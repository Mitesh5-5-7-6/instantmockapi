/**
 * Geometry for the requests area chart.
 *
 * Pure: points in, coordinates out. Same split as `er-layout.ts` — the renderer
 * draws and makes no decisions, and every rule below is testable with no DOM.
 * That is also why there is no charting library here: one series of seven points
 * with one axis is ~150 lines of geometry, and a library's geometry could never
 * be asserted the way this is.
 *
 * Nothing here is responsive. The renderer uses a fixed viewBox at `width:100%`,
 * so the SVG scales itself and this module never needs a measured pixel width.
 */

export interface ChartPoint {
  label: string;
  value: number;
}

export interface AreaChartInput {
  /** Ordered oldest → newest. */
  points: readonly ChartPoint[];
  width: number;
  height: number;
  /** Number of horizontal gridlines including the baseline. */
  tickCount?: number;
}

export interface PlacedPoint {
  index: number;
  label: string;
  value: number;
  x: number;
  y: number;
}

export interface Gridline {
  value: number;
  y: number;
  label: string;
}

export interface AreaChartLayout {
  width: number;
  height: number;
  plot: { x: number; y: number; width: number; height: number };
  points: PlacedPoint[];
  /** Closed: smooth top edge, down to the baseline, back, `Z`. */
  areaPath: string;
  /** Open: the smooth top edge only. */
  linePath: string;
  gridlines: Gridline[];
  xLabels: { index: number; x: number; label: string }[];
  yMax: number;
  baselineY: number;
}

/** Room for the widest y-axis label, e.g. `12.45K`. */
const GUTTER_LEFT = 44;
/** Room for one row of date labels. */
const GUTTER_BOTTOM = 22;
const GUTTER_TOP = 10;
const GUTTER_RIGHT = 6;

/**
 * Catmull-Rom tension.
 *
 * Deliberately below the textbook 1/6 ≈ 0.167… no — *above* it, but capped well
 * under 0.25. Past roughly a quarter, the curve overshoots on a sharp dip and
 * dives below the baseline, which draws a negative number of requests. The
 * control points are clamped as well (see `smoothPath`), so overshoot is
 * impossible rather than merely unlikely.
 */
const SMOOTHING = 0.2;

/** Multipliers that keep an axis label round. 2.5 is excluded on purpose — see `niceMax`. */
const STEP_LADDER = [1, 2, 5, 10];

/**
 * An axis maximum that divides into round, whole-number ticks.
 *
 * Two decisions worth stating:
 *
 * - **Integer steps only.** The magnitude is floored at 1 and 2.5 is left out of
 *   the ladder, so every tick is a whole number. These are request counts; an
 *   axis reading `0 / 2.5 / 5 / 7.5 / 10` is wrong for something that cannot be
 *   fractional.
 * - **Headroom is accepted.** A max of 47 yields 80 (ticks 0/20/40/60/80) rather
 *   than a snug 50, because 50 across four intervals needs a step of 12.5. Round
 *   labels are worth more than a full-height plot.
 *
 * An all-zero series still gets a real axis rather than a divide-by-zero.
 */
export function niceMax(rawMax: number, tickCount = 5): number {
  const intervals = Math.max(1, tickCount - 1);
  if (!Number.isFinite(rawMax) || rawMax <= 0) {
    return intervals;
  }

  const rough = rawMax / intervals;
  const magnitude = Math.max(1, 10 ** Math.floor(Math.log10(rough)));
  for (const multiplier of STEP_LADDER) {
    const step = multiplier * magnitude;
    if (step * intervals >= rawMax) {
      return step * intervals;
    }
  }
  return 10 * magnitude * intervals;
}

/** `0`, `980`, `1K`, `12.45K`, `1.2M` — shared with the stat tiles. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  const abs = Math.abs(value);
  if (abs < 1000) {
    return String(Math.round(value));
  }
  const [divisor, suffix] = abs < 1_000_000 ? ([1000, 'K'] as const) : ([1_000_000, 'M'] as const);
  // Trim to at most two decimals, then drop trailing zeros so 1000 reads "1K"
  // rather than "1.00K".
  const scaled = Number((value / divisor).toFixed(2));
  return `${scaled}${suffix}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Smooth top edge through every point, as a cubic Bézier chain.
 *
 * Catmull-Rom converted to Bézier control points — the standard way to get a
 * curve that passes through each point rather than merely near it.
 *
 * The control points are clamped into the plot, and that is what makes overshoot
 * *impossible*: a cubic Bézier is contained within the convex hull of its four
 * control points, and the two endpoints are data points already inside the plot.
 * So clamping the two handles bounds the whole curve.
 */
function smoothPath(points: readonly PlacedPoint[], top: number, bottom: number): string {
  const first = points[0];
  if (!first) {
    return '';
  }
  if (points.length === 1) {
    // One bucket: a flat line across the plot rather than a NaN-poisoned path.
    return `M ${first.x} ${first.y}`;
  }

  let path = `M ${first.x} ${first.y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index] as PlacedPoint;
    const next = points[index + 1] as PlacedPoint;
    // Virtual endpoints: clamp to the real ends so the curve does not fly off
    // at the edges. `noUncheckedIndexedAccess` is on, hence the explicit `??`.
    const previous = points[index - 1] ?? current;
    const after = points[index + 2] ?? next;

    const c1x = current.x + (next.x - previous.x) * SMOOTHING;
    const c1y = clamp(current.y + (next.y - previous.y) * SMOOTHING, top, bottom);
    const c2x = next.x - (after.x - current.x) * SMOOTHING;
    const c2y = clamp(next.y - (after.y - current.y) * SMOOTHING, top, bottom);

    path += ` C ${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(next.x)} ${round(next.y)}`;
  }
  return path;
}

/** Two decimals is plenty at viewBox scale, and keeps the path string small. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function layoutAreaChart({
  points,
  width,
  height,
  tickCount = 5,
}: AreaChartInput): AreaChartLayout {
  const plot = {
    x: GUTTER_LEFT,
    y: GUTTER_TOP,
    width: Math.max(0, width - GUTTER_LEFT - GUTTER_RIGHT),
    height: Math.max(0, height - GUTTER_TOP - GUTTER_BOTTOM),
  };
  const baselineY = plot.y + plot.height;

  if (points.length === 0) {
    return {
      width,
      height,
      plot,
      points: [],
      areaPath: '',
      linePath: '',
      gridlines: [],
      xLabels: [],
      yMax: 0,
      baselineY,
    };
  }

  const yMax = niceMax(Math.max(...points.map((point) => point.value)), tickCount);
  // A single point sits at the left edge; two or more spread across the plot.
  const step = points.length > 1 ? plot.width / (points.length - 1) : 0;

  const placed: PlacedPoint[] = points.map((point, index) => ({
    index,
    label: point.label,
    value: point.value,
    x: round(plot.x + index * step),
    // Inverted: value 0 sits on the baseline, yMax at the top of the plot.
    y: round(baselineY - (point.value / yMax) * plot.height),
  }));

  const linePath = smoothPath(placed, plot.y, baselineY);
  const lastPoint = placed[placed.length - 1] as PlacedPoint;
  const firstPoint = placed[0] as PlacedPoint;
  // Derived from the line, never drawn twice: the fill and the stroke therefore
  // share one top edge by construction and cannot drift apart.
  const areaPath =
    linePath === ''
      ? ''
      : `${linePath} L ${lastPoint.x} ${baselineY} L ${firstPoint.x} ${baselineY} Z`;

  const intervals = Math.max(1, tickCount - 1);
  const gridlines: Gridline[] = Array.from({ length: tickCount }, (_unused, index) => {
    const value = (yMax / intervals) * index;
    return {
      value,
      y: round(baselineY - (value / yMax) * plot.height),
      label: formatCompact(value),
    };
  });

  return {
    width,
    height,
    plot,
    points: placed,
    areaPath,
    linePath,
    gridlines,
    xLabels: placed.map((point) => ({ index: point.index, x: point.x, label: point.label })),
    yMax,
    baselineY,
  };
}

/**
 * The point nearest a pointer position, in viewBox units.
 *
 * Ties go to the lower index — stated because a midpoint hover would otherwise
 * flicker between two buckets as the cursor jitters.
 */
export function nearestIndex(layout: AreaChartLayout, viewBoxX: number): number {
  if (layout.points.length === 0) {
    return -1;
  }
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of layout.points) {
    const distance = Math.abs(point.x - viewBoxX);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = point.index;
    }
  }
  return bestIndex;
}
