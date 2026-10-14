import type { EnvConfig } from '@instantmockapi/config';
import type { ErrorDetail } from '@instantmockapi/shared';
import type { ProposalDraft } from '@instantmockapi/db';
import { newProjectGenerationConfig, type AuthConfig } from '@instantmockapi/ips';
import { toBuilderShape, validateShape } from '@instantmockapi/ai';
import { KINDS } from './ai-proposal-access.js';

/** The editable fields of a draft. PATCH adds `revision`; adopt sends these as `draft`. */
export const DRAFT_FIELDS_SCHEMA = {
  type: 'object',
  required: ['kind', 'name', 'description', 'entities', 'generationConfig', 'authAnswered'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: [...KINDS] },
    name: { type: 'string', maxLength: 120 },
    description: { type: 'string', maxLength: 500 },
    entities: { type: 'array', maxItems: 100 },
    generationConfig: { type: 'object' },
    authAnswered: { type: 'boolean' },
    authentication: { type: ['object', 'null'] },
  },
} as const;

export interface DraftInput {
  kind: 'project' | 'single';
  name: string;
  description: string;
  entities: unknown[];
  generationConfig: Record<string, unknown>;
  authAnswered: boolean;
  authentication?: AuthConfig | null;
}

/**
 * Clean a user's draft exactly as commit will, and dry-run the same validation.
 * Issues are returned, never thrown: autosave must keep every edit (SP2 §5.1).
 */
export function buildDraft(
  input: DraftInput,
  config: EnvConfig,
): { draft: Omit<ProposalDraft, 'revision' | 'savedAt'>; issues: ErrorDetail[] } {
  const shape = toBuilderShape(
    { entities: input.entities, generationConfig: input.generationConfig },
    newProjectGenerationConfig(config.defaultMockRecords),
    { maxMockRecords: config.maxMockRecords },
    { keepEntityAuth: true },
  );
  // Only an answered question carries a config; an unanswered one is "not yet", not "none".
  const authentication = input.authAnswered ? (input.authentication ?? null) : null;
  const issues = validateShape(
    shape,
    input.kind,
    config.maxNestingDepth,
    authentication ?? undefined,
  );
  return {
    draft: {
      kind: input.kind,
      name: input.name.trim().slice(0, 120),
      description: input.description.trim().slice(0, 500),
      entities: shape.entities,
      generationConfig: {
        methods: [...shape.generationConfig.methods],
        mockRecords: shape.generationConfig.mockRecords,
      },
      authAnswered: input.authAnswered,
      authentication,
    },
    issues,
  };
}
