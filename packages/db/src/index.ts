// @instantmockapi/db -- MongoDB models, indexes, cleanup queries

export { connectDB, disconnectDB } from './connection.js';

// Re-exported so other packages share this exact mongoose instance (and thus
// the connection opened by connectDB) rather than resolving their own copy.
export { default as mongoose } from 'mongoose';

// Export Models
export { User, type IUser } from './models/user.js';
export { Project, type IProject } from './models/project.js';
export { Version, type IVersion } from './models/version.js';
export {
  Artifact,
  type IArtifact,
  type ArtifactType,
  type ArtifactStatus,
} from './models/artifact.js';
export { Job, type IJob, type IJobWorker } from './models/job.js';
export { MockStore, type IMockStore } from './models/mockStore.js';
export { ApiLog, type IApiLog } from './models/apiLog.js';

// Export Queries
export { findExpiredProjects, expireProjectInDB, hardDeleteProject } from './queries.js';
