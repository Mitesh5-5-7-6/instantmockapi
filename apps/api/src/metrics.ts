/**
 * Pure arithmetic behind the dashboard's numbers.
 *
 * Kept apart from the queries so every edge case below is testable without a
 * database — the same split `pagination.ts` uses. All of these exist because the
 * naive version produces a number that is wrong in a way nobody notices.
 */

/** Daily bucket as it comes back from the aggregation — sparse. */
export interface RawBucket {
  date: string;
  count: number;
  serverErrors: number;
}

export interface SeriesBucket extends RawBucket {
  /**
   * True for a bucket whose day has not finished.
   *
   * Without this the last point on the chart is always a partial day, so every
   * dashboard permanently shows a downward trend at the right-hand edge.
   */
  partial: boolean;
}

/** ISO day key (`YYYY-MM-DD`) for a timestamp, in UTC. */
export function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The window a request covers: `[from, to)`.
 *
 * `to` is the start of tomorrow rather than "now", so today's bucket exists and
 * accumulates as the day goes on instead of the series ending yesterday.
 */
export function resolveWindow(days: number, now: Date): { from: Date; to: Date } {
  const startOfToday = new Date(`${dayKey(now)}T00:00:00.000Z`);
  const to = new Date(startOfToday.getTime() + 86_400_000);
  const from = new Date(to.getTime() - days * 86_400_000);
  return { from, to };
}

/**
 * Every day in the window, in order, with missing days as explicit zeros.
 *
 * `$group` emits nothing for a day with no traffic, so a raw pipeline result has
 * fewer points than days. Rendered directly, a quiet Tuesday silently vanishes
 * and the x-axis compresses — the chart then lies about *when* the traffic
 * happened, not just how much.
 */
export function zeroFillSeries(raw: readonly RawBucket[], days: number, now: Date): SeriesBucket[] {
  const byDate = new Map(raw.map((bucket) => [bucket.date, bucket]));
  const today = dayKey(now);
  const { from } = resolveWindow(days, now);

  const series: SeriesBucket[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = dayKey(new Date(from.getTime() + offset * 86_400_000));
    const bucket = byDate.get(date);
    series.push({
      date,
      count: bucket?.count ?? 0,
      serverErrors: bucket?.serverErrors ?? 0,
      partial: date === today,
    });
  }
  return series;
}

/**
 * Percent change between two windows, to one decimal.
 *
 * `null` — not `0`, not `Infinity` — when the previous window had no traffic.
 * There is no honest percentage for "up from nothing", and `(x-0)/0` renders as
 * `+Infinity%` or `NaN%` if it reaches the UI. The caller shows "new" instead.
 */
export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/**
 * A share of a total as a percentage, to one decimal.
 *
 * `null` on a zero denominator for the same reason: `0/0` is `NaN`, which
 * `JSON.stringify` turns into `null` anyway — better to mean it deliberately
 * than to ship a coincidence.
 */
export function rate(part: number, total: number): number | null {
  if (total <= 0) {
    return null;
  }
  return Math.round((part / total) * 1000) / 10;
}

/** Status counts split the way the hosted runtime actually behaves. */
export interface StatusSplit {
  total: number;
  clientErrors: number;
  serverErrors: number;
}

export interface RequestRates {
  successRate: number | null;
  clientErrorRate: number | null;
  serverErrorRate: number | null;
}

/**
 * Success and error rates.
 *
 * **Success is `status < 500`, and 4xx is reported separately.** The hosted
 * runtime returns 4xx by design — 405 for a method the project did not enable,
 * 422 for a record that failed the user's own validation rules, 404 for a
 * missing id, 409 for a duplicate. Counting those as errors means someone
 * testing their validation watches their "error rate" climb, so the dashboard
 * would be punishing correct behaviour.
 */
export function requestRates(split: StatusSplit): RequestRates {
  const success = split.total - split.serverErrors;
  return {
    successRate: rate(success, split.total),
    clientErrorRate: rate(split.clientErrors, split.total),
    serverErrorRate: rate(split.serverErrors, split.total),
  };
}

/**
 * Average of a set of durations that only *some* rows carry.
 *
 * `durationMs` was added after the log existed and cannot be backfilled, so
 * older rows hold null. Averaging those as zero would drag the mean toward zero
 * for a full retention window and render as an impossibly fast API — so the
 * average is over the rows that have a value, and the sample count is published
 * alongside it so the figure can be read for what it is.
 */
export function averageDuration(
  sum: number,
  sampleCount: number,
): { avgDurationMs: number | null; durationSampleCount: number } {
  return {
    avgDurationMs: sampleCount > 0 ? Math.round(sum / sampleCount) : null,
    durationSampleCount: sampleCount,
  };
}

/**
 * Normalize a plan limit for the wire.
 *
 * `PlanConfig` carries two different sentinels for "unlimited" —
 * `maxConcurrentJobs: Infinity` and `maxProjects: 0`. `JSON.stringify(Infinity)`
 * is `null`, so the two would arrive at the client meaning the same thing by
 * accident while `0` arrived meaning a limit of zero. Both become an explicit
 * `null`, or the enterprise sidebar renders a `0 / 0` meter.
 */
export function planLimit(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}
