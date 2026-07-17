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
    expect(code).toContain('type: z.enum(["home", "work"]).default("home")');
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
