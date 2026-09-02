/**
 * Core type definitions for the Internal Project Schema (IPS).
 *
 * The IPS is the single source of truth and intermediate representation
 * for all parser inputs and generator outputs (doc 04 §F3, doc 09 §3).
 */

import type { HttpMethod, ProjectKind } from '@instantmockapi/shared';

/**
 * Switchable query capabilities of a hosted API (doc 19 §Phase 4).
 *
 * Defined **here rather than in query.ts**, where the logic that reads them
 * lives, for one structural reason: `GenerationConfig` below carries a `features`
 * block, so the toggle vocabulary is part of the IPS document shape. Keeping it
 * in query.ts made types.ts import query.ts while query.ts imported types.ts for
 * `Entity` and `Field` — a cycle dependency-cruiser rejects, and one that would
 * eventually bite at module-init time rather than only in a linter.
 */
export const QUERY_FEATURES = ['search', 'filter', 'sort', 'include'] as const;

export type QueryFeature = (typeof QUERY_FEATURES)[number];

export type QueryFeatures = Record<QueryFeature, boolean>;

/**
 * Valid primitive and nested field types in the IPS.
 * Matches doc 04 §F3 list.
 */
export type FieldType =
  | 'string'
  | 'number'
  | 'decimal'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'email'
  | 'url'
  | 'uuid'
  | 'enum'
  | 'object'
  | 'array';

/**
 * Merged validation rules (Layer 1 + Layer 2) applied to a field (doc 04 §F3).
 */
export interface ValidationRules {
  /** Mark field as email validation format rule */
  email?: boolean;
  /** Mark field as url validation format rule */
  url?: boolean;
  /** Mark field as uuid validation format rule */
  uuid?: boolean;
  /** Minimum length (for strings) or minimum value (for numbers) */
  min?: number;
  /** Maximum length (for strings) or maximum value (for numbers) */
  max?: number;
  /** Exact length (for strings) */
  length?: number;
  /** Regex pattern string (for strings) */
  regex?: string | null;
  /** Allowable enum values (for enum type) */
  enum?: string[] | null;
  /** Array length constraints (for array type) */
  arrayLength?: {
    min?: number;
    max?: number;
  } | null;
  /** Custom error message when validation fails */
  message?: string | null;
}

/**
 * Metadata key-value map for additional properties (e.g. unique constraint).
 *
 * The known keys are declared explicitly rather than left to the index
 * signature: `noPropertyAccessFromIndexSignature` is on, so `meta.identity`
 * would otherwise have to be written `meta['identity']` in every consumer.
 */
export interface FieldMeta {
  unique?: boolean;
  /** Set by `materializeRelations`: this field is the entity's identity. */
  identity?: boolean;
  /** Set by `materializeRelations`: this field holds a foreign key. */
  reference?: boolean;
  /** Server-assigned — clients are never required to send it. */
  readOnly?: boolean;
  /** For reference fields: the entity name the key points at. */
  relation?: string;
  /** Opt-in `?search=` target; when any field sets it, it becomes the whitelist. */
  searchable?: boolean;
  [key: string]: unknown;
}

/**
 * Individual field definition within an entity.
 * Supports nesting via recursive `children` (doc 04 §F3).
 */
export interface Field {
  /**
   * Stable internal id (`fld_…`), minted by `ensureSchemaIds`.
   *
   * **Optional forever.** Every field written before Phase 1 has none, and
   * `Project.ips` is `Schema.Types.Mixed`, so an old document can be any shape.
   * Read it through the backfill; never require it.
   *
   * Survives a rename — which is the whole point: `firstName` becoming `givenName` is one field changing,
   * not a field disappearing and an unrelated one appearing.
   */
  id?: string;
  /** Name of the field (camelCase recommended) */
  name: string;
  /** DataType of the field */
  type: FieldType;
  /** Whether the field is mandatory */
  required: boolean;
  /** Default value for the field (or null) */
  default: unknown;
  /** Recursive child fields (for 'object' or 'array' type of objects) */
  children: Field[];
  /** Validation rules (Layer 1 + Layer 2 merged) */
  validation: ValidationRules;
  /** Metadata parameters */
  meta: FieldMeta;
}

/**
 * How two entities relate (doc 19 §Phase A).
 *
 * `belongsTo` and `manyToMany` are the **owning** sides — they carry the key on
 * the declaring entity. `hasOne` and `hasMany` are **inverse views** that read a
 * key living on the target entity.
 */
export type RelationKind = 'belongsTo' | 'hasOne' | 'hasMany' | 'manyToMany';

/**
 * A relation from one entity to another.
 *
 * Field roles are uniform regardless of kind: `localField` always names a field
 * on *this* entity and `foreignField` always names one on the *target*. Two
 * records are related when `this[localField]` matches `target[foreignField]`
 * (for `manyToMany`, when the `localField` array contains it).
 */
export interface Relation {
  /**
   * Stable internal id (`rel_…`), minted by `ensureSchemaIds`.
   *
   * **Optional forever.** Every relation written before Phase 1 has none, and
   * `Project.ips` is `Schema.Types.Mixed`, so an old document can be any shape.
   * Read it through the backfill; never require it.
   *
   * Survives a rename — which is the whole point: a relation keeps its identity when its `name` or
   * `target` changes, so impact analysis can report a retarget as a retarget.
   */
  id?: string;
  /** Include key and JSON property on expanded records, e.g. `classroom` */
  name: string;
  kind: RelationKind;
  /** Target entity name — must exist in `ips.entities` */
  target: string;
  /** Field on this entity: the FK (belongsTo), id array (manyToMany), or identity (inverse sides) */
  localField: string;
  /** Field on the target: its identity (owning sides) or the FK pointing back (inverse sides) */
  foreignField: string;
  /** Whether the owning-side key is mandatory (ignored on inverse sides) */
  required: boolean;
  /** What happens to related records when the record on the other side is deleted */
  onDelete: 'restrict' | 'cascade' | 'setNull';
}

/**
 * Record identity for an entity — the field the hosted API routes on
 * (`GET /students/{id}`) and the value relations point at.
 *
 * `int` issues small stable integers (1..N) to seeded records so documentation
 * examples are copy-pasteable; `uuid` issues UUIDs.
 */
export interface EntityIdentity {
  /** Identity field name (conventionally `id`) */
  field: string;
  style: 'int' | 'uuid';
}

/**
 * An entity (corresponds to a database collection or API resource).
 */
export interface Entity {
  /**
   * Stable internal id (`ent_…`), minted by `ensureSchemaIds`.
   *
   * **Optional forever.** Every entity written before Phase 1 has none, and
   * `Project.ips` is `Schema.Types.Mixed`, so an old document can be any shape.
   * Read it through the backfill; never require it.
   *
   * Survives a rename — which is the whole point: renaming `User` to `Customer` must not look like
   * deleting one entity and creating another.
   */
  id?: string;
  /** Name of the entity (PascalCase recommended, e.g. Customer) */
  name: string;
  /** Field list for the entity */
  fields: Field[];
  /**
   * Relations to other entities. Optional because documents written before
   * relations existed have none — read it through `entityRelations`, never raw.
   */
  relations?: Relation[];
  /** Identity descriptor; read through `entityIdentity` for the default. */
  identity?: EntityIdentity;
  /**
   * What this resource is for, in the author's words. Surfaces as the tag and
   * schema description in the generated docs; the Single API wizard collects one
   * per endpoint. Absent on documents written before it existed.
   */
  description?: string;
}

/**
 * Generation configuration settings (doc 04 §F3).
 */
export interface GenerationConfig {
  /** Validators to generate (e.g. ['zod', 'yup', 'jsonschema']) */
  validators: string[];
  /** Code types to generate (e.g. ['typescript']) */
  types: string[];
  /** HTTP methods to route on hosted mock API */
  methods: HttpMethod[];
  /** Number of mock records to seed for hosted API */
  mockRecords: number;
  /**
   * Hosted-API query capabilities (doc 19 §Phase 4).
   *
   * Optional because every document written before the query layer has none —
   * read it through `queryFeatures`, never raw, so those resolve to all-off
   * rather than `undefined`.
   */
  features?: QueryFeatures;
}

/**
 * The root Internal Project Schema (IPS) document.
 */
export interface InternalProjectSchema {
  /** Unique ID of the project */
  projectId: string;
  /** IPS version number */
  version: number;
  /** What this project generates; absent on documents written before kinds. */
  kind?: ProjectKind;
  /**
   * Public routing id, copied from the live Project document so generators can
   * emit canonical URLs. Never authoritative here — the Project row owns it.
   */
  publicId?: string;
  /** Vanity path segment, copied from the live Project document. */
  slug?: string;
  /** Entities defined in the schema */
  entities: Entity[];
  /** Generation settings associated with this version */
  generationConfig: GenerationConfig;
}
