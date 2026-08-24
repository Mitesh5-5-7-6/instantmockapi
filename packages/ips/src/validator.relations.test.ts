import { describe, it, expect } from 'vitest';
import { validateIPS } from './validator.js';
import type { Entity, Field, InternalProjectSchema, Relation } from './types.js';

function field(name: string, type: Field['type'] = 'string'): Field {
  return { name, type, required: true, default: null, children: [], validation: {}, meta: {} };
}

function relation(
  partial: Partial<Relation> & Pick<Relation, 'name' | 'kind' | 'target'>,
): Relation {
  return { localField: '', foreignField: '', required: false, onDelete: 'restrict', ...partial };
}

function ips(entities: Entity[]): InternalProjectSchema {
  return {
    projectId: 'proj_rel',
    version: 1,
    entities,
    generationConfig: {
      validators: ['zod'],
      types: ['typescript'],
      methods: ['GET', 'POST'],
      mockRecords: 3,
    },
  };
}

/** Collect the detail paths of a failed validation. */
function paths(schema: InternalProjectSchema): string[] {
  const res = validateIPS(schema);
  return res.ok ? [] : res.error.details.map((d) => d.path);
}

function issueAt(schema: InternalProjectSchema, path: string): string | undefined {
  const res = validateIPS(schema);
  return res.ok ? undefined : res.error.details.find((d) => d.path === path)?.issue;
}

const intIdentity = { field: 'id', style: 'int' } as const;

describe('validateIPS · relations', () => {
  it('accepts a sparsely-authored belongsTo / hasMany pair with no FK declared', () => {
    // The single most important case: the wizard and packs author only
    // { name, kind, target }, and nothing has materialized `classroomId` yet.
    const res = validateIPS(
      ips([
        {
          name: 'Classroom',
          identity: intIdentity,
          fields: [field('name')],
          relations: [relation({ name: 'students', kind: 'hasMany', target: 'Student' })],
        },
        {
          name: 'Student',
          identity: intIdentity,
          fields: [field('name')],
          relations: [
            relation({ name: 'classroom', kind: 'belongsTo', target: 'Classroom', required: true }),
          ],
        },
      ]),
    );
    expect(res.ok).toBe(true);
  });

  it('accepts a manyToMany pair', () => {
    const res = validateIPS(
      ips([
        {
          name: 'Student',
          identity: intIdentity,
          fields: [field('name')],
          relations: [relation({ name: 'courses', kind: 'manyToMany', target: 'Course' })],
        },
        { name: 'Course', identity: intIdentity, fields: [field('title')] },
      ]),
    );
    expect(res.ok).toBe(true);
  });

  it('accepts an entity with no relations at all', () => {
    expect(validateIPS(ips([{ name: 'Thing', fields: [field('name')] }])).ok).toBe(true);
  });

  it('rejects a non-array relations value', () => {
    const schema = ips([
      { name: 'Thing', fields: [field('name')], relations: {} as unknown as Relation[] },
    ]);
    expect(issueAt(schema, 'entities[0].relations')).toContain('must be an array');
  });

  it('rejects an unknown kind', () => {
    const schema = ips([
      {
        name: 'Thing',
        fields: [field('name')],
        relations: [
          relation({ name: 'other', kind: 'hasHeaps' as Relation['kind'], target: 'Thing' }),
        ],
      },
    ]);
    expect(issueAt(schema, 'entities[0].relations[0].kind')).toContain('kind must be one of');
  });

  it('rejects an unknown onDelete', () => {
    const schema = ips([
      { name: 'Classroom', identity: intIdentity, fields: [field('name')] },
      {
        name: 'Student',
        identity: intIdentity,
        fields: [field('name')],
        relations: [
          relation({
            name: 'classroom',
            kind: 'belongsTo',
            target: 'Classroom',
            onDelete: 'explode' as Relation['onDelete'],
          }),
        ],
      },
    ]);
    expect(issueAt(schema, 'entities[1].relations[0].onDelete')).toContain(
      'onDelete must be one of',
    );
  });

  it('rejects a relation name that is not a valid identifier', () => {
    const schema = ips([
      { name: 'Classroom', identity: intIdentity, fields: [field('name')] },
      {
        name: 'Student',
        identity: intIdentity,
        fields: [field('name')],
        relations: [relation({ name: 'has-dash', kind: 'belongsTo', target: 'Classroom' })],
      },
    ]);
    expect(issueAt(schema, 'entities[1].relations[0].name')).toContain('alphanumeric');
  });

  it('rejects duplicate relation names on one entity', () => {
    const schema = ips([
      { name: 'Classroom', identity: intIdentity, fields: [field('name')] },
      {
        name: 'Student',
        identity: intIdentity,
        fields: [field('name')],
        relations: [
          relation({ name: 'classroom', kind: 'belongsTo', target: 'Classroom' }),
          relation({ name: 'classroom', kind: 'hasOne', target: 'Classroom' }),
        ],
      },
    ]);
    expect(issueAt(schema, 'entities[1].relations[1].name')).toContain('Duplicate');
  });

  it('rejects a relation name that collides with a field name', () => {
    // ?include= expansion writes onto this key, so the field would be overwritten
    const schema = ips([
      { name: 'Classroom', identity: intIdentity, fields: [field('name')] },
      {
        name: 'Student',
        identity: intIdentity,
        fields: [field('name'), field('classroom')],
        relations: [relation({ name: 'classroom', kind: 'belongsTo', target: 'Classroom' })],
      },
    ]);
    expect(issueAt(schema, 'entities[1].relations[0].name')).toContain('collides');
  });

  it('rejects a dangling target', () => {
    const schema = ips([
      {
        name: 'Student',
        identity: intIdentity,
        fields: [field('name')],
        relations: [relation({ name: 'ghost', kind: 'belongsTo', target: 'Ghost' })],
      },
    ]);
    expect(issueAt(schema, 'entities[0].relations[0].target')).toContain('not a declared entity');
  });

  it('rejects a missing target', () => {
    const schema = ips([
      {
        name: 'Student',
        identity: intIdentity,
        fields: [field('name')],
        relations: [relation({ name: 'nothing', kind: 'belongsTo', target: '' })],
      },
    ]);
    expect(issueAt(schema, 'entities[0].relations[0].target')).toContain('required');
  });

  it('rejects a hasMany whose target carries no matching belongsTo', () => {
    const schema = ips([
      {
        name: 'Classroom',
        identity: intIdentity,
        fields: [field('name')],
        relations: [relation({ name: 'students', kind: 'hasMany', target: 'Student' })],
      },
      { name: 'Student', identity: intIdentity, fields: [field('name')] },
    ]);
    expect(issueAt(schema, 'entities[0].relations[0].foreignField')).toContain(
      'add the matching belongsTo',
    );
  });

  it('rejects an explicit foreignField that does not exist on the target', () => {
    const schema = ips([
      { name: 'Classroom', identity: intIdentity, fields: [field('name')] },
      {
        name: 'Student',
        identity: intIdentity,
        fields: [field('name')],
        relations: [
          relation({
            name: 'classroom',
            kind: 'belongsTo',
            target: 'Classroom',
            foreignField: 'nope',
          }),
        ],
      },
    ]);
    expect(issueAt(schema, 'entities[1].relations[0].foreignField')).toContain("'nope'");
  });

  it('catches drift when the owning side renames its FK but the inverse does not', () => {
    // Student.belongsTo declares homeroomId; Classroom.hasMany still derives
    // classroomId, so the pair describes two different joins.
    const schema = ips([
      {
        name: 'Classroom',
        identity: intIdentity,
        fields: [field('name')],
        relations: [relation({ name: 'students', kind: 'hasMany', target: 'Student' })],
      },
      {
        name: 'Student',
        identity: intIdentity,
        fields: [field('name')],
        relations: [
          relation({
            name: 'classroom',
            kind: 'belongsTo',
            target: 'Classroom',
            localField: 'homeroomId',
          }),
        ],
      },
    ]);
    expect(paths(schema)).toContain('entities[0].relations[0].foreignField');
  });

  it('accepts the drift case once the inverse names the same key', () => {
    const res = validateIPS(
      ips([
        {
          name: 'Classroom',
          identity: intIdentity,
          fields: [field('name')],
          relations: [
            relation({
              name: 'students',
              kind: 'hasMany',
              target: 'Student',
              foreignField: 'homeroomId',
            }),
          ],
        },
        {
          name: 'Student',
          identity: intIdentity,
          fields: [field('name')],
          relations: [
            relation({
              name: 'classroom',
              kind: 'belongsTo',
              target: 'Classroom',
              localField: 'homeroomId',
            }),
          ],
        },
      ]),
    );
    expect(res.ok).toBe(true);
  });

  it('rejects a required self-referencing belongsTo', () => {
    const schema = ips([
      {
        name: 'Node',
        identity: intIdentity,
        fields: [field('label')],
        relations: [
          relation({ name: 'parent', kind: 'belongsTo', target: 'Node', required: true }),
        ],
      },
    ]);
    expect(issueAt(schema, 'entities[0].relations[0].required')).toContain('cannot be required');
  });

  it('accepts an optional self-referencing belongsTo', () => {
    const res = validateIPS(
      ips([
        {
          name: 'Node',
          identity: intIdentity,
          fields: [field('label')],
          relations: [relation({ name: 'parent', kind: 'belongsTo', target: 'Node' })],
        },
      ]),
    );
    expect(res.ok).toBe(true);
  });

  it('reports relation problems as VALIDATION_ERROR, never DEPTH_LIMIT_EXCEEDED', () => {
    // validateIPS picks its code by substring-matching 'exceeds max depth', so no
    // relation issue may ever contain that phrase.
    const res = validateIPS(
      ips([
        {
          name: 'Student',
          identity: intIdentity,
          fields: [field('name')],
          relations: [relation({ name: 'ghost', kind: 'belongsTo', target: 'Ghost' })],
        },
      ]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('validateIPS · identity', () => {
  it('accepts both styles', () => {
    expect(
      validateIPS(
        ips([{ name: 'A', identity: { field: 'id', style: 'int' }, fields: [field('x')] }]),
      ).ok,
    ).toBe(true);
    expect(
      validateIPS(
        ips([{ name: 'A', identity: { field: 'ref', style: 'uuid' }, fields: [field('x')] }]),
      ).ok,
    ).toBe(true);
  });

  it('rejects a non-object identity', () => {
    const schema = ips([
      { name: 'A', identity: 'id' as unknown as Entity['identity'], fields: [field('x')] },
    ]);
    expect(issueAt(schema, 'entities[0].identity')).toContain('must be an object');
  });

  it('rejects an invalid identity field name', () => {
    const schema = ips([
      { name: 'A', identity: { field: 'not-valid', style: 'int' }, fields: [field('x')] },
    ]);
    expect(issueAt(schema, 'entities[0].identity.field')).toContain('valid field name');
  });

  it('rejects an unknown identity style', () => {
    const schema = ips([
      {
        name: 'A',
        identity: { field: 'id', style: 'serial' as 'int' },
        fields: [field('x')],
      },
    ]);
    expect(issueAt(schema, 'entities[0].identity.style')).toContain("'int' or 'uuid'");
  });
});
