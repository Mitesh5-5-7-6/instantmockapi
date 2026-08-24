import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import { Project, IProject } from './models/project.js';
import { MockStore } from './models/mockStore.js';
import { ApiLog } from './models/apiLog.js';
import { Artifact } from './models/artifact.js';
import { Version } from './models/version.js';
import { Job } from './models/job.js';
import { AppError, PUBLIC_ID_PREFIX, logger, slugify } from '@instantmockapi/shared';

/** Attempts before giving up on finding a free public id. */
const MAX_PUBLIC_ID_ATTEMPTS = 5;
/** Suffix attempts before giving up on a free per-owner slug. */
const MAX_SLUG_ATTEMPTS = 50;
/**
 * Random bytes per public id. 5 bytes = 10 hex characters ≈ 1.1e12 values, which
 * keeps the birthday-collision point around a million projects rather than the
 * ~19k that 7 hex characters would give.
 */
const PUBLIC_ID_BYTES = 5;

/**
 * Mint `publicId` and `slug` if absent, so the project is addressable by its
 * pretty URL.
 *
 * Idempotent and safe to call on every write path — a project that already has
 * both is returned untouched without a save. A duplicate-key collision on
 * `publicId` is retried with a fresh value rather than surfaced.
 */
export async function ensurePublicIdentity(
  project: IProject,
  options: { bytes?: number } = {},
): Promise<IProject> {
  if (project.publicId && project.slug) {
    return project;
  }

  if (!project.slug) {
    const base = slugify(project.name);
    let candidate = base;
    for (let attempt = 2; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      const clash = await Project.exists({
        ownerId: project.ownerId,
        slug: candidate,
        _id: { $ne: project._id },
      });
      if (!clash) {
        break;
      }
      candidate = `${base}-${attempt}`;
    }
    project.slug = candidate;
  }

  if (project.publicId) {
    await project.save();
    return project;
  }

  const prefix = PUBLIC_ID_PREFIX[project.kind ?? 'project'];
  for (let attempt = 1; attempt <= MAX_PUBLIC_ID_ATTEMPTS; attempt++) {
    project.publicId = `${prefix}_${randomBytes(options.bytes ?? PUBLIC_ID_BYTES).toString('hex')}`;
    try {
      await project.save();
      return project;
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) {
        throw error;
      }
      logger.warn('Public id collision, retrying', {
        projectId: String(project._id),
        attempt,
      });
    }
  }

  throw new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Could not allocate a public API id',
  });
}

/**
 * Find all active projects that have passed their expiry date.
 */
export async function findExpiredProjects(): Promise<IProject[]> {
  const now = new Date();
  return Project.find({
    status: 'active',
    'hosted.expiresAt': { $lte: now },
  });
}

/**
 * Permanently deletes all ephemeral data for an expired project.
 * Nuls out registry artifact refs and updates status to 'expired'.
 */
export async function expireProjectInDB(projectId: string): Promise<void> {
  const pId = new Types.ObjectId(projectId);

  logger.info(`DB cleanup starting for expired project: ${projectId}`);

  // 1. Delete all hosted mockStores
  await MockStore.deleteMany({ projectId: pId });
  logger.debug(`Deleted all mockStores for project ${projectId}`);

  // 2. Delete apiLogs
  await ApiLog.deleteMany({ projectId: pId });
  logger.debug(`Deleted all apiLogs for project ${projectId}`);

  // 3. Mark all registry artifacts for this project as failed/un-stored (storageRef = null)
  await Artifact.updateMany({ projectId: pId }, { $set: { storageRef: null } });
  logger.debug(`Nulled all artifact storage references for project ${projectId}`);

  // 4. Update the project status to expired and clear hosted details
  await Project.updateOne(
    { _id: pId },
    {
      $set: {
        status: 'expired',
        'hosted.url': null,
        'hosted.expiresAt': null,
      },
    },
  );
  logger.info(`Successfully expired project ${projectId} in database`);
}

/**
 * Hard-deletes a project and all associated documents across all collections.
 * Used when a user manually deletes a project.
 */
export async function hardDeleteProject(projectId: string): Promise<void> {
  const pId = new Types.ObjectId(projectId);

  logger.info(`Hard-deleting all database records for project: ${projectId}`);

  await Promise.all([
    Project.deleteOne({ _id: pId }),
    Version.deleteMany({ projectId: pId }),
    Artifact.deleteMany({ projectId: pId }),
    Job.deleteMany({ projectId: pId }),
    MockStore.deleteMany({ projectId: pId }),
    ApiLog.deleteMany({ projectId: pId }),
  ]);

  logger.info(`Hard-delete completed for project: ${projectId}`);
}
