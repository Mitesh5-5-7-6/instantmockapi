/**
 * The schema builder's own data model, and its translation into IPS.
 *
 * Lifted out of the wizard page so it can be tested as plain functions. The
 * builder deliberately keeps every editable value as a **string** — an input
 * that is mid-edit (`"-"`, `"1."`, `""`) has no valid number to hold, and
 * storing the coerced value would fight the user's keystrokes. Coercion happens
 * once here, on the way out.
 */

export interface BuilderValidation {
  email?: boolean;
  url?: boolean;
  uuid?: boolean;
  unique?: boolean;
  min?: string;
  max?: string;
  length?: string;
  regex?: string;
  arrayMin?: string;
  arrayMax?: string;
  enum?: string[];
  message?: string;
  /** Opt-in `?search=` target — becomes `meta.searchable` (doc 19 §Phase 4). */
  searchable?: boolean;
}

export interface BuilderField {
  /** UI-local key for React. Regenerated freely; never sent to the API. */
  id: string;
  /**
   * The stable `fld_` id, when this field came from an existing definition.
   *
   * Distinct from `id` on purpose. `id` identifies a row in this form; this
   * identifies a field in the project's history. Losing it makes a rename look
   * like a delete plus an unrelated create, which would tell the user their whole
   * entity was rebuilt.
   */
  schemaId?: string;
  name: string;
  type: string;
  required: boolean;
  default: string;
  validation: BuilderValidation;
  children: BuilderField[];
  showRules?: boolean;
}

/** How two entities relate, as authored in the wizard. */
export interface BuilderRelation {
  id: string;
  /** The stable `rel_` id, when editing an existing definition. */
  schemaId?: string;
  /** Property name on the expanded record, e.g. `classroom`. */
  name: string;
  kind: 'belongsTo' | 'hasOne' | 'hasMany' | 'manyToMany';
  /** Target entity name. Empty until the author picks one. */
  target: string;
  required: boolean;
  onDelete: 'restrict' | 'cascade' | 'setNull';
}

export interface BuilderEntity {
  id: string;
  /** The stable `ent_` id, when editing an existing definition. */
  schemaId?: string;
  name: string;
  fields: BuilderField[];
  relations: BuilderRelation[];
  /** Identity style; `int` yields copy-pasteable `/students/1` URLs. */
  identityStyle: 'int' | 'uuid';
  /** Cleared to exclude the entity from generation (wizard step 3). */
  generate: boolean;
}

/** The full IPS FieldType set — the builder can express every one. */
export const FIELD_TYPES = [
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
  'object',
  'array',
] as const;

export const NUMERIC_TYPES = ['number', 'decimal', 'integer'];

/**
 * Types that can hold a searchable string, mirroring the IPS default.
 *
 * `avatar` is absent on purpose, matching `TEXTUAL_TYPES` in the IPS: its value
 * is a URL full of trait names, so searching it matches on `Hat` and `Blonde`.
 */
export const TEXTUAL_TYPES = ['string', 'email', 'url', 'uuid', 'enum'];

/**
 * Relation kinds, with the wording the wizard shows.
 *
 * `belongsTo` and `manyToMany` own the key; `hasOne`/`hasMany` are inverse views
 * of a key that lives on the target. The wizard says so out loud because it
 * determines which entity grows a foreign-key field.
 */
export const RELATION_KINDS = [
  { kind: 'belongsTo', label: 'belongs to', cardinality: 'M : 1', owning: true },
  { kind: 'hasOne', label: 'has one', cardinality: '1 : 1', owning: false },
  { kind: 'hasMany', label: 'has many', cardinality: '1 : M', owning: false },
  { kind: 'manyToMany', label: 'many to many', cardinality: 'M : M', owning: true },
] as const;

/**
 * Root entity fields are depth 1; every object/array descent adds one. Mirrors
 * MAX_NESTING_DEPTH so the builder soft-guards before the API rejects with
 * DEPTH_LIMIT_EXCEEDED.
 */
export const MAX_DEPTH = 10;

let sequence = 0;

/** Client-only node id. Never sent to the API — it exists to key React lists. */
export function nextId(): string {
  sequence += 1;
  return `n${sequence}`;
}

export function newField(name = '', type = 'string'): BuilderField {
  return {
    id: nextId(),
    name,
    type,
    required: true,
    default: '',
    validation: {},
    children: type === 'array' ? [newField('item', 'object')] : [],
  };
}

export function newRelation(): BuilderRelation {
  return {
    id: nextId(),
    name: '',
    kind: 'belongsTo',
    target: '',
    required: false,
    onDelete: 'restrict',
  };
}

export function newEntity(name = ''): BuilderEntity {
  return {
    id: nextId(),
    name,
    fields: [newField('name')],
    relations: [],
    identityStyle: 'int',
    generate: true,
  };
}

function num(value?: string): number | undefined {
  if (value === undefined || value === '' || Number.isNaN(Number(value))) {
    return undefined;
  }
  return Number(value);
}

export function coerceDefault(field: BuilderField): unknown {
  const value = field.default;
  if (value === '' || value == null) {
    return null;
  }
  if (NUMERIC_TYPES.includes(field.type)) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (field.type === 'boolean') {
    return value === 'true';
  }
  return value;
}

/**
 * Map the builder's form-shaped validation to IPS ValidationRules, keeping only
 * the keys that mean something for the field's type.
 *
 * Type-scoping matters: a `min` left behind after switching a field from string
 * to boolean would be emitted as a length rule the generators would honour.
 */
export function buildValidation(field: BuilderField): Record<string, unknown> {
  const v = field.validation ?? {};
  const out: Record<string, unknown> = {};
  if (field.type === 'string') {
    if (v.email) out.email = true;
    if (v.url) out.url = true;
    if (v.uuid) out.uuid = true;
    if (num(v.length) !== undefined) out.length = num(v.length);
    if (v.regex) out.regex = v.regex;
  }
  if (field.type === 'string' || NUMERIC_TYPES.includes(field.type)) {
    if (num(v.min) !== undefined) out.min = num(v.min);
    if (num(v.max) !== undefined) out.max = num(v.max);
  }
  if (field.type === 'enum') {
    out.enum = (v.enum ?? []).map((s) => s.trim()).filter(Boolean);
  }
  if (field.type === 'array') {
    const arrayLength: Record<string, number> = {};
    if (num(v.arrayMin) !== undefined) arrayLength.min = num(v.arrayMin) as number;
    if (num(v.arrayMax) !== undefined) arrayLength.max = num(v.arrayMax) as number;
    if (Object.keys(arrayLength).length > 0) out.arrayLength = arrayLength;
  }
  if (v.message) out.message = v.message;
  return out;
}

/** Field metadata: `unique`, plus the searchable opt-in the query layer reads. */
export function buildMeta(field: BuilderField): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (field.validation?.unique) {
    meta.unique = true;
  }
  // Only meaningful on a textual scalar; setting it elsewhere would be ignored
  // downstream, so it is not written at all.
  if (field.validation?.searchable && TEXTUAL_TYPES.includes(field.type)) {
    meta.searchable = true;
  }
  return meta;
}

/**
 * Serialize a builder node to an IPS Field. `object` takes all named children;
 * `array` takes the single element definition at `children[0]`.
 */
export function builderFieldToIPS(field: BuilderField): Record<string, unknown> {
  let children: Record<string, unknown>[] = [];
  if (field.type === 'object') {
    children = field.children.filter((child) => child.name).map(builderFieldToIPS);
  } else if (field.type === 'array' && field.children[0]) {
    children = [builderFieldToIPS(field.children[0])];
  }
  return {
    name: field.name,
    type: field.type,
    required: field.required,
    default: coerceDefault(field),
    children,
    validation: buildValidation(field),
    meta: buildMeta(field),
  };
}

/**
 * The API accepts an enum with no values, but the generated `z.enum([])` would
 * be invalid — so this is guarded client-side, before create.
 */
export function hasEmptyEnum(fields: BuilderField[]): boolean {
  return fields.some((field) => {
    if (
      field.type === 'enum' &&
      (field.validation.enum ?? []).filter((value) => value.trim()).length === 0
    ) {
      return true;
    }
    return hasEmptyEnum(field.children);
  });
}

/** Layer-1 hint: suggest a string format from a plainly-named field. */
export function suggestFor(
  field: BuilderField,
): { label: string; patch: BuilderValidation } | null {
  if (field.type !== 'string') {
    return null;
  }
  const name = field.name.toLowerCase();
  if (/email/.test(name) && !field.validation.email) {
    return { label: 'email', patch: { email: true } };
  }
  if (/(url|website|link)/.test(name) && !field.validation.url) {
    return { label: 'url', patch: { url: true } };
  }
  if (/(uuid|guid)/.test(name) && !field.validation.uuid) {
    return { label: 'uuid', patch: { uuid: true } };
  }
  return null;
}
