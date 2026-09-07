'use client';

/**
 * Note and EmptyState — the two "there is something to say here" containers.
 *
 * `Note` is shadcn's `alert` under this product's name: same left-marked panel,
 * same `role`, and the six call sites keep their `{ children, variant }`
 * signature. shadcn's `Alert`/`AlertTitle`/`AlertDescription` are exported
 * alongside for anything new that wants the title/body split.
 *
 * The marker is a **left border**, not a fill. An alert is text people have to
 * actually read, and a tinted panel behind body copy makes that harder — the
 * same reasoning the toast follows.
 */

import type { ReactNode } from 'react';

import { cn } from '../lib/utils.js';

export type NoteVariant = 'info' | 'warning';

const NOTE_BASE = cn(
  'flex gap-2 rounded-sm border border-border p-3',
  'bg-popover text-sm text-muted-foreground',
  'border-l-[3px]',
);

const NOTE_MARK: Record<NoteVariant, string> = {
  info: 'border-l-primary',
  warning: 'border-l-warning',
};

/** An inline explanation or caution attached to a control. */
export function Note({
  children,
  variant = 'info',
  className,
}: {
  children: ReactNode;
  variant?: NoteVariant;
  className?: string;
}) {
  return (
    <p className={cn(NOTE_BASE, NOTE_MARK[variant], className)} role="note">
      {children}
    </p>
  );
}

/** shadcn's `Alert` shape — a title/description panel that announces itself. */
export function Alert({
  children,
  variant = 'info',
  className,
}: {
  children: ReactNode;
  variant?: NoteVariant;
  className?: string;
}) {
  return (
    <div
      className={cn(NOTE_BASE, NOTE_MARK[variant], 'flex-col gap-1', className)}
      role={variant === 'warning' ? 'alert' : 'note'}
    >
      {children}
    </div>
  );
}

export function AlertTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <strong className={cn('text-sm text-foreground', className)}>{children}</strong>;
}

export function AlertDescription({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span className={cn('text-xs text-muted-foreground', className)}>{children}</span>;
}

/* ── EmptyState ── */

/**
 * Shown where content would be, when there is legitimately none.
 *
 * A **dashed** border rather than the solid one every other panel uses, which is
 * the one visual convention worth keeping deliberately: it reads as an outline
 * waiting to be filled rather than as a card that failed to load.
 * `ErrorState` in `feedback.tsx` is the counterpart — same shape, different
 * reason for the absence — and reuses this container.
 */
export const EMPTY_STATE = cn(
  'rounded-md border border-dashed border-border p-12',
  'text-center text-muted-foreground',
);

export function EmptyState({
  title,
  children,
  className,
}: {
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(EMPTY_STATE, className)}>
      <h3 className="mb-2">{title}</h3>
      {children}
    </div>
  );
}
