/** A bounded undo stack: the review page keeps the last `limit` states (not across reloads). */
export interface History<T> {
  past: T[];
  limit: number;
}

export function createHistory<T>(limit = 50): History<T> {
  return { past: [], limit };
}

export function pushHistory<T>(history: History<T>, state: T): History<T> {
  return { ...history, past: [...history.past, state].slice(-history.limit) };
}

export function popHistory<T>(history: History<T>): { history: History<T>; state: T | undefined } {
  if (history.past.length === 0) return { history, state: undefined };
  return {
    history: { ...history, past: history.past.slice(0, -1) },
    state: history.past[history.past.length - 1],
  };
}
