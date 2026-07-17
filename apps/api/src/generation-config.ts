/**
 * Generation-config semantics: validation beyond JSON-schema shape checks,
 * plus the mapping from a config to requested artifacts and workers (doc 09).
 */

import {
  AppError,
  HTTP_METHODS,
  WORKER_ARTIFACT_MAP,
  WORKER_IDS,
  type ArtifactType,
  type ErrorDetail,
  type Result,
  type WorkerId,
  ok,
  err,
} from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import type { GenerationConfig } from '@instantmockapi/ips';
import type { IJobWorker } from '@instantmockapi/db';

const ALLOWED_VALIDATORS = ['zod', 'yup', 'jsonschema'] as const;
const ALLOWED_TYPES = ['typescript'] as const;

/** Artifact types a client may request via `POST /regenerate` ('ips' is API-managed). */
export const REGENERATABLE_ARTIFACTS: readonly ArtifactType[] = [
  'json_schema',
  'zod',
  'yup',
  'typescript',
  'mock_data',
  'openapi',
  'postman',
  'hosted_api',
  'export_zip',
];

function isSubset(values: unknown, allowed: readonly string[]): values is string[] {
  return Array.isArray(values) && values.every((v) => typeof v === 'string' && allowed.includes(v));
}

/** Semantic validation of a generation config (doc 08 §7 example, doc 13 §3). */
export function validateGenerationConfig(
  input: unknown,
  env: EnvConfig,
): Result<GenerationConfig, AppError> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return err(
      new AppError({ code: 'VALIDATION_ERROR', message: 'generationConfig must be an object' }),
    );
  }
  const cfg = input as Partial<GenerationConfig>;
  const details: ErrorDetail[] = [];

  if (!isSubset(cfg.validators, ALLOWED_VALIDATORS)) {
    details.push({
      path: 'generationConfig.validators',
      issue: `must be an array drawn from ${ALLOWED_VALIDATORS.join(', ')}`,
    });
  }
  if (!isSubset(cfg.types, ALLOWED_TYPES)) {
    details.push({
      path: 'generationConfig.types',
      issue: `must be an array drawn from ${ALLOWED_TYPES.join(', ')}`,
    });
  }
  if (!isSubset(cfg.methods, HTTP_METHODS) || cfg.methods.length === 0) {
    details.push({
      path: 'generationConfig.methods',
      issue: `must be a non-empty subset of ${HTTP_METHODS.join(',')}`,
    });
  }
  if (
    typeof cfg.mockRecords !== 'number' ||
    !Number.isInteger(cfg.mockRecords) ||
    cfg.mockRecords < 1 ||
    cfg.mockRecords > env.maxMockRecords
  ) {
    details.push({
      path: 'generationConfig.mockRecords',
      issue: `must be an integer between 1 and ${env.maxMockRecords}`,
    });
  }

  if (details.length > 0) {
    return err(
      new AppError({ code: 'VALIDATION_ERROR', message: 'Invalid generation config', details }),
    );
  }
  return ok({
    validators: [...(cfg.validators as string[])],
    types: [...(cfg.types as string[])],
    methods: [...(cfg.methods as GenerationConfig['methods'])],
    mockRecords: cfg.mockRecords as number,
  });
}

/** Artifacts a full generation produces for a given config. */
export function deriveRequestedArtifacts(config: GenerationConfig): ArtifactType[] {
  const artifacts: ArtifactType[] = ['json_schema'];
  if (config.validators.includes('zod')) {
    artifacts.push('zod');
  }
  if (config.validators.includes('yup')) {
    artifacts.push('yup');
  }
  if (config.types.includes('typescript')) {
    artifacts.push('typescript');
  }
  artifacts.push('mock_data', 'openapi', 'postman', 'hosted_api', 'export_zip');
  return artifacts;
}

/** Per-worker job entries for the requested artifacts (doc 10). */
export function workersForArtifacts(artifacts: readonly ArtifactType[]): IJobWorker[] {
  const workers: IJobWorker[] = [];
  for (const artifactType of artifacts) {
    const worker = WORKER_IDS.find((id: WorkerId) =>
      WORKER_ARTIFACT_MAP[id].includes(artifactType),
    );
    if (worker) {
      workers.push({ worker, artifactType, status: 'queued', error: null });
    }
  }
  return workers;
}
