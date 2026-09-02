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
  evaluatePromotion,
  evaluateRuntimeReadiness,
  isRuntimeRequiredArtifact,
  type ArtifactOutcome,
  type PromotionDecision,
  type RuntimeReadiness,
  type RuntimeRequiredArtifact,
} from './promotion.js';
