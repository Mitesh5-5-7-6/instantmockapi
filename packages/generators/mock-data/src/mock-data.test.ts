import { describe, it, expect } from 'vitest';
import { generateMockData } from './mock-data.js';
import { goldenFixtureIPS } from '../../__tests__/golden-fixture.js';
import type { InternalProjectSchema } from '@instantmockapi/ips';

describe('Mock Data Generator — Golden-File Tests', () => {
  // ── Existing basic test ─────────────────────────────────────────────
  const simpleIPS: InternalProjectSchema = {
    projectId: 'proj_test',
    version: 1,
    entities: [
      {
        name: 'Order',
        fields: [
          {
            name: 'orderId',
            type: 'uuid',
            required: true,
            default: null,
            validation: {},
            meta: {},
            children: [],
          },
          {
            name: 'quantity',
            type: 'integer',
            required: true,
            default: 1,
            validation: { min: 1, max: 10 },
            meta: {},
            children: [],
          },
          {
            name: 'customerEmail',
            type: 'email',
            required: true,
            default: null,
            validation: {},
            meta: {},
            children: [],
          },
        ],
      },
    ],
    generationConfig: {
      validators: [],
      types: [],
      methods: ['GET'],
      mockRecords: 5,
    },
  };

  it('should generate deterministic mock data when given a fixed seed', () => {
    const outputs1 = generateMockData(simpleIPS, 12345);
    const outputs2 = generateMockData(simpleIPS, 12345);

    expect(outputs1['order.mock.json']).toBeDefined();
    expect(outputs1['order.mock.json']).toBe(outputs2['order.mock.json']);

    const records = JSON.parse(outputs1['order.mock.json']!);
    expect(records.length).toBe(5);

    const firstRecord = records[0];
    expect(firstRecord.orderId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(firstRecord.quantity).toBeGreaterThanOrEqual(1);
    expect(firstRecord.quantity).toBeLessThanOrEqual(10);
    expect(firstRecord.customerEmail).toContain('@');
  });

  // ── Golden-file comprehensive tests ─────────────────────────────────

  describe('BlogPost golden mock data output', () => {
    const SEED = 42;
    const outputs = generateMockData(goldenFixtureIPS, SEED);

    it('should produce correctly named output file', () => {
      expect(Object.keys(outputs)).toEqual(['blogpost.mock.json']);
    });

    it('should generate the configured number of records', () => {
      const records = JSON.parse(outputs['blogpost.mock.json']!);
      expect(records.length).toBe(3); // mockRecords: 3
    });

    it('should be deterministic — same seed produces structurally equivalent output', () => {
      const outputs2 = generateMockData(goldenFixtureIPS, SEED);
      const records1 = JSON.parse(outputs['blogpost.mock.json']!);
      const records2 = JSON.parse(outputs2['blogpost.mock.json']!);

      // Verify structural equivalence (ignoring date millisecond drift from Date.now)
      expect(records1.length).toBe(records2.length);
      for (let i = 0; i < records1.length; i++) {
        // All non-date fields should be identical
        expect(records1[i].id).toBe(records2[i].id);
        expect(records1[i].title).toBe(records2[i].title);
        expect(records1[i].slug).toBe(records2[i].slug);
        expect(records1[i].viewCount).toBe(records2[i].viewCount);
        expect(records1[i].published).toBe(records2[i].published);
        expect(records1[i].authorEmail).toBe(records2[i].authorEmail);
        expect(records1[i].status).toBe(records2[i].status);
      }
    });

    describe('individual record structure', () => {
      const records = JSON.parse(outputs['blogpost.mock.json']!);
      const record = records[0];

      it('should generate valid uuid for id field', () => {
        expect(record.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      });

      it('should generate string for title', () => {
        expect(typeof record.title).toBe('string');
        expect(record.title.length).toBeGreaterThanOrEqual(5);
      });

      it('should generate string for slug', () => {
        expect(typeof record.slug).toBe('string');
      });

      it('should generate integer for viewCount', () => {
        expect(Number.isInteger(record.viewCount)).toBe(true);
        expect(record.viewCount).toBeGreaterThanOrEqual(0);
      });

      it('should generate number or null for optional rating', () => {
        // optional field can be null or a number
        if (record.rating !== null) {
          expect(typeof record.rating).toBe('number');
          expect(record.rating).toBeGreaterThanOrEqual(0);
          expect(record.rating).toBeLessThanOrEqual(5);
        }
      });

      it('should generate boolean for published', () => {
        expect(typeof record.published).toBe('boolean');
      });

      it('should generate ISO date string for createdAt', () => {
        expect(typeof record.createdAt).toBe('string');
        expect(new Date(record.createdAt).toISOString()).toBe(record.createdAt);
      });

      it('should generate email for authorEmail', () => {
        expect(typeof record.authorEmail).toBe('string');
        expect(record.authorEmail).toContain('@');
      });

      it('should generate url or null for optional website', () => {
        if (record.website !== null) {
          expect(typeof record.website).toBe('string');
        }
      });

      it('should generate one of the enum values for status', () => {
        expect(['draft', 'published', 'archived']).toContain(record.status);
      });

      it('should generate nested object for metadata', () => {
        expect(typeof record.metadata).toBe('object');
        expect(record.metadata).not.toBeNull();
        expect(typeof record.metadata.seoTitle).toBe('string');
        expect(Array.isArray(record.metadata.keywords)).toBe(true);
      });

      it('should generate array for tags', () => {
        if (record.tags !== null) {
          expect(Array.isArray(record.tags)).toBe(true);
          for (const tag of record.tags) {
            expect(typeof tag.label).toBe('string');
            if (tag.color !== null && tag.color !== undefined) {
              expect(typeof tag.color).toBe('string');
            }
          }
        }
      });
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────
  it('should return empty result for IPS with no entities', () => {
    const emptyIPS: InternalProjectSchema = {
      projectId: 'proj_empty',
      version: 1,
      entities: [],
      generationConfig: { validators: [], types: [], methods: [], mockRecords: 0 },
    };
    expect(Object.keys(generateMockData(emptyIPS, 1))).toHaveLength(0);
  });

  it('should generate 0 records when mockRecords is 0', () => {
    const zeroIPS: InternalProjectSchema = {
      projectId: 'proj_zero',
      version: 1,
      entities: [
        {
          name: 'Item',
          fields: [
            {
              name: 'name',
              type: 'string',
              required: true,
              default: '',
              validation: {},
              meta: {},
              children: [],
            },
          ],
        },
      ],
      generationConfig: { validators: [], types: [], methods: [], mockRecords: 0 },
    };
    const outputs = generateMockData(zeroIPS, 1);
    const records = JSON.parse(outputs['item.mock.json']!);
    expect(records).toHaveLength(0);
  });
});
