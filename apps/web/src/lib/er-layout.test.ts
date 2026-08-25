import { describe, it, expect } from 'vitest';
import { newEntity, newRelation, type BuilderEntity, type BuilderRelation } from './builder';
import { NODE_HEIGHT, NODE_WIDTH, layoutEr } from './er-layout';

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

const nameAt = (entities: BuilderEntity[], row: number): string[] =>
  layoutEr(entities)
    .nodes.filter((node) => node.row === row)
    .map((node) => node.name);

describe('layoutEr', () => {
  it('returns an empty canvas for an empty model', () => {
    expect(layoutEr([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it('draws only named, included entities', () => {
    const entities = [entity('Student'), entity('  '), { ...entity('Fee'), generate: false }];
    expect(layoutEr(entities).nodes.map((node) => node.name)).toEqual(['Student']);
  });

  it('roots the diagram at the most-connected entity', () => {
    // Student has two relations, so it anchors row 0 — regardless of where it
    // happens to sit in the authoring order.
    expect(nameAt(erp(), 0)).toEqual(['Student']);
    expect(nameAt(erp(), 1)).toEqual(['Classroom', 'Course']);
  });

  it('is stable under reordering of the input', () => {
    // Layout runs on every keystroke; if it depended on input order the boxes
    // would jump while someone types. One model in two orders, so the node ids
    // are identical and only the ordering differs.
    const model = erp();
    const forwards = layoutEr(model);
    const backwards = layoutEr([...model].reverse());
    expect(backwards.nodes).toEqual(forwards.nodes);
  });

  it('breaks a degree tie alphabetically, so the root is never arbitrary', () => {
    const entities = [entity('Zebra'), entity('Apple')];
    expect(nameAt(entities, 0)).toEqual(['Apple']);
  });

  it('orders each row alphabetically', () => {
    const entities = [
      entity('Hub', [rel('c', 'Charlie'), rel('a', 'Alpha'), rel('b', 'Bravo')]),
      entity('Alpha'),
      entity('Bravo'),
      entity('Charlie'),
    ];
    expect(nameAt(entities, 1)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('centres a narrow row against a wide one', () => {
    const entities = [
      entity('Hub', [rel('a', 'Alpha'), rel('b', 'Bravo'), rel('c', 'Charlie')]),
      entity('Alpha'),
      entity('Bravo'),
      entity('Charlie'),
    ];
    const layout = layoutEr(entities);
    const hub = layout.nodes.find((node) => node.name === 'Hub')!;
    expect(hub.x + hub.width / 2).toBeCloseTo(layout.width / 2, 5);
  });

  it('marks an entity nothing relates to', () => {
    const layout = layoutEr(erp().concat(entity('Orphan')));
    expect(layout.nodes.find((node) => node.name === 'Orphan')?.isolated).toBe(true);
    expect(layout.nodes.find((node) => node.name === 'Student')?.isolated).toBe(false);
  });

  it('places a disconnected component below the first, not on top of it', () => {
    const entities = [
      entity('Student', [rel('classroom', 'Classroom')]),
      entity('Classroom'),
      entity('Invoice', [rel('payment', 'Payment')]),
      entity('Payment'),
    ];
    const layout = layoutEr(entities);
    const rows = new Map(layout.nodes.map((node) => [node.name, node.row]));
    // The second component starts on a fresh row rather than colliding.
    expect(rows.get('Invoice')).toBeGreaterThan(rows.get('Classroom')!);
    const positions = layout.nodes.map((node) => `${node.x},${node.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('sizes the canvas to hold the widest row', () => {
    const layout = layoutEr(erp());
    const widest = 2;
    expect(layout.width).toBeGreaterThanOrEqual(widest * NODE_WIDTH);
    expect(layout.height).toBeGreaterThanOrEqual(2 * NODE_HEIGHT);
  });

  it('keeps every node inside the canvas', () => {
    const layout = layoutEr(erp());
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it('emits one edge per resolvable relation, carrying its cardinality', () => {
    const layout = layoutEr(erp());
    expect(layout.edges).toHaveLength(3);
    const m2m = layout.edges.find((edge) => edge.kind === 'manyToMany');
    expect(m2m?.cardinality).toBe('M : M');
    expect(m2m?.label).toBe('courses');
  });

  it('skips an edge to a target that is not on the diagram', () => {
    // Flagged by validateRelations; here there is simply no line to draw.
    const entities = [entity('Student', [rel('ghost', 'Nowhere')])];
    expect(layoutEr(entities).edges).toEqual([]);
  });

  it('skips a self-relation rather than drawing a degenerate line', () => {
    const entities = [entity('Employee', [rel('manager', 'Employee')])];
    expect(layoutEr(entities).edges).toEqual([]);
    expect(layoutEr(entities).nodes).toHaveLength(1);
  });

  it('routes a sibling edge around the side instead of through the boxes', () => {
    // A direct relation always steps a BFS row, so two related entities only
    // share a row when they are siblings: Hub owns both, and they also relate to
    // each other. That sideways edge is the case the elbow exists for.
    const entities = [
      entity('Hub', [rel('alpha', 'Alpha'), rel('bravo', 'Bravo')]),
      entity('Alpha', [rel('bravo', 'Bravo', 'hasOne')]),
      entity('Bravo'),
    ];
    const layout = layoutEr(entities);
    const edge = layout.edges.find((candidate) => candidate.sameRow)!;
    expect(edge).toBeDefined();
    expect(edge.from.y).toBe(edge.to.y);
    // The elbow lifts clear of the row instead of cutting through the boxes.
    expect(edge.via.y).toBeLessThan(edge.from.y);
  });

  it('anchors a downward edge from the bottom of the source to the top of the target', () => {
    const layout = layoutEr(erp());
    const student = layout.nodes.find((node) => node.name === 'Student')!;
    const edge = layout.edges.find((candidate) => candidate.label === 'classroom')!;
    expect(edge.sameRow).toBe(false);
    expect(edge.from.y).toBe(student.y + student.height);
  });

  it('keeps one node when a name is duplicated', () => {
    // Duplicate names are a validation error elsewhere; the diagram must not
    // render two boxes claiming the same identity.
    const entities = [entity('Student'), entity('Student')];
    expect(layoutEr(entities).nodes).toHaveLength(1);
  });

  it('ignores surrounding whitespace in an entity name', () => {
    const entities = [entity('  Student  ', [rel('classroom', 'Classroom')]), entity('Classroom')];
    const layout = layoutEr(entities);
    expect(layout.nodes.map((node) => node.name)).toContain('Student');
    expect(layout.edges).toHaveLength(1);
  });
});
