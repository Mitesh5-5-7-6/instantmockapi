'use client';

/**
 * Recent Activity.
 *
 * Derived from project creation, version notes and failed jobs — there is no
 * event log, so the feed reports what the existing records can actually
 * evidence. Notably absent: "endpoint added", which would need two IPS snapshots
 * diffed, and a PATCH bumps the version without writing a snapshot at all.
 */

import { Card, EmptyState } from '@instantmockapi/ui';
import type { ActivityEvent } from '../../lib/api-types';
import { ActivityRow } from './activity-row';

export function RecentActivityCard({ activity }: { activity: ActivityEvent[] }) {
  return (
    <Card className="ui-stack">
      <h2>Recent Activity</h2>
      {activity.length === 0 ? (
        <EmptyState title="Nothing yet">
          Creating a project or generating artifacts shows up here.
        </EmptyState>
      ) : (
        <div>
          {activity.map((event) => (
            <ActivityRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </Card>
  );
}
