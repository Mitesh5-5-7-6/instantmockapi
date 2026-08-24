/**
 * The hosted API's query layer (doc 19 §Phase 4).
 *
 * Pure functions over records and a parsed query — no I/O, no Fastify, no
 * database — so every rule below is unit-testable in isolation, the same split
 * that `path.ts` uses for URL grammar. Relation expansion is the one step that
 * needs data it does not have, and it takes a loader rather than reaching for
 * one.
 *
 * ## Pipeline order
 *
 *   filter → search → sort → paginate → include
 *
 * Filter and search run first so `meta.total` counts what the caller asked for
 * rather than what the entity holds. Include runs **last, on the page slice
 * only**: expanding before pagination would resolve relations for records about
 * to be discarded, making the cost of `?include=` scale with the collection
 * instead of with the page.
 *
 * ## What a disabled feature does
 *
 * A reserved parameter (`search`, `sort`, `include`) sent to a project that has
 * that feature switched off is a **400 naming the toggle**, not a silent no-op —
 * the parameter is unambiguous evidence of intent, and quietly ignoring it is
 * how someone concludes the feature is broken. Arbitrary keys get the opposite
 * treatment: with filtering off they are ignored, because `?utm_source=x` is not
 * a failed filter attempt and cannot be told apart from one.
 *
 * Turning a feature on never changes an existing response. Every parameter here
 * is additive, so a request that sends none returns byte-identical output
 * whether all four toggles are on or off.
 */

import { AppError, type ErrorDetail } from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import {
  FILTER_OPERATORS,
  RESERVED_QUERY_KEYS,
  type EntityQueryFields,
  type FilterOperator,
  type QueryFeatures,
} from '@instantmockapi/ips';
import type { MockRecord } from './store.js';

/** Raw query object as Fastify hands it over: repeated keys arrive as arrays. */
export type RawQuery = Record<string, string | string[] | undefined>;

export interface FilterTerm {
  field: string;
  operator: FilterOperator;
  /**
   * The query value, left as text. Coercion is deliberately deferred to the
   * comparison against each record, because the same URL is served by records
   * that may hold `30` in one and `"30"` in another.
   */
  value: string;
  /** Split values, for `_in` only. */
  values: string[];
}

export interface SortTerm {
  field: string;
  direction: 1 | -1;
}

/** A fully validated query, ready to apply. */
export interface QueryPlan {
  page: number;
  limit: number;
  search: string | null;
  filters: FilterTerm[];
  sort: SortTerm[];
  includes: string[];
}

/** Field lists used when a hosted config predates the query layer: none. */
export const NO_QUERY_FIELDS: EntityQueryFields = {
  searchable: [],
  filterable: [],
  sortable: [],
  includable: [],
};

function badQuery(message: string, details?: ErrorDetail[]): AppError {
  return new AppError({
    code: 'VALIDATION_ERROR',
    statusCode: 400,
    message,
    ...(details ? { details } : {}),
  });
}

/** Renders an allowed-values list for an error message, or a clear "none". */
function options(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

/**
 * A parameter the runtime interprets may appear once.
 *
 * Repeats are rejected rather than last-wins: `?status=active&status=archived`
 * looks like it should mean "either", and silently answering with only the
 * second is the kind of wrong answer a caller does not think to check. The
 * error points at `_in`, which is the one way to express a disjunction.
 */
function single(key: string, value: string | string[]): string {
  if (Array.isArray(value)) {
    throw badQuery(
      `Query parameter '${key}' was sent ${value.length} times; it may appear once. ` +
        `To match any of several values use '${key}_in=a,b'.`,
    );
  }
  return value;
}

function featureOff(parameter: string, feature: string): AppError {
  return badQuery(
    `Query parameter '${parameter}' is not enabled for this API. ` +
      `Enable '${feature}' in the project's Features to use it.`,
  );
}

/**
 * Split a filter key into field and operator.
 *
 * An exact field-name match is tried first, so an entity that really does have a
 * field called `price_gt` stays filterable by its own name instead of being
 * reinterpreted as a comparison on `price`.
 */
function parseFilterKey(
  key: string,
  filterable: readonly string[],
): { field: string; operator: FilterOperator } | null {
  if (filterable.includes(key)) {
    return { field: key, operator: 'eq' };
  }
  const split = key.lastIndexOf('_');
  if (split <= 0) {
    return null;
  }
  const field = key.slice(0, split);
  const suffix = key.slice(split + 1);
  const operator = FILTER_OPERATORS.find((candidate) => candidate === suffix);
  if (!operator || !filterable.includes(field)) {
    return null;
  }
  return { field, operator };
}

function parseFilters(query: RawQuery, filterable: readonly string[]): FilterTerm[] {
  const filters: FilterTerm[] = [];
  const unknown: ErrorDetail[] = [];

  for (const [key, raw] of Object.entries(query)) {
    if (raw === undefined || RESERVED_QUERY_KEYS.includes(key)) {
      continue;
    }
    const parsed = parseFilterKey(key, filterable);
    if (!parsed) {
      unknown.push({
        path: key,
        issue: `not a filterable field. Filterable: ${options(filterable)}`,
      });
      continue;
    }
    const value = single(key, raw);
    filters.push({
      field: parsed.field,
      operator: parsed.operator,
      value,
      values: parsed.operator === 'in' ? value.split(',').map((part) => part.trim()) : [],
    });
  }

  if (unknown.length > 0) {
    // Rejected rather than ignored: a typo'd filter that returns the unfiltered
    // collection reads as "filtering is broken", and the caller has no way to
    // tell that from a filter that legitimately matched everything.
    throw badQuery(
      `Unknown filter ${unknown.length === 1 ? 'parameter' : 'parameters'}: ` +
        unknown.map((detail) => `'${detail.path}'`).join(', '),
      unknown,
    );
  }
  return filters;
}

function parseSort(value: string, sortable: readonly string[]): SortTerm[] {
  const terms: SortTerm[] = [];
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') {
      continue;
    }
    const descending = trimmed.startsWith('-');
    const field = descending ? trimmed.slice(1).trim() : trimmed;
    if (!sortable.includes(field)) {
      throw badQuery(
        `Cannot sort by '${field}'. Sortable fields: ${options(sortable)}. ` +
          `Prefix a field with '-' to sort descending.`,
      );
    }
    terms.push({ field, direction: descending ? -1 : 1 });
  }
  return terms;
}

function parseIncludes(value: string, includable: readonly string[]): string[] {
  const includes: string[] = [];
  for (const part of value.split(',')) {
    const name = part.trim();
    if (name === '') {
      continue;
    }
    if (name.includes('.')) {
      // Worth its own message: a caller who tries this has understood the
      // parameter and only guessed wrong about its depth.
      throw badQuery(
        `Nested includes are not supported: '${name}'. ` +
          `Include one relation at a time, e.g. '?include=${name.split('.')[0] ?? ''}'.`,
      );
    }
    if (!includable.includes(name)) {
      throw badQuery(`Unknown relation '${name}'. Includable relations: ${options(includable)}.`);
    }
    if (!includes.includes(name)) {
      includes.push(name);
    }
  }
  return includes;
}

/**
 * Validate a raw query against an entity's capabilities.
 *
 * Throws `AppError` (400) on anything unusable. Pagination is parsed
 * unconditionally: it is a response-size bound rather than a feature, so it has
 * no toggle and cannot be switched off.
 */
export function parseQuery(
  rawQuery: unknown,
  fields: EntityQueryFields | undefined,
  features: QueryFeatures,
  env: EnvConfig,
): QueryPlan {
  const query: RawQuery = (rawQuery ?? {}) as RawQuery;
  const available = fields ?? NO_QUERY_FIELDS;

  const pageRaw = query['page'];
  const limitRaw = query['limit'];
  const page = Math.max(1, Number.parseInt(pageRaw ? single('page', pageRaw) : '1', 10) || 1);
  const limit = Math.min(
    Math.max(1, Number.parseInt(limitRaw ? single('limit', limitRaw) : '20', 10) || 20),
    env.maxPaginationLimit,
  );

  const searchRaw = query['search'];
  let search: string | null = null;
  if (searchRaw !== undefined) {
    if (!features.search) {
      throw featureOff('search', 'search');
    }
    const term = single('search', searchRaw).trim();
    // An empty term is "no term", not "match nothing" — a cleared search box
    // should show the collection rather than an empty state.
    search = term === '' ? null : term;
  }

  const sortRaw = query['sort'];
  let sort: SortTerm[] = [];
  if (sortRaw !== undefined) {
    if (!features.sort) {
      throw featureOff('sort', 'sorting');
    }
    sort = parseSort(single('sort', sortRaw), available.sortable);
  }

  const includeRaw = query['include'];
  let includes: string[] = [];
  if (includeRaw !== undefined) {
    if (!features.include) {
      throw featureOff('include', 'relations');
    }
    includes = parseIncludes(single('include', includeRaw), available.includable);
  }

  // Only interpreted when filtering is on. With it off an unrecognised key is
  // just an unrecognised key — there is no way to distinguish a mistyped filter
  // from a tracking parameter, so neither is rejected.
  const filters = features.filter ? parseFilters(query, available.filterable) : [];

  return { page, limit, search, filters, sort, includes };
}

/** ISO-8601-ish date text, ordered by instant rather than by code unit. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]|$)/;

function numeric(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isMissing(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * Total ordering over two record values.
 *
 * Numbers compare numerically even when one side arrived as text, so `?sort=age`
 * does not place `9` after `10`. Strings compare case-insensitively first so
 * that `apple` and `Apple` sort together, with a raw comparison breaking the tie
 * — without that tiebreak the order of two values differing only in case would
 * depend on their input order, and pagination would not be reproducible.
 */
export function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const left = a === true || a === 'true' ? 1 : 0;
    const right = b === true || b === 'true' ? 1 : 0;
    return left - right;
  }

  const leftNumber = numeric(a);
  const rightNumber = numeric(b);
  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }

  const left = String(a);
  const right = String(b);

  if (ISO_DATE.test(left) && ISO_DATE.test(right)) {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime < rightTime ? -1 : 1;
    }
  }

  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft !== foldedRight) {
    return foldedLeft < foldedRight ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Equality between a stored value and a query string.
 *
 * Deliberately loose about representation and strict about content: `?age=30`
 * matches the number `30`, but `?name=ada` does not match `Ada`. Case-insensitive
 * matching has its own operator (`_like`), so equality stays predictable.
 */
export function looseEquals(recordValue: unknown, queryValue: string): boolean {
  if (queryValue === 'null') {
    return isMissing(recordValue);
  }
  if (isMissing(recordValue)) {
    return false;
  }
  if (Array.isArray(recordValue)) {
    // Scalar-only field lists mean this should not arise from a generated
    // schema, but a seed can hold anything; matching any element beats throwing.
    return recordValue.some((element) => looseEquals(element, queryValue));
  }
  if (typeof recordValue === 'boolean') {
    return (recordValue ? 'true' : 'false') === queryValue.toLowerCase();
  }
  if (typeof recordValue === 'number') {
    const parsed = numeric(queryValue);
    return parsed !== null && parsed === recordValue;
  }
  return String(recordValue) === queryValue;
}

function matchesFilter(record: MockRecord, filter: FilterTerm): boolean {
  const value = record[filter.field];

  switch (filter.operator) {
    case 'eq':
      return looseEquals(value, filter.value);
    case 'ne':
      return !looseEquals(value, filter.value);
    case 'in':
      return filter.values.some((candidate) => looseEquals(value, candidate));
    case 'like':
      // Substring, case-insensitive — the one operator that ignores case.
      return !isMissing(value) && String(value).toLowerCase().includes(filter.value.toLowerCase());
    default: {
      // A record with no value cannot satisfy an ordering comparison. Returning
      // false rather than treating it as 0 keeps `_gte=0` from matching every
      // record that simply lacks the field.
      if (isMissing(value)) {
        return false;
      }
      const ordering = compareValues(value, filter.value);
      switch (filter.operator) {
        case 'gt':
          return ordering > 0;
        case 'gte':
          return ordering >= 0;
        case 'lt':
          return ordering < 0;
        default:
          return ordering <= 0;
      }
    }
  }
}

function matchesSearch(record: MockRecord, term: string, searchable: readonly string[]): boolean {
  const needle = term.toLowerCase();
  for (const field of searchable) {
    const value = record[field];
    if (isMissing(value)) {
      continue;
    }
    const haystack = Array.isArray(value) ? value.join(' ') : String(value);
    if (haystack.toLowerCase().includes(needle)) {
      return true;
    }
  }
  return false;
}

/**
 * Apply every filter and the search term. All filters must match (AND); a search
 * term matches when any searchable field contains it (OR).
 */
export function selectRecords(
  records: readonly MockRecord[],
  plan: QueryPlan,
  searchable: readonly string[],
): MockRecord[] {
  const filtered =
    plan.filters.length === 0
      ? [...records]
      : records.filter((record) => plan.filters.every((filter) => matchesFilter(record, filter)));

  if (plan.search === null) {
    return filtered;
  }
  const term = plan.search;
  return filtered.filter((record) => matchesSearch(record, term, searchable));
}

/**
 * Order records by the sort terms, then by identity.
 *
 * The identity tiebreak is what makes pagination trustworthy: without a total
 * order, two records with equal sort keys could swap places between the request
 * for page 1 and the request for page 2, so one of them would appear twice and
 * the other not at all.
 *
 * Records missing the sort field always sort last, ascending or descending
 * alike — a page of blanks is never the useful answer.
 */
export function sortRecords(
  records: readonly MockRecord[],
  plan: QueryPlan,
  identityField: string,
): MockRecord[] {
  if (plan.sort.length === 0) {
    return [...records];
  }
  return [...records].sort((a, b) => {
    for (const term of plan.sort) {
      const left = a[term.field];
      const right = b[term.field];
      const leftMissing = isMissing(left);
      const rightMissing = isMissing(right);
      if (leftMissing || rightMissing) {
        if (leftMissing && rightMissing) {
          continue;
        }
        return leftMissing ? 1 : -1;
      }
      const ordering = compareValues(left, right);
      if (ordering !== 0) {
        return ordering * term.direction;
      }
    }
    return compareValues(a[identityField], b[identityField]);
  });
}

/** The requested page, and the total it was drawn from. */
export interface Page {
  data: MockRecord[];
  total: number;
}

export function paginate(records: readonly MockRecord[], plan: QueryPlan): Page {
  const start = (plan.page - 1) * plan.limit;
  return { data: records.slice(start, start + plan.limit), total: records.length };
}

/** What `expandIncludes` needs to resolve one relation. */
export interface IncludeTarget {
  /** Property the expansion is written to. */
  name: string;
  /** Hosted path of the target entity, for the loader. */
  targetPath: string;
  localField: string;
  foreignField: string;
  /** Expands to an array rather than a single record or null. */
  collection: boolean;
}

function joinKeys(value: unknown): string[] {
  if (isMissing(value)) {
    return [];
  }
  // A many-to-many key is an array of ids; every other side is a single value.
  return (Array.isArray(value) ? value : [value]).filter((key) => !isMissing(key)).map(String);
}

/**
 * Attach related records to each record in a page.
 *
 * Each relation costs **one** load of its target entity, not one per record: the
 * target is indexed by its join key first, so including a relation on a page of
 * 100 records is the same number of reads as including it on a page of one.
 *
 * An expansion overwrites a same-named own field. That is only reachable when a
 * relation and a field share a name, and the caller named the relation
 * explicitly in `?include=`, so the relation is what they asked for.
 */
export async function expandIncludes(
  records: readonly MockRecord[],
  targets: readonly IncludeTarget[],
  load: (targetPath: string) => Promise<MockRecord[]>,
): Promise<MockRecord[]> {
  if (targets.length === 0 || records.length === 0) {
    return [...records];
  }

  // Two relations pointing at the same entity — or a self-relation — share one
  // load rather than issuing a second identical read.
  const loaded = new Map<string, Promise<MockRecord[]>>();
  const loadOnce = (targetPath: string): Promise<MockRecord[]> => {
    let pending = loaded.get(targetPath);
    if (!pending) {
      pending = load(targetPath);
      loaded.set(targetPath, pending);
    }
    return pending;
  };

  const expanded = records.map((record) => ({ ...record }));

  for (const target of targets) {
    const rows = await loadOnce(target.targetPath);
    const index = new Map<string, MockRecord[]>();
    for (const row of rows) {
      // An inverse view of a many-to-many reads an array-valued key on the
      // target, so a row can be indexed under several keys.
      for (const key of joinKeys(row[target.foreignField])) {
        const bucket = index.get(key);
        if (bucket) {
          bucket.push(row);
        } else {
          index.set(key, [row]);
        }
      }
    }

    for (const record of expanded) {
      const matches: MockRecord[] = [];
      for (const key of joinKeys(record[target.localField])) {
        matches.push(...(index.get(key) ?? []));
      }
      record[target.name] = target.collection ? matches : (matches[0] ?? null);
    }
  }

  return expanded;
}
