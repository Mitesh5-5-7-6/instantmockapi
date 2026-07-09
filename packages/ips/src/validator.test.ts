import { describe, it, expect } from 'vitest';
import { validateIPS } from './validator.js';
import type { InternalProjectSchema, Field } from './types.js';

describe('IPS Validator', () => {
  const validIPS: InternalProjectSchema = {
    projectId: 'proj_123',
    version: 1,
    entities: [
      {
        name: 'Customer',
        fields: [
          {
            name: 'name',
            type: 'string',
            required: true,
            default: '',
            children: [],
            validation: {},
            meta: {},
          },
          {
            name: 'email',
            type: 'email',
            required: true,
            default: null,
            children: [],
            validation: { email: true },
            meta: { unique: true },
          },
        ],
      },
    ],
    generationConfig: {
      validators: ['zod'],
      types: ['typescript'],
      methods: ['GET', 'POST'],
      mockRecords: 25,
    },
  };

  it('should validate a correct IPS schema successfully', () => {
    const res = validateIPS(validIPS);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.projectId).toBe('proj_123');
    }
  });

  it('should reject invalid project identifiers and versions', () => {
    const invalid = { ...validIPS, projectId: ' ', version: -1 };
    const res = validateIPS(invalid);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('VALIDATION_ERROR');
      expect(res.error.details.some((d) => d.path === 'projectId')).toBe(true);
      expect(res.error.details.some((d) => d.path === 'version')).toBe(true);
    }
  });

  it('should reject duplicate entity names', () => {
    const invalid = {
      ...validIPS,
      entities: [
        { name: 'Customer', fields: validIPS.entities[0]!.fields },
        { name: 'Customer', fields: validIPS.entities[0]!.fields },
      ],
    };
    const res = validateIPS(invalid);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.details.some((d) => d.path === 'entities[1].name' && d.issue.includes('Duplicate'))).toBe(true);
    }
  });

  it('should reject duplicate field names within an entity', () => {
    const invalid = {
      ...validIPS,
      entities: [
        {
          name: 'Customer',
          fields: [
            {
              name: 'email',
              type: 'email',
              required: true,
              default: null,
              children: [],
              validation: {},
              meta: {},
            },
            {
              name: 'email',
              type: 'string',
              required: false,
              default: null,
              children: [],
              validation: {},
              meta: {},
            },
          ],
        },
      ],
    };
    const res = validateIPS(invalid);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.details.some((d) => d.path === 'entities[0].fields[1].name' && d.issue.includes('Duplicate'))).toBe(true);
    }
  });

  it('should reject field names containing illegal characters', () => {
    const invalid = {
      ...validIPS,
      entities: [
        {
          name: 'Customer',
          fields: [
            {
              name: 'invalid-field-name!',
              type: 'string',
              required: true,
              default: null,
              children: [],
              validation: {},
              meta: {},
            },
          ],
        },
      ],
    };
    const res = validateIPS(invalid);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.details.some((d) => d.path === 'entities[0].fields[0].name' && d.issue.includes('invalid'))).toBe(true);
    }
  });

  it('should enforce depth limit cap correctly', () => {
    // Create nested structure: object inside object inside ... (11 levels deep)
    let currentField: Field = {
      name: 'nested_11',
      type: 'string',
      required: true,
      default: '',
      children: [],
      validation: {},
      meta: {},
    };

    for (let i = 10; i >= 1; i--) {
      currentField = {
        name: `nested_${i}`,
        type: 'object',
        required: true,
        default: null,
        children: [currentField],
        validation: {},
        meta: {},
      };
    }

    const deeplyNestedIPS = {
      ...validIPS,
      entities: [
        {
          name: 'DeepEntity',
          fields: [currentField],
        },
      ],
    };

    const res = validateIPS(deeplyNestedIPS, 10); // maxDepth = 10
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('DEPTH_LIMIT_EXCEEDED');
      expect(res.error.details.some((d) => d.issue.includes('exceeds max depth'))).toBe(true);
    }
  });
});
