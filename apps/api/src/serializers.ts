/**
 * Response serializers: mongoose documents → API JSON shapes.
 * Keeps _id/internal fields out of responses and list payloads light.
 */

import type { IArtifact, IJob, IProject, IUser, IVersion } from '@instantmockapi/db';

export function toUserView(user: IUser) {
  return {
    id: String(user._id),
    email: user.email,
    plan: user.plan,
    authProvider: user.authProvider,
    createdAt: user.createdAt,
  };
}

export function toProjectSummary(project: IProject) {
  return {
    id: String(project._id),
    name: project.name,
    status: project.status,
    currentVersion: project.currentVersion,
    inputType: project.inputSource.type,
    hosted: project.hosted,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
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
    createdAt: version.createdAt,
  };
}
