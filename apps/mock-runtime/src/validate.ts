/**
 * Safe interpreter over the hosted validation model (doc 13 §4).
 *
 * The runtime never executes generated validator code — it interprets the
 * IPS-derived field rules Worker F embedded in the hosting config, so hosted
 * writes obey exactly the rules the downloadable Zod/Yup encode.
 */

import type { ErrorDetail } from '@instantmockapi/shared';
import type { UnknownFieldPolicy } from '@instantmockapi/ips';
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
 * Collect every body key no field declares, at every depth.
 *
 * Recurses only into objects the schema *describes* as objects — an undeclared
 * key is reported once, by its own path, rather than having its whole subtree
 * walked and reported key by key. Arrays of objects are walked per element, so
 * the path a caller is handed (`items[2].sku`) points at the value they sent.
 */
function collectUnknown(
  fields: HostedFieldRule[],
  record: Record<string, unknown>,
  prefix: string,
  found: string[],
): void {
  const declared = new Map(fields.map((field) => [field.name, field]));

  for (const key of Object.keys(record)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const field = declared.get(key);
    if (!field) {
      found.push(path);
      continue;
    }

    const value = record[key];
    if (field.type === 'object' && isPlainObject(value)) {
      collectUnknown(field.children, value, path, found);
    } else if (field.type === 'array' && Array.isArray(value)) {
      const itemRule = field.children[0];
      if (itemRule?.type === 'object') {
        value.forEach((item, index) => {
          if (isPlainObject(item)) {
            collectUnknown(itemRule.children, item, `${path}[${index}]`, found);
          }
        });
      }
    }
  }
}

/**
 * Drop every undeclared key, at every depth, returning a new record.
 *
 * Structural mirror of `collectUnknown` — same traversal, different verb — so a
 * key that `reject` would name is exactly a key that `strip` removes. Written as
 * a copy rather than a mutation because the caller's body belongs to the request
 * object, and the seeded/stored record must not alias it.
 */
function pruneUnknown(
  fields: HostedFieldRule[],
  record: Record<string, unknown>,
): Record<string, unknown> {
  const declared = new Map(fields.map((field) => [field.name, field]));
  const pruned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    const field = declared.get(key);
    if (!field) {
      continue;
    }
    if (field.type === 'object' && isPlainObject(value)) {
      pruned[key] = pruneUnknown(field.children, value);
    } else if (field.type === 'array' && Array.isArray(value)) {
      const itemRule = field.children[0];
      pruned[key] =
        itemRule?.type === 'object'
          ? value.map((item) =>
              isPlainObject(item) ? pruneUnknown(itemRule.children, item) : item,
            )
          : value;
    } else {
      pruned[key] = value;
    }
  }
  return pruned;
}

/**
 * Undeclared keys in a body, as validation errors.
 *
 * Empty for `allow` and `strip`: neither is a failure, and `strip` is applied by
 * `stripUnknownFields` after validation passes rather than reported here.
 */
export function unknownFieldErrors(
  fields: HostedFieldRule[],
  record: unknown,
  policy: UnknownFieldPolicy,
): ErrorDetail[] {
  if (policy !== 'reject' || !isPlainObject(record)) {
    return [];
  }
  const found: string[] = [];
  collectUnknown(fields, record, '', found);
  return found.map((path) => ({ path, issue: 'is not a field of this entity' }));
}

/**
 * The record to store, with undeclared keys removed when the policy says so.
 *
 * Returns the input untouched for `allow` and `reject` — `reject` never reaches
 * here with an offending key, because `unknownFieldErrors` already refused the
 * request.
 */
export function stripUnknownFields<T extends Record<string, unknown>>(
  fields: HostedFieldRule[],
  record: T,
  policy: UnknownFieldPolicy,
): T {
  return policy === 'strip' ? (pruneUnknown(fields, record) as T) : record;
}

/**
 * Validate a record against an entity's field rules.
 * `partial: true` (PATCH) skips required checks for absent fields.
 *
 * Declared fields only. What happens to an *undeclared* key is the project's
 * `unknownFields` policy, applied by `unknownFieldErrors` and
 * `stripUnknownFields` — kept out of here because this function answers "are
 * the values right", and that one answers "is this key permitted at all".
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
