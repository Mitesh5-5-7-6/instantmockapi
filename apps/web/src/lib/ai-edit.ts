/**
 * Applying an AI edit to a project's data model in the editor.
 *
 * The model returns a whole revised model. This turns it into per-entity
 * choices against what the editor holds, and the chosen result back into
 * builder entities the editor saves like any hand edit.
 *
 * Three things the model output cannot be trusted with, and so are taken from
 * the project instead:
 *
 * - **Stable ids** (`ent_`/`fld_`/`rel_`), matched by name. Without them the
 *   version history would show every entity the model kept as deleted and
 *   recreated.
 * - **Identity style.** The model is told to use uuid identities; switching a
 *   live project from integer ids would change every URL it serves.
 * - **Relations on a Single API**, which that kind of project cannot have.
 */

import type { BuilderEntity, BuilderField } from './builder';
import { ipsToBuilder, type IpsLike } from './draft-schema';
import { diffEntities, mergeEntities, type EntityChange, type MergeChoice } from './proposal-diff';

const keyOf = (name: string): string => name.trim().toLowerCase();

function withoutIds(field: BuilderField): BuilderField {
  const { schemaId: _schemaId, ...rest } = field;
  return { ...rest, children: field.children.map(withoutIds) };
}

/** Copy stable ids from `mine` onto the model's fields with the same names. */
function carryFieldIds(
  next: readonly BuilderField[],
  mine: readonly BuilderField[] | undefined,
): BuilderField[] {
  const byName = new Map((mine ?? []).map((field) => [keyOf(field.name), field]));
  return next.map((field) => {
    const match = byName.get(keyOf(field.name));
    return {
      ...field,
      ...(match?.schemaId !== undefined ? { schemaId: match.schemaId } : {}),
      children: carryFieldIds(field.children, match?.children),
    };
  });
}

/** The style most of the project's entities use; new entities follow it. */
function projectIdentityStyle(mine: readonly BuilderEntity[]): BuilderEntity['identityStyle'] {
  const uuid = mine.filter((entity) => entity.identityStyle === 'uuid').length;
  return uuid > mine.length - uuid ? 'uuid' : 'int';
}

/** Compare the model's revised entities with the editor's. */
export function aiEditChanges(
  mine: readonly BuilderEntity[],
  aiEntities: readonly unknown[],
  options: { relations: boolean },
): EntityChange[] {
  const mineByName = new Map(mine.map((entity) => [keyOf(entity.name), entity]));
  const fallbackStyle = projectIdentityStyle(mine);
  const next = ipsToBuilder({ entities: aiEntities } as IpsLike).map((entity): BuilderEntity => {
    const match = mineByName.get(keyOf(entity.name));
    const relationIds = new Map(
      (match?.relations ?? []).map((relation) => [keyOf(relation.name), relation.schemaId]),
    );
    const { schemaId: _schemaId, ...rest } = entity;
    return {
      ...rest,
      ...(match?.schemaId !== undefined ? { schemaId: match.schemaId } : {}),
      identityStyle: match?.identityStyle ?? fallbackStyle,
      fields: carryFieldIds(entity.fields.map(withoutIds), match?.fields),
      relations: options.relations
        ? entity.relations.map(({ schemaId: _id, ...relation }) => {
            const carried = relationIds.get(keyOf(relation.name));
            return carried !== undefined ? { ...relation, schemaId: carried } : relation;
          })
        : [],
    };
  });
  return diffEntities(mine, next);
}

/**
 * What each change starts as. The user asked for this edit, so additions and
 * changes default to the model's version; an entity the model dropped defaults
 * to kept, so nothing disappears unless the user removes it on purpose.
 */
export function defaultEditChoices(changes: readonly EntityChange[]): Record<string, MergeChoice> {
  const choices: Record<string, MergeChoice> = {};
  for (const change of changes) {
    if (change.kind !== 'same') {
      choices[change.key] = change.kind === 'removed' ? 'mine' : 'new';
    }
  }
  return choices;
}

/** The editor's entities after the chosen changes. */
export function applyAiEdit(
  changes: readonly EntityChange[],
  choices: Readonly<Record<string, MergeChoice>>,
): BuilderEntity[] {
  return mergeEntities(changes, choices);
}
