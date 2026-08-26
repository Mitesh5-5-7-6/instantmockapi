'use client';

/** Recent Projects, with a link through to the full list. */

import Link from 'next/link';
import { Button, Card, EmptyState, Icon } from '@instantmockapi/ui';
import { toRecentProjectRows } from '../../lib/dashboard-metrics';
import type { DashboardView, ProjectSummary } from '../../lib/api-types';
import { ProjectRow } from './project-row';

export function RecentProjectsCard({
  projects,
  view,
}: {
  projects: ProjectSummary[];
  view: DashboardView | undefined;
}) {
  const rows = toRecentProjectRows(projects, view);

  return (
    <Card className="ui-stack">
      <div className="ui-row ui-row--between">
        <h2>Recent Projects</h2>
        <Link href="/projects">
          <Button variant="ghost" size="sm">
            View all <Icon name="chevron-right" size={14} />
          </Button>
        </Link>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No projects yet">
          <p>Paste a JSON sample or build a schema — a working mock API takes minutes.</p>
          <Link href="/new">
            <Button size="sm">Create your first project</Button>
          </Link>
        </EmptyState>
      ) : (
        <div>
          {rows.map((row) => (
            <ProjectRow key={row.id} row={row} />
          ))}
        </div>
      )}
    </Card>
  );
}
