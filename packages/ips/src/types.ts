/**
 * Core type definitions for the Internal Project Schema (IPS).
 *
 * The IPS is the single source of truth and intermediate representation
 * for all parser inputs and generator outputs (doc 04 §F3, doc 09 §3).
 */

import type { HttpMethod } from '@instantmockapi/shared';

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
 */
export interface FieldMeta {
  unique?: boolean;
  [key: string]: unknown;
}

/**
 * Individual field definition within an entity.
 * Supports nesting via recursive `children` (doc 04 §F3).
 */
export interface Field {
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
 * An entity (corresponds to a database collection or API resource).
 */
export interface Entity {
  /** Name of the entity (PascalCase recommended, e.g. Customer) */
  name: string;
  /** Field list for the entity */
  fields: Field[];
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
}

/**
 * The root Internal Project Schema (IPS) document.
 */
export interface InternalProjectSchema {
  /** Unique ID of the project */
  projectId: string;
  /** IPS version number */
  version: number;
  /** Entities defined in the schema */
  entities: Entity[];
  /** Generation settings associated with this version */
  generationConfig: GenerationConfig;
}
