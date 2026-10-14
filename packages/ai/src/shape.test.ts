import { describe, expect, it } from 'vitest';
import { newProjectGenerationConfig } from '@instantmockapi/ips';
import { toBuilderShape, validateShape } from './shape.js';

const defaults = newProjectGenerationConfig(25);
const id = {
  name: 'id',
  type: 'uuid',
  required: true,
  default: null,
  children: [],
  validation: {},
  meta: { identity: true },
};

function field(name: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    type,
    required: true,
    default: null,
    children: [],
    validation: {},
    meta: {},
    ...extra,
  };
}

describe('toBuilderShape', () => {
  it('keeps every one of the 13 IPS field types unchanged', () => {
    const fields = [
      id,
      field('s', 'string'),
      field('n', 'number'),
      field('d', 'decimal'),
      field('i', 'integer'),
      field('b', 'boolean'),
      field('at', 'date'),
      field('mail', 'email'),
      field('link', 'url'),
      field('ref', 'uuid'),
      field('pic', 'avatar'),
      field('state', 'enum', { validation: { enum: ['open', 'closed'] } }),
      field('box', 'object', { children: [field('inner', 'string')] }),
      field('list', 'array', { children: [field('item', 'string')] }),
    ];
    const shape = toBuilderShape(
      { entities: [{ name: 'Thing', fields, relations: [] }] },
      defaults,
    );
    expect(shape.entities[0]!.fields.map((f) => f.type)).toEqual(fields.map((f) => f.type));
    expect(validateShape(shape, 'project', 10)).toEqual([]);
  });

  it('keeps manyToMany and lets IPS complete relations without localField/foreignField', () => {
    const shape = toBuilderShape(
      {
        entities: [
          {
            name: 'Alpha',
            fields: [id],
            relations: [{ name: 'betas', kind: 'manyToMany', target: 'Beta' }],
          },
          { name: 'Beta', fields: [id], relations: [] },
          {
            name: 'Gamma',
            fields: [id],
            relations: [{ name: 'alpha', kind: 'belongsTo', target: 'Alpha', required: true }],
          },
        ],
      },
      defaults,
    );
    expect(shape.entities[0]!.relations![0]!.kind).toBe('manyToMany');
    expect(validateShape(shape, 'project', 10)).toEqual([]);
  });

  it('strips platform-owned and unknown properties', () => {
    const shape = toBuilderShape(
      {
        authentication: { mode: 'ALL_PROTECTED' },
        ownerId: 'x',
        entities: [
          {
            id: 'ent_123',
            authentication: { protected: true },
            name: 'Thing',
            description: '  a thing  ',
            fields: [
              {
                ...id,
                id: 'fld_1',
                meta: { identity: true, reference: true, readOnly: true, relation: 'X' },
              },
            ],
            relations: [],
          },
        ],
        generationConfig: {
          validators: ['joi'],
          types: ['python'],
          methods: ['GET', 'TRACE'],
          mockRecords: 50,
          unknownFields: 'allow',
        },
      },
      defaults,
    );
    const entity = shape.entities[0]! as unknown as Record<string, unknown>;
    expect(entity['id']).toBeUndefined();
    expect(entity['authentication']).toBeUndefined();
    expect(entity['description']).toBe('a thing');
    expect(shape.entities[0]!.fields[0]!.meta).toEqual({ identity: true });
    expect(
      (shape.entities[0]!.fields[0]! as unknown as Record<string, unknown>)['id'],
    ).toBeUndefined();
    expect(shape.generationConfig).toEqual({ ...defaults, methods: ['GET'], mockRecords: 50 });
    expect(Object.keys(shape)).toEqual(['entities', 'generationConfig']);
  });

  it('defaults required to true and default to null, and tolerates garbage', () => {
    const shape = toBuilderShape(
      { entities: [{ name: 'Thing', fields: [{ name: 'x', type: 'string' }, 'junk'] }] },
      defaults,
    );
    expect(shape.entities[0]!.fields[0]).toMatchObject({
      required: true,
      default: null,
      children: [],
      validation: {},
      meta: {},
    });
    expect(shape.entities[0]!.fields[1]!.name).toBe('');
    expect(toBuilderShape('nonsense', defaults)).toEqual({
      entities: [],
      generationConfig: defaults,
    });
  });
});

describe('validateShape', () => {
  it('returns IPS details for an invalid schema instead of throwing', () => {
    const shape = toBuilderShape(
      { entities: [{ name: 'Thing', fields: [id, field('x', 'notatype')] }] },
      defaults,
    );
    const details = validateShape(shape, 'project', 10);
    expect(details.length).toBeGreaterThan(0);
    expect(details.some((d) => d.path.includes('fields'))).toBe(true);
  });

  it('rejects non-ASCII identifiers so the repair loop can fix them', () => {
    const shape = toBuilderShape({ entities: [{ name: 'દર્દી', fields: [id] }] }, defaults);
    expect(validateShape(shape, 'project', 10).length).toBeGreaterThan(0);
  });

  it('rejects an empty entity list for project and single', () => {
    const shape = toBuilderShape({ entities: [] }, defaults);
    expect(validateShape(shape, 'project', 10).length).toBeGreaterThan(0);
    expect(validateShape(shape, 'single', 10).length).toBeGreaterThan(0);
  });
});
