import { describe, it, expect } from 'vitest';
import { generateZod } from './zod.js';
import { generateYup } from './yup.js';
import { goldenFixtureIPS } from '../../__tests__/golden-fixture.js';
import type { InternalProjectSchema } from '@instantmockapi/ips';

describe('Zod Generator — Golden-File Tests', () => {
  // ── Existing basic nested test ──────────────────────────────────────
  const nestedIPS: InternalProjectSchema = {
    projectId: 'proj_test',
    version: 1,
    entities: [
      {
        name: 'Customer',
        fields: [
          {
            name: 'primaryDetail',
            type: 'object',
            required: true,
            default: null,
            validation: {},
            meta: {},
            children: [
              {
                name: 'name',
                type: 'string',
                required: true,
                default: '',
                validation: { min: 3, message: 'Name must be at least 3 characters' },
                meta: {},
                children: [],
              },
              {
                name: 'email',
                type: 'email',
                required: true,
                default: null,
                validation: { email: true },
                meta: { unique: true },
                children: [],
              },
            ],
          },
          {
            name: 'addresses',
            type: 'array',
            required: false,
            default: null,
            validation: {},
            meta: {},
            children: [
              {
                name: 'address',
                type: 'object',
                required: true,
                default: null,
                validation: {},
                meta: {},
                children: [
                  {
                    name: 'type',
                    type: 'enum',
                    required: true,
                    default: 'home',
                    validation: { enum: ['home', 'work', 'other'] },
                    meta: {},
                    children: [],
                  },
                  {
                    name: 'location',
                    type: 'object',
                    required: true,
                    default: null,
                    validation: {},
                    meta: {},
                    children: [
                      {
                        name: 'country',
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
              },
            ],
          },
        ],
      },
    ],
    generationConfig: {
      validators: ['zod', 'yup'],
      types: ['typescript'],
      methods: ['GET', 'POST'],
      mockRecords: 25,
    },
  };

  it('should generate valid Zod schemas with nested objects', () => {
    const zodOutput = generateZod(nestedIPS);
    const code = zodOutput['customer.zod.ts']!;

    expect(code).toContain("import { z } from 'zod';");
    expect(code).toContain('export const CustomerSchema = z.object({');
    expect(code).toContain('primaryDetail: z.object({');
    expect(code).toContain(
      'name: z.string().min(3, { message: "Name must be at least 3 characters" })',
    );
    expect(code).toContain('email: z.string().email() /* unique */');
    expect(code).toContain('addresses: z.array(z.object({');
    expect(code).toContain('type: z.enum(["home", "work", "other"]).default("home")');
    expect(code).toContain('export type Customer = z.infer<typeof CustomerSchema>;');
  });

  // ── Golden-file comprehensive tests ─────────────────────────────────────

  describe('BlogPost golden Zod output', () => {
    const outputs = generateZod(goldenFixtureIPS);
    const code = outputs['blogpost.zod.ts']!;

    it('should produce correctly named output file', () => {
      expect(Object.keys(outputs)).toEqual(['blogpost.zod.ts']);
    });

    it('should have z import and schema/type exports', () => {
      expect(code).toContain("import { z } from 'zod';");
      expect(code).toContain('export const BlogPostSchema = z.object({');
      expect(code).toContain('export type BlogPost = z.infer<typeof BlogPostSchema>;');
    });

    it('should generate uuid field with unique comment', () => {
      expect(code).toContain('id: z.string().uuid() /* unique */');
    });

    it('should generate string field with min/max/message/default', () => {
      expect(code).toContain(
        'title: z.string().min(5, { message: "Title must be 5-200 chars" }).max(200, { message: "Title must be 5-200 chars" }).default("")',
      );
    });

    it('should generate string field with regex and unique comment', () => {
      expect(code).toContain('slug: z.string().regex(/^[a-z0-9-]+$/) /* unique */');
    });

    it('should generate integer field with int() and min/default', () => {
      expect(code).toContain('viewCount: z.number().int().min(0).default(0)');
    });

    it('should generate decimal field as optional with min/max', () => {
      expect(code).toContain('rating: z.number().min(0).max(5).optional()');
    });

    it('should generate boolean field with default', () => {
      expect(code).toContain('published: z.boolean().default(false)');
    });

    it('should generate date field as z.coerce.date()', () => {
      expect(code).toContain('createdAt: z.coerce.date()');
    });

    it('should generate email field with unique comment', () => {
      expect(code).toContain('authorEmail: z.string().email() /* unique */');
    });

    it('should generate url field as optional', () => {
      expect(code).toContain('website: z.string().url().optional()');
    });

    it('should generate enum field with values and default', () => {
      expect(code).toContain('status: z.enum(["draft", "published", "archived"]).default("draft")');
    });

    it('should generate nested object with child fields', () => {
      expect(code).toContain('metadata: z.object({');
    });

    it('should generate array with min/max constraints', () => {
      expect(code).toContain('tags: z.array(z.object({');
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
    expect(Object.keys(generateZod(emptyIPS))).toHaveLength(0);
  });
});

describe('Yup Generator — Golden-File Tests', () => {
  // ── Existing basic test ─────────────────────────────────────────────
  const nestedIPS: InternalProjectSchema = {
    projectId: 'proj_test',
    version: 1,
    entities: [
      {
        name: 'Customer',
        fields: [
          {
            name: 'primaryDetail',
            type: 'object',
            required: true,
            default: null,
            validation: {},
            meta: {},
            children: [
              {
                name: 'name',
                type: 'string',
                required: true,
                default: '',
                validation: { min: 3, message: 'Name must be at least 3 characters' },
                meta: {},
                children: [],
              },
              {
                name: 'email',
                type: 'email',
                required: true,
                default: null,
                validation: { email: true },
                meta: { unique: true },
                children: [],
              },
            ],
          },
        ],
      },
    ],
    generationConfig: {
      validators: ['yup'],
      types: [],
      methods: [],
      mockRecords: 0,
    },
  };

  it('should generate valid Yup schemas matching golden targets', () => {
    const yupOutput = generateYup(nestedIPS);
    const code = yupOutput['customer.yup.ts']!;

    expect(code).toContain("import * as yup from 'yup';");
    expect(code).toContain('export const CustomerSchema = yup.object({');
    expect(code).toContain('primaryDetail: yup.object({');
    expect(code).toContain(
      'name: yup.string().min(3, "Name must be at least 3 characters").required("Name must be at least 3 characters")',
    );
    expect(code).toContain('email: yup.string().email().required() /* unique */');
    expect(code).toContain('export type Customer = yup.InferType<typeof CustomerSchema>;');
  });

  // ── Golden comprehensive ────────────────────────────────────────────
  describe('BlogPost golden Yup output', () => {
    const outputs = generateYup(goldenFixtureIPS);
    const code = outputs['blogpost.yup.ts']!;

    it('should produce correctly named output file', () => {
      expect(Object.keys(outputs)).toEqual(['blogpost.yup.ts']);
    });

    it('should have yup import and schema/type exports', () => {
      expect(code).toContain("import * as yup from 'yup';");
      expect(code).toContain('export const BlogPostSchema = yup.object({');
      expect(code).toContain('export type BlogPost = yup.InferType<typeof BlogPostSchema>;');
    });

    it('should generate uuid field with required and unique', () => {
      expect(code).toContain('id: yup.string().uuid().required() /* unique */');
    });

    it('should generate string with min/max/message', () => {
      expect(code).toContain(
        'title: yup.string().min(5, "Title must be 5-200 chars").max(200, "Title must be 5-200 chars")',
      );
    });

    it('should generate string with regex match and unique', () => {
      expect(code).toContain('slug: yup.string().matches(/^[a-z0-9-]+$/)');
      expect(code).toContain('/* unique */');
    });

    it('should generate integer field', () => {
      expect(code).toContain('viewCount: yup.number().integer().min(0)');
    });

    it('should generate boolean field', () => {
      expect(code).toContain('published: yup.boolean()');
    });

    it('should generate date field', () => {
      expect(code).toContain('createdAt: yup.date()');
    });

    it('should generate email field with unique comment', () => {
      expect(code).toContain('authorEmail: yup.string().email().required() /* unique */');
    });

    it('should generate enum field with oneOf', () => {
      expect(code).toContain('status: yup.string().oneOf(["draft", "published", "archived"])');
    });

    it('should generate nested object', () => {
      expect(code).toContain('metadata: yup.object({');
    });
  });
});

/**
 * The unknown-field policy, as the two validator generators encode it.
 *
 * This is the half of the fix that lives outside the runtime: before it, a
 * hosted API stored an undeclared key while the Zod it handed you dropped it.
 * The generated schema now says whichever of the three the project chose.
 */
describe('unknown-field policy', () => {
  const ipsWith = (unknownFields?: 'allow' | 'strip' | 'reject'): InternalProjectSchema =>
    ({
      projectId: 'proj_policy',
      version: 1,
      entities: [
        {
          name: 'Current',
          fields: [
            {
              name: 'title',
              type: 'string',
              required: true,
              default: null,
              validation: {},
              meta: {},
              children: [],
            },
            {
              name: 'detail',
              type: 'object',
              required: false,
              default: null,
              validation: {},
              meta: {},
              children: [
                {
                  name: 'note',
                  type: 'string',
                  required: false,
                  default: null,
                  validation: {},
                  meta: {},
                  children: [],
                },
              ],
            },
          ],
        },
      ],
      generationConfig: {
        validators: ['zod', 'yup'],
        types: [],
        methods: ['POST'],
        mockRecords: 1,
        ...(unknownFields ? { unknownFields } : {}),
      },
    }) as InternalProjectSchema;

  it('emits passthrough Zod for allow, on nested objects too', () => {
    const code = generateZod(ipsWith('allow'))['current.zod.ts']!;
    // Two objects in this entity, and both must say it: a strict root over a
    // lenient child would accept an undeclared key one level down.
    expect(code.match(/\.passthrough\(\)/g)).toHaveLength(2);
    expect(code).not.toContain('.strict()');
  });

  it('emits strict Zod for reject', () => {
    const code = generateZod(ipsWith('reject'))['current.zod.ts']!;
    expect(code.match(/\.strict\(\)/g)).toHaveLength(2);
  });

  it('emits plain z.object for strip — already Zod default', () => {
    const code = generateZod(ipsWith('strip'))['current.zod.ts']!;
    expect(code).not.toContain('.passthrough()');
    expect(code).not.toContain('.strict()');
  });

  it('defaults an absent policy to passthrough, matching a pre-setting API', () => {
    // The compatibility case. A project generated before the setting existed
    // stores undeclared keys, so its regenerated Zod must keep them too.
    expect(generateZod(ipsWith())['current.zod.ts']).toContain('.passthrough()');
  });

  it('emits noUnknown for Yup strip and adds strict for reject', () => {
    // `.noUnknown()` alone only strips in Yup — the test it adds passes once the
    // keys are gone. `.strict(true)` is what turns it into an error.
    expect(generateYup(ipsWith('strip'))['current.yup.ts']).toContain('.noUnknown()');
    expect(generateYup(ipsWith('strip'))['current.yup.ts']).not.toContain('.strict(true)');
    expect(generateYup(ipsWith('reject'))['current.yup.ts']).toContain('.noUnknown().strict(true)');
    expect(generateYup(ipsWith('allow'))['current.yup.ts']).not.toContain('.noUnknown()');
  });
});
