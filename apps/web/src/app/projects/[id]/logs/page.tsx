'use client';

/**
 * The Logs tab: individual requests to the hosted API.
 *
 * The counterpart to Overview's aggregates. This is where `ApiLog.path` earns its
 * keep — it stores the URL exactly as called, query string and record id
 * included, which is useless for counting endpoints and precisely what you want
 * when the question is "did my request arrive, and what did it get back".
 */

import { Fragment, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  Button,
  Card,
  EmptyState,
  Icon,
  Input,
  MethodBadge,
  Note,
  Select,
  type ApiMethod,
} from '@instantmockapi/ui';
import { useProject, useProjectLogs } from '../../../../lib/hooks';
import {
  buildSnippet,
  endpointUrl,
  projectEndpoints,
  type IpsEntity,
} from '../../../../lib/endpoints';
import type { ApiLogRow, LogStatusClass } from '../../../../lib/api-types';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const STATUS_CLASSES: LogStatusClass[] = ['2xx', '3xx', '4xx', '5xx'];
const WINDOWS = [
  { value: 1, label: 'Last 24 hours' },
  { value: 7, label: 'Last 7 days' },
  { value: 14, label: 'Last 14 days' },
  { value: 30, label: 'Last 30 days' },
];

const PAGE_SIZE = 50;
/** Matches the `useJob` precedent rather than introducing SSE for a table. */
const POLL_MS = 5000;

/** 2xx green, 4xx amber, 5xx red — the class, not the exact code. */
function statusTone(status: number): string {
  if (status >= 500) {
    return 'error';
  }
  if (status >= 400) {
    return 'warning';
  }
  return 'success';
}

function LogDetail({ row }: { row: ApiLogRow }) {
  return (
    <dl className="log-detail">
      <div>
        <dt>Path</dt>
        {/* The full value, unwrapped — the row above truncates it. */}
        <dd className="ui-mono log-detail__path">{row.path}</dd>
      </div>
      <div>
        <dt>Endpoint</dt>
        <dd>
          {row.entity === null && row.shape === null ? (
            // Both null means the request found the project but no entity — a 404
            // — or predates per-endpoint attribution. Either way there is nothing
            // to attribute it to, and saying so beats an empty cell.
            <span className="ui-meta">not attributed</span>
          ) : (
            <span className="ui-mono">
              {row.entity ?? 'discovery'} · {row.shape ?? '—'}
            </span>
          )}
        </dd>
      </div>
      <div>
        <dt>Caller</dt>
        <dd className="ui-mono">{row.ip ?? <span className="ui-meta">not recorded</span>}</dd>
      </div>
      <div>
        <dt>User agent</dt>
        <dd className="ui-mono log-detail__ua">
          {row.userAgent ?? <span className="ui-meta">not recorded</span>}
        </dd>
      </div>
    </dl>
  );
}

export default function LogsPage() {
  const { id } = useParams<{ id: string }>();
  const project = useProject(id);

  const [page, setPage] = useState(1);
  const [days, setDays] = useState(7);
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [live, setLive] = useState(true);

  const filtered = method !== '' || status !== '' || q !== '';
  const logs = useProjectLogs(
    id,
    {
      page,
      limit: PAGE_SIZE,
      days,
      ...(method !== '' ? { method } : {}),
      ...(status !== '' ? { status: status as LogStatusClass } : {}),
      ...(q !== '' ? { q } : {}),
    },
    // Paused while filtered or off the first page: a list that reshuffles under
    // you while you are reading it is worse than a stale one.
    { refetchInterval: live && !filtered && page === 1 ? POLL_MS : false },
  );

  const rows = logs.data?.data ?? [];
  const meta = logs.data?.meta;
  const pages = meta ? Math.max(1, Math.ceil(meta.total / meta.limit)) : 1;

  /** Any filter change returns to page 1 — page 4 of a new filter is meaningless. */
  const reset =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      setPage(1);
    };

  const detail = project.data;
  const entities = ((detail?.ips as { entities?: IpsEntity[] })?.entities ?? []) as IpsEntity[];
  /**
   * A real endpoint from the schema for the empty state’s example call.
   *
   * Built through `projectEndpoints` rather than hand-assembled, so the URL is
   * the one the runtime actually serves — including the identity style, which
   * decides whether a record path samples `1` or a uuid.
   */
  const sampleEndpoint = detail?.hosted.url
    ? projectEndpoints(entities, detail.generationConfig.methods).find(
        (row) => row.target === 'collection',
      )
    : undefined;

  return (
    <div className="ui-stack">
      <Card className="ui-stack">
        <div className="ui-row ui-row--between">
          <div>
            <h2>Request log</h2>
            <p className="ui-meta">
              Every request to this project&rsquo;s hosted API, newest first.
            </p>
          </div>
          <Button
            variant={live ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={live}
            onClick={() => setLive((current) => !current)}
            // Explains itself when the toggle is on but polling is suspended,
            // rather than appearing broken.
            title={
              filtered || page > 1
                ? 'Auto-refresh pauses while filtered or paging'
                : 'Refresh every 5 seconds'
            }
          >
            <Icon name="refresh" size={14} />
            {live ? (filtered || page > 1 ? 'Auto-refresh paused' : 'Live') : 'Paused'}
          </Button>
        </div>

        <div className="log-filters">
          <Select
            aria-label="Time window"
            value={String(days)}
            onChange={(event) => reset(setDays)(Number(event.target.value))}
          >
            {WINDOWS.map((window) => (
              <option key={window.value} value={window.value}>
                {window.label}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Method"
            value={method}
            onChange={(event) => reset(setMethod)(event.target.value)}
          >
            <option value="">All methods</option>
            {METHODS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Status"
            value={status}
            onChange={(event) => reset(setStatus)(event.target.value)}
          >
            <option value="">All statuses</option>
            {STATUS_CLASSES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </Select>
          <Input
            aria-label="Filter by path prefix"
            placeholder="/customer"
            value={q}
            onChange={(event) => reset(setQ)(event.target.value)}
          />
        </div>

        {logs.isLoading ? <div className="ui-skeleton" style={{ minHeight: 240 }} /> : null}

        {logs.data && rows.length === 0 ? (
          <EmptyState title={filtered ? 'Nothing matches those filters' : 'No requests yet'}>
            {filtered ? (
              'Widen the window or clear a filter.'
            ) : detail?.hosted.url && sampleEndpoint ? (
              <div className="ui-stack" style={{ gap: 'var(--space-3)' }}>
                {/* The empty state does the work: nobody&rsquo;s first visit has
                    traffic, so it shows the call that would fill this table. */}
                <p className="ui-meta">Call your API and requests appear here within seconds.</p>
                <pre className="ui-codeblock">
                  <code>
                    {buildSnippet({
                      language: 'curl',
                      method: sampleEndpoint.method,
                      url: endpointUrl(detail.hosted.url, sampleEndpoint),
                    })}
                  </code>
                </pre>
              </div>
            ) : (
              'Generate and host this project, then call it.'
            )}
          </EmptyState>
        ) : null}

        {rows.length > 0 ? (
          <div className="log-table-wrap">
            <table className="log-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Method</th>
                  <th scope="col">Path</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="log-table__num">
                    Duration
                  </th>
                  <th scope="col">
                    <span className="ui-visually-hidden">Expand</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const open = expanded === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr>
                        <td className="ui-mono">{new Date(row.at).toLocaleTimeString()}</td>
                        <td>
                          <MethodBadge method={row.method as ApiMethod} />
                        </td>
                        <td className="log-table__path">
                          <code title={row.path}>{row.path}</code>
                        </td>
                        <td>
                          <span className={`log-status log-status--${statusTone(row.status)}`}>
                            {row.status}
                          </span>
                        </td>
                        {/* A dash, never `0ms`: rows predating the duration field
                            carry no value, and zero would claim an impossibly
                            fast response. */}
                        <td className="log-table__num ui-mono">
                          {row.durationMs === null ? '—' : `${row.durationMs}ms`}
                        </td>
                        <td>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-expanded={open}
                            aria-label={open ? 'Hide details' : 'Show details'}
                            onClick={() => setExpanded(open ? null : row.id)}
                          >
                            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
                          </Button>
                        </td>
                      </tr>
                      {open ? (
                        <tr>
                          <td colSpan={6}>
                            <LogDetail row={row} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {meta && meta.total > 0 ? (
          <div className="ui-row ui-row--between">
            <span className="ui-meta">
              {(meta.page - 1) * meta.limit + 1}–{Math.min(meta.page * meta.limit, meta.total)} of{' '}
              {meta.total}
            </span>
            <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= pages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      {meta ? (
        <Note variant="info">
          Logs are kept for {meta.retentionDays} days and removed when a project expires or is
          deleted. Caller address, user agent and endpoint attribution were added later, so older
          requests show those as not recorded.
        </Note>
      ) : null}
    </div>
  );
}
