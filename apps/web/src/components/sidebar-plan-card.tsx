'use client';

/**
 * Plan card at the foot of the sidebar.
 *
 * Meters **projects against the plan's project limit** — the one limit the API
 * actually enforces, on create. The mockup shows requests-per-month, but no such
 * quota exists on any tier, and a meter counting toward a ceiling nothing
 * honours is worse than no meter: people plan around the number.
 *
 * Counted with a `limit: 1` projects query so the sidebar reads `meta.total`
 * without loading a page of rows, and without pulling the dashboard aggregation
 * onto every screen in the app.
 */

import Link from 'next/link';
import { Button, Card, ProgressBar } from '@instantmockapi/ui';
import { toPlanUsage } from '../lib/dashboard-metrics';
import { useMe, useProjects } from '../lib/hooks';

export function SidebarPlanCard() {
  const me = useMe();
  const projects = useProjects({ limit: 1 });

  if (!me.data) {
    return null;
  }

  const usage = toPlanUsage(projects.data?.meta.total ?? 0, me.data.limits.maxProjects);

  return (
    <Card className="ui-stack ui-sidebar__collapsible">
      <div className="ui-row ui-row--between">
        <strong style={{ textTransform: 'capitalize' }}>{me.data.plan} plan</strong>
      </div>

      <div className="ui-stack" style={{ gap: 'var(--space-1)' }}>
        <div className="ui-row ui-row--between">
          <span className="ui-meta">{usage.label}</span>
          <span className="ui-meta ui-mono">{usage.detail}</span>
        </div>
        <ProgressBar percent={usage.percent} />
      </div>

      <span className="ui-meta">
        Hosted APIs last {me.data.limits.hostedApiLifetimeDays} days on this plan.
      </span>

      {/* Points at Settings rather than a checkout: there is no billing
          integration, so a button styled as one would be a dead end. */}
      <Link href="/settings">
        <Button variant="secondary" size="sm">
          View plan
        </Button>
      </Link>
    </Card>
  );
}
