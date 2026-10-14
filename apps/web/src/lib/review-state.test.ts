import { describe, expect, it } from 'vitest';
import { newEntity, newField, newRelation } from './builder';
import {
  applyTranslation,
  clientIssueCount,
  draftInputFor,
  hasRelations,
  reviewReducer,
  type ReviewState,
} from './review-state';

function base(): ReviewState {
  const a = newEntity('Alpha');
  const b = newEntity('Beta');
  b.relations = [{ ...newRelation(), name: 'alpha', kind: 'belongsTo', target: 'Alpha' }];
  return {
    kind: 'project',
    name: 'N',
    description: 'D',
    entities: [a, b],
    methods: ['GET'],
    mockRecords: 20,
    authMode: null,
    protectedNames: [],
  };
}

describe('reviewReducer', () => {
  it('follows a rename of a protected entity (Review Focus #4)', () => {
    const state = { ...base(), authMode: 'COMBINATION' as const, protectedNames: ['Alpha'] };
    const alpha = state.entities[0]!;
    const next = reviewReducer(state, {
      type: 'entity',
      id: alpha.id,
      next: { ...alpha, name: 'Member' },
    });
    expect(next.protectedNames).toEqual(['Member']);
  });

  it('retargets relations in other entities when an entity is renamed', () => {
    const state = base();
    const alpha = state.entities[0]!;
    const next = reviewReducer(state, {
      type: 'entity',
      id: alpha.id,
      next: { ...alpha, name: 'Member' },
    });
    expect(next.entities[1]!.relations.map((relation) => relation.target)).toEqual(['Member']);
    expect(clientIssueCount(next.entities)).toBe(0);
  });

  it('drops a removed entity from the protected list', () => {
    const state = {
      ...base(),
      authMode: 'COMBINATION' as const,
      protectedNames: ['Alpha', 'Beta'],
    };
    expect(
      reviewReducer(state, { type: 'removeEntity', id: state.entities[1]!.id }).protectedNames,
    ).toEqual(['Alpha']);
  });

  it('switching to single removes relations and resets a COMBINATION answer', () => {
    const state = { ...base(), authMode: 'COMBINATION' as const, protectedNames: ['Alpha'] };
    const next = reviewReducer(state, { type: 'kind', value: 'single' });
    expect(hasRelations(next)).toBe(false);
    expect(next.authMode).toBeNull();
    expect(next.protectedNames).toEqual([]);
  });

  it('switching to single keeps a NONE/ALL_PROTECTED answer', () => {
    expect(
      reviewReducer({ ...base(), authMode: 'ALL_PROTECTED' }, { type: 'kind', value: 'single' })
        .authMode,
    ).toBe('ALL_PROTECTED');
  });

  it('toggles protected names', () => {
    const once = reviewReducer(base(), { type: 'toggleProtected', name: 'Alpha' });
    expect(once.protectedNames).toEqual(['Alpha']);
    expect(reviewReducer(once, { type: 'toggleProtected', name: 'Alpha' }).protectedNames).toEqual(
      [],
    );
  });
});

describe('clientIssueCount', () => {
  it('is 0 for a valid model', () => {
    expect(clientIssueCount(base().entities)).toBe(0);
  });

  it('counts a dangling relation, an unnamed entity and an empty enum', () => {
    const [alpha, beta] = base().entities;
    const unnamed = { ...newEntity('X'), name: '  ' };
    const withEnum = { ...newEntity('Gamma'), fields: [newField('status', 'enum')] };
    // Without Alpha, Beta's relation dangles.
    expect(clientIssueCount([beta!])).toBe(1);
    expect(clientIssueCount([alpha!, beta!, unnamed])).toBe(1);
    expect(clientIssueCount([alpha!, beta!, withEnum])).toBe(1);
  });
});

describe('draftInputFor', () => {
  it('marks the auth question unanswered while authMode is null', () => {
    const { input } = draftInputFor(base(), []);
    expect(input).toMatchObject({
      authAnswered: false,
      authentication: null,
      generationConfig: { methods: ['GET'], mockRecords: 20 },
    });
  });

  it('carries an answered COMBINATION as config + entity stamps, and descriptions by name', () => {
    const state = { ...base(), authMode: 'COMBINATION' as const, protectedNames: ['Beta'] };
    const { input } = draftInputFor(state, [{ name: 'Alpha', description: 'Alphas' }]);
    expect(input.authAnswered).toBe(true);
    expect(input.authentication?.mode).toBe('COMBINATION');
    expect(input.entities.map((e) => e['authentication'])).toEqual(['PUBLIC', 'PROTECTED']);
    expect(input.entities[0]!['description']).toBe('Alphas');
  });

  it('answers NONE as authAnswered with a null config', () => {
    expect(draftInputFor({ ...base(), authMode: 'NONE' }, []).input).toMatchObject({
      authAnswered: true,
      authentication: null,
    });
  });
});

describe('applyTranslation (Review Focus #1)', () => {
  it('replaces the description only when the user has not changed it', () => {
    expect(
      applyTranslation({ ...base(), description: 'Old AI text' }, 'Old AI text', 'નવું')
        .description,
    ).toBe('નવું');
    expect(
      applyTranslation({ ...base(), description: 'My own words' }, 'Old AI text', 'નવું')
        .description,
    ).toBe('My own words');
  });
});
