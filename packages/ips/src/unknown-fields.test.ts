/**
 * The unknown-field policy, end to end through the IPS layer.
 *
 * The behaviour under test is one the repo had *by accident* before: undeclared
 * body keys were stored and echoed by the hosted runtime while the generated Zod
 * dropped them. These cases pin the two halves of the fix — that a missing
 * setting still means the old behaviour, and that changing it is reported as the
 * breaking change it can be.
 */

import { describe, it, expect } from 'vitest';
import { diffSchemas, type SchemaChange } from './changes.js';
import { classifyImpact } from './classification.js';
import { analyseDraftImpact } from './impact.js';
import { ensureSchemaIds } from './ids.js';
import {
  describeUnknownFields,
  resolveUnknownFields,
  unknownFieldPolicy,
  unknownFieldsDirection,
} from './unknown-fields.js';
import {
  UNKNOWN_FIELD_POLICIES,
  type Entity,
  type Field,
  type InternalProjectSchema,
} from './types.js';

function field(name: string, over: Partial<Field> = {}): Field {
  return {
    name,
    type: 'string',
    required: false,
    default: null,
    children: [],
    validation: {},
    meta: {},
    ...over,
  };
}

function ips(
  entities: Entity[],
  config: Partial<InternalProjectSchema['generationConfig']> = {},
): InternalProjectSchema {
  return {
    projectId: 'p1',
    version: 1,
    entities,
    generationConfig: {
      validators: ['zod'],
      types: ['typescript'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      mockRecords: 10,
      ...config,
    },
  } as InternalProjectSchema;
}

function fork(active: InternalProjectSchema): {
  active: InternalProjectSchema;
  draft: InternalProjectSchema;
} {
  ensureSchemaIds(active);
  return { active, draft: JSON.parse(JSON.stringify(active)) as InternalProjectSchema };
}

const one = (changes: SchemaChange[], kind: string): SchemaChange => {
  const matches = changes.filter((change) => change.kind === kind);
  expect(matches, `expected exactly one ${kind}, got ${matches.length}`).toHaveLength(1);
  return matches[0]!;
};

describe('resolveUnknownFields — what an absent setting means', () => {
  it('resolves missing input to allow', () => {
    // The load-bearing default. Every project published before this setting
    // existed stores and echoes undeclared keys; reading "missing" as anything
    // stricter would make their next regeneration reject live traffic.
    expect(resolveUnknownFields(undefined)).toBe('allow');
    expect(unknownFieldPolicy(undefined)).toBe('allow');
    expect(unknownFieldPolicy({})).toBe('allow');
  });

  it('resolves malformed input to allow rather than throwing', () => {
    // Read over `Version.ipsSnapshot`, which is Mixed and may hold anything any
    // past version of this code wrote.
    for (const bad of [null, 42, {}, [], 'STRICT', '']) {
      expect(resolveUnknownFields(bad)).toBe('allow');
    }
  });

  it('passes every real policy through unchanged', () => {
    for (const policy of UNKNOWN_FIELD_POLICIES) {
      expect(resolveUnknownFields(policy)).toBe(policy);
    }
  });
});

describe('unknownFieldsDirection — the one reader of which way it moved', () => {
  it('calls anything to reject narrowing', () => {
    expect(unknownFieldsDirection('allow', 'reject')).toBe('narrowing');
    expect(unknownFieldsDirection('strip', 'reject')).toBe('narrowing');
  });

  it('calls reject to anything widening', () => {
    expect(unknownFieldsDirection('reject', 'allow')).toBe('widening');
    expect(unknownFieldsDirection('reject', 'strip')).toBe('widening');
  });

  it('separates allow to strip from strip to allow', () => {
    // Not symmetric: dropping a key nobody declared costs a caller data, while
    // starting to keep one costs nobody anything.
    expect(unknownFieldsDirection('allow', 'strip')).toBe('lossy');
    expect(unknownFieldsDirection('strip', 'allow')).toBe('widening');
  });

  it('reports no move when the policy is unchanged', () => {
    for (const policy of UNKNOWN_FIELD_POLICIES) {
      expect(unknownFieldsDirection(policy, policy)).toBe('none');
    }
  });
});

describe('diffing the policy', () => {
  it('reports nothing when an absent setting is written out as allow', () => {
    // The compatibility case that would otherwise show every untouched legacy
    // project a phantom change the moment it is opened in the editor.
    const { active, draft } = fork(ips([{ name: 'User', fields: [field('email')] }]));
    draft.generationConfig.unknownFields = 'allow';

    expect(diffSchemas(active, draft)).toHaveLength(0);
  });

  it('reports tightening to reject as breaking, on both bodies', () => {
    const { active, draft } = fork(ips([{ name: 'User', fields: [field('email')] }]));
    draft.generationConfig.unknownFields = 'reject';

    const change = one(diffSchemas(active, draft), 'UNKNOWN_FIELDS_CHANGED');
    expect(change).toMatchObject({
      risk: 'BREAKING',
      aspect: 'both',
      before: 'allow',
      after: 'reject',
    });
    expect(classifyImpact(change)).toBe('BREAKING');
  });

  it('reports allow to strip as a warning that only potentially breaks', () => {
    const { active, draft } = fork(ips([{ name: 'User', fields: [field('email')] }]));
    draft.generationConfig.unknownFields = 'strip';

    const change = one(diffSchemas(active, draft), 'UNKNOWN_FIELDS_CHANGED');
    expect(change.risk).toBe('WARNING');
    expect(classifyImpact(change)).toBe('POTENTIALLY_BREAKING');
  });

  it('reports loosening as safe and non-breaking', () => {
    const { active, draft } = fork(
      ips([{ name: 'User', fields: [field('email')] }], { unknownFields: 'reject' }),
    );
    draft.generationConfig.unknownFields = 'allow';

    const change = one(diffSchemas(active, draft), 'UNKNOWN_FIELDS_CHANGED');
    expect(change.risk).toBe('SAFE');
    expect(classifyImpact(change)).toBe('NON_BREAKING');
  });
});

describe('impact of a policy change', () => {
  it('names no endpoint but regenerates every artifact that restates the rule', () => {
    const { active, draft } = fork(ips([{ name: 'User', fields: [field('email')] }]));
    draft.generationConfig.unknownFields = 'reject';

    const report = analyseDraftImpact(active, draft);

    // Project-level: it identifies no schema element, and that is expected
    // rather than a gap in the analysis.
    expect(report.incomplete).toBe(false);
    expect(report.unattributed).toHaveLength(1);
    expect(report.unattributed[0]!.cause).toBe('no-wire');

    // Every schema the project hands out states this rule.
    expect(report.artifacts).toEqual(
      expect.arrayContaining(['hosted_api', 'openapi', 'json_schema', 'zod', 'yup', 'export_zip']),
    );
    // Seeds contain only declared fields, and a saved Postman request restates
    // no such rule — regenerating either would produce identical bytes.
    expect(report.artifacts).not.toContain('mock_data');
    expect(report.artifacts).not.toContain('postman');
  });
});

describe('describeUnknownFields', () => {
  it('gives each policy a distinct phrase for diff summaries', () => {
    const phrases = UNKNOWN_FIELD_POLICIES.map(describeUnknownFields);
    expect(new Set(phrases).size).toBe(UNKNOWN_FIELD_POLICIES.length);
  });
});
