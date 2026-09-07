'use client';

/**
 * The error and notification vocabulary of the design system.
 *
 * These are first-class components rather than something each screen assembles,
 * because the product they replace had 24 hand-written `<p className="ui-error">`
 * blocks in 14 files, each in a slightly different place, and users could not
 * learn where to look for a failure.
 *
 * Four destinations, and choosing between them is the whole design:
 *
 * | Component      | For                                                          |
 * |----------------|--------------------------------------------------------------|
 * | `Toast`        | Something happened, and the page it happened on may be gone. |
 * | `FormError`    | This submission failed, for a reason about the whole form.   |
 * | `ErrorState`   | There is nothing to render, because loading it failed.       |
 * | `ErrorDetails` | The technical particulars, on request only.                  |
 *
 * A field-level message is not here: `Field`'s `error` prop already does that
 * job and already announces itself.
 *
 * Presentation only. Every decision about *which* of these to use lives in
 * `apps/web/src/lib` as pure, tested functions.
 *
 * Styling follows the same shadcn conventions as `./ui/*` — Tailwind utilities
 * and `cn()`. These stay in their own module rather than moving under `ui/`
 * because they are a product decision (the four destinations above), not a
 * primitive.
 */

import type { ReactNode } from 'react';

import { Icon, type IconName } from './icons.js';
import { cn } from './lib/utils.js';
import { Button } from './ui/button.js';
import { EMPTY_STATE } from './ui/alert.js';

export type FeedbackVariant = 'success' | 'error' | 'warning' | 'info' | 'loading';

const VARIANT_ICONS: Record<FeedbackVariant, IconName> = {
  success: 'check',
  error: 'x',
  warning: 'alert',
  info: 'lightbulb',
  loading: 'refresh',
};

/**
 * The variant reads from the **left edge**, as `Note` does.
 *
 * A filled panel makes body copy hard work, and an error toast is text people
 * have to actually read. `info` is the deep primary rather than the vivid mark:
 * a 3px rule is small, but a notification is the one element that appears
 * unbidden, so it should not also be the brightest thing on screen.
 */
const TOAST_MARK: Record<FeedbackVariant, { border: string; icon: string; action: string }> = {
  success: {
    border: 'border-l-accent-mark',
    icon: 'text-accent-mark',
    action: 'text-accent-text',
  },
  error: {
    border: 'border-l-destructive',
    icon: 'text-destructive',
    action: 'text-destructive',
  },
  warning: { border: 'border-l-warning', icon: 'text-warning', action: 'text-warning' },
  info: { border: 'border-l-primary', icon: 'text-accent-text', action: 'text-accent-text' },
  loading: { border: 'border-l-info', icon: 'text-info', action: 'text-info' },
};

/* ── Toast ────────────────────────────────────────────────────────────────── */

export interface ToastProps {
  variant: FeedbackVariant;
  title: string;
  detail?: string | null;
  action?: { label: string; onClick: () => void } | null;
  onDismiss: () => void;
}

/**
 * One notification.
 *
 * `role="alert"` is deliberately **not** used here — the viewport owns the live
 * region. Announcing per-toast would make a screen reader re-read the whole
 * stack every time one is added, and would re-announce a toast that was merely
 * refreshed in place by deduplication.
 */
export function Toast({ variant, title, detail, action, onDismiss }: ToastProps) {
  const mark = TOAST_MARK[variant];
  return (
    <div
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3',
        'rounded-md border border-border border-l-[3px] px-4 py-3',
        'bg-popover shadow-[0_8px_24px_rgb(0_0_0/35%)]',
        // Someone who asked for less motion still needs the toast, just not the
        // slide.
        'motion-safe:animate-[ui-toast-in_160ms_ease-out]',
        mark.border,
      )}
    >
      <Icon
        name={VARIANT_ICONS[variant]}
        size={16}
        className={cn('mt-0.5', mark.icon, variant === 'loading' && 'motion-safe:animate-spin')}
      />
      <div className="flex min-w-0 flex-col gap-[3px]">
        {/* Long server messages wrap rather than being clipped: a truncated
            error is one the user has to guess at. */}
        <strong className="text-sm break-words [overflow-wrap:anywhere]">{title}</strong>
        {detail !== null && detail !== undefined && detail !== '' ? (
          <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{detail}</span>
        ) : null}
        {action ? (
          <button
            type="button"
            className={cn(
              'mt-[3px] cursor-pointer self-start border-0 bg-transparent p-0',
              'font-[inherit] text-xs underline',
              'outline-none focus-visible:ring-2 focus-visible:ring-ring',
              mark.action,
            )}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ) : null}
      </div>
      {/*
        A real button, not a click handler on an icon: an error toast does not
        expire, so dismissing it must be reachable by keyboard or it is
        permanent for anyone not using a mouse.
      */}
      <button
        type="button"
        className={cn(
          'flex size-[22px] shrink-0 cursor-pointer items-center justify-center',
          'rounded-sm border-0 bg-transparent p-0',
          'text-muted-foreground transition-colors hover:bg-card hover:text-foreground',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
        onClick={onDismiss}
        aria-label={`Dismiss: ${title}`}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

export interface ToastViewportProps {
  /** Corner or edge to anchor to, as `top-left` … `bottom-right`. */
  position: string;
  /** Newest first, so a bottom-anchored stack grows away from the edge. */
  stackUpward: boolean;
  children: ReactNode;
  /** True while any non-expiring notification is showing. */
  hasUrgent: boolean;
}

/**
 * Where each anchor puts the column.
 *
 * A lookup keyed by the same strings the settings store persists, so an
 * unrecognised saved value falls back to a corner that exists rather than
 * pinning the stack to the top-left of the document. The `*-center` entries
 * carry their own `-translate-x-1/2` because the anchor is `left: 50%`.
 */
const TOAST_ANCHORS: Record<string, string> = {
  'top-left': 'top-4 left-4',
  'top-right': 'top-4 right-4',
  'bottom-left': 'bottom-4 left-4',
  'bottom-right': 'bottom-4 right-4',
  'top-center': 'top-4 left-1/2 -translate-x-1/2 max-sm:translate-x-0',
  'bottom-center': 'bottom-4 left-1/2 -translate-x-1/2 max-sm:translate-x-0',
};

/**
 * The single outlet every notification renders into.
 *
 * Two live regions rather than one, and the split is the reason this component
 * is not simply a `<div>`: `assertive` interrupts whatever a screen reader is
 * saying, which is right for a failure and hostile for `Project saved`. A single
 * region would have to pick one and be wrong half the time.
 */
export function ToastViewport({ position, stackUpward, children, hasUrgent }: ToastViewportProps) {
  return (
    <div
      className={cn(
        'fixed z-[var(--z-toast)] flex w-[min(400px,calc(100vw-1.5rem))] flex-col gap-2',
        // On a phone the column spans the viewport instead of hugging a corner.
        'max-sm:right-2 max-sm:left-2 max-sm:w-[calc(100vw-1rem)]',
        // The column must not swallow clicks on the page it floats over; each
        // toast re-enables pointer events for itself.
        'pointer-events-none [&>*]:pointer-events-auto',
        // Newest nearest the anchored edge, so the eye finds it without scanning.
        stackUpward && 'flex-col-reverse',
        TOAST_ANCHORS[position] ?? TOAST_ANCHORS['bottom-right'],
      )}
      data-position={position}
      data-stack={stackUpward ? 'up' : 'down'}
      role="region"
      aria-label="Notifications"
      aria-live={hasUrgent ? 'assertive' : 'polite'}
      // Additions are what matter; removing a dismissed toast is not news.
      aria-relevant="additions"
    >
      {children}
    </div>
  );
}

/* ── Form-level error ─────────────────────────────────────────────────────── */

export interface FormErrorProps {
  title: string;
  detail?: string | null;
  children?: ReactNode;
}

/**
 * A failure that applies to a whole submission rather than one control.
 *
 * Legitimate when the error genuinely is form-wide — wrong credentials, a name
 * already taken, a definition that is invalid for a reason no single input
 * caused. Not legitimate as a home for anything a field could carry: an error
 * beside the input is always more actionable than one at the bottom of a form.
 *
 * `role="alert"` because it appears in response to a submission the user just
 * made, and they need to know the submission did not go through.
 */
export function FormError({ title, detail, children }: FormErrorProps) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-sm p-3 text-sm',
        'border border-destructive/35 border-l-[3px] border-l-destructive',
        // A 6% wash rather than a fill — enough to mark the panel as a failure
        // without fighting the text inside it.
        'bg-destructive/[0.06]',
      )}
      role="alert"
    >
      <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-col gap-[3px]">
        <strong>{title}</strong>
        {detail !== null && detail !== undefined && detail !== '' ? (
          <span className="text-xs text-muted-foreground">{detail}</span>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/* ── Error state ──────────────────────────────────────────────────────────── */

export interface ErrorStateProps {
  title: string;
  detail?: string | null;
  onRetry?: (() => void) | null;
  retryLabel?: string;
  children?: ReactNode;
}

/**
 * Shown where content would be, when loading it failed.
 *
 * The fourth destination, and the one the error spec does not name explicitly.
 * A toast is the wrong answer for a query failure: it fades, and it leaves the
 * user looking at a blank page with no explanation and nothing to press. This is
 * the counterpart to `EmptyState` — same container, different reason for the
 * absence — so it reuses that container's classes and only re-tints the border.
 */
export function ErrorState({
  title,
  detail,
  onRetry,
  retryLabel = 'Try again',
  children,
}: ErrorStateProps) {
  return (
    <div
      className={cn(EMPTY_STATE, 'flex flex-col items-center gap-3 border-destructive/30')}
      role="alert"
    >
      <Icon name="alert" size={24} className="text-destructive" />
      <strong>{title}</strong>
      {detail !== null && detail !== undefined && detail !== '' ? (
        <span className="text-xs text-muted-foreground">{detail}</span>
      ) : null}
      {children}
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <Icon name="refresh" size={16} /> {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

/* ── Error details ───────────────────────────────────────────────────────── */

export interface ErrorDetailsProps {
  details: readonly { path: string; issue: string }[];
  code?: string | null;
  status?: number | null;
  requestId?: string | null;
  occurredAt?: Date | null;
}

/**
 * The technical particulars, behind "View details".
 *
 * This exists so the answer to "developers need the detail" is not "dump the
 * JSON on the page". Same information, laid out — a raw envelope makes a reader
 * parse punctuation to find the one path that concerns them.
 *
 * Designed to sit inside the existing `Modal`, which is why it renders no
 * container or heading of its own.
 */
export function ErrorDetails({ details, code, status, requestId, occurredAt }: ErrorDetailsProps) {
  const meta: [string, string][] = [];
  if (code) {
    meta.push(['Code', code]);
  }
  if (typeof status === 'number') {
    meta.push(['Status', String(status)]);
  }
  if (requestId) {
    meta.push(['Request', requestId]);
  }
  if (occurredAt) {
    meta.push(['Time', occurredAt.toLocaleString()]);
  }

  return (
    <div className="flex flex-col gap-4">
      {details.length > 0 ? (
        <ol className="m-0 flex flex-col gap-3 pl-4 text-sm">
          {details.map((entry, position) => (
            <li key={`${entry.path}:${position}`} className="flex flex-col gap-0.5">
              <code className="font-mono text-xs text-accent-text [overflow-wrap:anywhere]">
                {entry.path}
              </code>
              <span>{entry.issue}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">No field-level detail was reported.</p>
      )}

      {meta.length > 0 ? (
        <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3 border-t border-border pt-3">
          {meta.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              {/*
                The request id is selectable text rather than a copy button: a
                user pasting it into a support message is the whole point, and
                one more control in a diagnostic panel earns less than it costs.
              */}
              <dd className="m-0 font-mono text-xs select-all [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
