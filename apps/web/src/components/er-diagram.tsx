'use client';

/**
 * Entity-relationship diagram: one table card per entity, one line per
 * relationship.
 *
 * All arrangement lives in `lib/er-layout`; this file only draws. Cardinality is
 * shown in crow's-foot notation — a bar for "one", a fork for "many" — at each
 * end of a line, so the picture and the legend teach the same thing.
 *
 * Markers are defined once and referenced per end, because a line's two ends
 * carry different symbols: `belongsTo` is many at the key side and one at the
 * referenced side, and drawing the same glyph on both would state the wrong
 * cardinality.
 */

import { useRef, useState } from 'react';
import {
  HEADER_HEIGHT,
  MORE_HEIGHT,
  ROW_HEIGHT,
  layoutEr,
  type ErCard,
  type ErEdge,
} from '../lib/er-layout';
import type { BuilderEntity } from '../lib/builder';

/** Which end of a relation is the "many" side. */
function ends(kind: ErEdge['kind']): { source: 'one' | 'many'; target: 'one' | 'many' } {
  switch (kind) {
    case 'belongsTo':
      return { source: 'many', target: 'one' };
    case 'hasMany':
      return { source: 'one', target: 'many' };
    case 'manyToMany':
      return { source: 'many', target: 'many' };
    default:
      return { source: 'one', target: 'one' };
  }
}

const KIND_WORDS: Record<ErEdge['kind'], string> = {
  belongsTo: 'belongs to',
  hasOne: 'has one',
  hasMany: 'has many',
  manyToMany: 'many to many',
};

/** Right angles only: out of the source, along its lane, into the target. */
function edgePath(edge: ErEdge): string {
  return `M ${edge.from.x} ${edge.from.y} H ${edge.laneX} V ${edge.to.y} H ${edge.to.x}`;
}

/** A header whose top corners match the card's radius and whose bottom is square. */
function headerPath(card: ErCard, radius: number): string {
  const { x, y, width } = card;
  const bottom = y + HEADER_HEIGHT;
  return [
    `M ${x} ${bottom}`,
    `V ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    `H ${x + width - radius}`,
    `Q ${x + width} ${y} ${x + width} ${y + radius}`,
    `V ${bottom}`,
    'Z',
  ].join(' ');
}

/** Cut text that would run past its column, keeping the start readable. */
function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
}

const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5];

function Card({ card }: { card: ErCard }) {
  const radius = 8;
  // Types are short and say the most per character, so each row's type keeps
  // its full length (up to a cap) and the name gets whatever width is left.
  const fitRow = (row: ErCard['rows'][number]) => {
    const type = clip(row.type, 14);
    const room = card.width - 38 - 12 - type.length * 6.6 - 10;
    return { name: clip(row.name, Math.max(4, Math.floor(room / 6.6))), type };
  };
  return (
    <g className={`ui-er__card${card.isolated ? ' ui-er__card--isolated' : ''}`}>
      <title>{`${card.name} — ${card.rows.length + card.hiddenFields} columns`}</title>
      <rect
        x={card.x}
        y={card.y}
        width={card.width}
        height={card.height}
        rx={radius}
        className="ui-er__card-body"
      />
      <path d={headerPath(card, radius)} className="ui-er__card-head" />
      <line
        x1={card.x}
        x2={card.x + card.width}
        y1={card.y + HEADER_HEIGHT}
        y2={card.y + HEADER_HEIGHT}
        className="ui-er__card-rule"
      />
      <text x={card.x + 12} y={card.y + HEADER_HEIGHT / 2 + 4.5} className="ui-er__card-title">
        {clip(card.name, Math.floor((card.width - 24) / 7.8))}
      </text>

      {card.rows.map((row, index) => {
        const centre = card.rowY[index] as number;
        const text = fitRow(row);
        return (
          <g key={`${row.key ?? 'col'}-${row.name}`}>
            {index > 0 && (
              <line
                x1={card.x + 8}
                x2={card.x + card.width - 8}
                y1={centre - ROW_HEIGHT / 2}
                y2={centre - ROW_HEIGHT / 2}
                className="ui-er__row-rule"
              />
            )}
            {row.key && (
              <text
                x={card.x + 12}
                y={centre + 3.5}
                className={`ui-er__badge ui-er__badge--${row.key}`}
              >
                {row.key.toUpperCase()}
              </text>
            )}
            <text
              x={card.x + 38}
              y={centre + 4}
              className={`ui-er__col-name${row.key ? ' ui-er__col-name--key' : ''}`}
            >
              {text.name}
            </text>
            <text
              x={card.x + card.width - 12}
              y={centre + 4}
              textAnchor="end"
              className="ui-er__col-type"
            >
              {text.type}
            </text>
          </g>
        );
      })}

      {card.hiddenFields > 0 && (
        <text
          x={card.x + 38}
          y={card.y + HEADER_HEIGHT + card.rows.length * ROW_HEIGHT + MORE_HEIGHT / 2 + 4}
          className="ui-er__more"
        >
          +{card.hiddenFields} more {card.hiddenFields === 1 ? 'field' : 'fields'}
        </text>
      )}
    </g>
  );
}

export function ErDiagram({ entities }: { entities: BuilderEntity[] }) {
  const layout = layoutEr(entities);
  const [zoom, setZoom] = useState(1);
  const frame = useRef<HTMLDivElement>(null);

  if (layout.cards.length === 0) {
    return <p className="ui-meta">Name an entity to see the data model here.</p>;
  }

  const step = (direction: 1 | -1) => {
    const index = ZOOM_STEPS.findIndex((candidate) => candidate >= zoom - 0.001);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction))];
    setZoom(next ?? 1);
  };
  const fit = () => {
    const available = (frame.current?.clientWidth ?? layout.width) - 2;
    setZoom(Math.max(ZOOM_STEPS[0] as number, Math.min(1, available / layout.width)));
  };

  return (
    <div className="ui-er">
      <div className="ui-er__toolbar" role="toolbar" aria-label="Diagram zoom">
        <span className="ui-meta">
          {layout.cards.length} {layout.cards.length === 1 ? 'entity' : 'entities'} ·{' '}
          {layout.edges.length} {layout.edges.length === 1 ? 'relationship' : 'relationships'}
        </span>
        <div className="ui-er__zoom">
          <button type="button" onClick={() => step(-1)} aria-label="Zoom out">
            −
          </button>
          <button type="button" onClick={() => setZoom(1)} aria-label="Reset zoom">
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" onClick={() => step(1)} aria-label="Zoom in">
            +
          </button>
          <button type="button" onClick={fit}>
            Fit
          </button>
        </div>
      </div>

      <div className="ui-er__canvas" ref={frame}>
        <svg
          width={layout.width * zoom}
          height={layout.height * zoom}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label={`Data model: ${layout.cards.map((card) => card.name).join(', ')}`}
          style={{ display: 'block' }}
        >
          <defs>
            {/* One marker per symbol, oriented to the path so the glyph at the
                start of a line and the one at its end both face their card. */}
            <marker
              id="er-one"
              viewBox="0 0 16 16"
              refX="15"
              refY="8"
              markerWidth="16"
              markerHeight="16"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <path d="M 10 2 L 10 14" className="ui-er__glyph" />
            </marker>
            <marker
              id="er-many"
              viewBox="0 0 16 16"
              refX="15"
              refY="8"
              markerWidth="16"
              markerHeight="16"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <path d="M 3 8 L 15 2 M 3 8 L 15 14 M 3 8 L 15 8" className="ui-er__glyph" />
            </marker>
          </defs>

          {layout.edges.map((edge) => {
            const { source, target } = ends(edge.kind);
            return (
              <g key={edge.id} className="ui-er__edge">
                <title>
                  {`${edge.source}.${edge.label} → ${edge.target} · ${KIND_WORDS[edge.kind]} (${edge.cardinality})`}
                </title>
                {/* A wide transparent twin makes the thin line easy to hover. */}
                <path d={edgePath(edge)} className="ui-er__edge-hit" />
                <path
                  d={edgePath(edge)}
                  className="ui-er__edge-line"
                  markerStart={`url(#er-${source})`}
                  markerEnd={`url(#er-${target})`}
                />
              </g>
            );
          })}

          {layout.cards.map((card) => (
            <Card key={card.id} card={card} />
          ))}
        </svg>
      </div>
    </div>
  );
}

function Glyph({ kind }: { kind: 'one' | 'many' }) {
  return (
    <svg
      width="34"
      height="14"
      viewBox="0 0 34 14"
      aria-hidden="true"
      className="ui-er__legend-glyph"
    >
      <path d="M 0 7 H 32" className="ui-er__edge-line" />
      {kind === 'one' ? (
        <path d="M 27 1 L 27 13" className="ui-er__glyph" />
      ) : (
        <path d="M 20 7 L 32 1 M 20 7 L 32 13" className="ui-er__glyph" />
      )}
    </svg>
  );
}

/** Key to the notation, kept beside the diagram. */
export function ErLegend() {
  return (
    <div
      className="ui-row"
      style={{ gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'center' }}
    >
      <span className="ui-meta ui-row" style={{ gap: 'var(--space-2)' }}>
        <Glyph kind="one" /> one
      </span>
      <span className="ui-meta ui-row" style={{ gap: 'var(--space-2)' }}>
        <Glyph kind="many" /> many
      </span>
      <span className="ui-meta">
        <span className="ui-er__badge-chip ui-er__badge-chip--pk">PK</span> primary key
      </span>
      <span className="ui-meta">
        <span className="ui-er__badge-chip ui-er__badge-chip--fk">FK</span> foreign key
      </span>
      <span className="ui-meta">Hover a line for its relationship.</span>
    </div>
  );
}
