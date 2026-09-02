/**
 * Runtime readiness and the promotion policy (Phase 1).
 *
 * ## The distinction this encodes
 *
 * Some generated artifacts *serve the user's API*; the rest are developer-facing
 * outputs. `hosted_api` is the config the mock runtime actually reads — without a
 * completed one at a version, that version cannot answer a request. OpenAPI,
 * Postman, Zod, Yup, TypeScript and the export ZIP are things a developer
 * downloads. A broken documentation generator must not keep a working API off the
 * air.
 *
 *                       NEW VERSION v3
 *                            │
 *                 ┌──────────┴──────────┐
 *           runtime artifacts      optional artifacts
 *                 │                     │
 *           hosted_api ✓          openapi ✗  postman ✓
 *                 │                     zod ✓  typescript ✓
 *                 ▼
 *            Runtime ready?  ── no ──▶  KEEP OLD VERSION LIVE
 *                 │
 *                yes
 *                 ▼
 *            PROMOTE v3
 *
 * ## Why this is a policy and not an `if`
 *
 * The promotion decision used to be one condition inline in the worker:
 * `outcomes.get('hosted_api') === 'completed'`. That conflated four separate
 * questions — what a job did, what state the artifacts are in, whether the
 * version can serve traffic, and whether to move the live pointer. Separating
 * them is what lets Phase 1's impact analysis regenerate only *affected*
 * artifacts and still answer "can this version go live" correctly, because the
 * answer depends on the version's artifact set rather than on what one job
 * happened to touch.
 *
 * The invariant that outranks everything here:
 *
 * > **A failed generation can never destroy or temporarily disable the currently
 * > live version.**
 */

import type { ArtifactStatus, ArtifactType } from './constants.js';

/**
 * Artifacts a version must have completed before it can serve traffic.
 *
 * Exactly one today, and deliberately a set rather than a constant so adding a
 * second runtime input is a one-line change here rather than a hunt through the
 * worker.
 *
 * **`mock_data` is NOT in this set**, which is a real decision rather than an
 * omission: if seeding fails the endpoints still answer, they just answer with
 * whatever records are already there. See `staleDataRisk` below for the sharp
 * edge that creates.
 */
export const RUNTIME_REQUIRED_ARTIFACTS = ['hosted_api'] as const;

export type RuntimeRequiredArtifact = (typeof RUNTIME_REQUIRED_ARTIFACTS)[number];

export function isRuntimeRequiredArtifact(type: ArtifactType): boolean {
  return (RUNTIME_REQUIRED_ARTIFACTS as readonly string[]).includes(type);
}

/** One artifact row, reduced to what the policy needs. */
export interface ArtifactOutcome {
  artifactType: ArtifactType;
  status: ArtifactStatus;
}

export interface RuntimeReadiness {
  /** True when every runtime-required artifact is `completed` at this version. */
  ready: boolean;
  /** Required artifacts that are absent, pending, generating or failed. */
  blocking: ArtifactType[];
  /** Optional artifacts that failed. Never blocks; worth telling the user. */
  degraded: ArtifactType[];
  /**
   * True when the runtime is ready but `mock_data` did not complete.
   *
   * Worth surfacing separately because `MockStore` is **not version-keyed** — the
   * records are stored per `(projectId, entity)` with no version. So promoting a
   * new schema whose seeding failed leaves the API serving records shaped for the
   * *previous* schema: the endpoints work, the response bodies may be missing
   * fields the new schema declares. Degraded, not down, but not silently either.
   */
  staleDataRisk: boolean;
}

/**
 * Can this version serve traffic?
 *
 * Takes the artifact rows *for one version*, not a job's outcomes. A partial
 * regenerate touches a subset, so "what this job produced" and "what this version
 * has" are different questions — and only the second one decides whether the
 * runtime can be pointed here.
 *
 * An absent required artifact blocks exactly as a failed one does. There is no
 * difference to the runtime between "never generated" and "generated and failed":
 * both mean no config to serve.
 */
export function evaluateRuntimeReadiness(outcomes: readonly ArtifactOutcome[]): RuntimeReadiness {
  const byType = new Map(outcomes.map((outcome) => [outcome.artifactType, outcome.status]));

  const blocking = RUNTIME_REQUIRED_ARTIFACTS.filter(
    (type) => byType.get(type) !== 'completed',
  ) as ArtifactType[];

  const degraded = outcomes
    .filter(
      (outcome) => outcome.status === 'failed' && !isRuntimeRequiredArtifact(outcome.artifactType),
    )
    .map((outcome) => outcome.artifactType);

  const ready = blocking.length === 0;

  return {
    ready,
    blocking,
    degraded,
    // Only meaningful when the version is going live; a version that cannot
    // serve has no data risk to report.
    staleDataRisk: ready && byType.get('mock_data') === 'failed',
  };
}

export interface PromotionDecision {
  promote: boolean;
  /** Why, in words a log line or a UI notice can use directly. */
  reason: string;
  readiness: RuntimeReadiness;
}

/**
 * Whether to move the live pointer to `candidate`.
 *
 * Refuses to move *backwards*. A partial regenerate of an older version, or a job
 * settling out of order, must not drag a live project onto a version it has
 * already moved past — the newer artifacts are the ones users are being served
 * and the ones the definition matches.
 */
export function evaluatePromotion(params: {
  candidate: number;
  published: number | null | undefined;
  outcomes: readonly ArtifactOutcome[];
}): PromotionDecision {
  const readiness = evaluateRuntimeReadiness(params.outcomes);

  if (!readiness.ready) {
    return {
      promote: false,
      // Names the artifacts, so the log says what to retry.
      reason: `v${params.candidate} is not runtime-ready (${readiness.blocking.join(', ')} incomplete); keeping the current version live`,
      readiness,
    };
  }

  const published = params.published ?? null;
  if (published !== null && params.candidate <= published) {
    return {
      promote: false,
      reason: `v${params.candidate} is not newer than the live v${published}; leaving the pointer alone`,
      readiness,
    };
  }

  const notes = [
    readiness.degraded.length > 0
      ? `optional artifacts failed: ${readiness.degraded.join(', ')}`
      : '',
    readiness.staleDataRisk ? 'mock data was not reseeded, so records may predate this schema' : '',
  ].filter(Boolean);

  return {
    promote: true,
    reason:
      notes.length > 0
        ? `promoting v${params.candidate} — runtime ready (${notes.join('; ')})`
        : `promoting v${params.candidate} — runtime ready`,
    readiness,
  };
}
