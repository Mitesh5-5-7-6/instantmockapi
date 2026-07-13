/**
 * TypeScript interface generator (Worker C).
 *
 * Translates IPS schemas and nested structures into clean, compile-safe TypeScript types (doc 04 §F6, doc 09 §4).
 */

import type { InternalProjectSchema, Entity, Field } from '@instantmockapi/ips';

interface InterfaceDefinition {
  name: string;
  fields: string[];
}

/**
 * Generates TypeScript interface files from an IPS schema.
 * Returns a dictionary containing file name and the generated TypeScript content.
 */
export function generateTypeScript(ips: InternalProjectSchema): Record<string, string> {
  const result: Record<string, string> = {};

  for (const entity of ips.entities) {
    const code = generateTSForEntity(entity);
    result[`${entity.name.toLowerCase()}.types.ts`] = code;
  }

  return result;
}

function generateTSForEntity(entity: Entity): string {
  const definitions: InterfaceDefinition[] = [];

  // Main entity interface fields
  const mainFields: string[] = [];

  for (const field of entity.fields) {
    mainFields.push(renderFieldLine(entity.name, field, definitions));
  }

  definitions.push({
    name: entity.name,
    fields: mainFields,
  });

  // Render all interfaces from leaf to root (or alphabetical/ordered)
  const rendered = definitions.map((def) => {
    const lines: string[] = [];
    lines.push(`export interface ${def.name} {`);
    lines.push(def.fields.map((line) => `  ${line}`).join('\n'));
    lines.push('}');
    return lines.join('\n');
  });

  return rendered.join('\n\n') + '\n';
}

function renderFieldLine(
  parentName: string,
  field: Field,
  definitions: InterfaceDefinition[],
): string {
  const optional = field.required ? '' : '?';
  const typeName = getFieldTypeName(parentName, field, definitions);
  const comment = getFieldComment(field);

  return `${field.name}${optional}: ${typeName};${comment}`;
}

function getFieldTypeName(
  parentName: string,
  field: Field,
  definitions: InterfaceDefinition[],
): string {
  switch (field.type) {
    case 'string':
    case 'email':
    case 'url':
    case 'uuid':
      return 'string';

    case 'number':
    case 'decimal':
    case 'integer':
      return 'number';

    case 'boolean':
      return 'boolean';

    case 'date':
      return 'string'; // Represented as ISO-8601 string on wire (doc 04 §F6)

    case 'enum': {
      const values = field.validation.enum ?? [];
      if (values.length === 0) return 'string';
      return values.map((v) => JSON.stringify(v)).join(' | ');
    }
    case 'object': {
      const subInterfaceName = `${parentName}${capitalize(field.name)}`;
      const subFields = field.children.map((child) =>
        renderFieldLine(subInterfaceName, child, definitions),
      );
      definitions.push({
        name: subInterfaceName,
        fields: subFields,
      });
      return subInterfaceName;
    }
    case 'array':
      if (field.children.length > 0) {
        const itemField = field.children[0]!;
        // Handle array of objects vs primitives
        if (itemField.type === 'object') {
          const itemInterfaceName = `${parentName}${capitalize(field.name)}Item`;
          const itemFields = itemField.children.map((child) =>
            renderFieldLine(itemInterfaceName, child, definitions),
          );
          definitions.push({
            name: itemInterfaceName,
            fields: itemFields,
          });
          return `${itemInterfaceName}[]`;
        } else {
          const itemTypeName = getFieldTypeName(parentName, itemField, definitions);
          // If the type name contains union operators, wrap it in parens
          return itemTypeName.includes('|') ? `(${itemTypeName})[]` : `${itemTypeName}[]`;
        }
      }
      return 'any[]';

    default:
      return 'unknown';
  }
}

function getFieldComment(field: Field): string {
  const comments: string[] = [];

  if (field.type === 'date') {
    comments.push('ISO-8601 Date format');
  }

  if (field.meta.unique) {
    comments.push('unique');
  }

  if (comments.length > 0) {
    return ` // ${comments.join(', ')}`;
  }
  return '';
}

function capitalize(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
