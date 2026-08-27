/**
 * The icon set.
 *
 * Hand-authored rather than a dependency, for one reason that outweighs bundle
 * size: `Modal`, `Stepper` and `SuccessMark` live in this package, so an icon
 * library here would either become this package's first runtime dependency —
 * it currently has none — or leave the app rendering two icon systems at two
 * stroke weights inches apart. Path geometry follows lucide (ISC licensed),
 * redrawn onto its 24×24 grid.
 *
 * **`stroke-width` is deliberately not a prop.** The design system asks for a
 * consistent 1.5px stroke matching its hairline aesthetic (doc 12); declaring it
 * once here is what makes that enforceable instead of a convention every call
 * site has to remember.
 *
 * Colour comes from `currentColor`, so an icon inherits whatever its container
 * has — `.ui-nav a[aria-current='page']` recolours it with no extra rule, in
 * both themes and under both `[data-flow]` accent scopes.
 *
 * Revisit threshold: around 50 icons, hand-maintenance stops being worth it and
 * `lucide-react` in `apps/web` becomes the better trade. The dependency rules
 * already permit that.
 */

/**
 * An icon is paths plus circles. Lines, polylines and rects are all expressible
 * as paths, so two primitives cover the whole set and the renderer stays trivial.
 */
interface IconShape {
  p?: string[];
  c?: [cx: number, cy: number, r: number][];
}

/**
 * Dots (the kebab menu) are drawn as zero-length paths: with `stroke-linecap:
 * round`, `h.01` renders as a round cap of exactly the stroke width. That keeps
 * every part strokeable and avoids a fill exception for one icon.
 */
const ICONS = {
  // ── navigation ──
  home: { p: ['M3 10.5 12 3l9 7.5', 'M5.5 9.8V20h13V9.8'] },
  folder: {
    p: [
      'M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l1.8 2.4h9A1.5 1.5 0 0 1 21 9.9V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z',
    ],
  },
  'file-code': {
    p: [
      'M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z',
      'M14 3v5h5',
      'M10.5 12.5 9 15l1.5 2.5',
      'M13.5 12.5 15 15l-1.5 2.5',
    ],
  },
  layers: { p: ['M12 3 3 7.5l9 4.5 9-4.5z', 'M3 12.5 12 17l9-4.5', 'M3 17 12 21.5l9-4.5'] },
  inbox: {
    p: [
      'M6 4.5h12l3 7.5v6a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18v-6z',
      'M3 12h5l1.5 2.5h5L16 12h5',
    ],
  },
  target: {
    c: [
      [12, 12, 8.5],
      [12, 12, 4.5],
      [12, 12, 1],
    ],
  },
  'bar-chart': { p: ['M4.5 20v-7', 'M12 20V5', 'M19.5 20v-4.5', 'M3 20.5h18'] },
  settings: {
    c: [[12, 12, 3.2]],
    p: [
      'M12 3.5v2.2',
      'M12 18.3v2.2',
      'M3.5 12h2.2',
      'M18.3 12h2.2',
      'M6 6l1.6 1.6',
      'M16.4 16.4 18 18',
      'M18 6l-1.6 1.6',
      'M7.6 16.4 6 18',
    ],
  },

  // ── brand / code ──
  code: { p: ['M9 8l-4 4 4 4', 'M15 8l4 4-4 4', 'M13.2 5.5l-2.4 13'] },

  // ── topbar ──
  search: { c: [[10.5, 10.5, 6.5]], p: ['M15.5 15.5 21 21'] },

  // ── stat tiles ──
  cube: { p: ['M12 3 21 7.9v8.2L12 21l-9-4.9V7.9z', 'M3 7.9 12 12.8l9-4.9', 'M12 12.8V21'] },
  activity: { p: ['M3 12h4l3-7 4 14 3-7h4'] },
  globe: {
    c: [[12, 12, 9]],
    p: ['M3 12h18', 'M12 3c2.8 2.6 2.8 15.4 0 18', 'M12 3c-2.8 2.6-2.8 15.4 0 18'],
  },

  // ── indicators / actions ──
  'arrow-up': { p: ['M12 20V4', 'M5.5 10.5 12 4l6.5 6.5'] },
  plus: { p: ['M12 5v14', 'M5 12h14'] },
  'chevron-down': { p: ['M6 9.5 12 15.5l6-6'] },
  'chevron-right': { p: ['M9.5 6 15.5 12l-6 6'] },
  'more-vertical': { p: ['M12 5.5h.01', 'M12 12h.01', 'M12 18.5h.01'] },
  menu: { p: ['M4 7h16', 'M4 12h16', 'M4 17h16'] },
  x: { p: ['M6 6l12 12', 'M18 6 6 18'] },
  check: { p: ['M4.5 12.5 9 17 19.5 6.5'] },
  clock: { c: [[12, 12, 9]], p: ['M12 7.5V12l3.5 2'] },
  alert: { c: [[12, 12, 9]], p: ['M12 7.5v5.5', 'M12 16.5h.01'] },

  // ── project workspace ──
  download: { p: ['M12 4v11', 'M7.5 10.5 12 15l4.5-4.5', 'M4.5 19.5h15'] },
  copy: {
    p: [
      'M9 9h10.5v10.5H9z',
      'M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15',
    ],
  },
  trash: {
    p: ['M4.5 7h15', 'M9.5 7V4.5h5V7', 'M6.5 7l1 12.5h9L17.5 7', 'M10.5 11v5', 'M13.5 11v5'],
  },
  /** Regenerate. Two arcs with arrowheads, so it reads as a cycle rather than a circle. */
  refresh: {
    p: [
      'M20 12a8 8 0 0 1-13.7 5.6',
      'M4 12a8 8 0 0 1 13.7-5.6',
      'M20 5.5V10h-4.5',
      'M4 18.5V14h4.5',
    ],
  },
  'external-link': {
    p: [
      'M14 4.5h5.5V10',
      'M19.5 4.5 11 13',
      'M17 14.5v4A1.5 1.5 0 0 1 15.5 20h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7h4',
    ],
  },
  /** Three stacked ellipses — the conventional datastore glyph. */
  database: {
    p: [
      'M12 3c4.4 0 8 1.1 8 2.5S16.4 8 12 8 4 6.9 4 5.5 7.6 3 12 3z',
      'M4 5.5v13C4 19.9 7.6 21 12 21s8-1.1 8-2.5v-13',
      'M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5',
    ],
  },
  filter: { p: ['M4 6h16', 'M7 12h10', 'M10 18h4'] },

  // ── auth ──
  mail: { p: ['M3 6.5h18v11H3z', 'M3 7l9 6.5L21 7'] },
  lock: {
    p: ['M5.5 11h13v9.5h-13z', 'M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11'],
  },
  /** Visibility toggle: an open eye. */
  eye: {
    c: [[12, 12, 3]],
    p: ['M12 5c5 0 9 4.4 9 7s-4 7-9 7-9-4.4-9-7 4-7 9-7z'],
  },
  /**
   * The same eye with a stroke through it. Drawn as the outline plus a slash
   * rather than a separate shape, so the two states read as one control changing
   * rather than two unrelated glyphs.
   */
  'eye-off': {
    p: [
      'M4 8.5C2.9 9.9 3 11.4 3 12c0 2.6 4 7 9 7 1.6 0 3-.4 4.2-1.1',
      'M9.5 5.4A9.7 9.7 0 0 1 12 5c5 0 9 4.4 9 7 0 1-.9 2.6-2.4 4',
      'M9.9 9.9a3 3 0 0 0 4.2 4.2',
      'M4 4l16 16',
    ],
  },
  /**
   * Google's mark, reduced to its stroked outline.
   *
   * Not the four-colour logo: this set is `currentColor` and single-weight, and a
   * multi-colour raster in the middle of it would be the one element that ignores
   * the theme. The button carries the word "Google" beside it, which is what
   * actually identifies the provider.
   */
  google: {
    p: ['M21 12.2H12v3.2h5.2A5.4 5.4 0 1 1 12 6.6c1.4 0 2.6.5 3.5 1.3l2.3-2.3A9 9 0 1 0 21 12.2z'],
  },

  // ── quick start / activity feed ──
  'cloud-upload': {
    p: [
      'M17.5 17.5a4 4 0 0 0-1.2-7.8 5.5 5.5 0 0 0-10.5 1.6A3.6 3.6 0 0 0 6.5 17.5',
      'M12 21v-8',
      'M8.8 16.2 12 13l3.2 3.2',
    ],
  },
  play: { p: ['M8 5.5v13l11-6.5z'] },

  // ── footer ──
  lightbulb: {
    p: [
      'M12 3a6 6 0 0 1 3.6 10.8c-.6.5-.9 1.2-.9 2H9.3c0-.8-.3-1.5-.9-2A6 6 0 0 1 12 3z',
      'M9.5 18.5h5',
      'M10.2 21h3.6',
    ],
  },
  book: {
    p: [
      'M12 7v14',
      'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
    ],
  },
  'life-buoy': {
    c: [
      [12, 12, 9],
      [12, 12, 4],
    ],
    p: ['M15.2 8.8 18.4 5.6', 'M8.8 8.8 5.6 5.6', 'M8.8 15.2 5.6 18.4', 'M15.2 15.2 18.4 18.4'],
  },

  // ── plan / emphasis ──
  zap: {
    p: [
      'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z',
    ],
  },
} satisfies Record<string, IconShape>;

export type IconName = keyof typeof ICONS;

/** Every icon name, for tests and for iterating the set. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** Sizes the design actually uses. A closed union keeps the set from sprawling. */
export type IconSize = 14 | 16 | 18 | 20 | 24 | 28;

export interface IconProps {
  name: IconName;
  size?: IconSize;
  /**
   * Give this only when the icon is the sole content of its control.
   *
   * Without it the icon is `aria-hidden`, which is correct beside a text label —
   * announcing "folder Projects" is worse than announcing "Projects". When the
   * icon stands alone, either pass a label here or put one on the enclosing
   * button.
   */
  label?: string;
}

export function Icon({ name, size = 18, label }: IconProps) {
  const shape: IconShape = ICONS[name];
  return (
    <svg
      className="ui-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {/* Index keys: the parts of an icon are a fixed list that never reorders,
          and keying on the geometry would collide if two parts were identical. */}
      {shape.p?.map((d, index) => (
        <path key={`p${index}`} d={d} />
      ))}
      {shape.c?.map(([cx, cy, r], index) => (
        <circle key={`c${index}`} cx={cx} cy={cy} r={r} />
      ))}
    </svg>
  );
}
