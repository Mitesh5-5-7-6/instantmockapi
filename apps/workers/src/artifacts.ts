/**
 * Per-artifact production table and DAG levels (doc 09 §6, doc 10 §4).
 *
 * Level 0 (A/B/C/D) depend only on the IPS; Level 1 (E/F) consume Worker D's
 * records; Level 2 (G) bundles whatever was produced. Everything here is
 * synchronous data mapping — I/O (storage, registry, db) lives in the
 * processor.
 */

import {
  WORKER_ARTIFACT_MAP,
  WORKER_IDS,
  type ArtifactType,
  type WorkerId,
} from '@instantmockapi/shared';
import type { Field, InternalProjectSchema } from '@instantmockapi/ips';
import { generateJSONSchema } from '@instantmockapi/generator-schema';
import { generateZod, generateYup } from '@instantmockapi/generator-validation';
import { generateTypeScript } from '@instantmockapi/generator-types';
import {
  generateOpenAPI,
  generatePostmanCollection,
  type EntityExamples,
} from '@instantmockapi/generator-docs';
import { generateHostingConfig } from '@instantmockapi/generator-hosting';
import { generateExportZip } from '@instantmockapi/generator-export';

export interface ArtifactContext {
  ips: InternalProjectSchema;
  /** Worker D's raw output: `<entity>.mock.json` → JSON array string. */
  mockFiles: Record<string, string>;
  /** Parsed mock records keyed by lowercased entity name (for E). */
  examples: EntityExamples;
  /** For G: archive path → content, from every completed artifact. */
  bundleFiles: Record<string, string | Uint8Array>;
  /** For G's README: artifact types actually present in the bundle. */
  includedArtifacts: string[];
}

/** A producer returns filename→content, or raw bytes for binary artifacts. */
export type ArtifactProducer = (
  ctx: ArtifactContext,
) => Record<string, string> | Uint8Array | Promise<Record<string, string> | Uint8Array>;

export const DEFAULT_PRODUCERS: Record<ArtifactType, ArtifactProducer> = {
  // 'ips' is registry bookkeeping for the schema itself — the API owns it and
  // never stages it as a worker task; producing it is a no-op serialization.
  ips: ({ ips }) => ({ 'ips.json': JSON.stringify(ips, null, 2) }),
  json_schema: ({ ips }) => generateJSONSchema(ips),
  zod: ({ ips }) => generateZod(ips),
  yup: ({ ips }) => generateYup(ips),
  typescript: ({ ips }) => generateTypeScript(ips),
  mock_data: ({ mockFiles }) => mockFiles,
  openapi: ({ ips, examples }) => generateOpenAPI(ips, examples),
  postman: ({ ips, examples }) => generatePostmanCollection(ips, examples),
  hosted_api: ({ ips }) => generateHostingConfig(ips),
  export_zip: ({ ips, bundleFiles, includedArtifacts }) =>
    generateExportZip(ips, bundleFiles, includedArtifacts),
};

/** Single-stored-file artifacts and their content types; others store bundles. */
export const SINGLE_FILE_ARTIFACTS: Partial<Record<ArtifactType, { contentType: string }>> = {
  openapi: { contentType: 'application/json' },
  postman: { contentType: 'application/json' },
  hosted_api: { contentType: 'application/json' },
  export_zip: { contentType: 'application/zip' },
};

const LEVEL_0: ReadonlySet<ArtifactType> = new Set([
  'ips',
  'json_schema',
  'zod',
  'yup',
  'typescript',
  'mock_data',
]);
const LEVEL_1: ReadonlySet<ArtifactType> = new Set(['openapi', 'postman', 'hosted_api']);

export interface ExecutionPlan {
  level0: ArtifactType[];
  level1: ArtifactType[];
  level2: ArtifactType[];
}

/** Split requested artifacts into DAG levels, preserving request order. */
export function buildExecutionPlan(requested: readonly string[]): ExecutionPlan {
  const known = requested.filter((t): t is ArtifactType => t in DEFAULT_PRODUCERS);
  return {
    level0: known.filter((t) => LEVEL_0.has(t)),
    level1: known.filter((t) => LEVEL_1.has(t)),
    level2: known.filter((t) => t === 'export_zip'),
  };
}

export function workerForArtifact(artifactType: ArtifactType): WorkerId | null {
  return WORKER_IDS.find((id) => WORKER_ARTIFACT_MAP[id].includes(artifactType)) ?? null;
}

/**
 * Restore structure a Mongo round-trip may have stripped: older documents
 * were saved with `minimize: true`, which drops empty objects (validation: {},
 * meta: {}) that generators legitimately dereference.
 */
export function normalizeIps(ips: InternalProjectSchema): InternalProjectSchema {
  const normalizeField = (field: Field): Field => ({
    ...field,
    default: field.default ?? null,
    validation: field.validation ?? {},
    meta: field.meta ?? {},
    children: (field.children ?? []).map(normalizeField),
  });
  return {
    ...ips,
    entities: (ips.entities ?? []).map((entity) => ({
      ...entity,
      fields: (entity.fields ?? []).map(normalizeField),
    })),
  };
}

/** Parse Worker D's `<entity>.mock.json` files into examples keyed by entity. */
export function parseExamples(mockFiles: Record<string, string>): EntityExamples {
  const examples: EntityExamples = {};
  for (const [filename, content] of Object.entries(mockFiles)) {
    if (!filename.endsWith('.mock.json')) {
      continue;
    }
    const entity = filename.slice(0, -'.mock.json'.length);
    try {
      const records = JSON.parse(content) as Record<string, unknown>[];
      if (Array.isArray(records)) {
        examples[entity] = records;
      }
    } catch {
      // Malformed mock file — leave this entity without examples
    }
  }
  return examples;
}
