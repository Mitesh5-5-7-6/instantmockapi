'use client';

/**
 * Dashboard.
 *
 * One `GET /v1/dashboard` call feeds the tiles, the chart and the activity feed,
 * so the summary total and the sum of the chart cannot disagree — they are
 * computed from the same matched set server-side. Recent Projects reuses the
 * existing projects query rather than duplicating that data in the payload.
 *
 * The project grid that used to live here now has its own route at `/projects`.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Button, EmptyState, Icon } from '@instantmockapi/ui';
import { useDashboard, useMe, useProjects, type DashboardDays } from '../lib/hooks';
import { StatTiles, StatTilesSkeleton } from '../components/dashboard/stat-tiles';
import { RequestsOverviewCard } from '../components/dashboard/requests-overview-card';
import { RecentProjectsCard } from '../components/dashboard/recent-projects-card';
import { QuickStartCard } from '../components/dashboard/quick-start-card';
import { RecentActivityCard } from '../components/dashboard/recent-activity-card';
import { initialsOf } from '../lib/avatar';

export default function DashboardPage() {
  const [days, setDays] = useState<DashboardDays>(7);
  const dashboard = useDashboard(days);
  const projects = useProjects({ sort: '-updatedAt', limit: 4 });
  const me = useMe();

  // The email local part is the only name the system has today, so the greeting
  // uses initials rather than guessing at a first name — "Welcome back, Info"
  // for info@acme.com is worse than no name at all.
  const greeting = me.data ? `Welcome back, ${initialsOf(me.data.email)}` : 'Welcome back';

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-6)' }}>
      <div className="ui-row ui-row--between">
        <div className="ui-stack" style={{ gap: 'var(--space-1)' }}>
          <h1>{greeting}</h1>
          <p className="ui-meta">Monitor and manage your mock APIs in one place.</p>
        </div>
        <Link href="/new">
          <Button>
            <Icon name="plus" size={16} /> New Project
          </Button>
        </Link>
      </div>

      {dashboard.isError ? (
        <EmptyState title="Couldn't load your dashboard">
          <p className="ui-error">{dashboard.error.message}</p>
          <Button variant="secondary" onClick={() => void dashboard.refetch()}>
            Retry
          </Button>
        </EmptyState>
      ) : null}

      {dashboard.isLoading ? <StatTilesSkeleton /> : null}
      {dashboard.data ? <StatTiles view={dashboard.data} /> : null}

      <div className="dashboard-grid">
        <div className="ui-stack" style={{ gap: 'var(--space-6)' }}>
          <RecentProjectsCard projects={projects.data?.data ?? []} view={dashboard.data} />
          <QuickStartCard />
        </div>

        <div className="ui-stack" style={{ gap: 'var(--space-6)' }}>
          {dashboard.data ? (
            <RequestsOverviewCard view={dashboard.data} days={days} onDaysChange={setDays} />
          ) : (
            <div className="ui-skeleton" style={{ minHeight: 320 }} />
          )}
          <RecentActivityCard activity={dashboard.data?.activity ?? []} />
        </div>
      </div>
    </div>
  );
}
