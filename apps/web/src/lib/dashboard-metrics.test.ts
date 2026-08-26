import { describe, it, expect } from 'vitest';
import {
  NO_VALUE,
  activityIcon,
  summariseRequests,
  toChartPoints,
  toPlanUsage,
  toRecentProjectRows,
  toStatTiles,
} from './dashboard-metrics';
import type { DashboardView, ProjectSummary } from './api-types';

const NOW = new Date('2026-05-18T12:00:00.000Z');

function view(overrides: Partial<DashboardView> = {}): DashboardView {
  return {
    window: {
      days: 7,
      from: '2026-05-12T00:00:00.000Z',
      to: '2026-05-19T00:00:00.000Z',
      tz: 'UTC',
      retentionDays: 30,
    },
    projects: { total: 12, createdInWindow: 2, byStatus: { active: 9, expired: 3 } },
    endpoints: { total: 48, inProjectsCreatedThisMonth: 8 },
    requests: {
      total: 12450,
      previousTotal: 10534,
      changePercent: 18.2,
      successRate: 98.6,
      clientErrorRate: 1,
      serverErrorRate: 0.4,
      avgDurationMs: 120,
      durationSampleCount: 12450,
      series: [
        { date: '2026-05-12', count: 1820, serverErrors: 2, partial: false },
        { date: '2026-05-13', count: 2400, serverErrors: 0, partial: false },
        { date: '2026-05-18', count: 40, serverErrors: 0, partial: true },
      ],
      byProject: { p1: 5200, p2: 2100 },
      note: 'Counted from hosted-request logs, retained 30 days.',
    },
    hosted: { live: 9, total: 12, soonestExpiresAt: '2026-05-19T12:00:00.000Z' },
    plan: {
      tier: 'free',
      projects: { used: 7, limit: 10 },
      concurrentJobs: { used: 0, limit: 1 },
      hostedApiLifetimeDays: 2,
    },
    activity: [],
    ...overrides,
  };
}

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'p1',
    name: 'Student ERP',
    kind: 'project',
    publicId: 'prj_1',
    slug: 'student-erp',
    description: null,
    status: 'active',
    currentVersion: 2,
    inputType: 'builder',
    hosted: { url: 'https://x', expiresAt: null },
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-18T10:00:00.000Z',
    ...overrides,
  } as ProjectSummary;
}

describe('toStatTiles', () => {
  it('produces the four headline tiles', () => {
    const tiles = toStatTiles(view());
    expect(tiles.map((tile) => tile.key)).toEqual(['projects', 'endpoints', 'requests', 'hosted']);
    expect(tiles.map((tile) => tile.value)).toEqual(['12', '48', '12.45K', '9 of 12']);
  });

  it('labels the requests tile with its window, not as a lifetime total', () => {
    // Request logs are retained 30 days and deleted when a project expires, so
    // "Total Requests" would be a claim the data cannot support.
    expect(toStatTiles(view())[2]?.label).toBe('Requests · last 7 days');
    expect(toStatTiles(view({ window: { ...view().window, days: 30 } }))[2]?.label).toBe(
      'Requests · last 30 days',
    );
  });

  it('reports the fourth tile as live hosted APIs, not an uptime percentage', () => {
    // Nothing measures availability, and the request log cannot stand in: its
    // write hook only fires once a project resolves, so an expired project's
    // 404s are invisible to it.
    const hosted = toStatTiles(view())[3];
    expect(hosted?.label).toBe('Hosted APIs live');
    expect(hosted?.value).toBe('9 of 12');
  });

  it('compares against the previous window rather than a calendar month', () => {
    expect(toStatTiles(view())[2]?.delta).toEqual({
      text: '18.2% vs previous 7 days',
      direction: 'up',
    });
  });

  it('marks a decrease as down', () => {
    const dropped = view({ requests: { ...view().requests, changePercent: -12.5 } });
    expect(toStatTiles(dropped)[2]?.delta).toEqual({
      text: '12.5% vs previous 7 days',
      direction: 'down',
    });
  });

  it('says "new" rather than a percentage when there is nothing to compare to', () => {
    // The alternative is +100% or +∞%, both of which are inventions.
    const fresh = view({ requests: { ...view().requests, changePercent: null } });
    expect(toStatTiles(fresh)[2]?.delta).toEqual({ text: 'new in the last 7 days' });
    expect(toStatTiles(fresh)[2]?.delta?.direction).toBeUndefined();
  });

  it('distinguishes no change from no data', () => {
    const flat = view({ requests: { ...view().requests, changePercent: 0 } });
    expect(toStatTiles(flat)[2]?.delta?.text).toBe('no change vs previous 7 days');
  });

  it('omits a delta entirely when the count is zero', () => {
    const empty = view({ projects: { total: 0, createdInWindow: 0, byStatus: {} } });
    expect(toStatTiles(empty)[0]?.delta).toBeUndefined();
  });
});

describe('summariseRequests', () => {
  it('produces the four figures under the chart', () => {
    const items = summariseRequests(view());
    expect(items.map((item) => item.key)).toEqual(['total', 'success', 'duration', 'errors']);
    expect(items.map((item) => item.value)).toEqual(['12.45K', '98.6%', '120ms', '0.4%']);
  });

  it('says the success rate counts 5xx only', () => {
    // A deliberate definition, not an oversight: the runtime returns 405 for an
    // unselected method and 422 for the user's own validation rules.
    expect(summariseRequests(view())[1]?.hint).toBe('5xx only');
    expect(summariseRequests(view())[3]?.hint).toBe('1% client (4xx)');
  });

  it('renders an em-dash, never 0%, when a rate has no denominator', () => {
    const quiet = view({
      requests: {
        ...view().requests,
        total: 0,
        successRate: null,
        serverErrorRate: null,
        clientErrorRate: null,
        avgDurationMs: null,
        durationSampleCount: 0,
      },
    });
    const items = summariseRequests(quiet);
    expect(items[1]?.value).toBe(NO_VALUE);
    expect(items[3]?.value).toBe(NO_VALUE);
    expect(items[3]?.hint).toBeUndefined();
  });

  it('renders an em-dash for duration before any timing data exists', () => {
    // 0ms would read as an impossibly fast API. durationMs cannot be backfilled,
    // so this state lasts until traffic accrues after the field shipped.
    const untimed = view({
      requests: { ...view().requests, avgDurationMs: null, durationSampleCount: 0 },
    });
    expect(summariseRequests(untimed)[2]).toMatchObject({
      value: NO_VALUE,
      hint: 'no timing data yet',
    });
  });

  it('says how thin the duration sample is when only some rows are timed', () => {
    const partial = view({
      requests: { ...view().requests, total: 12450, durationSampleCount: 3000 },
    });
    expect(summariseRequests(partial)[2]?.hint).toBe('3K of 12.45K timed');
  });

  it('adds no sample hint once every row is timed', () => {
    expect(summariseRequests(view())[2]?.hint).toBeUndefined();
  });
});

describe('toRecentProjectRows', () => {
  it('builds a row per project with relative time', () => {
    const rows = toRecentProjectRows([project()], view(), NOW);
    expect(rows[0]).toMatchObject({
      id: 'p1',
      name: 'Student ERP',
      meta: 'v2 · updated 2h ago',
      requests: '5.2K',
    });
  });

  it('maps expired to Inactive, the state the design names', () => {
    // There is no `inactive` status in the system; the four are draft,
    // generating, active, expired.
    const rows = toRecentProjectRows([project({ status: 'expired' })], view(), NOW);
    expect(rows[0]?.statusLabel).toBe('Inactive');
    expect(rows[0]?.status).toBe('expired');
  });

  it('leaves other statuses untouched', () => {
    expect(toRecentProjectRows([project({ status: 'draft' })], view(), NOW)[0]?.statusLabel).toBe(
      'draft',
    );
  });

  it('shows an em-dash, not 0, for a project with no counted requests', () => {
    // Absent from byProject means "no rows in the window", but with no payload at
    // all we do not know the count — and "0 requests" would be a claim.
    const unknown = toRecentProjectRows([project({ id: 'p9' })], view(), NOW);
    expect(unknown[0]?.requests).toBe(NO_VALUE);
    const noPayload = toRecentProjectRows([project()], undefined, NOW);
    expect(noPayload[0]?.requests).toBe(NO_VALUE);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 9 }, (_unused, index) =>
      project({ id: `p${index}`, name: `P${index}` }),
    );
    expect(toRecentProjectRows(many, view(), NOW)).toHaveLength(4);
    expect(toRecentProjectRows(many, view(), NOW, 2)).toHaveLength(2);
  });
});

describe('toPlanUsage', () => {
  it('meters projects against the limit the API actually enforces', () => {
    // The mockup's "12,450 / 50,000 requests per month" has no denominator
    // anywhere in the system; maxProjects is enforced on create.
    expect(toPlanUsage(view())).toEqual({
      label: 'Projects',
      used: 7,
      limit: 10,
      percent: 70,
      detail: '7 / 10',
    });
  });

  it('reads a null limit as unlimited rather than as zero', () => {
    // Enterprise carries two different "unlimited" sentinels server-side, both
    // normalised to null — so a 0/0 meter must not appear here.
    const enterprise = view({
      plan: { ...view().plan, tier: 'enterprise', projects: { used: 40, limit: null } },
    });
    expect(toPlanUsage(enterprise)).toMatchObject({ percent: 0, detail: '40 · unlimited' });
  });

  it('caps the bar at 100% rather than overflowing it', () => {
    const over = view({ plan: { ...view().plan, projects: { used: 15, limit: 10 } } });
    expect(toPlanUsage(over).percent).toBe(100);
  });
});

describe('toChartPoints', () => {
  it('labels buckets for the axis and keeps the counts', () => {
    const points = toChartPoints(view());
    expect(points).toHaveLength(3);
    expect(points.map((point) => point.value)).toEqual([1820, 2400, 40]);
    // Formatted in UTC so the label matches the bucket the server computed.
    expect(points[0]?.label).toMatch(/12/);
  });
});

describe('activityIcon', () => {
  it('gives every activity kind an icon and a tone', () => {
    for (const type of [
      'project.created',
      'project.imported',
      'project.built',
      'version.generated',
      'job.failed',
    ] as const) {
      const mapped = activityIcon(type);
      expect(mapped.icon.length).toBeGreaterThan(0);
      expect(mapped.tone.length).toBeGreaterThan(0);
    }
  });

  it('marks a failure with the error tone', () => {
    expect(activityIcon('job.failed').tone).toBe('error');
  });
});
