'use client';

/**
 * Badge, StatusChip and MethodBadge — shadcn's `badge` shape, with this
 * product's three uses of it.
 *
 * shadcn ships one `Badge` with `default|secondary|destructive|outline`. That
 * covers the plain marker but not the two semantic ones, which is why all three
 * live in one file rather than three: they are the same box, and the only reason
 * they are separate components is that the *palette* is chosen from a different
 * vocabulary each time — a project lifecycle status, an HTTP method, and neither.
 *
 * ## The colour rules are carried over verbatim
 *
 * Both were decided during the theme work and are the reason the app no longer
 * reads as green. They are restated here because they now live in class names
 * rather than in a commented CSS block:
 *
 * - **A status chip is a coloured dot with a neutral label.** Ten cards on the
 *   Projects screen means ten chips, and ten green *words* is what made the
 *   theme read as green. The 7px dot carries the state; the word stays grey.
 *   `failed` and `expired` are the deliberate exceptions and keep a coloured
 *   label — losing red at a glance costs more than the restraint is worth.
 * - **GET is neutral.** Reading is the default action, so it gets the default
 *   appearance. It is also by far the most common method, so colouring it made
 *   an eighteen-endpoint list render as a column of green.
 */

import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';

import { cn } from '../lib/utils.js';

/* ── Badge ── */

export const badgeVariants = cva(
  cn(
    'inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap',
    'rounded-sm border px-2 py-px',
    'font-mono text-xs tracking-[0.04em]',
  ),
  {
    variants: {
      variant: {
        /** The `API` marker on an entity row — green label, no fill. */
        accent: 'border-accent-text/40 text-accent-text',
        neutral: 'border-border text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'accent' },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

export function Badge({
  children,
  variant = 'accent',
  className,
}: {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}) {
  return <span className={cn(badgeVariants({ variant }), className)}>{children}</span>;
}

/* ── StatusChip ── */

/**
 * Per-status dot and label colours.
 *
 * A lookup rather than cva variants, because `status` is a free string arriving
 * from server data — `project.status`, a worker's job state — so an unrecognised
 * value has to render *something*. A cva variant would resolve to no classes and
 * silently drop the chip's border and padding along with its colour;
 * `UNKNOWN_STATUS` is the floor that cannot happen through.
 */
interface StatusStyle {
  dot: string;
  /** Only for the states that keep a coloured label. */
  label?: string;
  /** Only for the states that also tint their border. */
  border?: string;
}

const STATUS_STYLES: Record<string, StatusStyle> = {
  /* Green dot, grey label. */
  active: { dot: 'bg-accent-mark' },
  live: { dot: 'bg-accent-mark' },
  ready: { dot: 'bg-accent-mark' },
  completed: { dot: 'bg-accent-mark' },
  /* Blue, and pulsing: generating is progress, not success. */
  running: { dot: 'bg-info animate-pulse' },
  generating: { dot: 'bg-info animate-pulse' },
  /* Grey — nothing has happened yet. */
  queued: { dot: 'bg-pending' },
  pending: { dot: 'bg-pending' },
  draft: { dot: 'bg-pending' },
  /* Coloured labels — the states a person must not scan past. */
  failed: { dot: 'bg-destructive', label: 'text-destructive', border: 'border-destructive/35' },
  failed_partial: {
    dot: 'bg-destructive',
    label: 'text-destructive',
    border: 'border-destructive/35',
  },
  error: { dot: 'bg-destructive', label: 'text-destructive', border: 'border-destructive/35' },
  /* Violet: an expired hosted API is a thing to act on, and violet is distinct
     enough from the destructive red not to be read as a failure. */
  expired: { dot: 'bg-violet', label: 'text-violet' },
};

const UNKNOWN_STATUS: StatusStyle = { dot: 'bg-pending' };

export interface StatusChipProps {
  status: string;
  label?: string;
  className?: string;
}

export function StatusChip({ status, label, className }: StatusChipProps) {
  const style = STATUS_STYLES[status.toLowerCase()] ?? UNKNOWN_STATUS;
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap',
        'rounded-sm border bg-card px-2 py-0.5',
        'text-xs/4 font-medium capitalize',
        style.border ?? 'border-border',
        style.label ?? 'text-muted-foreground',
        className,
      )}
    >
      <span className={cn('size-[7px] shrink-0 rounded-full', style.dot)} aria-hidden />
      {label ?? status}
    </span>
  );
}

/* ── MethodBadge ── */

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Border, label and a 12% fill of the same colour — one hue per method, so the
 * tint can never fall out of step with the border the way two separate values
 * would.
 */
const METHOD_STYLES: Record<ApiMethod, string> = {
  GET: 'border-muted-foreground text-muted-foreground',
  POST: 'border-accent-mark bg-accent-mark/12 text-accent-mark',
  PUT: 'border-warning bg-warning/12 text-warning',
  PATCH: 'border-violet bg-violet/12 text-violet',
  DELETE: 'border-destructive bg-destructive/12 text-destructive',
};

/** Colour-coded HTTP method label for an endpoint row. */
export function MethodBadge({ method, className }: { method: ApiMethod; className?: string }) {
  return (
    <span
      className={cn(
        // A floor on the width, not a fixed one: the paths beside them line up
        // down the list instead of stepping in and out with the method's length,
        // and DELETE still fits without being clipped.
        'inline-flex min-w-[58px] shrink-0 items-center justify-center',
        'rounded-sm border px-2 py-0.5',
        'font-mono text-xs font-semibold tracking-[0.04em]',
        METHOD_STYLES[method],
        className,
      )}
    >
      {method}
    </span>
  );
}
