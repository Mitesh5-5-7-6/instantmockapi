import type { LLMProvider, LLMRequest } from './provider.js';

/**
 * Test doubles, exported so the worker and API suites share one definition.
 * Not used by production code.
 */
export function createScriptedProvider(
  ...responses: Array<string | Error>
): LLMProvider & { calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  return {
    model: 'scripted-test-model',
    calls,
    async generate(request) {
      calls.push(structuredClone(request));
      const next = responses.shift();
      if (next === undefined) {
        throw new Error('createScriptedProvider: no response left for this call');
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
}

/** A minimal model response that passes IPS: each entity has a uuid identity and one string field. */
export function fakeOutputJson(
  entityNames: string[],
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    detectedLanguage: 'en',
    domain: 'test domain',
    recommendedKind: entityNames.length > 1 ? 'project' : 'single',
    kindRationale: 'test rationale',
    name: 'Test API',
    description: 'test description',
    entities: entityNames.map((name) => ({
      name,
      description: `${name} records`,
      fields: [
        {
          name: 'id',
          type: 'uuid',
          required: true,
          default: null,
          children: [],
          validation: {},
          meta: { identity: true },
        },
        {
          name: 'title',
          type: 'string',
          required: true,
          default: null,
          children: [],
          validation: {},
          meta: {},
        },
      ],
      relations: [],
    })),
    generationConfig: { methods: ['GET', 'POST', 'PATCH', 'DELETE'], mockRecords: 20 },
    authRecommendation: { recommended: false, reason: 'test reason' },
    assumptions: [],
    questions: [],
    ...overrides,
  });
}
