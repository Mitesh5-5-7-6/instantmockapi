/**
 * Writing version snapshots (Phase 2 §3, §7, §42).
 *
 * ## The gap this closes
 *
 * A `Version` row used to be written in exactly one place — `createGenerationJob`
 * — but `currentVersion` advances in **six**: a schema PATCH, a restore, three
 * generation routes, and a draft commit. So a version number could exist on the
 * project with no snapshot, no history entry, and nothing to compare against:
 *
 *     v1 ✓   v2 ✗(patch)   v3 ✓   v4 ✗(restore)   v5 ✓
 *
 * History showed 1, 3, 5 with the gaps unexplained, §7's "never reuse a version
 * number" had no record to check against, and §24's "compare any two versions"
 * could not reach v2 or v4 at all.
 *
 * Every advance now records a snapshot, and `changeType` distinguishes a version
 * that was edited into existence from one that was generated.
 *
 * ## Idempotent, and unable to rewrite history
 *
 * `$setOnInsert` under a unique `{projectId, version}` index. Calling this twice
 * for the same version is a no-op, which is what lets `createGenerationJob` keep
 * its own call — a generate after a commit finds the row already there and
 * leaves the committed snapshot alone rather than overwriting it with a later
 * state of the same definition.
 *
 * That is also why §4's immutability needs no enforcement code: there is no path
 * that writes an existing row.
 */

import { Artifact, Version, type IProject, type VersionChangeType } from '@instantmockapi/db';
import type { GenerationConfig, InternalProjectSchema, SchemaSnapshot } from '@instantmockapi/ips';
import {
  AppError,
  logger,
  versionStatus,
  type ArtifactOutcome,
  type ArtifactStatus,
  type ArtifactType,
  type VersionStatus,
} from '@instantmockapi/shared';

export interface RecordVersionParams {
  project: IProject;
  /**
   * Which version to record. Defaults to `project.currentVersion`.
   *
   * Explicit at the sites that record *before* saving the project, so a snapshot
   * cannot be stamped against a number the project has not committed to.
   */
  version?: number;
  /** Human-readable reason, shown in the history list. */
  note?: string | null;
  changeType?: VersionChangeType;
  /** The version this one was derived from. Defaults to the previous number. */
  parentVersion?: number | null;
  /** The acting user, from `request.authUser.sub`. */
  createdBy?: string | null;
  /** For a rollback: the version whose definition was copied forward (§7). */
  rollbackSourceVersion?: number | null;
  /**
   * Override what gets snapshotted.
   *
   * Only for callers that have already computed the definition but have not
   * assigned it to the project yet. Everything else snapshots the live one.
   */
  ips?: InternalProjectSchema;
  config?: GenerationConfig;
}

/**
 * Record the snapshot for one version, if it is not already recorded.
 *
 * Returns whether a row was inserted, which is what the backfill uses to avoid
 * logging on every read.
 */
export async function recordVersion(params: RecordVersionParams): Promise<boolean> {
  const { project } = params;
  const version = params.version ?? project.currentVersion;

  const previous = await Version.findOneAndUpdate(
    { projectId: project._id, version },
    {
      $setOnInsert: {
        ipsSnapshot: params.ips ?? project.ips,
        configSnapshot: params.config ?? project.generationConfig,
        note: params.note ?? null,
        // `parentVersion` defaults to the previous number rather than to null:
        // for every ordinary advance that is the truth, and §7 wants the lineage
        // recorded rather than inferred by arithmetic later.
        parentVersion: params.parentVersion ?? (version > 1 ? version - 1 : null),
        ...(params.changeType === undefined ? {} : { changeType: params.changeType }),
        createdBy: params.createdBy ?? null,
        rollbackSourceVersion: params.rollbackSourceVersion ?? null,
      },
    },
    // Mongoose returns the document as it was BEFORE the write by default, so a
    // `null` here means there was nothing to return — the upsert inserted.
    //
    // Read from the document rather than from `rawResult`'s
    // `lastErrorObject.updatedExisting`: that option is not supported across
    // mongoose versions and silently yields `null`, which read as "no result" and
    // threw on every generate.
    { upsert: true },
  );

  return previous === null;
}

/** Where a comparison side's definition came from. */
export interface VersionRef {
  version: number;
  note: string | null;
  createdAt: Date | null;
  /**
   * `'version'` — a stored snapshot. `'project'` — the live definition, for a
   * version that has been authored but never generated, so a UI can label it
   * *"v7 (not yet generated)"* rather than implying it is a historical record.
   */
  source: 'version' | 'project';
}

/**
 * One side of a comparison, resolved.
 *
 * ## Why a fallback exists at all
 *
 * `currentVersion` can be ahead of the newest snapshot: a schema PATCH advances
 * the definition and — before Phase 2 — wrote no `Version` row. Stage 1 closed
 * that going forward, but a project edited before then still has the gap, and
 * `currentVersion` is the one version a user most obviously wants to compare.
 *
 * ## Why it refuses everything else, loudly
 *
 * A version number with no row and no claim to being current is a hole in the
 * history, and the honest response says *why* rather than "not found". It must
 * never silently substitute the nearest version — a diff of the wrong pair
 * looks exactly like a diff of the right one.
 *
 * And it must never fabricate a snapshot: the intermediate IPS of a version
 * that was never generated is gone, and inventing one would be writing history
 * that did not happen (§47).
 */
export async function resolveSnapshot(
  project: IProject,
  version: number,
): Promise<{ snapshot: SchemaSnapshot; ref: VersionRef }> {
  const row = await Version.findOne({ projectId: project._id, version });
  if (row) {
    return {
      snapshot: { version, ips: row.ipsSnapshot, config: row.configSnapshot },
      ref: { version, note: row.note ?? null, createdAt: row.createdAt, source: 'version' },
    };
  }

  if (version === project.currentVersion) {
    return {
      snapshot: {
        version,
        ips: project.ips as InternalProjectSchema,
        config: project.generationConfig,
      },
      ref: { version, note: null, createdAt: null, source: 'project' },
    };
  }

  throw new AppError({
    code: 'NOT_FOUND',
    message:
      `v${version} was never snapshotted. Versions are recorded when a project is generated; ` +
      `v${version} was created by an edit or a restore that has not been generated.`,
  });
}

/**
 * The derived status of several versions, in one aggregation.
 *
 * One query for a whole page rather than one per row: the history list is §28's
 * "load metadata only, cheaply" screen, and a `countDocuments` per version
 * inside a `.map()` is the N+1 the project list already exists to avoid.
 *
 * `wasPublished` comes from `Version.publishedAt` — the one piece of state that
 * genuinely cannot be derived, because "was live and is not any more" leaves no
 * trace in the artifact rows.
 */
export async function versionStatuses(
  project: IProject,
  versions: readonly number[],
): Promise<Map<number, VersionStatus>> {
  const result = new Map<number, VersionStatus>();
  if (versions.length === 0) {
    return result;
  }

  const [rows, published] = await Promise.all([
    Artifact.find({ projectId: project._id, version: { $in: [...versions] } })
      .select('artifactType status version')
      .lean<{ artifactType: ArtifactType; status: ArtifactStatus; version: number }[]>(),
    Version.find({ projectId: project._id, version: { $in: [...versions] } })
      .select('version publishedAt')
      .lean<{ version: number; publishedAt?: Date | null }[]>(),
  ]);

  const outcomesByVersion = new Map<number, ArtifactOutcome[]>();
  for (const row of rows) {
    const list = outcomesByVersion.get(row.version) ?? [];
    list.push({ artifactType: row.artifactType, status: row.status });
    outcomesByVersion.set(row.version, list);
  }
  const wasPublished = new Set(
    published.filter((row) => row.publishedAt != null).map((row) => row.version),
  );

  for (const version of versions) {
    result.set(
      version,
      versionStatus({
        version,
        publishedVersion: project.publishedVersion,
        outcomes: outcomesByVersion.get(version) ?? [],
        wasPublished: wasPublished.has(version),
      }),
    );
  }
  return result;
}

/**
 * Ensure a project has a `Version` row for the version it is serving (§42).
 *
 * Lazy and on-read, following the `ensurePublicIdentity` precedent rather than
 * a startup migration: *"Do not blindly create duplicate versions on every
 * startup. Migration must be idempotent."* Running it on every history request
 * costs one indexed upsert and converges without a deploy step.
 *
 * Snapshots the **live** definition, which is the only honest thing available:
 * the intermediate IPS of a version that was never generated is gone, and §47
 * forbids fabricating one.
 */
export async function backfillInitialVersion(
  project: IProject,
  publishedVersion: number,
): Promise<void> {
  const inserted = await recordVersion({
    project,
    version: publishedVersion,
    note: 'Recorded from the current definition',
    changeType: 'INITIAL',
    parentVersion: null,
  });

  if (inserted) {
    logger.info('Backfilled an initial version snapshot', {
      projectId: String(project._id),
      version: publishedVersion,
    });
  }
}
