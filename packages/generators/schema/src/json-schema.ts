/**
 * JSON Schema generator (Worker A).
 *
 * Translates IPS entities, nested types, and validation rules into standard JSON Schema draft-07 (doc 04 §F5, doc 09 §4).
 */

import type { InternalProjectSchema, Entity, Field } from '@instantmockapi/ips';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface JSONSchemaNode {
  [key: string]: any;
}

/**
 * Generates JSON Schema draft-07 JSON files from an IPS schema.
 * Returns a dictionary containing file name and the generated JSON Schema content.
 */
export function generateJSONSchema(ips: InternalProjectSchema): Record<string, string> {
  const result: Record<string, string> = {};

  for (const entity of ips.entities) {
    const schema = generateSchemaForEntity(entity);
    result[`${entity.name.toLowerCase()}.schema.json`] = JSON.stringify(schema, null, 2);
  }

  return result;
}

function generateSchemaForEntity(entity: Entity): JSONSchemaNode {
  const properties: JSONSchemaNode = {};
  const required: string[] = [];

  for (const field of entity.fields) {
    properties[field.name] = renderFieldSchema(field);
    if (field.required) {
      required.push(field.name);
    }
  }

  const schema: JSONSchemaNode = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: entity.name,
    type: 'object',
    properties,
  };
  if (required.length > 0) {
    schema['required'] = required;
  }
  return schema;
}

function renderFieldSchema(field: Field): JSONSchemaNode {
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

    case 'enum':
      s['type'] = 'string';
      s['enum'] = rules.enum ?? [];
      break;

    case 'object': {
      s['type'] = 'object';
      const properties: JSONSchemaNode = {};
      const required: string[] = [];

      for (const child of field.children) {
        properties[child.name] = renderFieldSchema(child);
        if (child.required) {
          required.push(child.name);
        }
      }

      s['properties'] = properties;
      if (required.length > 0) {
        s['required'] = required;
      }
      break;
    }

    case 'array':
      s['type'] = 'array';
      if (field.children.length > 0) {
        s['items'] = renderFieldSchema(field.children[0]!);
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
