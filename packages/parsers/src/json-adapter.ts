/**
 * JSON Adapter for parsing raw JSON payloads into an IPS draft.
 *
 * Infers types, detects formats (email/url/uuid), and merges lists of objects
 * into nested IPS structures (doc 04 §F2, doc 09 §2).
 */

import { AppError, type ErrorDetail, type Result, ok, err } from '@instantmockapi/shared';
import type {
  InternalProjectSchema,
  Entity,
  Field,
  FieldType,
  ValidationRules,
} from '@instantmockapi/ips';

// ISO-8601 Date regex: Matches YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss.sssZ etc.
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:?\d{2})?)?$/;

// UUID v4 regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ParserCtx {
  errors: ErrorDetail[];
}

/**
 * Parse a raw JSON payload (object or array of objects) into an IPS draft schema.
 *
 * In V1, this creates a draft with default config options (doc 04 §F2, §F3).
 */
export function parseJSONPayload(
  projectId: string,
  _projectName: string,
  jsonString: string,
): Result<InternalProjectSchema, AppError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    return err(
      new AppError({
        code: 'PARSE_ERROR',
        message: 'Invalid JSON payload: ' + (e instanceof Error ? e.message : String(e)),
      }),
    );
  }

  const ctx: ParserCtx = { errors: [] };
  const entities: Entity[] = [];

  if (parsed === null || typeof parsed !== 'object') {
    return err(
      new AppError({
        code: 'PARSE_ERROR',
        message: 'JSON payload must be an object or an array of objects',
      }),
    );
  }

  if (Array.isArray(parsed)) {
    // If it's an array of objects, treat it as a list of records for the primary entity
    const merged = mergeObjects(parsed, 'root', ctx);
    entities.push({
      name: 'MainEntity',
      fields: merged,
    });
  } else {
    // If it is a single object, we can infer entities.
    // If keys themselves are objects or arrays, they become fields/sub-structures.
    // By default, we treat the root as "MainEntity"
    const rootFields = parseObjectFields(parsed as Record<string, unknown>, 'root', ctx);
    entities.push({
      name: 'MainEntity',
      fields: rootFields,
    });
  }

  if (ctx.errors.length > 0) {
    return err(
      new AppError({
        code: 'PARSE_ERROR',
        message: 'Failed to parse JSON payload',
        details: ctx.errors,
      }),
    );
  }

  const ips: InternalProjectSchema = {
    projectId,
    version: 1,
    entities,
    generationConfig: {
      validators: ['zod', 'yup'],
      types: ['typescript'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      mockRecords: 25,
    },
  };

  return ok(ips);
}

function parseObjectFields(obj: Record<string, unknown>, path: string, ctx: ParserCtx): Field[] {
  const fields: Field[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = `${path}.${key}`;
    const inferred = inferField(key, value, fieldPath, ctx);
    if (inferred) {
      fields.push(inferred);
    }
  }

  return fields;
}

function inferField(key: string, value: unknown, path: string, ctx: ParserCtx): Field | null {
  const meta = {};
  let type: FieldType = 'string';
  let required = true;
  const validation: ValidationRules = {};
  let children: Field[] = [];
  let defaultValue: unknown = null;

  if (value === null) {
    type = 'string'; // Fallback
    required = false;
  } else if (typeof value === 'boolean') {
    type = 'boolean';
    defaultValue = false;
  } else if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      type = 'integer';
    } else {
      type = 'decimal';
    }
    defaultValue = 0;
  } else if (typeof value === 'string') {
    defaultValue = '';
    // ISO Date detection
    if (ISO_DATE_REGEX.test(value)) {
      type = 'date';
    }
    // UUID detection
    else if (UUID_REGEX.test(value)) {
      type = 'uuid';
      validation.uuid = true;
    }
    // Heuristics based on key name (Layer 1 suggestions)
    else if (isEmailKey(key)) {
      type = 'email';
      validation.email = true;
    } else if (isUrlKey(key)) {
      type = 'url';
      validation.url = true;
    } else {
      type = 'string';
    }
  } else if (Array.isArray(value)) {
    type = 'array';
    defaultValue = [];
    if (value.length > 0) {
      const first = value[0];
      if (first !== null && typeof first === 'object') {
        // Array of objects -> merge them to infer schema
        children = mergeObjects(value, path, ctx);
      } else {
        // Array of primitives -> create a dummy item representing the primitive type
        const itemField = inferField('item', first, `${path}[0]`, ctx);
        if (itemField) {
          children = [itemField];
        }
      }
    } else {
      // Empty array -> default to string item
      children = [
        {
          name: 'item',
          type: 'string',
          required: true,
          default: '',
          children: [],
          validation: {},
          meta: {},
        },
      ];
    }
  } else if (typeof value === 'object') {
    type = 'object';
    children = parseObjectFields(value as Record<string, unknown>, path, ctx);
  } else {
    ctx.errors.push({ path, issue: `Unsupported JSON type: ${typeof value}` });
    return null;
  }

  return {
    name: key,
    type,
    required,
    default: defaultValue,
    children,
    validation,
    meta,
  };
}

/** Merge keys/types from multiple objects in an array to create a unified schema. */
function mergeObjects(arr: unknown[], path: string, ctx: ParserCtx): Field[] {
  const mergedFieldsMap = new Map<string, { values: unknown[]; paths: string[] }>();

  arr.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      ctx.errors.push({ path: itemPath, issue: 'Expected an object inside array elements' });
      return;
    }

    const obj = item as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      const existing = mergedFieldsMap.get(key);
      const valPath = `${itemPath}.${key}`;
      if (existing) {
        existing.values.push(value);
        existing.paths.push(valPath);
      } else {
        mergedFieldsMap.set(key, { values: [value], paths: [valPath] });
      }
    }
  });

  const fields: Field[] = [];

  for (const [key, info] of mergedFieldsMap.entries()) {
    // Deduplicate types, pick most specific or report incompatibility
    const inferredFields = info.values
      .map((val, idx) => inferField(key, val, info.paths[idx]!, ctx))
      .filter((f): f is Field => f !== null);

    if (inferredFields.length === 0) continue;

    // Pick first as template, merge properties
    const baseField = inferredFields[0]!;

    // If any record had this missing, make it optional
    if (info.values.length < arr.length || inferredFields.some((f) => !f.required)) {
      baseField.required = false;
    }

    // Merge type if different (e.g. integer vs decimal -> decimal)
    const types = new Set(inferredFields.map((f) => f.type));
    if (types.size > 1) {
      if (types.has('decimal') && types.has('integer')) {
        baseField.type = 'decimal';
      } else {
        // Conflicting types -> default to string
        baseField.type = 'string';
      }
    }

    // If type is object, recursively merge child objects
    if (baseField.type === 'object') {
      const childObjects = info.values.filter(
        (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
      );
      baseField.children = mergeObjects(childObjects, `${path}.*`, ctx);
    }
    // If type is array of objects, recursively merge grandchildren
    else if (baseField.type === 'array') {
      const childArrays = info.values.filter(Array.isArray);
      const flattenedItems = childArrays.flat().filter((v) => typeof v === 'object' && v !== null);
      if (flattenedItems.length > 0) {
        baseField.children = mergeObjects(flattenedItems, `${path}.*`, ctx);
      }
    }

    fields.push(baseField);
  }

  return fields;
}

function isEmailKey(key: string): boolean {
  const k = key.toLowerCase();
  return k === 'email' || k.endsWith('email') || k.includes('_email') || k.includes('-email');
}

function isUrlKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k === 'url' ||
    k === 'website' ||
    k === 'link' ||
    k.endsWith('url') ||
    k.endsWith('website') ||
    k.endsWith('link')
  );
}
