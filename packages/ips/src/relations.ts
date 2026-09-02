/**
 * Relation helpers for the IPS (doc 19 §Phase A).
 *
 * Relations are authored sparsely — by pack files and by the wizard, only
 * `{ name, kind, target }` is required. Everything else (field names, identity
 * descriptors, and the foreign-key fields themselves) is derived here, so that
 * **every generator downstream sees a complete, ordinary IPS**: a `Student` that
 * `belongsTo` a `Classroom` gets a real `classroomId` entry in `entity.fields`,
 * and generators that don't care about relations keep working untouched.
 *
 * Documents written before relations existed carry neither `relations` nor
 * `identity`. Every accessor here tolerates that, so old projects normalize into
 * the new shape instead of crashing — the same guarantee `normalizeIps` gives
 * for `validation` / `meta`.
 */

import type {
  Entity,
  EntityIdentity,
  Field,
  FieldType,
  InternalProjectSchema,
  Relation,
  RelationKind,
} from './types.js';

/** Identity used by an entity that declares none. */
export const DEFAULT_IDENTITY: EntityIdentity = { field: 'id', style: 'uuid' };

/** Relation kinds whose key lives on the declaring entity. */
const OWNING_KINDS: ReadonlySet<RelationKind> = new Set<RelationKind>(['belongsTo', 'manyToMany']);

/** Relation kinds that expand to an array of records rather than a single one. */
const COLLECTION_KINDS: ReadonlySet<RelationKind> = new Set<RelationKind>([
  'hasMany',
  'manyToMany',
]);

export function isOwningRelation(relation: Pick<Relation, 'kind'>): boolean {
  return OWNING_KINDS.has(relation.kind);
}

export function isCollectionRelation(relation: Pick<Relation, 'kind'>): boolean {
  return COLLECTION_KINDS.has(relation.kind);
}

function camel(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Identity descriptor of an entity, defaulted for pre-relations documents. */
export function entityIdentity(entity: Pick<Entity, 'identity'>): EntityIdentity {
  const identity = entity.identity;
  if (!identity || typeof identity.field !== 'string' || !identity.field) {
    return DEFAULT_IDENTITY;
  }
  return { field: identity.field, style: identity.style === 'int' ? 'int' : 'uuid' };
}

/** Declared relations of an entity — never undefined, never a non-array. */
export function entityRelations(entity: Pick<Entity, 'relations'>): Relation[] {
  return Array.isArray(entity.relations) ? entity.relations : [];
}

/** IPS field type that carries a reference to an entity with this identity style. */
export function identityFieldType(identity: EntityIdentity): FieldType {
  return identity.style === 'int' ? 'integer' : 'uuid';
}

/**
 * A relation as authored: only `name`, `kind`, and `target` are required —
 * `completeRelation` derives the rest.
 */
export type RelationInput = Pick<Relation, 'name' | 'kind' | 'target'> & Partial<Relation>;

/**
 * Fill a sparsely-declared relation with its derived field names.
 *
 * Both sides of a pair derive from the *owning* side's target identity, so a
 * `belongsTo` and its matching `hasMany` always agree on the join key even when
 * the two entities use different identity field names.
 */
export function completeRelation(
  source: Pick<Entity, 'name' | 'identity'>,
  relation: RelationInput,
  target: Pick<Entity, 'identity'> | undefined,
): Relation {
  const sourceIdentity = entityIdentity(source);
  const targetIdentity = target ? entityIdentity(target) : DEFAULT_IDENTITY;

  const owning = isOwningRelation(relation);
  const reference = `${camel(relation.target)}${pascal(targetIdentity.field)}`;

  const localField =
    relation.localField ||
    (relation.kind === 'manyToMany' ? `${reference}s` : owning ? reference : sourceIdentity.field);

  const foreignField =
    relation.foreignField ||
    (owning ? targetIdentity.field : `${camel(source.name)}${pascal(sourceIdentity.field)}`);

  return {
    // Carried explicitly, and first. This function returns a FRESH literal and
    // runs on every PATCH via `materializeRelations`, so a stable id that is
    // not copied here is destroyed on the first save — silently breaking every
    // dependency-graph edge pointing at this relation. Omitted rather than set
    // to undefined so an id-less relation does not persist an explicit null.
    ...(relation.id !== undefined ? { id: relation.id } : {}),
    name: relation.name,
    kind: relation.kind,
    target: relation.target,
    localField,
    foreignField,
    required: relation.required ?? false,
    onDelete: relation.onDelete ?? 'restrict',
  };
}

/** Field that holds a foreign key (or an array of them, for many-to-many). */
function referenceField(
  name: string,
  type: FieldType,
  target: string,
  required: boolean,
  isArray: boolean,
): Field {
  return {
    name,
    type: isArray ? 'array' : type,
    required,
    default: null,
    children: isArray
      ? [
          {
            name: 'item',
            type,
            required: true,
            default: null,
            children: [],
            validation: {},
            meta: { reference: true, relation: target },
          },
        ]
      : [],
    validation: {},
    meta: { reference: true, relation: target },
  };
}

function identityField(identity: EntityIdentity): Field {
  return {
    name: identity.field,
    type: identityFieldType(identity),
    // Never required: the hosted runtime assigns identity on create, so a POST
    // body that omits it must still validate.
    required: false,
    default: null,
    children: [],
    validation: {},
    meta: { identity: true, readOnly: true },
  };
}

/**
 * Normalize relations and materialize the fields they imply.
 *
 * Idempotent: fields already present — declared by the author, or added by an
 * earlier call — are left untouched, so this can run at any number of pipeline
 * stages without duplicating anything.
 */
export function materializeRelations(ips: InternalProjectSchema): InternalProjectSchema {
  const entities = ips.entities ?? [];

  // Pass 1: settle identities and complete relation declarations, so pass 2 can
  // resolve target identities without depending on declaration order.
  const withRelations = entities.map((entity) => {
    const identity = entityIdentity(entity);
    const source = { name: entity.name, identity };
    const relations = entityRelations(entity).map((relation) =>
      completeRelation(
        source,
        relation,
        entities.find((candidate) => candidate.name === relation.target),
      ),
    );
    return { ...entity, identity, relations };
  });

  const byName = new Map(withRelations.map((entity) => [entity.name, entity]));

  // Pass 2: add the identity field and every owning-side reference field.
  const materialized = withRelations.map((entity) => {
    const fields = [...(entity.fields ?? [])];
    const has = (name: string): boolean => fields.some((field) => field.name === name);

    if (!has(entity.identity.field)) {
      fields.unshift(identityField(entity.identity));
    }

    for (const relation of entity.relations) {
      if (!isOwningRelation(relation) || has(relation.localField)) {
        continue;
      }
      const target = byName.get(relation.target);
      const type = identityFieldType(target ? entityIdentity(target) : DEFAULT_IDENTITY);
      fields.push(
        referenceField(
          relation.localField,
          type,
          relation.target,
          relation.required,
          relation.kind === 'manyToMany',
        ),
      );
    }

    return { ...entity, fields };
  });

  return { ...ips, entities: materialized };
}

/**
 * Entities ordered so that every owning-side target precedes the entity
 * declaring it — the order a seeder must follow to hand out real foreign keys.
 *
 * `manyToMany` counts as a dependency for the same reason `belongsTo` does: the
 * owning side draws from the target's issued id pool.
 *
 * Cycles (including self-references) can't be ordered; the remaining entities
 * are appended in declaration order and the seeder falls back to whatever ids
 * already exist, or null.
 */
export function topologicalEntityOrder(ips: Pick<InternalProjectSchema, 'entities'>): Entity[] {
  const entities = ips.entities ?? [];
  const names = new Set(entities.map((entity) => entity.name));

  /** entity name → names it must be seeded after */
  const dependencies = new Map<string, Set<string>>();
  for (const entity of entities) {
    const deps = new Set<string>();
    for (const relation of entityRelations(entity)) {
      if (!isOwningRelation(relation) || relation.target === entity.name) {
        continue;
      }
      if (names.has(relation.target)) {
        deps.add(relation.target);
      }
    }
    dependencies.set(entity.name, deps);
  }

  const ordered: Entity[] = [];
  const emitted = new Set<string>();

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const entity of entities) {
      if (emitted.has(entity.name)) {
        continue;
      }
      const deps = dependencies.get(entity.name) ?? new Set<string>();
      if ([...deps].every((dep) => emitted.has(dep))) {
        ordered.push(entity);
        emitted.add(entity.name);
        progressed = true;
      }
    }
  }

  // Whatever is left participates in a cycle — keep declaration order.
  for (const entity of entities) {
    if (!emitted.has(entity.name)) {
      ordered.push(entity);
    }
  }

  return ordered;
}
