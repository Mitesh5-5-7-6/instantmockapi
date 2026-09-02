/**
 * Stable internal identity for schema elements (Phase 1).
 *
 * ## Why the IPS needs ids at all
 *
 * The IPS is entirely **name-keyed** today: an entity is found by `entity.name`,
 * a field by `field.name` among its siblings, a relation by `relation.target`.
 * That works only because `validateIPS` rejects duplicate names — and it makes a
 * rename indistinguishable from a delete-plus-create.
 *
 * Phase 1's dependency graph has to survive a rename. `User` becoming `Customer`
 * must keep `ent_…`, or every edge in the graph is a string comparison that
 * silently re-points the first time somebody renames a field. So identity moves
 * *into* the document rather than into a parallel table: one source of truth,
 * carried by the thing it identifies.
 *
 * ## Every id is optional, forever
 *
 * Every project generated before Phase 1 has no ids at all, and `Project.ips` is
 * `Schema.Types.Mixed`, so an old document can be any shape. The types therefore
 * declare `id?: string` and nothing may *require* one — code either reads it
 * through a backfill or tolerates its absence. `ensureSchemaIds` is the backfill.
 *
 * ## Format
 *
 * `prefix_` plus lowercase hex, matching the `prj_`/`sng_` public-id convention
 * already used for routing (`packages/shared/src/hosting-urls.ts`). Eight bytes
 * rather than that convention's five: a public id only has to be unique across
 * projects, while these have to be unique across every element of every schema,
 * and unlike a public id there is no database uniqueness index to catch a clash.
 */

import { randomBytes } from 'crypto';

/** Prefix per element kind. Readable in a diff, and greppable. */
export const ID_PREFIX = {
  entity: 'ent',
  field: 'fld',
  relation: 'rel',
  /**
   * Endpoints have no home in the IPS yet — they are derived by
   * `projectEndpoints` on every read. The prefix is declared here so the
   * endpoint registry, when it lands, cannot invent a second scheme.
   */
  endpoint: 'ep',
} as const;

export type SchemaElementKind = keyof typeof ID_PREFIX;

const ID_BYTES = 8;

/**
 * Matches any id this module mints.
 *
 * Bounded rather than open-ended so a validator can reject a malformed id
 * instead of accepting an arbitrary string as identity.
 */
export const SCHEMA_ID_PATTERN = /^(ent|fld|rel|ep)_[0-9a-f]{10,32}$/;

/** Mint one id. */
export function newSchemaId(kind: SchemaElementKind): string {
  return `${ID_PREFIX[kind]}_${randomBytes(ID_BYTES).toString('hex')}`;
}

export function isSchemaId(value: unknown, kind?: SchemaElementKind): boolean {
  if (typeof value !== 'string' || !SCHEMA_ID_PATTERN.test(value)) {
    return false;
  }
  return kind === undefined ? true : value.startsWith(`${ID_PREFIX[kind]}_`);
}

/**
 * Anything that may carry a stable id. Structural rather than importing the IPS
 * types, so this module stays usable on partially-built objects — the wizard
 * builds entities before they are valid IPS.
 */
interface Identifiable {
  id?: string;
}

/**
 * Give `element` an id if it has none, in place.
 *
 * Returns true when one was minted, so callers can tell a backfill that changed
 * something from one that found nothing to do — which is what lets the caller
 * skip a database write.
 *
 * An id that is already present is **never replaced**, even if malformed:
 * replacing it would break every graph edge pointing at it, which is a worse
 * outcome than tolerating an odd-looking string. Malformed ids are a validator's
 * problem, not a backfill's.
 */
function ensureId(element: Identifiable, kind: SchemaElementKind): boolean {
  if (typeof element.id === 'string' && element.id !== '') {
    return false;
  }
  element.id = newSchemaId(kind);
  return true;
}

/** Recurse into `children`, which nest arbitrarily deep for object/array fields. */
function ensureFieldIds(fields: { id?: string; children?: unknown }[]): number {
  let minted = 0;
  for (const field of fields) {
    if (ensureId(field, 'field')) {
      minted += 1;
    }
    // Nested objects and array element types live in `children`, and a field
    // buried three levels down is just as much a dependency-graph node as a
    // top-level one — `customer.address.city` has to be addressable.
    if (Array.isArray(field.children)) {
      minted += ensureFieldIds(field.children as { id?: string; children?: unknown }[]);
    }
  }
  return minted;
}

export interface BackfillResult {
  /** How many ids were minted. Zero means the document was already complete. */
  minted: number;
  /** True when nothing changed, so the caller can skip persisting. */
  unchanged: boolean;
}

/**
 * Backfill stable ids across a whole schema, in place.
 *
 * **Idempotent by construction**: it only ever writes an id that is absent, so a
 * second run mints nothing and reports `unchanged: true`. That is the property
 * the migration depends on — running it on every read must not churn the
 * document or invalidate the graph.
 *
 * Mutates rather than copying. The callers are (a) the lazy read-path backfill,
 * which already holds a mongoose document it intends to save, and (b) the
 * post-materialization pass, which owns the object it was just handed. Both want
 * mutation; a copy would force them to reassign and would double the allocation
 * for a schema that usually needs no change at all.
 *
 * Deliberately **not** a validator. A schema with duplicate names, a missing
 * target or an unknown field type still gets ids — identity is orthogonal to
 * validity, and refusing to identify a broken schema would make it impossible to
 * describe what is broken about it.
 */
export function ensureSchemaIds(ips: {
  entities?: { id?: string; fields?: unknown; relations?: unknown }[];
}): BackfillResult {
  let minted = 0;

  for (const entity of ips.entities ?? []) {
    if (ensureId(entity, 'entity')) {
      minted += 1;
    }
    if (Array.isArray(entity.fields)) {
      minted += ensureFieldIds(entity.fields as { id?: string; children?: unknown }[]);
    }
    // `relations` is optional on documents written before relations existed.
    if (Array.isArray(entity.relations)) {
      for (const relation of entity.relations as Identifiable[]) {
        if (ensureId(relation, 'relation')) {
          minted += 1;
        }
      }
    }
  }

  return { minted, unchanged: minted === 0 };
}

/**
 * Every id in a schema, in document order.
 *
 * For the uniqueness check a validator needs, and for the dependency graph's
 * node enumeration. Elements without an id are skipped rather than reported —
 * "has no id yet" is the normal state of an un-backfilled document, not an
 * error.
 */
export function collectSchemaIds(ips: {
  entities?: { id?: string; fields?: unknown; relations?: unknown }[];
}): string[] {
  const ids: string[] = [];

  const walkFields = (fields: { id?: string; children?: unknown }[]): void => {
    for (const field of fields) {
      if (typeof field.id === 'string') {
        ids.push(field.id);
      }
      if (Array.isArray(field.children)) {
        walkFields(field.children as { id?: string; children?: unknown }[]);
      }
    }
  };

  for (const entity of ips.entities ?? []) {
    if (typeof entity.id === 'string') {
      ids.push(entity.id);
    }
    if (Array.isArray(entity.fields)) {
      walkFields(entity.fields as { id?: string; children?: unknown }[]);
    }
    if (Array.isArray(entity.relations)) {
      for (const relation of entity.relations as Identifiable[]) {
        if (typeof relation.id === 'string') {
          ids.push(relation.id);
        }
      }
    }
  }

  return ids;
}

/** Ids that appear more than once. Empty is the healthy case. */
export function duplicateSchemaIds(ips: Parameters<typeof collectSchemaIds>[0]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of collectSchemaIds(ips)) {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  return [...duplicates];
}
