import { describe, expect, it } from 'vitest';
import { newEntity } from './builder';
import type { ReviewState } from './review-state';
import {
  canCreateApi,
  initialSession,
  nextTranslation,
  sessionReducer,
  type ReviewSession,
} from './review-session';

function form(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    kind: 'project',
    name: 'Shop',
    description: 'A shop',
    entities: [newEntity('Product')],
    methods: ['GET'],
    mockRecords: 20,
    authMode: null,
    protectedNames: [],
    ...overrides,
  };
}

function loaded(state = form()): ReviewSession {
  return sessionReducer(initialSession(), { type: 'init', state });
}

describe('sessionReducer', () => {
  it('starts empty and init loads a form without counting as an edit', () => {
    expect(initialSession()).toEqual({
      current: null,
      history: { past: [], limit: 50 },
      editSeq: 0,
    });
    const session = loaded();
    expect(session.current?.name).toBe('Shop');
    expect(session.editSeq).toBe(0);
    expect(session.history.past).toEqual([]);
  });

  it('a user edit pushes the previous form onto the undo history and counts as an edit', () => {
    const before = loaded();
    const after = sessionReducer(before, {
      type: 'edit',
      action: { type: 'name', value: 'Store' },
    });
    expect(after.current?.name).toBe('Store');
    expect(after.history.past).toEqual([before.current]);
    expect(after.editSeq).toBe(1);
  });

  it('an edit that changes nothing is neither recorded nor saved', () => {
    const before = loaded();
    const after = sessionReducer(before, {
      type: 'edit',
      action: { type: 'kind', value: 'project' },
    });
    expect(after).toBe(before);
  });

  it('edits before the form is loaded are ignored', () => {
    const empty = initialSession();
    expect(sessionReducer(empty, { type: 'edit', action: { type: 'name', value: 'x' } })).toBe(
      empty,
    );
    expect(sessionReducer(empty, { type: 'undo' })).toBe(empty);
  });

  it('undo restores the previous form and counts as an edit, so it is saved', () => {
    let session = loaded();
    session = sessionReducer(session, { type: 'edit', action: { type: 'name', value: 'A' } });
    session = sessionReducer(session, { type: 'edit', action: { type: 'name', value: 'B' } });
    session = sessionReducer(session, { type: 'undo' });
    expect(session.current?.name).toBe('A');
    expect(session.history.past).toHaveLength(1);
    expect(session.editSeq).toBe(3);
  });

  it('undo with nothing to undo is a no-op', () => {
    const session = loaded();
    expect(sessionReducer(session, { type: 'undo' })).toBe(session);
  });

  it('init (Load latest) replaces the form and clears the undo history', () => {
    let session = loaded();
    session = sessionReducer(session, { type: 'edit', action: { type: 'name', value: 'A' } });
    session = sessionReducer(session, { type: 'init', state: form({ name: 'Theirs' }) });
    expect(session.current?.name).toBe('Theirs');
    expect(session.history.past).toEqual([]);
    expect(session.editSeq).toBe(1);
  });

  it('a translation replaces an unedited description, is saved, but is not an undo step', () => {
    const session = sessionReducer(loaded(), {
      type: 'translate',
      previous: 'A shop',
      next: 'Une boutique',
    });
    expect(session.current?.description).toBe('Une boutique');
    expect(session.history.past).toEqual([]);
    expect(session.editSeq).toBe(1);
  });

  it('a translation keeps a description the user edited, but still saves (entity prose changed)', () => {
    let session = loaded();
    session = sessionReducer(session, {
      type: 'edit',
      action: { type: 'description', value: 'Mine' },
    });
    session = sessionReducer(session, {
      type: 'translate',
      previous: 'A shop',
      next: 'Une boutique',
    });
    expect(session.current?.description).toBe('Mine');
    expect(session.editSeq).toBe(2);
  });
});

describe('nextTranslation', () => {
  const seen = { language: null, description: 'A shop' };

  it('is null while the language is unchanged', () => {
    expect(nextTranslation(seen, { language: null, description: 'A shop' })).toBeNull();
  });

  it('reports the previous and new description when the language changes', () => {
    expect(nextTranslation(seen, { language: 'fr', description: 'Une boutique' })).toEqual({
      previous: 'A shop',
      next: 'Une boutique',
    });
  });
});

describe('canCreateApi', () => {
  const ready = {
    authAnswered: true,
    issueCount: 0,
    save: { status: 'saved' as const, dirty: false, pending: false },
  };

  it('is true only when answered, valid, saved and idle', () => {
    expect(canCreateApi(ready)).toBe(true);
  });

  it.each([
    ['the auth question is unanswered', { ...ready, authAnswered: false }],
    ['the server reported issues', { ...ready, issueCount: 1 }],
    ['an edit is unsaved', { ...ready, save: { ...ready.save, dirty: true } }],
    ['a save is scheduled or in flight', { ...ready, save: { ...ready.save, pending: true } }],
    ['the last save failed', { ...ready, save: { ...ready.save, status: 'error' as const } }],
    ['another tab changed it', { ...ready, save: { ...ready.save, status: 'conflict' as const } }],
    ['a save is running', { ...ready, save: { ...ready.save, status: 'saving' as const } }],
  ])('is false when %s', (_, input) => {
    expect(canCreateApi(input)).toBe(false);
  });
});
