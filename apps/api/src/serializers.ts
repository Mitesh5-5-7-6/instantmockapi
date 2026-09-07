/**
 * Response serializers: mongoose documents → API JSON shapes.
 * Keeps _id/internal fields out of responses and list payloads light.
 */

import { getPlanConfig } from '@instantmockapi/config';
import { hasPendingRegeneration } from '@instantmockapi/db';
import type { IArtifact, IJob, IProject, IUser, IVersion } from '@instantmockapi/db';
import type { VersionStatus } from '@instantmockapi/shared';

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
    /*
     * The two version numbers, both on the wire (Phase 2).
     *
     * `currentVersion` is the DEFINITION — what the user is editing.
     * `publishedVersion` is what the hosted API SERVES. They diverge the moment
     * anything is edited, and the client had no way to know: only
     * `currentVersion` was ever exposed, so every screen showing "v4" was
     * naming a version that may not be live.
     *
     * `publishedVersion` can be `null` — a project that has never generated has
     * nothing live — which is a different statement from "v1", and the reason
     * this is not collapsed into one number here.
     */
    publishedVersion: project.publishedVersion ?? null,
    /** `currentVersion > publishedVersion`: edits are waiting to be generated. */
    pendingRegeneration: hasPendingRegeneration(project),
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

/**
 * One row of the version history (Phase 2 §8, §28).
 *
 * `status` is **derived**, and is passed in rather than read off the document
 * because it depends on the project's published pointer and on the version's
 * artifact rows — neither of which a `Version` document knows about. Storing it
 * would make it a cache of the artifact rows that nothing recomputes; see
 * `versionStatus` in `@instantmockapi/shared`.
 *
 * §28: metadata only. The snapshot bodies never cross the wire from here — the
 * comparison endpoint is where a caller pays for those, and only on demand.
 */
export function toVersionView(version: IVersion, status?: VersionStatus) {
  return {
    id: String(version._id),
    projectId: String(version.projectId),
    version: version.version,
    note: version.note ?? null,
    createdAt: version.createdAt,

    // Phase 2 metadata. `null` rather than absent for the fields a pre-Phase-2
    // row simply does not have, so a client never has to distinguish "not
    // recorded" from "not sent".
    parentVersion: version.parentVersion ?? null,
    changeType: version.changeType ?? null,
    changeSummary: version.changeSummary ?? null,
    publishedAt: version.publishedAt ?? null,
    rollbackSourceVersion: version.rollbackSourceVersion ?? null,
    ...(status === undefined ? {} : { status }),
  };
}
