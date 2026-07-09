/**
 * Shared golden-file fixture for generator tests.
 *
 * This IPS covers every field type, validation rule, nesting pattern,
 * and edge case that the generators must handle correctly.
 */
import type { InternalProjectSchema } from '@instantmockapi/ips';

/**
 * Rich fixture with two entities exercising all field types and rules.
 */
export const goldenFixtureIPS: InternalProjectSchema = {
  projectId: 'proj_golden',
  version: 1,
  entities: [
    {
      name: 'BlogPost',
      fields: [
        {
          name: 'id',
          type: 'uuid',
          required: true,
          default: null,
          validation: {},
          meta: { unique: true },
          children: [],
        },
        {
          name: 'title',
          type: 'string',
          required: true,
          default: '',
          validation: { min: 5, max: 200, message: 'Title must be 5-200 chars' },
          meta: {},
          children: [],
        },
        {
          name: 'slug',
          type: 'string',
          required: true,
          default: null,
          validation: { regex: '^[a-z0-9-]+$' },
          meta: { unique: true },
          children: [],
        },
        {
          name: 'viewCount',
          type: 'integer',
          required: true,
          default: 0,
          validation: { min: 0 },
          meta: {},
          children: [],
        },
        {
          name: 'rating',
          type: 'decimal',
          required: false,
          default: null,
          validation: { min: 0, max: 5 },
          meta: {},
          children: [],
        },
        {
          name: 'published',
          type: 'boolean',
          required: true,
          default: false,
          validation: {},
          meta: {},
          children: [],
        },
        {
          name: 'createdAt',
          type: 'date',
          required: true,
          default: null,
          validation: {},
          meta: {},
          children: [],
        },
        {
          name: 'authorEmail',
          type: 'email',
          required: true,
          default: null,
          validation: {},
          meta: { unique: true },
          children: [],
        },
        {
          name: 'website',
          type: 'url',
          required: false,
          default: null,
          validation: {},
          meta: {},
          children: [],
        },
        {
          name: 'status',
          type: 'enum',
          required: true,
          default: 'draft',
          validation: { enum: ['draft', 'published', 'archived'] },
          meta: {},
          children: [],
        },
        {
          name: 'metadata',
          type: 'object',
          required: true,
          default: null,
          validation: {},
          meta: {},
          children: [
            {
              name: 'seoTitle',
              type: 'string',
              required: false,
              default: '',
              validation: { max: 60 },
              meta: {},
              children: [],
            },
            {
              name: 'keywords',
              type: 'array',
              required: false,
              default: null,
              validation: { arrayLength: { min: 1, max: 10 } },
              meta: {},
              children: [
                {
                  name: 'keyword',
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
        {
          name: 'tags',
          type: 'array',
          required: false,
          default: null,
          validation: { arrayLength: { min: 0, max: 5 } },
          meta: {},
          children: [
            {
              name: 'tag',
              type: 'object',
              required: true,
              default: null,
              validation: {},
              meta: {},
              children: [
                {
                  name: 'label',
                  type: 'string',
                  required: true,
                  default: '',
                  validation: { min: 1 },
                  meta: {},
                  children: [],
                },
                {
                  name: 'color',
                  type: 'string',
                  required: false,
                  default: '#000000',
                  validation: { length: 7 },
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
  generationConfig: {
    validators: ['zod', 'yup', 'jsonschema'],
    types: ['typescript'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    mockRecords: 3,
  },
};
