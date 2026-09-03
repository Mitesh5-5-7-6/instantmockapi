'use client';

/**
 * The Activity tab: version history and what has happened to the project.
 *
 * Distinct from Logs, and the distinction is the point — Activity is what *you*
 * did to the project, Logs is what *callers* did to its API. Merging them would
 * interleave "v3 generated" with 5,000 request rows.
 */

import { useParams } from 'next/navigation';
import { Button, Card, EmptyState, ListRow } from '@instantmockapi/ui';
import {
  useProject,
  useProjectMetrics,
  useRestoreVersion,
  useVersions,
} from '../../../../lib/hooks';
import { useAction } from '../../../../lib/use-action';
import { ActivityRow } from '../../../../components/dashboard/activity-row';

export default function ActivityPage() {
  const { id } = useParams<{ id: string }>();
  const project = useProject(id);
  const versions = useVersions(id);
  const restore = useAction(useRestoreVersion(id), {
    success: (_data: unknown, version: number) => `Restored v${version}`,
  });
  // A generous limit here: this is the screen where the full feed belongs, unlike
  // the Overview card which shows the most recent few.
  const metrics = useProjectMetrics(id, 30, 20);

  const rows = versions.data?.data ?? [];
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
            Each generation snapshots the schema and configuration. Restoring one makes it current
            without deleting anything newer.
          </p>
        </div>
        {rows.length === 0 ? (
          <EmptyState title="No snapshots yet">Versions appear here when you generate.</EmptyState>
        ) : (
          <div>
            {rows.map((version) => {
              const isCurrent = version.version === project.data?.currentVersion;
              return (
                <ListRow
                  key={version.id}
                  title={<span className="ui-mono">v{version.version}</span>}
                  meta={
                    <>
                      {version.note ? `${version.note} · ` : ''}
                      {new Date(version.createdAt).toLocaleString()}
                    </>
                  }
                  trailing={
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={restore.isPending || isCurrent}
                      onClick={() => void restore.run(version.version)}
                    >
                      {isCurrent ? 'Current' : 'Restore'}
                    </Button>
                  }
                />
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
