import { describe, expect, it } from 'vitest';
import { editableBlueprint } from './edit.js';

const field = (name: string, meta: Record<string, unknown> = {}) => ({
  id: `fld_${name}`,
  name,
  type: 'string',
  required: true,
  meta,
});

describe('editableBlueprint', () => {
  it('drops foreign-key fields, which the platform derives from relations', () => {
    // `shape.ts` strips `meta.reference` from model output, so a key copied
    // back by the model would return as a plain field and clash with the one
    // the platform derives.
    const blueprint = editableBlueprint([
      {
        name: 'Booking',
        fields: [
          field('id', { identity: true }),
          field('seats'),
          field('tourId', { reference: true, readOnly: true }),
        ],
        relations: [{ id: 'rel_1', name: 'tour', kind: 'belongsTo', target: 'Tour' }],
      },
    ]);
    expect(blueprint).toEqual([
      {
        name: 'Booking',
        fields: [
          { name: 'id', type: 'string', required: true, meta: { identity: true } },
          { name: 'seats', type: 'string', required: true, meta: {} },
        ],
        relations: [{ name: 'tour', kind: 'belongsTo', target: 'Tour' }],
      },
    ]);
  });

  it('removes stable ids at every depth, so the model never echoes or invents them', () => {
    const blueprint = editableBlueprint([
      {
        id: 'ent_1',
        name: 'Tour',
        fields: [{ ...field('stops'), type: 'array', children: [field('city')] }],
        relations: [],
      },
    ]);
    expect(JSON.stringify(blueprint)).not.toMatch(/\b(ent|fld|rel)_/);
  });

  it('keeps entities that are not records out of the result', () => {
    expect(editableBlueprint([null, 'x', { name: 'Tour', fields: [], relations: [] }])).toEqual([
      { name: 'Tour', fields: [], relations: [] },
    ]);
  });
});
