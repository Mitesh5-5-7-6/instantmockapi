/**
 * Shared relation fixture for generator tests (doc 19 §Phase A).
 *
 * Deliberately a *second* fixture rather than extra entities on
 * `goldenFixtureIPS`: six existing assertions across the generator suites pin
 * that fixture to exactly one output file, so growing it would break tests that
 * have nothing to do with relations.
 *
 * Stored **as authored** — sparse relations, no foreign-key fields, no identity
 * fields — so it doubles as the `materializeRelations` contract: run it through
 * that function and the derived shape must appear.
 */
import type { InternalProjectSchema } from '@instantmockapi/ips';

function field(
  name: string,
  type: 'string' | 'integer' | 'date' = 'string',
): InternalProjectSchema['entities'][number]['fields'][number] {
  return { name, type, required: true, default: null, children: [], validation: {}, meta: {} };
}

/**
 * Student ERP in miniature — one of every cardinality, plus mixed identity
 * styles so seeding covers both `int` (copy-pasteable `/students/1`) and `uuid`.
 *
 * Classroom 1──M Student M──M Course
 */
export const goldenRelationsIPS: InternalProjectSchema = {
  projectId: 'proj_relations',
  version: 1,
  entities: [
    {
      name: 'Classroom',
      identity: { field: 'id', style: 'int' },
      fields: [field('name'), field('capacity', 'integer')],
      relations: [
        {
          name: 'students',
          kind: 'hasMany',
          target: 'Student',
          localField: '',
          foreignField: '',
          required: false,
          onDelete: 'restrict',
        },
      ],
    },
    {
      name: 'Student',
      identity: { field: 'id', style: 'int' },
      fields: [field('name'), field('enrolledAt', 'date')],
      relations: [
        {
          name: 'classroom',
          kind: 'belongsTo',
          target: 'Classroom',
          localField: '',
          foreignField: '',
          required: true,
          onDelete: 'restrict',
        },
        {
          name: 'courses',
          kind: 'manyToMany',
          target: 'Course',
          localField: '',
          foreignField: '',
          required: false,
          onDelete: 'setNull',
        },
      ],
    },
    {
      name: 'Course',
      identity: { field: 'id', style: 'uuid' },
      fields: [field('title')],
      relations: [],
    },
  ],
  generationConfig: {
    validators: ['zod'],
    types: ['typescript'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    mockRecords: 4,
  },
};
