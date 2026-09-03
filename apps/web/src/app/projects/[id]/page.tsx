'use client';

/**
 * The Overview tab.
 *
 * Replaces the old flat-scrolling project page, whose content is now spread across
 * the workspace tabs — artifacts to Files, versions to Activity, the schema modal
 * to Schema, the playground to Mock Data. What is left here is the summary: where
 * the API lives, how much it is being used, and what to look at next.
 *
 * Two requests: the project (shared with the layout via the `['project', id]` key)
 * and its metrics. Nothing else, so switching to this tab does not pull artifacts
 * and versions it will not render.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Button,
  Card,
  EmptyState,
  MethodBadge,
  Note,
  Select,
  Stat,
  type ApiMethod,
} from '@instantmockapi/ui';
import { useGenerate, useProject, useProjectMetrics, type MetricsDays } from '../../../lib/hooks';
import { useAction } from '../../../lib/use-action';
import { projectEndpoints, type IpsEntity } from '../../../lib/endpoints';
import { toEndpointRows, toProjectStatTiles, toRequestPoints } from '../../../lib/project-metrics';
import { formatCompact } from '../../../lib/area-chart';
import { HostedApiCard } from '../../../components/project/hosted-api-card';
import { TopEndpointsCard } from '../../../components/project/top-endpoints-card';
import { RequestsChart } from '../../../components/dashboard/requests-chart';
import { ActivityRow } from '../../../components/dashboard/activity-row';

/** Windows the metrics endpoint accepts — capped by the log's 30-day retention. */
const WINDOWS: { value: MetricsDays; label: string }[] = [
  { value: 7, label: 'Last 7 days' },
  { value: 14, label: 'Last 14 days' },
  { value: 30, label: 'Last 30 days' },
];

/** How many endpoints the Overview lists before deferring to the APIs tab. */
const ENDPOINT_PREVIEW = 5;

export default function ProjectOverviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [days, setDays] = useState<MetricsDays>(7);

  const project = useProject(id);
  const metrics = useProjectMetrics(id, days);
  const generate = useAction(useGenerate(id), { success: 'Generation started' });

  if (!project.data) {
    return <div className="ui-skeleton" style={{ minHeight: 320 }} />;
  }

  const detail = project.data;
  const entities = ((detail.ips as { entities?: IpsEntity[] })?.entities ?? []) as IpsEntity[];
  const methods = detail.generationConfig.methods;
  const view = metrics.data;

  // Derived from the schema, so the endpoint list is complete before any traffic
  // exists — request counts are then layered on where there are any.
  const allEndpoints = projectEndpoints(entities, methods);
  const usageRows = view ? toEndpointRows(view.topEndpoints, entities, methods) : [];
  const countByKey = new Map(usageRows.map((row) => [`${row.method}|${row.path}`, row.count]));

  return (
    <div className="ui-stack">
      {detail.status === 'expired' ? (
        <Card className="ui-stack">
          <h2>Hosting expired</h2>
          <p className="ui-meta">
            The hosted mock API and generated files were cleaned up on schedule. The schema and
            configuration are intact — regenerate to bring everything back under a fresh version.
          </p>
          <div className="ui-row">
            <Button
              disabled={generate.isPending}
              onClick={() =>
                void generate.run(undefined).then((job) => {
                  if (job !== null) {
                    router.push(`/projects/${id}/progress/${job.jobId}`);
                  }
                })
              }
            >
              {generate.isPending ? 'Starting…' : 'Generate again'}
            </Button>
          </div>
        </Card>
      ) : (
        <HostedApiCard
          detail={detail}
          generating={generate.isPending}
          onGenerate={() =>
            void generate.run(undefined).then((job) => {
              if (job !== null) {
                router.push(`/projects/${id}/progress/${job.jobId}`);
              }
            })
          }
        />
      )}

      {/* Four tiles, not the design's five — the base URL is the card above rather
          than a tile repeated inside it. */}
      <div className="ui-stats">
        {view ? (
          toProjectStatTiles(view).map((tile) => (
            <Stat
              key={tile.label}
              label={tile.label}
              value={tile.value}
              // `hint` carries the caveats — which requests were timed, why a
              // rate is absent — so they sit with the figure they qualify.
              {...(tile.hint !== undefined ? { hint: tile.hint } : {})}
              {...(tile.delta ? { delta: tile.delta } : {})}
            />
          ))
        ) : (
          <>
            {[0, 1, 2, 3].map((slot) => (
              <div key={slot} className="ui-skeleton" style={{ minHeight: 96 }} />
            ))}
          </>
        )}
      </div>

      <div className="project-overview-grid">
        <div className="ui-stack">
          <Card className="ui-stack">
            <div className="ui-row ui-row--between">
              <h2>Requests</h2>
              <Select
                aria-label="Time window"
                value={String(days)}
                onChange={(event) => setDays(Number(event.target.value) as MetricsDays)}
              >
                {WINDOWS.map((window) => (
                  <option key={window.value} value={window.value}>
                    {window.label}
                  </option>
                ))}
              </Select>
            </div>
            {view ? (
              <RequestsChart points={toRequestPoints(view)} unit="requests" />
            ) : (
              <div className="ui-skeleton" style={{ minHeight: 220 }} />
            )}
          </Card>

          <Card className="ui-stack">
            <div className="ui-row ui-row--between">
              <h2>Endpoints</h2>
              {/*
                Two links, because they answer two different thoughts. Endpoints
                are derived from entities × selected methods and are never added
                one at a time, so "looking at this list, something is wrong" leads
                to the data model — and the Overview tab is where most people
                first read that list.
              */}
              <span className="ui-row" style={{ gap: 'var(--space-4)' }}>
                <Link href={`/projects/${id}/edit`}>Edit data model →</Link>
                <Link href={`/projects/${id}/apis`}>View all APIs →</Link>
              </span>
            </div>

            {allEndpoints.length === 0 ? (
              <EmptyState title="No endpoints yet">
                <p className="ui-meta">
                  Endpoints come from your entities and the HTTP methods you select.
                </p>
                <Link className="ui-btn" href={`/projects/${id}/edit`}>
                  Edit data model
                </Link>
              </EmptyState>
            ) : (
              <table className="endpoint-table">
                <thead>
                  <tr>
                    <th scope="col">Method</th>
                    <th scope="col">Endpoint</th>
                    <th scope="col" className="endpoint-table__num">
                      Requests
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {allEndpoints.slice(0, ENDPOINT_PREVIEW).map((endpoint) => {
                    const count = countByKey.get(`${endpoint.method}|${endpoint.path || '/'}`);
                    return (
                      <tr key={`${endpoint.method}|${endpoint.path}`}>
                        <td>
                          <MethodBadge method={endpoint.method as ApiMethod} />
                        </td>
                        <td>
                          <code>{endpoint.path || '/'}</code>
                        </td>
                        {/* A dash, not 0: with no metrics loaded the count is
                            unknown, and an endpoint with genuinely no traffic in
                            the window reads the same way — either is honest, and
                            neither is "zero requests, definitively". */}
                        <td className="endpoint-table__num">
                          {count === undefined ? '—' : formatCompact(count)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {allEndpoints.length > ENDPOINT_PREVIEW ? (
              <p className="ui-meta">
                Showing {ENDPOINT_PREVIEW} of {allEndpoints.length}.{' '}
                <Link href={`/projects/${id}/apis`}>See them all</Link>, or{' '}
                <Link href={`/projects/${id}/logs`}>read the request log</Link>.
              </p>
            ) : null}
          </Card>
        </div>

        <div className="ui-stack">
          <TopEndpointsCard rows={usageRows} note={view?.endpointNote ?? null} />

          <Card className="ui-stack">
            <div className="ui-row ui-row--between">
              <h2>Activity</h2>
              <Link href={`/projects/${id}/activity`}>View all</Link>
            </div>
            {view && view.activity.length > 0 ? (
              <div>
                {view.activity.slice(0, 5).map((event) => (
                  <ActivityRow key={event.id} event={event} />
                ))}
              </div>
            ) : (
              <EmptyState title="Nothing yet">
                Generating this project records its first event.
              </EmptyState>
            )}
          </Card>

          {/* Stated once, here, rather than beside every figure on the page. */}
          {view ? (
            <Note variant="info">
              Request figures come from hosted-request logs, kept for {view.window.retentionDays}{' '}
              days.
            </Note>
          ) : null}
        </div>
      </div>
    </div>
  );
}
