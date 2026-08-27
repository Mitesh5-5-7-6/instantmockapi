/**
 * Turning `ProjectMetricsView` into what the Overview tab renders.
 *
 * Pure, so the decisions here are testable without mounting anything — and the
 * decisions are almost all about **not lying**: which figures have no value to
 * show, which deltas are not derivable, and how to present traffic recorded
 * against an endpoint that no longer exists.
 */

import { countEndpoints, entityEndpoints, type IpsEntity } from './endpoints';
import { formatCompact, type ChartPoint } from './area-chart';
import type { ApiLogShape, EndpointUsage, ProjectMetricsView } from './api-types';

/** Shown wherever a figure genuinely has no value — never `0`. */
export const NO_VALUE = '—';

export interface StatTile {
  label: string;
  value: string;
  hint?: string;
  delta?: { text: string; direction: 'up' | 'down' } | null;
}

/**
 * A percentage as a signed string, or null.
 *
 * Null propagates: `changePercent` is null when the previous window had no
 * traffic, because "up from nothing" has no percentage. Rendering that as `+100%`
 * or `+∞%` is the failure this avoids.
 */
function signedPercent(value: number | null): { text: string; direction: 'up' | 'down' } | null {
  if (value === null) {
    return null;
  }
  return {
    text: `${value >= 0 ? '+' : ''}${value}% vs previous`,
    direction: value >= 0 ? 'up' : 'down',
  };
}

/**
 * How much of the traffic was actually timed.
 *
 * `durationMs` was added after logging already existed and cannot be backfilled,
 * so the mean is over a subset. Publishing the sample size is what lets the
 * number be read for what it is rather than assumed to cover everything.
 */
function durationHint(requests: ProjectMetricsView['requests']): string {
  if (requests.total === 0) {
    return 'no requests yet';
  }
  if (requests.durationSampleCount === 0) {
    return 'not recorded for these requests';
  }
  if (requests.durationSampleCount < requests.total) {
    const timed = formatCompact(requests.durationSampleCount);
    return `timed for ${timed} of ${formatCompact(requests.total)}`;
  }
  return `across ${formatCompact(requests.total)} requests`;
}

/**
 * The latency delta.
 *
 * Inverted on purpose: faster is *better*, so a negative millisecond change is an
 * improvement and must render as the positive direction. Reusing the request
 * tile's mapping would paint a speed-up red.
 */
function durationDelta(changeMs: number | null): StatTile['delta'] {
  if (changeMs === null || changeMs === 0) {
    return null;
  }
  const faster = changeMs < 0;
  return {
    text: `${faster ? '' : '+'}${changeMs}ms vs previous`,
    direction: faster ? 'up' : 'down',
  };
}

/**
 * The four Overview tiles.
 *
 * Four, not the design's five: the base URL is a full-width row above these
 * rather than a tile, because the design renders it *both* as a tile and inside
 * its Environment card, and one copy is enough.
 */
export function toProjectStatTiles(view: ProjectMetricsView): StatTile[] {
  const { requests, endpoints } = view;

  return [
    {
      label: 'Endpoints',
      value: String(endpoints.total),
      // The design shows "+2 this week" here. Endpoint-count history is not
      // stored anywhere, so that delta is not derivable — the entity count is
      // real and more useful than a fabricated trend.
      hint: `${endpoints.entities} ${endpoints.entities === 1 ? 'entity' : 'entities'}`,
    },
    {
      label: 'Requests',
      value: formatCompact(requests.total),
      hint: `last ${view.window.days} days`,
      delta: signedPercent(requests.changePercent),
    },
    {
      label: 'Success rate',
      // Null when there was no traffic: there is no rate over zero requests, and
      // `0%` would read as "everything failed".
      value: requests.successRate === null ? NO_VALUE : `${requests.successRate}%`,
      hint:
        requests.clientErrorRate === null
          ? 'no requests yet'
          : // 4xx is reported separately, not as failure — the runtime returns it
            // by design for an unselected method or a failed validation rule.
            `${requests.clientErrorRate}% client errors`,
    },
    {
      label: 'Avg response',
      value: requests.avgDurationMs === null ? NO_VALUE : `${requests.avgDurationMs}ms`,
      hint: durationHint(requests),
      delta: durationDelta(requests.durationChangeMs),
    },
  ];
}

/** The requests chart's points. */
export function toRequestPoints(view: ProjectMetricsView): ChartPoint[] {
  return view.requests.series.map((bucket) => ({
    // Day and month only: a 30-day axis cannot fit full dates, and the year is
    // never in question inside a 30-day window.
    label: bucket.date.slice(5),
    value: bucket.count,
  }));
}

/**
 * Bridge two names for the same thing.
 *
 * `EndpointRow.target` in the shared endpoint list calls a single-record URL
 * `'item'`; `ApiLog.shape`, which comes from the runtime's `HostedTarget.kind`,
 * calls it `'record'`. `'index'` and `'collection'` agree.
 *
 * Without this mapping the join silently misses **every** record endpoint — the
 * lookup just never matches, so `GET /customer/{id}` renders as orphaned with a
 * fallback path, which looks like data rather than a bug. Worth a named function
 * so the mismatch is documented at the one place it matters.
 */
function shapeOfTarget(target: 'index' | 'collection' | 'item'): ApiLogShape {
  return target === 'item' ? 'record' : target;
}

export interface EndpointRowView {
  key: string;
  method: string;
  /** Rebuilt from the *current* schema where possible. */
  path: string;
  count: number;
  avgDurationMs: number | null;
  /** True when the endpoint no longer exists in the project's schema. */
  orphaned: boolean;
}

/**
 * Join recorded traffic onto the project's current endpoints.
 *
 * The API returns `(method, entity, shape)` triples rather than paths, precisely
 * so the display path can be rebuilt here from the live schema — an entity whose
 * identity field was renamed since the traffic still renders with its *current*
 * path, instead of a stale template frozen at log time.
 *
 * An entity that has since been **deleted** has no current path at all. Those
 * rows are kept and marked `orphaned` rather than dropped: the requests happened,
 * they are in the total, and silently omitting them would make the breakdown fail
 * to add up.
 */
export function toEndpointRows(
  usage: readonly EndpointUsage[],
  entities: readonly IpsEntity[],
  methods: readonly string[],
): EndpointRowView[] {
  // One lookup keyed on (method, entity, shape) built from the schema, so the
  // join is linear rather than a nested scan per usage row.
  //
  // Keyed on the *log's* vocabulary, not the endpoint list's — see
  // `shapeOfTarget`.
  const paths = new Map<string, string>();
  for (const entity of entities) {
    for (const row of entityEndpoints(entity, methods)) {
      paths.set(
        `${row.method}|${entity.name.toLowerCase()}|${shapeOfTarget(row.target)}`,
        row.path,
      );
    }
  }

  return usage.map((row) => {
    const key = `${row.method}|${row.entity ?? ''}|${row.shape ?? ''}`;
    // The discovery document belongs to no entity, so it is not in the map.
    const known = row.entity === null && row.shape === 'index' ? '/' : paths.get(key);
    return {
      key,
      method: row.method,
      // Falls back to the recorded entity name, so an orphaned row is still
      // identifiable rather than blank.
      path: known ?? `/${row.entity ?? '?'}`,
      count: row.count,
      avgDurationMs: row.avgDurationMs,
      orphaned: known === undefined,
    };
  });
}

/**
 * Bar widths for the Top Endpoints panel, as a fraction of the busiest.
 *
 * Relative to the maximum rather than to the total: with twenty endpoints every
 * share-of-total bar would be a sliver, and the question the panel answers is
 * "which is busiest", not "what proportion".
 */
export function toEndpointBars(
  rows: readonly EndpointRowView[],
  limit = 5,
): (EndpointRowView & { fraction: number })[] {
  const top = [...rows].sort((a, b) => b.count - a.count).slice(0, limit);
  const max = top[0]?.count ?? 0;
  return top.map((row) => ({
    ...row,
    // Guarded: every count being zero would divide by zero. It cannot happen with
    // real data, but a zero-width bar is the right answer if it did.
    fraction: max > 0 ? row.count / max : 0,
  }));
}

/** Endpoint total from the schema, for screens with no metrics loaded yet. */
export function endpointTotal(entities: readonly IpsEntity[], methods: readonly string[]): number {
  return countEndpoints(entities, methods);
}
