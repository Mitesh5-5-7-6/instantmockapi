/**
 * Layout for the entity-relationship diagram.
 *
 * Pure geometry: entities in, coordinates out. Kept apart from the SVG so the
 * arrangement can be asserted without rendering, and so the renderer contains no
 * decisions.
 *
 * The picture is the conventional database one: each entity is a table card —
 * primary key, foreign keys, then fields — and each relationship is one
 * orthogonal line from the foreign-key row to the primary-key row it points at.
 * Cards flow left to right in columns by distance from the most-connected
 * entity, so every line spans at most one gap and gets its own lane in it.
 *
 * **Determinism is the whole point.** Layout runs on every keystroke, so any
 * dependence on input order would make cards jump while someone is typing.
 * Every ordering below is by name or by computed position, never by discovery
 * order.
 */

import type { BuilderEntity, BuilderField, BuilderRelation } from './builder';
import { cardinalityOf, isOwningKind, previewKeyField } from './relations';

/** Plain fields shown per card before the rest collapse into "+N more". */
export const MAX_CARD_FIELDS = 8;

export const HEADER_HEIGHT = 34;
export const ROW_HEIGHT = 24;
/** Height of the "+N more" line under a capped card. */
export const MORE_HEIGHT = 22;
const CARD_PADDING_BOTTOM = 6;
const MIN_CARD_WIDTH = 184;
const MAX_CARD_WIDTH = 320;
/** Rough glyph widths for the UI font (names) and the mono font (types). */
const NAME_CHAR = 7;
const TYPE_CHAR = 6.6;
const HEADER_CHAR = 7.8;
/** Key badge column plus horizontal padding and the gap before the type. */
const ROW_CHROME = 12 + 26 + 20 + 12;

const PADDING = 20;
const COLUMN_GAP = 112;
const CARD_GAP_Y = 32;
const COMPONENT_GAP = 56;
/** Room for an end symbol before a line may turn. */
const STUB = 28;
const LANE_SPACING = 12;

export type ErKey = 'pk' | 'fk' | null;

export interface ErRow {
  name: string;
  type: string;
  key: ErKey;
}

export interface ErCard {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Distance from its component's most-connected entity. */
  column: number;
  /** True when nothing relates to it, so the diagram can say so. */
  isolated: boolean;
  rows: ErRow[];
  /** Vertical centre of each row, parallel to `rows`, for line anchors. */
  rowY: number[];
  /** Plain fields left off the card by `MAX_CARD_FIELDS`. */
  hiddenFields: number;
}

export interface ErEdge {
  id: string;
  label: string;
  cardinality: string;
  kind: BuilderRelation['kind'];
  source: string;
  target: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** x of the vertical run; the path is from → laneX → to, all right angles. */
  laneX: number;
}

export interface ErLayout {
  cards: ErCard[];
  edges: ErEdge[];
  width: number;
  height: number;
}

const byName = (a: string, b: string): number => a.localeCompare(b);

function identityType(entity: BuilderEntity): string {
  return entity.identityStyle === 'uuid' ? 'uuid' : 'integer';
}

function fieldType(field: BuilderField): string {
  if (field.type === 'array') {
    const item = field.children[0];
    return item ? `${item.type}[]` : 'array';
  }
  return field.type;
}

interface Link {
  key: string;
  relation: BuilderRelation;
  source: BuilderEntity;
  target: BuilderEntity;
  /** Row index the line leaves from on the source, or -1 for the header. */
  fromRow: number;
  /** Row index the line arrives at on the target, or -1 for the header. */
  toRow: number;
}

/** The relationships worth a line: one per relationship, not one per side. */
function collectLinks(entities: Map<string, BuilderEntity>, rows: Map<string, ErRow[]>): Link[] {
  const links: Link[] = [];
  const owningBack = (from: BuilderEntity, to: string, kind?: BuilderRelation['kind']) =>
    from.relations.some(
      (relation) =>
        relation.target === to &&
        isOwningKind(relation.kind) &&
        (kind === undefined || relation.kind === kind),
    );

  for (const source of [...entities.values()].sort((a, b) => byName(a.name, b.name))) {
    const relations = [...source.relations].sort(
      (a, b) => byName(a.name, b.name) || byName(a.kind, b.kind),
    );
    for (const relation of relations) {
      const target = entities.get(relation.target);
      if (!target) {
        continue;
      }
      const sourceRows = rows.get(source.name) ?? [];
      if (isOwningKind(relation.kind)) {
        // A many-to-many declared on both sides is one relationship; the
        // alphabetically first side draws it.
        if (
          relation.kind === 'manyToMany' &&
          target !== source &&
          owningBack(target, source.name, 'manyToMany') &&
          byName(target.name, source.name) < 0
        ) {
          continue;
        }
        const keyName = previewKeyField(relation);
        links.push({
          key: `${source.name}.${relation.name}.${relation.kind}.${target.name}`,
          relation,
          source,
          target,
          fromRow: sourceRows.findIndex((row) => row.key === 'fk' && row.name === keyName),
          toRow: 0,
        });
      } else {
        // The inverse of an owning relation is already drawn from the key side.
        if (owningBack(target, source.name)) {
          continue;
        }
        links.push({
          key: `${source.name}.${relation.name}.${relation.kind}.${target.name}`,
          relation,
          source,
          target,
          fromRow: 0,
          toRow: -1,
        });
      }
    }
  }
  return links;
}

/** PK, then the keys owning relations add, then fields up to the cap. */
function cardRows(
  entity: BuilderEntity,
  entities: Map<string, BuilderEntity>,
): { rows: ErRow[]; hidden: number } {
  const rows: ErRow[] = [{ name: 'id', type: identityType(entity), key: 'pk' }];
  const keyNames = new Set<string>(['id']);

  const owning = entity.relations
    .filter((relation) => isOwningKind(relation.kind) && entities.has(relation.target))
    .sort((a, b) => byName(a.target, b.target) || byName(a.name, b.name));
  for (const relation of owning) {
    const name = previewKeyField(relation);
    if (!name || keyNames.has(name)) {
      continue;
    }
    keyNames.add(name);
    const base = identityType(entities.get(relation.target) as BuilderEntity);
    rows.push({ name, type: relation.kind === 'manyToMany' ? `${base}[]` : base, key: 'fk' });
  }

  const plain = entity.fields.filter((field) => field.name.trim() && !keyNames.has(field.name));
  for (const field of plain.slice(0, MAX_CARD_FIELDS)) {
    rows.push({ name: field.name, type: fieldType(field), key: null });
  }
  return { rows, hidden: Math.max(0, plain.length - MAX_CARD_FIELDS) };
}

function cardWidth(name: string, rows: ErRow[]): number {
  const header = name.length * HEADER_CHAR + 32;
  const widest = Math.max(
    ...rows.map((row) => row.name.length * NAME_CHAR + row.type.length * TYPE_CHAR + ROW_CHROME),
  );
  return Math.round(Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, header, widest)));
}

type Routed = Pick<ErEdge, 'from' | 'to' | 'laneX'>;

/** Places where one line's vertical run cuts another line's horizontal runs. */
function crossingsAt(lines: Routed[]): number {
  const between = (value: number, a: number, b: number): boolean =>
    value > Math.min(a, b) && value < Math.max(a, b);
  let count = 0;
  for (const a of lines) {
    for (const b of lines) {
      if (a === b) {
        continue;
      }
      if (between(a.laneX, b.from.x, b.laneX) && between(b.from.y, a.from.y, a.to.y)) {
        count += 1;
      }
      if (between(a.laneX, b.laneX, b.to.x) && between(b.to.y, a.from.y, a.to.y)) {
        count += 1;
      }
    }
  }
  return count;
}

/** Undirected adjacency, self-relations excluded (they do not connect anything). */
function adjacency(entities: Map<string, BuilderEntity>): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const name of entities.keys()) {
    graph.set(name, new Set());
  }
  for (const entity of entities.values()) {
    for (const relation of entity.relations) {
      if (entities.has(relation.target) && relation.target !== entity.name) {
        graph.get(entity.name)?.add(relation.target);
        graph.get(relation.target)?.add(entity.name);
      }
    }
  }
  return graph;
}

/**
 * Split into connected components, each as columns of names.
 *
 * Each component starts from its most-connected entity (ties alphabetical) and
 * spreads breadth-first, so a relation always joins the same or adjacent
 * columns. Within a column, cards sit beside the neighbours they connect to in
 * the previous column, which keeps lines from crossing.
 */
function components(graph: Map<string, Set<string>>): string[][][] {
  const remaining = new Set([...graph.keys()].filter((name) => (graph.get(name)?.size ?? 0) > 0));
  const result: string[][][] = [];

  while (remaining.size > 0) {
    const root = [...remaining].sort(
      (a, b) => (graph.get(b)?.size ?? 0) - (graph.get(a)?.size ?? 0) || byName(a, b),
    )[0] as string;
    remaining.delete(root);
    const columns: string[][] = [[root]];

    for (;;) {
      const previous = columns[columns.length - 1] as string[];
      const next = new Set<string>();
      for (const name of previous) {
        for (const neighbour of graph.get(name) ?? []) {
          if (remaining.has(neighbour)) {
            next.add(neighbour);
          }
        }
      }
      if (next.size === 0) {
        break;
      }
      for (const name of next) {
        remaining.delete(name);
      }
      const centre = (name: string): number => {
        const positions = previous
          .map((candidate, index) => (graph.get(name)?.has(candidate) ? index : -1))
          .filter((index) => index >= 0);
        return positions.reduce((sum, index) => sum + index, 0) / positions.length;
      };
      columns.push([...next].sort((a, b) => centre(a) - centre(b) || byName(a, b)));
    }
    result.push(columns);
  }
  return result;
}

/**
 * Arrange entities as table cards and route one line per relationship.
 *
 * Only named, generated entities appear: an entity being typed has no identity
 * to draw, and an excluded one is not part of the model being generated.
 */
export function layoutEr(entities: BuilderEntity[]): ErLayout {
  const included = new Map<string, BuilderEntity>();
  for (const entity of entities) {
    const name = entity.name.trim();
    // A duplicate name is a validation error elsewhere; the first one wins here.
    if (entity.generate && name && !included.has(name)) {
      included.set(name, {
        ...entity,
        name,
        relations: entity.relations.map((relation) => ({
          ...relation,
          target: relation.target.trim(),
        })),
      });
    }
  }
  if (included.size === 0) {
    return { cards: [], edges: [], width: 0, height: 0 };
  }

  const rowsByName = new Map<string, ErRow[]>();
  const hiddenByName = new Map<string, number>();
  for (const entity of included.values()) {
    const { rows, hidden } = cardRows(entity, included);
    rowsByName.set(entity.name, rows);
    hiddenByName.set(entity.name, hidden);
  }
  const heightOf = (name: string): number =>
    HEADER_HEIGHT +
    (rowsByName.get(name)?.length ?? 0) * ROW_HEIGHT +
    ((hiddenByName.get(name) ?? 0) > 0 ? MORE_HEIGHT : 0) +
    CARD_PADDING_BOTTOM;
  const widthOf = (name: string): number => cardWidth(name, rowsByName.get(name) ?? []);

  const graph = adjacency(included);
  const links = collectLinks(included, rowsByName);
  const columnOf = new Map<string, number>();
  const componentOf = new Map<string, number>();
  const groups = components(graph);
  groups.forEach((columns, component) =>
    columns.forEach((names, column) =>
      names.forEach((name) => {
        columnOf.set(name, column);
        componentOf.set(name, component);
      }),
    ),
  );
  // A self-relation on an otherwise unconnected entity still needs a loop, so
  // it is laid out as a component of its own rather than as isolated.
  for (const link of links) {
    if (link.source === link.target && !columnOf.has(link.source.name)) {
      columnOf.set(link.source.name, 0);
      componentOf.set(link.source.name, groups.length);
      groups.push([[link.source.name]]);
    }
  }

  /** The gap a link runs in: right of the leftmost column it touches. */
  const gapOf = (link: Link): number =>
    Math.min(columnOf.get(link.source.name) ?? 0, columnOf.get(link.target.name) ?? 0);
  const lanesIn = new Map<string, Link[]>();
  for (const link of links) {
    const slot = `${componentOf.get(link.source.name)}:${gapOf(link)}`;
    lanesIn.set(slot, [...(lanesIn.get(slot) ?? []), link]);
  }
  const lastColumn = (component: number): number => (groups[component]?.length ?? 1) - 1;
  const gapWidth = (component: number, gap: number): number => {
    const span = Math.max(0, (lanesIn.get(`${component}:${gap}`)?.length ?? 0) - 1) * LANE_SPACING;
    // Right of the last column only loops run, so it needs just their lanes.
    return gap === lastColumn(component) ? STUB * 2 + span : Math.max(COLUMN_GAP, STUB * 2 + span);
  };

  const cards = new Map<string, ErCard>();
  let top = PADDING;
  let right = 0;
  groups.forEach((columns, component) => {
    const columnHeight = (names: string[]): number =>
      names.reduce((sum, name) => sum + heightOf(name), 0) + (names.length - 1) * CARD_GAP_Y;
    const height = Math.max(...columns.map(columnHeight));
    let x = PADDING;
    columns.forEach((names, column) => {
      const width = Math.max(...names.map(widthOf));
      let y = top + (height - columnHeight(names)) / 2;
      for (const name of names) {
        const entity = included.get(name) as BuilderEntity;
        const rows = rowsByName.get(name) ?? [];
        cards.set(name, {
          id: entity.id,
          name,
          // Narrower cards align on the column's left edge, keeping lane maths simple.
          x,
          y,
          width: widthOf(name),
          height: heightOf(name),
          column,
          isolated: false,
          rows,
          rowY: rows.map((_, index) => y + HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2),
          hiddenFields: hiddenByName.get(name) ?? 0,
        });
        y += heightOf(name) + CARD_GAP_Y;
      }
      x += width;
      // The trailing gap only exists when loops need it.
      const trailing = column < columns.length - 1 || lanesIn.has(`${component}:${column}`);
      if (trailing) {
        x += gapWidth(component, column);
      }
    });
    right = Math.max(right, x);
    top += height + COMPONENT_GAP;
  });

  // Entities nothing relates to wrap along the bottom, out of the lines' way.
  const isolated = [...included.keys()].filter((name) => !columnOf.has(name)).sort(byName);
  if (isolated.length > 0) {
    const limit = Math.max(right, PADDING + 3 * (MIN_CARD_WIDTH + CARD_GAP_Y));
    let x = PADDING;
    let rowHeight = 0;
    for (const name of isolated) {
      const width = widthOf(name);
      if (x > PADDING && x + width > limit) {
        x = PADDING;
        top += rowHeight + CARD_GAP_Y;
        rowHeight = 0;
      }
      const entity = included.get(name) as BuilderEntity;
      const rows = rowsByName.get(name) ?? [];
      const y = top;
      cards.set(name, {
        id: entity.id,
        name,
        x,
        y,
        width,
        height: heightOf(name),
        column: 0,
        isolated: true,
        rows,
        rowY: rows.map((_, index) => y + HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2),
        hiddenFields: hiddenByName.get(name) ?? 0,
      });
      x += width + CARD_GAP_Y;
      rowHeight = Math.max(rowHeight, heightOf(name));
      right = Math.max(right, x - CARD_GAP_Y);
    }
    top += rowHeight + COMPONENT_GAP;
  }

  const anchorY = (card: ErCard, row: number): number =>
    row >= 0 && row < card.rowY.length ? (card.rowY[row] as number) : card.y + HEADER_HEIGHT / 2;

  const edges: ErEdge[] = [];
  for (const [slot, members] of lanesIn) {
    const [component, gap] = slot.split(':').map(Number) as [number, number];
    const columnRight = Math.max(
      ...[...cards.values()]
        .filter((card) => !card.isolated && componentOf.get(card.name) === component)
        .filter((card) => card.column === gap)
        .map((card) => card.x + card.width),
    );
    const placed = members.map((link) => {
      const source = cards.get(link.source.name) as ErCard;
      const target = cards.get(link.target.name) as ErCard;
      const fromY = anchorY(source, link.fromRow);
      const toY = anchorY(target, link.toRow);
      const sideX = (card: ErCard, facingRight: boolean) =>
        facingRight ? card.x + card.width : card.x;
      const sameColumn = source.column === target.column;
      return {
        link,
        from: { x: sideX(source, sameColumn || source.column < target.column), y: fromY },
        to: { x: sideX(target, sameColumn || target.column < source.column), y: toY },
      };
    });
    const width = gapWidth(component, gap);
    const span = (placed.length - 1) * LANE_SPACING;
    const first =
      gap === lastColumn(component)
        ? columnRight + STUB
        : columnRight + Math.max(STUB, (width - span) / 2);
    // Start from height order, then swap neighbouring lanes while that removes
    // crossings. Lines only meet inside their own gap, so this is the whole
    // problem, and gaps rarely hold more than a handful of lines.
    placed.sort(
      (a, b) => (a.from.y + a.to.y) / 2 - (b.from.y + b.to.y) / 2 || byName(a.link.key, b.link.key),
    );
    const cost = () =>
      crossingsAt(
        placed.map((entry, index) => ({ ...entry, laneX: first + index * LANE_SPACING })),
      );
    let best = cost();
    for (let improved = true; improved && best > 0;) {
      improved = false;
      for (let index = 0; index < placed.length - 1; index += 1) {
        [placed[index], placed[index + 1]] = [placed[index + 1]!, placed[index]!];
        const next = cost();
        if (next < best) {
          best = next;
          improved = true;
        } else {
          [placed[index], placed[index + 1]] = [placed[index + 1]!, placed[index]!];
        }
      }
    }
    placed.forEach((entry, index) => {
      const laneX = first + index * LANE_SPACING;
      right = Math.max(right, laneX + STUB);
      edges.push({
        id: entry.link.relation.id,
        label: entry.link.relation.name,
        cardinality: cardinalityOf(entry.link.relation.kind),
        kind: entry.link.relation.kind,
        source: entry.link.source.name,
        target: entry.link.target.name,
        from: entry.from,
        to: entry.to,
        laneX,
      });
    });
  }

  return {
    cards: [...cards.values()].sort((a, b) => byName(a.name, b.name)),
    edges: edges.sort(
      (a, b) =>
        byName(a.source, b.source) || byName(a.label, b.label) || byName(a.target, b.target),
    ),
    width: Math.ceil(right + PADDING),
    height: Math.ceil(top - COMPONENT_GAP + PADDING),
  };
}
