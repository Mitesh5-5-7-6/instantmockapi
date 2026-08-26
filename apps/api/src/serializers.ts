/**
 * Response serializers: mongoose documents → API JSON shapes.
 * Keeps _id/internal fields out of responses and list payloads light.
 */

import { getPlanConfig } from '@instantmockapi/config';
import type { IArtifact, IJob, IProject, IUser, IVersion } from '@instantmockapi/db';

/**
 * A plan limit on the wire.
 *
 * `PlanConfig` carries two different sentinels for "unlimited" —
 * `maxConcurrentJobs: Infinity` and `maxProjects: 0`. `JSON.stringify(Infinity)`
 * is `null`, so without normalising both the client would see one as null and
 * the other as a hard limit of zero.
 */
function planLimit(value: number): number | null {
  return !Number.isFinite(value) || value <= 0 ? null : value;
}

export function toUserView(user: IUser) {
  return {
    id: String(user._id),
    email: user.email,
    name: user.name ?? null,
    plan: user.plan,
    authProvider: user.authProvider,
    createdAt: user.createdAt,
    // Served rather than duplicated client-side: the settings screen used to
    // carry its own copy of this table, which drifts from packages/config the
    // first time a limit changes.
    limits: planLimits(user.plan),
  };
}

/** What the caller's plan allows. Usage counts live on the dashboard payload. */
export function planLimits(tier: IUser['plan']) {
  const plan = getPlanConfig(tier);
  return {
    maxProjects: planLimit(plan.maxProjects),
    maxConcurrentJobs: planLimit(plan.maxConcurrentJobs),
    hostedApiLifetimeDays: plan.hostedApiLifetimeDays,
  };
}

export function toProjectSummary(project: IProject) {
  return {
    id: String(project._id),
    name: project.name,
    // Addressing: the web app needs these to render the hosted base URL and to
    // branch the wizard/detail screens on project kind.
    kind: project.kind ?? 'project',
    publicId: project.publicId ?? null,
    slug: project.slug ?? null,
    description: project.description ?? null,
    status: project.status,
    currentVersion: project.currentVersion,
    inputType: project.inputSource.type,
    hosted: project.hosted,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

/**
 * A summary plus the figures the dashboard's project rows need.
 *
 * Kept separate rather than folded into `toProjectSummary` so the default list
 * payload stays byte-identical — every other caller (the wizard, the project
 * picker) would otherwise pay for a projection it does not read.
 */
export function toProjectSummaryWithCounts(
  project: IProject,
  counts: { endpointCount: number; requestCount: number; requestWindowDays: number },
) {
  return { ...toProjectSummary(project), ...counts };
}

export function toProjectDetail(project: IProject) {
  return {
    ...toProjectSummary(project),
    ips: project.ips,
    generationConfig: project.generationConfig,
  };
}

export function toJobView(job: IJob) {
  // Progress aggregator (doc 10 §8): settled (completed|failed) / total selected
  const total = job.workers.length;
  const settled = job.workers.filter(
    (w) => w.status === 'completed' || w.status === 'failed',
  ).length;

  return {
    id: String(job._id),
    projectId: String(job.projectId),
    version: job.version,
    type: job.type,
    status: job.status,
    progress: {
      settled,
      total,
      percent: total > 0 ? Math.round((settled / total) * 100) : 0,
    },
    requestedArtifacts: job.requestedArtifacts,
    workers: job.workers.map((w) => ({
      worker: w.worker,
      artifactType: w.artifactType,
      status: w.status,
      error: w.error ?? null,
    })),
    createdAt: job.createdAt,
    completedAt: job.completedAt,
  };
}

export function toArtifactView(artifact: IArtifact) {
  return {
    id: String(artifact._id),
    projectId: String(artifact.projectId),
    artifactType: artifact.artifactType,
    version: artifact.version,
    status: artifact.status,
    workerId: artifact.workerId,
    generatedAt: artifact.generatedAt,
    errorMessage: artifact.errorMessage,
    storageRef: artifact.storageRef,
  };
}

export function toVersionView(version: IVersion) {
  return {
    id: String(version._id),
    projectId: String(version.projectId),
    version: version.version,
    note: version.note ?? null,
    createdAt: version.createdAt,
  };
}
