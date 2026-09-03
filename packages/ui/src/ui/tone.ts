/**
 * The tint vocabulary shared by `IconTile`, `Avatar` and `Stat`.
 *
 * ## Why a lookup of class pairs and not one `--tone` variable
 *
 * The CSS version set a single `--tone` property per modifier class and derived
 * both the text colour and a 16% `color-mix` fill from it. That is genuinely
 * tidier — but it needs a `--tone` custom property, and a Tailwind utility
 * cannot read one that a sibling class sets. So the pair is written out.
 *
 * The cost is that fill and label could in principle fall out of step; the
 * table is arranged one tone per line so that is visible rather than buried.
 *
 * ## Each tone must actually be the hue its name claims
 *
 * Three of these were lying, and it was the single biggest source of green in
 * the product: `success` was byte-identical to the accent, `cyan` resolved to a
 * light **green** (`#7ee2a8`) and `violet` to a **grey**. Screens that
 * deliberately asked for six different colours — the dashboard tiles, the
 * quick-start cards — got green for seven of thirteen usages. Pointing them at
 * real values removed green *without* removing information, which is why this
 * table matters more than it looks, and why `theme.test.ts` asserts that no
 * tone names a hue absent from the palette.
 */

export type Tone = 'accent' | 'cyan' | 'success' | 'warning' | 'error' | 'violet' | 'neutral';

export interface ToneClasses {
  /** Text/glyph colour. */
  text: string;
  /** A faint fill of the same hue, for a tile or an avatar ground. */
  fill: string;
}

export const TONES: Record<Tone, ToneClasses> = {
  accent: { text: 'text-accent-mark', fill: 'bg-accent-mark/16' },
  cyan: { text: 'text-info', fill: 'bg-info/16' },
  success: { text: 'text-accent-mark', fill: 'bg-accent-mark/16' },
  warning: { text: 'text-warning', fill: 'bg-warning/16' },
  error: { text: 'text-destructive', fill: 'bg-destructive/16' },
  violet: { text: 'text-violet', fill: 'bg-violet/16' },
  neutral: { text: 'text-muted-foreground', fill: 'bg-muted-foreground/16' },
};
