import { describe, expect, it } from 'vitest';
import { newField, newRelation, type BuilderEntity } from './builder';
import { aiEditChanges, applyAiEdit, defaultEditChoices } from './ai-edit';

/** An entity as the project's editor holds it: every node carries its stable id. */
function stored(name: string, fields: string[], relations: [string, string][] = []): BuilderEntity {
  return {
    id: `ui-${name}`,
    schemaId: `ent_${name}`,
    name,
    fields: fields.map((field) => ({ ...newField(field), schemaId: `fld_${name}_${field}` })),
    relations: relations.map(([relation, target]) => ({
      ...newRelation(),
      schemaId: `rel_${name}_${relation}`,
      name: relation,
      target,
    })),
    identityStyle: 'int',
    generate: true,
  };
}

/** An entity as the model returns it: IPS shape, uuid identity, no stable ids. */
function proposed(
  name: string,
  fields: string[],
  relations: [string, string][] = [],
): Record<string, unknown> {
  return {
    name,
    fields: [
      { name: 'id', type: 'uuid', required: true, meta: { identity: true } },
      ...fields.map((field) => ({ name: field, type: 'string', required: true, meta: {} })),
    ],
    relations: relations.map(([relation, target]) => ({
      name: relation,
      kind: 'belongsTo',
      target,
    })),
  };
}

const mine = () => [stored('Tour', ['title', 'price']), stored('Guide', ['name'])];

describe('aiEditChanges', () => {
  it('reports what the model added, changed and dropped', () => {
    const changes = aiEditChanges(
      mine(),
      [proposed('Tour', ['title', 'price', 'rating']), proposed('Review', ['comment'])],
      { relations: true },
    );
    expect(changes.map((change) => [change.name, change.kind])).toEqual([
      ['Tour', 'changed'],
      ['Guide', 'removed'],
      ['Review', 'added'],
    ]);
  });

  it("keeps the project's stable ids on everything the model kept", () => {
    // Without them, the version history would show an untouched entity as
    // deleted and recreated.
    const changes = aiEditChanges(
      [stored('Booking', ['seats'], [['tour', 'Tour']]), stored('Tour', ['title'])],
      [proposed('Booking', ['seats', 'notes'], [['tour', 'Tour']]), proposed('Tour', ['title'])],
      { relations: true },
    );
    const booking = changes.find((change) => change.name === 'Booking')!.next!;
    expect(booking.schemaId).toBe('ent_Booking');
    expect(booking.fields.find((field) => field.name === 'seats')?.schemaId).toBe(
      'fld_Booking_seats',
    );
    expect(booking.fields.find((field) => field.name === 'notes')?.schemaId).toBeUndefined();
    expect(booking.relations[0]?.schemaId).toBe('rel_Booking_tour');
  });

  it("keeps an existing entity's identity style, and gives new ones the project's", () => {
    // The model is told to use uuid identities; switching a live project's ids
    // from integers to uuids would change every URL it serves.
    const changes = aiEditChanges(mine(), [proposed('Tour', ['title']), proposed('Review', [])], {
      relations: true,
    });
    for (const change of changes.filter((entry) => entry.next)) {
      expect(change.next!.identityStyle).toBe('int');
    }
  });

  it('leaves relations out of a Single API project', () => {
    const changes = aiEditChanges(
      [stored('Tour', ['title'])],
      [proposed('Tour', ['title'], [['guide', 'Guide']])],
      { relations: false },
    );
    expect(changes[0]!.kind).toBe('same');
  });
});

describe('defaultEditChoices and applyAiEdit', () => {
  it("takes the model's additions and changes but keeps what it dropped", () => {
    const changes = aiEditChanges(
      mine(),
      [proposed('Tour', ['title', 'price', 'rating']), proposed('Review', ['comment'])],
      { relations: true },
    );
    const choices = defaultEditChoices(changes);
    expect(choices).toEqual({ tour: 'new', guide: 'mine', review: 'new' });

    const applied = applyAiEdit(changes, choices);
    expect(applied.map((entity) => entity.name)).toEqual(['Tour', 'Guide', 'Review']);
    expect(applied[0]!.fields.map((field) => field.name)).toEqual(['title', 'price', 'rating']);
  });

  it('removes a dropped entity only when the user chooses to', () => {
    const changes = aiEditChanges(mine(), [proposed('Tour', ['title', 'price'])], {
      relations: true,
    });
    const applied = applyAiEdit(changes, { ...defaultEditChoices(changes), guide: 'new' });
    expect(applied.map((entity) => entity.name)).toEqual(['Tour']);
  });

  it('changes nothing when every choice is "mine"', () => {
    const before = mine();
    const changes = aiEditChanges(before, [proposed('Review', [])], { relations: true });
    const applied = applyAiEdit(changes, { tour: 'mine', guide: 'mine', review: 'mine' });
    expect(applied).toEqual(before);
  });
});
