/**
 * Autosave for the AI review page (SP2 §6.3), kept out of React so its timing
 * rules can be tested with fake timers.
 *
 * The rules, and why each exists:
 *
 * - **Debounce.** Every edit re-arms one timer; a save goes out `delayMs`
 *   after the last edit, carrying the latest input only.
 * - **One request at a time.** The server applies a save only on top of the
 *   revision it names. Two overlapping saves would both name revision N, and
 *   the second would 409 against the first — a conflict with ourselves. So a
 *   save waits for the one in flight and then sends the revision it returned.
 * - **Dirty is a sequence, not a flag.** Each edit bumps a counter and a save
 *   records the counter it started from. A save that lands after a newer edit
 *   leaves the form dirty; clearing a boolean would silently drop that edit.
 * - **A conflict stops autosaving.** Another tab saved first; retrying would
 *   only repeat the 409. Saving resumes after `reset` (the page's "Load latest").
 * - **`reset` disowns in-flight saves.** Their outcome belongs to the form that
 *   was replaced, so it is ignored — but the next save still waits for them, to
 *   keep the one-at-a-time rule.
 */

export type SaveStatus = 'saved' | 'saving' | 'error' | 'conflict';

export interface SaverSnapshot {
  status: SaveStatus;
  /** An edit has not been saved yet. */
  dirty: boolean;
  /** A save is scheduled or in flight. */
  pending: boolean;
}

export interface DraftSaverOptions<I, R> {
  delayMs: number;
  write: (input: I, revision: number) => Promise<R>;
  revisionOf: (result: R) => number;
  isConflict: (error: unknown) => boolean;
  /** A save succeeded; `input` is what was sent (its issues refer to it). */
  onSaved: (result: R, input: I) => void;
  onConflict?: () => void;
  onChange: (snapshot: SaverSnapshot) => void;
}

export class DraftSaver<I, R> {
  private revision = 0;
  private latest: I | null = null;
  private editSeq = 0;
  private savedSeq = 0;
  private status: SaveStatus = 'saved';
  private failure: unknown = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Never rejects: failures are reported through `status`, then rethrown by `run`. */
  private inflight: Promise<void> | null = null;
  /** Bumped by `reset`, so the outcome of an older save can be recognised and dropped. */
  private epoch = 0;

  constructor(private readonly options: DraftSaverOptions<I, R>) {}

  snapshot(): SaverSnapshot {
    return {
      status: this.status,
      dirty: this.editSeq !== this.savedSeq,
      pending: this.timer !== null || this.inflight !== null,
    };
  }

  /** Start over from a freshly loaded form whose saved draft has `revision` (0 for none). */
  reset(revision: number): void {
    this.clearTimer();
    this.epoch += 1;
    this.revision = revision;
    this.latest = null;
    this.editSeq = 0;
    this.savedSeq = 0;
    this.status = 'saved';
    this.failure = null;
    this.emit();
  }

  /** The form changed; `input` is the body to save for it. */
  edit(input: I): void {
    this.latest = input;
    this.editSeq += 1;
    if (this.status !== 'conflict') {
      this.clearTimer();
      this.timer = setTimeout(() => {
        this.timer = null;
        // A failure is already on screen through `status`.
        void this.run().catch(() => undefined);
      }, this.options.delayMs);
    }
    this.emit();
  }

  /**
   * Save now, skipping the debounce: waits for any save in flight, then sends
   * whatever is still unsaved. Rejects if the form cannot be saved (a failure,
   * or a conflict), so a caller such as Create stops instead of committing an
   * older draft.
   */
  flush(): Promise<void> {
    this.clearTimer();
    this.emit();
    return this.run();
  }

  private async run(): Promise<void> {
    const epoch = this.epoch;
    while (this.inflight) await this.inflight.catch(() => undefined);
    // Re-checked after every await: a reset may have replaced the form meanwhile.
    if (epoch !== this.epoch) return;
    if (this.status === 'conflict') throw this.failure;
    if (this.editSeq === this.savedSeq || this.latest === null) return;

    const seq = this.editSeq;
    const input = this.latest;
    let failed = false;
    this.status = 'saving';
    // `inflight` is set in the same synchronous step as the checks above, so a
    // second caller that was also waiting sees it and waits again.
    const revision = this.revision;
    // Through a microtask so a `write` that throws synchronously still lands in
    // the failure branch instead of escaping with `status` stuck on 'saving'.
    const attempt: Promise<void> = Promise.resolve()
      .then(() => this.options.write(input, revision))
      .then(
        (result) => {
          if (epoch !== this.epoch) return;
          this.revision = this.options.revisionOf(result);
          this.savedSeq = seq;
          this.status = 'saved';
          this.failure = null;
          this.options.onSaved(result, input);
        },
        (cause: unknown) => {
          if (epoch !== this.epoch) return;
          failed = true;
          this.failure = cause;
          if (this.options.isConflict(cause)) {
            this.status = 'conflict';
            this.clearTimer();
            this.options.onConflict?.();
          } else {
            this.status = 'error';
          }
        },
      )
      .finally(() => {
        if (this.inflight === attempt) this.inflight = null;
        this.emit();
      });
    this.inflight = attempt;
    this.emit();
    await attempt;
    if (failed) throw this.failure;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(): void {
    this.options.onChange(this.snapshot());
  }
}
