/**
 * Change detection: what differs between the active definition and a draft.
 *
 * ## Why ids and not names
 *
 * Every lookup in this file matches on the stable ids from `ids.ts`. Diffing by
 * name cannot tell a rename from a delete-plus-create, which is the difference
 * between "PATCH /users still works, at a new path" and "every endpoint for this
 * entity is gone". `ensureSchemaIds` runs when a draft is forked, so both sides
 * of the diff carry ids and matching is exact.
 *
 * An element present in the draft with no matching id is an addition; an id in
 * the active definition with no match in the draft is a removal.
 *
 * ## The two axes every change carries
 *
 * **Severity** — whether existing callers break. Adding an enum value is safe;
 * removing one rejects requests that used to succeed. Widening `required` from
 * false to true rejects bodies that used to validate. This is the axis a user
 * needs before they commit.
 *
 * **Aspect** — *which* endpoints a change can reach, and it is what makes impact
 * analysis precise rather than alarmist:
 *
 *   - `write` — only request-shaped endpoints. A `default` or a validation rule
 *     changes what a POST accepts and nothing about what a GET returns.
 *   - `read` — only response-shaped endpoints.
 *   - `both` — a type change or a field appearing/disappearing alters the
 *     response body *and* the accepted request.
 *   - `routing` — the endpoint's own path moves. Entity renames do this, because
 *     the hosted route is derived from the entity name.
 *
 * Without the aspect, an `age` type change would mark `DELETE /users/{id}` as
 * affected — and the spec is explicit that it must not.
 *
 * ## What this module deliberately does not do
 *
 * It reports changes; it does not judge validity (that is `validateIPS`) and it
 * does not know what an endpoint is (that is `impact.ts`). Keeping it ignorant of
 * endpoints is what lets it be a pure function of two schemas.
 */

import type { Entity, Field, InternalProjectSchema, Relation, ValidationRules } from './types.js';
import type { GenerationConfig } from './types.js';

export const CHANGE_KINDS = [
  'ENTITY_ADDED',
  'ENTITY_REMOVED',
  'ENTITY_RENAMED',
  'ENTITY_DESCRIPTION_CHANGED',
  'ENTITY_IDENTITY_CHANGED',
  'FIELD_ADDED',
  'FIELD_REMOVED',
  'FIELD_RENAMED',
  'FIELD_TYPE_CHANGED',
  'FIELD_REQUIRED_CHANGED',
  'FIELD_DEFAULT_CHANGED',
  'FIELD_META_CHANGED',
  'VALIDATION_ADDED',
  'VALIDATION_REMOVED',
  'VALIDATION_CHANGED',
  'ENUM_VALUES_ADDED',
  'ENUM_VALUES_REMOVED',
  'RELATION_ADDED',
  'RELATION_REMOVED',
  'RELATION_KIND_CHANGED',
  'RELATION_TARGET_CHANGED',
  'RELATION_FIELDS_CHANGED',
  'RELATION_ON_DELETE_CHANGED',
  'RELATION_REQUIRED_CHANGED',
  'METHODS_CHANGED',
  'QUERY_FEATURES_CHANGED',
  'MOCK_RECORDS_CHANGED',
  'GENERATORS_CHANGED',
] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

/**
 * How much attention a change deserves before it is committed.
 *
 * Five levels rather than a breaking/non-breaking flag, because the middle of
 * that range is where the useful information lives:
 *
 * - `SAFE` — strictly additive. Nothing that worked stops working. A new
 *   optional field, a widened enum, a relaxed rule.
 * - `INFO` — no effect on anything callable. Descriptions, which generators to
 *   emit, how many records to seed.
 * - `WARNING` — breaks *some* callers, depending on what they send. Making a
 *   field required breaks only requests that omitted it; tightening `max`
 *   breaks only values above the new bound. Distinguishing this from BREAKING
 *   is the difference between "check your clients" and "your clients are down".
 * - `BREAKING` — breaks callers unconditionally. A type change, a removed field,
 *   a removed enum value.
 * - `ROUTING` — the endpoint still works but has MOVED. Its own category
 *   because the remedy is different: callers update a URL rather than a payload.
 */
export const CHANGE_RISKS = ['SAFE', 'INFO', 'WARNING', 'ROUTING', 'BREAKING'] as const;

export type ChangeRisk = (typeof CHANGE_RISKS)[number];

/**
 * Ranking, worst last, for "the highest risk in this set".
 *
 * `ROUTING` sits just below `BREAKING` — both demand action, and the ordering
 * between them is presentational rather than a claim that a moved URL hurts less
 * than a changed payload.
 */
const RISK_RANK: Record<ChangeRisk, number> = {
  INFO: 0,
  SAFE: 1,
  WARNING: 2,
  ROUTING: 3,
  BREAKING: 4,
};

/** Which side of an endpoint a change can reach. */
export type ChangeAspect = 'read' | 'write' | 'both' | 'routing' | 'none';

export interface SchemaChange {
  kind: ChangeKind;
  risk: ChangeRisk;
  aspect: ChangeAspect;
  /** Stable id of the entity this change belongs to, when there is one. */
  entityId?: string;
  /** Entity name as it reads in the DRAFT — what the user is looking at. */
  entityName?: string;
  fieldId?: string;
  fieldName?: string;
  relationId?: string;
  relationName?: string;
  /**
   * Dotted path within the field, for nested objects and array elements —
   * `address.city`, `tags.item`. Absent for a top-level field.
   */
  path?: string;
  before?: unknown;
  after?: unknown;
  /** One sentence, written for the user rather than for a log. */
  summary: string;
}

/* ────────────────────────── helpers ────────────────────────── */

/** Index a list by stable id, skipping anything not yet backfilled. */
function byId<T extends { id?: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (typeof item.id === 'string' && item.id !== '') {
      map.set(item.id, item);
    }
  }
  return map;
}

/**
 * Flatten a field tree to `(field, dottedPath)` pairs.
 *
 * Nested objects and array element types are real dependency-graph nodes —
 * `customer.address.city` has to be reportable — so the diff walks the whole tree
 * rather than only the top level.
 */
function flattenFields(fields: readonly Field[], prefix = ''): { field: Field; path: string }[] {
  const flat: { field: Field; path: string }[] = [];
  for (const field of fields) {
    const path = prefix === '' ? field.name : `${prefix}.${field.name}`;
    flat.push({ field, path });
    if (Array.isArray(field.children) && field.children.length > 0) {
      flat.push(...flattenFields(field.children, path));
    }
  }
  return flat;
}

const VALIDATION_KEYS = [
  'email',
  'url',
  'uuid',
  'min',
  'max',
  'length',
  'regex',
  'arrayLength',
  'message',
] as const;

function sameValue(a: unknown, b: unknown): boolean {
  // JSON comparison rather than deep-equal: every value in an IPS is
  // JSON-serialisable by construction (it round-trips through Mongo as Mixed),
  // and this avoids a deep-equal dependency in a package that has none.
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function enumOf(validation: ValidationRules | undefined): string[] {
  return Array.isArray(validation?.enum) ? validation.enum : [];
}

/* ────────────────────────── field diff ────────────────────────── */

function diffField(entity: Entity, before: Field, after: Field, path: string): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const at = {
    entityId: entity.id,
    entityName: entity.name,
    fieldId: after.id,
    fieldName: after.name,
    ...(path === after.name ? {} : { path }),
  };

  if (before.name !== after.name) {
    changes.push({
      ...at,
      kind: 'FIELD_RENAMED',
      // A response key changes and a request key stops being recognised. Callers
      // reading `firstName` get undefined; callers sending it are ignored.
      risk: 'BREAKING',
      aspect: 'both',
      before: before.name,
      after: after.name,
      summary: `Field ${entity.name}.${before.name} renamed to ${after.name}`,
    });
  }

  if (before.type !== after.type) {
    changes.push({
      ...at,
      kind: 'FIELD_TYPE_CHANGED',
      // The spec calls this out as high-impact: the response value changes shape
      // and previously-valid request bodies stop validating.
      risk: 'BREAKING',
      aspect: 'both',
      before: before.type,
      after: after.type,
      summary: `Field ${entity.name}.${after.name} type changed from ${before.type} to ${after.type}`,
    });
  }

  if (before.required !== after.required) {
    changes.push({
      ...at,
      kind: 'FIELD_REQUIRED_CHANGED',
      // Widening breaks writers that omitted it; relaxing cannot break anyone.
      risk: after.required ? 'WARNING' : 'SAFE',
      // Requiredness is a request rule. A GET response is unaffected by whether
      // the field was mandatory on the way in.
      aspect: 'write',
      before: before.required,
      after: after.required,
      summary: after.required
        ? `Field ${entity.name}.${after.name} is now required`
        : `Field ${entity.name}.${after.name} is no longer required`,
    });
  }

  if (!sameValue(before.default, after.default)) {
    changes.push({
      ...at,
      kind: 'FIELD_DEFAULT_CHANGED',
      risk: 'SAFE',
      // The spec's own example of read-vs-write precision: a default affects what
      // a POST fills in, and nothing about reading stored data back.
      aspect: 'write',
      before: before.default,
      after: after.default,
      summary: `Default for ${entity.name}.${after.name} changed`,
    });
  }

  // ── enum values, treated separately from other validation ──
  const beforeEnum = enumOf(before.validation);
  const afterEnum = enumOf(after.validation);
  const added = afterEnum.filter((value) => !beforeEnum.includes(value));
  const removed = beforeEnum.filter((value) => !afterEnum.includes(value));

  if (added.length > 0) {
    changes.push({
      ...at,
      kind: 'ENUM_VALUES_ADDED',
      // Widening an accepted set cannot reject anything that used to pass.
      risk: 'SAFE',
      aspect: 'write',
      before: beforeEnum,
      after: afterEnum,
      summary: `Allowed values added to ${entity.name}.${after.name}: ${added.join(', ')}`,
    });
  }
  if (removed.length > 0) {
    changes.push({
      ...at,
      kind: 'ENUM_VALUES_REMOVED',
      // Requests carrying a removed value now 422 — and stored records may
      // already hold it, so reads can surface a value the schema disallows.
      risk: 'BREAKING',
      aspect: 'both',
      before: beforeEnum,
      after: afterEnum,
      summary: `Allowed values removed from ${entity.name}.${after.name}: ${removed.join(', ')}`,
    });
  }

  // ── the remaining validation rules, one change per rule ──
  for (const key of VALIDATION_KEYS) {
    const from = before.validation?.[key];
    const to = after.validation?.[key];
    if (sameValue(from, to)) {
      continue;
    }
    const absent = (value: unknown): boolean =>
      value === undefined || value === null || value === false;
    const kind: ChangeKind = absent(from)
      ? 'VALIDATION_ADDED'
      : absent(to)
        ? 'VALIDATION_REMOVED'
        : 'VALIDATION_CHANGED';

    changes.push({
      ...at,
      path: `${path}.validation.${key}`,
      kind,
      // Adding or tightening a rule rejects bodies that used to pass; removing
      // one only widens what is accepted. Tightening-vs-loosening within a
      // numeric bound is not inferred — reporting a possible break is the safe
      // direction, and the user can see the before/after.
      risk: kind === 'VALIDATION_REMOVED' ? 'SAFE' : 'WARNING',
      aspect: 'write',
      before: from ?? null,
      after: to ?? null,
      summary:
        kind === 'VALIDATION_ADDED'
          ? `Validation ${key} added to ${entity.name}.${after.name}`
          : kind === 'VALIDATION_REMOVED'
            ? `Validation ${key} removed from ${entity.name}.${after.name}`
            : `Validation ${key} on ${entity.name}.${after.name} changed`,
    });
  }

  if (!sameValue(before.meta, after.meta)) {
    changes.push({
      ...at,
      kind: 'FIELD_META_CHANGED',
      // `unique` and `searchable` change what the hosted query layer accepts and
      // what a write may collide on, but no response shape moves.
      risk: 'SAFE',
      aspect: 'write',
      before: before.meta,
      after: after.meta,
      summary: `Metadata on ${entity.name}.${after.name} changed`,
    });
  }

  return changes;
}

/* ────────────────────────── entity diff ────────────────────────── */

function diffEntityFields(before: Entity, after: Entity): SchemaChange[] {
  const changes: SchemaChange[] = [];

  const beforeFlat = flattenFields(before.fields ?? []);
  const afterFlat = flattenFields(after.fields ?? []);
  const beforeById = byId(beforeFlat.map((entry) => entry.field));
  const afterIds = new Set(
    afterFlat.map((entry) => entry.field.id).filter((id): id is string => typeof id === 'string'),
  );

  for (const { field, path } of afterFlat) {
    const previous = field.id === undefined ? undefined : beforeById.get(field.id);
    if (!previous) {
      changes.push({
        entityId: after.id,
        entityName: after.name,
        fieldId: field.id,
        fieldName: field.name,
        ...(path === field.name ? {} : { path }),
        kind: 'FIELD_ADDED',
        // A new optional field is additive; a new required one rejects every
        // existing request body that does not carry it.
        risk: field.required ? 'WARNING' : 'SAFE',
        aspect: 'both',
        after: { name: field.name, type: field.type, required: field.required },
        summary: field.required
          ? `Required field ${after.name}.${field.name} added`
          : `Field ${after.name}.${field.name} added`,
      });
      continue;
    }
    changes.push(...diffField(after, previous, field, path));
  }

  for (const { field, path } of beforeFlat) {
    // Skip anything unmatchable. A field with no id cannot be paired, and
    // reporting it as REMOVED would be a lie about an un-backfilled schema —
    // the field is very likely still there, just unidentified.
    if (field.id === undefined || afterIds.has(field.id)) {
      continue;
    }
    changes.push({
      entityId: after.id,
      entityName: after.name,
      fieldId: field.id,
      fieldName: field.name,
      ...(path === field.name ? {} : { path }),
      kind: 'FIELD_REMOVED',
      risk: 'BREAKING',
      aspect: 'both',
      before: { name: field.name, type: field.type },
      summary: `Field ${after.name}.${field.name} removed`,
    });
  }

  return changes;
}

function diffRelations(before: Entity, after: Entity): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const beforeById = byId(before.relations ?? []);
  const afterById = byId(after.relations ?? []);

  const at = (relation: Relation) => ({
    entityId: after.id,
    entityName: after.name,
    relationId: relation.id,
    relationName: relation.name,
  });

  for (const [id, relation] of afterById) {
    const previous = beforeById.get(id);
    if (!previous) {
      changes.push({
        ...at(relation),
        kind: 'RELATION_ADDED',
        // Adds an `?include=` key and, on owning sides, a derived foreign-key
        // field. Nothing existing stops working.
        risk: 'SAFE',
        aspect: 'both',
        after: { name: relation.name, kind: relation.kind, target: relation.target },
        summary: `Relation ${after.name}.${relation.name} → ${relation.target} added`,
      });
      continue;
    }

    if (previous.kind !== relation.kind) {
      changes.push({
        ...at(relation),
        kind: 'RELATION_KIND_CHANGED',
        // Cardinality decides whether an expansion is an object or an array, and
        // which side carries the key.
        risk: 'BREAKING',
        aspect: 'both',
        before: previous.kind,
        after: relation.kind,
        summary: `Relation ${after.name}.${relation.name} changed from ${previous.kind} to ${relation.kind}`,
      });
    }
    if (previous.target !== relation.target) {
      changes.push({
        ...at(relation),
        kind: 'RELATION_TARGET_CHANGED',
        risk: 'BREAKING',
        aspect: 'both',
        before: previous.target,
        after: relation.target,
        summary: `Relation ${after.name}.${relation.name} retargeted from ${previous.target} to ${relation.target}`,
      });
    }
    if (
      previous.localField !== relation.localField ||
      previous.foreignField !== relation.foreignField
    ) {
      changes.push({
        ...at(relation),
        kind: 'RELATION_FIELDS_CHANGED',
        risk: 'BREAKING',
        aspect: 'both',
        before: { localField: previous.localField, foreignField: previous.foreignField },
        after: { localField: relation.localField, foreignField: relation.foreignField },
        summary: `Join fields for ${after.name}.${relation.name} changed`,
      });
    }
    if (previous.onDelete !== relation.onDelete) {
      changes.push({
        ...at(relation),
        kind: 'RELATION_ON_DELETE_CHANGED',
        // Only observable through DELETE, and only in what happens to the other
        // side. No shape moves.
        risk: 'SAFE',
        aspect: 'write',
        before: previous.onDelete,
        after: relation.onDelete,
        summary: `Delete behaviour for ${after.name}.${relation.name} changed from ${previous.onDelete} to ${relation.onDelete}`,
      });
    }
    if (previous.required !== relation.required) {
      changes.push({
        ...at(relation),
        kind: 'RELATION_REQUIRED_CHANGED',
        risk: relation.required ? 'WARNING' : 'SAFE',
        aspect: 'write',
        before: previous.required,
        after: relation.required,
        summary: relation.required
          ? `Relation ${after.name}.${relation.name} is now required`
          : `Relation ${after.name}.${relation.name} is no longer required`,
      });
    }
  }

  for (const [id, relation] of beforeById) {
    if (afterById.has(id)) {
      continue;
    }
    changes.push({
      ...at(relation),
      kind: 'RELATION_REMOVED',
      // `?include=<name>` stops resolving for every existing caller.
      risk: 'BREAKING',
      aspect: 'both',
      before: { name: relation.name, kind: relation.kind, target: relation.target },
      summary: `Relation ${after.name}.${relation.name} → ${relation.target} removed`,
    });
  }

  return changes;
}

/* ────────────────────────── config diff ────────────────────────── */

function diffConfig(before: GenerationConfig, after: GenerationConfig): SchemaChange[] {
  const changes: SchemaChange[] = [];

  const beforeMethods = [...(before.methods ?? [])].sort();
  const afterMethods = [...(after.methods ?? [])].sort();
  if (!sameValue(beforeMethods, afterMethods)) {
    const removed = beforeMethods.filter((method) => !afterMethods.includes(method));
    changes.push({
      kind: 'METHODS_CHANGED',
      // Removing a method deletes endpoints outright; adding creates new ones.
      risk: removed.length > 0 ? 'BREAKING' : 'SAFE',
      // Not `read`/`write`: this changes which endpoints EXIST, so the whole
      // surface is in scope.
      aspect: 'routing',
      before: beforeMethods,
      after: afterMethods,
      summary:
        removed.length > 0
          ? `HTTP methods removed: ${removed.join(', ')}`
          : `HTTP methods changed to ${afterMethods.join(', ')}`,
    });
  }

  if (!sameValue(before.features, after.features)) {
    changes.push({
      kind: 'QUERY_FEATURES_CHANGED',
      // Turning a feature on only widens what the runtime accepts; turning one
      // off rejects query strings that used to work.
      risk: 'SAFE',
      aspect: 'read',
      before: before.features ?? null,
      after: after.features ?? null,
      summary: 'Query capabilities changed',
    });
  }

  if (before.mockRecords !== after.mockRecords) {
    changes.push({
      kind: 'MOCK_RECORDS_CHANGED',
      risk: 'INFO',
      // Reseeding replaces the records a GET returns, but no endpoint or shape
      // changes.
      aspect: 'read',
      before: before.mockRecords,
      after: after.mockRecords,
      summary: `Seeded records per entity changed from ${before.mockRecords} to ${after.mockRecords}`,
    });
  }

  if (
    !sameValue([...(before.validators ?? [])].sort(), [...(after.validators ?? [])].sort()) ||
    !sameValue([...(before.types ?? [])].sort(), [...(after.types ?? [])].sort())
  ) {
    changes.push({
      kind: 'GENERATORS_CHANGED',
      // Which downloads get produced. The hosted API is untouched, so no caller
      // of the API can notice.
      risk: 'INFO',
      aspect: 'none',
      before: { validators: before.validators, types: before.types },
      after: { validators: after.validators, types: after.types },
      summary: 'Generated output selection changed',
    });
  }

  return changes;
}

/* ────────────────────────── entry point ────────────────────────── */

/**
 * Every change between an active definition and a draft.
 *
 * Both sides are expected to carry stable ids — `ensureSchemaIds` runs when the
 * draft is forked. An element without an id can only ever be reported as an
 * addition or a removal, never as a modification, because there is nothing to
 * pair it with.
 *
 * Order is stable and document-ordered: config first, then entities in draft
 * order, so a rendered list does not reshuffle between reads.
 */
export function diffSchemas(
  active: InternalProjectSchema,
  draft: InternalProjectSchema,
): SchemaChange[] {
  const changes: SchemaChange[] = [...diffConfig(active.generationConfig, draft.generationConfig)];

  const activeById = byId(active.entities ?? []);
  const draftById = byId(draft.entities ?? []);

  for (const [id, entity] of draftById) {
    const previous = activeById.get(id);
    if (!previous) {
      changes.push({
        entityId: id,
        entityName: entity.name,
        kind: 'ENTITY_ADDED',
        risk: 'SAFE',
        aspect: 'routing',
        after: { name: entity.name },
        summary: `Entity ${entity.name} added`,
      });
      continue;
    }

    if (previous.name !== entity.name) {
      changes.push({
        entityId: id,
        entityName: entity.name,
        kind: 'ENTITY_RENAMED',
        // The hosted route is derived from the entity name
        // (`ENTITY_PATH = name.toLowerCase()`), so a rename MOVES every endpoint
        // for this entity. Callers holding the old URL get a 404. Stable ids keep
        // the dependency graph intact; they do not keep the URL intact.
        risk: 'ROUTING',
        aspect: 'routing',
        before: previous.name,
        after: entity.name,
        summary: `Entity ${previous.name} renamed to ${entity.name} — its endpoint paths move`,
      });
    }

    if ((previous.description ?? null) !== (entity.description ?? null)) {
      changes.push({
        entityId: id,
        entityName: entity.name,
        kind: 'ENTITY_DESCRIPTION_CHANGED',
        risk: 'INFO',
        // Documentation text only. No request, response or route changes.
        aspect: 'none',
        before: previous.description ?? null,
        after: entity.description ?? null,
        summary: `Description for ${entity.name} changed`,
      });
    }

    if (!sameValue(previous.identity, entity.identity)) {
      changes.push({
        entityId: id,
        entityName: entity.name,
        kind: 'ENTITY_IDENTITY_CHANGED',
        // The identity field is what item URLs address and what relations point
        // at, so this reshapes routes and joins together.
        risk: 'ROUTING',
        aspect: 'routing',
        before: previous.identity ?? null,
        after: entity.identity ?? null,
        summary: `Identity for ${entity.name} changed`,
      });
    }

    changes.push(...diffEntityFields(previous, entity));
    changes.push(...diffRelations(previous, entity));
  }

  for (const [id, entity] of activeById) {
    if (draftById.has(id)) {
      continue;
    }
    changes.push({
      entityId: id,
      entityName: entity.name,
      kind: 'ENTITY_REMOVED',
      risk: 'BREAKING',
      aspect: 'routing',
      before: { name: entity.name },
      summary: `Entity ${entity.name} removed — all of its endpoints go`,
    });
  }

  return changes;
}

/** The worst risk present, or null for an empty set. */
export function highestRisk(changes: readonly SchemaChange[]): ChangeRisk | null {
  let worst: ChangeRisk | null = null;
  for (const change of changes) {
    if (worst === null || RISK_RANK[change.risk] > RISK_RANK[worst]) {
      worst = change.risk;
    }
  }
  return worst;
}

/**
 * True when any change demands action from existing callers.
 *
 * `WARNING` counts. It means "some of your callers break", and a confirmation
 * dialog that only warns on `BREAKING` would wave through making a field
 * required — which rejects every request body that omitted it.
 */
export function needsAttention(changes: readonly SchemaChange[]): boolean {
  return changes.some((change) => RISK_RANK[change.risk] >= RISK_RANK['WARNING']);
}

/** Counts by risk, for a summary line. */
export function summariseChanges(changes: readonly SchemaChange[]): Record<ChangeRisk, number> {
  const counts: Record<ChangeRisk, number> = {
    SAFE: 0,
    INFO: 0,
    WARNING: 0,
    ROUTING: 0,
    BREAKING: 0,
  };
  for (const change of changes) {
    counts[change.risk] += 1;
  }
  return counts;
}
