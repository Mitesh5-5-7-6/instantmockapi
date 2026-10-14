'use client';

import { useMemo, type Dispatch } from 'react';
import { Button, Card, Note } from '@instantmockapi/ui';
import { EntityCard } from '../builder/entity-card';
import { ErDiagram, ErLegend } from '../er-diagram';
import { newEntity } from '../../lib/builder';
import { relationTargets, validateRelations } from '../../lib/relations';
import type { ReviewAction, ReviewState } from '../../lib/review-state';

export function ModelSection({
  state,
  dispatch,
  fieldErrors,
  unmapped,
}: {
  state: ReviewState;
  dispatch: Dispatch<ReviewAction>;
  fieldErrors: ReadonlyMap<string, string[]>;
  unmapped: readonly { path: string; issue: string }[];
}) {
  const single = state.kind === 'single';
  const targets = useMemo(() => relationTargets(state.entities), [state.entities]);
  const issues = useMemo(() => validateRelations(state.entities), [state.entities]);
  return (
    <Card className="ui-stack">
      <h2>{single ? 'Endpoints' : 'Data model'}</h2>
      {/* Note renders a <p>, so one Note per item rather than a list inside it. */}
      {unmapped.map((detail, i) => (
        <Note key={i} variant="warning">
          <code>{detail.path || '(root)'}</code>: {detail.issue}
        </Note>
      ))}
      {single ? null : (
        <>
          <ErDiagram entities={state.entities} />
          <ErLegend />
        </>
      )}
      {state.entities.map((entity) => (
        <EntityCard
          key={entity.id}
          entity={entity}
          targets={targets}
          issues={issues.filter((issue) => issue.entityId === entity.id)}
          removable={state.entities.length > 1}
          onChange={(next) => dispatch({ type: 'entity', id: entity.id, next })}
          onRemove={() => dispatch({ type: 'removeEntity', id: entity.id })}
          showRelations={!single}
          noun={single ? 'endpoint' : 'entity'}
          errors={fieldErrors}
        />
      ))}
      <div className="ui-row">
        <Button
          variant="secondary"
          onClick={() => dispatch({ type: 'addEntity', entity: newEntity() })}
        >
          Add {single ? 'endpoint' : 'entity'}
        </Button>
      </div>
    </Card>
  );
}
