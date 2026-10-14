'use client';

import type { Dispatch } from 'react';
import { Card, Checkbox, Field, Input } from '@instantmockapi/ui';
import { entityEndpoints, type IpsEntity } from '../../lib/endpoints';
import type { ReviewAction, ReviewState } from '../../lib/review-state';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Paths are derived by the platform, so they are always valid; only methods and records are editable. */
export function EndpointsSection({
  state,
  dispatch,
}: {
  state: ReviewState;
  dispatch: Dispatch<ReviewAction>;
}) {
  const named = state.entities.filter((entity) => entity.generate && entity.name.trim());
  return (
    <Card className="ui-stack">
      <h2>Generated endpoints</h2>
      <div className="ui-row" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        {METHODS.map((method) => (
          <Checkbox
            key={method}
            label={method}
            checked={state.methods.includes(method)}
            onChange={(checked) =>
              dispatch({
                type: 'methods',
                value: checked
                  ? [...state.methods, method]
                  : state.methods.filter((m) => m !== method),
              })
            }
          />
        ))}
      </div>
      <Field label="Mock records per resource">
        <Input
          type="number"
          min={1}
          max={1000}
          value={state.mockRecords}
          onChange={(e) =>
            dispatch({
              type: 'mockRecords',
              value: Math.max(1, Math.min(1000, Number(e.target.value) || 1)),
            })
          }
        />
      </Field>
      <ul className="ui-stack">
        {named.flatMap((entity) =>
          entityEndpoints(
            { name: entity.name.trim(), fields: [] } as unknown as IpsEntity,
            state.methods,
          ).map((row) => (
            <li key={`${row.method} ${row.path}`}>
              <code>
                {row.method} {row.path}
              </code>
            </li>
          )),
        )}
      </ul>
    </Card>
  );
}
