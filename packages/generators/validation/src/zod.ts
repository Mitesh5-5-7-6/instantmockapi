/**
 * Zod validation schema generator (Worker B).
 *
 * Translates IPS entities, nested types, and validation rules into executable Zod code (doc 04 §F5, doc 09 §4).
 */

import type { InternalProjectSchema, Entity, Field } from '@instantmockapi/ips';

/**
 * Generates executable Zod TypeScript code from an IPS schema.
 * Returns a dictionary containing file name and the generated TypeScript content.
 */
export function generateZod(ips: InternalProjectSchema): Record<string, string> {
  const result: Record<string, string> = {};

  for (const entity of ips.entities) {
    const code = generateZodForEntity(entity);
    result[`${entity.name.toLowerCase()}.zod.ts`] = code;
  }

  return result;
}

function generateZodForEntity(entity: Entity): string {
  const lines: string[] = [];
  lines.push("import { z } from 'zod';");
  lines.push('');

  // Recursive field generation starts
  const renderedFields = entity.fields.map((field) => {
    return `  ${field.name}: ${renderField(field, 1)}`;
  });

  lines.push(`export const ${entity.name}Schema = z.object({`);
  lines.push(renderedFields.join(',\n'));
  lines.push('});');
  lines.push('');
  lines.push(`export type ${entity.name} = z.infer<typeof ${entity.name}Schema>;`);
  lines.push('');

  return lines.join('\n');
}

function renderField(field: Field, indent: number): string {
  const rules = field.validation;
  const msgOpt = rules.message ? `, { message: ${JSON.stringify(rules.message)} }` : '';
  const noMsgOpt = rules.message ? `{ message: ${JSON.stringify(rules.message)} }` : '';

  let base = '';

  switch (field.type) {
    case 'string':
      base = 'z.string()';
      if (rules.email) base += `.email(${noMsgOpt})`;
      if (rules.url) base += `.url(${noMsgOpt})`;
      if (rules.uuid) base += `.uuid(${noMsgOpt})`;
      if (rules.min !== undefined) base += `.min(${rules.min}${msgOpt})`;
      if (rules.max !== undefined) base += `.max(${rules.max}${msgOpt})`;
      if (rules.length !== undefined) base += `.length(${rules.length}${msgOpt})`;
      if (rules.regex) base += `.regex(/${rules.regex}/${msgOpt})`;
      break;

    case 'number':
    case 'decimal':
      base = 'z.number()';
      if (rules.min !== undefined) base += `.min(${rules.min}${msgOpt})`;
      if (rules.max !== undefined) base += `.max(${rules.max}${msgOpt})`;
      break;

    case 'integer':
      base = 'z.number().int()';
      if (rules.min !== undefined) base += `.min(${rules.min}${msgOpt})`;
      if (rules.max !== undefined) base += `.max(${rules.max}${msgOpt})`;
      break;

    case 'boolean':
      base = 'z.boolean()';
      break;

    case 'date':
      base = 'z.coerce.date()';
      break;

    case 'email':
      base = `z.string().email(${noMsgOpt})`;
      if (rules.min !== undefined) base += `.min(${rules.min}${msgOpt})`;
      if (rules.max !== undefined) base += `.max(${rules.max}${msgOpt})`;
      break;

    case 'url':
      base = `z.string().url(${noMsgOpt})`;
      if (rules.min !== undefined) base += `.min(${rules.min}${msgOpt})`;
      if (rules.max !== undefined) base += `.max(${rules.max}${msgOpt})`;
      break;

    case 'uuid':
      base = `z.string().uuid(${noMsgOpt})`;
      break;

    case 'enum':
      const enumValues = rules.enum ?? [];
      const formattedEnum = enumValues.map((v) => JSON.stringify(v)).join(', ');
      base = `z.enum([${formattedEnum}])`;
      break;

    case 'object':
      const objIndent = '  '.repeat(indent);
      const innerFields = field.children.map((child) => {
        return `${objIndent}  ${child.name}: ${renderField(child, indent + 1)}`;
      });
      base = `z.object({\n${innerFields.join(',\n')}\n${objIndent}})`;
      break;

    case 'array':
      if (field.children.length > 0) {
        const itemField = field.children[0]!;
        // Handle array of objects or primitives
        const renderedItem = renderField(itemField, indent + 1);
        base = `z.array(${renderedItem})`;
      } else {
        base = 'z.array(z.unknown())';
      }

      // Check array limits
      if (rules.arrayLength) {
        if (rules.arrayLength.min !== undefined) base += `.min(${rules.arrayLength.min})`;
        if (rules.arrayLength.max !== undefined) base += `.max(${rules.arrayLength.max})`;
      }
      break;

    default:
      base = 'z.unknown()';
  }

  // Handle optional / nullable / default constraints (doc 04 §F5)
  if (!field.required) {
    base += '.optional()';
  }
  if (field.default !== undefined && field.default !== null) {
    const formattedDefault = JSON.stringify(field.default);
    base += `.default(${formattedDefault})`;
  } else if (field.required === false) {
    // If not required and no default, Zod will accept undefined. If nullable is desired, can append `.nullable()`
    // For V1, we mirror optionality as `.optional()`.
  }

  // Emit unique comments (doc 04 §F5, doc 09 §4)
  if (field.meta.unique) {
    base += ' /* unique */';
  }

  return base;
}
