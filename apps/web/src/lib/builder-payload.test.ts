import { describe, expect, it } from 'vitest';
import { newEntity, newField, newRelation } from './builder';
import { attachDescriptions, proposalToBuilder, serializeBuilder } from './builder-payload';
import type { AiProposalView } from './api-types';

function fixture() {
  const school = { ...newEntity('Alpha'), identityStyle: 'uuid' as const };
  school.fields = [
    newField('title'),
    newField(''),
    { ...newField('meta', 'object'), children: [newField('note')] },
  ];
  const beta = newEntity('Beta');
  beta.fields = [newField('label')];
  beta.relations = [
    { ...newRelation(), name: 'alpha', kind: 'belongsTo' as const, target: 'Alpha' },
  ];
  const excluded = { ...newEntity('Gamma'), generate: false };
  excluded.fields = [newField('x')];
  return [school, beta, excluded];
}

describe('serializeBuilder (golden: same output as the wizard)', () => {
  it('prunes excluded entities, drops unnamed fields, and omits authentication for NONE', () => {
    const entities = fixture();
    const { raw, pathIndex } = serializeBuilder({
      entities,
      generationConfig: { methods: ['GET'] },
      authMode: 'NONE',
      protectedNames: [],
    });
    expect(raw.entities.map((e) => e['name'])).toEqual(['Alpha', 'Beta']);
    expect(raw.entities[0]!['identity']).toEqual({ field: 'id', style: 'uuid' });
    expect((raw.entities[0]!['fields'] as unknown[]).length).toBe(2);
    expect(raw).not.toHaveProperty('authentication');
    expect(raw.generationConfig).toEqual({ methods: ['GET'] });
    expect(pathIndex.get('entities[0].fields[1].children[0]')).toBe(
      entities[0]!.fields[2]!.children[0]!.id,
    );
    expect(pathIndex.get('entities[1].relations[0]')).toBe(entities[1]!.relations[0]!.id);
  });

  it('adds the auth block for ALL_PROTECTED without entity stamps', () => {
    const { raw } = serializeBuilder({
      entities: fixture(),
      generationConfig: {},
      authMode: 'ALL_PROTECTED',
      protectedNames: [],
    });
    expect(raw).toHaveProperty('authentication.mode', 'ALL_PROTECTED');
    expect(raw.entities[0]).not.toHaveProperty('authentication');
  });

  it('stamps every included entity for COMBINATION', () => {
    const { raw } = serializeBuilder({
      entities: fixture(),
      generationConfig: {},
      authMode: 'COMBINATION',
      protectedNames: ['Beta'],
    });
    expect(raw.entities.map((e) => e['authentication'])).toEqual(['PUBLIC', 'PROTECTED']);
  });
});

describe('attachDescriptions', () => {
  it('restores descriptions by entity name and leaves renamed entities alone (Review Focus #5)', () => {
    const out = attachDescriptions(
      [{ name: 'Alpha' }, { name: 'Renamed' }],
      [
        { name: 'Alpha', description: 'A' },
        { name: 'Beta', description: 'B' },
      ],
    );
    expect(out).toEqual([{ name: 'Alpha', description: 'A' }, { name: 'Renamed' }]);
  });
});

describe('proposalToBuilder', () => {
  const result = {
    detectedLanguage: 'en',
    domain: 'd',
    recommendedKind: 'project',
    kindRationale: '',
    name: 'AI Name',
    description: 'AI desc',
    entities: [
      {
        name: 'Alpha',
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
      },
    ],
    generationConfig: { methods: ['GET', 'POST'], mockRecords: 20 },
    authRecommendation: { recommended: true, reason: '' },
    assumptions: [],
    questions: [],
  };
  const view = (draft: unknown) =>
    ({ id: 'p', status: 'ready', hints: {}, result, draft }) as unknown as AiProposalView;

  it('seeds from the result with the auth question unanswered and uuid identity preserved', () => {
    const state = proposalToBuilder(view(null));
    expect(state).toMatchObject({
      name: 'AI Name',
      description: 'AI desc',
      kind: 'project',
      methods: ['GET', 'POST'],
      mockRecords: 20,
      authMode: null,
      protectedNames: [],
    });
    expect(state.entities[0]!.identityStyle).toBe('uuid');
    expect(state.entities[0]!.fields.map((f) => f.name)).toEqual(['title']);
  });

  it('seeds from the draft, including a COMBINATION answer', () => {
    const draft = {
      revision: 2,
      kind: 'single',
      name: 'Mine',
      description: 'D',
      generationConfig: { methods: ['GET'], mockRecords: 5 },
      authAnswered: true,
      authentication: { mode: 'COMBINATION' },
      entities: [{ ...result.entities[0], authentication: 'PROTECTED' }],
    };
    expect(proposalToBuilder(view(draft))).toMatchObject({
      kind: 'single',
      name: 'Mine',
      authMode: 'COMBINATION',
      protectedNames: ['Alpha'],
      methods: ['GET'],
      mockRecords: 5,
    });
  });

  it('round-trips through serializeBuilder', () => {
    const state = proposalToBuilder(view(null));
    const { raw } = serializeBuilder({
      entities: state.entities,
      generationConfig: {},
      authMode: 'NONE',
      protectedNames: [],
    });
    expect(raw.entities.map((e) => e['name'])).toEqual(['Alpha']);
  });
});
