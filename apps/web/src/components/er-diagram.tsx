'use client';

/**
 * Entity-relationship diagram for the Design Data Model step.
 *
 * All arrangement lives in `lib/er-layout`; this file only draws. Cardinality is
 * shown with the crow's-foot vocabulary the design legend uses — a bar for
 * "one", a fork for "many" — so the picture and the legend teach the same thing.
 *
 * Markers are defined once and referenced per end, because an edge's two ends
 * carry different symbols: `belongsTo` is many-at-the-source, one-at-the-target,
 * and drawing the same glyph on both ends would state the wrong cardinality.
 */

import { layoutEr, type ErEdge } from '../lib/er-layout';
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

function edgePath(edge: ErEdge): string {
  if (edge.sameRow) {
    // Lift clear of the row so a sibling edge does not cut through the boxes.
    return `M ${edge.from.x} ${edge.from.y} C ${edge.via.x} ${edge.via.y} ${edge.via.x} ${edge.via.y} ${edge.to.x} ${edge.to.y}`;
  }
  // Vertical-then-horizontal elbow: reads as a schema diagram rather than a
  // diagonal web once more than a couple of relations exist.
  return `M ${edge.from.x} ${edge.from.y} V ${edge.via.y} H ${edge.to.x} V ${edge.to.y}`;
}

export function ErDiagram({ entities }: { entities: BuilderEntity[] }) {
  const layout = layoutEr(entities);

  if (layout.nodes.length === 0) {
    return <p className="ui-meta">Name an entity to see the data model here.</p>;
  }

  return (
    <div className="ui-er">
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={`Data model: ${layout.nodes.map((node) => node.name).join(', ')}`}
        style={{ display: 'block', minWidth: layout.width }}
      >
        <defs>
          {/* One marker per symbol, oriented to the path so an end drawn on a
              vertical edge and one on a horizontal edge both point outward. */}
          <marker
            id="er-one"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M 9 1 L 9 9" stroke="currentColor" strokeWidth="1.6" fill="none" />
          </marker>
          <marker
            id="er-many"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="9"
            markerHeight="9"
            orient="auto-start-reverse"
          >
            <path
              d="M 1 5 L 9 1 M 1 5 L 9 9 M 1 5 L 9 5"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="none"
            />
          </marker>
        </defs>

        {layout.edges.map((edge) => {
          const { source, target } = ends(edge.kind);
          return (
            <g key={edge.id} className="ui-er__edge" style={{ color: 'var(--text-muted)' }}>
              <path
                d={edgePath(edge)}
                className="ui-er__edge"
                strokeWidth="1.3"
                markerStart={`url(#er-${source})`}
                markerEnd={`url(#er-${target})`}
              />
              <text
                className="ui-er__edge-label"
                x={edge.via.x + 4}
                y={edge.via.y - 4}
                textAnchor="start"
              >
                {edge.label} · {edge.cardinality}
              </text>
            </g>
          );
        })}

        {layout.nodes.map((node) => (
          <g key={node.id}>
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx="8"
              className={`ui-er__node${node.isolated ? ' ui-er__node--isolated' : ''}`}
              strokeWidth="1.4"
            />
            <text
              className="ui-er__label"
              x={node.x + node.width / 2}
              y={node.y + node.height / 2 + 4}
              textAnchor="middle"
            >
              {node.name}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/** The cardinality legend from the design, kept beside the diagram. */
export function ErLegend() {
  return (
    <div className="ui-row" style={{ gap: 'var(--space-4)', flexWrap: 'wrap' }}>
      {[
        ['1 : 1', 'has one'],
        ['1 : M', 'has many'],
        ['M : 1', 'belongs to'],
        ['M : M', 'many to many'],
      ].map(([cardinality, label]) => (
        <span key={cardinality} className="ui-meta">
          <span className="ui-mono">{cardinality}</span> {label}
        </span>
      ))}
    </div>
  );
}
