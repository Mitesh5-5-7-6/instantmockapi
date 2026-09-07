'use client';

/**
 * The chart panel: range selector, the area chart, and the four summary figures.
 *
 * The range selector is a native `<select>`. The design's chevron-in-a-box *is*
 * a styled native select, and a three-option picker with no custom rendering
 * does not justify building a listbox.
 */

import { Card, Note, Select, Stat } from '@instantmockapi/ui';
import { summariseRequests, toChartPoints } from '../../lib/dashboard-metrics';
import type { DashboardView } from '../../lib/api-types';
import type { DashboardDays } from '../../lib/hooks';
import { RequestsChart } from './requests-chart';

export function RequestsOverviewCard({
  view,
  days,
  onDaysChange,
}: {
  view: DashboardView;
  days: DashboardDays;
  onDaysChange: (days: DashboardDays) => void;
}) {
  const summary = summariseRequests(view);

  return (
    <Card className="ui-stack">
      <div className="ui-row ui-row--between">
        <h2>Requests Overview</h2>
        <Select
          value={String(days)}
          aria-label="Time range"
          onChange={(event) => onDaysChange(Number(event.target.value) as DashboardDays)}
        >
          {/* Only windows the 30-day log retention can actually serve — a "last
              90 days" option would return a structurally empty left half. */}
          <option value="7">Last 7 days</option>
          <option value="14">Last 14 days</option>
          <option value="30">Last 30 days</option>
        </Select>
      </div>

      <RequestsChart points={toChartPoints(view)} />

      <div className="ui-stats">
        {summary.map((item) => (
          <Stat
            key={item.key}
            value={item.value}
            label={item.label}
            {...(item.hint ? { hint: item.hint } : {})}
            // A step down from Stat's default figure size. These three sit
            // inside a card that already has its own heading, so the display
            // size the standalone tiles use would out-shout it.
            className="[&>div:first-child]:text-lg"
          />
        ))}
      </div>

      {/* The disclaimer travels with the number from the API, so the label cannot
          drift from what was actually counted. */}
      <Note>{view.requests.note}</Note>
    </Card>
  );
}
