import { describe, it, expect } from 'vitest';
import { generateJSONSchema } from './json-schema.js';
import { goldenFixtureIPS } from '../../__tests__/golden-fixture.js';
import type { InternalProjectSchema } from '@instantmockapi/ips';

describe('JSON Schema Generator — Golden-File Tests', () => {
  // ── Basic structure tests ──────────────────────────────────────────────
  const simpleIPS: InternalProjectSchema = {
    projectId: 'proj_test',
    version: 1,
    entities: [
      {
        name: 'Product',
        fields: [
          {
            name: 'title',
            type: 'string',
            required: true,
            default: '',
            validation: { min: 2 },
            meta: {},
            children: [],
          },
          {
            name: 'price',
            type: 'decimal',
            required: true,
            default: 9.99,
            validation: { min: 0.01 },
            meta: {},
            children: [],
          },
        ],
      },
    ],
    generationConfig: {
      validators: ['jsonschema'],
      types: [],
      methods: [],
      mockRecords: 0,
    },
  };

  it('should generate draft-07 JSON schemas with correct structure', () => {
    const outputs = generateJSONSchema(simpleIPS);
    const code = outputs['product.schema.json']!;
    const schema = JSON.parse(code);

    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.title).toBe('Product');
    expect(schema.type).toBe('object');
    expect(schema.properties.title.type).toBe('string');
    expect(schema.properties.title.minLength).toBe(2);
    expect(schema.properties.price.type).toBe('number');
    expect(schema.properties.price.minimum).toBe(0.01);
    expect(schema.properties.price.default).toBe(9.99);
    expect(schema.required).toContain('title');
    expect(schema.required).toContain('price');
  });

  // ── Golden-file comprehensive tests ─────────────────────────────────────

  it('should produce correctly named output files', () => {
    const outputs = generateJSONSchema(goldenFixtureIPS);
    expect(Object.keys(outputs)).toEqual(['blogpost.schema.json']);
  });

  describe('BlogPost schema golden output', () => {
    const outputs = generateJSONSchema(goldenFixtureIPS);
    const schema = JSON.parse(outputs['blogpost.schema.json']!);

    it('should have draft-07 meta schema and correct title', () => {
      expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
      expect(schema.title).toBe('BlogPost');
      expect(schema.type).toBe('object');
    });

    it('should generate uuid field with format and unique marker', () => {
      expect(schema.properties.id.type).toBe('string');
      expect(schema.properties.id.format).toBe('uuid');
      expect(schema.properties.id.unique).toBe(true);
    });

    it('should generate string field with min/max/default/errorMessage', () => {
      const title = schema.properties.title;
      expect(title.type).toBe('string');
      expect(title.minLength).toBe(5);
      expect(title.maxLength).toBe(200);
      expect(title.default).toBe('');
      expect(title.errorMessage).toBe('Title must be 5-200 chars');
    });

    it('should generate string field with regex pattern and unique marker', () => {
      const slug = schema.properties.slug;
      expect(slug.type).toBe('string');
      expect(slug.pattern).toBe('^[a-z0-9-]+$');
      expect(slug.unique).toBe(true);
    });

    it('should generate integer field with minimum and default', () => {
      const vc = schema.properties.viewCount;
      expect(vc.type).toBe('integer');
      expect(vc.minimum).toBe(0);
      expect(vc.default).toBe(0);
    });

    it('should generate decimal/number field with min/max (optional)', () => {
      const rating = schema.properties.rating;
      expect(rating.type).toBe('number');
      expect(rating.minimum).toBe(0);
      expect(rating.maximum).toBe(5);
      // no default since default is null
      expect(rating.default).toBeUndefined();
    });

    it('should generate boolean field with default', () => {
      const pub = schema.properties.published;
      expect(pub.type).toBe('boolean');
      expect(pub.default).toBe(false);
    });

    it('should generate date field as string with date-time format', () => {
      const ca = schema.properties.createdAt;
      expect(ca.type).toBe('string');
      expect(ca.format).toBe('date-time');
    });

    it('should generate email field with email format and unique marker', () => {
      const ae = schema.properties.authorEmail;
      expect(ae.type).toBe('string');
      expect(ae.format).toBe('email');
      expect(ae.unique).toBe(true);
    });

    it('should generate url field with uri format', () => {
      const ws = schema.properties.website;
      expect(ws.type).toBe('string');
      expect(ws.format).toBe('uri');
    });

    it('should generate enum field with enum values and default', () => {
      const st = schema.properties.status;
      expect(st.type).toBe('string');
      expect(st.enum).toEqual(['draft', 'published', 'archived']);
      expect(st.default).toBe('draft');
    });

    it('should generate nested object with properties and required', () => {
      const md = schema.properties.metadata;
      expect(md.type).toBe('object');
      expect(md.properties.seoTitle.type).toBe('string');
      expect(md.properties.seoTitle.maxLength).toBe(60);
      // seoTitle is optional, so not in required
      expect(md.required).toBeUndefined();
    });

    it('should generate nested array-of-strings with array constraints', () => {
      const kw = schema.properties.metadata.properties.keywords;
      expect(kw.type).toBe('array');
      expect(kw.items.type).toBe('string');
      expect(kw.minItems).toBe(1);
      expect(kw.maxItems).toBe(10);
    });

    it('should generate array-of-objects with items schema', () => {
      const tags = schema.properties.tags;
      expect(tags.type).toBe('array');
      expect(tags.minItems).toBe(0);
      expect(tags.maxItems).toBe(5);
      // Items is a nested object
      expect(tags.items.type).toBe('object');
      expect(tags.items.properties.label.type).toBe('string');
      expect(tags.items.properties.label.minLength).toBe(1);
      expect(tags.items.properties.color.type).toBe('string');
      // color has length: 7 → minLength + maxLength
      expect(tags.items.properties.color.minLength).toBe(7);
      expect(tags.items.properties.color.maxLength).toBe(7);
      expect(tags.items.properties.color.default).toBe('#000000');
    });

    it('should include all required fields in the required array', () => {
      const requiredFields = schema.required;
      const expectedRequired = [
        'id',
        'title',
        'slug',
        'viewCount',
        'published',
        'createdAt',
        'authorEmail',
        'status',
        'metadata',
      ];
      for (const field of expectedRequired) {
        expect(requiredFields).toContain(field);
      }
      // Optional fields should NOT be in required
      expect(requiredFields).not.toContain('rating');
      expect(requiredFields).not.toContain('website');
      expect(requiredFields).not.toContain('tags');
    });
  });

  // ── Edge case: empty entities ───────────────────────────────────────
  it('should return empty result for IPS with no entities', () => {
    const emptyIPS: InternalProjectSchema = {
      projectId: 'proj_empty',
      version: 1,
      entities: [],
      generationConfig: { validators: [], types: [], methods: [], mockRecords: 0 },
    };
    const outputs = generateJSONSchema(emptyIPS);
    expect(Object.keys(outputs)).toHaveLength(0);
  });

  // ── Edge case: entity with no fields ────────────────────────────────
  it('should generate valid schema for entity with no fields', () => {
    const noFieldsIPS: InternalProjectSchema = {
      projectId: 'proj_nf',
      version: 1,
      entities: [{ name: 'Empty', fields: [] }],
      generationConfig: { validators: [], types: [], methods: [], mockRecords: 0 },
    };
    const outputs = generateJSONSchema(noFieldsIPS);
    const schema = JSON.parse(outputs['empty.schema.json']!);
    expect(schema.type).toBe('object');
    expect(schema.properties).toEqual({});
    expect(schema.required).toBeUndefined();
  });
});
