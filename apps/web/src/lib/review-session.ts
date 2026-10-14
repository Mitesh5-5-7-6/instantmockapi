/**
 * The AI review page's form state with its undo history (SP2 §6.2), as one
 * pure reducer.
 *
 * Undo lives inside the reducer rather than beside it so that pushing "the
 * state before this edit" always sees the real previous state. A page-level
 * `dispatch` that read `state` from its render closure would push a stale
 * snapshot when two actions fire before a re-render.
 *
 * `editSeq` counts the changes that must be saved: user edits, undo and an
 * applied translation. The page hands the form to autosave whenever it moves.
 * Loading (`init`) does not move it: a freshly loaded form is already saved.
 */

import { createHistory, popHistory, pushHistory, type History } from './undo';
import {
  applyTranslation,
  reviewReducer,
  type ReviewAction,
  type ReviewState,
} from './review-state';
import type { SaverSnapshot } from './draft-saver';

export interface ReviewSession {
  /** Null until the proposal has loaded. */
  current: ReviewState | null;
  history: History<ReviewState>;
  editSeq: number;
}

export type SessionAction =
  /** Load a form from the server (first load, or "Load latest"). Clears undo. */
  | { type: 'init'; state: ReviewState }
  /** A user change: undoable and saved. */
  | { type: 'edit'; action: ReviewAction }
  | { type: 'undo' }
  /** The AI prose arrived in a new language. Saved, but not an undo step: the user did not make it. */
  | { type: 'translate'; previous: string; next: string };

export function initialSession(): ReviewSession {
  return { current: null, history: createHistory<ReviewState>(), editSeq: 0 };
}

export function sessionReducer(session: ReviewSession, action: SessionAction): ReviewSession {
  if (action.type === 'init') {
    return { ...session, current: action.state, history: createHistory<ReviewState>() };
  }
  const current = session.current;
  if (current === null) return session;
  switch (action.type) {
    case 'edit': {
      const next = reviewReducer(current, action.action);
      if (next === current) return session;
      return {
        current: next,
        history: pushHistory(session.history, current),
        editSeq: session.editSeq + 1,
      };
    }
    case 'undo': {
      const { history, state } = popHistory(session.history);
      if (state === undefined) return session;
      return { current: state, history, editSeq: session.editSeq + 1 };
    }
    case 'translate':
      // Counted as an edit even when the description is kept: the entity
      // descriptions in the saved draft come from the (now translated) result.
      return {
        ...session,
        current: applyTranslation(current, action.previous, action.next),
        editSeq: session.editSeq + 1,
      };
  }
}

export interface SeenProse {
  language: string | null;
  description: string;
}

/**
 * Whether the proposal's prose has changed language since the page last looked,
 * and if so the description to replace and its replacement.
 */
export function nextTranslation(
  seen: SeenProse,
  now: SeenProse,
): { previous: string; next: string } | null {
  if (now.language === seen.language) return null;
  return { previous: seen.description, next: now.description };
}

/** Create API is offered only for a form the server has seen, in full, and found valid. */
export function canCreateApi(input: {
  authAnswered: boolean;
  issueCount: number;
  save: SaverSnapshot;
}): boolean {
  return (
    input.authAnswered &&
    input.issueCount === 0 &&
    input.save.status === 'saved' &&
    !input.save.dirty &&
    !input.save.pending
  );
}
