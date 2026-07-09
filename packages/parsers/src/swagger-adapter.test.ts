import { describe, it, expect } from 'vitest';
import { parseSwaggerSpec } from './swagger-adapter.js';

const PROJECT_ID = 'proj_test';

/** Helper: unwrap an ok result or fail loudly. */
function expectOk<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!result.ok) {
    throw new Error(`Expected ok, got error: ${JSON.stringify(result.error)}`);
  }
  return result.value as T;
}

describe('parseSwaggerSpec — OpenAPI 3.x', () => {
  const openApi3 = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0.0' },
    components: {
      schemas: {
        Customer: {
          type: 'object',
          required: ['id', 'email', 'addresses'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email', maxLength: 100 },
            age: { type: 'integer', minimum: 0, maximum: 120 },
            status: { type: 'string', enum: ['active', 'inactive'] },
            website: { type: 'string', format: 'uri' },
            addresses: {
              type: 'array',
              minItems: 1,
              items: { $ref: '#/components/schemas/Address' },
            },
          },
        },
        Address: {
          type: 'object',
          required: ['city'],
          properties: {
            city: { type: 'string' },
            zip: { type: 'string', pattern: '^[0-9]{5}$' },
          },
        },
      },
    },
  });

  it('parses into an IPS with the expected entity and fields', () => {
    const ips = expectOk(parseSwaggerSpec(PROJECT_ID, 'Test', openApi3));
    expect(ips.projectId).toBe(PROJECT_ID);
    expect(ips.version).toBe(1);
    const customer = ips.entities.find((e) => e.name === 'Customer');
    expect(customer).toBeDefined();
    const byName = Object.fromEntries(customer!.fields.map((f) => [f.name, f]));
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining(['id', 'email', 'age', 'status', 'website', 'addresses']),
    );
  });

  it('maps string formats to IPS field types and sets format validation flags', () => {
    const ips = expectOk(parseSwaggerSpec(PROJECT_ID, 'Test', openApi3));
    const customer = ips.entities.find((e) => e.name === 'Customer')!;
    const byName = Object.fromEntries(customer.fields.map((f) => [f.name, f]));
    expect(byName.id.type).toBe('uuid');
    expect(byName.id.validation.uuid).toBe(true);
    expect(byName.email.type).toBe('email');
    expect(byName.email.validation.email).toBe(true);
    expect(byName.email.validation.max).toBe(100);
    expect(byName.website.type).toBe('url');
    expect(byName.website.validation.url).toBe(true);
  });

  it('maps numeric ranges and enums', () => {
    const ips = expectOk(parseSwaggerSpec(PROJECT_ID, 'Test', openApi3));
    const byName = Object.fromEntries(
      ips.entities.find((e) => e.name === 'Customer')!.fields.map((f) => [f.name, f]),
    );
    expect(byName.age.type).toBe('integer');
    expect(byName.age.validation.min).toBe(0);
    expect(byName.age.validation.max).toBe(120);
    expect(byName.status.type).toBe('enum');
    expect(byName.status.validation.enum).toEqual(['active', 'inactive']);
  });

  it('propagates required[] onto fields', () => {
    const ips = expectOk(parseSwaggerSpec(PROJECT_ID, 'Test', openApi3));
    const byName = Object.fromEntries(
      ips.entities.find((e) => e.name === 'Customer')!.fields.map((f) => [f.name, f]),
    );
    expect(byName.email.required).toBe(true);
    expect(byName.age.required).toBe(false);
  });

  it('represents an array-of-objects as a single item field (canonical convention) and inlines $ref', () => {
    const ips = expectOk(parseSwaggerSpec(PROJECT_ID, 'Test', openApi3));
    const byName = Object.fromEntries(
      ips.entities.find((e) => e.name === 'Customer')!.fields.map((f) => [f.name, f]),
    );
    const addresses = byName.addresses;
    expect(addresses.type).toBe('array');
    expect(addresses.validation.arrayLength?.min).toBe(1);
    // children must hold exactly one item field
    expect(addresses.children).toHaveLength(1);
    const item = addresses.children[0];
    expect(item.type).toBe('object');
    // $ref-resolved Address fields
    const itemByName = Object.fromEntries(item.children.map((f) => [f.name, f]));
    expect(itemByName.city.required).toBe(true);
    expect(itemByName.zip.validation.regex).toBe('^[0-9]{5}$');
  });
});

describe('parseSwaggerSpec — Swagger 2.0', () => {
  const swagger2 = JSON.stringify({
    swagger: '2.0',
    info: { title: 'Test', version: '1.0.0' },
    definitions: {
      Product: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          price: { type: 'number', minimum: 0 },
          inStock: { type: 'boolean' },
        },
      },
    },
  });

  it('reads schemas from `definitions`', () => {
    const ips = expectOk(parseSwaggerSpec(PROJECT_ID, 'Test', swagger2));
    const product = ips.entities.find((e) => e.name === 'Product');
    expect(product).toBeDefined();
    const byName = Object.fromEntries(product!.fields.map((f) => [f.name, f]));
    expect(byName.name.type).toBe('string');
    expect(byName.name.required).toBe(true);
    expect(byName.price.type).toBe('decimal');
    expect(byName.inStock.type).toBe('boolean');
  });
});

describe('parseSwaggerSpec — YAML input', () => {
  const yamlSpec = [
    'openapi: 3.0.0',
    'info:',
    '  title: Test',
    '  version: 1.0.0',
    'components:',
    '  schemas:',
    '    Note:',
    '      type: object',
    '      required: [title]',
    '      properties:',
    '        title:',
    '          type: string',
    '        pinned:',
    '          type: boolean',
  ].join('\n');

  it('parses a YAML spec', () => {
    const ips = expectOk(parseSwaggerSpec(PROJECT_ID, 'Test', yamlSpec));
    const note = ips.entities.find((e) => e.name === 'Note');
    expect(note).toBeDefined();
    const byName = Object.fromEntries(note!.fields.map((f) => [f.name, f]));
    expect(byName.title.required).toBe(true);
    expect(byName.pinned.type).toBe('boolean');
  });
});

describe('parseSwaggerSpec — error handling', () => {
  it('errors on empty input', () => {
    const result = parseSwaggerSpec(PROJECT_ID, 'Test', '   ');
    expect(result.ok).toBe(false);
  });

  it('errors on input that is neither JSON nor YAML object', () => {
    const result = parseSwaggerSpec(PROJECT_ID, 'Test', '"just a string"');
    expect(result.ok).toBe(false);
  });

  it('errors when no schema definitions are present', () => {
    const result = parseSwaggerSpec(
      PROJECT_ID,
      'Test',
      JSON.stringify({ openapi: '3.0.0', info: {} }),
    );
    expect(result.ok).toBe(false);
  });
});
