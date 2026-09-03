import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  DEFAULT_TOAST_POSITION,
  isToastPosition,
  parseToastPosition,
  readToastPosition,
  stacksUpward,
  TOAST_POSITION_KEY,
  TOAST_POSITION_LABELS,
  TOAST_POSITIONS,
  writeToastPosition,
} from './toast-position';

describe('the position set', () => {
  it('covers every corner and both centres', () => {
    expect([...TOAST_POSITIONS]).toEqual([
      'top-left',
      'top-center',
      'top-right',
      'bottom-left',
      'bottom-center',
      'bottom-right',
    ]);
  });

  it('labels every one, so the settings control cannot render a blank option', () => {
    for (const position of TOAST_POSITIONS) {
      expect(TOAST_POSITION_LABELS[position]).toBeTruthy();
    }
  });

  it('defaults to bottom-right', () => {
    expect(DEFAULT_TOAST_POSITION).toBe('bottom-right');
  });
});

describe('parseToastPosition', () => {
  it('accepts every valid position', () => {
    for (const position of TOAST_POSITIONS) {
      expect(parseToastPosition(position)).toBe(position);
    }
  });

  /**
   * The stored string is editable by hand and may have been written by an older
   * release. None of that should be able to stop notifications rendering.
   */
  it.each([null, undefined, '', 'middle', 'top', 'TOP-LEFT', 42, {}, []])(
    'falls back to the default for %o',
    (stored) => {
      expect(parseToastPosition(stored)).toBe(DEFAULT_TOAST_POSITION);
    },
  );
});

describe('isToastPosition', () => {
  it('narrows correctly', () => {
    expect(isToastPosition('top-left')).toBe(true);
    expect(isToastPosition('nowhere')).toBe(false);
    expect(isToastPosition(null)).toBe(false);
  });
});

describe('stacksUpward', () => {
  /**
   * A bottom-anchored column grows away from the edge so the newest toast sits
   * nearest the corner the eye is already on.
   */
  it('is true only for bottom anchors', () => {
    expect(stacksUpward('bottom-right')).toBe(true);
    expect(stacksUpward('bottom-left')).toBe(true);
    expect(stacksUpward('bottom-center')).toBe(true);
    expect(stacksUpward('top-right')).toBe(false);
    expect(stacksUpward('top-center')).toBe(false);
  });
});

describe('storage', () => {
  const original = globalThis.window;

  afterEach(() => {
    if (original === undefined) {
      // @ts-expect-error - restoring the node environment's absent window
      delete globalThis.window;
    } else {
      globalThis.window = original;
    }
  });

  function withStorage(storage: Partial<Storage>): void {
    // @ts-expect-error - a minimal window for this pure module's storage access
    globalThis.window = { localStorage: storage };
  }

  it('reads a stored preference', () => {
    withStorage({ getItem: vi.fn().mockReturnValue('top-left') });
    expect(readToastPosition()).toBe('top-left');
  });

  it('defaults when nothing is stored', () => {
    withStorage({ getItem: vi.fn().mockReturnValue(null) });
    expect(readToastPosition()).toBe(DEFAULT_TOAST_POSITION);
  });

  /**
   * `localStorage` throws — not merely returns null — in a Safari private window
   * and wherever site data is blocked. A notification system that crashes the
   * page over a cosmetic preference is worse than one that ignores it.
   */
  it('survives storage that throws on read', () => {
    withStorage({
      getItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
    });
    expect(readToastPosition()).toBe(DEFAULT_TOAST_POSITION);
  });

  it('survives storage that throws on write', () => {
    withStorage({
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError');
      }),
    });
    expect(() => writeToastPosition('top-right')).not.toThrow();
  });

  it('writes under the documented key', () => {
    const setItem = vi.fn();
    withStorage({ setItem });
    writeToastPosition('bottom-left');
    expect(setItem).toHaveBeenCalledWith(TOAST_POSITION_KEY, 'bottom-left');
  });
});
