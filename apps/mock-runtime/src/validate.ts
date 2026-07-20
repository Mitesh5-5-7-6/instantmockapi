/**
 * Safe interpreter over the hosted validation model (doc 13 §4).
 *
 * The runtime never executes generated validator code — it interprets the
 * IPS-derived field rules Worker F embedded in the hosting config, so hosted
 * writes obey exactly the rules the downloadable Zod/Yup encode.
 */

import type { ErrorDetail } from '@instantmockapi/shared';
import type { HostedFieldRule } from '@instantmockapi/generator-hosting';

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkString(field: HostedFieldRule, value: string, path: string, errors: ErrorDetail[]) {
  const rules = field.validation;
  if (rules.min !== undefined && value.length < rules.min) {
    errors.push({ path, issue: rules.message ?? `must be at least ${rules.min} characters` });
  }
  if (rules.max !== undefined && value.length > rules.max) {
    errors.push({ path, issue: rules.message ?? `must be at most ${rules.max} characters` });
  }
  if (rules.length !== undefined && value.length !== rules.length) {
    errors.push({ path, issue: rules.message ?? `must be exactly ${rules.length} characters` });
  }
  if (rules.regex && !new RegExp(rules.regex).test(value)) {
    errors.push({ path, issue: rules.message ?? `must match pattern ${rules.regex}` });
  }
  if (rules.email && !EMAIL_PATTERN.test(value)) {
    errors.push({ path, issue: rules.message ?? 'must be a valid email address' });
  }
  if (rules.url) {
    try {
      new URL(value);
    } catch {
      errors.push({ path, issue: rules.message ?? 'must be a valid URL' });
    }
  }
  if (rules.uuid && !UUID_PATTERN.test(value)) {
    errors.push({ path, issue: rules.message ?? 'must be a valid UUID' });
  }
}

function checkNumber(field: HostedFieldRule, value: number, path: string, errors: ErrorDetail[]) {
  const rules = field.validation;
  if (rules.min !== undefined && value < rules.min) {
    errors.push({ path, issue: rules.message ?? `must be >= ${rules.min}` });
  }
  if (rules.max !== undefined && value > rules.max) {
    errors.push({ path, issue: rules.message ?? `must be <= ${rules.max}` });
  }
}

function checkField(
  field: HostedFieldRule,
  value: unknown,
  path: string,
  errors: ErrorDetail[],
): void {
  const fail = (issue: string): void => {
    errors.push({ path, issue: field.validation.message ?? issue });
  };

  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') {
        return fail('must be a string');
      }
      return checkString(field, value, path, errors);

    case 'number':
    case 'decimal':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return fail('must be a number');
      }
      return checkNumber(field, value, path, errors);

    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return fail('must be an integer');
      }
      return checkNumber(field, value, path, errors);

    case 'boolean':
      if (typeof value !== 'boolean') {
        return fail('must be a boolean');
      }
      return;

    case 'date':
      if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
        return fail('must be an ISO-8601 date string');
      }
      return;

    case 'email':
      if (typeof value !== 'string' || !EMAIL_PATTERN.test(value)) {
        return fail('must be a valid email address');
      }
      return checkString(field, value, path, errors);

    case 'url':
      if (typeof value !== 'string') {
        return fail('must be a valid URL');
      }
      try {
        new URL(value);
      } catch {
        return fail('must be a valid URL');
      }
      return;

    case 'uuid':
      if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        return fail('must be a valid UUID');
      }
      return;

    case 'enum': {
      const allowed = field.validation.enum ?? [];
      if (typeof value !== 'string' || !allowed.includes(value)) {
        return fail(`must be one of: ${allowed.join(', ')}`);
      }
      return;
    }

    case 'object': {
      if (!isPlainObject(value)) {
        return fail('must be an object');
      }
      validateFields(field.children, value, errors, path, false);
      return;
    }

    case 'array': {
      if (!Array.isArray(value)) {
        return fail('must be an array');
      }
      const bounds = field.validation.arrayLength;
      if (bounds?.min !== undefined && value.length < bounds.min) {
        fail(`must contain at least ${bounds.min} items`);
      }
      if (bounds?.max !== undefined && value.length > bounds.max) {
        fail(`must contain at most ${bounds.max} items`);
      }
      const itemRule = field.children[0];
      if (itemRule) {
        value.forEach((item, index) => checkField(itemRule, item, `${path}[${index}]`, errors));
      }
      return;
    }

    default:
      return; // unknown types are not validated (forward compatibility)
  }
}

function validateFields(
  fields: HostedFieldRule[],
  record: Record<string, unknown>,
  errors: ErrorDetail[],
  prefix: string,
  partial: boolean,
): void {
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    const value = record[field.name];

    if (value === undefined || value === null) {
      // PATCH validates only the fields it carries
      if (field.required && !partial && value === undefined) {
        errors.push({ path, issue: 'is required' });
      } else if (field.required && value === null) {
        errors.push({ path, issue: 'must not be null' });
      }
      continue;
    }
    checkField(field, value, path, errors);
  }
}

/**
 * Validate a record against an entity's field rules.
 * `partial: true` (PATCH) skips required checks for absent fields.
 * Unknown extra keys are allowed — mock stores are intentionally lenient.
 */
export function validateRecord(
  fields: HostedFieldRule[],
  record: unknown,
  options: { partial?: boolean } = {},
): ErrorDetail[] {
  if (!isPlainObject(record)) {
    return [{ path: '', issue: 'body must be a JSON object' }];
  }
  const errors: ErrorDetail[] = [];
  validateFields(fields, record, errors, '', options.partial ?? false);
  return errors;
}
