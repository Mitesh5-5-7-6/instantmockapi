'use client';

/**
 * API Ready (sample design: PROJECT step 6 / SINGLE step 5).
 *
 * The moment generation finishes: what was built, where it lives, and the two
 * things worth doing next. The flow accent comes from the project's own kind, so
 * a Single API reaches this screen in blue and a Project in purple without the
 * route knowing which it is.
 */

import { use } from 'react';
import Link from 'next/link';
import {
  Button,
  Card,
  CodeBlock,
  CountdownBadge,
  FlowScope,
  Stat,
  SuccessMark,
} from '@instantmockapi/ui';
import { useProject } from '../../../../lib/hooks';
import { countEndpoints, type IpsEntity } from '../../../../lib/endpoints';

export default function ReadyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const project = useProject(id);
  const detail = project.data;

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

        <div className="ui-row">
          <Link href={`/projects/${id}/apis`}>
            <Button>{isProject ? 'Explore APIs' : 'Use your API'}</Button>
          </Link>
          <Link href={`/projects/${id}`}>
            <Button variant="secondary">{isProject ? 'Go to Project' : 'Go to Details'}</Button>
          </Link>
        </div>
      </Card>
    </FlowScope>
  );
}
