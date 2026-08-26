import { describe, it, expect } from 'vitest';
import { generateMockData } from './mock-data.js';
import { goldenFixtureIPS } from '../../__tests__/golden-fixture.js';
import { goldenRelationsIPS } from '../../../ips/__tests__/golden-relations-fixture.js';
import { materializeRelations, type InternalProjectSchema } from '@instantmockapi/ips';

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
    expect(firstRecord.orderId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
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
        expect(record.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
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

describe('Mock Data Generator — relational seeding (doc 19 §Phase A)', () => {
  /**
   * The Option-B guarantee, made falsifiable.
   *
   * Relational seeding reorders entities and issues identity values, both of
   * which would shift every Faker draw if they applied unconditionally. They are
   * gated instead: `topologicalEntityOrder` is the identity permutation with no
   * owning relations, and identity assignment requires an explicit
   * `entity.identity`. These two literals were captured from the pre-rewrite
   * generator — if either changes, the gating has leaked.
   */
  it('leaves relation-free output byte-identical', () => {
    const outputs = generateMockData(goldenFixtureIPS, 42);
    expect(Object.keys(outputs)).toEqual(['blogpost.mock.json']);
    const records = JSON.parse(outputs['blogpost.mock.json']!) as Record<string, unknown>[];
    expect(records[0]!.slug).toBe('Alter stella decerno');
    expect(records[0]!.viewCount).toBe(343);
  });

  const materialized = materializeRelations(goldenRelationsIPS);

  function seed(seedValue = 7): {
    classrooms: Record<string, unknown>[];
    students: Record<string, unknown>[];
    courses: Record<string, unknown>[];
  } {
    const outputs = generateMockData(materialized, seedValue);
    return {
      classrooms: JSON.parse(outputs['classroom.mock.json']!),
      students: JSON.parse(outputs['student.mock.json']!),
      courses: JSON.parse(outputs['course.mock.json']!),
    };
  }

  it('emits one file per entity in declaration order', () => {
    expect(Object.keys(generateMockData(materialized, 7))).toEqual([
      'classroom.mock.json',
      'student.mock.json',
      'course.mock.json',
    ]);
  });

  it('issues sequential integer ids for int-style entities', () => {
    const { classrooms, students } = seed();
    expect(classrooms.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(students.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });

  it('issues uuids for uuid-style entities', () => {
    for (const course of seed().courses) {
      expect(course.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
  });

  // The literal acceptance criterion of doc 19 §Phase A.
  it('resolves every belongsTo foreign key to a real parent record', () => {
    const { classrooms, students } = seed();
    const ids = new Set(classrooms.map((r) => r.id));
    expect(students).not.toHaveLength(0);
    for (const student of students) {
      expect(ids.has(student.classroomId)).toBe(true);
    }
  });

  it('never nulls a required belongsTo', () => {
    for (const student of seed().students) {
      expect(student.classroomId).not.toBeNull();
    }
  });

  it('fills manyToMany arrays with distinct, resolvable ids', () => {
    const { students, courses } = seed();
    const ids = new Set(courses.map((r) => r.id));
    for (const student of students) {
      const links = student.courseIds as unknown[];
      expect(Array.isArray(links)).toBe(true);
      expect(new Set(links).size).toBe(links.length);
      for (const link of links) {
        expect(ids.has(link)).toBe(true);
      }
    }
  });

  it('is deterministic for a given seed', () => {
    expect(generateMockData(materialized, 11)).toEqual(generateMockData(materialized, 11));
  });

  /**
   * `date` fields used to draw relative to `new Date()`, so two seeded runs a
   * millisecond apart disagreed and no golden comparison could include a date.
   * A seeded run now pins the reference date.
   */
  it('produces identical date fields across seeded runs', () => {
    const first = JSON.parse(
      generateMockData(goldenFixtureIPS, 9)['blogpost.mock.json']!,
    ) as Record<string, unknown>[];
    const second = JSON.parse(
      generateMockData(goldenFixtureIPS, 9)['blogpost.mock.json']!,
    ) as Record<string, unknown>[];
    expect(first.map((r) => r.createdAt)).toEqual(second.map((r) => r.createdAt));
    expect(first).toEqual(second);
  });

  it('varies with the seed', () => {
    expect(generateMockData(materialized, 11)).not.toEqual(generateMockData(materialized, 12));
  });

  it('respects mockRecords for every entity', () => {
    const { classrooms, students, courses } = seed();
    expect(classrooms).toHaveLength(4);
    expect(students).toHaveLength(4);
    expect(courses).toHaveLength(4);
  });

  it('mirrors mutually-declared manyToMany so both sides agree', () => {
    const both = materializeRelations({
      ...goldenRelationsIPS,
      entities: [
        goldenRelationsIPS.entities[1]!, // Student (declares courses)
        {
          ...goldenRelationsIPS.entities[2]!, // Course declares students back
          relations: [
            {
              name: 'students',
              kind: 'manyToMany',
              target: 'Student',
              localField: '',
              foreignField: '',
              required: false,
              onDelete: 'setNull',
            },
          ],
        },
        goldenRelationsIPS.entities[0]!, // Classroom
      ],
    });
    const outputs = generateMockData(both, 5);
    const students = JSON.parse(outputs['student.mock.json']!) as Record<string, unknown>[];
    const courses = JSON.parse(outputs['course.mock.json']!) as Record<string, unknown>[];

    for (const course of courses) {
      for (const studentId of course.studentIds as unknown[]) {
        const student = students.find((s) => s.id === studentId);
        expect(student).toBeDefined();
        expect(student!.courseIds as unknown[]).toContain(course.id);
      }
    }
  });

  it('tolerates a belongsTo cycle and still backfills both sides', () => {
    const cyclic = materializeRelations({
      ...goldenRelationsIPS,
      entities: [
        {
          name: 'Left',
          identity: { field: 'id', style: 'int' },
          fields: [
            {
              name: 'label',
              type: 'string',
              required: true,
              default: null,
              children: [],
              validation: {},
              meta: {},
            },
          ],
          relations: [
            {
              name: 'right',
              kind: 'belongsTo',
              target: 'Right',
              localField: '',
              foreignField: '',
              required: true,
              onDelete: 'restrict',
            },
          ],
        },
        {
          name: 'Right',
          identity: { field: 'id', style: 'int' },
          fields: [
            {
              name: 'label',
              type: 'string',
              required: true,
              default: null,
              children: [],
              validation: {},
              meta: {},
            },
          ],
          relations: [
            {
              name: 'left',
              kind: 'belongsTo',
              target: 'Left',
              localField: '',
              foreignField: '',
              required: true,
              onDelete: 'restrict',
            },
          ],
        },
      ],
    });
    const outputs = generateMockData(cyclic, 3);
    const left = JSON.parse(outputs['left.mock.json']!) as Record<string, unknown>[];
    const right = JSON.parse(outputs['right.mock.json']!) as Record<string, unknown>[];

    const rightIds = new Set(right.map((r) => r.id));
    const leftIds = new Set(left.map((r) => r.id));
    // Left was seeded before Right existed, so its FK is deferred to pass 2.
    for (const record of left) {
      expect(rightIds.has(record.rightId)).toBe(true);
    }
    for (const record of right) {
      expect(leftIds.has(record.leftId)).toBe(true);
    }
  });
});
