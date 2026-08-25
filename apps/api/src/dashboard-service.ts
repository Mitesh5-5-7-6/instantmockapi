/**
 * Everything behind `GET /v1/dashboard`.
 *
 * Sits beside its route the way `generation-service.ts` does, so the route stays
 * a thin schema-plus-handler and the querying is testable through the API
 * harness.
 *
 * ## Why one composite endpoint rather than several
 *
 * Every panel on that screen needs the same two inputs: the caller's project-id
 * list, and one time window. Split into `/stats`, `/requests/series` and
 * `/activity`, each call re-derives the id list — and, worse, **they can
 * disagree**: fetched a few hundred milliseconds apart across a bucket boundary,
 * the tile total stops equalling the sum of the chart, which a user can only read
 * as a bug. Computing every request-derived figure inside one `$facet` over one
 * `$match` makes that agreement true by construction.
 */

// Type-only: `mongoose` is not a dependency of this app (it arrives via
// @instantmockapi/db), so a value import would resolve at build time and then
// fail at runtime with "Cannot find package 'mongoose'".
import type { Types } from 'mongoose';
import { getPlanConfig } from '@instantmockapi/config';
import { Job, Project, ApiLog, Version, type IProject } from '@instantmockapi/db';
import { countEndpoints, type IpsEntity, type PlanTier } from '@instantmockapi/shared';
import {
  averageDuration,
  dayKey,
  percentChange,
  planLimit,
  requestRates,
  resolveWindow,
  zeroFillSeries,
  type RawBucket,
  type SeriesBucket,
} from './metrics.js';
import {
  failedJobEvent,
  mergeActivity,
  projectCreatedEvent,
  versionEvent,
  type ActivityEvent,
} from './activity.js';

/** Retention of the hosted request log, mirrored from the ApiLog TTL index. */
const LOG_RETENTION_DAYS = 30;

const REQUEST_NOTE =
  'Counted from hosted-request logs, which are retained for 30 days and removed when a project expires or is deleted.';

export interface DashboardQuery {
  days: number;
  activityLimit: number;
}

export interface DashboardView {
  window: { days: number; from: string; to: string; tz: 'UTC'; retentionDays: number };
  projects: { total: number; createdInWindow: number; byStatus: Record<string, number> };
  endpoints: { total: number; inProjectsCreatedThisMonth: number };
  requests: {
    total: number;
    previousTotal: number;
    changePercent: number | null;
    successRate: number | null;
    clientErrorRate: number | null;
    serverErrorRate: number | null;
    avgDurationMs: number | null;
    durationSampleCount: number;
    series: SeriesBucket[];
    byProject: Record<string, number>;
    note: string;
  };
  hosted: { live: number; total: number; soonestExpiresAt: string | null };
  plan: {
    tier: PlanTier;
    projects: { used: number; limit: number | null };
    concurrentJobs: { used: number; limit: number | null };
    hostedApiLifetimeDays: number;
  };
  activity: ActivityEvent[];
}

/** The project fields the dashboard reads. `inputSource.raw` is deliberately excluded. */
const PROJECT_FIELDS =
  '_id name status kind createdAt updatedAt currentVersion hosted inputSource.type ips.entities generationConfig.methods';

type DashboardProject = Pick<
  IProject,
  'name' | 'status' | 'createdAt' | 'hosted' | 'currentVersion'
> & {
  _id: Types.ObjectId;
  inputSource: { type: string };
  ips?: { entities?: IpsEntity[] };
  generationConfig?: { methods?: string[] };
};

/** Shape of the single `$facet` aggregation's result. */
interface RequestFacets {
  daily: RawBucket[];
  totals: {
    total: number;
    clientErrors: number;
    serverErrors: number;
    durationSum: number;
    durationSamples: number;
  }[];
  byProject: { _id: Types.ObjectId; count: number }[];
  previous: { total: number }[];
}

export async function buildDashboard(
  ownerId: string,
  query: DashboardQuery,
  plan: PlanTier,
  /** Injected so tests can freeze the clock; today's bucket depends on it. */
  now: Date = new Date(),
): Promise<DashboardView> {
  const { from, to } = resolveWindow(query.days, now);
  const previousFrom = new Date(from.getTime() - query.days * 86_400_000);
  const monthStart = new Date(`${dayKey(now).slice(0, 7)}-01T00:00:00.000Z`);

  // One indexed read, covered by {ownerId, updatedAt}. Needed by the projects
  // tile, the endpoint sum, the hosted tile and the activity feed regardless, so
  // the id list the aggregation needs costs nothing extra.
  const projects = (await Project.find({ ownerId })
    .select(PROJECT_FIELDS)
    .sort({ updatedAt: -1 })
    .lean()) as unknown as DashboardProject[];

  // ⚠️ Real ObjectIds, never String(project._id). Mongoose casts *queries* but
  // NOT aggregation pipelines, so string ids in `$in` match nothing at all and
  // the whole dashboard silently reads zero — no error, no warning.
  const projectIds = projects.map((project) => project._id);
  const nameById = new Map(projects.map((project) => [String(project._id), project.name]));

  const facets = await aggregateRequests(projectIds, { from, to, previousFrom });

  const totals = facets.totals[0] ?? {
    total: 0,
    clientErrors: 0,
    serverErrors: 0,
    durationSum: 0,
    durationSamples: 0,
  };
  const previousTotal = facets.previous[0]?.total ?? 0;

  const byStatus: Record<string, number> = {};
  for (const project of projects) {
    byStatus[project.status] = (byStatus[project.status] ?? 0) + 1;
  }

  const endpointsOf = (project: DashboardProject): number =>
    countEndpoints(project.ips?.entities ?? [], project.generationConfig?.methods ?? []);

  const liveProjects = projects.filter(
    (project) =>
      project.status === 'active' &&
      (!project.hosted?.expiresAt || project.hosted.expiresAt.getTime() > now.getTime()),
  );
  const soonestExpiry = liveProjects
    .map((project) => project.hosted?.expiresAt)
    .filter((expiresAt): expiresAt is Date => expiresAt instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  const planConfig = getPlanConfig(plan);
  const activeJobs = await Job.countDocuments({
    projectId: { $in: projectIds },
    status: { $in: ['queued', 'running'] },
  });

  return {
    window: {
      days: query.days,
      from: from.toISOString(),
      to: to.toISOString(),
      tz: 'UTC',
      retentionDays: LOG_RETENTION_DAYS,
    },
    projects: {
      total: projects.length,
      // "Created this month", not a net change: hard-delete means a delta and the
      // total can contradict each other (delete one, create two, total unchanged).
      createdInWindow: projects.filter((project) => project.createdAt >= monthStart).length,
      byStatus,
    },
    endpoints: {
      total: projects.reduce((sum, project) => sum + endpointsOf(project), 0),
      inProjectsCreatedThisMonth: projects
        .filter((project) => project.createdAt >= monthStart)
        .reduce((sum, project) => sum + endpointsOf(project), 0),
    },
    requests: {
      total: totals.total,
      previousTotal,
      changePercent: percentChange(totals.total, previousTotal),
      ...requestRates(totals),
      ...averageDuration(totals.durationSum, totals.durationSamples),
      series: zeroFillSeries(facets.daily, query.days, now),
      byProject: Object.fromEntries(
        facets.byProject.map((row) => [String(row._id), row.count] as const),
      ),
      note: REQUEST_NOTE,
    },
    hosted: {
      live: liveProjects.length,
      total: projects.length,
      soonestExpiresAt: soonestExpiry ? soonestExpiry.toISOString() : null,
    },
    plan: {
      tier: plan,
      projects: { used: projects.length, limit: planLimit(planConfig.maxProjects) },
      concurrentJobs: { used: activeJobs, limit: planLimit(planConfig.maxConcurrentJobs) },
      hostedApiLifetimeDays: planConfig.hostedApiLifetimeDays,
    },
    activity: await buildActivity(projects, nameById, query.activityLimit),
  };
}

/**
 * Every request-derived figure, from one `$match` split by `$facet`.
 *
 * The point of the single pipeline is agreement: the chart, the summary totals
 * and the per-project counts are computed over the identical matched set, so the
 * series provably sums to the total. `previous` sits in the same pipeline for the
 * same reason — a separate query could straddle a boundary and produce a change
 * percentage against a window the rest of the payload never saw.
 */
async function aggregateRequests(
  projectIds: readonly Types.ObjectId[],
  range: { from: Date; to: Date; previousFrom: Date },
): Promise<RequestFacets> {
  const empty: RequestFacets = { daily: [], totals: [], byProject: [], previous: [] };
  // `$in: []` is valid and matches nothing, but short-circuiting saves a round
  // trip for every brand-new account — the most common state on this screen.
  if (projectIds.length === 0) {
    return empty;
  }

  const inWindow = { $gte: range.from, $lt: range.to };
  const result = await ApiLog.aggregate<RequestFacets>([
    { $match: { projectId: { $in: projectIds }, at: { $gte: range.previousFrom, $lt: range.to } } },
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
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              clientErrors: {
                $sum: {
                  $cond: [{ $and: [{ $gte: ['$status', 400] }, { $lt: ['$status', 500] }] }, 1, 0],
                },
              },
              serverErrors: { $sum: { $cond: [{ $gte: ['$status', 500] }, 1, 0] } },
              // Sum and count only the rows that actually carry a duration:
              // coercing a missing value to 0 would drag the mean toward zero for
              // a whole retention window.
              durationSum: {
                $sum: { $cond: [{ $isNumber: '$durationMs' }, '$durationMs', 0] },
              },
              durationSamples: { $sum: { $cond: [{ $isNumber: '$durationMs' }, 1, 0] } },
            },
          },
          { $project: { _id: 0 } },
        ],
        byProject: [
          { $match: { at: inWindow } },
          { $group: { _id: '$projectId', count: { $sum: 1 } } },
        ],
        previous: [
          { $match: { at: { $gte: range.previousFrom, $lt: range.from } } },
          { $group: { _id: null, total: { $sum: 1 } } },
          { $project: { _id: 0 } },
        ],
      },
    },
  ]);

  return result[0] ?? empty;
}

/**
 * The feed: three indexed reads merged in memory.
 *
 * Deliberately not `$unionWith` — that would force one lead collection, restate
 * three different match/sort shapes as a single pipeline, and forfeit each
 * collection's own index for the sort, all for a six-row panel.
 */
async function buildActivity(
  projects: readonly DashboardProject[],
  nameById: ReadonlyMap<string, string>,
  limit: number,
): Promise<ActivityEvent[]> {
  const projectIds = projects.map((project) => project._id);
  if (projectIds.length === 0) {
    return [];
  }

  const [versions, failedJobs] = await Promise.all([
    Version.find({ projectId: { $in: projectIds } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean(),
    Job.find({ projectId: { $in: projectIds }, status: 'failed_partial' })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean(),
  ]);

  const created = [...projects]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit)
    .map((project) =>
      projectCreatedEvent({
        id: String(project._id),
        name: project.name,
        createdAt: project.createdAt,
        inputType: project.inputSource?.type ?? 'json',
      }),
    );

  const generated = versions.map((version) =>
    versionEvent({
      id: String(version._id),
      projectId: String(version.projectId),
      projectName: nameById.get(String(version.projectId)) ?? 'a project',
      version: version.version,
      note: version.note ?? null,
      createdAt: version.createdAt,
    }),
  );

  const failed = failedJobs.map((job) =>
    failedJobEvent({
      id: String(job._id),
      projectId: String(job.projectId),
      projectName: nameById.get(String(job.projectId)) ?? 'a project',
      failed: job.workers.filter((worker) => worker.status === 'failed').length,
      total: job.workers.length,
      at: job.completedAt ?? job.createdAt,
    }),
  );

  return mergeActivity([created, generated, failed], limit);
}
