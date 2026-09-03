'use client';

/**
 * One entity: its name, identity style, fields, and — for relational projects —
 * its relationships.
 *
 * ## Why the relationship section is optional
 *
 * A **Single API** project is a set of independent endpoints, not a relational
 * model. `endpointsToEntities` in `single-api.ts` hardcodes `relations: []` and
 * `SingleEndpoint` has no relations field at all, so the creation flow cannot
 * produce one. Nothing on the server enforces that — a single project *with*
 * relations would generate and host perfectly well — which is exactly why the
 * editor must not offer it: the only way to get one is by editing, and the result
 * would be a project whose shape contradicts its own kind.
 *
 * Defaults to shown, so the relational wizard and the Demo API keep their
 * existing behaviour untouched.
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
  showRelations = true,
  noun = 'entity',
  errors,
}: {
  entity: BuilderEntity;
  targets: string[];
  issues: RelationIssue[];
  removable: boolean;
  onChange: (next: BuilderEntity) => void;
  onRemove: () => void;
  /** Relational projects only. See the note above. */
  showRelations?: boolean;
  /**
   * What one of these is called to the author.
   *
   * A Single API project calls them endpoints — that is the word its own wizard
   * uses, and "entity" would make the editor read as a different feature from the
   * one that created the project.
   */
  noun?: 'entity' | 'endpoint';
  /** Server-reported problems, keyed by builder node id. */
  errors?: ReadonlyMap<string, string[]> | undefined;
}) {
  const entityErrors = errors?.get(entity.id) ?? [];
  return (
    <Card className="ui-stack">
      <div className="ui-row ui-row--between" style={{ alignItems: 'flex-end' }}>
        {/*
          `Field` already renders and announces an error; it had simply never
          been given one. This is the server's message about this entity's name,
          beside the input rather than at the bottom of the page.
        */}
        <Field
          label={noun === 'endpoint' ? 'Endpoint name' : 'Entity name'}
          error={entityErrors[0] ?? null}
        >
          <Input
            value={entity.name}
            placeholder="Student"
            onChange={(event) => onChange({ ...entity, name: event.target.value })}
            aria-invalid={entityErrors.length > 0 ? true : undefined}
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
            Remove {noun}
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
            errors={errors}
          />
        ))}
      </div>

      {entityErrors.length > 1 ? (
        <div className="ui-stack" style={{ gap: 2 }}>
          {entityErrors.slice(1).map((issue) => (
            <span key={issue} className="ui-error" role="alert">
              {issue}
            </span>
          ))}
        </div>
      ) : null}

      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange({ ...entity, fields: [...entity.fields, newField()] })}
        >
          + Add field
        </Button>
      </div>

      {showRelations && (
        <>
          <hr style={{ border: 0, borderTop: '1px solid var(--border)', width: '100%' }} />
          <p className="ui-meta">
            Relationships describe how this entity connects to another one. The selected kind
            controls cardinality; the delete rule controls what happens to related records.
          </p>
          <RelationEditor entity={entity} targets={targets} issues={issues} onChange={onChange} />
        </>
      )}
    </Card>
  );
}
