'use client';

/**
 * The Activity tab: what has happened to this project.
 *
 * Distinct from Logs, and the distinction is the point — Activity is what *you*
 * did to the project, Logs is what *callers* did to its API. Merging them would
 * interleave "v3 generated" with 5,000 request rows.
 *
 * **The version list moved to the Versions tab.** It used to live here, and the
 * two are genuinely different questions: this page is a feed of events, while
 * Versions is a list of things you can act on — publish, restore, compare. One
 * list serving both meant the publish action had nowhere sensible to go.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Card, EmptyState, buttonVariants } from '@instantmockapi/ui';
import { useProjectMetrics } from '../../../../lib/hooks';
import { ActivityRow } from '../../../../components/dashboard/activity-row';

export default function ActivityPage() {
  const { id } = useParams<{ id: string }>();
  // A generous limit here: this is the screen where the full feed belongs, unlike
  // the Overview card which shows the most recent few.
  const metrics = useProjectMetrics(id, 30, 20);

  const events = metrics.data?.activity ?? [];

  return (
    <div className="ui-stack">
      <Card className="ui-stack">
        <div>
          <h2>Recent activity</h2>
          <p className="ui-meta">Generations and failures, newest first.</p>
        </div>
        {events.length === 0 ? (
          <EmptyState title="Nothing yet">
            Generating this project will record its first event here.
          </EmptyState>
        ) : (
          <div>
            {events.map((event) => (
              <ActivityRow key={event.id} event={event} />
            ))}
          </div>
        )}
      </Card>

      <Card className="ui-stack">
        <div>
          <h2>Versions</h2>
          <p className="ui-meta">
            Version history, publishing and restore moved to their own tab, where each version can
            carry the actions that belong to it.
          </p>
        </div>
        <div className="ui-row">
          {/* The variant's classes on the link itself — a `Button` nested inside
              an anchor would be a button inside a link. */}
          <Link
            className={buttonVariants({ variant: 'secondary' })}
            href={`/projects/${id}/versions`}
          >
            Open Versions
          </Link>
        </div>
      </Card>
    </div>
  );
}
