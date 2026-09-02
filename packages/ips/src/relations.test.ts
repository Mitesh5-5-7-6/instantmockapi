import { describe, it, expect } from 'vitest';
import {
  DEFAULT_IDENTITY,
  completeRelation,
  entityIdentity,
  entityRelations,
  identityFieldType,
  isCollectionRelation,
  isOwningRelation,
  materializeRelations,
  topologicalEntityOrder,
} from './relations.js';
import { ensureSchemaIds } from './ids.js';
import type { Entity, Field, InternalProjectSchema, Relation } from './types.js';

function field(name: string, type: Field['type'] = 'string'): Field {
  return { name, type, required: true, default: null, children: [], validation: {}, meta: {} };
}

function entity(name: string, extra: Partial<Entity> = {}): Entity {
  return { name, fields: [field('name')], ...extra };
}

function relation(
  partial: Partial<Relation> & Pick<Relation, 'name' | 'kind' | 'target'>,
): Relation {
  return {
    localField: '',
    foreignField: '',
    required: false,
    onDelete: 'restrict',
    ...partial,
  };
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

describe('entityIdentity', () => {
  it('defaults when the entity declares none', () => {
    expect(entityIdentity({})).toEqual(DEFAULT_IDENTITY);
  });

  it('defaults when the declared field name is blank', () => {
    expect(entityIdentity({ identity: { field: '', style: 'int' } })).toEqual(DEFAULT_IDENTITY);
  });

  it('falls back to uuid for an unknown style', () => {
    const identity = entityIdentity({
      identity: { field: 'sid', style: 'weird' as 'int' },
    });
    expect(identity).toEqual({ field: 'sid', style: 'uuid' });
  });

  it('preserves a valid declaration', () => {
    expect(entityIdentity({ identity: { field: 'studentId', style: 'int' } })).toEqual({
      field: 'studentId',
      style: 'int',
    });
  });
});

describe('entityRelations', () => {
  it('returns [] for absent or non-array values', () => {
    expect(entityRelations({})).toEqual([]);
    expect(entityRelations({ relations: undefined })).toEqual([]);
    expect(entityRelations({ relations: {} as unknown as Relation[] })).toEqual([]);
  });
});

describe('identityFieldType', () => {
  it('maps identity style to an IPS field type', () => {
    expect(identityFieldType({ field: 'id', style: 'int' })).toBe('integer');
    expect(identityFieldType({ field: 'id', style: 'uuid' })).toBe('uuid');
  });
});

describe('relation kind predicates', () => {
  // Pins the semantics: hasOne is the singular INVERSE of belongsTo (the Prisma
  // convention), so the foreign key lives on the target, not here.
  it.each([
    ['belongsTo', true, false],
    ['hasOne', false, false],
    ['hasMany', false, true],
    ['manyToMany', true, true],
  ] as const)('%s → owning %s, collection %s', (kind, owning, collection) => {
    expect(isOwningRelation({ kind })).toBe(owning);
    expect(isCollectionRelation({ kind })).toBe(collection);
  });
});

describe('completeRelation', () => {
  const classroom = entity('Classroom', { identity: { field: 'id', style: 'int' } });
  const student = entity('Student', { identity: { field: 'id', style: 'int' } });

  it('derives the FK on the declaring entity for belongsTo', () => {
    const completed = completeRelation(
      student,
      relation({ name: 'classroom', kind: 'belongsTo', target: 'Classroom' }),
      classroom,
    );
    expect(completed.localField).toBe('classroomId');
    expect(completed.foreignField).toBe('id');
  });

  it('derives the FK on the target for the inverse hasMany', () => {
    const completed = completeRelation(
      classroom,
      relation({ name: 'students', kind: 'hasMany', target: 'Student' }),
      student,
    );
    expect(completed.localField).toBe('id');
    expect(completed.foreignField).toBe('classroomId');
  });

  it('pluralises the id array for manyToMany', () => {
    const course = entity('Course', { identity: { field: 'id', style: 'uuid' } });
    const completed = completeRelation(
      student,
      relation({ name: 'courses', kind: 'manyToMany', target: 'Course' }),
      course,
    );
    expect(completed.localField).toBe('courseIds');
    expect(completed.foreignField).toBe('id');
  });

  it('honours explicitly declared field names', () => {
    const completed = completeRelation(
      student,
      relation({
        name: 'homeroom',
        kind: 'belongsTo',
        target: 'Classroom',
        localField: 'homeroomId',
        foreignField: 'code',
      }),
      classroom,
    );
    expect(completed.localField).toBe('homeroomId');
    expect(completed.foreignField).toBe('code');
  });

  it('uses the target identity field name, not a hardcoded id', () => {
    const coded = entity('Classroom', { identity: { field: 'code', style: 'uuid' } });
    const completed = completeRelation(
      student,
      relation({ name: 'classroom', kind: 'belongsTo', target: 'Classroom' }),
      coded,
    );
    expect(completed.localField).toBe('classroomCode');
  });

  it('agrees on the join key when the two entities use different identity names', () => {
    // Both sides must derive from the belongsTo target's identity, or the pair
    // silently describes two different joins.
    const src = entity('Student', { identity: { field: 'sid', style: 'int' } });
    const dst = entity('Classroom', { identity: { field: 'cid', style: 'int' } });

    const owning = completeRelation(
      src,
      relation({ name: 'classroom', kind: 'belongsTo', target: 'Classroom' }),
      dst,
    );
    const inverse = completeRelation(
      dst,
      relation({ name: 'students', kind: 'hasMany', target: 'Student' }),
      src,
    );

    expect(owning.localField).toBe('classroomCid');
    expect(inverse.foreignField).toBe('classroomCid');
  });

  it('defaults required to false and onDelete to restrict', () => {
    const completed = completeRelation(
      student,
      { name: 'classroom', kind: 'belongsTo', target: 'Classroom' },
      classroom,
    );
    expect(completed.required).toBe(false);
    expect(completed.onDelete).toBe('restrict');
  });

  it('falls back to the default identity when the target is unknown', () => {
    const completed = completeRelation(
      student,
      relation({ name: 'ghost', kind: 'belongsTo', target: 'Ghost' }),
      undefined,
    );
    expect(completed.localField).toBe('ghostId');
    expect(completed.foreignField).toBe('id');
  });
});

describe('materializeRelations', () => {
  const source = ips([
    entity('Classroom', {
      identity: { field: 'id', style: 'int' },
      relations: [relation({ name: 'students', kind: 'hasMany', target: 'Student' })],
    }),
    entity('Student', {
      identity: { field: 'id', style: 'int' },
      relations: [
        relation({ name: 'classroom', kind: 'belongsTo', target: 'Classroom', required: true }),
        relation({ name: 'courses', kind: 'manyToMany', target: 'Course' }),
      ],
    }),
    entity('Course', { identity: { field: 'id', style: 'uuid' } }),
  ]);

  it('prepends the identity field as optional and read-only', () => {
    const result = materializeRelations(source);
    const classroom = result.entities[0]!;
    expect(classroom.fields[0]!.name).toBe('id');
    expect(classroom.fields[0]!.type).toBe('integer');
    // The runtime assigns identity on create, so a POST without one must validate
    expect(classroom.fields[0]!.required).toBe(false);
    expect(classroom.fields[0]!.meta.identity).toBe(true);
    expect(classroom.fields[0]!.meta.readOnly).toBe(true);
  });

  it('appends the owning-side foreign key with its target recorded', () => {
    const student = materializeRelations(source).entities[1]!;
    const fk = student.fields.find((f) => f.name === 'classroomId');
    expect(fk).toBeDefined();
    expect(fk!.type).toBe('integer');
    expect(fk!.required).toBe(true);
    expect(fk!.meta.reference).toBe(true);
    expect(fk!.meta.relation).toBe('Classroom');
  });

  it('materialises manyToMany as an array of the target identity type', () => {
    const student = materializeRelations(source).entities[1]!;
    const link = student.fields.find((f) => f.name === 'courseIds');
    expect(link!.type).toBe('array');
    expect(link!.children).toHaveLength(1);
    expect(link!.children[0]!.type).toBe('uuid');
    expect(link!.children[0]!.meta.relation).toBe('Course');
  });

  it('adds nothing for the inverse side', () => {
    const classroom = materializeRelations(source).entities[0]!;
    expect(classroom.fields.map((f) => f.name)).toEqual(['id', 'name']);
  });

  it('completes sparsely-authored relations in place', () => {
    const student = materializeRelations(source).entities[1]!;
    expect(student.relations![0]).toMatchObject({
      localField: 'classroomId',
      foreignField: 'id',
    });
  });

  it('is idempotent', () => {
    const once = materializeRelations(source);
    expect(materializeRelations(once)).toEqual(once);
  });

  it('does not duplicate an explicitly declared foreign key', () => {
    const declared = ips([
      entity('Classroom', { identity: { field: 'id', style: 'int' } }),
      {
        name: 'Student',
        identity: { field: 'id', style: 'int' },
        fields: [field('name'), field('classroomId', 'integer')],
        relations: [relation({ name: 'classroom', kind: 'belongsTo', target: 'Classroom' })],
      },
    ]);
    const student = materializeRelations(declared).entities[1]!;
    expect(student.fields.filter((f) => f.name === 'classroomId')).toHaveLength(1);
  });

  it('leaves an entity that already declares its identity field untouched', () => {
    const declared = ips([{ name: 'Thing', fields: [field('id', 'uuid'), field('name')] }]);
    const thing = materializeRelations(declared).entities[0]!;
    expect(thing.fields.map((f) => f.name)).toEqual(['id', 'name']);
    expect(thing.fields[0]!.meta.identity).toBeUndefined();
  });

  it('adds only the identity field when no relations are declared', () => {
    const plain = materializeRelations(ips([entity('Thing')]));
    expect(plain.entities[0]!.fields.map((f) => f.name)).toEqual(['id', 'name']);
  });
});

describe('topologicalEntityOrder', () => {
  it('is the identity permutation for a relation-free schema', () => {
    // This is what keeps existing mock-data output byte-identical: no belongsTo
    // means no dependency edges, so the first pass emits declaration order.
    const names = topologicalEntityOrder(
      ips([entity('Alpha'), entity('Beta'), entity('Gamma')]),
    ).map((e) => e.name);
    expect(names).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('places a belongsTo target before the entity declaring it', () => {
    const names = topologicalEntityOrder(
      ips([
        entity('Student', {
          relations: [relation({ name: 'classroom', kind: 'belongsTo', target: 'Classroom' })],
        }),
        entity('Classroom'),
      ]),
    ).map((e) => e.name);
    expect(names).toEqual(['Classroom', 'Student']);
  });

  it('treats manyToMany as a dependency too', () => {
    const names = topologicalEntityOrder(
      ips([
        entity('Student', {
          relations: [relation({ name: 'courses', kind: 'manyToMany', target: 'Course' })],
        }),
        entity('Course'),
      ]),
    ).map((e) => e.name);
    expect(names).toEqual(['Course', 'Student']);
  });

  it('ignores inverse sides when ordering', () => {
    const names = topologicalEntityOrder(
      ips([
        entity('Classroom', {
          relations: [relation({ name: 'students', kind: 'hasMany', target: 'Student' })],
        }),
        entity('Student'),
      ]),
    ).map((e) => e.name);
    expect(names).toEqual(['Classroom', 'Student']);
  });

  it('appends cycle participants in declaration order instead of hanging', () => {
    const names = topologicalEntityOrder(
      ips([
        entity('A', { relations: [relation({ name: 'b', kind: 'belongsTo', target: 'B' })] }),
        entity('B', { relations: [relation({ name: 'a', kind: 'belongsTo', target: 'A' })] }),
        entity('C'),
      ]),
    ).map((e) => e.name);
    expect(names).toEqual(['C', 'A', 'B']);
  });

  it('terminates on a self-reference', () => {
    const names = topologicalEntityOrder(
      ips([
        entity('Node', {
          relations: [relation({ name: 'parent', kind: 'belongsTo', target: 'Node' })],
        }),
      ]),
    ).map((e) => e.name);
    expect(names).toEqual(['Node']);
  });

  it('ignores relations pointing at entities that do not exist', () => {
    const names = topologicalEntityOrder(
      ips([
        entity('A', { relations: [relation({ name: 'g', kind: 'belongsTo', target: 'Ghost' })] }),
      ]),
    ).map((e) => e.name);
    expect(names).toEqual(['A']);
  });
});

/**
 * `materializeRelations` runs on EVERY create and every PATCH
 * (apps/api/src/routes/projects.ts). It rebuilds each relation through
 * `completeRelation`, which returns a fresh object literal — so anything not
 * explicitly carried across is destroyed on the first save.
 *
 * That makes these the tests that protect Phase 1's stable ids. Without the
 * spread in `completeRelation`, a relation id would survive exactly until the
 * user pressed save, and every dependency-graph edge pointing at it would break
 * silently — no error, no failing test, just a graph that quietly forgot.
 */
describe('stable ids survive materialization', () => {
  it('preserves a relation id through completeRelation', () => {
    const result = materializeRelations(
      ips([
        entity('Student', {
          relations: [
            {
              ...relation({ name: 'classroom', kind: 'belongsTo', target: 'Classroom' }),
              id: 'rel_0123456789ab',
            },
          ],
        }),
        entity('Classroom'),
      ]),
    );

    expect(result.entities[0]?.relations?.[0]?.id).toBe('rel_0123456789ab');
  });

  it('survives repeated materialization', () => {
    // The function is documented as idempotent and is called at several pipeline
    // stages, so once is not a sufficient test.
    const start = ips([
      entity('Student', {
        relations: [
          {
            ...relation({ name: 'classroom', kind: 'belongsTo', target: 'Classroom' }),
            id: 'rel_aaaaaaaaaaaa',
          },
        ],
      }),
      entity('Classroom'),
    ]);

    const twice = materializeRelations(materializeRelations(materializeRelations(start)));

    expect(twice.entities[0]?.relations?.[0]?.id).toBe('rel_aaaaaaaaaaaa');
  });

  it('preserves entity and field ids too', () => {
    // These travel by object spread rather than an explicit copy, so they are
    // less fragile — but they are on the same code path and worth pinning.
    const start = ips([
      {
        ...entity('Student', { fields: [{ ...field('name'), id: 'fld_1111aaaa2222' }] }),
        id: 'ent_1111aaaa2222',
      },
    ]);

    const result = materializeRelations(start);

    expect(result.entities[0]?.id).toBe('ent_1111aaaa2222');
    // Note the materialized identity field is unshifted BEFORE the author's
    // fields, so the named field is no longer at index 0.
    expect(result.entities[0]?.fields.find((f) => f.name === 'name')?.id).toBe('fld_1111aaaa2222');
  });

  it('omits the id key entirely when the relation has none', () => {
    // Every relation written before Phase 1 has no id. Emitting `id: undefined`
    // would persist an explicit null into Mongo and make `ensureSchemaIds`
    // unable to tell "absent" from "set to nothing".
    const result = materializeRelations(
      ips([
        entity('Student', {
          relations: [relation({ name: 'classroom', kind: 'belongsTo', target: 'Classroom' })],
        }),
        entity('Classroom'),
      ]),
    );

    expect(result.entities[0]?.relations?.[0]).not.toHaveProperty('id');
  });

  it('leaves server-materialized fields without ids, for the backfill to fill', () => {
    // materializeRelations unshifts an identity field and pushes reference
    // fields. It deliberately does NOT mint ids for them — `ensureSchemaIds`
    // runs afterwards and owns that, so there is exactly one minting site.
    const result = materializeRelations(
      ips([
        entity('Student', {
          relations: [relation({ name: 'classroom', kind: 'belongsTo', target: 'Classroom' })],
        }),
        entity('Classroom'),
      ]),
    );

    const identity = result.entities[0]?.fields.find((f) => f.meta.identity === true);
    expect(identity).toBeDefined();
    expect(identity).not.toHaveProperty('id');

    // ...and the backfill then gives them one.
    const minted = ensureSchemaIds(result);
    expect(minted.minted).toBeGreaterThan(0);
    expect(result.entities[0]?.fields.find((f) => f.meta.identity === true)?.id).toMatch(/^fld_/);
  });
});

describe('identity field reconciliation', () => {
  /**
   * The bug a user hit on the first real edit: switching an entity from UUIDs to
   * counting numbers changed `identity.style` but left the stored `id` field
   * typed `uuid`.
   *
   * The two are statements about the same thing and everything downstream assumes
   * they agree — mock data seeds from the style, the hosted runtime validates
   * against the field type. Disagreeing, the runtime rejects every id it was just
   * given.
   */
  it('retypes an existing identity field when the style changes', () => {
    const ips = materializeRelations({
      projectId: 'p1',
      version: 1,
      entities: [
        {
          name: 'User',
          identity: { field: 'id', style: 'int' },
          fields: [
            {
              name: 'id',
              type: 'uuid',
              required: false,
              default: null,
              children: [],
              validation: {},
              meta: { identity: true },
            },
            {
              name: 'email',
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
      generationConfig: {
        validators: ['zod'],
        types: ['typescript'],
        methods: ['GET'],
        mockRecords: 5,
      },
    } as never);

    const id = ips.entities[0]!.fields.find((field) => field.name === 'id');
    expect(id?.type).toBe('integer');
  });

  it('retypes in the other direction too', () => {
    const ips = materializeRelations({
      projectId: 'p1',
      version: 1,
      entities: [
        {
          name: 'User',
          identity: { field: 'id', style: 'uuid' },
          fields: [
            {
              name: 'id',
              type: 'integer',
              required: false,
              default: null,
              children: [],
              validation: {},
              meta: { identity: true },
            },
          ],
        },
      ],
      generationConfig: {
        validators: ['zod'],
        types: ['typescript'],
        methods: ['GET'],
        mockRecords: 5,
      },
    } as never);

    expect(ips.entities[0]!.fields[0]!.type).toBe('uuid');
  });

  /** Everything else about the field survives — this is a retype, not a rebuild. */
  it('keeps the identity field’s id, position and metadata', () => {
    const ips = materializeRelations({
      projectId: 'p1',
      version: 1,
      entities: [
        {
          name: 'User',
          identity: { field: 'ref', style: 'int' },
          fields: [
            {
              id: 'fld_keepme',
              name: 'ref',
              type: 'uuid',
              required: false,
              default: null,
              children: [],
              validation: { message: 'custom' },
              meta: { identity: true, readOnly: true },
            },
          ],
        },
      ],
      generationConfig: {
        validators: ['zod'],
        types: ['typescript'],
        methods: ['GET'],
        mockRecords: 5,
      },
    } as never);

    expect(ips.entities[0]!.fields[0]).toMatchObject({
      id: 'fld_keepme',
      name: 'ref',
      type: 'integer',
      validation: { message: 'custom' },
      meta: { identity: true, readOnly: true },
    });
    // No duplicate was unshifted alongside it.
    expect(ips.entities[0]!.fields).toHaveLength(1);
  });

  it('leaves an already-consistent identity field untouched', () => {
    const input = {
      projectId: 'p1',
      version: 1,
      entities: [
        {
          name: 'User',
          identity: { field: 'id', style: 'uuid' },
          fields: [
            {
              name: 'id',
              type: 'uuid',
              required: false,
              default: null,
              children: [],
              validation: {},
              meta: { identity: true },
            },
          ],
        },
      ],
      generationConfig: {
        validators: ['zod'],
        types: ['typescript'],
        methods: ['GET'],
        mockRecords: 5,
      },
    } as never;

    const once = materializeRelations(input);
    const twice = materializeRelations(once);
    expect(twice).toEqual(once);
  });
});
