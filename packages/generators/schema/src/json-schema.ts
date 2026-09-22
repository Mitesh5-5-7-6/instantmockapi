/**
 * JSON Schema generator (Worker A).
 *
 * Translates IPS entities, nested types, and validation rules into standard JSON Schema draft 2020-12 (doc 04 §F5, doc 09 §4).
 */

import {
  unknownFieldPolicy,
  type InternalProjectSchema,
  type Entity,
  type Field,
  type UnknownFieldPolicy,
} from '@instantmockapi/ips';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface JSONSchemaNode {
  [key: string]: any;
}

/**
 * `additionalProperties` for the project's unknown-field policy.
 *
 * Only two of the three policies have an honest answer here, which is why this
 * returns `null` for the third:
 *
 * - `reject` — `false`. A body with an extra key really is invalid.
 * - `allow` — `true`. Stated rather than left to the default, so a reader can
 *   see the API was *asked* to keep extra keys and is not merely unopinionated.
 * - `strip` — nothing. The key is neither invalid (the request succeeds) nor
 *   retained (the stored record drops it), and JSON Schema has no way to say
 *   "accepted and discarded". Emitting `false` would document a 422 that never
 *   happens.
 */
function additionalProperties(policy: UnknownFieldPolicy): boolean | null {
  switch (policy) {
    case 'reject':
      return false;
    case 'allow':
      return true;
    default:
      return null;
  }
}

/**
 * Generates JSON Schema draft 2020-12 JSON files from an IPS schema.
 * Returns a dictionary containing file name and the generated JSON Schema content.
 */
export function generateJSONSchema(ips: InternalProjectSchema): Record<string, string> {
  const result: Record<string, string> = {};

  const policy = unknownFieldPolicy(ips.generationConfig);

  for (const entity of ips.entities) {
    const schema = generateSchemaForEntity(entity, policy);
    result[`${entity.name.toLowerCase()}.schema.json`] = JSON.stringify(schema, null, 2);
  }

  return result;
}

function generateSchemaForEntity(entity: Entity, policy: UnknownFieldPolicy): JSONSchemaNode {
  const properties: JSONSchemaNode = {};
  const required: string[] = [];

  for (const field of entity.fields) {
    properties[field.name] = renderFieldSchema(field, policy);
    if (field.required) {
      required.push(field.name);
    }
  }

  const schema: JSONSchemaNode = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: entity.name,
    type: 'object',
    properties,
  };
  if (required.length > 0) {
    schema['required'] = required;
  }
  const extras = additionalProperties(policy);
  if (extras !== null) {
    schema['additionalProperties'] = extras;
  }
  return schema;
}

function renderFieldSchema(field: Field, policy: UnknownFieldPolicy): JSONSchemaNode {
  const rules = field.validation;
  const s: JSONSchemaNode = {};

  // Base types
  switch (field.type) {
    case 'string':
      s['type'] = 'string';
      if (rules.email) s['format'] = 'email';
      if (rules.url) s['format'] = 'uri';
      if (rules.uuid) s['format'] = 'uuid';
      if (rules.min !== undefined) s['minLength'] = rules.min;
      if (rules.max !== undefined) s['maxLength'] = rules.max;
      if (rules.length !== undefined) {
        s['minLength'] = rules.length;
        s['maxLength'] = rules.length;
      }
      if (rules.regex) s['pattern'] = rules.regex;
      break;

    case 'number':
    case 'decimal':
      s['type'] = 'number';
      if (rules.min !== undefined) s['minimum'] = rules.min;
      if (rules.max !== undefined) s['maximum'] = rules.max;
      break;

    case 'integer':
      s['type'] = 'integer';
      if (rules.min !== undefined) s['minimum'] = rules.min;
      if (rules.max !== undefined) s['maximum'] = rules.max;
      break;

    case 'boolean':
      s['type'] = 'boolean';
      break;

    case 'date':
      s['type'] = 'string';
      s['format'] = 'date-time';
      break;

    case 'email':
      s['type'] = 'string';
      s['format'] = 'email';
      if (rules.min !== undefined) s['minLength'] = rules.min;
      if (rules.max !== undefined) s['maxLength'] = rules.max;
      break;

    case 'url':
      s['type'] = 'string';
      s['format'] = 'uri';
      if (rules.min !== undefined) s['minLength'] = rules.min;
      if (rules.max !== undefined) s['maxLength'] = rules.max;
      break;

    case 'uuid':
      s['type'] = 'string';
      s['format'] = 'uuid';
      break;

    // `uri`, not a bespoke format: a validator that does not know about avatars
    // still checks the thing that matters, and one that does gains nothing.
    case 'avatar':
      s['type'] = 'string';
      s['format'] = 'uri';
      s['description'] = 'Avatar image URL';
      break;

    case 'enum':
      s['type'] = 'string';
      s['enum'] = rules.enum ?? [];
      break;

    case 'object': {
      s['type'] = 'object';
      const properties: JSONSchemaNode = {};
      const required: string[] = [];

      for (const child of field.children) {
        properties[child.name] = renderFieldSchema(child, policy);
        if (child.required) {
          required.push(child.name);
        }
      }

      s['properties'] = properties;
      if (required.length > 0) {
        s['required'] = required;
      }
      // Nested objects carry the same rule as the root: the runtime walks the
      // whole tree when it looks for undeclared keys, so a schema that stopped
      // at the top level would describe a laxer API than the one running.
      const nestedExtras = additionalProperties(policy);
      if (nestedExtras !== null) {
        s['additionalProperties'] = nestedExtras;
      }
      break;
    }

    case 'array':
      s['type'] = 'array';
      if (field.children.length > 0) {
        s['items'] = renderFieldSchema(field.children[0]!, policy);
      } else {
        s['items'] = {};
      }

      if (rules.arrayLength) {
        if (rules.arrayLength.min !== undefined) s['minItems'] = rules.arrayLength.min;
        if (rules.arrayLength.max !== undefined) s['maxItems'] = rules.arrayLength.max;
      }
      break;

    default:
      s['type'] = 'string';
  }

  // Include default value if configured
  if (field.default !== undefined && field.default !== null) {
    s['default'] = field.default;
  }

  // Custom error message extension (common in AJV validation tools)
  if (rules.message) {
    s['errorMessage'] = rules.message;
  }

  // Unique metadata comment (doc 04 §F5)
  if (field.meta.unique) {
    s['unique'] = true;
  }

  return s;
}
