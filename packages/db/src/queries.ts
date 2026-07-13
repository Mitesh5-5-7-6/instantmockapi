import { Types } from 'mongoose';
import { Project, IProject } from './models/project.js';
import { MockStore } from './models/mockStore.js';
import { ApiLog } from './models/apiLog.js';
import { Artifact } from './models/artifact.js';
import { Version } from './models/version.js';
import { Job } from './models/job.js';
import { logger } from '@instantmockapi/shared';

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
