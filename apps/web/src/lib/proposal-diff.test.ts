import { describe, expect, it } from 'vitest';
import { newEntity, newField, newRelation } from './builder';
import { diffEntities, mergeEntities } from './proposal-diff';

function entity(name: string, fields: string[], relationTarget?: string) {
  const e = newEntity(name);
  e.fields = fields.map((f) => newField(f));
  if (relationTarget)
    e.relations = [
      {
        ...newRelation(),
        name: relationTarget.toLowerCase(),
        kind: 'belongsTo',
        target: relationTarget,
      },
    ];
  return e;
}

describe('diffEntities', () => {
  it('classifies added, removed, changed and same (by case-insensitive name)', () => {
    const mine = [entity('Member', ['name']), entity('Plan', ['price']), entity('Old', ['x'])];
    const next = [
      entity('member', ['name']),
      entity('Plan', ['price', 'period']),
      entity('Trainer', ['name']),
    ];
    const changes = diffEntities(mine, next);
    expect(changes.map((c) => [c.name, c.kind])).toEqual([
      ['Member', 'same'],
      ['Plan', 'changed'],
      ['Old', 'removed'],
      ['Trainer', 'added'],
    ]);
    expect(changes[1]!.fieldChanges).toEqual([{ name: 'period', change: 'added' }]);
  });

  it('reports type, required and enum changes, and relation changes', () => {
    const mine = entity('Plan', ['price']);
    const next = entity('Plan', ['price'], 'Member');
    next.fields[0] = { ...next.fields[0]!, type: 'decimal', required: false };
    const [change] = diffEntities([mine], [next]);
    expect(change!.fieldChanges).toEqual([
      { name: 'price', change: 'type' },
      { name: 'price', change: 'required' },
    ]);
    expect(change!.relationChanges).toEqual(['+member → Member']);
  });
});

describe('mergeEntities', () => {
  const mine = [entity('Member', ['name']), entity('Plan', ['price']), entity('Old', ['x'])];
  const next = [
    entity('Member', ['name']),
    entity('Plan', ['price', 'period']),
    entity('Trainer', ['name']),
  ];

  it('changes nothing with default choices', () => {
    const merged = mergeEntities(diffEntities(mine, next), {});
    expect(merged).toEqual(mine);
  });

  it('applies each choice', () => {
    const merged = mergeEntities(diffEntities(mine, next), {
      plan: 'new',
      old: 'new',
      trainer: 'new',
    });
    expect(merged.map((e) => e.name)).toEqual(['Member', 'Plan', 'Trainer']);
    expect(merged[1]!.fields.map((f) => f.name)).toEqual(['price', 'period']);
  });
});
