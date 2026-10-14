import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftSaver, type SaverSnapshot } from './draft-saver';

interface Saved {
  revision: number;
}

/** A promise the test resolves or rejects by hand, to hold a save "in flight". */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class Conflict extends Error {}

function setup(options: { failOnSaved?: Error } = {}) {
  const calls: { input: string; revision: number; done: ReturnType<typeof deferred<Saved>> }[] = [];
  const saved: { result: Saved; input: string }[] = [];
  const snapshots: SaverSnapshot[] = [];
  let conflicts = 0;
  const saver = new DraftSaver<string, Saved>({
    delayMs: 800,
    write: (input, revision) => {
      const done = deferred<Saved>();
      calls.push({ input, revision, done });
      return done.promise;
    },
    revisionOf: (result) => result.revision,
    isConflict: (error) => error instanceof Conflict,
    onSaved: (result, input) => {
      if (options.failOnSaved) throw options.failOnSaved;
      saved.push({ result, input });
    },
    onConflict: () => {
      conflicts += 1;
    },
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return {
    saver,
    calls,
    saved,
    snapshots,
    conflicts: () => conflicts,
    last: () => snapshots[snapshots.length - 1]!,
  };
}

/** Let resolved promises run their continuations. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DraftSaver', () => {
  it('debounces edits and saves only the latest input, 800 ms after the last one', async () => {
    const t = setup();
    t.saver.reset(0);
    t.saver.edit('a');
    vi.advanceTimersByTime(500);
    t.saver.edit('ab');
    vi.advanceTimersByTime(799);
    expect(t.calls).toHaveLength(0);
    expect(t.last()).toEqual({ status: 'saved', dirty: true, pending: true });
    vi.advanceTimersByTime(1);
    await settle();
    expect(t.calls.map((c) => [c.input, c.revision])).toEqual([['ab', 0]]);
    expect(t.last().status).toBe('saving');
  });

  it('sends the revision it was reset to, then the one each save returns', async () => {
    const t = setup();
    t.saver.reset(4);
    t.saver.edit('a');
    vi.advanceTimersByTime(800);
    await settle();
    t.calls[0]!.done.resolve({ revision: 5 });
    await settle();
    expect(t.last()).toEqual({ status: 'saved', dirty: false, pending: false });
    expect(t.saved).toEqual([{ result: { revision: 5 }, input: 'a' }]);

    t.saver.edit('b');
    vi.advanceTimersByTime(800);
    await settle();
    expect(t.calls[1]!.revision).toBe(5);
  });

  it('never runs two saves at once, and stays dirty for an edit made mid-flight', async () => {
    const t = setup();
    t.saver.reset(0);
    t.saver.edit('a');
    vi.advanceTimersByTime(800);
    await settle();
    expect(t.calls).toHaveLength(1);

    // Edited while the first save is in flight: its timer fires but must wait.
    t.saver.edit('ab');
    vi.advanceTimersByTime(800);
    await settle();
    expect(t.calls).toHaveLength(1);

    t.calls[0]!.done.resolve({ revision: 1 });
    await settle();
    // The first save covered 'a' only, so the form is still dirty and a second
    // save starts on top of the revision the first one returned.
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]).toMatchObject({ input: 'ab', revision: 1 });
    expect(t.last().dirty).toBe(true);

    t.calls[1]!.done.resolve({ revision: 2 });
    await settle();
    expect(t.last()).toEqual({ status: 'saved', dirty: false, pending: false });
  });

  it('keeps dirty set when an edit lands after the save started, even with no second save yet', async () => {
    const t = setup();
    t.saver.reset(0);
    t.saver.edit('a');
    vi.advanceTimersByTime(800);
    await settle();
    t.saver.edit('ab');
    t.calls[0]!.done.resolve({ revision: 1 });
    await settle();
    expect(t.calls).toHaveLength(1);
    expect(t.last()).toEqual({ status: 'saved', dirty: true, pending: true });
  });

  it('stops autosaving on a conflict until reset, and flush rejects meanwhile', async () => {
    const t = setup();
    t.saver.reset(2);
    t.saver.edit('a');
    vi.advanceTimersByTime(800);
    await settle();
    t.calls[0]!.done.reject(new Conflict('changed elsewhere'));
    await settle();
    expect(t.last()).toEqual({ status: 'conflict', dirty: true, pending: false });
    expect(t.conflicts()).toBe(1);

    t.saver.edit('ab');
    vi.advanceTimersByTime(5_000);
    await settle();
    expect(t.calls).toHaveLength(1);
    expect(t.last().pending).toBe(false);
    await expect(t.saver.flush()).rejects.toBeInstanceOf(Conflict);

    // "Load latest": the form is re-initialised, so nothing is dirty and saving resumes.
    t.saver.reset(7);
    expect(t.last()).toEqual({ status: 'saved', dirty: false, pending: false });
    t.saver.edit('fresh');
    vi.advanceTimersByTime(800);
    await settle();
    expect(t.calls[1]).toMatchObject({ input: 'fresh', revision: 7 });
  });

  it('reports other failures as an error, keeps the edit dirty, and retries on flush', async () => {
    const t = setup();
    t.saver.reset(0);
    t.saver.edit('a');
    vi.advanceTimersByTime(800);
    await settle();
    t.calls[0]!.done.reject(new Error('offline'));
    await settle();
    expect(t.last()).toEqual({ status: 'error', dirty: true, pending: false });
    expect(t.conflicts()).toBe(0);

    const retried = t.saver.flush();
    await settle();
    expect(t.calls[1]).toMatchObject({ input: 'a', revision: 0 });
    t.calls[1]!.done.resolve({ revision: 1 });
    await retried;
    expect(t.last()).toEqual({ status: 'saved', dirty: false, pending: false });
  });

  it('flush rejects with the failure so a caller (Create) can stop', async () => {
    const t = setup();
    t.saver.reset(0);
    t.saver.edit('a');
    const flushed = t.saver.flush();
    await settle();
    t.calls[0]!.done.reject(new Error('too large'));
    await expect(flushed).rejects.toThrow('too large');
  });

  it('flush skips the debounce, waits for an in-flight save, then saves what is left', async () => {
    const t = setup();
    t.saver.reset(0);
    t.saver.edit('a');
    vi.advanceTimersByTime(800);
    await settle();
    t.saver.edit('ab');
    let done = false;
    const flushed = t.saver.flush().then(() => {
      done = true;
    });
    await settle();
    expect(t.calls).toHaveLength(1);
    t.calls[0]!.done.resolve({ revision: 1 });
    await settle();
    expect(t.calls[1]).toMatchObject({ input: 'ab', revision: 1 });
    expect(done).toBe(false);
    t.calls[1]!.done.resolve({ revision: 2 });
    await flushed;
    expect(done).toBe(true);
    // The debounce timer that edit('ab') armed was cancelled, so nothing else is sent.
    vi.advanceTimersByTime(5_000);
    await settle();
    expect(t.calls).toHaveLength(2);
  });

  it('flush with nothing to save resolves without a request', async () => {
    const t = setup();
    t.saver.reset(3);
    await t.saver.flush();
    expect(t.calls).toHaveLength(0);
  });

  it('ignores the outcome of a save that was in flight when it was reset', async () => {
    const t = setup();
    t.saver.reset(0);
    t.saver.edit('old');
    vi.advanceTimersByTime(800);
    await settle();
    t.saver.reset(9);
    t.calls[0]!.done.resolve({ revision: 1 });
    await settle();
    expect(t.saved).toEqual([]);
    expect(t.last()).toEqual({ status: 'saved', dirty: false, pending: false });

    t.saver.edit('new');
    vi.advanceTimersByTime(800);
    await settle();
    expect(t.calls[1]).toMatchObject({ input: 'new', revision: 9 });
  });

  it('still serialises across a reset: a new save waits for the old request', async () => {
    const t = setup();
    t.saver.reset(0);
    t.saver.edit('old');
    vi.advanceTimersByTime(800);
    await settle();
    t.saver.reset(9);
    t.saver.edit('new');
    vi.advanceTimersByTime(800);
    await settle();
    expect(t.calls).toHaveLength(1);
    t.calls[0]!.done.reject(new Conflict('stale'));
    await settle();
    // The stale request's conflict belongs to the old form and is ignored.
    expect(t.conflicts()).toBe(0);
    expect(t.calls[1]).toMatchObject({ input: 'new', revision: 9 });
  });

  it('treats a throw in the success handler as a failed save, and keeps working', async () => {
    const boom = new Error('handler broke');
    const t = setup({ failOnSaved: boom });
    t.saver.reset(0);
    t.saver.edit('a');
    const flushed = t.saver.flush();
    await settle();
    t.calls[0]!.done.resolve({ revision: 1 });
    await expect(flushed).rejects.toBe(boom);
    expect(t.last()).toEqual({ status: 'error', dirty: true, pending: false });

    // The in-flight slot was released, so a retry is sent rather than waiting forever.
    const retried = t.saver.flush().catch(() => undefined);
    await settle();
    expect(t.calls).toHaveLength(2);
    t.calls[1]!.done.resolve({ revision: 2 });
    await retried;
  });
});
