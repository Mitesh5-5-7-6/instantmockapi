/**
 * Swagger / OpenAPI Adapter.
 *
 * Parses an OpenAPI 3.x or Swagger 2.0 spec (JSON or YAML) into an IPS draft
 * (doc 02 §3, doc 03, doc 04 §F2, doc 09 §2).
 *
 * - OpenAPI 3.x schemas are read from `components.schemas`.
 * - Swagger 2.0 schemas are read from `definitions`.
 * - `$ref`s to sibling schemas are inlined (V1 has no entity relationships,
 *   so referenced object schemas become nested objects). Circular `$ref`s are
 *   detected and stopped rather than recursed infinitely.
 * - Depth is capped (default 10, matching the IPS depth cap in doc 04 §F3);
 *   the assembled IPS is finally checked with the canonical `validateIPS`.
 */

import yaml from 'js-yaml';
import {
  AppError,
  type ErrorDetail,
  type Result,
  ok,
  err,
  type HttpMethod,
  HTTP_METHODS,
} from '@instantmockapi/shared';
import {
  validateIPS,
  type InternalProjectSchema,
  type Entity,
  type Field,
  type FieldType,
  type ValidationRules,
} from '@instantmockapi/ips';

/** Default generation config for a fresh draft (mirrors the JSON adapter). */
const DEFAULT_GENERATION_CONFIG = {
  validators: ['zod', 'yup'],
  types: ['typescript'],
  methods: [...HTTP_METHODS] as HttpMethod[],
  mockRecords: 25,
};

/** Default nesting depth cap — aligns with the IPS default (doc 04 §F3). */
const DEFAULT_MAX_DEPTH = 10;

/**
 * The subset of an OpenAPI/Swagger Schema Object we read. Intentionally loose:
 * specs vary, and we only consume the JSON-Schema-shaped fields we map from.
 */
interface SchemaObject {
  type?: string;
  format?: string;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
  $ref?: string;
  nullable?: boolean;
}

interface ParserCtx {
  errors: ErrorDetail[];
  /** All named schemas, used to resolve `$ref`. */
  allSchemas: Record<string, SchemaObject>;
  maxDepth: number;
}

/**
 * Parse an OpenAPI 3.x or Swagger 2.0 spec string (JSON or YAML) into an IPS draft.
 */
export function parseSwaggerSpec(
  projectId: string,
  _projectName: string,
  specString: string,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Result<InternalProjectSchema, AppError> {
  // 1. Parse as JSON first, then fall back to YAML.
  const spec = parseSpecString(specString);
  if (!spec.ok) {
    return err(spec.error);
  }

  const doc = spec.value as Record<string, unknown>;

  // 2. Locate schema definitions (OpenAPI 3 `components.schemas` or Swagger 2 `definitions`).
  const components = doc['components'] as { schemas?: Record<string, SchemaObject> } | undefined;
  const schemas: Record<string, SchemaObject> | undefined =
    components?.schemas ?? (doc['definitions'] as Record<string, SchemaObject> | undefined);

  if (!schemas || typeof schemas !== 'object' || Object.keys(schemas).length === 0) {
    return err(
      new AppError({
        code: 'PARSE_ERROR',
        message:
          'No schema definitions found. Expected OpenAPI `components.schemas` or Swagger `definitions`.',
      }),
    );
  }

  const ctx: ParserCtx = { errors: [], allSchemas: schemas, maxDepth };
  const entities: Entity[] = [];

  // 3. Each object schema with properties becomes an entity.
  for (const [rawName, rawSchema] of Object.entries(schemas)) {
    const resolved = resolveRef(rawSchema, ctx, rawName, new Set()) ?? rawSchema;
    const isObjectLike =
      resolved.type === 'object' || (resolved.type === undefined && !!resolved.properties);

    if (!isObjectLike || !resolved.properties) {
      // Top-level non-object schemas (enum aliases, primitives) aren't entities in V1.
      ctx.errors.push({
        path: rawName,
        issue: `Schema '${rawName}' is not an object with properties; skipped (only object schemas become entities in V1).`,
      });
      continue;
    }

    const fields = objectToFields(resolved, sanitizeName(rawName), ctx, 1);
    if (fields.length > 0) {
      entities.push({ name: sanitizeName(rawName), fields });
    }
  }

  if (entities.length === 0) {
    return err(
      new AppError({
        code: 'PARSE_ERROR',
        message: 'No object schemas with properties were found to build entities.',
        details: ctx.errors,
      }),
    );
  }

  const ips: InternalProjectSchema = {
    projectId,
    version: 1,
    entities,
    generationConfig: { ...DEFAULT_GENERATION_CONFIG },
  };

  // 4. Validate the assembled IPS with the canonical validator (depth, names, shape).
  const validation = validateIPS(ips, maxDepth);
  if (!validation.ok) {
    return err(validation.error);
  }

  return ok(validation.value);
}

// ---------------------------------------------------------------------------
// Spec string parsing (JSON, then YAML fallback)
// ---------------------------------------------------------------------------

function parseSpecString(specString: string): Result<unknown, AppError> {
  const trimmed = specString.trim();
  if (!trimmed) {
    return err(new AppError({ code: 'PARSE_ERROR', message: 'Spec is empty.' }));
  }

  // Try JSON.
  try {
    return ok(JSON.parse(trimmed));
  } catch {
    // Not JSON — fall through to YAML.
  }

  // Try YAML.
  try {
    const loaded = yaml.load(trimmed);
    if (!loaded || typeof loaded !== 'object') {
      return err(
        new AppError({ code: 'PARSE_ERROR', message: 'Spec must be a JSON or YAML object.' }),
      );
    }
    return ok(loaded);
  } catch (e) {
    return err(
      new AppError({
        code: 'PARSE_ERROR',
        message: 'Spec is not valid JSON or YAML: ' + (e instanceof Error ? e.message : String(e)),
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Schema → IPS field mapping (verified against the golden-fixture convention)
// ---------------------------------------------------------------------------

/** Map an object schema's `properties` into IPS fields, honoring `required[]`. */
function objectToFields(
  schema: SchemaObject,
  path: string,
  ctx: ParserCtx,
  depth: number,
): Field[] {
  const props = schema.properties ?? {};
  const requiredSet = new Set(schema.required ?? []);
  const fields: Field[] = [];

  for (const [propName, propSchema] of Object.entries(props)) {
    const field = schemaToField(propName, propSchema, `${path}.${propName}`, ctx, depth);
    field.required = requiredSet.has(propName);
    fields.push(field);
  }

  return fields;
}

/**
 * Map a single schema node to an IPS Field.
 *
 * Array fields follow the canonical convention: `children` is a single-element
 * `[itemField]`, and an array of objects yields `[{ type: 'object', children: [...] }]`.
 */
function schemaToField(
  name: string,
  rawSchema: SchemaObject,
  path: string,
  ctx: ParserCtx,
  depth: number,
): Field {
  // Depth guard — also prevents infinite recursion on circular `$ref`s.
  if (depth > ctx.maxDepth) {
    ctx.errors.push({ path, issue: `Nesting depth ${depth} exceeds max depth of ${ctx.maxDepth}` });
    return leafField(name, null);
  }

  const s = resolveRef(rawSchema, ctx, path, new Set()) ?? rawSchema;
  const validation: ValidationRules = {};
  let type: FieldType = 'string';
  let children: Field[] = [];
  const defaultValue: unknown = s.default === undefined ? null : s.default;

  // Enum wins regardless of `type`.
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    type = 'enum';
    validation.enum = s.enum.map((v) => String(v));
  } else {
    switch (s.type) {
      case 'string':
        type = mapStringFormat(s.format);
        if (type === 'email') validation.email = true;
        else if (type === 'url') validation.url = true;
        else if (type === 'uuid') validation.uuid = true;
        if (s.minLength !== undefined) validation.min = s.minLength;
        if (s.maxLength !== undefined) validation.max = s.maxLength;
        if (s.pattern) validation.regex = s.pattern;
        break;

      case 'integer':
        type = 'integer';
        if (s.minimum !== undefined) validation.min = s.minimum;
        if (s.maximum !== undefined) validation.max = s.maximum;
        break;

      case 'number':
        type = 'decimal';
        if (s.minimum !== undefined) validation.min = s.minimum;
        if (s.maximum !== undefined) validation.max = s.maximum;
        break;

      case 'boolean':
        type = 'boolean';
        break;

      case 'object':
        type = 'object';
        children = objectToFields(s, path, ctx, depth + 1);
        break;

      case 'array': {
        type = 'array';
        if (s.minItems !== undefined || s.maxItems !== undefined) {
          validation.arrayLength = {};
          if (s.minItems !== undefined) validation.arrayLength.min = s.minItems;
          if (s.maxItems !== undefined) validation.arrayLength.max = s.maxItems;
        }
        const itemField = schemaToField('item', s.items ?? {}, `${path}[0]`, ctx, depth + 1);
        itemField.required = true;
        children = [itemField];
        break;
      }

      default:
        // No explicit type: treat as object if it has properties, else a string leaf.
        if (s.properties) {
          type = 'object';
          children = objectToFields(s, path, ctx, depth + 1);
        } else {
          type = 'string';
        }
    }
  }

  return { name, type, required: false, default: defaultValue, children, validation, meta: {} };
}

/** Resolve a `$ref` to a sibling schema, guarding against circular references. */
function resolveRef(
  schema: SchemaObject,
  ctx: ParserCtx,
  path: string,
  visited: Set<string>,
): SchemaObject | null {
  if (!schema || !schema.$ref) return schema;

  const refName = schema.$ref.split('/').pop() ?? '';
  if (visited.has(refName)) {
    ctx.errors.push({ path, issue: `Circular $ref to '${refName}' is not supported in V1.` });
    return { type: 'object', properties: {} };
  }

  const target = ctx.allSchemas[refName];
  if (!target) {
    ctx.errors.push({ path, issue: `Unresolved $ref '${schema.$ref}'.` });
    return { type: 'string' };
  }

  visited.add(refName);
  return resolveRef(target, ctx, path, visited);
}

/** Map an OpenAPI string `format` to an IPS field type. */
function mapStringFormat(format?: string): FieldType {
  switch (format) {
    case 'email':
      return 'email';
    case 'uri':
    case 'url':
      return 'url';
    case 'uuid':
      return 'uuid';
    case 'date':
    case 'date-time':
      return 'date';
    default:
      return 'string';
  }
}

/** Build an empty string leaf field (used for depth/ref fallbacks). */
function leafField(name: string, defaultValue: unknown): Field {
  return {
    name,
    type: 'string',
    required: false,
    default: defaultValue,
    children: [],
    validation: {},
    meta: {},
  };
}

/**
 * Coerce a schema name into a valid IPS entity name.
 * The IPS validator requires names matching /^[A-Za-z][A-Za-z0-9_]*$/.
 */
function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `Entity_${cleaned}`;
}
