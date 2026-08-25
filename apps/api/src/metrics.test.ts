import { describe, it, expect } from 'vitest';
import {
  averageDuration,
  dayKey,
  percentChange,
  planLimit,
  rate,
  requestRates,
  resolveWindow,
  zeroFillSeries,
  type RawBucket,
} from './metrics.js';

const NOW = new Date('2026-05-18T14:30:00.000Z');

describe('resolveWindow', () => {
  it('ends at the start of tomorrow so today has a bucket', () => {
    // Ending at "now" would leave the series finishing yesterday, and today's
    // traffic would be invisible until midnight.
    const { from, to } = resolveWindow(7, NOW);
    expect(to.toISOString()).toBe('2026-05-19T00:00:00.000Z');
    expect(from.toISOString()).toBe('2026-05-12T00:00:00.000Z');
  });

  it('spans exactly the requested number of days', () => {
    for (const days of [7, 14, 30]) {
      const { from, to } = resolveWindow(days, NOW);
      expect((to.getTime() - from.getTime()) / 86_400_000).toBe(days);
    }
  });
});

describe('zeroFillSeries', () => {
  const raw: RawBucket[] = [
    { date: '2026-05-13', count: 120, serverErrors: 2 },
    { date: '2026-05-18', count: 40, serverErrors: 0 },
  ];

  it('emits one bucket per day, filling the silent ones with zeros', () => {
    // $group emits nothing for a day with no traffic. Rendered raw, a quiet day
    // vanishes and the x-axis compresses — so the chart misreports *when* the
    // traffic happened, not just how much.
    const series = zeroFillSeries(raw, 7, NOW);
    expect(series).toHaveLength(7);
    expect(series.map((bucket) => bucket.date)).toEqual([
      '2026-05-12',
      '2026-05-13',
      '2026-05-14',
      '2026-05-15',
      '2026-05-16',
      '2026-05-17',
      '2026-05-18',
    ]);
    expect(series.map((bucket) => bucket.count)).toEqual([0, 120, 0, 0, 0, 0, 40]);
  });

  it('carries server errors through and defaults them to zero', () => {
    const series = zeroFillSeries(raw, 7, NOW);
    expect(series[1]?.serverErrors).toBe(2);
    expect(series[2]?.serverErrors).toBe(0);
  });

  it('flags only today as partial', () => {
    // Today is always a part-day, so without this flag the last point always
    // dips and every dashboard shows a permanent downward trend.
    const series = zeroFillSeries(raw, 7, NOW);
    expect(series.filter((bucket) => bucket.partial).map((bucket) => bucket.date)).toEqual([
      '2026-05-18',
    ]);
  });

  it('still returns a full series when there is no traffic at all', () => {
    const series = zeroFillSeries([], 7, NOW);
    expect(series).toHaveLength(7);
    expect(series.every((bucket) => bucket.count === 0)).toBe(true);
  });

  it('ignores a bucket outside the window rather than misplacing it', () => {
    const series = zeroFillSeries([{ date: '2020-01-01', count: 99, serverErrors: 0 }], 7, NOW);
    expect(series.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(0);
  });

  it('is ascending by date', () => {
    const dates = zeroFillSeries(raw, 30, NOW).map((bucket) => bucket.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe('percentChange', () => {
  it('rounds to one decimal', () => {
    expect(percentChange(12450, 10534)).toBe(18.2);
    expect(percentChange(50, 100)).toBe(-50);
  });

  it('returns null rather than infinity when the previous window was empty', () => {
    // "Up from nothing" has no honest percentage, and +Infinity% or NaN% is
    // what reaches the UI otherwise.
    expect(percentChange(500, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
  });

  it('reports zero change as 0, not null', () => {
    expect(percentChange(100, 100)).toBe(0);
  });
});

describe('rate', () => {
  it('is a one-decimal percentage', () => {
    expect(rate(986, 1000)).toBe(98.6);
    expect(rate(1, 3)).toBe(33.3);
  });

  it('is null on a zero denominator, never NaN', () => {
    expect(rate(0, 0)).toBeNull();
    expect(Number.isNaN(rate(0, 0) as number)).toBe(false);
  });
});

describe('requestRates', () => {
  it('counts 4xx as success, and reports it separately', () => {
    // The runtime returns 405 for an unselected method and 422 for the user's
    // own validation rules. Counting those as errors would make the dashboard
    // punish someone for testing their schema.
    const rates = requestRates({ total: 1000, clientErrors: 140, serverErrors: 0 });
    expect(rates.successRate).toBe(100);
    expect(rates.serverErrorRate).toBe(0);
    expect(rates.clientErrorRate).toBe(14);
  });

  it('counts 5xx against the success rate', () => {
    const rates = requestRates({ total: 1000, clientErrors: 10, serverErrors: 4 });
    expect(rates.serverErrorRate).toBe(0.4);
    expect(rates.successRate).toBe(99.6);
  });

  it('returns nulls for a window with no traffic', () => {
    expect(requestRates({ total: 0, clientErrors: 0, serverErrors: 0 })).toEqual({
      successRate: null,
      clientErrorRate: null,
      serverErrorRate: null,
    });
  });
});

describe('averageDuration', () => {
  it('averages over the rows that carry a duration', () => {
    expect(averageDuration(1200, 10)).toEqual({ avgDurationMs: 120, durationSampleCount: 10 });
  });

  it('is null with no samples, so the UI can render an em-dash not 0ms', () => {
    // Every row predating the field holds null and cannot be backfilled. A 0
    // here would read as an impossibly fast API for a whole retention window.
    expect(averageDuration(0, 0)).toEqual({ avgDurationMs: null, durationSampleCount: 0 });
  });

  it('reports the sample count so a thin average is legible as thin', () => {
    expect(averageDuration(300, 2).durationSampleCount).toBe(2);
  });
});

describe('planLimit', () => {
  it('normalises both "unlimited" sentinels to null', () => {
    // PlanConfig carries maxConcurrentJobs: Infinity AND maxProjects: 0, both
    // meaning unlimited. JSON.stringify(Infinity) is null, so without this the
    // enterprise sidebar renders a "0 / 0" meter.
    expect(planLimit(Infinity)).toBeNull();
    expect(planLimit(0)).toBeNull();
  });

  it('passes a real limit through', () => {
    expect(planLimit(10)).toBe(10);
    expect(planLimit(1)).toBe(1);
  });
});

describe('dayKey', () => {
  it('is the UTC calendar day', () => {
    expect(dayKey(new Date('2026-05-18T23:59:59.999Z'))).toBe('2026-05-18');
    expect(dayKey(new Date('2026-05-19T00:00:00.000Z'))).toBe('2026-05-19');
  });
});
