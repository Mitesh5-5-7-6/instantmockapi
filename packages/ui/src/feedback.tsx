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
 */

import type { ReactNode } from 'react';

import { Button } from './components.js';
import { Icon, type IconName } from './icons.js';

export type FeedbackVariant = 'success' | 'error' | 'warning' | 'info' | 'loading';

const VARIANT_ICONS: Record<FeedbackVariant, IconName> = {
  success: 'check',
  error: 'x',
  warning: 'alert',
  info: 'lightbulb',
  loading: 'refresh',
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
  return (
    <div className={`ui-toast ui-toast--${variant}`}>
      <Icon name={VARIANT_ICONS[variant]} size={16} />
      <div className="ui-toast__body">
        <strong className="ui-toast__title">{title}</strong>
        {detail !== null && detail !== undefined && detail !== '' ? (
          <span className="ui-toast__detail">{detail}</span>
        ) : null}
        {action ? (
          <button type="button" className="ui-toast__action" onClick={action.onClick}>
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
        className="ui-toast__dismiss"
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
      className="ui-toast-viewport"
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
    <div className="ui-formerror" role="alert">
      <Icon name="alert" size={16} />
      <div className="ui-formerror__body">
        <strong>{title}</strong>
        {detail !== null && detail !== undefined && detail !== '' ? <span>{detail}</span> : null}
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
 * the counterpart to `EmptyState` — same shape, different reason for the absence.
 */
export function ErrorState({
  title,
  detail,
  onRetry,
  retryLabel = 'Try again',
  children,
}: ErrorStateProps) {
  return (
    <div className="ui-empty ui-errorstate" role="alert">
      <Icon name="alert" size={24} />
      <strong>{title}</strong>
      {detail !== null && detail !== undefined && detail !== '' ? (
        <span className="ui-meta">{detail}</span>
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
    <div className="ui-stack ui-errordetails">
      {details.length > 0 ? (
        <ol className="ui-errordetails__list">
          {details.map((entry, position) => (
            <li key={`${entry.path}:${position}`}>
              <code className="ui-mono">{entry.path}</code>
              <span>{entry.issue}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="ui-meta">No field-level detail was reported.</p>
      )}

      {meta.length > 0 ? (
        <dl className="ui-errordetails__meta">
          {meta.map(([label, value]) => (
            <div key={label}>
              <dt className="ui-meta">{label}</dt>
              {/*
                The request id is selectable text rather than a copy button: a
                user pasting it into a support message is the whole point, and
                one more control in a diagnostic panel earns less than it costs.
              */}
              <dd className="ui-mono">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
