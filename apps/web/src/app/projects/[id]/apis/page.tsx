'use client';

/**
 * The APIs tab — was `/projects/{id}/explore` before the workspace gained tabs.
 *
 * The design draws these as two steps, but in the app they are one question —
 * "which endpoint, and how do I call it?" — so selecting an endpoint reveals its
 * snippet in place. Splitting them across routes would mean navigating away from
 * the list to read the call and back again to pick another.
 */

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, Card, EmptyState, FlowScope, MethodBadge, Badge } from '@instantmockapi/ui';
import { useProject } from '../../../../lib/hooks';
import {
  entityEndpoints,
  projectEndpoints,
  type EndpointRow,
  type IpsEntity,
} from '../../../../lib/endpoints';
import { SnippetTabs } from '../../../../components/snippet-tabs';

export default function ApisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const project = useProject(id);
  const detail = project.data;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const entities = useMemo(
    () => ((detail?.ips as { entities?: IpsEntity[] })?.entities ?? []) as IpsEntity[],
    [detail],
  );
  const methods = detail?.generationConfig?.methods ?? [];
  const rows = useMemo(() => projectEndpoints(entities, methods), [entities, methods]);

  const keyOf = (row: EndpointRow): string => `${row.method} ${row.path}`;
  // Defaults to the discovery document: it needs no id and no body, so it is
  // the one call that always works on a fresh project.
  const selected = rows.find((row) => keyOf(row) === selectedKey) ?? rows[0];

  if (!detail) {
    return <div className="ui-skeleton" />;
  }

  const isProject = detail.kind !== 'single';
  const baseUrl = detail.hosted.url;
  const entityOf = (row: EndpointRow): IpsEntity | undefined =>
    entities.find((entity) => entity.name === row.entity);

  if (!baseUrl) {
    return (
      <EmptyState title="Nothing hosted yet">
        <p className="ui-meta">
          This project has no hosted URL — generate it first, then come back to explore its
          endpoints.
        </p>
        <Link href={`/projects/${id}`}>
          <Button variant="secondary">Go to project</Button>
        </Link>
      </EmptyState>
    );
  }

  return (
    <FlowScope flow={isProject ? 'project' : 'single'}>
      <div className="ui-row ui-row--between">
        <div>
          <h1>{isProject ? 'Explore Project APIs' : 'Use Your API'}</h1>
          <p className="ui-meta ui-mono">{baseUrl}</p>
        </div>
        <Link href={`/projects/${id}`}>
          <Button variant="secondary">Go to project</Button>
        </Link>
      </div>

      <div
        className="ui-row"
        style={{ alignItems: 'flex-start', gap: 'var(--space-4)', flexWrap: 'wrap' }}
      >
        <div className="ui-stack" style={{ flex: '1 1 380px', gap: 'var(--space-4)' }}>
          <Card className="ui-stack">
            <div className="ui-row ui-row--between">
              <h2>{isProject ? 'Available Entities (APIs)' : 'Endpoints'}</h2>
              <span className="ui-meta ui-mono">{rows.length} endpoints</span>
            </div>

            <button
              type="button"
              className="ui-endpoint"
              aria-pressed={selected ? keyOf(selected) === 'GET ' : false}
              onClick={() => setSelectedKey('GET ')}
            >
              <MethodBadge method="GET" />
              <span className="ui-endpoint__path">/</span>
              <span className="ui-meta">Discovery document</span>
            </button>

            {entities.length === 0 ? (
              <p className="ui-meta">This project declares no entities.</p>
            ) : null}

            {entities.map((entity) => {
              const entityRows = entityEndpoints(entity, methods);
              return (
                <div key={entity.name} className="ui-stack" style={{ gap: 'var(--space-2)' }}>
                  <div className="ui-row" style={{ alignItems: 'center' }}>
                    <strong>{entity.name}</strong>
                    <Badge>API</Badge>
                    <div style={{ flex: 1 }} />
                    <span className="ui-meta ui-mono">
                      /{entity.name.toLowerCase()}
                      {(entity.relations?.length ?? 0) > 0
                        ? ` · ${entity.relations?.length} relations`
                        : ''}
                    </span>
                  </div>
                  {entityRows.length === 0 ? (
                    <p className="ui-meta">No methods were selected for this project.</p>
                  ) : null}
                  {entityRows.map((row) => (
                    <button
                      key={keyOf(row)}
                      type="button"
                      className="ui-endpoint"
                      aria-pressed={selected ? keyOf(selected) === keyOf(row) : false}
                      onClick={() => setSelectedKey(keyOf(row))}
                    >
                      <MethodBadge method={row.method} />
                      <span className="ui-endpoint__path">{row.path}</span>
                      <div style={{ flex: 1 }} />
                      <span className="ui-meta">{row.summary}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </Card>
        </div>

        <div style={{ flex: '1 1 380px', position: 'sticky', top: 'var(--space-4)' }}>
          <Card className="ui-stack">
            <h2>Use Your API</h2>
            {selected ? (
              <SnippetTabs
                baseUrl={baseUrl}
                endpoint={selected}
                entity={entityOf(selected)}
                features={detail.generationConfig?.features}
              />
            ) : (
              <p className="ui-meta">Select an endpoint to see how to call it.</p>
            )}
          </Card>
        </div>
      </div>
    </FlowScope>
  );
}
