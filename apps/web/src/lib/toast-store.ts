/**
 * The notification queue: one store for the whole application.
 *
 * Split deliberately into a pure reducer and a four-line subscription wrapper.
 * Every rule that could be wrong — deduplication, ordering, the cap, which
 * variants expire — is in the reducer, where it is testable without a DOM. The
 * React surface holds no logic.
 *
 * ## Deduplication is the point
 *
 * The failure mode this design exists to prevent is a column of identical
 * toasts: the client layer reports a failure, the hook reports it again, the
 * component reports it a third time. So a toast carries a `key`, and pushing a
 * key that is already showing **refreshes that toast** rather than adding
 * another. One user action produces one notification, even when three layers
 * each think they are responsible for saying so.
 *
 * ## Errors do not expire
 *
 * A success message can fade — the user saw the thing succeed. An error must
 * not: it is the only record of what went wrong, it may carry a `View details`
 * action, and a user who looked away has no way to get it back. Errors and
 * warnings stay until dismissed; success and info auto-dismiss.
 */

import type { AppFailure } from './errors';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info' | 'loading';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  detail: string | null;
  /**
   * Identity for deduplication. Defaults to the id, which never collides, so a
   * caller that does not care about duplicates gets none of this behaviour.
   */
  key: string;
  /** Milliseconds until auto-dismissal, or null to stay until dismissed. */
  duration: number | null;
  action: ToastAction | null;
  /** Kept for the details panel. Absent on success and info. */
  failure: AppFailure | null;
  /** Monotonic counter, so ordering does not depend on clock resolution. */
  sequence: number;
}

export interface ToastState {
  toasts: readonly Toast[];
  /** Source of both ids and ordering. */
  sequence: number;
}

export const EMPTY_TOAST_STATE: ToastState = { toasts: [], sequence: 0 };

/**
 * How many are shown at once.
 *
 * Four is enough for a burst of unrelated failures and few enough that the
 * oldest is still readable. Past that the viewport becomes a wall nobody reads,
 * and the newest — the one describing what the user just did — is the one pushed
 * off screen if we dropped from the wrong end.
 */
export const MAX_VISIBLE = 4;

/** Auto-dismiss delays. `null` means the user has to dismiss it. */
const DURATIONS: Record<ToastVariant, number | null> = {
  success: 4_000,
  info: 5_000,
  // A loading toast is replaced by its own outcome, not by a timer.
  loading: null,
  warning: null,
  error: null,
};

export type ToastInput = Omit<Toast, 'id' | 'sequence' | 'key' | 'duration'> &
  Partial<Pick<Toast, 'key' | 'duration'>>;

export type ToastAction_ =
  | { type: 'push'; toast: ToastInput }
  | { type: 'dismiss'; id: string }
  | { type: 'dismissKey'; key: string }
  | { type: 'clear' };

/** Delay for a variant, unless the caller asked for something specific. */
export function defaultDuration(variant: ToastVariant): number | null {
  return DURATIONS[variant];
}

export function toastReducer(state: ToastState, action: ToastAction_): ToastState {
  switch (action.type) {
    case 'push': {
      const sequence = state.sequence + 1;
      const id = `toast-${sequence}`;
      const next: Toast = {
        ...action.toast,
        id,
        sequence,
        key: action.toast.key ?? id,
        duration: action.toast.duration ?? defaultDuration(action.toast.variant),
      };

      const existing = state.toasts.findIndex((toast) => toast.key === next.key);
      if (existing !== -1) {
        // Replace in place rather than moving it to the end. A toast that
        // jumped position on every retry would be unreadable during a retry
        // loop, and the user is already looking at where it is.
        const toasts = [...state.toasts];
        toasts[existing] = { ...next, id: state.toasts[existing]!.id };
        return { toasts, sequence };
      }

      // Trim from the front: the oldest goes, never the one just pushed.
      const toasts = [...state.toasts, next].slice(-MAX_VISIBLE);
      return { toasts, sequence };
    }

    case 'dismiss':
      return {
        ...state,
        toasts: state.toasts.filter((toast) => toast.id !== action.id),
      };

    case 'dismissKey':
      return {
        ...state,
        toasts: state.toasts.filter((toast) => toast.key !== action.key),
      };

    case 'clear':
      return { ...state, toasts: [] };
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

type Listener = () => void;

/**
 * A module-level store rather than React context state.
 *
 * `pushToast` has to be callable from places that are not components — the
 * action router, a job stream callback, an error boundary — and a context-only
 * API would push a `useToast()` hook into every one of them or leave them unable
 * to notify at all. `useSyncExternalStore` keeps React correctly subscribed to
 * it, including under concurrent rendering.
 */
let state: ToastState = EMPTY_TOAST_STATE;
const listeners = new Set<Listener>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function dispatch(action: ToastAction_): void {
  const previous = state;
  state = toastReducer(previous, action);
  if (state !== previous) {
    for (const listener of listeners) {
      listener();
    }
  }
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToastState(): ToastState {
  return state;
}

export function dismissToast(id: string): void {
  clearTimer(id);
  dispatch({ type: 'dismiss', id });
}

export function dismissToastByKey(key: string): void {
  const existing = state.toasts.find((toast) => toast.key === key);
  if (existing !== undefined) {
    clearTimer(existing.id);
  }
  dispatch({ type: 'dismissKey', key });
}

export function clearToasts(): void {
  for (const id of timers.keys()) {
    clearTimer(id);
  }
  dispatch({ type: 'clear' });
}

/** Show a notification. Returns its id so a caller can replace or dismiss it. */
export function pushToast(toast: ToastInput): string {
  const key = toast.key;
  if (key !== undefined) {
    // The replaced toast's timer belongs to the message that is going away.
    // Leaving it running would dismiss its replacement early.
    const previous = state.toasts.find((entry) => entry.key === key);
    if (previous !== undefined) {
      clearTimer(previous.id);
    }
  }

  dispatch({ type: 'push', toast });

  // The pushed toast is the one carrying the new sequence — true whether it was
  // appended or replaced an existing key in place. Identifying it that way
  // rather than recomputing the id keeps the minting rule solely in the reducer.
  const added = state.toasts.find((entry) => entry.sequence === state.sequence);
  if (added === undefined) {
    return '';
  }
  if (added.duration !== null) {
    timers.set(
      added.id,
      setTimeout(() => dismissToast(added.id), added.duration),
    );
  }
  return added.id;
}

/** Reset everything. Exists for tests; nothing in the app should need it. */
export function resetToastsForTest(): void {
  for (const id of [...timers.keys()]) {
    clearTimer(id);
  }
  state = EMPTY_TOAST_STATE;
  listeners.clear();
}
