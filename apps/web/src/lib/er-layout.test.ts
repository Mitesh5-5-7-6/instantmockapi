import { describe, it, expect } from 'vitest';
import {
  newEntity,
  newField,
  newRelation,
  type BuilderEntity,
  type BuilderRelation,
} from './builder';
import { MAX_CARD_FIELDS, layoutEr, type ErCard, type ErEdge, type ErLayout } from './er-layout';

function rel(
  name: string,
  target: string,
  kind: BuilderRelation['kind'] = 'belongsTo',
): BuilderRelation {
  return { ...newRelation(), name, target, kind };
}

function entity(name: string, relations: BuilderRelation[] = []): BuilderEntity {
  return { ...newEntity(name), relations };
}

/** Student ERP in miniature: Classroom 1──M Student M──M Course. */
const erp = (): BuilderEntity[] => [
  entity('Student', [rel('classroom', 'Classroom'), rel('courses', 'Course', 'manyToMany')]),
  entity('Classroom', [rel('students', 'Student', 'hasMany')]),
  entity('Course'),
];

const card = (layout: ErLayout, name: string): ErCard =>
  layout.cards.find((candidate) => candidate.name === name)!;

const namesInColumn = (entities: BuilderEntity[], column: number): string[] =>
  layoutEr(entities)
    .cards.filter((candidate) => candidate.column === column)
    .map((candidate) => candidate.name);

/** Points where one line's vertical run cuts another line's horizontal runs. */
function crossings(edges: ErEdge[]): number {
  const between = (value: number, a: number, b: number) =>
    value > Math.min(a, b) && value < Math.max(a, b);
  let count = 0;
  for (const a of edges) {
    for (const b of edges) {
      if (a === b) continue;
      for (const [y, x1, x2] of [
        [b.from.y, b.from.x, b.laneX],
        [b.to.y, b.laneX, b.to.x],
      ] as const) {
        if (between(a.laneX, x1, x2) && between(y, a.from.y, a.to.y)) count += 1;
      }
    }
  }
  return count;
}

function overlaps(a: ErCard, b: ErCard): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('layoutEr — cards', () => {
  it('returns an empty canvas for an empty model', () => {
    expect(layoutEr([])).toEqual({ cards: [], edges: [], width: 0, height: 0 });
  });

  it('draws only named, included entities', () => {
    const entities = [entity('Student'), entity('  '), { ...entity('Fee'), generate: false }];
    expect(layoutEr(entities).cards.map((candidate) => candidate.name)).toEqual(['Student']);
  });

  it('lists the primary key first, typed by the identity style', () => {
    const uuid = { ...entity('Tour'), identityStyle: 'uuid' as const };
    const rows = card(layoutEr([uuid]), 'Tour').rows;
    expect(rows[0]).toMatchObject({ name: 'id', type: 'uuid', key: 'pk' });
    expect(card(layoutEr([entity('Tour')]), 'Tour').rows[0]).toMatchObject({ type: 'integer' });
  });

  it('shows each field with its type', () => {
    const tour = entity('Tour');
    tour.fields = [
      { ...newField('title'), type: 'string' },
      { ...newField('price'), type: 'decimal' },
    ];
    const rows = card(layoutEr([tour]), 'Tour').rows;
    expect(rows.slice(1)).toEqual([
      expect.objectContaining({ name: 'title', type: 'string', key: null }),
      expect.objectContaining({ name: 'price', type: 'decimal', key: null }),
    ]);
  });

  it('adds the foreign key an owning relation creates, marked as one', () => {
    // The key is derived server-side, but it is the column the line attaches to,
    // so the card has to show it.
    const layout = layoutEr(erp());
    const rows = card(layout, 'Student').rows;
    expect(rows).toContainEqual(
      expect.objectContaining({ name: 'classroomId', type: 'integer', key: 'fk' }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ name: 'courseIds', type: 'integer[]', key: 'fk' }),
    );
    // A non-owning side adds no column.
    expect(card(layout, 'Classroom').rows.filter((row) => row.key === 'fk')).toEqual([]);
  });

  it('does not repeat a key the author already declared as a field', () => {
    const student = entity('Student', [rel('classroom', 'Classroom')]);
    student.fields = [newField('id'), newField('classroomId'), newField('name')];
    const rows = card(layoutEr([student, entity('Classroom')]), 'Student').rows;
    expect(rows.filter((row) => row.name === 'id')).toHaveLength(1);
    expect(rows.filter((row) => row.name === 'classroomId')).toEqual([
      expect.objectContaining({ key: 'fk' }),
    ]);
  });

  it('caps a long card and says how many fields are hidden', () => {
    const wide = entity('Wide');
    wide.fields = Array.from({ length: MAX_CARD_FIELDS + 3 }, (_, index) =>
      newField(`field${index}`),
    );
    const layout = layoutEr([wide]);
    const plain = card(layout, 'Wide').rows.filter((row) => row.key === null);
    expect(plain).toHaveLength(MAX_CARD_FIELDS);
    expect(card(layout, 'Wide').hiddenFields).toBe(3);
  });

  it('never hides a key column, however long the card', () => {
    const wide = entity('Wide', [rel('owner', 'Owner')]);
    wide.fields = Array.from({ length: MAX_CARD_FIELDS + 5 }, (_, index) =>
      newField(`field${index}`),
    );
    const rows = card(layoutEr([wide, entity('Owner')]), 'Wide').rows;
    expect(rows.some((row) => row.name === 'ownerId')).toBe(true);
  });

  it('widens a card to fit its longest row', () => {
    const narrow = entity('A');
    const wide = entity('B');
    wide.fields = [newField('aVeryLongFieldNameThatNeedsRoom')];
    const layout = layoutEr([narrow, wide]);
    expect(card(layout, 'B').width).toBeGreaterThan(card(layout, 'A').width);
  });

  it('marks an entity nothing relates to', () => {
    const layout = layoutEr(erp().concat(entity('Orphan')));
    expect(card(layout, 'Orphan').isolated).toBe(true);
    expect(card(layout, 'Student').isolated).toBe(false);
  });

  it('keeps one card when a name is duplicated', () => {
    expect(layoutEr([entity('Student'), entity('Student')]).cards).toHaveLength(1);
  });

  it('ignores surrounding whitespace in an entity name', () => {
    const entities = [entity('  Student  ', [rel('classroom', 'Classroom')]), entity('Classroom')];
    const layout = layoutEr(entities);
    expect(layout.cards.map((candidate) => candidate.name)).toContain('Student');
    expect(layout.edges).toHaveLength(1);
  });
});

describe('layoutEr — arrangement', () => {
  it('puts the most-connected entity in the first column', () => {
    expect(namesInColumn(erp(), 0)).toEqual(['Student']);
    expect(namesInColumn(erp(), 1)).toEqual(['Classroom', 'Course']);
  });

  it('breaks a degree tie alphabetically, so the root is never arbitrary', () => {
    // One relation each, so neither is more connected.
    const entities = [entity('Zebra', [rel('apple', 'Apple')]), entity('Apple')];
    expect(namesInColumn(entities, 0)).toEqual(['Apple']);
    expect(namesInColumn(entities, 1)).toEqual(['Zebra']);
  });

  it('is stable under reordering of the input', () => {
    // Layout runs on every keystroke; if it depended on input order the cards
    // would jump while someone types.
    const model = erp();
    expect(layoutEr([...model].reverse())).toEqual(layoutEr(model));
  });

  it('never overlaps two cards, across components and isolated entities', () => {
    const entities = [
      entity('Student', [rel('classroom', 'Classroom'), rel('courses', 'Course', 'manyToMany')]),
      entity('Classroom'),
      entity('Course'),
      entity('Invoice', [rel('payment', 'Payment')]),
      entity('Payment'),
      entity('Orphan'),
      entity('Another'),
    ];
    const cards = layoutEr(entities).cards;
    for (const a of cards) {
      for (const b of cards) {
        if (a !== b) {
          expect(overlaps(a, b), `${a.name} overlaps ${b.name}`).toBe(false);
        }
      }
    }
  });

  it('keeps every card inside the canvas', () => {
    const layout = layoutEr(erp().concat(entity('Orphan')));
    for (const candidate of layout.cards) {
      expect(candidate.x).toBeGreaterThanOrEqual(0);
      expect(candidate.y).toBeGreaterThanOrEqual(0);
      expect(candidate.x + candidate.width).toBeLessThanOrEqual(layout.width);
      expect(candidate.y + candidate.height).toBeLessThanOrEqual(layout.height);
    }
  });
});

describe('layoutEr — relationship lines', () => {
  it('draws a relation declared on both sides once', () => {
    // Student.classroom and Classroom.students are one relationship; two lines
    // on the same path are what made the old labels print over each other.
    const layout = layoutEr(erp());
    expect(layout.edges).toHaveLength(2);
    const classroom = layout.edges.find((edge) => edge.label === 'classroom')!;
    expect(classroom).toMatchObject({ kind: 'belongsTo', cardinality: 'M : 1' });
    expect(layout.edges.find((edge) => edge.kind === 'manyToMany')?.cardinality).toBe('M : M');
  });

  it('draws a many-to-many declared on both sides once', () => {
    const entities = [
      entity('Student', [rel('courses', 'Course', 'manyToMany')]),
      entity('Course', [rel('students', 'Student', 'manyToMany')]),
    ];
    expect(layoutEr(entities).edges).toHaveLength(1);
  });

  it('still draws a relation declared only on its non-owning side', () => {
    const entities = [entity('Tour', [rel('bookings', 'Booking', 'hasMany')]), entity('Booking')];
    expect(layoutEr(entities).edges).toEqual([
      expect.objectContaining({ kind: 'hasMany', label: 'bookings' }),
    ]);
  });

  it('attaches the line to the foreign-key row and the primary-key row', () => {
    const layout = layoutEr(erp());
    const student = card(layout, 'Student');
    const classroom = card(layout, 'Classroom');
    const edge = layout.edges.find((candidate) => candidate.label === 'classroom')!;
    const fkRow = student.rows.findIndex((row) => row.name === 'classroomId');
    expect(edge.from.y).toBe(student.rowY[fkRow]);
    expect(edge.to.y).toBe(classroom.rowY[0]);
  });

  it('leaves a card on the side that faces the other card', () => {
    const layout = layoutEr(erp());
    const student = card(layout, 'Student');
    const classroom = card(layout, 'Classroom');
    const edge = layout.edges.find((candidate) => candidate.label === 'classroom')!;
    // Student is in column 0, Classroom in column 1.
    expect(edge.from.x).toBe(student.x + student.width);
    expect(edge.to.x).toBe(classroom.x);
  });

  it('gives lines that share a gap their own lane, so they never run together', () => {
    const layout = layoutEr(erp());
    const lanes = layout.edges.map((edge) => edge.laneX);
    expect(new Set(lanes).size).toBe(lanes.length);
  });

  it('orders lanes so lines sharing a gap do not cross', () => {
    // Tour's key rows run top to bottom destinationIds, guideId, while their
    // targets stack Booking, Destination, Guide. A lane order by midpoint alone
    // crossed guideId's line over destinationIds'.
    const entities = [
      entity('Tour', [
        rel('guide', 'Guide'),
        rel('bookings', 'Booking', 'hasMany'),
        rel('destinations', 'Destination', 'manyToMany'),
      ]),
      entity('Booking', [rel('tour', 'Tour'), rel('customer', 'Customer')]),
      entity('Customer', [rel('bookings', 'Booking', 'hasMany')]),
      entity('Destination'),
      entity('Guide', [rel('mentor', 'Guide')]),
    ];
    // A tall Tour card is what put the key rows level with the targets.
    entities[0]!.fields = Array.from({ length: 11 }, (_, index) => newField(`field${index}`));
    expect(crossings(layoutEr(entities).edges)).toBe(0);
  });

  it('routes a self-relation as a loop on the right of its card', () => {
    const entities = [entity('Employee', [rel('manager', 'Employee')])];
    const layout = layoutEr(entities);
    const employee = card(layout, 'Employee');
    expect(layout.edges).toHaveLength(1);
    const [edge] = layout.edges;
    expect(edge!.from.x).toBe(employee.x + employee.width);
    expect(edge!.to.x).toBe(employee.x + employee.width);
    expect(edge!.laneX).toBeGreaterThan(employee.x + employee.width);
    expect(layout.width).toBeGreaterThan(edge!.laneX);
  });

  it('skips a line to a target that is not on the diagram', () => {
    expect(layoutEr([entity('Student', [rel('ghost', 'Nowhere')])]).edges).toEqual([]);
  });
});
