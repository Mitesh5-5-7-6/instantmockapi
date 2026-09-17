import { describe, it, expect } from 'vitest';
import type { HostedFieldRule } from '@instantmockapi/generator-hosting';
import { stripUnknownFields, unknownFieldErrors, validateRecord } from './validate.js';

const rule = (partial: Partial<HostedFieldRule> & { name: string; type: string }) =>
  ({
    required: true,
    default: null,
    validation: {},
    children: [],
    ...partial,
  }) as HostedFieldRule;

const FIELDS: HostedFieldRule[] = [
  rule({ name: 'id', type: 'uuid' }),
  rule({ name: 'name', type: 'string', validation: { min: 2, max: 50 } }),
  rule({ name: 'email', type: 'email' }),
  rule({ name: 'age', type: 'integer', required: false, validation: { min: 0, max: 130 } }),
  rule({ name: 'status', type: 'enum', validation: { enum: ['active', 'inactive'] } }),
  rule({
    name: 'address',
    type: 'object',
    children: [
      rule({ name: 'city', type: 'string' }),
      rule({ name: 'zip', type: 'string', required: false, validation: { length: 5 } }),
    ],
  }),
  rule({
    name: 'tags',
    type: 'array',
    required: false,
    validation: { arrayLength: { min: 0, max: 3 } },
    children: [rule({ name: 'tag', type: 'string' })],
  }),
];

const VALID = {
  id: '6e3c9a1e-95f1-4db8-8f5f-2f13f3e58a01',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  age: 36,
  status: 'active',
  address: { city: 'London', zip: 'EC1A5' },
  tags: ['pioneer'],
};

describe('validateRecord (safe interpreter, doc 13 §4)', () => {
  it('accepts a fully valid record', () => {
    expect(validateRecord(FIELDS, VALID)).toEqual([]);
  });

  it('reports every missing required field with its path', () => {
    const errors = validateRecord(FIELDS, {});
    const paths = errors.map((e) => e.path);
    expect(paths).toContain('id');
    expect(paths).toContain('name');
    expect(paths).toContain('email');
    expect(paths).toContain('status');
    expect(paths).toContain('address');
    expect(paths).not.toContain('age'); // optional
    expect(errors.every((e) => e.issue === 'is required')).toBe(true);
  });

  it('enforces type, bounds, format, and enum rules', () => {
    const errors = validateRecord(FIELDS, {
      ...VALID,
      id: 'not-a-uuid',
      name: 'A',
      email: 'not-an-email',
      age: 200,
      status: 'archived',
    });
    const byPath = Object.fromEntries(errors.map((e) => [e.path, e.issue]));
    expect(byPath['id']).toMatch(/uuid/i);
    expect(byPath['name']).toMatch(/at least 2/);
    expect(byPath['email']).toMatch(/email/);
    expect(byPath['age']).toMatch(/<= 130/);
    expect(byPath['status']).toMatch(/active, inactive/);
  });

  it('recurses into nested objects with dotted paths', () => {
    const errors = validateRecord(FIELDS, {
      ...VALID,
      address: { city: 42, zip: '123' },
    });
    const byPath = Object.fromEntries(errors.map((e) => [e.path, e.issue]));
    expect(byPath['address.city']).toMatch(/string/);
    expect(byPath['address.zip']).toMatch(/exactly 5/);
  });

  it('validates array bounds and items', () => {
    const errors = validateRecord(FIELDS, {
      ...VALID,
      tags: ['a', 'b', 'c', 'd'],
    });
    expect(errors.some((e) => e.path === 'tags' && /at most 3/.test(e.issue))).toBe(true);

    const itemErrors = validateRecord(FIELDS, { ...VALID, tags: ['ok', 7] });
    expect(itemErrors.some((e) => e.path === 'tags[1]')).toBe(true);
  });

  it('partial mode (PATCH) validates only the provided fields', () => {
    expect(validateRecord(FIELDS, { name: 'Grace' }, { partial: true })).toEqual([]);
    const errors = validateRecord(FIELDS, { email: 'nope' }, { partial: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('email');
  });

  it('rejects non-object bodies', () => {
    expect(validateRecord(FIELDS, 'a string')[0]?.issue).toMatch(/JSON object/);
    expect(validateRecord(FIELDS, [1, 2])[0]?.issue).toMatch(/JSON object/);
  });

  it('uses the custom message when the rule provides one', () => {
    const fields = [
      rule({ name: 'title', type: 'string', validation: { min: 5, message: 'Title too short' } }),
    ];
    const errors = validateRecord(fields, { title: 'ab' });
    expect(errors[0]?.issue).toBe('Title too short');
  });
});

/**
 * The unknown-field policy.
 *
 * The bug these pin down: an undeclared key used to be stored and echoed back
 * unconditionally, while the Zod the same generation handed the caller dropped
 * it. The runtime now does whichever of the three the project asked for, and
 * `validateRecord` stays out of it.
 */
describe('undeclared keys', () => {
  const extra = { ...VALID, ajs: 'dwe' };

  it('is not validateRecord business — declared fields only', () => {
    // The separation that keeps the three policies from having to be understood
    // by every value check in this file.
    expect(validateRecord(FIELDS, extra)).toEqual([]);
  });

  it('allow reports nothing and keeps the key', () => {
    expect(unknownFieldErrors(FIELDS, extra, 'allow')).toEqual([]);
    expect(stripUnknownFields(FIELDS, extra, 'allow')).toEqual(extra);
  });

  it('strip reports nothing and removes the key', () => {
    // Accepted, not refused: the request succeeds and the extra key simply does
    // not reach the store.
    expect(unknownFieldErrors(FIELDS, extra, 'strip')).toEqual([]);
    expect(stripUnknownFields(FIELDS, extra, 'strip')).toEqual(VALID);
  });

  it('reject names the offending key by path', () => {
    expect(unknownFieldErrors(FIELDS, extra, 'reject')).toEqual([
      { path: 'ajs', issue: 'is not a field of this entity' },
    ]);
  });

  it('reaches into nested objects', () => {
    const nested = {
      ...VALID,
      address: { city: 'London', zip: 'EC1A5', county: 'Greater London' },
    };

    expect(unknownFieldErrors(FIELDS, nested, 'reject')).toEqual([
      { path: 'address.county', issue: 'is not a field of this entity' },
    ]);
    expect(stripUnknownFields(FIELDS, nested, 'strip')).toEqual(VALID);
  });

  it('reports an undeclared subtree once, by its own path', () => {
    // Not one error per key inside it: the caller sent one key this entity does
    // not have, and listing its children as separate problems buries that.
    const subtree = { ...VALID, meta: { source: 'import', batch: 7 } };

    expect(unknownFieldErrors(FIELDS, subtree, 'reject')).toEqual([
      { path: 'meta', issue: 'is not a field of this entity' },
    ]);
  });

  it('indexes into arrays of objects', () => {
    const fields = [
      rule({
        name: 'items',
        type: 'array',
        children: [
          rule({ name: 'item', type: 'object', children: [rule({ name: 'sku', type: 'string' })] }),
        ],
      }),
    ];
    const body = { items: [{ sku: 'a' }, { sku: 'b', qty: 2 }] };

    expect(unknownFieldErrors(fields, body, 'reject')).toEqual([
      { path: 'items[1].qty', issue: 'is not a field of this entity' },
    ]);
    expect(stripUnknownFields(fields, body, 'strip')).toEqual({
      items: [{ sku: 'a' }, { sku: 'b' }],
    });
  });

  it('leaves arrays of primitives alone', () => {
    // `tags` holds strings, not objects — there is nothing in them to declare.
    expect(unknownFieldErrors(FIELDS, VALID, 'reject')).toEqual([]);
    expect(stripUnknownFields(FIELDS, VALID, 'strip')).toEqual(VALID);
  });

  it('does not mutate the caller body when stripping', () => {
    // The body belongs to the request object; the stored record must not alias it.
    const body = { ...VALID, ajs: 'dwe' };
    stripUnknownFields(FIELDS, body, 'strip');
    expect(body.ajs).toBe('dwe');
  });

  it('reports nothing for a non-object body, whatever the policy', () => {
    // `validateRecord` already refuses those with its own message; a second
    // complaint about undeclared keys on a string would just be noise.
    expect(unknownFieldErrors(FIELDS, 'a string', 'reject')).toEqual([]);
  });
});
