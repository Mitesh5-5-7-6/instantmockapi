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
  summariseChanges,
  validateIPS,
  type GenerationConfig,
  type ImpactReport,
  type InternalProjectSchema,
} from '@instantmockapi/ips';
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
    const validated = unwrap(
      validateIPS(
        {
          ...body.ips,
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
  /** The caller has shown the user the impact of a WARNING-or-worse change. */
  acknowledgeRisk?: boolean;
  note?: string;
}): Promise<CommitResult> {
  const { ctx, plan, acknowledgeRisk, note } = params;
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
  if (analysis.requiresAcknowledgement && acknowledgeRisk !== true) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      message: `This change is ${highestRisk(analysis.impact.changes) ?? 'risky'} and affects ${analysis.impact.affected.length} endpoint(s). Re-send with acknowledgeRisk: true to confirm.`,
      details: analysis.impact.affected.map((endpoint) => ({
        path: `${endpoint.method} ${endpoint.path}`,
        issue: endpoint.reasons.map((reason) => reason.reason).join(', '),
      })),
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

  const artifacts = params.artifacts ?? analysis.impact.artifacts;
  const job = await createGenerationJob({
    project,
    type: 'full',
    requestedArtifacts: artifacts,
    generationConfig: draft.generationConfig,
    plan,
    note: note ?? commitNote(analysis),
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

/** A version note a human can read in the history list. */
function commitNote(analysis: DraftAnalysis): string {
  const count = analysis.impact.changes.length;
  const risk = highestRisk(analysis.impact.changes);
  const noun = count === 1 ? 'change' : 'changes';
  return `Draft commit: ${count} ${noun}${risk ? ` (${risk})` : ''}, ${analysis.impact.affected.length} endpoint(s) affected`;
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
    // Flagged when a change could not be matched to a graph node, so a UI can
    // avoid presenting the not-affected list as a guarantee it cannot make.
    incomplete: impact.incomplete,
    changes: impact.changes.map((change) => ({
      kind: change.kind,
      risk: change.risk,
      aspect: change.aspect,
      entity: change.entityName ?? null,
      field: change.fieldName ?? change.relationName ?? null,
      path: change.path ?? null,
      before: change.before ?? null,
      after: change.after ?? null,
      summary: change.summary,
    })),
    affected: impact.affected.map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.path,
      entity: endpoint.entity ?? null,
      risk: endpoint.risk,
      reasons: endpoint.reasons.map((reason) => ({
        source: reason.source,
        reason: reason.reason,
        facet: reason.facet,
        change: reason.change.kind,
        summary: reason.change.summary,
      })),
    })),
    unaffected: impact.unaffected.map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.path,
      entity: endpoint.entity ?? null,
    })),
    artifacts: impact.artifacts,
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
    createdAt: ctx.draft.createdAt,
    updatedAt: ctx.draft.updatedAt,
  };
}

/** Re-read the project after a commit, for callers that need fresh state. */
export async function reloadProject(project: IProject): Promise<IProject | null> {
  return Project.findById(project._id);
}
