/**
 * Generation job creation shared by /generate, /regenerate, and /generate-again.
 *
 * Flow (doc 08 §4, doc 10): idempotency-dedupe → version snapshot → registry
 * records reset to pending → job document → BullMQ enqueue → project marked
 * generating. Duplicate rapid calls with the same idempotency key return the
 * existing job instead of creating a new one.
 */

import { logger, unwrap, type ArtifactType, type JobType, type PlanTier } from '@instantmockapi/shared';
import { canCreateJob } from '@instantmockapi/config';
import { Job, Project, Version, type IProject } from '@instantmockapi/db';
import { createOrResetArtifactRecord } from '@instantmockapi/registry';
import { enqueueGenerationJob, generateIdempotencyKey } from '@instantmockapi/queue';
import type { GenerationConfig } from '@instantmockapi/ips';
import { workersForArtifacts } from './generation-config.js';

export interface CreatedJobRef {
  jobId: string;
  status: string;
  deduped: boolean;
}

export async function createGenerationJob(params: {
  project: IProject;
  type: JobType;
  requestedArtifacts: ArtifactType[];
  generationConfig: GenerationConfig;
  plan: PlanTier;
}): Promise<CreatedJobRef> {
  const { project, type, requestedArtifacts, generationConfig, plan } = params;
  const projectId = String(project._id);
  const version = project.currentVersion;

  const idempotencyKey = generateIdempotencyKey(
    projectId,
    version,
    generationConfig,
    requestedArtifacts,
  );

  // Idempotency dedupe: identical rapid calls return the existing job (doc 08 §4)
  const existing = await Job.findOne({ idempotencyKey });
  if (existing) {
    return { jobId: String(existing._id), status: existing.status, deduped: true };
  }

  // Plan concurrency (Free 1 / Pro 3 / Enterprise ∞): at the limit the job is
  // still accepted and queued — never rejected. Workers enforce actual
  // execution concurrency when the pipeline lands in Phase 5.
  const ownedProjectIds = await Project.find({ ownerId: project.ownerId }).select('_id');
  const activeJobs = await Job.countDocuments({
    projectId: { $in: ownedProjectIds.map((p) => p._id) },
    status: { $in: ['queued', 'running'] },
  });
  if (!canCreateJob(plan, activeJobs)) {
    logger.info('Plan concurrency limit reached; job accepted and left queued', {
      projectId,
      plan,
      activeJobs,
    });
  }

  // Immutable snapshot of what this version generates from (doc 07 §2)
  await Version.findOneAndUpdate(
    { projectId: project._id, version },
    { $setOnInsert: { ipsSnapshot: project.ips, configSnapshot: generationConfig } },
    { upsert: true },
  );

  // Registry rows reset to pending for every requested artifact
  for (const artifactType of requestedArtifacts) {
    const reset = await createOrResetArtifactRecord(projectId, artifactType, version);
    unwrap(reset);
  }

  let job;
  try {
    job = await Job.create({
      projectId: project._id,
      version,
      type,
      requestedArtifacts,
      idempotencyKey,
      status: 'queued',
      workers: workersForArtifacts(requestedArtifacts),
    });
  } catch (error) {
    // Race on the unique idempotencyKey index: another request won — return its job
    if ((error as { code?: number }).code === 11000) {
      const winner = await Job.findOne({ idempotencyKey });
      if (winner) {
        return { jobId: String(winner._id), status: winner.status, deduped: true };
      }
    }
    throw error;
  }

  await enqueueGenerationJob(
    projectId,
    version,
    type,
    requestedArtifacts,
    idempotencyKey,
    String(job._id),
  );

  project.status = 'generating';
  project.generationConfig = generationConfig;
  await project.save();

  return { jobId: String(job._id), status: job.status, deduped: false };
}
