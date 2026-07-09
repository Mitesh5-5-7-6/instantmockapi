/**
 * Yup validation schema generator (Worker B).
 *
 * Translates IPS entities, nested types, and validation rules into executable Yup code (doc 04 §F5, doc 09 §4).
 */

import type { InternalProjectSchema, Entity, Field } from '@instantmockapi/ips';

/**
 * Generates executable Yup TypeScript code from an IPS schema.
 * Returns a dictionary containing file name and the generated TypeScript content.
 */
export function generateYup(ips: InternalProjectSchema): Record<string, string> {
  const result: Record<string, string> = {};

  for (const entity of ips.entities) {
    const code = generateYupForEntity(entity);
    result[`${entity.name.toLowerCase()}.yup.ts`] = code;
  }

  return result;
}

function generateYupForEntity(entity: Entity): string {
  const lines: string[] = [];
  lines.push("import * as yup from 'yup';");
  lines.push('');

  // Recursive field generation starts
  const renderedFields = entity.fields.map((field) => {
    return `  ${field.name}: ${renderField(field, 1)}`;
  });

  lines.push(`export const ${entity.name}Schema = yup.object({`);
  lines.push(renderedFields.join(',\n'));
  lines.push('});');
  lines.push('');
  lines.push(`export type ${entity.name} = yup.InferType<typeof ${entity.name}Schema>;`);
  lines.push('');

  return lines.join('\n');
}

function renderField(field: Field, indent: number): string {
  const rules = field.validation;
  const msgArg = rules.message ? `, ${JSON.stringify(rules.message)}` : '';
  const onlyMsgArg = rules.message ? JSON.stringify(rules.message) : '';

  let base = '';

  switch (field.type) {
    case 'string':
      base = 'yup.string()';
      if (rules.email) base += `.email(${onlyMsgArg})`;
      if (rules.url) base += `.url(${onlyMsgArg})`;
      if (rules.uuid) base += `.uuid(${onlyMsgArg})`;
      if (rules.min !== undefined) base += `.min(${rules.min}${msgArg})`;
      if (rules.max !== undefined) base += `.max(${rules.max}${msgArg})`;
      if (rules.length !== undefined) base += `.length(${rules.length}${msgArg})`;
      if (rules.regex) base += `.matches(/${rules.regex}/${msgArg})`;
      break;

    case 'number':
    case 'decimal':
      base = 'yup.number()';
      if (rules.min !== undefined) base += `.min(${rules.min}${msgArg})`;
      if (rules.max !== undefined) base += `.max(${rules.max}${msgArg})`;
      break;

    case 'integer':
      base = 'yup.number().integer()';
      if (rules.min !== undefined) base += `.min(${rules.min}${msgArg})`;
      if (rules.max !== undefined) base += `.max(${rules.max}${msgArg})`;
      break;

    case 'boolean':
      base = 'yup.boolean()';
      break;

    case 'date':
      base = 'yup.date()';
      break;

    case 'email':
      base = `yup.string().email(${onlyMsgArg})`;
      if (rules.min !== undefined) base += `.min(${rules.min}${msgArg})`;
      if (rules.max !== undefined) base += `.max(${rules.max}${msgArg})`;
      break;

    case 'url':
      base = `yup.string().url(${onlyMsgArg})`;
      if (rules.min !== undefined) base += `.min(${rules.min}${msgArg})`;
      if (rules.max !== undefined) base += `.max(${rules.max}${msgArg})`;
      break;

    case 'uuid':
      base = `yup.string().uuid(${onlyMsgArg})`;
      break;

    case 'enum':
      const enumValues = rules.enum ?? [];
      const formattedEnum = enumValues.map((v) => JSON.stringify(v)).join(', ');
      base = `yup.string().oneOf([${formattedEnum}]${msgArg})`;
      break;

    case 'object':
      const objIndent = '  '.repeat(indent);
      const innerFields = field.children.map((child) => {
        return `${objIndent}  ${child.name}: ${renderField(child, indent + 1)}`;
      });
      base = `yup.object({\n${innerFields.join(',\n')}\n${objIndent}})`;
      break;

    case 'array':
      if (field.children.length > 0) {
        const itemField = field.children[0]!;
        // Handle array of objects or primitives
        const renderedItem = renderField(itemField, indent + 1);
        base = `yup.array().of(${renderedItem})`;
      } else {
        base = 'yup.array()';
      }

      // Check array limits
      if (rules.arrayLength) {
        if (rules.arrayLength.min !== undefined) base += `.min(${rules.arrayLength.min})`;
        if (rules.arrayLength.max !== undefined) base += `.max(${rules.arrayLength.max})`;
      }
      break;

    default:
      base = 'yup.mixed()';
  }

  // Handle optional / required constraints
  if (field.required) {
    base += `.required(${onlyMsgArg})`;
  } else {
    base += '.optional()';
  }

  if (field.default !== undefined && field.default !== null) {
    const formattedDefault = JSON.stringify(field.default);
    base += `.default(${formattedDefault})`;
  }

  // Emit unique comments
  if (field.meta.unique) {
    base += ' /* unique */';
  }

  return base;
}
