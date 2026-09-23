import { describe, it, expect } from 'vitest';
import { generateMockData } from './mock-data.js';
import { goldenFixtureIPS } from '../../__tests__/golden-fixture.js';
import { goldenRelationsIPS } from '../../../ips/__tests__/golden-relations-fixture.js';
import { materializeRelations, type InternalProjectSchema } from '@instantmockapi/ips';
import { AVATAR_TRAITS, AVATAR_TRAIT_NAMES } from '@instantmockapi/shared';

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
   *
   * **Both literals were re-captured when the semantic field table landed.**
   * `slug` was `'Alter stella decerno'` — three lorem words, because the name
   * carried no rule — and is now slugified; `viewCount` was `343` and is now
   * `4401`, because slugifying draws a different number of values from Faker
   * than `lorem.sentence()` did, which shifts every draw after it.
   *
   * That is worth being precise about, because it narrows what this test
   * proves. It is **not** a claim that output is stable across releases — a
   * deliberate change to any value function moves these numbers, and the fix is
   * to re-capture them after checking the diff is the intended one. What it
   * still guards is the thing it was written for: that relational seeding stays
   * gated. If `topologicalEntityOrder` or identity assignment ever applied to an
   * entity with no relations, these would move *without* anyone having touched a
   * value function, and this test is the tripwire for that.
   */
  it('leaves relation-free output stable', () => {
    const outputs = generateMockData(goldenFixtureIPS, 42);
    expect(Object.keys(outputs)).toEqual(['blogpost.mock.json']);
    const records = JSON.parse(outputs['blogpost.mock.json']!) as Record<string, unknown>[];
    expect(records[0]!.slug).toBe('cogo-alter-stella');
    expect(records[0]!.viewCount).toBe(4401);
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

/**
 * Realistic values by field name, and the `avatar` type.
 *
 * The bug behind this: an `email` field declared `string` seeded
 * `"Censura claro defung"`. Lorem is right for free text and wrong for anything
 * a developer pastes into a form or hands to a parser.
 */
describe('semantic field names', () => {
  const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  /** One entity of `string` fields, one per name under test. */
  function stringEntity(names: string[]): InternalProjectSchema {
    return {
      projectId: 'proj_semantic',
      version: 1,
      entities: [
        {
          name: 'Person',
          fields: names.map((name) => ({
            name,
            type: 'string' as const,
            // Required, so the 10%-null branch never fires and these cases are
            // about the value rather than about optionality.
            required: true,
            default: null,
            children: [],
            validation: {},
            meta: {},
          })),
        },
      ],
      generationConfig: {
        validators: [],
        types: [],
        methods: ['GET'],
        mockRecords: 5,
      },
    } as InternalProjectSchema;
  }

  function records(names: string[], seed = 3): Record<string, unknown>[] {
    return JSON.parse(generateMockData(stringEntity(names), seed)['person.mock.json']);
  }

  it('gives an email-named string field a parseable email address', () => {
    // The reported case, exactly.
    for (const row of records(['email'])) {
      expect(String(row.email)).toMatch(EMAIL);
    }
  });

  it('matches regardless of separator or case', () => {
    // `first_name`, `firstName` and `FIRST NAME` are one rule, not three
    // near-misses that each need their own entry.
    const row = records(['first_name', 'firstName', 'FIRST NAME'])[0]!;
    for (const key of ['first_name', 'firstName', 'FIRST NAME']) {
      expect(String(row[key])).not.toMatch(/ /);
      expect(String(row[key]).length).toBeGreaterThan(1);
    }
  });

  it('keeps firstName and lastName distinct from a full name', () => {
    // The ordering rule the table depends on: if `name` were tested first,
    // every one of these columns would hold a full name.
    const row = records(['firstName', 'lastName', 'name'])[0]!;
    expect(String(row.firstName)).not.toContain(' ');
    expect(String(row.lastName)).not.toContain(' ');
    expect(String(row.name)).toContain(' ');
  });

  it('produces digits for phone-ish names', () => {
    const row = records(['phone', 'mobile', 'phoneNumber', 'contactNumber'])[0]!;
    for (const key of ['phone', 'mobile', 'phoneNumber', 'contactNumber']) {
      expect(String(row[key])).toMatch(/\d/);
    }
  });

  it('produces a postal code for pincode and its spellings', () => {
    const row = records(['pincode', 'zip', 'zipCode', 'postalCode'])[0]!;
    for (const key of ['pincode', 'zip', 'zipCode', 'postalCode']) {
      expect(String(row[key])).toMatch(/^[A-Za-z0-9 -]+$/);
      expect(String(row[key]).length).toBeLessThanOrEqual(12);
    }
  });

  it('does not put the same full address in address and addressLine1', () => {
    // The general `address` rule sits after the numbered lines for this reason.
    const row = records(['address', 'addressLine1'])[0]!;
    expect(row.address).not.toBe(row.addressLine1);
  });

  it('leaves genuinely free-text names as lorem', () => {
    // The table's scope, stated as a test: inventing prose for a `description`
    // would move the surprise rather than remove it.
    const row = records(['title', 'description', 'note'])[0]!;
    for (const key of ['title', 'description', 'note']) {
      expect(typeof row[key]).toBe('string');
      expect(String(row[key]).length).toBeGreaterThan(0);
    }
    expect(String(row.description)).not.toMatch(EMAIL);
  });

  it('gives an avatar-named string field a picture URL, not a random domain', () => {
    const row = records(['avatarUrl', 'profilePic', 'photo'])[0]!;
    for (const key of ['avatarUrl', 'profilePic', 'photo']) {
      expect(String(row[key])).toContain('avataaars.io');
    }
  });

  it('stays deterministic under a seed', () => {
    // The contract the whole module keeps; the table must not break it.
    expect(records(['email', 'firstName', 'avatar'], 11)).toEqual(
      records(['email', 'firstName', 'avatar'], 11),
    );
  });
});

describe('the avatar field type', () => {
  function avatarIps(): InternalProjectSchema {
    return {
      projectId: 'proj_avatar',
      version: 1,
      entities: [
        {
          name: 'Member',
          fields: [
            {
              name: 'picture',
              type: 'avatar' as const,
              required: true,
              default: null,
              children: [],
              validation: {},
              meta: {},
            },
          ],
        },
      ],
      generationConfig: { validators: [], types: [], methods: ['GET'], mockRecords: 8 },
    } as InternalProjectSchema;
  }

  const pictures = (seed = 5): string[] =>
    (
      JSON.parse(generateMockData(avatarIps(), seed)['member.mock.json']) as Record<
        string,
        unknown
      >[]
    ).map((row) => String(row.picture));

  it('emits a getavataaars URL for every record', () => {
    for (const url of pictures()) {
      expect(url.startsWith('https://avataaars.io/?')).toBe(true);
      expect(() => new URL(url)).not.toThrow();
    }
  });

  it('fixes the house style — Circle and Tongue on every face', () => {
    // The user's one non-negotiable trait. Everything else is drawn.
    for (const url of pictures()) {
      const params = new URL(url).searchParams;
      expect(params.get('avatarStyle')).toBe('Circle');
      expect(params.get('mouthType')).toBe('Tongue');
    }
  });

  it('varies the other traits across records', () => {
    // Eight identical avatars would make the type pointless.
    const tops = new Set(pictures().map((url) => new URL(url).searchParams.get('topType')));
    expect(tops.size).toBeGreaterThan(1);
  });

  it('draws only from the curated trait lists', () => {
    // The lists are short so random combinations stay coherent; a value from
    // outside them means the generator drifted from the vocabulary.
    for (const url of pictures()) {
      const params = new URL(url).searchParams;
      for (const trait of AVATAR_TRAIT_NAMES) {
        expect(AVATAR_TRAITS[trait] as readonly string[]).toContain(params.get(trait));
      }
    }
  });

  it('is byte-identical under the same seed', () => {
    expect(pictures(9)).toEqual(pictures(9));
  });
});
