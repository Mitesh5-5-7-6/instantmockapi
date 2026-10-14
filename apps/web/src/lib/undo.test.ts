import { describe, expect, it } from 'vitest';
import { createHistory, popHistory, pushHistory } from './undo';

describe('undo history', () => {
  it('pops in LIFO order and caps at the limit', () => {
    let h = createHistory<number>(2);
    h = pushHistory(h, 1);
    h = pushHistory(h, 2);
    h = pushHistory(h, 3);
    const first = popHistory(h);
    expect(first.state).toBe(3);
    expect(popHistory(first.history).state).toBe(2);
    expect(popHistory(popHistory(first.history).history).state).toBeUndefined();
  });

  it('defaults to 50 entries', () => {
    expect(createHistory().limit).toBe(50);
  });
});
