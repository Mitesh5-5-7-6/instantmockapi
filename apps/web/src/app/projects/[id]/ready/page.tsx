'use client';

/**
 * API Ready (sample design: PROJECT step 6 / SINGLE step 5).
 *
 * The moment generation finishes: what was built, where it lives, and the two
 * things worth doing next. The flow accent comes from the project's own kind, so
 * a Single API reaches this screen in blue and a Project in purple without the
 * route knowing which it is.
 */

import { use, useState } from 'react';
import Link from 'next/link';
import {
  Button,
  Card,
  CodeBlock,
  CountdownBadge,
  FlowScope,
  MethodBadge,
  Stat,
  SuccessMark,
} from '@instantmockapi/ui';
import { useProject } from '../../../../lib/hooks';
import {
  countEndpoints,
  entityEndpoints,
  type EndpointRow,
  type IpsEntity,
} from '../../../../lib/endpoints';
import { normalizeError } from '../../../../lib/errors';
import { notifyFailure, notifySuccess } from '../../../../lib/toast';
import { SnippetTabs } from '../../../../components/snippet-tabs';
import { HostedPlayground } from '../../../../components/hosted-playground';

export default function ReadyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const project = useProject(id);
  const detail = project.data;
  // Before the loading return so the hook order never changes between renders.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  if (!detail) {
    return <div className="ui-skeleton" />;
  }

  const entities = ((detail.ips as { entities?: IpsEntity[] })?.entities ?? []) as IpsEntity[];
  const methods = detail.generationConfig?.methods ?? [];
  const isProject = detail.kind !== 'single';
  const relationCount = entities.reduce(
    (total, entity) => total + (entity.relations?.length ?? 0),
    0,
  );

  const hostedUrl = detail.hosted.url;
  const keyOf = (row: EndpointRow): string => `${row.method} ${row.path}`;
  const rows = entities.flatMap((entity) => entityEndpoints(entity, methods));
  const selected = rows.find((row) => keyOf(row) === selectedKey) ?? rows[0];
  // Entity path is `name.toLowerCase()`, as on the Mock Data tab, so the
  // playground hits the routes the runtime serves.
  const playgroundEntities = entities.map((entity) => ({
    name: entity.name,
    path: entity.name.toLowerCase(),
  }));

  // A refused clipboard write must say so; a silent Copy leaves stale content.
  const copyUrl = (url: string): void => {
    navigator.clipboard.writeText(url).then(
      () => notifySuccess('URL copied'),
      (cause: unknown) => notifyFailure(normalizeError(cause)),
    );
  };

  return (
    <FlowScope flow={isProject ? 'project' : 'single'}>
      <Card className="ui-stack">
        <div
          className="ui-stack"
          style={{ alignItems: 'center', gap: 'var(--space-3)', textAlign: 'center' }}
        >
          <SuccessMark />
          <h1>{isProject ? 'Project' : 'Single API'} Generated Successfully!</h1>
          <p className="ui-meta">{detail.name}</p>
        </div>

        <div className="ui-stack" style={{ gap: 'var(--space-2)' }}>
          <div className="ui-row ui-row--between">
            <span className="ui-meta">Base URL</span>
            {detail.hosted.expiresAt ? (
              <CountdownBadge expiresAt={detail.hosted.expiresAt} />
            ) : null}
          </div>
          {detail.hosted.url ? (
            <CodeBlock code={detail.hosted.url} />
          ) : (
            <p className="ui-meta">
              The hosted URL appears once the hosted_api artifact finishes generating.
            </p>
          )}
        </div>

        <div className="ui-stats">
          {/* Counted from the IPS and the selected methods, so the figure matches
              the endpoint list on the Explore screen exactly. */}
          <Stat value={countEndpoints(entities, methods)} label="Total APIs" />
          <Stat value={entities.length} label={isProject ? 'Total Entities' : 'Resources'} />
          {isProject ? <Stat value={relationCount} label="Relationships" /> : null}
          <Stat value={`v${detail.currentVersion}`} label="Version" />
        </div>

        {hostedUrl ? (
          <div className="ui-row" style={{ flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={() => copyUrl(hostedUrl)}>
              Copy URL
            </Button>
            <Button
              variant="secondary"
              onClick={() => window.open(hostedUrl, '_blank', 'noopener,noreferrer')}
            >
              Open API
            </Button>
            <Link href={`/projects/${id}`}>
              <Button variant="secondary">Open dashboard</Button>
            </Link>
          </div>
        ) : null}

        <div className="ui-row">
          <Link href={`/projects/${id}/apis`}>
            <Button>{isProject ? 'Explore APIs' : 'Use your API'}</Button>
          </Link>
          <Link href={`/projects/${id}`}>
            <Button variant="secondary">{isProject ? 'Go to Project' : 'Go to Details'}</Button>
          </Link>
        </div>

        {rows.length > 0 ? (
          <div className="ui-stack">
            <h2>Endpoints</h2>
            <div className="ui-stack" style={{ gap: 'var(--space-1)' }}>
              {rows.map((row) => (
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
            {hostedUrl && selected ? (
              <SnippetTabs
                baseUrl={hostedUrl}
                endpoint={selected}
                entity={entities.find((entity) => entity.name === selected.entity)}
                features={detail.generationConfig?.features}
              />
            ) : null}
          </div>
        ) : null}

        {hostedUrl ? (
          <details>
            <summary>Try it</summary>
            <HostedPlayground baseUrl={hostedUrl} entities={playgroundEntities} methods={methods} />
          </details>
        ) : null}
      </Card>
    </FlowScope>
  );
}
