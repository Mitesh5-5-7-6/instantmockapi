import type { BuilderEntity, BuilderField } from './builder';

export type EntityChangeKind = 'added' | 'removed' | 'changed' | 'same';
export interface FieldChange {
  name: string;
  change: 'added' | 'removed' | 'type' | 'required' | 'enum';
}
export interface EntityChange {
  /** Lower-cased name: the key a choice is stored under. */
  key: string;
  name: string;
  kind: EntityChangeKind;
  mine?: BuilderEntity;
  next?: BuilderEntity;
  fieldChanges: FieldChange[];
  relationChanges: string[];
}
export type MergeChoice = 'mine' | 'new';

const keyOf = (name: string): string => name.trim().toLowerCase();
const enumOf = (field: BuilderField): string => (field.validation.enum ?? []).join('\u0000');
const relationsOf = (entity: BuilderEntity): string[] =>
  entity.relations.map((relation) => `${relation.name} → ${relation.target}`);

function fieldChanges(mine: BuilderEntity, next: BuilderEntity): FieldChange[] {
  const changes: FieldChange[] = [];
  const nextByName = new Map(next.fields.map((field) => [keyOf(field.name), field]));
  const mineNames = new Set(mine.fields.map((field) => keyOf(field.name)));
  for (const field of mine.fields) {
    const other = nextByName.get(keyOf(field.name));
    if (!other) {
      changes.push({ name: field.name, change: 'removed' });
      continue;
    }
    if (other.type !== field.type) changes.push({ name: field.name, change: 'type' });
    if (other.required !== field.required) changes.push({ name: field.name, change: 'required' });
    if (enumOf(other) !== enumOf(field)) changes.push({ name: field.name, change: 'enum' });
  }
  for (const field of next.fields) {
    if (!mineNames.has(keyOf(field.name))) changes.push({ name: field.name, change: 'added' });
  }
  return changes;
}

function relationChanges(mine: BuilderEntity, next: BuilderEntity): string[] {
  const before = new Set(relationsOf(mine));
  const after = new Set(relationsOf(next));
  return [
    ...[...after].filter((r) => !before.has(r)).map((r) => `+${r}`),
    ...[...before].filter((r) => !after.has(r)).map((r) => `-${r}`),
  ];
}

/** Entity-level diff of the user's draft against a new suggestion; my order first, then additions. */
export function diffEntities(
  mine: readonly BuilderEntity[],
  next: readonly BuilderEntity[],
): EntityChange[] {
  const nextByKey = new Map(next.map((entity) => [keyOf(entity.name), entity]));
  const seen = new Set<string>();
  const changes: EntityChange[] = mine.map((entity) => {
    const key = keyOf(entity.name);
    seen.add(key);
    const other = nextByKey.get(key);
    if (!other) {
      return {
        key,
        name: entity.name,
        kind: 'removed',
        mine: entity,
        fieldChanges: [],
        relationChanges: [],
      };
    }
    const fields = fieldChanges(entity, other);
    const relations = relationChanges(entity, other);
    return {
      key,
      name: entity.name,
      kind: fields.length > 0 || relations.length > 0 ? 'changed' : 'same',
      mine: entity,
      next: other,
      fieldChanges: fields,
      relationChanges: relations,
    };
  });
  for (const entity of next) {
    const key = keyOf(entity.name);
    if (!seen.has(key)) {
      changes.push({
        key,
        name: entity.name,
        kind: 'added',
        next: entity,
        fieldChanges: [],
        relationChanges: [],
      });
    }
  }
  return changes;
}

/**
 * Apply per-entity choices. Missing choices mean "mine", so an untouched diff is a
 * no-op. A relation left pointing at a now-missing entity is kept and flagged by
 * validateRelations, never silently deleted.
 */
export function mergeEntities(
  changes: readonly EntityChange[],
  choices: Readonly<Record<string, MergeChoice>>,
): BuilderEntity[] {
  const merged: BuilderEntity[] = [];
  for (const change of changes) {
    const takeNew = choices[change.key] === 'new';
    if (
      change.kind === 'same' ||
      (change.kind === 'changed' && !takeNew) ||
      (change.kind === 'removed' && !takeNew)
    ) {
      merged.push(change.mine!);
    } else if ((change.kind === 'changed' || change.kind === 'added') && takeNew) {
      merged.push(change.next!);
    }
  }
  return merged;
}
