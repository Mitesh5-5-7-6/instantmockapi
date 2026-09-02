// @instantmockapi/db -- MongoDB models, indexes, cleanup queries

export { connectDB, disconnectDB } from './connection.js';

// Re-exported so other packages share this exact mongoose instance (and thus
// the connection opened by connectDB) rather than resolving their own copy.
export { default as mongoose } from 'mongoose';

// Export Models
export { User, type IUser } from './models/user.js';
export {
  AuthToken,
  AUTH_TOKEN_TTL_SECONDS,
  type IAuthToken,
  type AuthTokenKind,
} from './models/authToken.js';
export { Project, type IProject } from './models/project.js';
export { Version, type IVersion } from './models/version.js';
/**
 * The editable copy of a project's definition (Phase 1). One per project,
 * enforced by a unique index. Commit advances the definition; it does NOT
 * publish — the live runtime keeps serving its own version.
 */
export { ProjectDraft, type IProjectDraft } from './models/projectDraft.js';
export {
  Artifact,
  type IArtifact,
  type ArtifactType,
  type ArtifactStatus,
} from './models/artifact.js';
export { Job, type IJob, type IJobWorker } from './models/job.js';
export { MockStore, type IMockStore } from './models/mockStore.js';
export { ApiLog, USER_AGENT_MAX_LENGTH, type IApiLog, type ApiLogShape } from './models/apiLog.js';

// Export Queries
export {
  findExpiredProjects,
  expireProjectInDB,
  hardDeleteProject,
  ensurePublicIdentity,
} from './queries.js';

/**
 * The editing/deployment boundary (Phase 1).
 *
 * `publishedVersionOf` is the ONLY correct way to ask which version the hosted
 * runtime should serve — reading `project.publishedVersion` raw resolves
 * `undefined` for every project written before the split.
 */
export {
  publishedVersionOf,
  pinPublishedVersion,
  mustAdvanceBeforeGenerating,
  wouldDisturbLiveRuntime,
  hasPendingRegeneration,
  type VersionedProject,
} from './published-version.js';

/**
 * Version runtime state (Phase 1). Reads the artifact registry for ONE version,
 * because a partial regenerate touches a subset and readiness must be judged on
 * the whole set — which is what makes affected-artifacts-only regeneration safe.
 */
export { versionArtifactOutcomes } from './version-readiness.js';
