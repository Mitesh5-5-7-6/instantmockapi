/**
 * Generation job creation shared by /generate, /regenerate, and /generate-again.
 *
 * Flow (doc 08 §4, doc 10): idempotency-dedupe → version snapshot → registry
 * records reset to pending → job document → BullMQ enqueue → project marked
 * generating. Duplicate rapid calls with the same idempotency key return the
 * existing job instead of creating a new one.
 */

import {
  AppError,
  logger,
  unwrap,
  type ArtifactType,
  type JobType,
  type PlanTier,
} from '@instantmockapi/shared';
import { canCreateJob } from '@instantmockapi/config';
import { Job, Project, Version, wouldDisturbLiveRuntime, type IProject } from '@instantmockapi/db';
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
  /** Recorded on the version snapshot (doc 03 §7): why this version exists. */
  note?: string;
}): Promise<CreatedJobRef> {
  const { project, type, requestedArtifacts, generationConfig, plan, note } = params;
  const projectId = String(project._id);

  // The version is chosen by the caller. The routes that regenerate advance it
  // unconditionally; the full-generate route advances it only when the current
  // version is the live one (see `mustAdvanceBeforeGenerating`).
  const version = project.currentVersion;
  // Belt and braces. The routes make this unreachable; if it
  // ever fires, a caller has bypassed it and we would rather fail loudly than
  // reset a live artifact to pending and serve an unexplainable 404.
  if (wouldDisturbLiveRuntime(project, version)) {
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: `Refusing to generate into v${version}, which is currently serving traffic`,
    });
  }

  // Keyed on projectId + version + config + artifacts + the SCHEMA. Without the
  // schema, two generations of different definitions at the same version hash
  // identically and the second dedupes into the first — generating the wrong
  // thing. The version is now always fresh for a live project, so that can't
  // arise from a plain regenerate, but a restore rewrites `ips` and a draft
  // commit will too, and neither should be able to alias.
  const idempotencyKey = generateIdempotencyKey(
    projectId,
    version,
    generationConfig,
    requestedArtifacts,
    project.ips,
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

  // Immutable snapshot of what this version generates from (doc 07 §2).
  // note is stamped on insert; partial regens/restores bump to a fresh version
  // so this is a genuine insert and the note lands reliably.
  await Version.findOneAndUpdate(
    { projectId: project._id, version },
    {
      $setOnInsert: {
        ipsSnapshot: project.ips,
        configSnapshot: generationConfig,
        note: note ?? null,
      },
    },
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
