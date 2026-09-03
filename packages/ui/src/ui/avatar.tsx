'use client';

/**
 * Avatar and IconTile — a tinted container holding either initials or one glyph.
 *
 * shadcn's `Avatar` is a Radix wrapper for an image with a text fallback. This
 * product has no user images anywhere, so all it would contribute is the
 * fallback — the part written here. Kept as plain markup rather than pulling in
 * `@radix-ui/react-avatar` to render a `<span>`.
 *
 * The two share a file because they share the tone table and differ only in
 * shape: a circle of letters, or a rounded square of icon.
 */

import type { ReactNode } from 'react';

import { Icon, type IconName, type IconSize } from '../icons.js';
import { cn } from '../lib/utils.js';
import { TONES, type Tone } from './tone.js';

export type { Tone };

/* ── IconTile ── */

const TILE_SIZES = {
  sm: 'size-7 rounded-[var(--radius-sm)]',
  md: 'size-9 rounded-[var(--radius-md)]',
  lg: 'size-12 rounded-[var(--radius-lg)]',
} as const;

const TILE_GLYPHS: Record<keyof typeof TILE_SIZES, IconSize> = { sm: 16, md: 18, lg: 24 };

export interface IconTileProps {
  icon: IconName;
  tone?: Tone;
  size?: keyof typeof TILE_SIZES;
  /** Only when the tile is the sole content of a control. */
  label?: string;
  className?: string;
}

/** A coloured rounded square holding one icon. */
export function IconTile({ icon, tone = 'accent', size = 'md', label, className }: IconTileProps) {
  const { text, fill } = TONES[tone];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        TILE_SIZES[size],
        text,
        fill,
        className,
      )}
    >
      <Icon name={icon} size={TILE_GLYPHS[size]} {...(label ? { label } : {})} />
    </span>
  );
}

/* ── Avatar ── */

const AVATAR_SIZES = {
  sm: 'size-7 text-xs',
  md: 'size-9 text-sm',
  lg: 'size-11 text-base',
} as const;

export interface AvatarProps {
  /** Pre-computed initials — deriving them from a name is the app's job. */
  initials: string;
  tone?: Tone;
  size?: keyof typeof AVATAR_SIZES;
  /** Shows a presence dot. */
  online?: boolean;
  /** Full name or email, so the circle is not announced as two stray letters. */
  label?: string;
  className?: string;
}

/**
 * Initials in a tinted circle.
 *
 * Deliberately dumb: `initialsOf` and the deterministic tone choice live in the
 * app, where they can be unit-tested. A project must not change colour between
 * renders, and that is a property of the derivation, not of the rendering.
 */
export function Avatar({
  initials,
  tone = 'accent',
  size = 'md',
  online,
  label,
  className,
}: AvatarProps) {
  const { text, fill } = TONES[tone];
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full',
        // Initials are the one place tabular figures would hurt — they are
        // letters, so the tracking is what keeps two capitals from colliding.
        'font-semibold tracking-[0.02em] uppercase',
        AVATAR_SIZES[size],
        text,
        fill,
        className,
      )}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {initials}
      {online ? (
        <span
          // The ring in the surface colour is what makes the dot read as sitting
          // on the avatar rather than being part of the circle underneath it.
          className="absolute -right-px -bottom-px size-2.5 rounded-full bg-accent-mark ring-2 ring-card"
        />
      ) : null}
    </span>
  );
}

/* ── Kbd ── */

/** A keyboard key, e.g. the `⌘K` hint in the search field. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex min-w-[18px] items-center justify-center gap-px',
        'rounded-[var(--radius-sm)] border border-border bg-popover px-1 py-px',
        'font-mono text-xs/[1.4] text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/* ── SuccessMark ── */

export function SuccessMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex size-14 items-center justify-center rounded-full',
        // Vivid green, filled, with a black glyph: 13:1. At 56px this is one
        // mark on one screen at the end of a flow — the size at which bright
        // green belongs.
        'bg-accent-mark text-background',
        className,
      )}
      role="img"
      aria-label="Generated successfully"
    >
      {/* The label is on the wrapper, so the glyph itself stays aria-hidden. */}
      <Icon name="check" size={28} />
    </span>
  );
}
