// @instantmockapi/shared — Logger, errors, result types, constants
// Shared utilities consumed by every package in the monorepo.

export {
  AppError,
  getErrorMessage,
  REQUEST_ID_PATTERN,
  type ErrorCode,
  type ErrorDetail,
} from './errors.js';
export { type Result, type Ok, type Err, ok, err, unwrap } from './result.js';
export { Logger, logger, type LogLevel } from './logger.js';
export {
  createRequestObserver,
  type RequestLogEntry,
  type RequestObserver,
  type RequestObserverOptions,
} from './request-log.js';
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
export {
  PUBLIC_ID_PREFIX,
  PROJECT_KINDS,
  type ProjectKind,
  OBJECT_ID_PATTERN,
  PUBLIC_ID_PATTERN,
  SLUG_PATTERN,
  SLUG_MAX_LENGTH,
  RESERVED_SLUGS,
  type HostedRef,
  hostedPath,
  hostedUrl,
  slugify,
  isUsableSlug,
} from './hosting-urls.js';
export {
  type IpsField,
  type IpsRelation,
  type IpsEntity,
  type EndpointRow,
  type SnippetLanguage,
  type SnippetInput,
  SNIPPET_LANGUAGES,
  entityEndpoints,
  projectEndpoints,
  countEndpoints,
  exampleBody,
  exampleQuery,
  buildSnippet,
  pythonLiteral,
  endpointUrl,
} from './endpoints.js';

export { entitySlug, type RoutableEntity } from './routing.js';

/**
 * Runtime readiness and the promotion policy (Phase 1).
 *
 * The separation these encode: a job settles → artifact statuses change → the
 * version's runtime readiness is recalculated → the promotion policy decides →
 * the live pointer moves. `hosted_api` is the only artifact the runtime reads, so
 * a failed OpenAPI or Postman generator degrades a version rather than blocking
 * it. A failed generation can never disable the currently live version.
 */
export {
  RUNTIME_REQUIRED_ARTIFACTS,
  VERSION_STATUSES,
  evaluateAutoPublish,
  evaluatePromotion,
  evaluateRuntimeReadiness,
  isRuntimeRequiredArtifact,
  versionStatus,
  type ArtifactOutcome,
  type PromotionDecision,
  type RuntimeReadiness,
  type RuntimeRequiredArtifact,
  type VersionStatus,
} from './promotion.js';

/**
 * Which generated artifacts are behind the version being served (Phase 2 §18).
 *
 * The counterpart to selective regeneration: deselecting an affected artifact is
 * allowed, and the consequence is named rather than hidden.
 */
export {
  evaluateSyncState,
  type ArtifactSyncState,
  type ArtifactVersionRow,
  type SyncReport,
} from './sync-state.js';
