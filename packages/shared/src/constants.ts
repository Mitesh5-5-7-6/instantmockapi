/**
 * Domain constants used across the platform.
 *
 * Status vocabulary, artifact types, and worker identifiers are defined here
 * to ensure code matches the documentation exactly (doc 17 §9).
 */

// ---------------------------------------------------------------------------
// Project statuses (doc 07, doc 11, doc 12)
// ---------------------------------------------------------------------------
export const PROJECT_STATUSES = ['draft', 'generating', 'active', 'expired'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Artifact statuses (doc 07 §2 `artifacts`, doc 12 §1)
// ---------------------------------------------------------------------------
export const ARTIFACT_STATUSES = ['pending', 'generating', 'completed', 'failed'] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Job statuses (doc 07 §2 `jobs`)
// ---------------------------------------------------------------------------
export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed_partial'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// ---------------------------------------------------------------------------
// Artifact types — the registry keys (doc 07 §2 `artifacts`)
// ---------------------------------------------------------------------------
export const ARTIFACT_TYPES = [
  'ips',
  'json_schema',
  'zod',
  'yup',
  'typescript',
  'mock_data',
  'openapi',
  'postman',
  'hosted_api',
  'export_zip',
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

// ---------------------------------------------------------------------------
// Worker identifiers and their artifact mappings (doc 09, doc 10)
// ---------------------------------------------------------------------------
export const WORKER_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type WorkerId = (typeof WORKER_IDS)[number];

export const WORKER_ARTIFACT_MAP: Record<WorkerId, ReadonlyArray<ArtifactType>> = {
  A: ['json_schema'],
  B: ['zod', 'yup'],
  C: ['typescript'],
  D: ['mock_data'],
  E: ['openapi', 'postman'],
  F: ['hosted_api'],
  G: ['export_zip'],
} as const;

// ---------------------------------------------------------------------------
// Input source types (doc 04 §F2, doc 07 §2 `projects.inputSource`)
// ---------------------------------------------------------------------------
export const INPUT_SOURCE_TYPES = ['json', 'swagger', 'builder', 'docs'] as const;
export type InputSourceType = (typeof INPUT_SOURCE_TYPES)[number];

// ---------------------------------------------------------------------------
// HTTP methods for the hosted mock API (doc 04 §F5)
// ---------------------------------------------------------------------------
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

// ---------------------------------------------------------------------------
// Plan tiers (doc 01 §7, doc 02 §7)
// ---------------------------------------------------------------------------
export const PLAN_TIERS = ['free', 'pro', 'enterprise'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

// ---------------------------------------------------------------------------
// Job types (doc 07 §2 `jobs.type`)
// ---------------------------------------------------------------------------
export const JOB_TYPES = ['full', 'partial'] as const;
export type JobType = (typeof JOB_TYPES)[number];
