import { describe, it, expect } from 'vitest';
import {
  NO_VALUE,
  toEndpointBars,
  toEndpointRows,
  toProjectStatTiles,
  toRequestPoints,
} from './project-metrics';
import type { EndpointUsage, ProjectMetricsView } from './api-types';
import type { IpsEntity } from './endpoints';

function field(name: string, type = 'string') {
  return { name, type, required: true, default: null, children: [], validation: {}, meta: {} };
}

const CUSTOMER: IpsEntity = {
  name: 'Customer',
  fields: [field('email'), field('name')],
  relations: [],
} as unknown as IpsEntity;

const METHODS = ['GET', 'POST', 'DELETE'];

function view(overrides: Partial<ProjectMetricsView['requests']> = {}): ProjectMetricsView {
  return {
    window: { days: 7, from: '', to: '', tz: 'UTC', retentionDays: 30 },
    endpoints: { total: 8, entities: 3 },
    requests: {
      total: 5204,
      previousTotal: 4646,
      changePercent: 12,
      successRate: 98.6,
      clientErrorRate: 1.1,
      serverErrorRate: 1.4,
      avgDurationMs: 120,
      previousAvgDurationMs: 130,
      durationChangeMs: -10,
      durationSampleCount: 5204,
      series: [],
      ...overrides,
    },
    topEndpoints: [],
    unattributedRequests: 0,
    endpointNote: null,
    activity: [],
  };
}

const tile = (v: ProjectMetricsView, label: string) =>
  toProjectStatTiles(v).find((t) => t.label === label);

describe('toProjectStatTiles', () => {
  it('produces four tiles, not the five in the design', () => {
    // The base URL is a full-width row above them: the design renders it both as
    // a tile and inside its Environment card, and one copy is enough.
    expect(toProjectStatTiles(view())).toHaveLength(4);
  });

  it('formats large request counts compactly', () => {
    expect(tile(view(), 'Requests')?.value).toBe('5.2K');
  });

  it('describes endpoints by entity count, not a fabricated trend', () => {
    // The design shows "+2 this week". Endpoint-count history is not stored, so
    // that delta cannot be derived from anything.
    const endpoints = tile(view(), 'Endpoints');
    expect(endpoints?.value).toBe('8');
    expect(endpoints?.hint).toBe('3 entities');
    expect(endpoints?.delta).toBeUndefined();
  });

  it('singularises a one-entity project', () => {
    const single = { ...view(), endpoints: { total: 3, entities: 1 } };
    expect(tile(single, 'Endpoints')?.hint).toBe('1 entity');
  });

  describe('with no traffic at all', () => {
    const empty = view({
      total: 0,
      previousTotal: 0,
      changePercent: null,
      successRate: null,
      clientErrorRate: null,
      serverErrorRate: null,
      avgDurationMs: null,
      previousAvgDurationMs: null,
      durationChangeMs: null,
      durationSampleCount: 0,
    });

    it('shows a dash rather than zero for every rate', () => {
      // `0%` success would read as "everything failed"; `0ms` would claim an
      // impossibly fast API. Neither is true of a project nobody has called.
      expect(tile(empty, 'Success rate')?.value).toBe(NO_VALUE);
      expect(tile(empty, 'Avg response')?.value).toBe(NO_VALUE);
    });

    it('shows zero requests, because that figure is real', () => {
      // Unlike a rate, a count of zero is a true statement.
      expect(tile(empty, 'Requests')?.value).toBe('0');
    });

    it('offers no deltas', () => {
      // "Up from nothing" has no percentage.
      expect(tile(empty, 'Requests')?.delta).toBeNull();
      expect(tile(empty, 'Avg response')?.delta).toBeNull();
    });

    it('says so in the hints', () => {
      expect(tile(empty, 'Success rate')?.hint).toBe('no requests yet');
      expect(tile(empty, 'Avg response')?.hint).toBe('no requests yet');
    });
  });

  describe('the latency delta', () => {
    /**
     * The inversion that is easy to get wrong: for requests, up is good; for
     * response time, **down** is good. Sharing one mapping would paint a
     * speed-up red.
     */
    it('treats getting faster as an improvement', () => {
      const faster = tile(view({ durationChangeMs: -10 }), 'Avg response')?.delta;
      expect(faster?.direction).toBe('up');
      expect(faster?.text).toBe('-10ms vs previous');
    });

    it('treats getting slower as a regression', () => {
      const slower = tile(view({ durationChangeMs: 25 }), 'Avg response')?.delta;
      expect(slower?.direction).toBe('down');
      expect(slower?.text).toBe('+25ms vs previous');
    });

    it('shows nothing when the latency did not move', () => {
      // A "+0ms" badge is noise.
      expect(tile(view({ durationChangeMs: 0 }), 'Avg response')?.delta).toBeNull();
    });

    it('shows nothing when the previous window was never timed', () => {
      expect(tile(view({ durationChangeMs: null }), 'Avg response')?.delta).toBeNull();
    });
  });

  describe('the duration sample hint', () => {
    it('discloses when only some requests were timed', () => {
      // `durationMs` postdates the log and cannot be backfilled, so the mean is
      // over a subset — publishing the sample size is what makes it readable.
      const partial = view({ total: 5204, durationSampleCount: 412 });
      expect(tile(partial, 'Avg response')?.hint).toBe('timed for 412 of 5.2K');
    });

    it('says nothing was timed when nothing was', () => {
      const none = view({ total: 100, durationSampleCount: 0, avgDurationMs: null });
      expect(tile(none, 'Avg response')?.hint).toBe('not recorded for these requests');
    });

    it('keeps quiet about sampling when every request was timed', () => {
      expect(tile(view(), 'Avg response')?.hint).toBe('across 5.2K requests');
    });
  });

  it('reports client errors separately from failure', () => {
    // The runtime returns 4xx by design — 405 for an unselected method, 422 for
    // the user's own validation rules. Counting those against success would
    // punish correct behaviour.
    expect(tile(view(), 'Success rate')?.value).toBe('98.6%');
    expect(tile(view(), 'Success rate')?.hint).toBe('1.1% client errors');
  });
});

describe('toRequestPoints', () => {
  it('labels points by month and day', () => {
    const points = toRequestPoints(
      view({
        series: [
          { date: '2026-08-20', count: 5, serverErrors: 0, partial: false },
          { date: '2026-08-21', count: 9, serverErrors: 1, partial: true },
        ],
      }),
    );
    // A 30-day axis cannot fit full dates, and the year is never in question
    // inside a 30-day window.
    expect(points).toEqual([
      { label: '08-20', value: 5 },
      { label: '08-21', value: 9 },
    ]);
  });

  it('returns an empty list for an empty series, so the chart shows its empty state', () => {
    expect(toRequestPoints(view({ series: [] }))).toEqual([]);
  });
});

describe('toEndpointRows', () => {
  const usage = (over: Partial<EndpointUsage>): EndpointUsage => ({
    method: 'GET',
    entity: 'customer',
    shape: 'collection',
    count: 10,
    avgDurationMs: 40,
    durationSampleCount: 10,
    serverErrors: 0,
    ...over,
  });

  it('rebuilds the collection path from the current schema', () => {
    const [row] = toEndpointRows([usage({})], [CUSTOMER], METHODS);
    expect(row).toMatchObject({ method: 'GET', path: '/customer', orphaned: false });
  });

  it('rebuilds the record path with the current identity field', () => {
    // The whole reason the API returns (method, entity, shape) instead of a path:
    // the template is regenerated from today's schema, so a renamed identity
    // field shows correctly against traffic logged before the rename.
    const [row] = toEndpointRows([usage({ shape: 'record' })], [CUSTOMER], METHODS);
    expect(row?.path).toBe('/customer/{id}');
    expect(row?.orphaned).toBe(false);
  });

  it('renders the discovery document as the root path', () => {
    const [row] = toEndpointRows([usage({ entity: null, shape: 'index' })], [CUSTOMER], METHODS);
    expect(row).toMatchObject({ path: '/', orphaned: false });
  });

  /**
   * Traffic against a since-deleted entity. Dropping these rows would make the
   * breakdown quietly fail to add up against the total above it, so they are kept
   * and flagged.
   */
  it('keeps traffic for an entity that no longer exists, marked orphaned', () => {
    const [row] = toEndpointRows([usage({ entity: 'invoice' })], [CUSTOMER], METHODS);
    expect(row).toMatchObject({ path: '/invoice', orphaned: true, count: 10 });
  });

  it('marks a method that is no longer enabled as orphaned', () => {
    // PATCH traffic exists in the log but PATCH is not in the current config, so
    // there is no current endpoint to point at.
    const [row] = toEndpointRows(
      [usage({ method: 'PATCH', shape: 'record' })],
      [CUSTOMER],
      METHODS,
    );
    expect(row?.orphaned).toBe(true);
  });

  it('distinguishes the same entity across methods and shapes', () => {
    const rows = toEndpointRows(
      [
        usage({ method: 'GET', shape: 'collection' }),
        usage({ method: 'POST', shape: 'collection' }),
        usage({ method: 'GET', shape: 'record' }),
      ],
      [CUSTOMER],
      METHODS,
    );
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
    expect(rows.filter((row) => row.orphaned)).toHaveLength(0);
  });

  it('preserves the counts it was given', () => {
    const rows = toEndpointRows([usage({ count: 1234 })], [CUSTOMER], METHODS);
    expect(rows[0]?.count).toBe(1234);
  });
});

describe('toEndpointBars', () => {
  const row = (path: string, count: number) => ({
    key: path,
    method: 'GET',
    path,
    count,
    avgDurationMs: null,
    orphaned: false,
  });

  it('sorts by count and caps the list', () => {
    const bars = toEndpointBars([row('/a', 5), row('/b', 90), row('/c', 40)], 2);
    expect(bars.map((bar) => bar.path)).toEqual(['/b', '/c']);
  });

  /**
   * Scaled against the busiest endpoint, not the total. With twenty endpoints
   * every share-of-total bar would be a sliver, and the panel answers "which is
   * busiest".
   */
  it('gives the busiest a full bar and scales the rest against it', () => {
    const bars = toEndpointBars([row('/a', 100), row('/b', 50), row('/c', 25)]);
    expect(bars.map((bar) => bar.fraction)).toEqual([1, 0.5, 0.25]);
  });

  it('survives an all-zero set without dividing by zero', () => {
    const bars = toEndpointBars([row('/a', 0), row('/b', 0)]);
    expect(bars.every((bar) => bar.fraction === 0)).toBe(true);
  });

  it('returns nothing for no rows', () => {
    expect(toEndpointBars([])).toEqual([]);
  });

  it('does not mutate the list it was given', () => {
    // It sorts, and sorting in place would reorder the caller's endpoint table.
    const rows = [row('/a', 5), row('/b', 90)];
    toEndpointBars(rows);
    expect(rows.map((r) => r.path)).toEqual(['/a', '/b']);
  });
});
