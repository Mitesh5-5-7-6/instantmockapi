'use client';

/**
 * Relation rows for one entity (Design Data Model step).
 *
 * Each row shows the derived foreign-key field name for owning kinds. That
 * preview is the point of the control: `belongsTo` silently grows a
 * `classroomId` field on this entity while `hasMany` grows nothing here and
 * reads a key on the target, and nothing else on screen would tell you which
 * you picked.
 */

import { Button, Icon, Input, Select } from '@instantmockapi/ui';
import {
  RELATION_KINDS,
  newRelation,
  type BuilderEntity,
  type BuilderRelation,
} from '../../lib/builder';
import { isOwningKind, previewKeyField, type RelationIssue } from '../../lib/relations';

export function RelationEditor({
  entity,
  targets,
  issues,
  onChange,
}: {
  entity: BuilderEntity;
  /** Entity names available as a target — excludes unnamed and excluded ones. */
  targets: string[];
  issues: RelationIssue[];
  onChange: (next: BuilderEntity) => void;
}) {
  const update = (id: string, patch: Partial<BuilderRelation>): void =>
    onChange({
      ...entity,
      relations: entity.relations.map((relation) =>
        relation.id === id ? { ...relation, ...patch } : relation,
      ),
    });

  const issueFor = (relationId: string, field: RelationIssue['field']): string | undefined =>
    issues.find((issue) => issue.relationId === relationId && issue.field === field)?.message;

  const otherTargets = targets.filter((name) => name !== entity.name.trim());

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-3)' }}>
      <div className="ui-row ui-row--between">
        <span className="ui-meta">Relationships</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={otherTargets.length === 0}
          onClick={() => onChange({ ...entity, relations: [...entity.relations, newRelation()] })}
        >
          + relationship
        </Button>
      </div>

      {otherTargets.length === 0 ? (
        <p className="ui-meta">Add a second entity to relate this one to something.</p>
      ) : null}

      {entity.relations.map((relation) => {
        const nameIssue = issueFor(relation.id, 'name');
        const targetIssue = issueFor(relation.id, 'target');
        const keyField = previewKeyField(relation);
        return (
          <div key={relation.id} className="ui-stack" style={{ gap: 'var(--space-1)' }}>
            <div className="ui-row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <Input
                value={relation.name}
                placeholder="relation name"
                aria-label="Relation name"
                aria-invalid={nameIssue ? true : undefined}
                onChange={(event) => update(relation.id, { name: event.target.value })}
                style={{ maxWidth: 170 }}
              />
              <Select
                value={relation.kind}
                aria-label="Relation kind"
                onChange={(event) =>
                  update(relation.id, { kind: event.target.value as BuilderRelation['kind'] })
                }
              >
                {RELATION_KINDS.map((entry) => (
                  <option key={entry.kind} value={entry.kind}>
                    {entry.label} ({entry.cardinality})
                  </option>
                ))}
              </Select>
              <Select
                value={relation.target}
                aria-label="Relation target"
                aria-invalid={targetIssue ? true : undefined}
                onChange={(event) => update(relation.id, { target: event.target.value })}
              >
                <option value="">— target —</option>
                {/* A stale target stays listed so the select can still show it
                    while the author decides what to do about it. */}
                {(relation.target && !otherTargets.includes(relation.target)
                  ? [relation.target, ...otherTargets]
                  : otherTargets
                ).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
              <Select
                value={relation.onDelete}
                aria-label="On delete"
                onChange={(event) =>
                  update(relation.id, {
                    onDelete: event.target.value as BuilderRelation['onDelete'],
                  })
                }
              >
                <option value="restrict">on delete: restrict</option>
                <option value="cascade">on delete: cascade</option>
                <option value="setNull">on delete: set null</option>
              </Select>
              <div style={{ flex: 1 }} />
              <Button
                variant="ghost"
                size="sm"
                aria-label="Remove relationship"
                onClick={() =>
                  onChange({
                    ...entity,
                    relations: entity.relations.filter((item) => item.id !== relation.id),
                  })
                }
              >
                <Icon name="x" size={14} />
              </Button>
            </div>

            <div className="ui-row" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              {keyField ? (
                <span className="ui-meta ui-mono">
                  adds {entity.name || 'this entity'}.{keyField}
                </span>
              ) : isOwningKind(relation.kind) ? null : (
                <span className="ui-meta">
                  reads a key on {relation.target || 'the target'} — no field added here
                </span>
              )}
              {nameIssue ? <span className="ui-field-error">{nameIssue}</span> : null}
              {targetIssue ? <span className="ui-field-error">{targetIssue}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
