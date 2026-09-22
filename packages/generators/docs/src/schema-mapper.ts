/**
 * IPS field model → OpenAPI 3.1 schema objects.
 * Mirrors Worker A's rule translation, targeting the OpenAPI 3.1 schema dialect
 * (aligned with JSON Schema 2020-12 — optional fields use a `["type","null"]`
 * type array, since 3.1 removes the `nullable` keyword).
 */

import { EXAMPLE_AVATAR_URL } from '@instantmockapi/shared';
import {
  DEFAULT_UNKNOWN_FIELDS,
  type Entity,
  type Field,
  type UnknownFieldPolicy,
} from '@instantmockapi/ips';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface OpenAPISchemaNode {
  [key: string]: any;
}

/**
 * `additionalProperties` for the project's unknown-field policy.
 *
 * Same three-way split, and the same `null` for `strip`, as Worker A's JSON
 * Schema generator — the two describe the same API and a reader comparing the
 * OpenAPI document against the downloaded schema must not find them disagreeing
 * about whether an extra key is an error.
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

export function entitySchema(
  entity: Entity,
  policy: UnknownFieldPolicy = DEFAULT_UNKNOWN_FIELDS,
): OpenAPISchemaNode {
  const properties: OpenAPISchemaNode = {};
  const required: string[] = [];

  for (const field of entity.fields) {
    properties[field.name] = fieldSchema(field, policy);
    if (field.required) {
      required.push(field.name);
    }
  }

  const schema: OpenAPISchemaNode = { type: 'object', properties };
  if (required.length > 0) {
    schema['required'] = required;
  }
  const extras = additionalProperties(policy);
  if (extras !== null) {
    schema['additionalProperties'] = extras;
  }
  return schema;
}

function fieldSchema(field: Field, policy: UnknownFieldPolicy): OpenAPISchemaNode {
  const rules = field.validation;
  const s: OpenAPISchemaNode = {};

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
      break;

    case 'url':
      s['type'] = 'string';
      s['format'] = 'uri';
      break;

    case 'uuid':
      s['type'] = 'string';
      s['format'] = 'uuid';
      break;

    // Carries an example because this is the one type whose value a reader
    // cannot picture from `string`/`uri` alone.
    case 'avatar':
      s['type'] = 'string';
      s['format'] = 'uri';
      s['description'] = 'Avatar image URL';
      s['example'] = EXAMPLE_AVATAR_URL;
      break;

    case 'enum':
      s['type'] = 'string';
      s['enum'] = rules.enum ?? [];
      break;

    case 'object': {
      s['type'] = 'object';
      const properties: OpenAPISchemaNode = {};
      const required: string[] = [];
      for (const child of field.children) {
        properties[child.name] = fieldSchema(child, policy);
        if (child.required) {
          required.push(child.name);
        }
      }
      s['properties'] = properties;
      if (required.length > 0) {
        s['required'] = required;
      }
      // Nested objects inherit the rule, matching the runtime's full-tree walk.
      const nestedExtras = additionalProperties(policy);
      if (nestedExtras !== null) {
        s['additionalProperties'] = nestedExtras;
      }
      break;
    }

    case 'array':
      s['type'] = 'array';
      s['items'] = field.children.length > 0 ? fieldSchema(field.children[0]!, policy) : {};
      if (rules.arrayLength) {
        if (rules.arrayLength.min !== undefined) s['minItems'] = rules.arrayLength.min;
        if (rules.arrayLength.max !== undefined) s['maxItems'] = rules.arrayLength.max;
      }
      break;

    default:
      s['type'] = 'string';
  }

  if (field.default !== undefined && field.default !== null) {
    s['default'] = field.default;
  }
  // OpenAPI 3.1 drops `nullable`; express optionality as a null union instead.
  // Every branch above sets a string `type`, so this guard is always taken.
  if (!field.required && typeof s['type'] === 'string') {
    s['type'] = [s['type'], 'null'];
  }

  return s;
}
