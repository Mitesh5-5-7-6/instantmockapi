import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  clearToasts,
  defaultDuration,
  dismissToast,
  dismissToastByKey,
  EMPTY_TOAST_STATE,
  getToastState,
  MAX_VISIBLE,
  pushToast,
  resetToastsForTest,
  subscribeToasts,
  toastReducer,
  type ToastInput,
  type ToastState,
  type ToastVariant,
} from './toast-store';

const input = (over: Partial<ToastInput> = {}): ToastInput => ({
  variant: 'error',
  title: 'Failed',
  detail: null,
  action: null,
  failure: null,
  ...over,
});

const push = (state: ToastState, over: Partial<ToastInput> = {}): ToastState =>
  toastReducer(state, { type: 'push', toast: input(over) });

describe('toastReducer', () => {
  it('adds a toast with an id and a sequence', () => {
    const state = push(EMPTY_TOAST_STATE);
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]).toMatchObject({ title: 'Failed', sequence: 1 });
    expect(state.toasts[0]!.id).toBeTruthy();
  });

  it('keeps newest last', () => {
    let state = push(EMPTY_TOAST_STATE, { title: 'first' });
    state = push(state, { title: 'second' });
    expect(state.toasts.map((toast) => toast.title)).toEqual(['first', 'second']);
  });

  it('defaults the key to the id, so unkeyed toasts never collide', () => {
    let state = push(EMPTY_TOAST_STATE, { title: 'a' });
    state = push(state, { title: 'b' });
    expect(state.toasts).toHaveLength(2);
    expect(state.toasts[0]!.key).not.toBe(state.toasts[1]!.key);
  });
});

describe('deduplication', () => {
  /**
   * The failure this design exists to prevent: the client reports a failure, the
   * hook reports it again, the component reports it a third time, and the user
   * gets three identical toasts for one click.
   */
  it('refreshes an existing key instead of stacking a duplicate', () => {
    let state = push(EMPTY_TOAST_STATE, { key: 'save-failed', title: 'Save failed' });
    state = push(state, { key: 'save-failed', title: 'Save failed' });
    state = push(state, { key: 'save-failed', title: 'Save failed' });

    expect(state.toasts).toHaveLength(1);
  });

  it('updates the content when the same key is pushed again', () => {
    let state = push(EMPTY_TOAST_STATE, { key: 'k', title: 'Old', detail: null });
    state = push(state, { key: 'k', title: 'New', detail: 'now with detail' });

    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]).toMatchObject({ title: 'New', detail: 'now with detail' });
  });

  /**
   * Position is held. A toast that jumped to the bottom on every retry would be
   * unreadable during a retry loop, and the user is already looking at where it
   * is.
   */
  it('replaces in place rather than moving to the end', () => {
    let state = push(EMPTY_TOAST_STATE, { key: 'a', title: 'a' });
    state = push(state, { key: 'b', title: 'b' });
    state = push(state, { key: 'a', title: 'a again' });

    expect(state.toasts.map((toast) => toast.title)).toEqual(['a again', 'b']);
  });

  it('keeps the original id, so an open details panel is not orphaned', () => {
    let state = push(EMPTY_TOAST_STATE, { key: 'a', title: 'a' });
    const firstId = state.toasts[0]!.id;
    state = push(state, { key: 'a', title: 'a again' });
    expect(state.toasts[0]!.id).toBe(firstId);
  });

  it('treats different keys as different toasts', () => {
    let state = push(EMPTY_TOAST_STATE, { key: 'save', title: 'Save failed' });
    state = push(state, { key: 'delete', title: 'Delete failed' });
    expect(state.toasts).toHaveLength(2);
  });
});

describe('the visible cap', () => {
  it('holds at MAX_VISIBLE', () => {
    let state = EMPTY_TOAST_STATE;
    for (let index = 0; index < MAX_VISIBLE + 3; index += 1) {
      state = push(state, { key: `k${index}`, title: `t${index}` });
    }
    expect(state.toasts).toHaveLength(MAX_VISIBLE);
  });

  /**
   * Trimming from the wrong end would drop the toast describing what the user
   * just did, which is the only one they are waiting for.
   */
  it('drops the oldest, never the newest', () => {
    let state = EMPTY_TOAST_STATE;
    for (let index = 0; index < MAX_VISIBLE + 1; index += 1) {
      state = push(state, { key: `k${index}`, title: `t${index}` });
    }
    const titles = state.toasts.map((toast) => toast.title);
    expect(titles).not.toContain('t0');
    expect(titles.at(-1)).toBe(`t${MAX_VISIBLE}`);
  });
});

describe('dismissal', () => {
  it('removes by id', () => {
    let state = push(EMPTY_TOAST_STATE, { title: 'a' });
    state = push(state, { title: 'b' });
    state = toastReducer(state, { type: 'dismiss', id: state.toasts[0]!.id });

    expect(state.toasts.map((toast) => toast.title)).toEqual(['b']);
  });

  it('removes by key', () => {
    let state = push(EMPTY_TOAST_STATE, { key: 'a', title: 'a' });
    state = push(state, { key: 'b', title: 'b' });
    state = toastReducer(state, { type: 'dismissKey', key: 'a' });

    expect(state.toasts.map((toast) => toast.title)).toEqual(['b']);
  });

  it('ignores an id that is not showing', () => {
    const state = push(EMPTY_TOAST_STATE, { title: 'a' });
    expect(toastReducer(state, { type: 'dismiss', id: 'nope' }).toasts).toHaveLength(1);
  });

  it('clears everything', () => {
    let state = push(EMPTY_TOAST_STATE, { title: 'a' });
    state = push(state, { title: 'b' });
    expect(toastReducer(state, { type: 'clear' }).toasts).toEqual([]);
  });
});

describe('how long each variant stays', () => {
  /**
   * An error is the only record of what went wrong, it may carry a
   * `View details` action, and a user who looked away has no way to bring it
   * back. §27 of the error spec: important errors must not disappear before they
   * can reasonably be read.
   */
  it.each<[ToastVariant, boolean]>([
    ['error', true],
    ['warning', true],
    ['loading', true],
    ['success', false],
    ['info', false],
  ])('%s persists: %s', (variant, persists) => {
    expect(defaultDuration(variant) === null).toBe(persists);
  });

  it('lets a caller override the default', () => {
    const state = push(EMPTY_TOAST_STATE, { variant: 'error', duration: 1_000 });
    expect(state.toasts[0]!.duration).toBe(1_000);
  });
});

describe('the store', () => {
  beforeEach(() => {
    resetToastsForTest();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetToastsForTest();
  });

  it('notifies subscribers on a push', () => {
    const listener = vi.fn();
    subscribeToasts(listener);
    pushToast(input());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    subscribeToasts(listener)();
    pushToast(input());
    expect(listener).not.toHaveBeenCalled();
  });

  it('auto-dismisses a success toast', () => {
    pushToast(input({ variant: 'success', title: 'Saved' }));
    expect(getToastState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(4_000);
    expect(getToastState().toasts).toHaveLength(0);
  });

  it('leaves an error toast alone', () => {
    pushToast(input({ variant: 'error' }));
    vi.advanceTimersByTime(60_000);
    expect(getToastState().toasts).toHaveLength(1);
  });

  /**
   * The replaced toast's timer belongs to the message that is going away.
   * Leaving it running would dismiss its replacement early — so a success that
   * keeps being re-pushed would vanish mid-sentence.
   */
  it('does not let a replaced toast’s timer dismiss its replacement', () => {
    pushToast(input({ key: 'k', variant: 'success', title: 'first' }));
    vi.advanceTimersByTime(3_000);

    pushToast(input({ key: 'k', variant: 'success', title: 'second' }));
    // The first timer would have fired here; the second has 4s of its own.
    vi.advanceTimersByTime(1_500);
    expect(getToastState().toasts).toHaveLength(1);
    expect(getToastState().toasts[0]!.title).toBe('second');

    vi.advanceTimersByTime(3_000);
    expect(getToastState().toasts).toHaveLength(0);
  });

  it('returns the id it created', () => {
    const id = pushToast(input({ title: 'a' }));
    expect(getToastState().toasts[0]!.id).toBe(id);
  });

  it('dismisses by id and by key from the store', () => {
    const id = pushToast(input({ key: 'a' }));
    pushToast(input({ key: 'b' }));

    dismissToast(id);
    expect(getToastState().toasts).toHaveLength(1);

    dismissToastByKey('b');
    expect(getToastState().toasts).toHaveLength(0);
  });

  it('clears pending timers when everything is cleared', () => {
    pushToast(input({ variant: 'success' }));
    clearToasts();
    expect(getToastState().toasts).toHaveLength(0);

    // No stray timer left to fire against an empty queue.
    vi.advanceTimersByTime(10_000);
    expect(getToastState().toasts).toHaveLength(0);
  });
});
