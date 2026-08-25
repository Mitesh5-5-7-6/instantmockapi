'use client';

/**
 * One entity in the Design Data Model step: its name, identity style, fields,
 * and relationships.
 */

import { Button, Card, Field, Input, Select } from '@instantmockapi/ui';
import { newField, type BuilderEntity } from '../../lib/builder';
import type { RelationIssue } from '../../lib/relations';
import { FieldRow } from './field-row';
import { RelationEditor } from './relation-editor';

export function EntityCard({
  entity,
  targets,
  issues,
  removable,
  onChange,
  onRemove,
}: {
  entity: BuilderEntity;
  targets: string[];
  issues: RelationIssue[];
  removable: boolean;
  onChange: (next: BuilderEntity) => void;
  onRemove: () => void;
}) {
  return (
    <Card className="ui-stack">
      <div className="ui-row ui-row--between" style={{ alignItems: 'flex-end' }}>
        <Field label="Entity name">
          <Input
            value={entity.name}
            placeholder="Student"
            onChange={(event) => onChange({ ...entity, name: event.target.value })}
          />
        </Field>
        <Field label="Record id">
          <Select
            value={entity.identityStyle}
            aria-label="Identity style"
            onChange={(event) =>
              onChange({
                ...entity,
                identityStyle: event.target.value as BuilderEntity['identityStyle'],
              })
            }
          >
            {/* int first: it is what makes a documentation example read
                /students/1 instead of a uuid nobody can retype. */}
            <option value="int">counting numbers (1, 2, 3…)</option>
            <option value="uuid">UUIDs</option>
          </Select>
        </Field>
        <div style={{ flex: 1 }} />
        {removable ? (
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove entity
          </Button>
        ) : null}
      </div>

      <div className="ui-stack" style={{ gap: 'var(--space-3)' }}>
        {entity.fields.map((field) => (
          <FieldRow
            key={field.id}
            field={field}
            depth={1}
            onChange={(next) =>
              onChange({
                ...entity,
                fields: entity.fields.map((item) => (item.id === field.id ? next : item)),
              })
            }
            onRemove={() =>
              onChange({
                ...entity,
                fields: entity.fields.filter((item) => item.id !== field.id),
              })
            }
          />
        ))}
      </div>

      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange({ ...entity, fields: [...entity.fields, newField()] })}
        >
          + Add field
        </Button>
      </div>

      <hr style={{ border: 0, borderTop: '1px solid var(--border)', width: '100%' }} />

      <RelationEditor entity={entity} targets={targets} issues={issues} onChange={onChange} />
    </Card>
  );
}
