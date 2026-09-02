/**
 * Round-tripping a stored definition through the builder form, without losing
 * the things the builder does not know about.
 *
 * The wizard builds an IPS from nothing, so `builderFieldToIPS` can simply emit
 * whatever the form holds. Editing is not that. An existing definition contains
 * fields and metadata the form never shows — the identity field, foreign keys,
 * `meta.reference`, entity descriptions — all of which `materializeRelations`
 * owns on the server. Rebuilding the IPS from the form would silently delete
 * them.
 *
 * So the save path is a **merge, not a rebuild**:
 *
 *     stored IPS ──▶ ipsToBuilder ──▶ form ──▶ applyBuilderToIps(stored, form)
 *          │                                              │
 *          └──────────── everything unrepresented ─────────┘
 *                        passes through untouched
 *
 * ## Why the stable ids have to survive
 *
 * `diffSchemas` matches on `ent_`/`fld_`/`rel_` ids alone. A round trip that
 * dropped them would make every entity look removed and re-added, so the impact
 * report would claim a one-word rename rebuilt the entire API — and the user
 * would be asked to confirm a change that never happened. `schemaId` is
 * therefore carried on every builder node and written back verbatim.
 *
 * ## What is deliberately hidden from the form
 *
 * Fields carrying `meta.identity` or `meta.reference` are server-derived:
 * `materializeRelations` creates and maintains them from the entity's identity
 * descriptor and its relations. Showing them as editable rows would invite a user
 * to rename a foreign key that the server would immediately recreate. They are
 * filtered out on the way in and preserved on the way out, ids and metadata
 * intact.
 */

import {
  builderFieldToIPS,
  newEntity,
  nextId,
  type BuilderEntity,
  type BuilderField,
  type BuilderRelation,
  type BuilderValidation,
} from './builder';

/** The stored shapes, narrowed at the edge — `ips` arrives as `unknown`. */
interface IpsFieldLike {
  id?: string;
  name: string;
  type: string;
  required?: boolean;
  default?: unknown;
  children?: IpsFieldLike[];
  validation?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  description?: string;
}

interface IpsRelationLike {
  id?: string;
  name: string;
  kind: string;
  target: string;
  required?: boolean;
  onDelete?: string;
  [key: string]: unknown;
}

interface IpsEntityLike {
  id?: string;
  name: string;
  fields?: IpsFieldLike[];
  relations?: IpsRelationLike[];
  identity?: { field: string; style: 'int' | 'uuid' };
  description?: string;
  [key: string]: unknown;
}

export interface IpsLike {
  entities?: IpsEntityLike[];
  [key: string]: unknown;
}

/** A field the server derives and maintains. Never editable in the form. */
export function isDerivedField(field: IpsFieldLike): boolean {
  return field.meta?.['identity'] === true || field.meta?.['reference'] === true;
}

const asText = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);

const asNumberText = (value: unknown): string | undefined =>
  typeof value === 'number' ? String(value) : undefined;

/**
 * Read stored `ValidationRules` back into the form's string-shaped fields.
 *
 * The form holds numbers as strings because that is what an `<input>` gives you;
 * `buildValidation` parses them back. Keeping the two in step here is what stops
 * a saved `min: 3` reappearing as an empty box and then being written away.
 */
function toBuilderValidation(field: IpsFieldLike): BuilderValidation {
  const rules = field.validation ?? {};
  const arrayLength = rules['arrayLength'] as { min?: number; max?: number } | undefined;
  const validation: BuilderValidation = {};

  if (rules['email'] === true) validation.email = true;
  if (rules['url'] === true) validation.url = true;
  if (rules['uuid'] === true) validation.uuid = true;

  const min = asNumberText(rules['min']);
  if (min !== undefined) validation.min = min;
  const max = asNumberText(rules['max']);
  if (max !== undefined) validation.max = max;
  const length = asNumberText(rules['length']);
  if (length !== undefined) validation.length = length;

  if (typeof rules['regex'] === 'string') validation.regex = rules['regex'];
  if (typeof rules['message'] === 'string') validation.message = rules['message'];
  if (Array.isArray(rules['enum'])) validation.enum = rules['enum'].map(asText);

  const arrayMin = asNumberText(arrayLength?.min);
  if (arrayMin !== undefined) validation.arrayMin = arrayMin;
  const arrayMax = asNumberText(arrayLength?.max);
  if (arrayMax !== undefined) validation.arrayMax = arrayMax;

  // `unique` and `searchable` live in `meta` on the wire but read as rules in the
  // form, which is where `buildMeta` puts them back.
  if (field.meta?.['unique'] === true) validation.unique = true;
  if (field.meta?.['searchable'] === true) validation.searchable = true;

  return validation;
}

function toBuilderField(field: IpsFieldLike): BuilderField {
  const children = Array.isArray(field.children) ? field.children : [];
  return {
    id: nextId(),
    ...(field.id !== undefined ? { schemaId: field.id } : {}),
    name: field.name,
    type: field.type,
    required: field.required === true,
    default: asText(field.default),
    validation: toBuilderValidation(field),
    children: children.map(toBuilderField),
  };
}

function toBuilderRelation(relation: IpsRelationLike): BuilderRelation {
  return {
    id: nextId(),
    ...(relation.id !== undefined ? { schemaId: relation.id } : {}),
    name: relation.name,
    kind: relation.kind as BuilderRelation['kind'],
    target: relation.target,
    required: relation.required === true,
    onDelete: (relation.onDelete ?? 'restrict') as BuilderRelation['onDelete'],
  };
}

/** Load a stored definition into the builder form. */
export function ipsToBuilder(ips: IpsLike): BuilderEntity[] {
  const entities = Array.isArray(ips.entities) ? ips.entities : [];
  return entities.map((entity) => {
    const fields = Array.isArray(entity.fields) ? entity.fields : [];
    return {
      ...newEntity(entity.name),
      id: nextId(),
      ...(entity.id !== undefined ? { schemaId: entity.id } : {}),
      name: entity.name,
      // Derived fields are hidden, not dropped — `applyBuilderToIps` puts them
      // back from the stored document.
      fields: fields.filter((field) => !isDerivedField(field)).map(toBuilderField),
      relations: (Array.isArray(entity.relations) ? entity.relations : []).map(toBuilderRelation),
      identityStyle: entity.identity?.style ?? 'int',
      generate: true,
    };
  });
}

function indexById<T extends { id?: string }>(items: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of items) {
    if (typeof item.id === 'string' && item.id !== '') {
      index.set(item.id, item);
    }
  }
  return index;
}

/**
 * Write one builder field back, keeping whatever the form does not own.
 *
 * `meta` is merged rather than replaced: `buildMeta` emits only `unique` and
 * `searchable`, so replacing would erase `readOnly`, `relation` and anything a
 * future version of the server adds. The two keys the form *does* own are
 * deleted first, so unticking a box actually clears it — a merge alone would make
 * `unique` impossible to turn off.
 */
function mergeField(builder: BuilderField, stored: IpsFieldLike | undefined): IpsFieldLike {
  const emitted = builderFieldToIPS(builder) as unknown as IpsFieldLike;
  const storedChildren = Array.isArray(stored?.children) ? stored.children : [];
  const childIndex = indexById(storedChildren);

  const meta: Record<string, unknown> = { ...(stored?.meta ?? {}) };
  delete meta['unique'];
  delete meta['searchable'];
  Object.assign(meta, emitted.meta ?? {});

  // Key order matches `builderFieldToIPS` and `materializeRelations`. It changes
  // nothing semantically — generators read properties by name — but the server
  // hashes `JSON.stringify(ips)` for the generation idempotency key, so a save
  // that reshuffled keys would defeat deduplication for no reason.
  return {
    ...(builder.schemaId !== undefined ? { id: builder.schemaId } : {}),
    name: emitted.name,
    type: emitted.type,
    required: emitted.required,
    default: emitted.default,
    children: builder.children.map((child) =>
      mergeField(child, child.schemaId ? childIndex.get(child.schemaId) : undefined),
    ),
    validation: emitted.validation ?? {},
    meta,
    // Descriptions are authored elsewhere (Phase 4's technical notes) and must
    // survive an unrelated edit here.
    ...(stored?.description !== undefined ? { description: stored.description } : {}),
  };
}

function mergeRelation(
  builder: BuilderRelation,
  stored: IpsRelationLike | undefined,
): IpsRelationLike {
  return {
    // `localField`/`foreignField` are completed by `completeRelation` on the
    // server and are not in the form, so they ride along from the stored copy.
    ...(stored ?? {}),
    ...(builder.schemaId !== undefined ? { id: builder.schemaId } : {}),
    name: builder.name,
    kind: builder.kind,
    target: builder.target,
    required: builder.required,
    onDelete: builder.onDelete,
  };
}

/**
 * Apply the form back onto the stored definition.
 *
 * Returns the `ips` body for `PATCH /projects/:id/draft`. Entities, fields and
 * relations are matched by stable id; anything the form added arrives without
 * one and the server mints it. Anything the form cannot represent — derived
 * fields, entity descriptions, relation link fields — is copied from the stored
 * document rather than regenerated.
 */
export function applyBuilderToIps(stored: IpsLike, entities: readonly BuilderEntity[]): IpsLike {
  const storedEntities = Array.isArray(stored.entities) ? stored.entities : [];
  const entityIndex = indexById(storedEntities);

  // Nameless entities are dropped, exactly as nameless fields are below. A
  // freshly added card is a half-typed thought, and `validateIPS` answers
  // "Entity name is required" — so without this, clicking "Add entity" and then
  // Save is a 422 for having clicked a button.
  const merged = entities
    .filter((entity) => entity.name.trim() !== '')
    .map((entity) => {
      const previous = entity.schemaId ? entityIndex.get(entity.schemaId) : undefined;
      const storedFields = Array.isArray(previous?.fields) ? previous.fields : [];
      const fieldIndex = indexById(storedFields);

      const authored = entity.fields
        .filter((field) => field.name !== '')
        .map((field) =>
          mergeField(field, field.schemaId ? fieldIndex.get(field.schemaId) : undefined),
        );

      // Derived fields, in the order `materializeRelations` produces them: identity
      // first, foreign keys last. Placed deterministically so repeated saves do not
      // churn the generated type field order.
      const derived = storedFields.filter(isDerivedField);
      const identity = derived.filter((field) => field.meta?.['identity'] === true);
      const references = derived.filter((field) => field.meta?.['identity'] !== true);

      return {
        ...(previous ?? {}),
        ...(entity.schemaId !== undefined ? { id: entity.schemaId } : {}),
        name: entity.name,
        identity: {
          field: previous?.identity?.field ?? 'id',
          style: entity.identityStyle,
        },
        fields: [...identity, ...authored, ...references],
        relations: entity.relations
          .filter((relation) => relation.name !== '' && relation.target !== '')
          .map((relation) =>
            mergeRelation(
              relation,
              relation.schemaId
                ? indexById(Array.isArray(previous?.relations) ? previous.relations : []).get(
                    relation.schemaId,
                  )
                : undefined,
            ),
          ),
      };
    });

  return { ...stored, entities: merged };
}

/**
 * Stable serialisation for comparison: object keys sorted, array order kept.
 *
 * Array order is meaningful — it is the field order the generated types follow —
 * but the order of keys *within* a field is not, and a plain `JSON.stringify`
 * would report a reshuffle as an unsaved edit and light up the Save button on a
 * form nobody touched.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Does the form differ meaningfully from what it was loaded with? */
export function isDirty(stored: IpsLike, entities: readonly BuilderEntity[]): boolean {
  return canonical(applyBuilderToIps(stored, entities)) !== canonical(stored);
}

/** What the editor lets an author do, per project kind. */
export interface EditorCapabilities {
  /** What one top-level item is called to the author. */
  noun: 'entity' | 'endpoint';
  /** Whether the relationship editor is offered at all. */
  showRelations: boolean;
}

/**
 * A **Single API** project is a set of independent endpoints, not a relational
 * model.
 *
 * `endpointsToEntities` in `single-api.ts` hardcodes `relations: []`, and
 * `SingleEndpoint` has no relations field — so the creation flow cannot produce a
 * single project with relations. Nothing on the server enforces it: such a
 * project would generate and host perfectly well. That is precisely why the
 * editor must not offer relations. The only way to create one would be by
 * editing, and the result would be a project whose shape contradicts its own
 * kind, with no wizard able to reproduce it.
 *
 * Adding a top-level item is a different matter and stays available for both
 * kinds. For a single project, adding an "entity" *is* adding an endpoint — the
 * same thing its wizard does with a second endpoint row, and it hosts at
 * `/p/{sng_…}/{slug}/{endpoint}` exactly as the first one does.
 */
export function editorCapabilities(kind: 'project' | 'single' | undefined): EditorCapabilities {
  return kind === 'single'
    ? { noun: 'endpoint', showRelations: false }
    : // Anything unrecognised, including an absent kind on a document written
      // before kinds existed, gets the relational editor. It is the superset, so
      // the failure mode is an offered control rather than a hidden one.
      { noun: 'entity', showRelations: true };
}

/**
 * Problems the form can name before the server does.
 *
 * These are the two `validateIPS` rules an author trips by ordinary editing, and
 * a readable line beside the Save button beats a 422 with a JSON path. Nameless
 * entities and fields are absent on purpose — those are dropped rather than
 * reported, because a half-typed row is not a mistake.
 *
 * Relation problems are NOT here: `validateRelations` already owns those and the
 * editor renders them per card.
 */
export function draftProblems(entities: readonly BuilderEntity[]): string[] {
  const problems: string[] = [];
  const named = entities.filter((entity) => entity.name.trim() !== '');

  if (named.length === 0) {
    problems.push('Add at least one named entity.');
  }
  for (const entity of named) {
    if (entity.fields.every((field) => field.name.trim() === '')) {
      problems.push(`${entity.name} needs at least one named field.`);
    }
  }

  // Duplicate names would collide on the hosted route, since the path segment is
  // the lowercased name. `validateIPS` rejects it; naming it here is friendlier.
  const seen = new Set<string>();
  for (const entity of named) {
    const key = entity.name.trim().toLowerCase();
    if (seen.has(key)) {
      problems.push(`Two entities are both called ${entity.name}.`);
    }
    seen.add(key);
  }

  return problems;
}
