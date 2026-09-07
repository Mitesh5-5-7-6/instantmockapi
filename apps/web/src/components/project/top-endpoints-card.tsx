'use client';

/**
 * Top Endpoints: which endpoints carried the traffic.
 *
 * This panel is the whole reason `ApiLog` gained `entity` and `shape`. Grouping on
 * the stored `path` would give one bucket per record id — `/customer/c-1` and
 * `/customer/c-2` are different strings — so the list would be thousands of rows
 * long and say nothing.
 */

import { Card, EmptyState, MethodBadge, Note, type ApiMethod } from '@instantmockapi/ui';
import { formatCompact } from '../../lib/area-chart';
import { toEndpointBars, type EndpointRowView } from '../../lib/project-metrics';

export function TopEndpointsCard({
  rows,
  note,
}: {
  rows: readonly EndpointRowView[];
  /** Set when some traffic could not be attributed to an endpoint. */
  note: string | null;
}) {
  const bars = toEndpointBars(rows);

  return (
    <Card className="ui-stack">
      <h2>Top endpoints</h2>

      {bars.length === 0 ? (
        <EmptyState title="No endpoint data yet">
          Call your API and the busiest endpoints appear here.
        </EmptyState>
      ) : (
        <ol className="endpoint-bars">
          {bars.map((bar) => (
            <li key={bar.key}>
              <div className="endpoint-bars__label">
                <MethodBadge method={bar.method as ApiMethod} />
                <code title={bar.path}>{bar.path}</code>
                {/* An endpoint the schema no longer has. Shown rather than
                    dropped: the requests are counted in the total above, so
                    hiding them would make the panel fail to add up. */}
                {bar.orphaned ? <span className="endpoint-bars__gone">removed</span> : null}
              </div>
              <div className="endpoint-bars__track" aria-hidden="true">
                <span style={{ width: `${Math.max(bar.fraction * 100, 2)}%` }} />
              </div>
              <span className="endpoint-bars__count">{formatCompact(bar.count)}</span>
            </li>
          ))}
        </ol>
      )}

      {/* The honest footnote: attribution started when logging was extended, so a
          window spanning that date reports fewer endpoint requests than total
          requests. Silence here would read as a miscount. */}
      {note ? <Note variant="info">{note}</Note> : null}
    </Card>
  );
}
