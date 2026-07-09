import { Types } from 'mongoose';
import {
  Artifact,
  IArtifact,
  ArtifactType,
  ArtifactStatus,
} from '@instantmockapi/db';
import { logger, AppError, Result, ok, err } from '@instantmockapi/shared';
// Define valid status transitions in the state machine (doc 04 §F12, doc 07 §2)
const VALID_TRANSITIONS: Record<ArtifactStatus, ArtifactStatus[]> = {
  pending: ['generating'],
  generating: ['completed', 'failed'],
  completed: ['generating'],
  failed: ['generating'],
};
/**
 * Creates or resets a registry record for an artifact in a pending state.
 */
export async function createOrResetArtifactRecord(
  projectId: string,
  artifactType: ArtifactType,
  version: number
): Promise<Result<IArtifact, AppError>> {
  try {
    const pId = new Types.ObjectId(projectId);
    // Upsert to pending state
    const artifact = await Artifact.findOneAndUpdate(
      { projectId: pId, artifactType, version },
      {
        $set: {
          status: 'pending',
          workerId: null,
          generatedAt: null,
          errorMessage: null,
          storageRef: null,
        },
      },
      { new: true, upsert: true }
    );
    logger.debug(`Artifact registry record created/reset`, {
      projectId,
      artifactType,
      version,
      status: 'pending',
    });
    return ok(artifact);
  } catch (error: any) {
    logger.error('Failed to create artifact record', { error: error.message, projectId, artifactType });
    return err(
      new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to create artifact record',
      })
    );
  }
}
/**
 * Transition artifact status in the registry. Enforces state machine rules.
 */
export async function transitionArtifactStatus(
  projectId: string,
  artifactType: ArtifactType,
  version: number,
  newStatus: ArtifactStatus,
  options: {
    storageRef?: string | null;
    errorMessage?: string | null;
    workerId?: string | null;
  } = {}
): Promise<Result<IArtifact, AppError>> {
  try {
    const pId = new Types.ObjectId(projectId);
    // 1. Fetch current record
    const artifact = await Artifact.findOne({
      projectId: pId,
      artifactType,
      version,
    });
    if (!artifact) {
      logger.error('Artifact not found in registry', { projectId, artifactType, version });
      return err(
        new AppError({
          code: 'NOT_FOUND',
          message: `Artifact ${artifactType} version ${version} not found for project ${projectId}`,
        })
      );
    }
    const currentStatus = artifact.status;
    // 2. Validate transition
    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(newStatus)) {
      const msg = `Invalid artifact transition from '${currentStatus}' to '${newStatus}'`;
      logger.warn(msg, { projectId, artifactType, version });
      return err(
        new AppError({
          code: 'VALIDATION_ERROR',
          message: msg,
        })
      );
    }
    // 3. Perform update based on status
    const updateFields: Partial<IArtifact> = {
      status: newStatus,
    };
    if (options.workerId !== undefined) {
      updateFields.workerId = options.workerId;
    }
    if (newStatus === 'generating') {
      updateFields.errorMessage = null;
      updateFields.storageRef = null;
      updateFields.generatedAt = null;
    } else if (newStatus === 'completed') {
      updateFields.storageRef = options.storageRef ?? artifact.storageRef;
      updateFields.generatedAt = new Date();
      updateFields.errorMessage = null;
    } else if (newStatus === 'failed') {
      updateFields.errorMessage = options.errorMessage ?? 'Generation failed without details';
      updateFields.generatedAt = new Date();
      updateFields.storageRef = null;
    }
    const updated = await Artifact.findOneAndUpdate(
      { projectId: pId, artifactType, version },
      { $set: updateFields },
      { new: true }
    );
    if (!updated) {
      return err(
        new AppError({
          code: 'INTERNAL_ERROR',
          message: 'Failed to update artifact record',
        })
      );
    }
    logger.info(`Artifact transitioned successfully`, {
      projectId,
      artifactType,
      version,
      from: currentStatus,
      to: newStatus,
    });
    return ok(updated);
  } catch (error: any) {
    logger.error('Failed to transition artifact status', { error: error.message, projectId, artifactType });
    return err(
      new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to transition status',
      })
    );
  }
}
/**
 * Gets all artifact registry records for a specific project version.
 */
export async function getArtifactsForVersion(
  projectId: string,
  version: number
): Promise<Result<IArtifact[], AppError>> {
  try {
    const pId = new Types.ObjectId(projectId);
    const artifacts = await Artifact.find({ projectId: pId, version });
    return ok(artifacts);
  } catch (error: any) {
    logger.error('Failed to fetch artifacts for version', { error: error.message, projectId, version });
    return err(
      new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch artifacts',
      })
    );
  }
}
/**
 * Retrieve a specific artifact registry record.
 */
export async function getArtifactRecord(
  projectId: string,
  artifactType: ArtifactType,
  version: number
): Promise<Result<IArtifact | null, AppError>> {
  try {
    const pId = new Types.ObjectId(projectId);
    const artifact = await Artifact.findOne({ projectId: pId, artifactType, version });
    return ok(artifact);
  } catch (error: any) {
    logger.error('Failed to fetch artifact record', { error: error.message, projectId, artifactType, version });
    return err(
      new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch artifact record',
      })
    );
  }
}