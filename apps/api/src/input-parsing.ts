/**
 * Input-source → IPS parsing shared by project create and re-parse (doc 04 §F2).
 * Parser output is always re-validated (structure + nesting depth cap) before
 * it is accepted (doc 13 §3).
 */

import { AppError, HTTP_METHODS, type InputSourceType, type Result } from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import {
  ALL_QUERY_FEATURES,
  materializeRelations,
  validateIPS,
  type AuthConfig,
  type Entity,
  type GenerationConfig,
  type InternalProjectSchema,
} from '@instantmockapi/ips';
import { parseBuilderPayload, parseJSONPayload, parseSwaggerSpec } from '@instantmockapi/parsers';

function defaultGenerationConfig(env: EnvConfig): GenerationConfig {
  return {
    validators: ['zod'],
    types: ['typescript'],
    methods: [...HTTP_METHODS],
    mockRecords: env.defaultMockRecords,
    // On by default, for the same reason every HTTP method is: a fresh project
    // should expose the whole surface, and the wizard turns things off.
    features: { ...ALL_QUERY_FEATURES },
  };
}

function parseBuilderRaw(
  projectId: string,
  name: string,
  rawString: string,
  env: EnvConfig,
): Result<InternalProjectSchema, AppError | Error> {
  let raw: unknown;
  try {
    raw = JSON.parse(rawString);
  } catch {
    throw new AppError({ code: 'PARSE_ERROR', message: 'Builder payload must be valid JSON' });
  }
  const builder = raw as {
    entities?: Entity[];
    generationConfig?: GenerationConfig;
    authentication?: AuthConfig;
  };
  if (!Array.isArray(builder.entities)) {
    throw new AppError({
      code: 'PARSE_ERROR',
      message: 'Builder payload requires an entities array',
      details: [{ path: 'inputSource.raw.entities', issue: 'must be an array of entities' }],
    });
  }
  return parseBuilderPayload(
    projectId,
    name,
    builder.entities,
    builder.generationConfig ?? defaultGenerationConfig(env),
    // Not defaulted: a wizard that never asked, and a user who answered "no",
    // both produce a project with no `authentication` block — the same document
    // a pre-Phase-3 project has. `validateIPS` inside the adapter is what
    // rejects a malformed one, so nothing needs sanitising here.
    builder.authentication,
  );
}

/**
 * Parse a stored input source into a validated IPS.
 * Throws AppError(PARSE_ERROR/VALIDATION_ERROR/DEPTH_LIMIT_EXCEEDED) on failure.
 */
export function parseInputSource(
  projectId: string,
  name: string,
  type: InputSourceType,
  rawString: string,
  env: EnvConfig,
): InternalProjectSchema {
  let result: Result<InternalProjectSchema, AppError | Error>;
  switch (type) {
    case 'json':
      result = parseJSONPayload(projectId, name, rawString);
      break;
    case 'swagger':
      result = parseSwaggerSpec(projectId, name, rawString, env.maxNestingDepth);
      break;
    case 'builder':
      result = parseBuilderRaw(projectId, name, rawString, env);
      break;
    case 'docs':
      throw new AppError({
        code: 'VALIDATION_ERROR',
        message: "inputSource.type 'docs' is not supported in V1",
      });
    default:
      throw new AppError({
        code: 'VALIDATION_ERROR',
        message: `Unknown inputSource.type '${String(type)}'`,
      });
  }

  if (result.ok === false) {
    throw result.error instanceof AppError
      ? result.error
      : new AppError({ code: 'PARSE_ERROR', message: result.error.message });
  }

  const validated = validateIPS(result.value, env.maxNestingDepth);
  if (validated.ok === false) {
    throw validated.error;
  }
  // Materialize on the WRITE path, not just in the worker: `GET /projects/:id`
  // returns the stored IPS, so the wizard's review screen and the generated
  // artifacts must describe the same entity — identity and foreign-key fields
  // included. Idempotent, so running it again downstream is harmless.
  return materializeRelations(validated.value);
}
