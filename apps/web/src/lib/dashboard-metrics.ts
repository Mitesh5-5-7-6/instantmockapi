/**
 * The dashboard payload turned into view models.
 *
 * This module is where the honesty boundary is **explicit**. Every figure the
 * screen shows comes through a named field here, so a value that cannot be
 * derived has nowhere to hide inside JSX — and removing a tile is deleting a
 * field and a file rather than picking apart markup.
 *
 * Two rules it enforces on the way out:
 *  - a `null` rate renders as an em-dash, never as `0%`;
 *  - a `null` change renders as "new", never as `+100%` or `+∞%`.
 */

import type { IconName, Tone } from '@instantmockapi/ui';
import { formatCompact } from './area-chart';
import { formatAgo } from './relative-time';
import type { DashboardView, ProjectSummary } from './api-types';

/** Placeholder for a figure that genuinely has no value yet. */
export const NO_VALUE = '—';

export interface StatTile {
  key: string;
  label: string;
  value: string;
  icon: IconName;
  tone: Tone;
  delta?: { text: string; direction?: 'up' | 'down' };
}

/**
 * The four headline tiles.
 *
 * The fourth is **hosted APIs live**, not an uptime percentage: nothing in the
 * system measures availability, and the request log cannot stand in for it —
 * its write hook only fires once a project resolves, so an expired project's
 * 404s are invisible to it. It would be blind to exactly the failure it claimed
 * to report, and a project nobody called would read 100%.
 */
export function toStatTiles(view: DashboardView): StatTile[] {
  const { projects, endpoints, requests, hosted, window } = view;

  return [
    {
      key: 'projects',
      label: 'Total Projects',
      value: String(projects.total),
      icon: 'folder',
      tone: 'accent',
      ...(projects.createdInWindow > 0
        ? {
            // "Created this month", not a net change: a hard delete lets a delta
            // and the total contradict each other.
            delta: {
              text: `${projects.createdInWindow} created this month`,
              direction: 'up' as const,
            },
          }
        : {}),
    },
    {
      key: 'endpoints',
      label: 'Total APIs',
      value: String(endpoints.total),
      icon: 'cube',
      tone: 'violet',
      ...(endpoints.inProjectsCreatedThisMonth > 0
        ? {
            delta: {
              text: `${endpoints.inProjectsCreatedThisMonth} in new projects`,
              direction: 'up' as const,
            },
          }
        : {}),
    },
    {
      key: 'requests',
      label: `Requests · last ${window.days} days`,
      value: formatCompact(requests.total),
      icon: 'activity',
      tone: 'success',
      delta: describeChange(requests.changePercent, window.days),
    },
    {
      key: 'hosted',
      label: 'Hosted APIs live',
      value: `${hosted.live} of ${hosted.total}`,
      icon: 'globe',
      tone: 'warning',
      ...(hosted.soonestExpiresAt
        ? { delta: { text: `next expires ${formatAgo(hosted.soonestExpiresAt)}` } }
        : {}),
    },
  ];
}

/**
 * The change line under the requests tile.
 *
 * `null` becomes "new" rather than a percentage. A calendar-month comparison is
 * impossible anyway — the log is retained 30 days, so by late in the month "last
 * month" has aged out entirely — hence the previous *equal-length window*.
 */
function describeChange(
  changePercent: number | null,
  days: number,
): { text: string; direction?: 'up' | 'down' } {
  if (changePercent === null) {
    return { text: `new in the last ${days} days` };
  }
  if (changePercent === 0) {
    return { text: `no change vs previous ${days} days` };
  }
  const direction = changePercent > 0 ? ('up' as const) : ('down' as const);
  return {
    text: `${Math.abs(changePercent)}% vs previous ${days} days`,
    direction,
  };
}

export interface RequestSummaryItem {
  key: string;
  label: string;
  value: string;
  /** Extra context, e.g. how thin the duration sample is. */
  hint?: string;
}

/** The four figures under the chart. */
export function summariseRequests(view: DashboardView): RequestSummaryItem[] {
  const { requests, window } = view;

  return [
    {
      key: 'total',
      label: `Requests (${window.days}d)`,
      value: formatCompact(requests.total),
    },
    {
      key: 'success',
      label: 'Success rate',
      value: percent(requests.successRate),
      // Stated because it is a deliberate definition, not an oversight: the
      // runtime returns 405 for an unselected method and 422 for the user's own
      // validation rules, so counting 4xx as failure would punish correct use.
      hint: '5xx only',
    },
    {
      key: 'duration',
      label: 'Avg server time',
      value: requests.avgDurationMs === null ? NO_VALUE : `${requests.avgDurationMs}ms`,
      ...(requests.avgDurationMs === null
        ? { hint: 'no timing data yet' }
        : requests.durationSampleCount < requests.total
          ? {
              hint: `${formatCompact(requests.durationSampleCount)} of ${formatCompact(requests.total)} timed`,
            }
          : {}),
    },
    {
      key: 'errors',
      label: 'Server errors',
      value: percent(requests.serverErrorRate),
      ...(requests.clientErrorRate !== null
        ? { hint: `${requests.clientErrorRate}% client (4xx)` }
        : {}),
    },
  ];
}

/** A percentage, or an em-dash when there is nothing to divide by. */
function percent(value: number | null): string {
  return value === null ? NO_VALUE : `${value}%`;
}

export interface RecentProjectRow {
  id: string;
  name: string;
  status: string;
  /** `expired` has no chip of its own; the design calls that state Inactive. */
  statusLabel: string;
  meta: string;
  requests: string;
}

/** Recent Projects rows, newest first. */
export function toRecentProjectRows(
  projects: readonly ProjectSummary[],
  view: DashboardView | undefined,
  now: Date = new Date(),
  limit = 4,
): RecentProjectRow[] {
  return projects.slice(0, limit).map((project) => {
    const count = view?.requests.byProject[project.id];
    return {
      id: project.id,
      name: project.name,
      status: project.status,
      statusLabel: project.status === 'expired' ? 'Inactive' : project.status,
      meta: `v${project.currentVersion} · updated ${formatAgo(project.updatedAt, now)}`,
      // An em-dash rather than 0: with no dashboard payload loaded we do not
      // know the count, and "0 requests" would be a claim we cannot make.
      requests: count === undefined ? NO_VALUE : formatCompact(count),
    };
  });
}

export interface PlanUsage {
  label: string;
  used: number;
  limit: number | null;
  percent: number;
  detail: string;
}

/**
 * The sidebar meter.
 *
 * Shows **projects against the plan's project limit** — the one limit the API
 * actually enforces. The mockup's "12,450 / 50,000 requests per month" has no
 * denominator anywhere in the system, and shipping an unenforced quota is worse
 * than shipping none: people plan around a number nothing honours.
 */
export function toPlanUsage(view: DashboardView): PlanUsage {
  const { used, limit } = view.plan.projects;
  return {
    label: 'Projects',
    used,
    limit,
    percent: limit === null || limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100)),
    detail: limit === null ? `${used} · unlimited` : `${used} / ${limit}`,
  };
}

/** Chart input: the series, labelled by day-of-month. */
export function toChartPoints(view: DashboardView): { label: string; value: number }[] {
  return view.requests.series.map((bucket) => ({
    // `2026-05-18` → `May 18`, which is what the axis has room for.
    label: new Date(`${bucket.date}T00:00:00Z`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }),
    value: bucket.count,
  }));
}

/** Icon and tone per activity kind. */
export function activityIcon(type: DashboardView['activity'][number]['type']): {
  icon: IconName;
  tone: Tone;
} {
  switch (type) {
    case 'project.imported':
      return { icon: 'cloud-upload', tone: 'cyan' };
    case 'project.built':
      return { icon: 'code', tone: 'violet' };
    case 'version.generated':
      return { icon: 'cube', tone: 'success' };
    case 'job.failed':
      return { icon: 'x', tone: 'error' };
    default:
      return { icon: 'plus', tone: 'accent' };
  }
}
