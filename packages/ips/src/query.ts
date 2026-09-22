/**
 * Query-layer feature toggles and field selection (doc 19 §Phase 4).
 *
 * The hosted API's `?search` / `?filter` / `?sort` / `?include` surface is
 * opt-in per project. This module owns two things:
 *
 *  1. **The toggle set** — what may be switched on, and what an absent toggle
 *     block means (nothing enabled; see `resolveQueryFeatures`).
 *  2. **Which fields participate** — derived once here so the hosting generator
 *     can precompute the lists into its config *and* the OpenAPI/Postman
 *     generators can document exactly the same lists. Deriving it twice is how
 *     documentation starts lying about the API it documents.
 *
 * Nothing here reads a request. Turning a toggle on only widens what the runtime
 * will *accept*: a request that sends no query parameters returns byte-identical
 * output whether every feature is on or off, which is what makes enabling them
 * on an already-hosted project safe.
 */

import { entityRelations } from './relations.js';
import { QUERY_FEATURES } from './types.js';
import type {
  Entity,
  Field,
  FieldType,
  GenerationConfig,
  QueryFeature,
  QueryFeatures,
} from './types.js';

// The toggle vocabulary itself lives in types.ts, because `GenerationConfig`
// carries it — see the note there. Re-exported so this module stays the one
// place a caller has to import from for anything query-related.
export { QUERY_FEATURES, type QueryFeature, type QueryFeatures };

/**
 * Query keys the runtime interprets itself, and therefore never treats as a
 * field filter.
 *
 * Only keys that are actually implemented belong here: reserving a name we don't
 * honour would turn a typo into a silently-ignored parameter, which is the exact
 * failure the unknown-key rejection exists to prevent.
 */
export const RESERVED_QUERY_KEYS: readonly string[] = [
  'page',
  'limit',
  'search',
  'sort',
  'include',
];

/** Comparison suffixes a filter key may carry, e.g. `?price_gte=10`. */
export const FILTER_OPERATORS = ['ne', 'gt', 'gte', 'lt', 'lte', 'like', 'in'] as const;

export type FilterOperator = 'eq' | (typeof FILTER_OPERATORS)[number];

/** Every feature off — what a document written before this field existed means. */
export const NO_QUERY_FEATURES: QueryFeatures = Object.freeze({
  search: false,
  filter: false,
  sort: false,
  include: false,
});

/** Every feature on — the posture a newly created project starts from. */
export const ALL_QUERY_FEATURES: QueryFeatures = Object.freeze({
  search: true,
  filter: true,
  sort: true,
  include: true,
});

/**
 * Normalize an unknown `features` value into a complete toggle set.
 *
 * Absent, malformed, or partial input resolves to **off** for anything not
 * explicitly `true`. Old hosted configs and old IPS documents carry no toggles
 * at all, and they must keep answering requests exactly as they did before this
 * feature existed — so "missing" can only ever mean "off", never "on".
 */
export function resolveQueryFeatures(input: unknown): QueryFeatures {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ...NO_QUERY_FEATURES };
  }
  const raw = input as Record<string, unknown>;
  const features = { ...NO_QUERY_FEATURES };
  for (const feature of QUERY_FEATURES) {
    features[feature] = raw[feature] === true;
  }
  return features;
}

/** Toggle set of a generation config, defaulted for pre-feature documents. */
export function queryFeatures(
  config: Pick<GenerationConfig, 'features'> | null | undefined,
): QueryFeatures {
  return resolveQueryFeatures(config?.features);
}

/** True when at least one query feature is enabled. */
export function hasQueryFeatures(features: QueryFeatures): boolean {
  return QUERY_FEATURES.some((feature) => features[feature]);
}

/** Enabled feature names, in declaration order — for discovery documents. */
export function enabledQueryFeatures(features: QueryFeatures): QueryFeature[] {
  return QUERY_FEATURES.filter((feature) => features[feature]);
}

/**
 * Field types holding a single comparable value.
 *
 * `object` and `array` are excluded: comparing or ordering a subtree has no
 * single obvious meaning, so those fields are simply not queryable.
 */
const SCALAR_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'string',
  'number',
  'decimal',
  'integer',
  'boolean',
  'date',
  'email',
  'url',
  'uuid',
  'avatar',
  'enum',
]);

/**
 * Scalar types whose values read as human text, and so are worth searching.
 *
 * `avatar` is filterable and sortable above but **not** searchable: its value is
 * a generated URL full of trait names, so `?search=hat` would match every record
 * wearing one — a result nobody asked for and cannot explain.
 */
const TEXTUAL_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'string',
  'email',
  'url',
  'uuid',
  'enum',
]);

function topLevelFields(entity: Pick<Entity, 'fields'>): Field[] {
  return Array.isArray(entity.fields) ? entity.fields : [];
}

/**
 * Fields that may be filtered and ordered on: the entity's top-level scalars.
 *
 * Nested leaves are deliberately excluded. Supporting `?author.name=` would need
 * a path grammar in every consumer (runtime matcher, error messages, OpenAPI
 * parameter list) to serve a case the wizard cannot even express yet.
 */
export function queryableFields(entity: Pick<Entity, 'fields'>): string[] {
  return topLevelFields(entity)
    .filter((field) => SCALAR_TYPES.has(field.type))
    .map((field) => field.name);
}

/**
 * Fields `?search=` scans.
 *
 * Any field marked `meta.searchable` forms the whitelist — an explicit opt-in is
 * honoured for any scalar, since search compares the *string form* of a value
 * and that is well defined for numbers and dates too. With nothing marked, the
 * default is textual fields only: substring-matching a term against every id and
 * timestamp on the record produces coincidental hits, not useful ones.
 */
export function searchableFields(entity: Pick<Entity, 'fields'>): string[] {
  const scalars = topLevelFields(entity).filter((field) => SCALAR_TYPES.has(field.type));
  const opted = scalars.filter((field) => field.meta?.searchable === true);
  const chosen =
    opted.length > 0 ? opted : scalars.filter((field) => TEXTUAL_TYPES.has(field.type));
  return chosen.map((field) => field.name);
}

/** Relation names `?include=` may expand. */
export function includableRelations(entity: Pick<Entity, 'relations'>): string[] {
  return entityRelations(entity).map((relation) => relation.name);
}

/** The four field lists a hosted entity exposes to the query layer. */
export interface EntityQueryFields {
  searchable: string[];
  filterable: string[];
  sortable: string[];
  includable: string[];
}

/**
 * Every query-participating field list for an entity, precomputed together.
 *
 * `filterable` and `sortable` hold the same set today. They are emitted
 * separately anyway: both are derived from one call here so they cannot drift,
 * and a generated config that spells out each capability is readable on its own
 * terms by someone debugging a 400.
 */
export function entityQueryFields(entity: Pick<Entity, 'fields' | 'relations'>): EntityQueryFields {
  const queryable = queryableFields(entity);
  return {
    searchable: searchableFields(entity),
    filterable: queryable,
    sortable: [...queryable],
    includable: includableRelations(entity),
  };
}
