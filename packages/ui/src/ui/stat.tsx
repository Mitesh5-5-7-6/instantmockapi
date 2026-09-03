'use client';

/**
 * Stat — one headline figure, or a dashboard tile.
 *
 * Not a shadcn component; the closest thing in the registry is a `Card` with
 * hand-written contents, repeated per dashboard. This is that composition,
 * named, so the eleven call sites cannot drift.
 */

import { Icon, type IconName } from '../icons.js';
import { cn } from '../lib/utils.js';
import { IconTile } from './avatar.js';
import type { Tone } from './tone.js';

export interface StatProps {
  value: React.ReactNode;
  label: string;
  /**
   * Promotes the plain figure to a dashboard tile: larger value, an icon in the
   * top-right corner, room for a delta line.
   *
   * The tile treatment is gated on this prop rather than applied
   * unconditionally, so the four existing call sites on the Ready screen — which
   * pass only `value` and `label` — keep rendering byte-identically. A parallel
   * `StatCard` component would have guaranteed the two drifted apart instead.
   */
  icon?: IconName;
  tone?: Tone;
  /**
   * Secondary line under the figure.
   *
   * `direction` is presentational only: the caller decides whether "fewer
   * requests" is good news. `null` renders nothing, which is what a percentage
   * with no comparable previous window should produce — never "+0%" or "+∞%".
   */
  delta?: { text: string; direction?: 'up' | 'down' } | null;
  /**
   * Qualifying text under the figure — what it covers, or why it is absent.
   *
   * Distinct from `delta`, which is a comparison. This carries the caveats that
   * keep a figure honest: "timed for 412 of 5.2K requests", "no requests yet".
   * Without somewhere to put those, a mean taken over a subset of rows renders
   * as though it covered all of them.
   */
  hint?: string;
  className?: string;
}

export function Stat({ value, label, icon, tone = 'accent', delta, hint, className }: StatProps) {
  const isTile = icon !== undefined;
  const labelClass = 'text-xs text-muted-foreground';

  return (
    <div
      className={cn(
        'flex-[1_1_140px] rounded-[var(--radius-md)] border border-border bg-card',
        isTile ? 'p-4' : 'p-3',
        className,
      )}
    >
      {isTile ? (
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className={labelClass}>{label}</div>
          <IconTile icon={icon} tone={tone} size="md" />
        </div>
      ) : null}

      <div
        className={cn(
          'font-semibold text-foreground',
          // Tabular figures on the tile so a number that ticks up does not shift
          // the tile's width underneath it.
          isTile ? 'text-2xl tabular-nums' : 'text-xl',
        )}
      >
        {value}
      </div>

      {isTile ? null : <div className={labelClass}>{label}</div>}

      {delta ? (
        <div
          className={cn(
            'mt-2 flex items-center gap-1 text-xs',
            delta.direction === 'up' && 'text-accent-text',
            delta.direction === 'down' && 'text-destructive',
            delta.direction === undefined && 'text-muted-foreground',
          )}
        >
          {delta.direction ? (
            // Down is the same glyph rotated, so there is one arrow in the set.
            <Icon
              name="arrow-up"
              size={14}
              className={delta.direction === 'down' ? 'rotate-180' : undefined}
            />
          ) : null}
          <span>{delta.text}</span>
        </div>
      ) : null}

      {hint !== undefined ? (
        <div className="mt-2 text-xs text-subtle-foreground">{hint}</div>
      ) : null}
    </div>
  );
}
