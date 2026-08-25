/**
 * Layout for the entity-relationship diagram (Design Data Model step).
 *
 * Pure geometry: entities in, coordinates out. Kept apart from the SVG so the
 * arrangement can be asserted without rendering, and so the renderer contains no
 * decisions.
 *
 * **Determinism is the whole point.** Layout runs on every keystroke in the step,
 * so any dependence on object order, insertion order, or a hash would make boxes
 * jump while someone is typing. Every ordering below is by name or by an explicit
 * index, never by discovery order.
 */

import type { BuilderEntity } from './builder';
import { cardinalityOf } from './relations';

export const NODE_WIDTH = 132;
export const NODE_HEIGHT = 38;
const GAP_X = 28;
const GAP_Y = 70;
const PADDING = 16;

export interface ErNode {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** BFS depth from its component root — the row it sits on. */
  row: number;
  /** True when nothing relates to it, so the diagram can say so. */
  isolated: boolean;
}

export interface ErEdge {
  id: string;
  label: string;
  cardinality: string;
  kind: BuilderEntity['relations'][number]['kind'];
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** Elbow midpoint, so two edges between the same rows do not overlap. */
  via: { x: number; y: number };
  /** Both ends on one row — drawn as a side loop rather than a vertical. */
  sameRow: boolean;
}

export interface ErLayout {
  nodes: ErNode[];
  edges: ErEdge[];
  width: number;
  height: number;
}

/** Undirected adjacency over named, included entities. */
function adjacency(entities: BuilderEntity[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const entity of entities) {
    graph.set(entity.name, graph.get(entity.name) ?? new Set());
  }
  for (const entity of entities) {
    for (const relation of entity.relations) {
      if (!relation.target || !graph.has(relation.target) || relation.target === entity.name) {
        continue;
      }
      graph.get(entity.name)?.add(relation.target);
      graph.get(relation.target)?.add(entity.name);
    }
  }
  return graph;
}

/**
 * Assign each entity a row: breadth-first from the most-connected entity.
 *
 * Starting at the hub rather than at the first entity authored is what puts
 * `Student` in the middle of a student-ERP diagram instead of wherever it
 * happened to be typed. Ties break alphabetically so the choice is stable.
 */
function assignRows(names: string[], graph: Map<string, Set<string>>): Map<string, number> {
  const rows = new Map<string, number>();
  const remaining = new Set(names);

  while (remaining.size > 0) {
    const root = [...remaining].sort((a, b) => {
      const degree = (graph.get(b)?.size ?? 0) - (graph.get(a)?.size ?? 0);
      return degree !== 0 ? degree : a.localeCompare(b);
    })[0] as string;

    let frontier = [root];
    let depth = rows.size === 0 ? 0 : Math.max(...rows.values()) + 1;
    rows.set(root, depth);
    remaining.delete(root);

    while (frontier.length > 0) {
      depth += 1;
      const next: string[] = [];
      // Sorted so the row contents do not depend on Set iteration order.
      for (const name of [...frontier].sort((a, b) => a.localeCompare(b))) {
        for (const neighbour of [...(graph.get(name) ?? [])].sort((a, b) => a.localeCompare(b))) {
          if (remaining.has(neighbour)) {
            remaining.delete(neighbour);
            rows.set(neighbour, depth);
            next.push(neighbour);
          }
        }
      }
      frontier = next;
    }
  }
  return rows;
}

/**
 * Arrange entities and their relations on a grid.
 *
 * Only named, generated entities appear: an entity being typed has no identity
 * to draw, and an excluded one is not part of the model being generated.
 */
export function layoutEr(entities: BuilderEntity[]): ErLayout {
  const included = entities
    .filter((entity) => entity.generate && entity.name.trim())
    .map((entity) => ({ ...entity, name: entity.name.trim() }));

  // A duplicate name is a validation error elsewhere; here it would produce two
  // nodes with the same identity, so the first wins.
  const unique: typeof included = [];
  for (const entity of included) {
    if (!unique.some((seen) => seen.name === entity.name)) {
      unique.push(entity);
    }
  }

  if (unique.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  const graph = adjacency(unique);
  const rows = assignRows(
    unique.map((entity) => entity.name),
    graph,
  );

  const byRow = new Map<number, string[]>();
  for (const entity of unique) {
    const row = rows.get(entity.name) ?? 0;
    byRow.set(row, [...(byRow.get(row) ?? []), entity.name]);
  }
  for (const [row, names] of byRow) {
    byRow.set(
      row,
      [...names].sort((a, b) => a.localeCompare(b)),
    );
  }

  const widest = Math.max(...[...byRow.values()].map((names) => names.length));
  const canvasWidth = widest * NODE_WIDTH + (widest - 1) * GAP_X + PADDING * 2;

  const nodes: ErNode[] = [];
  for (const [row, names] of [...byRow.entries()].sort(([a], [b]) => a - b)) {
    // Rows are centred so a wide row and a narrow one share an axis.
    const rowWidth = names.length * NODE_WIDTH + (names.length - 1) * GAP_X;
    const startX = (canvasWidth - rowWidth) / 2;
    names.forEach((name, index) => {
      const entity = unique.find((candidate) => candidate.name === name);
      nodes.push({
        id: entity?.id ?? name,
        name,
        x: startX + index * (NODE_WIDTH + GAP_X),
        y: PADDING + row * (NODE_HEIGHT + GAP_Y),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        row,
        isolated: (graph.get(name)?.size ?? 0) === 0,
      });
    });
  }

  const nodeByName = new Map(nodes.map((node) => [node.name, node]));
  const edges: ErEdge[] = [];
  for (const entity of unique) {
    for (const relation of entity.relations) {
      const from = nodeByName.get(entity.name);
      const to = nodeByName.get(relation.target);
      // Unresolvable and self relations are skipped: both are flagged by
      // `validateRelations`, and neither has a meaningful line.
      if (!from || !to || from === to) {
        continue;
      }
      const sameRow = from.row === to.row;
      const start = sameRow
        ? { x: from.x + from.width, y: from.y + from.height / 2 }
        : { x: from.x + from.width / 2, y: from.y + (to.row > from.row ? from.height : 0) };
      const end = sameRow
        ? { x: to.x, y: to.y + to.height / 2 }
        : { x: to.x + to.width / 2, y: to.y + (to.row > from.row ? 0 : to.height) };
      edges.push({
        id: relation.id,
        label: relation.name,
        cardinality: cardinalityOf(relation.kind),
        kind: relation.kind,
        from: start,
        to: end,
        via: sameRow
          ? { x: (start.x + end.x) / 2, y: start.y - NODE_HEIGHT / 2 }
          : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
        sameRow,
      });
    }
  }

  const rowCount = byRow.size;
  return {
    nodes,
    edges,
    width: canvasWidth,
    height: PADDING * 2 + rowCount * NODE_HEIGHT + (rowCount - 1) * GAP_Y,
  };
}
