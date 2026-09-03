/**
 * The application's notification API.
 *
 * Deliberately module functions rather than a hook: notifications are raised
 * from the action router, from a job stream callback, from an error boundary —
 * places that are not components and cannot call a hook. A context-only API
 * would leave those unable to notify at all, which is how a product ends up
 * with some failures announced and others silent.
 *
 * `useToasts` exists only so the viewport can render; nothing else should need
 * to read the queue.
 */

'use client';

import { useSyncExternalStore } from 'react';

import type { AppFailure } from './errors';
import {
  getToastState,
  pushToast,
  subscribeToasts,
  type Toast,
  type ToastAction,
  type ToastVariant,
} from './toast-store';

export { dismissToast, dismissToastByKey, clearToasts } from './toast-store';
export type { Toast, ToastVariant } from './toast-store';

/** Subscribe the viewport to the queue. */
export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(
    subscribeToasts,
    () => getToastState().toasts,
    // The server render has no notifications: the queue is populated by user
    // action, so an empty first paint is correct rather than a placeholder.
    () => getToastState().toasts,
  );
}

export function notifySuccess(title: string, detail?: string | null, key?: string): string {
  return pushToast({
    variant: 'success',
    title,
    detail: detail ?? null,
    action: null,
    failure: null,
    ...(key !== undefined ? { key } : {}),
  });
}

export function notifyInfo(title: string, detail?: string | null, key?: string): string {
  return pushToast({
    variant: 'info',
    title,
    detail: detail ?? null,
    action: null,
    failure: null,
    ...(key !== undefined ? { key } : {}),
  });
}

export function notifyWarning(title: string, detail?: string | null, key?: string): string {
  return pushToast({
    variant: 'warning',
    title,
    detail: detail ?? null,
    action: null,
    failure: null,
    ...(key !== undefined ? { key } : {}),
  });
}

/**
 * A notification for work in progress.
 *
 * Keyed by the caller so the outcome can replace it in place — `Generating…`
 * becoming `Version v5 generated` is one notification changing, not two stacked.
 * Never expires on its own; the outcome is what ends it.
 */
export function notifyLoading(key: string, title: string, detail?: string | null): string {
  return pushToast({
    variant: 'loading',
    title,
    detail: detail ?? null,
    action: null,
    failure: null,
    key,
  });
}

/**
 * A failure.
 *
 * `failure` rides along on the toast so `View details` has something to show
 * without the raising code having to hold the error itself. The dedupe key comes
 * from the failure, so three layers reporting the same failure produce one
 * notification.
 */
export function notifyFailure(
  failure: AppFailure,
  options: { action?: ToastAction | null; key?: string } = {},
): string {
  return pushToast({
    variant: failure.kind === 'VALIDATION' ? 'warning' : 'error',
    title: failure.title,
    detail: failure.detail,
    action: options.action ?? null,
    failure,
    key: options.key ?? failure.key,
  });
}

/** Escape hatch for a notification that is none of the above shapes. */
export function notify(input: {
  variant: ToastVariant;
  title: string;
  detail?: string | null;
  action?: ToastAction | null;
  key?: string;
}): string {
  return pushToast({
    variant: input.variant,
    title: input.title,
    detail: input.detail ?? null,
    action: input.action ?? null,
    failure: null,
    ...(input.key !== undefined ? { key: input.key } : {}),
  });
}
