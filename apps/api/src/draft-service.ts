/**
 * Draft lifecycle: fork, edit, analyse, commit.
 *
 * The route layer above this is thin on purpose — every rule that decides
 * whether an edit is safe lives here, so it can be tested without HTTP and so
 * the same rules apply to any future caller (a CLI, a bulk importer).
 *
 * ## The two versions, and why they must not be confused
 *
 *     project.currentVersion    the DEFINITION version — what the model says
 *     project.publishedVersion  the RUNTIME version — what the hosted URL serves
 *
 * Committing advances the first and leaves the second alone. That is the whole
 * invariant Phase 1 exists to establish:
 *
 *     v4 published ──────────────────────────────▶ still serving
 *          │
 *          └─ commit ──▶ v5 definition ──▶ generate ──▶ ready ──▶ promote ──▶ v5 published
 *
 * A commit that also moved `publishedVersion` would point the live URL at a
 * version whose artifacts do not exist yet, which is exactly the outage this
 * split closed.
 */

import { createHash } from 'node:crypto';

import { AppError, unwrap, type ArtifactType, type PlanTier } from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import {
  Project,
  ProjectDraft,
  pinPublishedVersion,
  type IProject,
  type IProjectDraft,
} from '@instantmockapi/db';
import {
  analyseDraftImpact,
  ensureSchemaIds,
  highestRisk,
  materializeRelations,
  needsAttention,
  reconcileEntityRenames,
  summariseChanges,
  validateIPS,
  type GenerationConfig,
  type ImpactReport,
  type InternalProjectSchema,
} from '@instantmockapi/ips';
import { toChangeView, toImpactView } from './change-serializers.js';
import { validateGenerationConfig } from './generation-config.js';
import { createGenerationJob, type CreatedJobRef } from './generation-service.js';

/**
 * Addressing fields copied onto every stored IPS.
 *
 * The IPS carries them so generators can emit canonical URLs, but the Project
 * row owns them — a draft must never be able to change where its own project is
 * hosted.
 */
function addressing(project: IProject): { publicId?: string; slug?: string } {
  return {
    ...(project.publicId ? { publicId: project.publicId } : {}),
    ...(project.slug ? { slug: project.slug } : {}),
  };
}

/**
 * Give the ACTIVE definition stable ids, persisting them if any were missing.
 *
 * Every project generated before Phase 1 has an id-less schema, and `diffSchemas`
 * matches on ids alone — so without this a fork would produce a draft whose diff
 * against its own origin reports every entity as removed and re-added. The
 * backfill has to happen on the active side, not just the draft, or the two sides
 * have nothing in common to match on.
 *
 * Deliberately does NOT bump `currentVersion`. Assigning identity is not a schema
 * change: no generator reads `id`, so the artifacts a backfilled definition
 * produces are byte-identical. Bumping would mark a project pending regeneration
 * for opening an editor, which users would reasonably read as data loss.
 *
 * Idempotent — a second call mints nothing, so opening the editor twice does not
 * churn the document.
 */
export async function backfillProjectIds(project: IProject): Promise<boolean> {
  const result = ensureSchemaIds(project.ips);
  if (result.minted === 0) {
    return false;
  }
  // `ips` is `Schema.Types.Mixed`; mutating nested paths in place is invisible to
  // Mongoose without this, and the ids would silently fail to persist.
  project.markModified('ips');
  await project.save();
  return true;
}

/**
 * A short, stable fingerprint of what the user was shown.
 *
 * `acknowledgeImpact` carries this back on commit, so an acknowledgement binds to
 * one specific draft state rather than becoming a standing permission. Without
 * it, this sequence quietly commits an unreviewed breaking change:
 *
 *     GET  /draft/impact        user reads it, approves
 *     PATCH /draft              user (or the client) changes something else
 *     POST /draft/commit        client replays acknowledgeRisk: true
 *
 * Hashing the draft's `ips` rather than the rendered impact is deliberate: the
 * schema plus its embedded `generationConfig` is what *determines* the impact, and
 * the active side is already covered by the staleness check. Field order is
 * included on purpose — reordering changes the generated types, so it is a real
 * change and deserves a fresh look.
 */
export function impactDigest(draft: IProjectDraft): string {
  return createHash('sha256').update(JSON.stringify(draft.ips)).digest('hex').slice(0, 16);
}

/** A draft and the project it belongs to, with staleness already decided. */
export interface DraftContext {
  project: IProject;
  draft: IProjectDraft;
  /** The active definition has moved since the draft was forked. */
  stale: boolean;
}

export interface DraftAnalysis {
  stale: boolean;
  baseVersion: number;
  currentVersion: number;
  impact: ImpactReport;
  /** Counts by risk, for the dialog's summary line. */
  summary: Record<string, number>;
  /** True when a caller must acknowledge risk before committing. */
  requiresAcknowledgement: boolean;
  /** The value a risky commit must echo back as `acknowledgeImpact`. */
  digest: string;
  /**
   * The version this draft was restored from, or null for an ordinary edit.
   *
   * Carried on the analysis rather than looked up again at each call site,
   * because two decisions key off it — which artifacts are locked, and how the
   * review screen describes what is about to happen.
   */
  rollbackSourceVersion: number | null;
}

/**
 * Fork a draft from the active definition, or return the one already open.
 *
 * Returning the existing draft rather than a 409 is deliberate. There is one
 * draft per project, and the only thing a client can usefully do with "a draft
 * already exists" is fetch it — so making the caller do a failed POST then a GET
 * buys nothing. `created` distinguishes the two for a UI that wants to say
 * "resuming your unsaved changes".
 */
export async function openDraft(
  project: IProject,
): Promise<{ draft: IProjectDraft; created: boolean }> {
  await backfillProjectIds(project);

  const existing = await ProjectDraft.findOne({ projectId: project._id });
  if (existing) {
    return { draft: existing, created: false };
  }

  try {
    const draft = await ProjectDraft.create({
      projectId: project._id,
      // Deep-copied through JSON so the draft cannot share structure with the live
      // document — a shared nested object would let an edit mutate the active
      // definition in place, which is the one thing this whole model prevents.
      ips: JSON.parse(JSON.stringify(project.ips)) as InternalProjectSchema,
      generationConfig: JSON.parse(JSON.stringify(project.generationConfig)) as GenerationConfig,
      baseVersion: project.currentVersion,
    });
    return { draft, created: true };
  } catch (error) {
    // Race on the unique index: two POSTs arrived between the findOne above and
    // this insert, and the other one won. Return its draft rather than a 500 —
    // "fork or resume" is meant to be idempotent, and it has to stay so under
    // concurrency, not merely when the calls are politely sequential. React's
    // development double-invoke makes this a first-load certainty, not a corner
    // case. Same shape as the idempotency-key race in `generation-service.ts`.
    if ((error as { code?: number }).code !== 11000) {
      throw error;
    }
    const winner = await ProjectDraft.findOne({ projectId: project._id });
    if (winner === null) {
      throw error;
    }
    return { draft: winner, created: false };
  }
}

/**
 * Seed the draft from a version snapshot — a rollback (Phase 2 §22, §16).
 *
 * ## Why this replaces what `restore` used to do
 *
 * `restore` wrote the snapshot straight onto `project.ips`, bumped
 * `currentVersion`, and returned. No draft, no diff, no review — so the one
 * action most likely to remove fields and break callers was the only one that
 * skipped the confirmation every ordinary edit goes through.
 *
 * Seeding the draft instead means a rollback reuses the whole reviewed pipeline:
 *
 *     restore ─▶ draft ─▶ diff ─▶ impact ─▶ review ─▶ commit ─▶ generate ─▶ publish
 *
 * The breaking-change gate, the `acknowledgeImpact` digest, selective
 * regeneration and the STALE_DRAFT check all apply for free. §22 asks for
 * exactly this — *"do NOT create a special hidden rollback implementation that
 * bypasses version generation"* — and §16 adds that rollback must not touch
 * `publishedVersion`, which this cannot: nothing here goes near it.
 *
 * ## It replaces an open draft rather than refusing
 *
 * One draft per project, so a rollback has to take it over. Refusing while
 * unsaved edits exist would leave the user unable to roll back without first
 * discarding by hand, and silently merging the two is worse — the snapshot's
 * definition is the whole point of the operation.
 */
export async function seedDraftFromSnapshot(
  project: IProject,
  snapshot: {
    version: number;
    ipsSnapshot: InternalProjectSchema;
    configSnapshot: GenerationConfig;
  },
): Promise<DraftContext> {
  await backfillProjectIds(project);

  // Materialize on the way out so a snapshot taken before relations existed is
  // restored in the current shape rather than the one it was captured in — the
  // same reason the old `restore` did it.
  const ips = materializeRelations({
    ...snapshot.ipsSnapshot,
    projectId: String(project._id),
    ...addressing(project),
    // The draft's schema version tracks the definition it forked FROM, never the
    // version it was copied from: the diff is against the live definition, and a
    // draft is not a version.
    version: project.currentVersion,
    generationConfig: snapshot.configSnapshot,
  });
  // Mint ids for anything the snapshot predates, so the diff can pair elements
  // rather than reporting the whole schema as replaced.
  ensureSchemaIds(ips);

  const draft = await ProjectDraft.findOneAndUpdate(
    { projectId: project._id },
    {
      $set: {
        ips,
        generationConfig: snapshot.configSnapshot,
        baseVersion: project.currentVersion,
        rollbackSourceVersion: snapshot.version,
      },
    },
    { upsert: true, new: true },
  );

  return { project, draft, stale: false };
}

/** Load the open draft, or throw NOT_FOUND. */
export async function loadDraft(project: IProject): Promise<DraftContext> {
  const draft = await ProjectDraft.findOne({ projectId: project._id });
  if (!draft) {
    throw new AppError({
      code: 'NOT_FOUND',
      message: 'No draft is open for this project',
    });
  }
  return { project, draft, stale: draft.baseVersion !== project.currentVersion };
}

/**
 * Apply an edit to the draft.
 *
 * Validates what the client sent (so error paths carry the client's own indices),
 * then materializes and backfills — in that order. Materializing first would add
 * identity and foreign-key fields the client never sent and then report
 * validation errors against indices it cannot map back to its own form.
 */
export async function applyDraftEdit(
  ctx: DraftContext,
  body: { ips?: Record<string, unknown>; generationConfig?: Record<string, unknown> },
  config: EnvConfig,
): Promise<IProjectDraft> {
  const { project, draft } = ctx;

  if (body.generationConfig) {
    draft.generationConfig = unwrap(validateGenerationConfig(body.generationConfig, config));
  }

  if (body.ips) {
    // Follow entity renames through the references that name entities by string
    // — `relation.target` and `meta.relation`. This runs BEFORE validation on
    // purpose: `validateIPS` is what rejects a target naming an entity that no
    // longer exists, so reconciling after it would never get the chance, and
    // renaming an entity that anything relates to would stay unsavable.
    //
    // The previous draft state is the comparison side: the client sends the
    // whole document with the new name, and `draft.ips` still holds the old one
    // under the same stable id.
    const reconciled = reconcileEntityRenames(draft.ips, body.ips);

    const validated = unwrap(
      validateIPS(
        {
          ...reconciled,
          projectId: String(project._id),
          ...addressing(project),
          // The draft's schema version tracks the definition it was forked from,
          // never the draft's own edit count. A draft is not a version.
          version: draft.baseVersion,
        },
        config.maxNestingDepth,
      ),
    );
    draft.ips = materializeRelations(validated);
  }

  // Keep the config the diff will read in step with the config the draft holds,
  // so a config-only edit is still visible to `diffSchemas`.
  draft.ips = { ...draft.ips, generationConfig: draft.generationConfig };

  // New entities and fields arrive without ids. Minting them here — after
  // materialization, so synthesised identity and foreign-key fields get ids too —
  // is what lets the NEXT edit be diffed as a modification rather than a
  // replacement.
  ensureSchemaIds(draft.ips);
  draft.markModified('ips');
  await draft.save();
  return draft;
}

/**
 * Diff the draft against the active definition and analyse the impact.
 *
 * The graph is built from the draft, because impact is a statement about the API
 * that is about to ship rather than the one currently running.
 */
export function analyseDraft(ctx: DraftContext): DraftAnalysis {
  const { project, draft, stale } = ctx;
  const active = project.ips as InternalProjectSchema;
  const proposed = draft.ips;

  const impact = analyseDraftImpact(active, proposed);
  return {
    stale,
    baseVersion: draft.baseVersion,
    currentVersion: project.currentVersion,
    impact,
    summary: summariseChanges(impact.changes),
    requiresAcknowledgement: needsAttention(impact.changes),
    digest: impactDigest(draft),
    rollbackSourceVersion: draft.rollbackSourceVersion ?? null,
  };
}

export interface CommitResult {
  committed: boolean;
  /** Absent when nothing changed. */
  version?: number;
  publishedVersion: number;
  job?: CreatedJobRef;
  analysis: DraftAnalysis;
  /** Why a commit was skipped, when it was. */
  reason?: 'no-changes';
}

/**
 * Commit the draft: it becomes the new canonical definition, pending generation.
 *
 * The ordering below is load-bearing, not stylistic:
 *
 *  1. Reject a stale draft *before* anything is written.
 *  2. Validate, so an invalid definition can never become canonical.
 *  3. Refuse silently-risky commits unless the caller acknowledged the risk.
 *  4. Do nothing at all when nothing changed.
 *  5. **Pin the published version, then advance the definition.** In that order.
 *     `publishedVersionOf` falls back to `currentVersion`, so a bump before the
 *     pin makes the fallback follow the bump and 404 the live URL.
 *  6. Write the definition, then enqueue — `createGenerationJob` snapshots
 *     `project.ips`, so it has to see the committed shape.
 *  7. Delete the draft last. It is the only step that destroys the user's work,
 *     so everything that could fail happens before it.
 */
export async function commitDraft(params: {
  ctx: DraftContext;
  plan: PlanTier;
  /** Which artifacts to regenerate. Defaults to the impact report's list. */
  artifacts?: ArtifactType[];
  /**
   * The `digest` from the impact the user actually reviewed.
   *
   * A string rather than a boolean so it cannot be hardcoded once and replayed
   * forever. A client that has not read `GET /draft/impact` cannot produce one,
   * which is the point — you should not be able to acknowledge risk you have not
   * been shown.
   */
  acknowledgeImpact?: string;
  note?: string;
}): Promise<CommitResult> {
  const { ctx, plan, acknowledgeImpact, note } = params;
  const { project, draft } = ctx;

  // 1. Staleness. Never merge — the user reasoned about a definition that has
  //    since moved, so the only safe answer is to send them back to a fresh diff.
  if (draft.baseVersion !== project.currentVersion) {
    throw new AppError({
      code: 'STALE_DRAFT',
      message: `This draft was created from version v${draft.baseVersion}, but the project is now on version v${project.currentVersion}.`,
      details: [
        { path: 'baseVersion', issue: `v${draft.baseVersion}` },
        { path: 'currentVersion', issue: `v${project.currentVersion}` },
      ],
    });
  }

  // 2. Validate. An invalid draft is savable — a half-finished edit should not be
  //    rejected mid-typing — but it must never become the definition of record.
  const validated = unwrap(validateIPS(draft.ips));

  const analysis = analyseDraft(ctx);

  // 3. Risk gate. A commit that quietly ships a BREAKING or WARNING change
  //    defeats the point of computing the impact at all.
  if (analysis.requiresAcknowledgement && acknowledgeImpact !== analysis.digest) {
    const stated =
      acknowledgeImpact === undefined
        ? 'Re-send with acknowledgeImpact set to the digest from GET /draft/impact.'
        : 'The draft has changed since that impact was reviewed. Fetch GET /draft/impact again.';
    throw new AppError({
      code: 'VALIDATION_ERROR',
      message: `This change is ${highestRisk(analysis.impact.changes) ?? 'risky'} and affects ${analysis.impact.affected.length} endpoint(s). ${stated}`,
      details: [
        { path: 'acknowledgeImpact', issue: analysis.digest },
        // The affected endpoints ride along so a client that skipped the impact
        // call can still render the dialog from the rejection alone. The API
        // stays self-describing even when the frontend gets the order wrong.
        ...analysis.impact.affected.map((endpoint) => ({
          path: `${endpoint.method} ${endpoint.path}`,
          issue: endpoint.reasons.map((reason) => reason.reason).join(', '),
        })),
      ],
    });
  }

  // 4. Nothing to do. Committing an unchanged draft would burn a version number
  //    and enqueue a job that regenerates identical artifacts.
  if (analysis.impact.changes.length === 0) {
    await draft.deleteOne();
    return {
      committed: false,
      reason: 'no-changes',
      publishedVersion: project.publishedVersion ?? project.currentVersion,
      analysis,
    };
  }

  // 5. Freeze the runtime, THEN advance the definition.
  pinPublishedVersion(project);
  project.currentVersion += 1;

  // 6. The committed definition. `version` is stamped to the new definition
  //    version so a snapshot is self-describing.
  project.generationConfig = draft.generationConfig;
  project.ips = {
    ...validated,
    projectId: String(project._id),
    ...addressing(project),
    version: project.currentVersion,
    generationConfig: draft.generationConfig,
  };
  project.markModified('ips');
  await project.save();

  // From the analysis, which read it off this same draft — one read, so the
  // locked checkboxes the client was shown and the artifacts forced here cannot
  // come from different values.
  const rollbackSource = analysis.rollbackSourceVersion;
  const artifacts = forceMockDataOnRollback(
    params.artifacts ?? analysis.impact.artifacts,
    analysis,
    rollbackSource,
  );

  const job = await createGenerationJob({
    project,
    type: 'full',
    requestedArtifacts: artifacts,
    generationConfig: draft.generationConfig,
    plan,
    note: note ?? commitNote(analysis, rollbackSource),
    // A rollback is a version like any other, and says so in the history: §7
    // wants the lineage recorded rather than reconstructed from the note text.
    ...(rollbackSource === null
      ? {}
      : { changeType: 'ROLLBACK' as const, rollbackSourceVersion: rollbackSource }),
  });

  // 7. The draft has become the definition; nothing is left to resume.
  await draft.deleteOne();

  return {
    committed: true,
    version: project.currentVersion,
    publishedVersion: project.publishedVersion ?? project.currentVersion,
    job,
    analysis,
  };
}

/**
 * Change kinds that alter the shape of a stored record.
 *
 * Not every change does. Turning a query feature off, or choosing different
 * generators, leaves the records on disk exactly as valid as they were.
 */
const SHAPE_KINDS = new Set<string>([
  'ENTITY_ADDED',
  'ENTITY_REMOVED',
  'ENTITY_RENAMED',
  'ENTITY_IDENTITY_CHANGED',
  'FIELD_ADDED',
  'FIELD_REMOVED',
  'FIELD_RENAMED',
  'FIELD_TYPE_CHANGED',
  'FIELD_DEFAULT_CHANGED',
  'ENUM_VALUES_REMOVED',
  'RELATION_ADDED',
  'RELATION_REMOVED',
  'RELATION_RENAMED',
  'RELATION_KIND_CHANGED',
  'RELATION_TARGET_CHANGED',
  'RELATION_FIELDS_CHANGED',
]);

/** True when this commit changes what a stored record should look like. */
export function affectsRecordShape(analysis: DraftAnalysis): boolean {
  return analysis.impact.changes.some((change) => SHAPE_KINDS.has(change.kind));
}

/**
 * Force `mock_data` into the regeneration set on a schema-affecting rollback.
 *
 * ## Why a rollback is the one case that cannot opt out
 *
 * `MockStore` is keyed `(projectId, entity)` with **no version**. The promotion
 * policy already names the consequence as `staleDataRisk`: promote a schema
 * whose seeding failed and the endpoints answer with records shaped for the
 * *previous* schema.
 *
 * For an ordinary edit that is a possibility. For a rollback it is a certainty —
 * the records on disk were seeded for the newer schema by definition, so rolling
 * the definition back without reseeding leaves the live API returning fields the
 * restored schema does not declare, and missing ones it does. And it is the one
 * inconsistency a user cannot see or diagnose: the schema page, the docs and the
 * types would all agree with each other and disagree with the data.
 *
 * §17 lets a user deselect artifacts, and they still can — docs, types,
 * validators, the export bundle. This forces exactly one, for one situation.
 */
export function forceMockDataOnRollback(
  artifacts: ArtifactType[],
  analysis: DraftAnalysis,
  rollbackSourceVersion: number | null,
): ArtifactType[] {
  const forced = lockedArtifacts(analysis, rollbackSourceVersion).map((lock) => lock.artifactType);
  return [...artifacts, ...forced.filter((artifact) => !artifacts.includes(artifact))];
}

/**
 * Why an artifact cannot be deselected. A code, not a sentence — the copy
 * belongs to the UI that renders it, and `ERROR_PHASE.md`'s vocabulary is not
 * something a serializer should be inventing variants of.
 */
export type ArtifactLockReason = 'ROLLBACK_RESEED';

export interface ArtifactLock {
  artifactType: ArtifactType;
  reason: ArtifactLockReason;
}

/**
 * Artifacts this commit will regenerate whether or not the client asks.
 *
 * The **single** implementation of the rule: `forceMockDataOnRollback` applies
 * it and `toDraftAnalysisResponse` reports it, so the checkbox the user sees
 * locked and the artifact the commit actually forces cannot disagree. Mirroring
 * the predicate in the browser was the alternative, and it would have gone
 * stale the first time `SHAPE_KINDS` gained a member.
 */
export function lockedArtifacts(
  analysis: DraftAnalysis,
  rollbackSourceVersion: number | null,
): ArtifactLock[] {
  if (rollbackSourceVersion === null || !affectsRecordShape(analysis)) {
    return [];
  }
  return [{ artifactType: 'mock_data', reason: 'ROLLBACK_RESEED' }];
}

/** A version note a human can read in the history list. */
function commitNote(analysis: DraftAnalysis, rollbackSourceVersion: number | null = null): string {
  const count = analysis.impact.changes.length;
  const risk = highestRisk(analysis.impact.changes);
  const noun = count === 1 ? 'change' : 'changes';
  const what =
    rollbackSourceVersion === null ? 'Draft commit' : `Rollback to v${rollbackSourceVersion}`;
  return `${what}: ${count} ${noun}${risk ? ` (${risk})` : ''}, ${analysis.impact.affected.length} endpoint(s) affected`;
}

/** Discard the draft. */
export async function discardDraft(ctx: DraftContext): Promise<void> {
  await ctx.draft.deleteOne();
}

/**
 * Re-fork a stale draft, discarding the edits.
 *
 * The honest V1 answer to staleness. A real rebase — replaying the draft's
 * changes onto the new definition — needs three-way merge semantics per change
 * kind, and getting it subtly wrong would corrupt a definition rather than fail.
 * Until then the user re-applies their edits against a diff that is actually
 * true.
 */
export async function refork(project: IProject): Promise<IProjectDraft> {
  await ProjectDraft.deleteOne({ projectId: project._id });
  const { draft } = await openDraft(project);
  return draft;
}

/** Serialise a change list for the review-changes panel. */
export function toDraftAnalysisResponse(analysis: DraftAnalysis): Record<string, unknown> {
  const { impact } = analysis;
  return {
    stale: analysis.stale,
    baseVersion: analysis.baseVersion,
    currentVersion: analysis.currentVersion,
    risk: impact.risk,
    summary: analysis.summary,
    requiresAcknowledgement: analysis.requiresAcknowledgement,
    // Echo this back as `acknowledgeImpact` on a risky commit.
    digest: analysis.digest,
    rollbackSourceVersion: analysis.rollbackSourceVersion,
    /*
     * Which regenerate checkboxes the client must render locked.
     *
     * Reported rather than left for the client to work out: the server forces
     * these on commit either way, and a UI that offered `mock_data` as
     * deselectable would be showing the user a choice they do not have.
     */
    lockedArtifacts: lockedArtifacts(analysis, analysis.rollbackSourceVersion),
    // Through the shared serializer, so this payload and the comparison
    // endpoint describe a change identically. Everything the old inline mapper
    // produced is still here, spelled the same way; the additions (stable ids,
    // `changeType`, `impact`, `matchedBy`) are new keys beside them, which is
    // why `review-changes.tsx` needed no edit.
    changes: impact.changes.map(toChangeView),
    // Carries `affected`, `unaffected`, `artifacts` and `incomplete` — the last
    // of which is flagged when a change could not be matched to a graph node, so
    // a UI can avoid presenting the not-affected list as a guarantee it cannot
    // make.
    ...toImpactView(impact),
  };
}

/** Draft document shape for the API. */
export function toDraftResponse(ctx: DraftContext): Record<string, unknown> {
  return {
    projectId: String(ctx.project._id),
    baseVersion: ctx.draft.baseVersion,
    currentVersion: ctx.project.currentVersion,
    stale: ctx.stale,
    ips: ctx.draft.ips,
    generationConfig: ctx.draft.generationConfig,
    /*
     * On every draft response, not just the restore that seeded it.
     *
     * `POST /draft` returns an already-open draft, so a browser reload
     * mid-review goes through here. Without this the UI would forget the draft
     * was a rollback and stop locking `mock_data` and stop asking for §23's
     * confirmation — while the server carried on forcing `mock_data` anyway.
     * A silent divergence between what the user is told and what runs.
     */
    rollbackSourceVersion: ctx.draft.rollbackSourceVersion ?? null,
    createdAt: ctx.draft.createdAt,
    updatedAt: ctx.draft.updatedAt,
  };
}

/** Re-read the project after a commit, for callers that need fresh state. */
export async function reloadProject(project: IProject): Promise<IProject | null> {
  return Project.findById(project._id);
}
