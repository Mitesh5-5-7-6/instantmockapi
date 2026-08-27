/**
 * Everything behind `GET /v1/projects/:id/metrics`.
 *
 * The per-project counterpart to `dashboard-service.ts`, and deliberately built
 * the same way: **one `$match` split by `$facet`**. The reason is agreement — the
 * tile total, the chart series and the endpoint breakdown are computed over the
 * identical matched set, so the series provably sums to the total and the
 * endpoints provably sum to no more than it. Split across three endpoints they
 * could be fetched either side of a bucket boundary and disagree, which a reader
 * can only interpret as a bug.
 *
 * Every arithmetic helper comes from `metrics.ts` unchanged. Those functions take
 * plain numbers and know nothing about scope, so the account-wide dashboard and
 * this share them exactly — there is one definition of "success rate" on the
 * platform, not two that drift.
 */

// Type-only: `mongoose` is not a dependency of this app (it arrives via
// @instantmockapi/db), so a value import would resolve at build time and then
// fail at runtime with "Cannot find package 'mongoose'".
import type { Types } from 'mongoose';
import { ApiLog, Job, Version, type ApiLogShape, type IProject } from '@instantmockapi/db';
import { countEndpoints, type IpsEntity } from '@instantmockapi/shared';
import {
  averageDuration,
  percentChange,
  requestRates,
  resolveWindow,
  zeroFillSeries,
  type RawBucket,
  type SeriesBucket,
} from './metrics.js';
import { failedJobEvent, mergeActivity, versionEvent, type ActivityEvent } from './activity.js';

/** Retention of the hosted request log, mirrored from the ApiLog TTL index. */
const LOG_RETENTION_DAYS = 30;

/**
 * `entity` and `shape` were added to `ApiLog` after logging had been running for
 * some time, and **no backfill is possible** — the values were never captured.
 * Rows from before then carry null and are therefore absent from the endpoint
 * breakdown while still counting toward every total.
 *
 * Surfaced as a note rather than hidden, because a breakdown that silently
 * accounts for less traffic than the total above it reads as a miscount.
 */
const ENDPOINT_NOTE =
  'Per-endpoint attribution began when request logging was extended; older requests count toward totals but are not broken down by endpoint.';

export interface ProjectMetricsQuery {
  days: number;
  activityLimit: number;
}

export interface EndpointUsage {
  method: string;
  /** Canonical entity path, or null for the discovery document. */
  entity: string | null;
  shape: ApiLogShape | null;
  count: number;
  /** Null when no row in this bucket carried a duration. */
  avgDurationMs: number | null;
  durationSampleCount: number;
  serverErrors: number;
}

export interface ProjectMetricsView {
  window: { days: number; from: string; to: string; tz: 'UTC'; retentionDays: number };
  endpoints: { total: number; entities: number };
  requests: {
    total: number;
    previousTotal: number;
    changePercent: number | null;
    successRate: number | null;
    clientErrorRate: number | null;
    serverErrorRate: number | null;
    avgDurationMs: number | null;
    previousAvgDurationMs: number | null;
    /** Signed change in milliseconds; null when either window has no samples. */
    durationChangeMs: number | null;
    durationSampleCount: number;
    series: SeriesBucket[];
  };
  topEndpoints: EndpointUsage[];
  /** Requests counted in the totals but absent from `topEndpoints`. */
  unattributedRequests: number;
  endpointNote: string | null;
  activity: ActivityEvent[];
}

interface TotalsRow {
  total: number;
  clientErrors: number;
  serverErrors: number;
  durationSum: number;
  durationSamples: number;
}

interface EndpointRow {
  _id: { method: string; entity: string | null; shape: ApiLogShape | null };
  count: number;
  durationSum: number;
  durationSamples: number;
  serverErrors: number;
}

interface RequestFacets {
  daily: RawBucket[];
  totals: TotalsRow[];
  previous: TotalsRow[];
  byEndpoint: EndpointRow[];
}

const EMPTY_TOTALS: TotalsRow = {
  total: 0,
  clientErrors: 0,
  serverErrors: 0,
  durationSum: 0,
  durationSamples: 0,
};

/**
 * The `durationMs`-aware sum used in three facets.
 *
 * Sums and counts **only rows that carry a duration**. Coercing a missing value
 * to 0 would drag the mean toward zero across an entire retention window and
 * render as an impossibly fast API — the trap `ApiLog.durationMs` documents.
 */
const DURATION_ACCUMULATORS = {
  durationSum: { $sum: { $cond: [{ $isNumber: '$durationMs' }, '$durationMs', 0] } },
  durationSamples: { $sum: { $cond: [{ $isNumber: '$durationMs' }, 1, 0] } },
} as const;

const STATUS_ACCUMULATORS = {
  total: { $sum: 1 },
  clientErrors: {
    $sum: { $cond: [{ $and: [{ $gte: ['$status', 400] }, { $lt: ['$status', 500] }] }, 1, 0] },
  },
  serverErrors: { $sum: { $cond: [{ $gte: ['$status', 500] }, 1, 0] } },
} as const;

/**
 * Every request-derived figure for one project, from one pipeline.
 *
 * ⚠️ `projectId` **must be a real `Types.ObjectId`**, never `String(project._id)`.
 * Mongoose casts values in *queries* but not inside aggregation pipelines, so a
 * string silently matches nothing and every figure comes back zero — a bug that
 * passes typecheck, passes review, and looks exactly like "this project has no
 * traffic". This is the same trap `dashboard-service.ts` records.
 */
async function aggregateProjectRequests(
  projectId: Types.ObjectId,
  range: { from: Date; to: Date; previousFrom: Date },
): Promise<RequestFacets> {
  const inWindow = { $gte: range.from, $lt: range.to };
  const result = await ApiLog.aggregate<RequestFacets>([
    { $match: { projectId, at: { $gte: range.previousFrom, $lt: range.to } } },
    {
      $facet: {
        daily: [
          { $match: { at: inWindow } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: 'UTC' } },
              count: { $sum: 1 },
              serverErrors: { $sum: { $cond: [{ $gte: ['$status', 500] }, 1, 0] } },
            },
          },
          { $project: { _id: 0, date: '$_id', count: 1, serverErrors: 1 } },
          { $sort: { date: 1 } },
        ],
        totals: [
          { $match: { at: inWindow } },
          { $group: { _id: null, ...STATUS_ACCUMULATORS, ...DURATION_ACCUMULATORS } },
          { $project: { _id: 0 } },
        ],
        // The full previous window, not just its count: the response reports a
        // latency delta as well as a request-count delta.
        previous: [
          { $match: { at: { $gte: range.previousFrom, $lt: range.from } } },
          { $group: { _id: null, ...STATUS_ACCUMULATORS, ...DURATION_ACCUMULATORS } },
          { $project: { _id: 0 } },
        ],
        byEndpoint: [
          { $match: { at: inWindow } },
          {
            // Grouped on the recorded semantics, never on `path` — that holds the
            // raw URL, so `/products/1` and `/products/2` would be two endpoints.
            $group: {
              _id: { method: '$method', entity: '$entity', shape: '$shape' },
              count: { $sum: 1 },
              serverErrors: { $sum: { $cond: [{ $gte: ['$status', 500] }, 1, 0] } },
              ...DURATION_ACCUMULATORS,
            },
          },
          { $sort: { count: -1 } },
        ],
      },
    },
  ]);

  return result[0] ?? { daily: [], totals: [], previous: [], byEndpoint: [] };
}

/** Versions and failed jobs for one project, newest first. */
async function projectActivity(
  project: IProject,
  limit: number,
  since: Date,
): Promise<ActivityEvent[]> {
  const projectId = project._id as Types.ObjectId;
  const name = project.name;

  // Two indexed reads merged in memory rather than a $unionWith: each keeps its
  // own sort and limit, and neither collection has to lead.
  const [versions, jobs] = await Promise.all([
    Version.find({ projectId, createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean(),
    Job.find({ projectId, status: 'failed_partial', createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean(),
  ]);

  const generated = versions.map((version) =>
    versionEvent({
      id: String(version._id),
      projectId: String(projectId),
      projectName: name,
      version: version.version,
      note: version.note ?? null,
      createdAt: version.createdAt,
    }),
  );

  const failed = jobs.map((job) =>
    failedJobEvent({
      id: String(job._id),
      projectId: String(projectId),
      projectName: name,
      failed: job.workers.filter((worker) => worker.status === 'failed').length,
      total: job.workers.length,
      // `completedAt` when the job finished, so the event is dated by when it
      // failed rather than when it was queued.
      at: job.completedAt ?? job.createdAt,
    }),
  );

  return mergeActivity([generated, failed], limit);
}

/** Average duration for a facet row, or null when nothing in it was timed. */
function facetAverage(row: TotalsRow): number | null {
  return averageDuration(row.durationSum, row.durationSamples).avgDurationMs;
}

export async function buildProjectMetrics(
  project: IProject,
  query: ProjectMetricsQuery,
  now: Date = new Date(),
): Promise<ProjectMetricsView> {
  const window = resolveWindow(query.days, now);
  // The previous window is the same length immediately before this one, so the
  // change percentage compares like with like.
  const previousFrom = new Date(window.from.getTime() - query.days * 24 * 60 * 60 * 1000);

  const facets = await aggregateProjectRequests(project._id as Types.ObjectId, {
    from: window.from,
    to: window.to,
    previousFrom,
  });

  const totals = facets.totals[0] ?? EMPTY_TOTALS;
  const previous = facets.previous[0] ?? EMPTY_TOTALS;

  const rates = requestRates({
    total: totals.total,
    clientErrors: totals.clientErrors,
    serverErrors: totals.serverErrors,
  });
  const duration = averageDuration(totals.durationSum, totals.durationSamples);
  const previousAvg = facetAverage(previous);

  const topEndpoints: EndpointUsage[] = facets.byEndpoint
    // A row with no shape resolved to the project but not to an endpoint (a 404
    // on an unknown entity, or traffic logged before attribution existed). It
    // belongs in the totals and not in a breakdown *of endpoints*.
    .filter((row) => row._id.shape !== null)
    .map((row) => ({
      method: row._id.method,
      entity: row._id.entity,
      shape: row._id.shape,
      count: row.count,
      avgDurationMs: averageDuration(row.durationSum, row.durationSamples).avgDurationMs,
      durationSampleCount: row.durationSamples,
      serverErrors: row.serverErrors,
    }));

  const attributed = topEndpoints.reduce((sum, row) => sum + row.count, 0);
  const entities = (project.ips?.entities ?? []) as IpsEntity[];

  return {
    window: {
      days: query.days,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      tz: 'UTC',
      retentionDays: LOG_RETENTION_DAYS,
    },
    endpoints: {
      total: countEndpoints(entities, project.generationConfig.methods),
      entities: entities.length,
    },
    requests: {
      total: totals.total,
      previousTotal: previous.total,
      changePercent: percentChange(totals.total, previous.total),
      ...rates,
      avgDurationMs: duration.avgDurationMs,
      previousAvgDurationMs: previousAvg,
      // Null unless both windows were sampled — a delta against nothing is not a
      // delta, and rendering it as 0 would claim the latency was unchanged.
      durationChangeMs:
        duration.avgDurationMs !== null && previousAvg !== null
          ? duration.avgDurationMs - previousAvg
          : null,
      durationSampleCount: duration.durationSampleCount,
      series: zeroFillSeries(facets.daily, query.days, now),
    },
    topEndpoints,
    unattributedRequests: totals.total - attributed,
    // Only mentioned when there is something to explain.
    endpointNote: totals.total > attributed ? ENDPOINT_NOTE : null,
    activity: await projectActivity(project, query.activityLimit, previousFrom),
  };
}
