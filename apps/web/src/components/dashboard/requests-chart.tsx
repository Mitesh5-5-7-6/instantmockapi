'use client';

/**
 * The requests area chart. Draws only — all arrangement is in `lib/area-chart`.
 *
 * Three mechanics worth knowing before changing anything here:
 *
 * 1. **Fixed viewBox, `width: 100%`.** The SVG scales itself, so the geometry
 *    module never needs a measured pixel width and there is no ResizeObserver.
 * 2. **The tooltip is an HTML div positioned in percentages**, not a
 *    `<foreignObject>` (broken in Safari) and not a `<text>` with a hand-measured
 *    background `<rect>`. Percentages of the wrapper track the responsive SVG
 *    exactly, with nothing measured at runtime.
 * 3. **Colour is entirely in CSS**, matching `er-diagram.tsx`. The gradient stops
 *    read `var(--accent)`, so the fill follows both the theme and the
 *    `[data-flow]` scope.
 */

import { useId, useState } from 'react';
import { EmptyState } from '@instantmockapi/ui';
import {
  formatCompact,
  layoutAreaChart,
  nearestIndex,
  type ChartPoint,
} from '../../lib/area-chart';

const VIEWBOX_WIDTH = 640;
const VIEWBOX_HEIGHT = 220;

export interface RequestsChartProps {
  points: ChartPoint[];
  /** Singular/plural noun for the tooltip and the accessible table. */
  unit?: string;
}

export function RequestsChart({ points, unit = 'requests' }: RequestsChartProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  // Unique per instance: two charts on one page would otherwise share a
  // gradient id and the second would silently reference the first.
  const gradientId = useId();

  const layout = layoutAreaChart({
    points,
    width: VIEWBOX_WIDTH,
    height: VIEWBOX_HEIGHT,
  });

  if (layout.points.length === 0) {
    return (
      <EmptyState title="No requests yet">Traffic appears here once your API is called.</EmptyState>
    );
  }

  const active = hovered === null ? null : (layout.points[hovered] ?? null);

  const moveTo = (index: number): void => {
    setHovered(Math.max(0, Math.min(layout.points.length - 1, index)));
  };

  return (
    <div className="ui-chart">
      <svg
        className="ui-chart__svg"
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        role="img"
        aria-label={`${unit} per day, ${layout.points[0]?.label} to ${layout.points[layout.points.length - 1]?.label}`}
        tabIndex={0}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (rect.width === 0) {
            return;
          }
          // Client pixels → viewBox units, which is all `nearestIndex` speaks.
          const viewBoxX = ((event.clientX - rect.left) / rect.width) * VIEWBOX_WIDTH;
          setHovered(nearestIndex(layout, viewBoxX));
        }}
        onPointerLeave={() => setHovered(null)}
        onBlur={() => setHovered(null)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            moveTo((hovered ?? -1) + 1);
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            moveTo((hovered ?? layout.points.length) - 1);
          } else if (event.key === 'Escape') {
            setHovered(null);
          }
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            {/* `stop-color` accepts a custom property, which is what makes the
                fill theme-aware and flow-aware for free. */}
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {layout.gridlines.map((line) => (
          <g key={line.value}>
            <line
              className="ui-chart__grid"
              x1={layout.plot.x}
              y1={line.y}
              x2={layout.plot.x + layout.plot.width}
              y2={line.y}
            />
            <text className="ui-chart__tick" x={layout.plot.x - 8} y={line.y + 3} textAnchor="end">
              {line.label}
            </text>
          </g>
        ))}

        <path d={layout.areaPath} fill={`url(#${gradientId})`} />
        <path className="ui-chart__line" d={layout.linePath} />

        {active ? (
          <>
            <line
              className="ui-chart__crosshair"
              x1={active.x}
              y1={layout.plot.y}
              x2={active.x}
              y2={layout.baselineY}
            />
            <circle className="ui-chart__dot" cx={active.x} cy={active.y} r={4} />
          </>
        ) : null}

        {layout.xLabels.map((label) => (
          <text
            key={label.index}
            className="ui-chart__tick"
            x={label.x}
            y={VIEWBOX_HEIGHT - 6}
            textAnchor={
              label.index === 0
                ? 'start'
                : label.index === layout.xLabels.length - 1
                  ? 'end'
                  : 'middle'
            }
          >
            {label.label}
          </text>
        ))}
      </svg>

      {active ? (
        <div
          className="ui-chart__tooltip"
          style={{
            left: `${(active.x / VIEWBOX_WIDTH) * 100}%`,
            top: `${(active.y / VIEWBOX_HEIGHT) * 100}%`,
          }}
        >
          <span className="ui-meta">{active.label}</span>
          <strong>
            {formatCompact(active.value)} {unit}
          </strong>
        </div>
      ) : null}

      {/* A long aria-label is a weak substitute for seven data points, so the
          values are also available as a real table. */}
      <table className="ui-visually-hidden">
        <caption>{unit} per day</caption>
        <tbody>
          {layout.points.map((point) => (
            <tr key={point.index}>
              <th scope="row">{point.label}</th>
              <td>{point.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
