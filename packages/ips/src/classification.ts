/**
 * The three-value impact axis, as a **projection** of a change.
 *
 * ## Why a second axis exists at all
 *
 * `ChangeRisk` (`SAFE | INFO | WARNING | ROUTING | BREAKING`) answers *"how much
 * attention does this need before I commit, and what is the remedy"*. Phase 2's
 * comparison view asks a coarser, different question — *"do existing callers
 * break: yes, maybe, or no"*. Those are not the same cut of the same facts, and
 * `ROUTING` is the proof: a moved URL breaks every caller (so it is BREAKING on
 * this axis) but its remedy is "update a URL", which is why it earns its own
 * risk level on the other.
 *
 * ## Why this module only reads
 *
 * Phase 1 deliberately *replaced* a severity enum with `ChangeRisk` because "two
 * overlapping axes would drift". They drift when one is stored beside the other
 * and nothing recomputes it. So this is a pure function of a `SchemaChange`,
 * living in a module that imports the change type and exports no way to write
 * one. A third field cannot creep in next to `risk` and `aspect` without moving
 * it here first, which is a conversation rather than an accident.
 *
 * The other half of not-drifting is a presentation rule, stated here because
 * this is where someone will look for it:
 *
 * > **The comparison view renders `impact`. The commit dialog renders `risk`.
 * > Neither renders both in the same row.**
 *
 * Eight of the twenty-nine kinds legitimately disagree — `FIELD_DEFAULT_CHANGED`
 * is `SAFE` (nothing starts returning 422) and `POTENTIALLY_BREAKING` (writes
 * that omitted the key now store a different value). Both are true of different
 * questions; side by side they read as a contradiction.
 *
 * ## Why the table is keyed on `kind` and not on `risk`
 *
 * Because a `risk → impact` map cannot express the spec. §12 wants
 * `required: false → true` to be BREAKING and `minLength 3 → 8` to be only
 * POTENTIALLY_BREAKING, and `changes.ts` scores both `WARNING`. Eight kinds
 * therefore re-read `before`/`after` — the same evidence the risk decision read.
 *
 * `RULES` is an **exhaustive** `Record<ChangeKind, …>`, so adding a change kind
 * is a compile error until it is classified. That is the whole drift-prevention
 * mechanism; a `switch` with a `default` would have let a new kind ship
 * silently misclassified.
 */

import {
  validationDirection,
  type ChangeKind,
  type SchemaChange,
  type ValidationKey,
} from './changes.js';

export const CHANGE_IMPACTS = ['NON_BREAKING', 'POTENTIALLY_BREAKING', 'BREAKING'] as const;

export type ChangeImpact = (typeof CHANGE_IMPACTS)[number];

export const CHANGE_TYPES = ['ADDED', 'REMOVED', 'MODIFIED', 'RENAMED'] as const;

export type ChangeType = (typeof CHANGE_TYPES)[number];

/** Worst last, for "the worst impact in this set". */
const IMPACT_RANK: Record<ChangeImpact, number> = {
  NON_BREAKING: 0,
  POTENTIALLY_BREAKING: 1,
  BREAKING: 2,
};

/* ────────────────────────── evidence readers ────────────────────────── */

/**
 * Every reader below is total and returns the **worse** candidate when the
 * evidence is unreadable.
 *
 * These run over `Version.ipsSnapshot`, which is `Schema.Types.Mixed` and may
 * hold any shape written by any past version of this code. Throwing here would
 * turn a comparison of two old snapshots into a 500; guessing optimistically
 * would report a breaking change as safe, which is the one direction that
 * actually hurts.
 */
function truthy(value: unknown): boolean {
  return value === true;
}

/** `after.required` for a whole-field payload, or a bare boolean. */
function requiredAfter(change: SchemaChange): boolean | null {
  const { after } = change;
  if (typeof after === 'boolean') {
    return after;
  }
  if (after !== null && typeof after === 'object' && 'required' in after) {
    const value = (after as Record<string, unknown>)['required'];
    return typeof value === 'boolean' ? value : null;
  }
  return null;
}

/** A required field appearing, or an optional one becoming required. */
function requiredNow(change: SchemaChange): ChangeImpact {
  const required = requiredAfter(change);
  // `null` means the payload did not say. A required field is the breaking case,
  // so an unreadable payload takes it.
  return required === false ? 'NON_BREAKING' : 'BREAKING';
}

/** The rule key a `VALIDATION_*` change carries, from its synthetic path. */
function validationKeyOf(change: SchemaChange): ValidationKey | null {
  const path = change.path;
  if (typeof path !== 'string') {
    return null;
  }
  const marker = '.validation.';
  const at = path.lastIndexOf(marker);
  return at === -1 ? null : (path.slice(at + marker.length) as ValidationKey);
}

/**
 * A tightened rule may reject bodies that used to pass; a relaxed one cannot.
 *
 * §12's exact pair: `minLength 3 → 8` is potentially breaking, `8 → 3` is not.
 */
function validationImpact(change: SchemaChange): ChangeImpact {
  const key = validationKeyOf(change);
  if (key === null) {
    return 'POTENTIALLY_BREAKING';
  }
  return validationDirection(key, change.before, change.after) === 'relaxed'
    ? 'NON_BREAKING'
    : 'POTENTIALLY_BREAKING';
}

/**
 * `meta` carries three wire-visible flags and one bookkeeping one.
 *
 * `unique` newly true makes writes that used to succeed collide with a 409;
 * `searchable` withdrawn narrows what `?search=` accepts. `relation` is the echo
 * of an entity rename and changes nothing a caller can see.
 */
function metaImpact(change: SchemaChange): ChangeImpact {
  const before = change.before;
  const after = change.after;
  if (
    before === null ||
    typeof before !== 'object' ||
    after === null ||
    typeof after !== 'object'
  ) {
    return 'POTENTIALLY_BREAKING';
  }
  const from = before as Record<string, unknown>;
  const to = after as Record<string, unknown>;

  if (!truthy(from['unique']) && truthy(to['unique'])) {
    return 'POTENTIALLY_BREAKING';
  }
  if (truthy(from['searchable']) && !truthy(to['searchable'])) {
    return 'POTENTIALLY_BREAKING';
  }
  return 'NON_BREAKING';
}

/** A method disappearing removes endpoints; adding one cannot break a caller. */
function methodsImpact(change: SchemaChange): ChangeImpact {
  const before = Array.isArray(change.before) ? change.before : null;
  const after = Array.isArray(change.after) ? change.after : null;
  if (before === null || after === null) {
    return 'BREAKING';
  }
  const kept = new Set(after.map(String));
  return before.map(String).some((method) => !kept.has(method)) ? 'BREAKING' : 'NON_BREAKING';
}

/**
 * Withdrawing a query feature makes previously-valid query strings fail.
 *
 * The runtime rejects an unknown query parameter rather than ignoring it, so
 * this is a real break for anyone using it — but only for those callers, hence
 * potentially rather than outright.
 */
function featuresImpact(change: SchemaChange): ChangeImpact {
  const before = change.before;
  const after = change.after;
  if (
    before === null ||
    typeof before !== 'object' ||
    after === null ||
    typeof after !== 'object'
  ) {
    return 'POTENTIALLY_BREAKING';
  }
  const from = before as Record<string, unknown>;
  const to = after as Record<string, unknown>;
  return Object.keys(from).some((key) => truthy(from[key]) && !truthy(to[key]))
    ? 'POTENTIALLY_BREAKING'
    : 'NON_BREAKING';
}

/** A relation echoing an entity rename resolves to the same records. */
function isRenameEcho(change: SchemaChange): boolean {
  // `changes.ts` marks the echo by demoting it to INFO with no aspect; nothing
  // else in the relation family is ever scored that way.
  return change.risk === 'INFO' && change.aspect === 'none';
}

/* ────────────────────────── the table ────────────────────────── */

type Rule = ChangeImpact | ((change: SchemaChange) => ChangeImpact);

const IMPACT_RULES: Record<ChangeKind, Rule> = {
  /* ── entities ── */
  ENTITY_ADDED: 'NON_BREAKING',
  ENTITY_REMOVED: 'BREAKING',
  // §12 lists "endpoint path changed: BREAKING", and a rename IS that: the
  // hosted route is `entitySlug(entity)`, so every old URL 404s.
  ENTITY_RENAMED: 'BREAKING',
  ENTITY_DESCRIPTION_CHANGED: 'NON_BREAKING',
  // `{id}` changes meaning and format — int ids stop being valid UUIDs.
  ENTITY_IDENTITY_CHANGED: 'BREAKING',

  /* ── fields ── */
  // §12: "optional field added: NON-BREAKING". A *required* one rejects every
  // body that was valid a moment ago.
  FIELD_ADDED: requiredNow,
  FIELD_REMOVED: 'BREAKING',
  FIELD_RENAMED: 'BREAKING',
  FIELD_TYPE_CHANGED: 'BREAKING',
  // §12, both directions explicitly.
  FIELD_REQUIRED_CHANGED: requiredNow,
  // Nothing starts returning 422 — but a write that omitted the key now stores a
  // different value than it used to, and a reader may be relying on the old one.
  // This is the clearest case where `risk` (SAFE) and `impact` legitimately
  // disagree, which is why they are never rendered together.
  FIELD_DEFAULT_CHANGED: 'POTENTIALLY_BREAKING',
  FIELD_META_CHANGED: metaImpact,

  /* ── validation ── */
  VALIDATION_ADDED: 'POTENTIALLY_BREAKING',
  VALIDATION_REMOVED: 'NON_BREAKING',
  VALIDATION_CHANGED: validationImpact,
  ENUM_VALUES_ADDED: 'NON_BREAKING',
  // Requests carrying a dropped value now 422, and stored records may already
  // hold one.
  ENUM_VALUES_REMOVED: 'BREAKING',

  /* ── relations ── */
  RELATION_ADDED: 'NON_BREAKING',
  RELATION_REMOVED: 'BREAKING',
  // `?include=oldName` is a hard 400, not a silent ignore.
  RELATION_RENAMED: 'BREAKING',
  // Object ↔ array in the response body; the same class as a type change.
  RELATION_KIND_CHANGED: 'BREAKING',
  RELATION_TARGET_CHANGED: (change) => (isRenameEcho(change) ? 'NON_BREAKING' : 'BREAKING'),
  RELATION_FIELDS_CHANGED: 'BREAKING',
  // A DELETE that used to be refused with a 409 now succeeds and destroys
  // related records. Nothing breaks; something irreversible starts happening.
  RELATION_ON_DELETE_CHANGED: 'POTENTIALLY_BREAKING',
  RELATION_REQUIRED_CHANGED: requiredNow,

  /* ── project config ── */
  METHODS_CHANGED: methodsImpact,
  QUERY_FEATURES_CHANGED: featuresImpact,
  // Reseeds the store. No shape moves and no route moves.
  MOCK_RECORDS_CHANGED: 'NON_BREAKING',
  // Which files a developer can download. The hosted API is untouched.
  GENERATORS_CHANGED: 'NON_BREAKING',
};

const TYPE_RULES: Record<ChangeKind, ChangeType> = {
  ENTITY_ADDED: 'ADDED',
  ENTITY_REMOVED: 'REMOVED',
  ENTITY_RENAMED: 'RENAMED',
  ENTITY_DESCRIPTION_CHANGED: 'MODIFIED',
  ENTITY_IDENTITY_CHANGED: 'MODIFIED',

  FIELD_ADDED: 'ADDED',
  FIELD_REMOVED: 'REMOVED',
  FIELD_RENAMED: 'RENAMED',
  FIELD_TYPE_CHANGED: 'MODIFIED',
  FIELD_REQUIRED_CHANGED: 'MODIFIED',
  FIELD_DEFAULT_CHANGED: 'MODIFIED',
  FIELD_META_CHANGED: 'MODIFIED',

  // A rule is a property OF a field, so its arrival is a modification of that
  // field rather than an addition to the schema. Counting it as ADDED would make
  // "2 added" mean two different things in one summary.
  VALIDATION_ADDED: 'MODIFIED',
  VALIDATION_REMOVED: 'MODIFIED',
  VALIDATION_CHANGED: 'MODIFIED',
  ENUM_VALUES_ADDED: 'MODIFIED',
  ENUM_VALUES_REMOVED: 'MODIFIED',

  RELATION_ADDED: 'ADDED',
  RELATION_REMOVED: 'REMOVED',
  RELATION_RENAMED: 'RENAMED',
  RELATION_KIND_CHANGED: 'MODIFIED',
  RELATION_TARGET_CHANGED: 'MODIFIED',
  RELATION_FIELDS_CHANGED: 'MODIFIED',
  RELATION_ON_DELETE_CHANGED: 'MODIFIED',
  RELATION_REQUIRED_CHANGED: 'MODIFIED',

  METHODS_CHANGED: 'MODIFIED',
  QUERY_FEATURES_CHANGED: 'MODIFIED',
  MOCK_RECORDS_CHANGED: 'MODIFIED',
  GENERATORS_CHANGED: 'MODIFIED',
};

/* ────────────────────────── the projections ────────────────────────── */

/** Whether existing callers break: yes, maybe, or no. */
export function classifyImpact(change: SchemaChange): ChangeImpact {
  const rule = IMPACT_RULES[change.kind];
  if (rule === undefined) {
    // Unreachable through the type system, but `kind` arrives from stored
    // documents on the comparison path. The cautious answer beats a crash.
    return 'POTENTIALLY_BREAKING';
  }
  return typeof rule === 'function' ? rule(change) : rule;
}

/** §11's four-way shape of the change, for the `+ − ~` glyph and the counts. */
export function classifyChangeType(change: SchemaChange): ChangeType {
  return TYPE_RULES[change.kind] ?? 'MODIFIED';
}

/** The worst impact across a set, or null when nothing changed. */
export function worstImpact(changes: readonly SchemaChange[]): ChangeImpact | null {
  let worst: ChangeImpact | null = null;
  for (const change of changes) {
    const impact = classifyImpact(change);
    if (worst === null || IMPACT_RANK[impact] > IMPACT_RANK[worst]) {
      worst = impact;
    }
  }
  return worst;
}

/** Every bucket, zero-initialised, so a caller never has to check for absence. */
export function summariseImpact(changes: readonly SchemaChange[]): Record<ChangeImpact, number> {
  const counts = { NON_BREAKING: 0, POTENTIALLY_BREAKING: 0, BREAKING: 0 };
  for (const change of changes) {
    counts[classifyImpact(change)] += 1;
  }
  return counts;
}

/** Same, for §36's "2 Added, 3 Modified, 1 Removed, 2 Renamed" line. */
export function summariseChangeTypes(changes: readonly SchemaChange[]): Record<ChangeType, number> {
  const counts = { ADDED: 0, REMOVED: 0, MODIFIED: 0, RENAMED: 0 };
  for (const change of changes) {
    counts[classifyChangeType(change)] += 1;
  }
  return counts;
}
