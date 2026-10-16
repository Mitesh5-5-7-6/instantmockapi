/**
 * Editing an existing project's data model with a prompt.
 *
 * The project's draft goes to the model as `<current_blueprint>`, but not as
 * stored. Two kinds of content are removed first:
 *
 * - **Foreign-key fields** (`meta.reference`). The platform derives them from
 *   relations, and `toBuilderShape` strips `reference` from model output — so a
 *   key the model copied back would return as a plain field and clash with the
 *   one the platform derives on save.
 * - **Stable ids** (`ent_`, `fld_`, `rel_`). They mean nothing to the model, and
 *   an echoed or invented id would be indistinguishable from a real one. The
 *   editor reattaches the real ids by name when the result is applied.
 */

import { isRecord } from './sanitize.js';

function withoutId(record: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = record;
  return rest;
}

function cleanField(field: Record<string, unknown>): Record<string, unknown> {
  const clean = withoutId(field);
  if (Array.isArray(field['children'])) {
    clean['children'] = field['children'].filter(isRecord).map(cleanField);
  }
  return clean;
}

const isForeignKey = (field: Record<string, unknown>): boolean =>
  isRecord(field['meta']) && field['meta']['reference'] === true;

/** The draft's entities, ready to send as `<current_blueprint>`. */
export function editableBlueprint(entities: readonly unknown[]): Record<string, unknown>[] {
  return entities.filter(isRecord).map((entity) => {
    const clean = withoutId(entity);
    const fields = Array.isArray(entity['fields']) ? entity['fields'].filter(isRecord) : [];
    const relations = Array.isArray(entity['relations'])
      ? entity['relations'].filter(isRecord)
      : [];
    clean['fields'] = fields.filter((field) => !isForeignKey(field)).map(cleanField);
    clean['relations'] = relations.map(withoutId);
    return clean;
  });
}
