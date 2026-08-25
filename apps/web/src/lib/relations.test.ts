import { describe, it, expect } from 'vitest';
import {
  newEntity,
  newField,
  newRelation,
  type BuilderEntity,
  type BuilderRelation,
} from './builder';
import {
  builderRelationToIPS,
  cardinalityOf,
  isOwningKind,
  previewKeyField,
  pruneForGeneration,
  relationTargets,
  relationsPointingAt,
  validateRelations,
} from './relations';

function relation(overrides: Partial<BuilderRelation> = {}): BuilderRelation {
  return { ...newRelation(), name: 'classroom', target: 'Classroom', ...overrides };
}

function entity(name: string, overrides: Partial<BuilderEntity> = {}): BuilderEntity {
  return { ...newEntity(name), ...overrides };
}

const model = (): BuilderEntity[] => [
  entity('Student', { relations: [relation()] }),
  entity('Classroom'),
];

describe('relation kinds', () => {
  it('knows which side owns the key', () => {
    // Only the owning side grows a foreign-key field, which is what the wizard
    // previews to the author.
    expect(isOwningKind('belongsTo')).toBe(true);
    expect(isOwningKind('manyToMany')).toBe(true);
    expect(isOwningKind('hasMany')).toBe(false);
    expect(isOwningKind('hasOne')).toBe(false);
  });

  it('labels cardinality for the diagram legend', () => {
    expect(cardinalityOf('belongsTo')).toBe('M : 1');
    expect(cardinalityOf('hasOne')).toBe('1 : 1');
    expect(cardinalityOf('hasMany')).toBe('1 : M');
    expect(cardinalityOf('manyToMany')).toBe('M : M');
  });
});

describe('previewKeyField', () => {
  it('mirrors the field name the server will derive', () => {
    expect(previewKeyField(relation({ kind: 'belongsTo', target: 'Classroom' }))).toBe(
      'classroomId',
    );
  });

  it('pluralises a many-to-many key array', () => {
    expect(previewKeyField(relation({ kind: 'manyToMany', target: 'Course' }))).toBe('courseIds');
  });

  it('follows a non-default identity field name', () => {
    expect(previewKeyField(relation({ target: 'Course' }), 'code')).toBe('courseCode');
  });

  it('previews nothing for an inverse side, which grows no field', () => {
    expect(previewKeyField(relation({ kind: 'hasMany' }))).toBeNull();
    expect(previewKeyField(relation({ kind: 'hasOne' }))).toBeNull();
  });

  it('previews nothing before a target is chosen', () => {
    expect(previewKeyField(relation({ target: '' }))).toBeNull();
  });
});

describe('relationTargets', () => {
  it('offers named, included entities', () => {
    expect(relationTargets(model())).toEqual(['Student', 'Classroom']);
  });

  it('omits an entity being typed and one excluded from generation', () => {
    const entities = [entity('Student'), entity('  '), entity('Fee', { generate: false })];
    expect(relationTargets(entities)).toEqual(['Student']);
  });
});

describe('validateRelations', () => {
  it('accepts a well-formed model', () => {
    expect(validateRelations(model())).toEqual([]);
  });

  it('requires a name and a target', () => {
    const entities = [entity('Student', { relations: [relation({ name: '', target: '' })] })];
    const issues = validateRelations(entities);
    expect(issues.map((issue) => issue.field).sort()).toEqual(['name', 'target']);
  });

  it('rejects a name that is not a plain identifier', () => {
    const entities = [
      entity('Student', { relations: [relation({ name: 'my class!' })] }),
      entity('Classroom'),
    ];
    expect(validateRelations(entities)[0]?.message).toContain('plain identifier');
  });

  it('rejects a relation name that collides with a field on the same entity', () => {
    // At request time the expansion overwrites the field, losing its value —
    // caught here rather than discovered in a response.
    const entities = [
      entity('Student', {
        fields: [newField('classroom')],
        relations: [relation({ name: 'classroom' })],
      }),
      entity('Classroom'),
    ];
    expect(validateRelations(entities)[0]?.message).toContain('would replace it');
  });

  it('rejects two relations sharing a name on one entity', () => {
    const entities = [
      entity('Student', { relations: [relation(), relation()] }),
      entity('Classroom'),
    ];
    const issues = validateRelations(entities);
    expect(issues.some((issue) => issue.message.includes('Duplicate relation name'))).toBe(true);
  });

  it('allows the same relation name on two different entities', () => {
    const entities = [
      entity('Student', { relations: [relation()] }),
      entity('Teacher', { relations: [relation()] }),
      entity('Classroom'),
    ];
    expect(validateRelations(entities)).toEqual([]);
  });

  it('flags a target that stopped being an included entity', () => {
    // The realistic path: author the relation, then exclude or rename the target.
    const entities = [
      entity('Student', { relations: [relation({ target: 'Classroom' })] }),
      entity('Classroom', { generate: false }),
    ];
    expect(validateRelations(entities)[0]).toMatchObject({
      field: 'target',
      message: expect.stringContaining('no longer an included entity'),
    });
  });

  it('ignores relations on an entity that is itself excluded', () => {
    const entities = [
      entity('Student', { generate: false, relations: [relation({ target: 'Gone' })] }),
      entity('Classroom'),
    ];
    expect(validateRelations(entities)).toEqual([]);
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const entities = [
      entity('Student', {
        relations: [relation({ name: '', target: '' }), relation({ name: 'bad name!' })],
      }),
    ];
    expect(validateRelations(entities).length).toBeGreaterThanOrEqual(3);
  });
});

describe('relationsPointingAt', () => {
  it('lists what would dangle if an entity were excluded', () => {
    const entities = [
      entity('Student', { relations: [relation({ name: 'classroom', target: 'Classroom' })] }),
      entity('Teacher', { relations: [relation({ name: 'room', target: 'Classroom' })] }),
      entity('Classroom'),
    ];
    expect(relationsPointingAt(entities, 'Classroom')).toEqual([
      { entity: 'Student', relation: 'classroom' },
      { entity: 'Teacher', relation: 'room' },
    ]);
  });

  it('does not count an entity relating to itself', () => {
    const entities = [entity('Student', { relations: [relation({ target: 'Student' })] })];
    expect(relationsPointingAt(entities, 'Student')).toEqual([]);
  });

  it('names an unnamed relation legibly rather than as an empty string', () => {
    const entities = [
      entity('Student', { relations: [relation({ name: '', target: 'Classroom' })] }),
      entity('Classroom'),
    ];
    expect(relationsPointingAt(entities, 'Classroom')[0]?.relation).toBe('(unnamed)');
  });
});

describe('pruneForGeneration', () => {
  it('drops excluded and unnamed entities', () => {
    const entities = [entity('Student'), entity('Fee', { generate: false }), entity('   ')];
    expect(pruneForGeneration(entities).map((e) => e.name)).toEqual(['Student']);
  });

  it('drops a relation whose target was excluded, so the create can succeed', () => {
    // validateIPS rejects a relation pointing at an undeclared entity, so an
    // unpruned submit would fail the whole project over a deliberate omission.
    const entities = [
      entity('Student', { relations: [relation({ target: 'Classroom' })] }),
      entity('Classroom', { generate: false }),
    ];
    const pruned = pruneForGeneration(entities);
    expect(pruned).toHaveLength(1);
    expect(pruned[0]?.relations).toEqual([]);
  });

  it('keeps a relation whose target survives', () => {
    expect(pruneForGeneration(model())[0]?.relations).toHaveLength(1);
  });

  it('drops an unnamed relation rather than sending a nameless one', () => {
    const entities = [
      entity('Student', { relations: [relation({ name: '  ' })] }),
      entity('Classroom'),
    ];
    expect(pruneForGeneration(entities)[0]?.relations).toEqual([]);
  });

  it('does not mutate the entities it was given', () => {
    const entities = model();
    const before = JSON.parse(JSON.stringify(entities));
    pruneForGeneration(entities);
    expect(entities).toEqual(before);
  });
});

describe('builderRelationToIPS', () => {
  it('sends a sparse relation and lets the server derive the field names', () => {
    // Guessing localField/foreignField here would disagree with
    // `completeRelation` whenever two entities use different identity fields.
    expect(builderRelationToIPS(relation({ name: ' classroom ', required: true }))).toEqual({
      name: 'classroom',
      kind: 'belongsTo',
      target: 'Classroom',
      required: true,
      onDelete: 'restrict',
    });
  });
});
