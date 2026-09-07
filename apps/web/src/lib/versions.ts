/**
 * What a version row offers, and what it says about itself.
 *
 * Pure and separate from the page so the rules are testable — `apps/web` runs
 * vitest in a node environment with no DOM, so anything asserted about this
 * screen has to live in a function rather than in JSX.
 *
 * The rules themselves are §5's, and they are worth stating as data rather than
 * as conditions scattered through a render: only a READY version offers Publish,
 * the live version never does, and a failed one offers a retry instead.
 */

import type { VersionStatus } from './api-types';
import type { VersionView } from './hooks';

/** The three semantic groups §34 allows a colour for. */
export type VersionTone = 'live' | 'ready' | 'progress' | 'failed' | 'neutral';

export interface VersionRowView {
  version: number;
  /** Absent on a row written before Phase 2; treated as unknown, not as ready. */
  status: VersionStatus | null;
  label: string;
  tone: VersionTone;
  /** §5: only a READY (or DEGRADED) version that is not already live. */
  canPublish: boolean;
  /** §5: a failed version offers a retry rather than a publish. */
  canRetry: boolean;
  /** True for the version the hosted API is serving. */
  isLive: boolean;
  /**
   * Why publishing is unavailable, when it is worth saying.
   *
   * `null` when the row can publish, or when the reason is obvious from the
   * status chip beside it — a live version does not need "this is already live"
   * spelled out.
   */
  publishBlockedReason: string | null;
}

const LABELS: Record<VersionStatus, string> = {
  PUBLISHED: 'Live',
  SUPERSEDED: 'Superseded',
  READY: 'Ready',
  DEGRADED: 'Ready, degraded',
  GENERATING: 'Generating',
  FAILED: 'Failed',
  PENDING: 'Not generated',
};

const TONES: Record<VersionStatus, VersionTone> = {
  PUBLISHED: 'live',
  SUPERSEDED: 'neutral',
  READY: 'ready',
  // Ready, but a download is missing or the seeded records predate this schema.
  // Amber rather than green: publishable, and worth looking at first.
  DEGRADED: 'progress',
  GENERATING: 'progress',
  FAILED: 'failed',
  PENDING: 'neutral',
};

/**
 * Publishable statuses.
 *
 * `DEGRADED` is included on purpose: a failed OpenAPI degrades a version rather
 * than blocking it, so the API can serve and the user is entitled to publish it
 * — the confirmation names what is missing. Excluding it here would contradict
 * the promotion policy and produce a Publish button the server would accept but
 * the UI never offered.
 */
const PUBLISHABLE: ReadonlySet<VersionStatus> = new Set<VersionStatus>(['READY', 'DEGRADED']);

const BLOCKED_BECAUSE: Partial<Record<VersionStatus, string>> = {
  GENERATING: 'Still generating',
  FAILED: 'Generation failed',
  PENDING: 'Not generated yet',
  SUPERSEDED: 'Restore it to publish its definition again',
};

/**
 * One version, as the list renders it.
 *
 * `publishedVersion` is passed in rather than inferred from the status, because
 * a pre-Phase-2 row has no status at all and the live version still has to be
 * unmistakable — §9 and §18 both require that.
 */
export function toVersionRow(
  version: VersionView,
  publishedVersion: number | null,
): VersionRowView {
  const isLive = publishedVersion !== null && version.version === publishedVersion;
  const status = version.status ?? null;

  // The pointer outranks the derived status for the live row. They agree in
  // practice, but if they ever disagree the pointer is the one serving traffic.
  const effective: VersionStatus | null = isLive ? 'PUBLISHED' : status;

  const canPublish = !isLive && effective !== null && PUBLISHABLE.has(effective);

  return {
    version: version.version,
    status: effective,
    label: effective === null ? 'Unknown' : LABELS[effective],
    tone: effective === null ? 'neutral' : TONES[effective],
    canPublish,
    canRetry: effective === 'FAILED',
    isLive,
    publishBlockedReason:
      canPublish || isLive || effective === null ? null : (BLOCKED_BECAUSE[effective] ?? null),
  };
}

/**
 * A one-line summary of what changed, from the recorded counts.
 *
 * Reads the stored `changeSummary` rather than recomputing a diff: the history
 * list is §28's cheap screen, and a diff per row would be a request per row.
 * Returns `null` when there is nothing recorded, so the row can fall back to
 * the human `note` instead of rendering "0 changes" as though that were a fact.
 */
export function summariseVersion(version: VersionView): string | null {
  const summary = version.changeSummary;
  if (!summary) {
    return null;
  }

  const parts: string[] = [];
  const add = (count: number, singular: string, plural = `${singular}s`): void => {
    if (count > 0) {
      parts.push(`${count} ${count === 1 ? singular : plural}`);
    }
  };

  add(
    summary.entitiesAdded + summary.entitiesRemoved + summary.entitiesModified,
    'entity',
    'entities',
  );
  add(summary.fieldsAdded + summary.fieldsRemoved + summary.fieldsModified, 'field');
  add(summary.relationsAdded + summary.relationsRemoved + summary.relationsModified, 'relation');
  add(summary.endpointsAdded + summary.endpointsRemoved + summary.endpointsModified, 'endpoint');

  return parts.length === 0 ? null : parts.join(' · ');
}

/** How a version came to exist, in words. */
export function describeChangeType(version: VersionView): string | null {
  switch (version.changeType) {
    case 'INITIAL':
      return 'Initial version';
    case 'ROLLBACK':
      return version.rollbackSourceVersion === null
        ? 'Rollback'
        : `Rollback to v${version.rollbackSourceVersion}`;
    case 'REGENERATION':
      // The definition did not change — only which artifacts were built from
      // it. Worth distinguishing, or a history of three regenerations reads
      // like three schema edits.
      return 'Regenerated';
    case 'BREAKING':
      return 'Breaking change';
    case 'FEATURE':
      return null;
    default:
      return null;
  }
}
