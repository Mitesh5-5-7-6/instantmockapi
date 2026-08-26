/**
 * "2h ago" formatting.
 *
 * `now` is an injected parameter, not `Date.now()`. That is the whole reason this
 * is testable — `formatRemaining` in `packages/ui` reads the clock internally,
 * which is exactly why it has no tests. The two are complements, not duplicates:
 * that one counts *down* to an expiry, this one counts *up* from a past event.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact elapsed time: `just now`, `4m ago`, `2h ago`, `3d ago`, `5w ago`,
 * then an absolute date.
 *
 * Beyond about a month, "9w ago" stops helping and a date is more use — which is
 * also past the request log's retention window, so anything older on this screen
 * came from a project record rather than traffic.
 */
export function formatAgo(at: string | Date, now: Date = new Date()): string {
  const then = at instanceof Date ? at : new Date(at);
  const elapsed = now.getTime() - then.getTime();

  if (Number.isNaN(elapsed)) {
    return '';
  }
  // A clock skew between server and browser can put a "past" event slightly in
  // the future. "in 3 seconds" would be a strange thing to read on an activity
  // feed, so anything not yet elapsed reads as just now.
  if (elapsed < MINUTE) {
    return 'just now';
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m ago`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h ago`;
  }
  if (elapsed < 7 * DAY) {
    return `${Math.floor(elapsed / DAY)}d ago`;
  }
  if (elapsed < 35 * DAY) {
    return `${Math.floor(elapsed / (7 * DAY))}w ago`;
  }
  return then.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
