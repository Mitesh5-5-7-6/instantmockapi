/**
 * Relation rules for the Design Data Model step.
 *
 * The API validates relations too, but only after a round trip that costs the
 * author their place in the wizard. These are the same rules stated locally so a
 * dangling target is a red line under a select, not a 422 on submit.
 *
 * Serialization stays deliberately **sparse**: only `name`, `kind`, `target`,
 * `required` and `onDelete` are sent. Field names are derived server-side by
 * `completeRelation`, and both sides of a pair derive from the owning side's
 * target identity — so a wizard that guessed at `localField` would be inventing
 * a value the server is about to overwrite, and would disagree with it whenever
 * two entities use different identity field names.
 */

import type { BuilderEntity, BuilderRelation } from './builder';
import { RELATION_KINDS } from './builder';

export interface RelationIssue {
  entityId: string;
  relationId: string;
  field: 'name' | 'target';
  message: string;
}

/** Entities eligible as a relation target: anything named and generated. */
export function relationTargets(entities: BuilderEntity[]): string[] {
  return entities
    .filter((entity) => entity.generate && entity.name.trim())
    .map((entity) => entity.name);
}

/** True when this kind puts the foreign key on the declaring entity. */
export function isOwningKind(kind: BuilderRelation['kind']): boolean {
  return RELATION_KINDS.some((entry) => entry.kind === kind && entry.owning);
}

/** Cardinality label for a kind, e.g. `1 : M` — used by the diagram legend. */
export function cardinalityOf(kind: BuilderRelation['kind']): string {
  return RELATION_KINDS.find((entry) => entry.kind === kind)?.cardinality ?? '';
}

function camel(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * The field name the server will derive for an owning relation.
 *
 * Shown to the author as a preview, never sent. It mirrors `completeRelation`:
 * target name in camelCase + capitalised identity field, pluralised for a
 * many-to-many key array.
 */
export function previewKeyField(relation: BuilderRelation, targetIdentity = 'id'): string | null {
  if (!isOwningKind(relation.kind) || !relation.target) {
    return null;
  }
  const base = `${camel(relation.target)}${targetIdentity.charAt(0).toUpperCase()}${targetIdentity.slice(1)}`;
  return relation.kind === 'manyToMany' ? `${base}s` : base;
}

/**
 * Every problem with the authored relations.
 *
 * Reported as a list rather than a first-failure so the step can underline all
 * the offending controls at once instead of revealing them one submit at a time.
 */
export function validateRelations(entities: BuilderEntity[]): RelationIssue[] {
  const issues: RelationIssue[] = [];
  const targets = new Set(relationTargets(entities));

  for (const entity of entities) {
    if (!entity.generate) {
      continue;
    }
    const seen = new Map<string, number>();
    for (const relation of entity.relations) {
      const name = relation.name.trim();

      if (!name) {
        issues.push({
          entityId: entity.id,
          relationId: relation.id,
          field: 'name',
          message: 'Needs a name — it becomes the property on the expanded record.',
        });
      } else if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        issues.push({
          entityId: entity.id,
          relationId: relation.id,
          field: 'name',
          message: 'Use a plain identifier: letters, digits and underscores.',
        });
      } else if (entity.fields.some((field) => field.name.trim() === name)) {
        // An expansion overwrites a same-named own field at request time, which
        // silently loses the field's value. Caught here instead.
        issues.push({
          entityId: entity.id,
          relationId: relation.id,
          field: 'name',
          message: `A field is already called '${name}' — the expansion would replace it.`,
        });
      }

      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      if (name && count > 1) {
        issues.push({
          entityId: entity.id,
          relationId: relation.id,
          field: 'name',
          message: `Duplicate relation name '${name}' on this entity.`,
        });
      }

      if (!relation.target) {
        issues.push({
          entityId: entity.id,
          relationId: relation.id,
          field: 'target',
          message: 'Pick the entity this points at.',
        });
      } else if (!targets.has(relation.target)) {
        // Reachable by renaming or excluding the target after authoring the
        // relation, which is exactly when a silent dangling reference happens.
        issues.push({
          entityId: entity.id,
          relationId: relation.id,
          field: 'target',
          message: `'${relation.target}' is no longer an included entity.`,
        });
      }
    }
  }
  return issues;
}

/**
 * Relations that would dangle if `entityName` were excluded from generation.
 *
 * The wizard shows this **before** the exclusion takes effect: dropping an
 * entity that three relations point at is a bigger edit than the checkbox looks,
 * and finding out via a 422 after the fact is worse.
 */
export function relationsPointingAt(
  entities: BuilderEntity[],
  entityName: string,
): { entity: string; relation: string }[] {
  const affected: { entity: string; relation: string }[] = [];
  for (const entity of entities) {
    if (!entity.generate || entity.name === entityName) {
      continue;
    }
    for (const relation of entity.relations) {
      if (relation.target === entityName) {
        affected.push({ entity: entity.name, relation: relation.name || '(unnamed)' });
      }
    }
  }
  return affected;
}

/**
 * The entities to submit: excluded ones dropped, and any relation pointing at a
 * dropped entity dropped with them.
 *
 * Pruning is not optional. `validateIPS` rejects a relation whose target is not
 * a declared entity, so submitting the unpruned set would fail the whole create
 * because of an entity the author deliberately left out.
 */
export function pruneForGeneration(entities: BuilderEntity[]): BuilderEntity[] {
  const included = entities.filter((entity) => entity.generate && entity.name.trim());
  const names = new Set(included.map((entity) => entity.name));
  return included.map((entity) => ({
    ...entity,
    relations: entity.relations.filter(
      (relation) => relation.name.trim() !== '' && names.has(relation.target),
    ),
  }));
}

/** Sparse IPS relation — the server derives the field names. */
export function builderRelationToIPS(relation: BuilderRelation): Record<string, unknown> {
  return {
    name: relation.name.trim(),
    kind: relation.kind,
    target: relation.target,
    required: relation.required,
    onDelete: relation.onDelete,
  };
}
