import { describe, it, expect } from 'vitest';
import {
  formatCompact,
  layoutAreaChart,
  nearestIndex,
  niceMax,
  type ChartPoint,
} from './area-chart';

const WIDTH = 640;
const HEIGHT = 220;

function series(values: number[]): ChartPoint[] {
  return values.map((value, index) => ({ label: `2026-05-${12 + index}`, value }));
}

const layout = (values: number[]) =>
  layoutAreaChart({ points: series(values), width: WIDTH, height: HEIGHT });

/** Every coordinate pair in an SVG path, for the containment assertions. */
function coordinates(path: string): { x: number; y: number }[] {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const pairs: { x: number; y: number }[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    pairs.push({ x: numbers[index] as number, y: numbers[index + 1] as number });
  }
  return pairs;
}

describe('niceMax', () => {
  it('rounds up to a maximum with round labels', () => {
    // The design's axis: 0 / 1K / 2K / 3K / 4K for a peak of 3,247.
    expect(niceMax(3247, 5)).toBe(4000);
  });

  it('keeps every tick a whole number', () => {
    // These are request counts. An axis reading 0 / 2.5 / 5 / 7.5 / 10 would be
    // wrong for something that cannot be fractional, which is why 2.5 is not on
    // the step ladder and the magnitude is floored at 1.
    for (const rawMax of [1, 3, 7, 10, 47, 99, 1234]) {
      const max = niceMax(rawMax, 5);
      expect(Number.isInteger(max / 4)).toBe(true);
    }
  });

  it('accepts headroom to keep the labels round', () => {
    // 47 → 80 (0/20/40/60/80), not a snug 50, because 50 across four intervals
    // needs a step of 12.5. Round labels beat a full-height plot.
    expect(niceMax(47, 5)).toBe(80);
    expect(niceMax(10, 5)).toBe(20);
  });

  it('gives an all-zero series a real axis instead of dividing by zero', () => {
    expect(niceMax(0, 5)).toBe(4);
    expect(niceMax(-5, 5)).toBe(4);
    expect(niceMax(Number.NaN, 5)).toBe(4);
  });

  it('is always at least the data maximum', () => {
    for (const rawMax of [1, 9, 10, 11, 250, 3247, 999_999]) {
      expect(niceMax(rawMax, 5)).toBeGreaterThanOrEqual(rawMax);
    }
  });
});

describe('formatCompact', () => {
  it('matches the design labels', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(980)).toBe('980');
    expect(formatCompact(1000)).toBe('1K');
    expect(formatCompact(12450)).toBe('12.45K');
    expect(formatCompact(1_200_000)).toBe('1.2M');
  });

  it('drops trailing zeros rather than padding decimals', () => {
    expect(formatCompact(2000)).toBe('2K');
    expect(formatCompact(1500)).toBe('1.5K');
  });

  it('caps at two decimals', () => {
    expect(formatCompact(1234)).toBe('1.23K');
  });

  it('handles junk without producing NaN in a label', () => {
    expect(formatCompact(Number.NaN)).toBe('0');
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('layoutAreaChart — degenerate input', () => {
  it('returns an empty layout for no points', () => {
    const empty = layoutAreaChart({ points: [], width: WIDTH, height: HEIGHT });
    expect(empty.points).toEqual([]);
    expect(empty.areaPath).toBe('');
    expect(empty.linePath).toBe('');
    expect(empty.gridlines).toEqual([]);
  });

  it('produces a finite path for a single point', () => {
    // The divisor is points.length - 1, so this is where a NaN would appear.
    const single = layout([42]);
    expect(single.points).toHaveLength(1);
    expect(single.linePath).not.toContain('NaN');
    expect(coordinates(single.linePath).every((pair) => Number.isFinite(pair.y))).toBe(true);
  });

  it('draws an all-zero series flat on the baseline', () => {
    const flat = layout([0, 0, 0, 0, 0, 0, 0]);
    expect(flat.points.every((point) => point.y === flat.baselineY)).toBe(true);
    expect(flat.gridlines).toHaveLength(5);
  });
});

describe('layoutAreaChart — geometry', () => {
  const seven = layout([1820, 2400, 1100, 3247, 900, 2600, 40]);

  it('spreads x from the left edge of the plot to the right', () => {
    const xs = seven.points.map((point) => point.x);
    expect(xs[0]).toBe(seven.plot.x);
    expect(xs[xs.length - 1]).toBe(seven.plot.x + seven.plot.width);
  });

  it('is strictly increasing in x', () => {
    const xs = seven.points.map((point) => point.x);
    for (let index = 1; index < xs.length; index += 1) {
      expect(xs[index] as number).toBeGreaterThan(xs[index - 1] as number);
    }
  });

  it('inverts y, so the largest value sits highest', () => {
    const peak = seven.points.reduce((best, point) => (point.value > best.value ? point : best));
    const trough = seven.points.reduce((worst, point) =>
      point.value < worst.value ? point : worst,
    );
    expect(peak.y).toBeLessThan(trough.y);
    expect(trough.y).toBeLessThanOrEqual(seven.baselineY);
  });

  it('never emits a coordinate outside the plot', () => {
    // The overshoot invariant, and the test that pays for itself. Catmull-Rom
    // dives below the baseline on a sharp dip at higher tension — drawing a
    // negative number of requests. Control points are clamped, and a cubic
    // Bézier stays inside the convex hull of its control points, so bounding the
    // handles bounds the whole curve.
    const spiky = layout([3000, 0, 3000, 0, 3000, 0, 3000]);
    for (const path of [spiky.linePath, spiky.areaPath]) {
      for (const pair of coordinates(path)) {
        expect(pair.y).toBeGreaterThanOrEqual(spiky.plot.y);
        expect(pair.y).toBeLessThanOrEqual(spiky.baselineY);
        expect(pair.x).toBeGreaterThanOrEqual(spiky.plot.x);
        expect(pair.x).toBeLessThanOrEqual(spiky.plot.x + spiky.plot.width);
      }
    }
  });

  it('derives the area from the line, so fill and stroke share one top edge', () => {
    expect(seven.areaPath.startsWith(seven.linePath)).toBe(true);
    expect(seven.areaPath.endsWith('Z')).toBe(true);
    // Closed down to the baseline at both ends.
    expect(seven.areaPath).toContain(`L ${seven.plot.x + seven.plot.width} ${seven.baselineY}`);
    expect(seven.areaPath).toContain(`L ${seven.plot.x} ${seven.baselineY}`);
  });

  it('passes through every point rather than near it', () => {
    // Catmull-Rom's defining property; a plain Bézier smoothing would miss.
    for (const point of seven.points) {
      expect(seven.linePath).toContain(`${point.x} ${point.y}`);
    }
  });

  it('is deterministic', () => {
    const values = [1820, 2400, 1100, 3247, 900, 2600, 40];
    expect(layout(values)).toEqual(layout(values));
  });
});

describe('layoutAreaChart — axes', () => {
  const seven = layout([1820, 2400, 1100, 3247, 900, 2600, 40]);

  it('emits exactly tickCount gridlines, baseline first', () => {
    expect(seven.gridlines).toHaveLength(5);
    expect(seven.gridlines[0]).toMatchObject({ value: 0, y: seven.baselineY, label: '0' });
    expect(seven.gridlines[4]?.y).toBe(seven.plot.y);
  });

  it('labels the axis the way the design does', () => {
    expect(seven.gridlines.map((line) => line.label)).toEqual(['0', '1K', '2K', '3K', '4K']);
  });

  it('spaces gridlines evenly', () => {
    const gaps = seven.gridlines
      .slice(1)
      .map((line, index) => (seven.gridlines[index] as { y: number }).y - line.y);
    for (const gap of gaps) {
      expect(gap).toBeCloseTo(gaps[0] as number, 5);
    }
  });

  it('emits one x label per point, aligned to it', () => {
    expect(seven.xLabels).toHaveLength(seven.points.length);
    for (const [index, label] of seven.xLabels.entries()) {
      expect(label.x).toBe(seven.points[index]?.x);
      expect(label.label).toBe(seven.points[index]?.label);
    }
  });

  it('keeps the plot inside the canvas, leaving room for the labels', () => {
    expect(seven.plot.x).toBeGreaterThan(0);
    expect(seven.plot.y).toBeGreaterThan(0);
    expect(seven.plot.x + seven.plot.width).toBeLessThanOrEqual(WIDTH);
    expect(seven.baselineY).toBeLessThan(HEIGHT);
  });
});

describe('nearestIndex', () => {
  const seven = layout([1, 2, 3, 4, 5, 6, 7]);

  it('finds the closest point', () => {
    const third = seven.points[3] as { x: number };
    expect(nearestIndex(seven, third.x)).toBe(3);
    expect(nearestIndex(seven, third.x + 2)).toBe(3);
  });

  it('clamps outside the plot to the first and last point', () => {
    expect(nearestIndex(seven, -500)).toBe(0);
    expect(nearestIndex(seven, 99_999)).toBe(seven.points.length - 1);
  });

  it('gives an exact midpoint to the lower index', () => {
    // Stated so a cursor jittering on a boundary does not flicker between two
    // buckets.
    const first = seven.points[0] as { x: number };
    const second = seven.points[1] as { x: number };
    expect(nearestIndex(seven, (first.x + second.x) / 2)).toBe(0);
  });

  it('returns -1 for an empty layout', () => {
    const empty = layoutAreaChart({ points: [], width: WIDTH, height: HEIGHT });
    expect(nearestIndex(empty, 100)).toBe(-1);
  });
});
