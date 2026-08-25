'use client';

/**
 * One endpoint in the Single API flow's Define Endpoints step.
 *
 * Presents an entity as an endpoint: the name is shown as the URL segment it
 * becomes, because that is the thing the author is really choosing — calling it
 * "entity name" would hide that renaming it changes the route.
 */

import { Button, Card, Field, Input, MethodBadge } from '@instantmockapi/ui';
import { newField } from '../../lib/builder';
import { endpointPath, type EndpointIssue, type SingleEndpoint } from '../../lib/single-api';
import { FieldRow } from './field-row';

export function EndpointCard({
  endpoint,
  basePath,
  issues,
  removable,
  onChange,
  onRemove,
}: {
  endpoint: SingleEndpoint;
  basePath: string;
  issues: EndpointIssue[];
  removable: boolean;
  onChange: (next: SingleEndpoint) => void;
  onRemove: () => void;
}) {
  const nameIssue = issues.find((issue) => issue.field === 'name')?.message;
  const path = endpointPath(endpoint.name);

  return (
    <Card className="ui-stack">
      <div className="ui-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Endpoint name">
          <Input
            value={endpoint.name}
            placeholder="current"
            aria-invalid={nameIssue ? true : undefined}
            onChange={(event) => onChange({ ...endpoint, name: event.target.value })}
          />
        </Field>
        <Field label="Description">
          <Input
            value={endpoint.description}
            placeholder="Get current weather information by city"
            onChange={(event) => onChange({ ...endpoint, description: event.target.value })}
            style={{ minWidth: 260 }}
          />
        </Field>
        <div style={{ flex: 1 }} />
        {removable ? (
          <Button variant="ghost" size="sm" onClick={onRemove} aria-label="Remove endpoint">
            ✕
          </Button>
        ) : null}
      </div>

      <div className="ui-row" style={{ alignItems: 'center', gap: 'var(--space-2)' }}>
        <MethodBadge method="GET" />
        <span className="ui-mono ui-meta">
          {basePath ? `/${basePath}` : ''}/{path || '{endpoint}'}
        </span>
        {nameIssue ? <span className="ui-field-error">{nameIssue}</span> : null}
      </div>

      <div className="ui-stack" style={{ gap: 'var(--space-3)' }}>
        <span className="ui-meta">Response shape</span>
        {endpoint.fields.map((field) => (
          <FieldRow
            key={field.id}
            field={field}
            depth={1}
            onChange={(next) =>
              onChange({
                ...endpoint,
                fields: endpoint.fields.map((item) => (item.id === field.id ? next : item)),
              })
            }
            onRemove={() =>
              onChange({
                ...endpoint,
                fields: endpoint.fields.filter((item) => item.id !== field.id),
              })
            }
          />
        ))}
      </div>

      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange({ ...endpoint, fields: [...endpoint.fields, newField()] })}
        >
          + Add field
        </Button>
      </div>
    </Card>
  );
}
