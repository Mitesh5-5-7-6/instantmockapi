'use client';

/**
 * Rows, and the progress bar one of them contains.
 *
 * `ListRow` generalises the shape; `WorkerRow` is the generation board's own
 * row and keeps its fixed slots, because it is the one place where the columns
 * have to line up down a list of eight jobs.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { cn } from '../lib/utils.js';
import { StatusChip } from './badge.js';

/* ── ProgressBar ── */

/**
 * shadcn's `progress` is a Radix wrapper; this is the same markup without it.
 *
 * Radix's `Progress` contributes the ARIA attributes, which are written out
 * here — four attributes against a dependency is not a trade worth making, and
 * `role="progressbar"` with `aria-valuenow` is the whole contract.
 */
export function ProgressBar({ percent, className }: { percent: number; className?: string }) {
  return (
    <div
      className={cn('h-2 overflow-hidden rounded-full bg-popover', className)}
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-[250ms] ease-out"
        style={{ width: `${Math.min(100, percent)}%` }}
      />
    </div>
  );
}

/* ── WorkerRow ── */

export interface WorkerRowProps {
  worker: string;
  artifactType: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  error?: string | null;
  waitingOn?: string;
  action?: ReactNode;
}

export function WorkerRow({
  worker,
  artifactType,
  status,
  error,
  waitingOn,
  action,
}: WorkerRowProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 px-4 py-3',
        'border-b border-border last:border-b-0',
        // A faint tint on the job that is actually running, so the board has one
        // obvious focus among eight otherwise identical rows.
        status === 'running' && 'bg-accent-subtle',
      )}
    >
      <span className="w-6 font-mono text-xs text-muted-foreground">{worker}</span>
      <span className="flex-1 font-mono text-sm">{artifactType}</span>
      {waitingOn && status === 'queued' ? (
        <span className="text-xs text-muted-foreground">Waiting on {waitingOn}</span>
      ) : null}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
      {action}
      <StatusChip status={status} label={status === 'running' ? 'generating' : status} />
    </div>
  );
}

/* ── ListRow ── */

export interface ListRowProps {
  /** Avatar, icon tile, or method badge. */
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  /** Status chips, counts, a kebab — laid out at the end of the row. */
  trailing?: ReactNode;
  /** Makes the whole row a button. */
  onClick?: () => void;
  className?: string;
}

/**
 * One row of a list: leading slot, a title/meta stack that absorbs the slack,
 * and trailing slots.
 */
export function ListRow({ leading, title, meta, trailing, onClick, className }: ListRowProps) {
  const body = (
    <>
      {leading}
      {/* The middle column must be allowed to shrink, or a long project name
          pushes the trailing columns out of the row entirely. */}
      <span className="min-w-0 flex-auto">
        <span className="block truncate text-foreground">{title}</span>
        {meta ? <span className="block text-xs text-muted-foreground">{meta}</span> : null}
      </span>
      {trailing}
    </>
  );

  const shared = cn(
    'flex w-full items-center gap-3 py-3 text-left',
    'border-b border-border last:border-b-0',
    className,
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={cn(
          shared,
          'cursor-pointer bg-transparent font-[inherit] text-inherit transition-colors',
          'hover:bg-muted',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
        onClick={onClick}
      >
        {body}
      </button>
    );
  }
  return <div className={shared}>{body}</div>;
}

/* ── CountdownBadge ── */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function formatRemaining(expiresAt: string | Date): string {
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) {
    return 'expired';
  }
  const days = Math.floor(remaining / DAY_MS);
  const hours = Math.floor((remaining % DAY_MS) / HOUR_MS);
  if (days > 0) {
    return `${days}d ${hours}h left`;
  }
  const minutes = Math.floor((remaining % HOUR_MS) / 60_000);
  return `${hours}h ${minutes}m left`;
}

export function CountdownBadge({ expiresAt }: { expiresAt: string | null }) {
  const [, forceTick] = useState(0);
  const ticking = expiresAt !== null;

  useEffect(() => {
    // Gated on `ticking`: a badge with no expiry renders nothing, so a minute
    // timer for it is a wake-up that repaints an empty span forever.
    if (!ticking) {
      return;
    }
    const timer = setInterval(() => forceTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, [ticking]);

  if (!expiresAt) {
    return null;
  }
  const remaining = new Date(expiresAt).getTime() - Date.now();
  return (
    <span
      className={cn(
        'text-xs tabular-nums',
        remaining < DAY_MS ? 'text-warning' : 'text-muted-foreground',
      )}
    >
      {formatRemaining(expiresAt)}
    </span>
  );
}
