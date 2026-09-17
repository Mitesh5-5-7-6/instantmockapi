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
 *   - `routing` — the endpoint's own path moves, **or whether it can be called
 *     at all changes**. Entity renames do the first, because the hosted route is
 *     derived from the entity name; authentication changes do the second.
 *
 * Without the aspect, an `age` type change would mark `DELETE /users/{id}` as
 * affected — and the spec is explicit that it must not.
 *
 * That exclusion is also why authentication uses `routing` rather than `both`.
 * `both` resolves to the `read`/`write` entity→endpoint edges, which omit DELETE
 * by design; protecting an entity under `both` would report every method except
 * the destructive one, and would additionally drag in the schema generators and
 * reseed the mock store. `routing` is emitted for every row and stops at the
 * surface. See `diffAuth`.
 *
 * ## What this module deliberately does not do
 *
 * It reports changes; it does not judge validity (that is `validateIPS`) and it
 * does not know what an endpoint is (that is `impact.ts`). Keeping it ignorant of
 * endpoints is what lets it be a pure function of two schemas.
 */

import type {
  Entity,
  EntityAuth,
  Field,
  InternalProjectSchema,
  Relation,
  ValidationRules,
} from './types.js';
import { entityAuth, projectAuth } from './auth.js';
import {
  describeUnknownFields,
  unknownFieldPolicy,
  unknownFieldsDirection,
} from './unknown-fields.js';
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
  'RELATION_RENAMED',
  'RELATION_KIND_CHANGED',
  'RELATION_TARGET_CHANGED',
  'RELATION_FIELDS_CHANGED',
  'RELATION_ON_DELETE_CHANGED',
  'RELATION_REQUIRED_CHANGED',
  'METHODS_CHANGED',
  'QUERY_FEATURES_CHANGED',
  'UNKNOWN_FIELDS_CHANGED',
  'MOCK_RECORDS_CHANGED',
  'GENERATORS_CHANGED',
  /* Authentication (Phase 3 §17). Six kinds rather than one
   * `AUTHENTICATION_CHANGED`, because their risks genuinely differ: turning a
   * project protected breaks every caller, while lengthening a token lifetime
   * breaks nobody. One kind would have to take the worst of them and would
   * report a TTL edit as breaking. */
  'AUTH_MODE_CHANGED',
  'ENTITY_AUTH_CHANGED',
  'AUTH_ENDPOINTS_CHANGED',
  'AUTH_COOKIE_CHANGED',
  'AUTH_TOKEN_EXPIRY_CHANGED',
  'AUTH_USER_FIELDS_CHANGED',
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
  /**
   * Every entity a **project-level** change reaches, when that set is
   * computable and smaller than "all of them".
   *
   * One row in the diff, many endpoints in the impact report — the same split a
   * field change already gets, and the reason it exists here is that the two
   * requirements pull in opposite directions. §37 forbids the wall of rows a
   * per-entity diff of `ALL_PUBLIC → ALL_PROTECTED` would produce; the impact
   * report has to enumerate anyway, or the affected list reads `0 APIs` for the
   * most breaking change the product can make, and every endpoint appears under
   * "No impact" as a confident and false claim.
   *
   * Only the diff can compute this: it is the difference between two resolved
   * states, and `analyseImpact` holds a graph built from one side only.
   */
  entityIds?: string[];
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
  /**
   * How the two sides of this change were paired up. Absent means `'id'`.
   *
   * Only ever `'name'` when diffing with `match: 'auto'` — i.e. comparing
   * version snapshots that predate stable ids. It is per-change rather than
   * per-report on purpose: one entity can be id-matched while its neighbour is
   * name-matched, and the warning belongs on the group that earned it rather
   * than over the whole page.
   *
   * A `'name'` pairing means **a rename cannot have been detected**: the names
   * are equal by construction, so a renamed element appears as one removal plus
   * one addition. Anything rendering these must say so.
   */
  matchedBy?: MatchBasis;
}

/* ────────────────────────── helpers ────────────────────────── */

/**
 * Facts about the diff as a whole that a per-element comparison needs.
 *
 * Only one so far: which entities were renamed. `Relation.target` and
 * `FieldMeta.relation` hold entity **names**, so renaming `Product` to `Item`
 * *also* moves every inbound relation's target and every derived foreign key's
 * `meta.relation`. Compared element by element those look like a retarget and a
 * metadata edit — `RELATION_TARGET_CHANGED` at BREAKING, once per inbound
 * relation — when they are one rename that was already reported.
 *
 * On a schema with ten relations, one rename would otherwise produce eleven
 * breaking rows and raise the whole report from ROUTING to BREAKING. So the
 * echoes are demoted to INFO and attributed to the rename that caused them.
 *
 * **Demoted, not dropped.** Dropping them would mean the diff of two
 * definitions no longer explains the byte difference between them, and the next
 * person to compare the raw JSON finds a delta the diff never mentioned.
 *
 * This is what keeps `diffSchemas` a pure function of its two arguments: the
 * context is derived from those same two documents, not passed in from outside.
 */
interface DiffContext {
  /** Old entity name → new entity name, for entities whose stable id persisted. */
  renamedEntities: ReadonlyMap<string, string>;
  /** How elements are paired. See `MatchMode`. */
  match: MatchMode;
}

/**
 * The dependency-graph key for an element, so impact analysis can resolve it.
 *
 * **The `name:` shape is copied verbatim from `graph.ts`** (`entityNode(entity.id
 * ?? \`name:${entity.name}\`)` and its field/relation siblings). That is not
 * cosmetic: `changeCandidates` in `impact.ts` turns these ids into graph node
 * ids, so a name-matched change resolves to a real node only if the key matches
 * the one the graph minted. Diverge by a character and every name-matched change
 * lands in `unattributed` instead of naming the endpoints it affects.
 *
 * Only used in `'auto'` mode. In `'id'` mode an element without a stable id is
 * left with `undefined`, exactly as before — so the draft path, which backfills
 * ids first, is byte-identical to Phase 1.
 */
function entityKeyOf(ctx: DiffContext, entity: Entity): string | undefined {
  return entity.id ?? (ctx.match === 'auto' ? `name:${entity.name}` : undefined);
}

function fieldKeyOf(
  ctx: DiffContext,
  entity: Entity,
  field: Field,
  path: string,
): string | undefined {
  return field.id ?? (ctx.match === 'auto' ? `name:${entity.name}.${path}` : undefined);
}

function relationKeyOf(ctx: DiffContext, entity: Entity, relation: Relation): string | undefined {
  return relation.id ?? (ctx.match === 'auto' ? `name:${entity.name}.${relation.name}` : undefined);
}

/** `matchedBy` only when it is worth saying — absent means `'id'`. */
function basis(by: MatchBasis): { matchedBy?: MatchBasis } {
  return by === 'name' ? { matchedBy: 'name' } : {};
}

/** Whether a before/after pair is exactly the echo of a reported entity rename. */
function isRenameEcho(ctx: DiffContext, before: unknown, after: unknown): boolean {
  return (
    typeof before === 'string' &&
    typeof after === 'string' &&
    ctx.renamedEntities.get(before) === after
  );
}

/**
 * Whether `meta` differs *only* by a `relation` key that followed a rename.
 *
 * The narrowness is the point. A field whose `unique` flag changed in the same
 * edit as a rename must keep its real risk — so this compares the two metas with
 * `relation` held equal, and demotes only when nothing else moved.
 */
function onlyRelationMetaChanged(
  ctx: DiffContext,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  if (!isRenameEcho(ctx, before['relation'], after['relation'])) {
    return false;
  }
  const { relation: _b, ...restBefore } = before;
  const { relation: _a, ...restAfter } = after;
  return sameValue(restBefore, restAfter);
}

/** What an added or removed entity contained, for the comparison view. */
export interface EntityShape {
  name: string;
  fields: { id?: string; name: string; type: string; required: boolean }[];
  relations: { id?: string; name: string; kind: string; target: string }[];
}

/**
 * An added or removed entity's contents, carried on the change itself.
 *
 * `ENTITY_ADDED` used to carry `{ name }` and nothing else, so a comparison view
 * could say "Customer added" but never what it contained — and §10 of the spec
 * wants that expandable.
 *
 * Carried as a **payload** rather than as per-field `FIELD_ADDED` changes, and
 * that is deliberate: `diffSchemas` skips the field loop entirely for a new
 * entity, because a 51-field entity would otherwise emit 52 rows for one
 * addition. That is exactly the "50 separate flat change rows" §37 forbids, and
 * it would double-count every summary — the entity and each of its fields.
 */
function entityShape(entity: Entity): EntityShape {
  return {
    name: entity.name,
    fields: (entity.fields ?? []).map((field) => ({
      ...(field.id === undefined ? {} : { id: field.id }),
      name: field.name,
      type: field.type,
      required: field.required,
    })),
    relations: (entity.relations ?? []).map((relation) => ({
      ...(relation.id === undefined ? {} : { id: relation.id }),
      name: relation.name,
      kind: relation.kind,
      target: relation.target,
    })),
  };
}

/** How the two sides of a pair were matched up. */
export type MatchBasis = 'id' | 'name';

/**
 * How to pair the two sides.
 *
 * `'id'` — stable ids only, and anything without one is invisible. The Phase 1
 * behaviour, and correct for a draft, because `POST /draft` backfills ids on
 * the active definition first so both sides are guaranteed to carry them.
 *
 * `'auto'` — ids first, then names for whatever is left over. Required for
 * comparing **version snapshots**, which may predate the id backfill entirely.
 * Under `'id'`, two such snapshots diff to *nothing* — `byId` skips every
 * id-less entity on both sides — and a comparison view would render that as
 * "no changes detected", which is a confident lie.
 */
export type MatchMode = 'id' | 'auto';

export interface DiffOptions {
  match?: MatchMode;
}

interface Pairing<T> {
  matched: { before: T; after: T; by: MatchBasis }[];
  /** Present only on the `after` side. */
  addedOnly: T[];
  /** Present only on the `before` side. */
  removedOnly: T[];
  /** True when any pair was resolved by name rather than by id. */
  usedNames: boolean;
}

/**
 * Pair two sibling lists, by id and then — in `'auto'` — by name.
 *
 * Two passes rather than one key map, because the common case is *partially*
 * identified: `materializeRelations` regenerates the identity field and every
 * derived foreign key with no id on both sides, so even a fully backfilled
 * project has unidentified elements once a snapshot is materialized for
 * comparison. A single map keyed on `id ?? name` would then pair an id-carrying
 * element on one side against a name-keyed one on the other only by accident.
 *
 * Order is preserved: `matched` follows the `after` list, which is what keeps
 * the rendered change list document-ordered.
 */
function pair<T>(
  before: readonly T[],
  after: readonly T[],
  idOf: (item: T) => string | undefined,
  nameOf: (item: T) => string,
  mode: MatchMode,
): Pairing<T> {
  const result: Pairing<T> = { matched: [], addedOnly: [], removedOnly: [], usedNames: false };

  const beforeById = new Map<string, T>();
  for (const item of before) {
    const id = idOf(item);
    if (typeof id === 'string' && id !== '') {
      beforeById.set(id, item);
    }
  }

  const claimed = new Set<T>();
  const leftoverAfter: T[] = [];

  // Pass 1 — stable id.
  for (const item of after) {
    const id = idOf(item);
    const partner = typeof id === 'string' && id !== '' ? beforeById.get(id) : undefined;
    if (partner === undefined) {
      leftoverAfter.push(item);
      continue;
    }
    result.matched.push({ before: partner, after: item, by: 'id' });
    claimed.add(partner);
  }

  if (mode === 'id') {
    // Anything unmatched on the after side is an addition, but only if it could
    // have been matched at all. An element with no id is skipped rather than
    // reported — see the call sites, which each decide what "skipped" means.
    result.addedOnly = leftoverAfter;
    result.removedOnly = before.filter((item) => !claimed.has(item));
    return result;
  }

  // Pass 2 — name, among what each side has left.
  const beforeByName = new Map<string, T>();
  for (const item of before) {
    if (!claimed.has(item)) {
      const name = nameOf(item);
      // First wins. Duplicate names are invalid per `validateIPS`, so this only
      // arises on a document that could not have been saved.
      if (!beforeByName.has(name)) {
        beforeByName.set(name, item);
      }
    }
  }

  for (const item of leftoverAfter) {
    const partner = beforeByName.get(nameOf(item));
    if (partner === undefined || claimed.has(partner)) {
      result.addedOnly.push(item);
      continue;
    }
    result.matched.push({ before: partner, after: item, by: 'name' });
    claimed.add(partner);
    result.usedNames = true;
  }

  result.removedOnly = before.filter((item) => !claimed.has(item));
  return result;
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

export type ValidationKey = (typeof VALIDATION_KEYS)[number];

/** Whether a validation rule got stricter, looser, or neither knowably. */
export type ValidationDirection = 'tightened' | 'relaxed' | 'unknown';

function numberOr(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `arrayLength` is a `{min, max}` pair rather than a scalar. */
function boundOf(value: unknown, key: 'min' | 'max'): number | null {
  return value !== null && typeof value === 'object'
    ? numberOr((value as Record<string, unknown>)[key])
    : null;
}

/**
 * Which way a validation rule moved.
 *
 * Exported and used by **both** risk (here) and the three-value impact
 * projection in `classification.ts`. One reader of the evidence, so the two
 * axes cannot give different answers about the same edit — the alternative was
 * the commit dialog calling a relaxed bound "needs attention" while the compare
 * page called it non-breaking.
 *
 * `unknown` is a real answer, not a failure. A changed `regex` can be either
 * direction and deciding which would need to compare the languages two patterns
 * accept; the honest report is "we cannot tell", which resolves to the cautious
 * side at both call sites.
 */
export function validationDirection(
  key: ValidationKey,
  before: unknown,
  after: unknown,
): ValidationDirection {
  const absent = (value: unknown): boolean =>
    value === undefined || value === null || value === false;

  // Appearing tightens, disappearing relaxes — for every key. A `message` is
  // the exception in spirit (it is only visible in an error body) but follows
  // the same shape, and treating it as relaxed either way is handled below.
  if (key === 'message') {
    return 'relaxed';
  }
  if (absent(before) && !absent(after)) {
    return 'tightened';
  }
  if (!absent(before) && absent(after)) {
    return 'relaxed';
  }

  switch (key) {
    case 'email':
    case 'url':
    case 'uuid':
      // Both present and both truthy — nothing moved that we can score.
      return 'unknown';
    case 'regex':
      // Deciding this needs to compare the languages two patterns accept.
      return 'unknown';
    case 'length': {
      // An exact length is a narrowing whichever way it moves: values of the
      // old length are now rejected regardless of direction.
      return 'tightened';
    }
    case 'min': {
      const from = numberOr(before);
      const to = numberOr(after);
      if (from === null || to === null) {
        return 'unknown';
      }
      return to > from ? 'tightened' : 'relaxed';
    }
    case 'max': {
      const from = numberOr(before);
      const to = numberOr(after);
      if (from === null || to === null) {
        return 'unknown';
      }
      return to < from ? 'tightened' : 'relaxed';
    }
    case 'arrayLength': {
      const minFrom = boundOf(before, 'min');
      const minTo = boundOf(after, 'min');
      const maxFrom = boundOf(before, 'max');
      const maxTo = boundOf(after, 'max');

      // Either bound closing in tightens the rule, and that outranks the other
      // bound opening out — a tighter floor rejects arrays that used to pass
      // however generous the ceiling became.
      const tightened =
        (minFrom !== null && minTo !== null && minTo > minFrom) ||
        (maxFrom !== null && maxTo !== null && maxTo < maxFrom) ||
        (minFrom === null && minTo !== null) ||
        (maxFrom === null && maxTo !== null);
      if (tightened) {
        return 'tightened';
      }
      const relaxed =
        (minFrom !== null && minTo !== null && minTo < minFrom) ||
        (maxFrom !== null && maxTo !== null && maxTo > maxFrom) ||
        (minFrom !== null && minTo === null) ||
        (maxFrom !== null && maxTo === null);
      return relaxed ? 'relaxed' : 'unknown';
    }
  }
}

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

function diffField(
  ctx: DiffContext,
  entity: Entity,
  before: Field,
  after: Field,
  path: string,
  by: MatchBasis = 'id',
): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const entityId = entityKeyOf(ctx, entity);
  const fieldId = fieldKeyOf(ctx, entity, after, path);
  const at = {
    ...(entityId === undefined ? {} : { entityId }),
    entityName: entity.name,
    ...(fieldId === undefined ? {} : { fieldId }),
    fieldName: after.name,
    ...(path === after.name ? {} : { path }),
    ...basis(by),
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
      /*
       * Scored on which WAY the rule moved, not merely on whether it moved.
       *
       * This used to be a flat `WARNING` for anything but a removal, with a
       * comment admitting the direction "is not inferred — reporting a possible
       * break is the safe direction". But `SAFE` is defined a hundred lines up
       * as "strictly additive… a relaxed rule", so a loosened `max` scored
       * WARNING while the file's own vocabulary called it SAFE.
       *
       * `min: 8 → 3` cannot reject a body that used to pass, so it no longer
       * demands acknowledgement at commit. `unknown` — a changed `regex` — stays
       * WARNING, which is the cautious side of a genuine cannot-tell.
       */
      risk: validationDirection(key, from, to) === 'relaxed' ? 'SAFE' : 'WARNING',
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
    // `meta.relation` names the target entity, so a derived foreign key's
    // metadata moves whenever that entity is renamed. When that is the ONLY
    // difference, this row is the rename's echo rather than a metadata edit —
    // and there is one per foreign key pointing at the renamed entity.
    const echo = onlyRelationMetaChanged(ctx, before.meta, after.meta);
    changes.push({
      ...at,
      kind: 'FIELD_META_CHANGED',
      // `unique` and `searchable` change what the hosted query layer accepts and
      // what a write may collide on, but no response shape moves.
      risk: echo ? 'INFO' : 'SAFE',
      aspect: echo ? 'none' : 'write',
      before: before.meta,
      after: after.meta,
      summary: echo
        ? `${entity.name}.${after.name} follows the rename of ${String(before.meta['relation'])} to ${String(after.meta['relation'])}`
        : `Metadata on ${entity.name}.${after.name} changed`,
    });
  }

  return changes;
}

/* ────────────────────────── entity diff ────────────────────────── */

function diffEntityFields(ctx: DiffContext, before: Entity, after: Entity): SchemaChange[] {
  const changes: SchemaChange[] = [];

  // Paired on the DOTTED PATH, not the bare name — so a nested `address.id`
  // never pairs with the entity's own identity field.
  const beforeFlat = flattenFields(before.fields ?? []);
  const afterFlat = flattenFields(after.fields ?? []);
  const fields = pair(
    beforeFlat,
    afterFlat,
    (entry) => entry.field.id,
    (entry) => entry.path,
    ctx.match,
  );

  const entityId = entityKeyOf(ctx, after);
  const locate = (field: Field, path: string) => {
    const fieldId = fieldKeyOf(ctx, after, field, path);
    return {
      ...(entityId === undefined ? {} : { entityId }),
      entityName: after.name,
      ...(fieldId === undefined ? {} : { fieldId }),
      fieldName: field.name,
      ...(path === field.name ? {} : { path }),
    };
  };

  for (const { before: previous, after: field, by } of fields.matched) {
    changes.push(...diffField(ctx, after, previous.field, field.field, field.path, by));
  }

  for (const { field, path } of fields.addedOnly) {
    changes.push({
      ...locate(field, path),
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
  }

  for (const { field, path } of fields.removedOnly) {
    // In 'id' mode, skip anything unmatchable: a field with no id cannot be
    // paired, and reporting it as REMOVED would be a lie about an un-backfilled
    // schema — the field is very likely still there, just unidentified.
    // 'auto' pairs it by path, so a leftover there really is gone.
    if (ctx.match === 'id' && field.id === undefined) {
      continue;
    }
    changes.push({
      ...locate(field, path),
      kind: 'FIELD_REMOVED',
      risk: 'BREAKING',
      aspect: 'both',
      before: { name: field.name, type: field.type },
      summary: `Field ${after.name}.${field.name} removed`,
    });
  }

  return changes;
}

function diffRelations(ctx: DiffContext, before: Entity, after: Entity): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const relations = pair(
    before.relations ?? [],
    after.relations ?? [],
    (relation) => relation.id,
    (relation) => relation.name,
    ctx.match,
  );

  const entityId = entityKeyOf(ctx, after);
  const at = (relation: Relation, by: MatchBasis = 'id') => {
    const relationId = relationKeyOf(ctx, after, relation);
    return {
      ...(entityId === undefined ? {} : { entityId }),
      entityName: after.name,
      ...(relationId === undefined ? {} : { relationId }),
      relationName: relation.name,
      ...basis(by),
    };
  };

  for (const relation of relations.addedOnly) {
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
  }

  for (const { before: previous, after: relation, by } of relations.matched) {
    if (previous.name !== relation.name) {
      changes.push({
        ...at(relation, by),
        kind: 'RELATION_RENAMED',
        /*
         * BREAKING, and unconditionally so.
         *
         * `relation.name` is the `?include=` key AND the property the expansion
         * lands on in the response. The hosted runtime **rejects an unknown
         * include with a 400** rather than ignoring it, so `?include=oldName`
         * fails hard the moment this ships. That is `RELATION_REMOVED`'s
         * justification verbatim, so the two keep the same risk — there is a
         * case for WARNING (only callers that pass `?include=` are hit, and only
         * when the feature is on) but it applies equally to both, and moving one
         * without the other is worse than either choice.
         */
        risk: 'BREAKING',
        /*
         * `read`, deliberately narrower than the `both` its siblings use.
         *
         * A relation node emits only `read` and `query` edges in the dependency
         * graph, and a rename leaves `localField` alone — the stored foreign key
         * and every request body are untouched, so `both` would over-claim and
         * mark POST/PUT/PATCH affected for no reason.
         *
         * `RELATION_ADDED`/`REMOVED` legitimately use `both` for a different
         * reason: their node is absent from one side's graph, so impact falls
         * through to the ENTITY node, where `both` correctly picks up the writes
         * that gain or lose the derived key. A renamed relation's node is present
         * on both sides. Not an inconsistency — do not "fix" it.
         */
        aspect: 'read',
        before: previous.name,
        after: relation.name,
        summary: `Relation ${after.name}.${previous.name} renamed to ${relation.name} — '?include=${previous.name}' stops resolving`,
      });
    }
    if (previous.kind !== relation.kind) {
      changes.push({
        ...at(relation, by),
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
      // Following a rename, not being repointed at a different entity. The
      // relation still resolves to the same records; only the name it is spelled
      // with moved, and `ENTITY_RENAMED` already reported that at ROUTING.
      const echo = isRenameEcho(ctx, previous.target, relation.target);
      changes.push({
        ...at(relation, by),
        kind: 'RELATION_TARGET_CHANGED',
        risk: echo ? 'INFO' : 'BREAKING',
        aspect: echo ? 'none' : 'both',
        before: previous.target,
        after: relation.target,
        summary: echo
          ? `Relation ${after.name}.${relation.name} follows the rename of ${previous.target} to ${relation.target}`
          : `Relation ${after.name}.${relation.name} retargeted from ${previous.target} to ${relation.target}`,
      });
    }
    if (
      previous.localField !== relation.localField ||
      previous.foreignField !== relation.foreignField
    ) {
      changes.push({
        ...at(relation, by),
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
        ...at(relation, by),
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
        ...at(relation, by),
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

  for (const relation of relations.removedOnly) {
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

  const beforeUnknown = unknownFieldPolicy(before);
  const afterUnknown = unknownFieldPolicy(after);
  if (beforeUnknown !== afterUnknown) {
    const direction = unknownFieldsDirection(beforeUnknown, afterUnknown);
    changes.push({
      kind: 'UNKNOWN_FIELDS_CHANGED',
      /*
       * Three directions, three risks — the reason this is not a flat `SAFE`
       * like the query toggles above. Narrowing to `reject` fails requests that
       * worked, which is unconditional breakage. `allow` → `strip` fails
       * nothing and is the more dangerous of the two to miss: extra keys simply
       * stop coming back, so a client notices when data is already gone rather
       * than when a request 422s.
       */
      risk: direction === 'narrowing' ? 'BREAKING' : direction === 'lossy' ? 'WARNING' : 'SAFE',
      // Bodies on the way in and on the way back out, so neither `read` nor
      // `write` alone covers it.
      aspect: 'both',
      // The resolved policies, not the raw fields: a document that never
      // carried the setting must diff as `allow`, not as `null`.
      before: beforeUnknown,
      after: afterUnknown,
      summary: `Undeclared body fields are now ${describeUnknownFields(afterUnknown)} (was ${describeUnknownFields(beforeUnknown)})`,
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

/* ────────────────────────── authentication diff ──────────────────────────
 *
 * Phase 3 §17. Every one of these is a change to the *generated* API's
 * authentication — never the platform's.
 */

/**
 * Which way a protection requirement moved.
 *
 * Exported and read by **both** the risk choice here and the three-value impact
 * projection in `classification.ts`, following `validationDirection`'s
 * precedent exactly. One reader of the evidence, so the commit dialog and the
 * compare page cannot disagree about the same edit.
 *
 * The asymmetry is the whole content of the type:
 *
 * - `tightened` — a caller that worked now gets 401. Unconditionally broken,
 *   for every caller of that endpoint, immediately.
 * - `relaxed` — a token is no longer required. Nothing that worked stops
 *   working: an unnecessary `Authorization` header is ignored, not rejected.
 *   This is `SAFE` in the sense `changes.ts` already defines, and calling it
 *   breaking would train people to ignore the label.
 *
 * A relaxation is still worth *seeing* — it exposes data that was protected —
 * but that is a security review, not a compatibility break, and conflating the
 * two is how a genuine outage gets the same chip as a deliberate opening.
 */
export type AuthDirection = 'tightened' | 'relaxed' | 'unchanged';

export function authDirection(before: EntityAuth, after: EntityAuth): AuthDirection {
  if (before === after) {
    return 'unchanged';
  }
  return after === 'PROTECTED' ? 'tightened' : 'relaxed';
}

/**
 * The protection every entity ends up with, so a mode change can be reported
 * once rather than as one row per entity.
 *
 * `ALL_PUBLIC → ALL_PROTECTED` on a twelve-entity project is one decision. §37
 * forbids the wall of rows the naive per-entity diff would produce, and the
 * mode row already says what happened — the entity rows would be its echo, the
 * same relation-cascade problem Phase 2 solved by attributing to the cause.
 */
function authOf(ips: InternalProjectSchema, entity: Pick<Entity, 'authentication'>): EntityAuth {
  return entityAuth(projectAuth(ips), entity);
}

function diffAuth(
  active: InternalProjectSchema,
  draft: InternalProjectSchema,
  entities: { matched: { before: Entity; after: Entity; by: MatchBasis }[] },
  ctx: DiffContext,
): SchemaChange[] {
  const before = projectAuth(active);
  const after = projectAuth(draft);
  const changes: SchemaChange[] = [];

  if (before.mode !== after.mode) {
    /*
     * Which entities the mode change actually moved, and which way.
     *
     * Computed from the *matched* pairs, so an entity added or removed in the
     * same edit is left to its own ENTITY_ADDED/REMOVED row rather than being
     * counted twice.
     */
    const movements = entities.matched.map(({ before: previous, after: next }) => ({
      entity: next,
      direction: authDirection(authOf(active, previous), authOf(draft, next)),
    }));

    /*
     * The project-level direction is "did anything get tightened", not "is
     * anything protected".
     *
     * The coarser reading — comparing whether *any* entity was protected before
     * against whether *any* is now — calls `COMBINATION → ALL_PROTECTED`
     * unchanged whenever a single entity was already protected, because both
     * sides answer yes. That collapses to `aspect: 'none'` and the change stops
     * reaching any endpoint at all.
     *
     * `NONE → ALL_PUBLIC` still comes out unchanged, which is the case worth
     * preserving: it adds an Auth API and protects nothing, so calling it
     * breaking would report a breaking change that breaks nobody.
     */
    const direction: AuthDirection = movements.some((move) => move.direction === 'tightened')
      ? 'tightened'
      : movements.some((move) => move.direction === 'relaxed')
        ? 'relaxed'
        : 'unchanged';

    /*
     * The moved entities travel with the change, so the impact report can
     * enumerate their endpoints while the diff shows one row.
     *
     * Only the ones that moved: `COMBINATION → ALL_PROTECTED` leaves an
     * already-protected entity exactly as it was, and listing its endpoints as
     * affected would cost the precision the no-impact list exists to
     * demonstrate.
     */
    const moved = movements
      .filter((move) => move.direction !== 'unchanged')
      .map((move) => entityKeyOf(ctx, move.entity))
      .filter((id): id is string => id !== undefined);

    changes.push({
      ...(moved.length > 0 ? { entityIds: moved } : {}),
      kind: 'AUTH_MODE_CHANGED',
      risk: direction === 'tightened' ? 'BREAKING' : direction === 'relaxed' ? 'SAFE' : 'INFO',
      /*
       * `routing`, not `both`, and this is not a technicality.
       *
       * `EdgeAspect` defines routing as "the target's URL, **or its
       * existence**, depends on the source" — and an auth change decides
       * whether the endpoint exists *for a given caller*. More concretely,
       * `both` resolves to the `read`/`write` entity→endpoint edges, and
       * `graph.ts` excludes DELETE from those on purpose (its contract is a
       * path parameter and an empty body, so a field change cannot reach it).
       *
       * Under `both` this would report GET, POST, PUT and PATCH as affected and
       * silently omit `DELETE /payment/{id}` — the one endpoint whose exposure
       * matters most. The `routing` edge is emitted for every row, DELETE
       * included.
       *
       * Independent of `risk`, which stays BREAKING rather than ROUTING: no
       * caller has a URL to update.
       */
      aspect: direction === 'unchanged' ? 'none' : 'routing',
      before: before.mode,
      after: after.mode,
      summary: `Authentication mode changed from ${before.mode} to ${after.mode}`,
    });
  }

  /*
   * Per-entity rows only while the mode itself held still.
   *
   * A mode change already accounts for every entity it moved, so emitting both
   * double-counts the summary and buries the one row that explains the rest.
   */
  if (before.mode === after.mode) {
    for (const { before: previous, after: entity, by } of entities.matched) {
      const direction = authDirection(authOf(active, previous), authOf(draft, entity));
      if (direction === 'unchanged') {
        continue;
      }
      const id = entityKeyOf(ctx, entity);
      changes.push({
        ...(id === undefined ? {} : { entityId: id }),
        entityName: entity.name,
        ...basis(by),
        kind: 'ENTITY_AUTH_CHANGED',
        risk: direction === 'tightened' ? 'BREAKING' : 'SAFE',
        // See `AUTH_MODE_CHANGED` above: `routing` is the only aspect that
        // reaches DELETE, and an auth change reaches every method.
        aspect: 'routing',
        before: authOf(active, previous),
        after: authOf(draft, entity),
        summary:
          direction === 'tightened'
            ? `${entity.name} now requires authentication`
            : `${entity.name} no longer requires authentication`,
      });
    }
  }

  const endpointsBefore = {
    signup: before.signup,
    signin: before.signin,
    refresh: before.refreshToken,
  };
  const endpointsAfter = {
    signup: after.signup,
    signin: after.signin,
    refresh: after.refreshToken,
  };
  if (!sameValue(endpointsBefore, endpointsAfter)) {
    const removed = (['signup', 'signin', 'refresh'] as const).filter(
      (name) => endpointsBefore[name] && !endpointsAfter[name],
    );
    changes.push({
      kind: 'AUTH_ENDPOINTS_CHANGED',
      // These endpoints EXIST or do not, so removing one 404s a URL callers
      // were using — the same reasoning `METHODS_CHANGED` applies.
      risk: removed.length > 0 ? 'BREAKING' : 'SAFE',
      aspect: 'routing',
      before: endpointsBefore,
      after: endpointsAfter,
      summary:
        removed.length > 0
          ? `Auth endpoints removed: ${removed.join(', ')}`
          : 'Auth endpoints changed',
    });
  }

  if (before.cookieAuth !== after.cookieAuth) {
    changes.push({
      kind: 'AUTH_COOKIE_CHANGED',
      /*
       * Breaking in both directions, unusually.
       *
       * Turning cookies ON can stop returning tokens in the signin body, so a
       * client reading `response.accessToken` gets undefined. Turning them OFF
       * leaves a browser client with no credential at all, because it never
       * held the token. Either way the client's way of authenticating stops
       * working, which is the definition the file uses.
       */
      risk: 'BREAKING',
      aspect: 'both',
      before: before.cookieAuth,
      after: after.cookieAuth,
      summary: after.cookieAuth
        ? 'Cookie authentication enabled'
        : 'Cookie authentication disabled',
    });
  }

  if (
    before.accessTokenExpiresIn !== after.accessTokenExpiresIn ||
    before.refreshTokenExpiresIn !== after.refreshTokenExpiresIn
  ) {
    changes.push({
      kind: 'AUTH_TOKEN_EXPIRY_CHANGED',
      // No endpoint, shape or contract moves — a caller that refreshes on 401
      // cannot tell. §17 still requires it in the history, which is why it is
      // a change at all rather than an untracked runtime setting.
      risk: 'INFO',
      aspect: 'none',
      before: {
        accessTokenExpiresIn: before.accessTokenExpiresIn,
        refreshTokenExpiresIn: before.refreshTokenExpiresIn,
      },
      after: {
        accessTokenExpiresIn: after.accessTokenExpiresIn,
        refreshTokenExpiresIn: after.refreshTokenExpiresIn,
      },
      summary: 'Token lifetimes changed',
    });
  }

  if (!sameValue(before.userFields, after.userFields)) {
    const addedRequired = after.userFields.filter(
      (field) =>
        field.required && !before.userFields.some((existing) => existing.name === field.name),
    );
    const removed = before.userFields.filter(
      (field) => !after.userFields.some((existing) => existing.name === field.name),
    );
    changes.push({
      kind: 'AUTH_USER_FIELDS_CHANGED',
      /*
       * The signup request body. A new *required* field 422s every existing
       * signup call; a removed one stops being accepted. A new optional field
       * is strictly additive — the same three-way reading `FIELD_ADDED` gets,
       * and the reason this is not a flat BREAKING.
       */
      risk: addedRequired.length > 0 || removed.length > 0 ? 'BREAKING' : 'SAFE',
      aspect: 'write',
      before: before.userFields,
      after: after.userFields,
      summary:
        addedRequired.length > 0
          ? `Signup now requires: ${addedRequired.map((field) => field.name).join(', ')}`
          : removed.length > 0
            ? `Signup fields removed: ${removed.map((field) => field.name).join(', ')}`
            : 'Signup fields changed',
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
  options: DiffOptions = {},
): SchemaChange[] {
  const changes: SchemaChange[] = [...diffConfig(active.generationConfig, draft.generationConfig)];

  const match = options.match ?? 'id';
  const entities = pair(
    active.entities ?? [],
    draft.entities ?? [],
    (entity) => entity.id,
    (entity) => entity.name,
    match,
  );

  // A pre-pass, because a relation's target echo can only be recognised once
  // every rename in the whole document is known — the entity that was renamed
  // may be declared after the entity that relates to it.
  const renamedEntities = new Map<string, string>();
  for (const { before, after } of entities.matched) {
    if (before.name !== after.name) {
      renamedEntities.set(before.name, after.name);
    }
  }
  const ctx: DiffContext = { renamedEntities, match };

  /*
   * Authentication, after the config and before the entities.
   *
   * It needs `entities.matched` — a per-entity protection change has to be
   * reported against the entity that survived, and pairing is what identifies
   * it — so this cannot live in `diffConfig`, which sees only the two configs.
   *
   * Ordered here so the rendered list reads outside-in: what the whole project
   * generates, then who can call it, then what the shapes are.
   */
  changes.push(...diffAuth(active, draft, entities, ctx));

  for (const entity of entities.addedOnly) {
    // In 'id' mode an entity with no id is skipped rather than reported: it is
    // very likely still there, just unidentified, and calling it an addition
    // would be a lie about an un-backfilled schema. 'auto' has a name to fall
    // back on, so nothing is skipped there.
    if (match === 'id' && entity.id === undefined) {
      continue;
    }
    changes.push({
      ...(entityKeyOf(ctx, entity) === undefined ? {} : { entityId: entityKeyOf(ctx, entity)! }),
      entityName: entity.name,
      kind: 'ENTITY_ADDED',
      risk: 'SAFE',
      aspect: 'routing',
      after: entityShape(entity),
      summary: `Entity ${entity.name} added`,
    });
  }

  for (const { before: previous, after: entity, by } of entities.matched) {
    const id = entityKeyOf(ctx, entity);
    const at = {
      ...(id === undefined ? {} : { entityId: id }),
      entityName: entity.name,
      ...basis(by),
    };

    if (previous.name !== entity.name) {
      changes.push({
        ...at,
        kind: 'ENTITY_RENAMED',
        // The hosted route is derived from the entity name
        // (`entitySlug` in `shared/routing.ts`), so a rename MOVES every endpoint
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
        ...at,
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
        ...at,
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

    changes.push(...diffEntityFields(ctx, previous, entity));
    changes.push(...diffRelations(ctx, previous, entity));
  }

  for (const entity of entities.removedOnly) {
    if (match === 'id' && entity.id === undefined) {
      continue;
    }
    const removedId = entityKeyOf(ctx, entity);
    changes.push({
      ...(removedId === undefined ? {} : { entityId: removedId }),
      entityName: entity.name,
      kind: 'ENTITY_REMOVED',
      risk: 'BREAKING',
      aspect: 'routing',
      before: entityShape(entity),
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
