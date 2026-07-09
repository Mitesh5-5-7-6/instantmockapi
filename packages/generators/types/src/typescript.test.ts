import { describe, it, expect } from 'vitest';
import { generateTypeScript } from './typescript.js';
import { goldenFixtureIPS } from '../../__tests__/golden-fixture.js';
import type { InternalProjectSchema } from '@instantmockapi/ips';

describe('TypeScript Type Generator — Golden-File Tests', () => {
  // ── Basic test ─────────────────────────────────────────────────────
  const simpleIPS: InternalProjectSchema = {
    projectId: 'proj_test',
    version: 1,
    entities: [
      {
        name: 'User',
        fields: [
          {
            name: 'username',
            type: 'string',
            required: true,
            default: '',
            validation: {},
            meta: {},
            children: [],
          },
          {
            name: 'role',
            type: 'enum',
            required: false,
            default: 'member',
            validation: { enum: ['admin', 'member'] },
            meta: {},
            children: [],
          },
          {
            name: 'profile',
            type: 'object',
            required: true,
            default: null,
            validation: {},
            meta: {},
            children: [
              {
                name: 'bio',
                type: 'string',
                required: false,
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
    generationConfig: {
      validators: [],
      types: ['typescript'],
      methods: [],
      mockRecords: 0,
    },
  };

  it('should generate TypeScript interfaces with named nested sub-interfaces', () => {
    const outputs = generateTypeScript(simpleIPS);
    const code = outputs['user.types.ts']!;

    expect(code).toContain('export interface User {');
    expect(code).toContain('username: string;');
    expect(code).toContain('role?: "admin" | "member";');
    expect(code).toContain('profile: UserProfile;');

    expect(code).toContain('export interface UserProfile {');
    expect(code).toContain('bio?: string;');
  });

  // ── Golden comprehensive tests ──────────────────────────────────────

  describe('BlogPost golden TypeScript output', () => {
    const outputs = generateTypeScript(goldenFixtureIPS);
    const code = outputs['blogpost.types.ts']!;

    it('should produce correctly named output file', () => {
      expect(Object.keys(outputs)).toEqual(['blogpost.types.ts']);
    });

    it('should export the main BlogPost interface', () => {
      expect(code).toContain('export interface BlogPost {');
    });

    // ── Primitive field types ────────────────────────────────────────
    it('should map uuid to string with unique comment', () => {
      expect(code).toContain('id: string; // unique');
    });

    it('should map string type to string', () => {
      expect(code).toContain('title: string;');
    });

    it('should map string with unique to string with unique comment', () => {
      expect(code).toContain('slug: string; // unique');
    });

    it('should map integer to number', () => {
      expect(code).toContain('viewCount: number;');
    });

    it('should map decimal to optional number', () => {
      expect(code).toContain('rating?: number;');
    });

    it('should map boolean to boolean', () => {
      expect(code).toContain('published: boolean;');
    });

    it('should map date to string with ISO-8601 comment', () => {
      expect(code).toContain('createdAt: string; // ISO-8601 Date format');
    });

    it('should map email to string with unique comment', () => {
      expect(code).toContain('authorEmail: string; // unique');
    });

    it('should map url to optional string', () => {
      expect(code).toContain('website?: string;');
    });

    it('should map enum to union type with default', () => {
      expect(code).toContain('status: "draft" | "published" | "archived";');
    });

    // ── Nested object ────────────────────────────────────────────────
    it('should create a named sub-interface for nested object', () => {
      expect(code).toContain('metadata: BlogPostMetadata;');
      expect(code).toContain('export interface BlogPostMetadata {');
    });

    it('should render optional fields in sub-interface', () => {
      expect(code).toContain('seoTitle?: string;');
    });

    it('should render array of primitives in sub-interface', () => {
      expect(code).toContain('keywords?: string[];');
    });

    // ── Array of objects ─────────────────────────────────────────────
    it('should create ItemInterface for array of objects', () => {
      expect(code).toContain('tags?: BlogPostTagsItem[];');
      expect(code).toContain('export interface BlogPostTagsItem {');
    });

    it('should render fields in the array item interface', () => {
      expect(code).toContain('label: string;');
      expect(code).toContain('color?: string;');
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
    expect(Object.keys(generateTypeScript(emptyIPS))).toHaveLength(0);
  });

  it('should handle entity with no fields', () => {
    const noFieldsIPS: InternalProjectSchema = {
      projectId: 'proj_nf',
      version: 1,
      entities: [{ name: 'Empty', fields: [] }],
      generationConfig: { validators: [], types: [], methods: [], mockRecords: 0 },
    };
    const outputs = generateTypeScript(noFieldsIPS);
    const code = outputs['empty.types.ts']!;
    expect(code).toContain('export interface Empty {');
    expect(code).toContain('}');
  });

  it('should handle enum with no values as plain string', () => {
    const enumIPS: InternalProjectSchema = {
      projectId: 'proj_enum',
      version: 1,
      entities: [
        {
          name: 'Test',
          fields: [
            {
              name: 'emptyEnum',
              type: 'enum',
              required: true,
              default: null,
              validation: { enum: [] },
              meta: {},
              children: [],
            },
          ],
        },
      ],
      generationConfig: { validators: [], types: [], methods: [], mockRecords: 0 },
    };
    const outputs = generateTypeScript(enumIPS);
    expect(outputs['test.types.ts']).toContain('emptyEnum: string;');
  });
});
