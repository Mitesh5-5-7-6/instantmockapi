/**
 * Following an entity rename through the places that name entities by string.
 *
 * ## The bug this exists to fix
 *
 * `Relation.target`, `FieldMeta.relation` and `EntityIdentity.field` are **names**,
 * not stable ids (see the notes on those fields in `types.ts`). So renaming an
 * entity leaves every relation that pointed at it naming an entity that no longer
 * exists — and `validateIPS` rejects exactly that:
 *
 *     Relation target 'Product' is not a declared entity
 *
 * Which means **renaming an entity that anything relates to could not be saved at
 * all**. Not "saved with stale metadata" — rejected, through `PATCH /draft` and
 * `PATCH /projects/:id` alike. The rename tests missed it because they call
 * `materializeRelations` directly and never validate.
 *
 * ## Why this cannot live in `materializeRelations`
 *
 * A rename is only visible by comparing two definitions: the stable id says these
 * are the same entity, and the differing name says it was renamed.
 * `materializeRelations` takes one IPS and therefore cannot tell a rename from an
 * entity that was always called that. This is the one relation operation that
 * needs both sides, so it is its own module.
 *
 * ## Why it runs before validation
 *
 * `validateIPS` is what rejects the stale target, so reconciling afterwards would
 * never get the chance. That puts this function on unvalidated client input, so
 * every step below is defensive: a malformed document is returned untouched and
 * left for `validateIPS` to reject with a proper path, rather than throwing here
 * and turning a 422 into a 500.
 */

import type { InternalProjectSchema } from './types.js';

/** The narrowest view of the previous definition this needs. */
export interface RenameSource {
  entities?: readonly { id?: string; name?: string }[];
}

/**
 * Old name → new name, for every entity whose stable id persisted across the two
 * definitions while its name changed.
 *
 * Keyed on the **old** name because that is what the stale references hold.
 */
export function detectEntityRenames(
  previous: RenameSource,
  next: RenameSource,
): ReadonlyMap<string, string> {
  const renames = new Map<string, string>();

  const previousById = new Map<string, string>();
  for (const entity of previous.entities ?? []) {
    if (typeof entity?.id === 'string' && typeof entity.name === 'string') {
      previousById.set(entity.id, entity.name);
    }
  }
  if (previousById.size === 0) {
    return renames;
  }

  for (const entity of next.entities ?? []) {
    if (typeof entity?.id !== 'string' || typeof entity.name !== 'string') {
      // No id means no way to know this is the same entity — a genuinely new
      // entity and a renamed un-backfilled one are indistinguishable, and
      // guessing would rewrite references to point at the wrong thing.
      continue;
    }
    const before = previousById.get(entity.id);
    if (before !== undefined && before !== entity.name) {
      renames.set(before, entity.name);
    }
  }

  return renames;
}

/** Rewrite one name if it was renamed. */
function follow(value: unknown, renames: ReadonlyMap<string, string>): string | undefined {
  return typeof value === 'string' ? renames.get(value) : undefined;
}

/**
 * `meta.relation` on a field, and on every nested field beneath it.
 *
 * Recursive because `children` can carry a reference field inside an object —
 * rare, but the alternative is a silent miss at depth two.
 */
function reconcileFields(fields: unknown, renames: ReadonlyMap<string, string>): unknown {
  if (!Array.isArray(fields)) {
    return fields;
  }
  return fields.map((field) => {
    if (field === null || typeof field !== 'object') {
      return field;
    }
    const row = field as Record<string, unknown>;
    const next: Record<string, unknown> = { ...row };

    const meta = row['meta'];
    if (meta !== null && typeof meta === 'object') {
      const renamed = follow((meta as Record<string, unknown>)['relation'], renames);
      if (renamed !== undefined) {
        next['meta'] = { ...(meta as Record<string, unknown>), relation: renamed };
      }
    }

    if (Array.isArray(row['children'])) {
      next['children'] = reconcileFields(row['children'], renames);
    }
    return next;
  });
}

function reconcileRelations(relations: unknown, renames: ReadonlyMap<string, string>): unknown {
  if (!Array.isArray(relations)) {
    return relations;
  }
  return relations.map((relation) => {
    if (relation === null || typeof relation !== 'object') {
      return relation;
    }
    const row = relation as Record<string, unknown>;
    const renamed = follow(row['target'], renames);
    return renamed === undefined ? relation : { ...row, target: renamed };
  });
}

/**
 * Point every name-based reference in `next` at the entity's new name.
 *
 * Returns `next` **by identity** when nothing was renamed, so the overwhelmingly
 * common edit pays only a map build and no copy.
 *
 * A simultaneous swap (`A → B` and `B → A`) is handled correctly because the
 * lookup table is built from the original names and applied in a single pass —
 * no reference is rewritten twice.
 */
export function reconcileEntityRenames<T extends Record<string, unknown>>(
  previous: RenameSource,
  next: T,
): T {
  const renames = detectEntityRenames(previous, next as RenameSource);
  if (renames.size === 0) {
    return next;
  }

  const entities = next['entities'];
  if (!Array.isArray(entities)) {
    return next;
  }

  return {
    ...next,
    entities: entities.map((entity) => {
      if (entity === null || typeof entity !== 'object') {
        return entity;
      }
      const row = entity as Record<string, unknown>;
      return {
        ...row,
        fields: reconcileFields(row['fields'], renames),
        relations: reconcileRelations(row['relations'], renames),
      };
    }),
  };
}

/** Typed convenience wrapper for callers already holding a validated IPS. */
export function reconcileRenamesInSchema(
  previous: RenameSource,
  next: InternalProjectSchema,
): InternalProjectSchema {
  return reconcileEntityRenames(
    previous,
    next as unknown as Record<string, unknown>,
  ) as unknown as InternalProjectSchema;
}
