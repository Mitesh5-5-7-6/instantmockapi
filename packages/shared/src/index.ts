// @instantmockapi/shared — Logger, errors, result types, constants
// Shared utilities consumed by every package in the monorepo.

export { AppError, getErrorMessage, type ErrorCode, type ErrorDetail } from './errors.js';
export { type Result, type Ok, type Err, ok, err, unwrap } from './result.js';
export { Logger, logger, type LogLevel } from './logger.js';
export {
  // Project
  PROJECT_STATUSES,
  type ProjectStatus,
  // Artifact
  ARTIFACT_STATUSES,
  type ArtifactStatus,
  ARTIFACT_TYPES,
  type ArtifactType,
  // Job
  JOB_STATUSES,
  type JobStatus,
  JOB_TYPES,
  type JobType,
  // Worker
  WORKER_IDS,
  type WorkerId,
  WORKER_ARTIFACT_MAP,
  // Input
  INPUT_SOURCE_TYPES,
  type InputSourceType,
  // HTTP
  HTTP_METHODS,
  type HttpMethod,
  // Plan
  PLAN_TIERS,
  type PlanTier,
} from './constants.js';
