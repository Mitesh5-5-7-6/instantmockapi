import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards on the palette.
 *
 * The theme it protects is Vercel black with a MongoDB green accent, and its one
 * organising rule is that **vividness scales inversely with area**: a vivid green
 * belongs on a 7px dot and is glaring on a button. Before this, one bright green
 * did all three jobs — as a button fill it threw 44× the luminance of a card, and
 * ten of those on the Projects screen was a wall of green.
 *
 * Contrast is *computed* here rather than eyeballed. The example that prompted
 * this work — dark green text on a same-lightness grey — looks reasonable
 * written down and is 1.30:1 in practice, well under the 4.5:1 text needs. A
 * check that does the arithmetic catches that; a reviewer squinting at hexes
 * does not.
 *
 * A text test because `packages/ui` has no DOM, the same technique as
 * `apps/web/src/lib/error-conventions.test.ts`.
 */

const CSS = readFileSync(join(process.cwd(), 'styles.css'), 'utf8');

/**
 * Values declared in the `:root` block, so the light variant cannot confuse us.
 *
 * The end marker is searched **from `:root` onward**: the file's header comment
 * mentions `[data-theme='light']` before the block starts, and slicing to the
 * first occurrence produced an empty string — a test that then reported every
 * token as undeclared rather than failing on the real thing.
 */
const ROOT_START = CSS.indexOf(':root {');
const ROOT = CSS.slice(ROOT_START, CSS.indexOf("[data-theme='light'] {", ROOT_START));

function token(name: string): string {
  const match = new RegExp(`^\\s*--${name}:\\s*([^;]+);`, 'm').exec(ROOT);
  if (match === null) {
    throw new Error(`token --${name} is not declared in :root`);
  }
  return match[1]!.trim();
}

// ---------------------------------------------------------------------------
// WCAG contrast, from the spec
// ---------------------------------------------------------------------------

function channels(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((raw) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (lighter + 0.05) / (darker + 0.05);
}

describe('the contrast maths', () => {
  /** Anchored against known values so a broken implementation cannot pass. */
  it('agrees with the spec on the extremes', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#000000', '#000000')).toBeCloseTo(1, 5);
  });

  /**
   * The example that started this: `hsl(135 70% 16%)` text on `hsl(0 0% 16%)`.
   * Same lightness, so almost no contrast however green it is.
   */
  it('rejects the same-lightness pairing that looked plausible', () => {
    expect(contrast('#292929', '#0c451b')).toBeLessThan(2);
  });
});

describe('every pair the product ships', () => {
  const pairs: [string, string, string, number][] = [
    ['primary text on the page', 'foreground', 'background', 4.5],
    ['primary text on a card', 'foreground', 'card', 4.5],
    ['secondary text on a card', 'muted-foreground', 'card', 4.5],
    ['secondary text on the page', 'muted-foreground', 'background', 4.5],
    ['tertiary text on the page', 'subtle-foreground', 'background', 3],
    // The primary button is the one filled thing on a screen; its label has to
    // hold up against a deep green rather than a bright one.
    ['the primary button label', 'primary-foreground', 'primary', 4.5],
    ['the primary button label, hovered', 'primary-foreground', 'primary-hover', 4.5],
    ['the primary button label, pressed', 'primary-foreground', 'primary-active', 4.5],
    ['green text on the page', 'accent-text', 'background', 4.5],
    // Every button hover lands on `--muted`, so accent text has to survive it.
    ['green text on the hover surface', 'accent-text', 'muted', 4.5],
    ['green text on the pressed surface', 'accent-text', 'muted-strong', 4.5],
    ['a green mark on the page', 'accent-mark', 'background', 3],
    ['black on a green mark', 'background', 'accent-mark', 4.5],
    ['destructive text on a card', 'destructive', 'card', 4.5],
    ['warning text on a card', 'warning', 'card', 4.5],
    ['info text on a card', 'info', 'card', 4.5],
    ['violet text on a card', 'violet', 'card', 4.5],
  ];

  // `$1`/`$4` rather than `%s`, which consumes the arguments positionally and
  // was printing the foreground token where the ratio belonged.
  it.each(pairs)('$0 clears $3:1', (_label, fg, bg, minimum) => {
    const ratio = contrast(token(fg), token(bg));
    expect(
      ratio,
      `--${fg} on --${bg} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`,
    ).toBeGreaterThanOrEqual(minimum);
  });
});

describe('the three green intensities', () => {
  /**
   * The whole design. Collapsing these back into one value is how the theme got
   * loud in the first place, and it is an easy "simplification" to make by
   * accident.
   */
  it('are three different values', () => {
    const [fill, label, mark] = [token('primary'), token('accent-text'), token('accent-mark')];
    expect(new Set([fill, label, mark]).size).toBe(3);
  });

  /**
   * A fill covers thousands of pixels, a mark covers about fifty. The fill must
   * therefore throw markedly less light, or a single button dominates the page.
   */
  it('put the fill well below the mark in luminance', () => {
    const fill = relativeLuminance(token('primary'));
    const mark = relativeLuminance(token('accent-mark'));
    expect(fill).toBeLessThan(mark / 3);
  });

  it('order the label between the fill and the mark', () => {
    const [fill, label, mark] = [
      relativeLuminance(token('primary')),
      relativeLuminance(token('accent-text')),
      relativeLuminance(token('accent-mark')),
    ];
    expect(label).toBeGreaterThan(fill);
    expect(label).toBeLessThan(mark);
  });
});

describe('surfaces', () => {
  it('start at pure black', () => {
    expect(token('background')).toBe('#000000');
  });

  it('step upward, so elevation reads without a border', () => {
    const ladder = ['background', 'card', 'popover', 'muted', 'muted-strong'].map((name) =>
      relativeLuminance(token(name)),
    );
    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i]!, `step ${i} is not lighter than ${i - 1}`).toBeGreaterThan(ladder[i - 1]!);
    }
  });

  /**
   * Chroma zero on every neutral, so green is the only hue in the system and
   * therefore the only thing that can draw the eye. A tinted grey competes.
   */
  it.each(['background', 'card', 'popover', 'muted', 'muted-strong', 'border', 'border-strong'])(
    '--%s is a true neutral',
    (name) => {
      const [r, g, b] = channels(token(name));
      expect(Math.max(r, g, b) - Math.min(r, g, b), `--${name} is tinted`).toBeLessThanOrEqual(2);
    },
  );

  /**
   * The old border was `#242424` on pure black — all but invisible, which left
   * green as the only thing giving the layout landmarks.
   */
  it('give the border enough presence to carry the layout', () => {
    expect(contrast(token('border'), token('background'))).toBeGreaterThan(1.3);
    expect(relativeLuminance(token('border-strong'))).toBeGreaterThan(
      relativeLuminance(token('border')),
    );
  });
});

describe('button variants', () => {
  function rule(selector: string): string {
    const start = CSS.indexOf(`${selector} {`);
    expect(start, `${selector} is not defined`).toBeGreaterThan(-1);
    return CSS.slice(start, CSS.indexOf('}', start));
  }

  /**
   * shadcn's `outline` is `border bg-background hover:bg-accent` and its `ghost`
   * is `hover:bg-accent`, where `--accent` is a chroma-zero grey. Nothing but
   * the primary is filled.
   */
  it.each(['.ui-btn--secondary', '.ui-btn--accent', '.ui-btn--ghost', '.ui-btn--danger'])(
    '%s is transparent until hovered',
    (selector) => {
      expect(rule(selector)).toContain('background: transparent');
    },
  );

  it('fills only the primary', () => {
    expect(rule('.ui-btn--primary')).toContain('background: var(--primary)');
  });

  /**
   * Interaction moves the grey. A hover that turns something green puts the
   * accent under the cursor on every row of a list in turn, which is the
   * densest possible way to spend the green budget.
   */
  it.each([
    '.ui-btn--secondary:hover:not(:disabled)',
    '.ui-btn--ghost:hover:not(:disabled)',
    '.ui-btn--accent:hover:not(:disabled)',
  ])('%s hovers to a grey surface', (selector) => {
    expect(rule(selector)).toMatch(/background: var\(--muted\)/);
  });
});

describe('per-row elements', () => {
  /**
   * GET is the most common method by a wide margin, so colouring it rendered an
   * eighteen-endpoint list as a column of green. Reads are the default action
   * and get the default appearance.
   */
  it('leave GET uncoloured', () => {
    const start = CSS.indexOf('.ui-method--GET {');
    const rule = CSS.slice(start, CSS.indexOf('}', start));
    expect(rule).not.toMatch(/--accent|--primary|status-success/);
    expect(rule).toContain('background: transparent');
  });

  /**
   * A status chip's dot carries the colour and its label stays neutral — ten
   * cards then show ten small dots rather than ten green pills. Failure and
   * expiry are the deliberate exceptions.
   */
  it.each(['.ui-chip--active', '.ui-chip--completed', '.ui-chip--generating'])(
    '%s colours its dot but not its label',
    (selector) => {
      const start = CSS.indexOf(selector);
      const rule = CSS.slice(start, CSS.indexOf('}', start));
      expect(rule).toMatch(/--chip-color:/);
      expect(rule, `${selector} still colours its label`).not.toMatch(/^\s*color:/m);
    },
  );

  it('keep a failure red throughout', () => {
    const start = CSS.indexOf('.ui-chip--failed,');
    const rule = CSS.slice(start, CSS.indexOf('}', start));
    expect(rule).toMatch(/color: var\(--destructive\)/);
  });
});

describe('the tone system', () => {
  /**
   * Three of these used to lie: `success` was byte-identical to `accent`, `cyan`
   * resolved to a light green and `violet` to a grey — so screens asking for six
   * colours got green for seven of thirteen usages. A tone must be the hue its
   * name claims.
   */
  const HUE_RANGE: Record<string, [number, number]> = {
    cyan: [170, 250],
    warning: [30, 70],
    error: [340, 30],
    violet: [260, 320],
  };

  function hue(hex: string): number {
    const [r, g, b] = channels(hex).map((v) => v / 255) as [number, number, number];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) {
      return -1;
    }
    const d = max - min;
    const h =
      max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return h * 60;
  }

  function toneValue(name: string): string {
    const start = CSS.indexOf(`.ui-tone--${name} {`);
    expect(start, `.ui-tone--${name} is not defined`).toBeGreaterThan(-1);
    const rule = CSS.slice(start, CSS.indexOf('}', start));
    const ref = /--tone: var\(--([a-z-]+)\)/.exec(rule);
    if (ref === null) {
      throw new Error(`.ui-tone--${name} does not point at a token`);
    }
    return token(ref[1]!);
  }

  it.each(Object.keys(HUE_RANGE))('--%s is actually that hue', (name) => {
    const [low, high] = HUE_RANGE[name]!;
    const h = hue(toneValue(name));
    const inRange = low > high ? h >= low || h <= high : h >= low && h <= high;
    expect(
      inRange,
      `.ui-tone--${name} resolves to hue ${h.toFixed(0)}, expected ${low}–${high}`,
    ).toBe(true);
  });

  it('does not resolve two differently-named tones to one value', () => {
    const values = ['cyan', 'warning', 'error', 'violet'].map(toneValue);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('green text versus green marks', () => {
  /**
   * `#00ED64` is tuned to be unmissable at 7px. At 14px of running text it is
   * electric, so text takes the lifted `--accent-text` — the same green, legible.
   * Borders, rings and strokes keep the mark, because a 1px line needs the
   * vividness to register at all.
   */
  it('never uses the vivid mark as a text colour', () => {
    const offenders = CSS.split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => /^color: var\(--(accent|accent-mark)\);$/.test(line));

    expect(
      offenders.map((o) => `line ${o.number}: ${o.line}`),
      'use var(--accent-text) for text',
    ).toEqual([]);
  });

  it('still uses the mark for borders and rings', () => {
    // If this ever hits zero, the marks have been quietened away entirely and
    // the accent has stopped doing its job.
    const marks = (CSS.match(/(border[a-z-]*-color|outline|stroke): var\(--accent[^)]*\)/g) ?? [])
      .length;
    expect(marks).toBeGreaterThan(4);
  });
});

describe('the green budget', () => {
  /**
   * A ceiling, so the next feature has to argue for its green rather than
   * reaching for the accent by reflex. Raise it deliberately or not at all.
   */
  it('holds the number of green references down', () => {
    const references = (CSS.match(/var\(--(accent|accent-mark|accent-text|primary)[^)]*\)/g) ?? [])
      .length;
    expect(references).toBeLessThanOrEqual(70);
  });

  /**
   * `--accent` survives only as a legacy alias, and it points at the MARK — so
   * anything still asking for "the accent" gets a small highlight rather than a
   * fill. If it ever aliases the fill again, every legacy call site becomes a
   * filled green surface at once.
   */
  it('keeps the legacy alias pointing at the mark, never the fill', () => {
    expect(token('accent')).toBe('var(--accent-mark)');
  });
});
