import { describe, it, expect } from 'vitest';
import { formatAgo } from './relative-time';

const NOW = new Date('2026-05-18T12:00:00.000Z');
const ago = (ms: number) => formatAgo(new Date(NOW.getTime() - ms), NOW);

describe('formatAgo', () => {
  it('reads anything under a minute as just now', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(59_000)).toBe('just now');
  });

  it('counts minutes, hours and days', () => {
    expect(ago(60_000)).toBe('1m ago');
    expect(ago(45 * 60_000)).toBe('45m ago');
    expect(ago(2 * 3_600_000)).toBe('2h ago');
    expect(ago(23 * 3_600_000)).toBe('23h ago');
    expect(ago(3 * 86_400_000)).toBe('3d ago');
  });

  it('switches units at the boundary, not inside it', () => {
    expect(ago(3_599_999)).toBe('59m ago');
    expect(ago(3_600_000)).toBe('1h ago');
    expect(ago(86_399_999)).toBe('23h ago');
    expect(ago(86_400_000)).toBe('1d ago');
  });

  it('counts weeks past a week', () => {
    expect(ago(7 * 86_400_000)).toBe('1w ago');
    expect(ago(20 * 86_400_000)).toBe('2w ago');
  });

  it('falls back to a date once elapsed time stops being useful', () => {
    // "9w ago" tells nobody anything, and it is past the request log's retention
    // window anyway.
    const old = formatAgo(new Date('2026-01-04T00:00:00.000Z'), NOW);
    expect(old).not.toContain('ago');
    expect(old).toMatch(/2026/);
  });

  it('treats a future timestamp as just now rather than counting up', () => {
    // Clock skew between the server and the browser puts "past" events slightly
    // ahead. "in 3 seconds" on an activity feed would be nonsense.
    expect(formatAgo(new Date(NOW.getTime() + 5_000), NOW)).toBe('just now');
    expect(formatAgo(new Date(NOW.getTime() + 86_400_000), NOW)).toBe('just now');
  });

  it('accepts an ISO string as well as a Date', () => {
    expect(formatAgo('2026-05-18T10:00:00.000Z', NOW)).toBe('2h ago');
  });

  it('returns an empty string for an unparseable value rather than "NaN ago"', () => {
    expect(formatAgo('not a date', NOW)).toBe('');
  });

  it('takes now as a parameter, so it is deterministic', () => {
    // The whole reason this lives here rather than in packages/ui: formatRemaining
    // reads the clock internally and therefore cannot be tested.
    expect(formatAgo('2026-05-18T10:00:00.000Z', NOW)).toBe(
      formatAgo('2026-05-18T10:00:00.000Z', NOW),
    );
  });
});
