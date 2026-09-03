'use client';

/**
 * The single notification outlet, mounted once for the whole application.
 *
 * "Once" is the entire design. What this replaces is a product where each screen
 * decided where its own errors appeared, so a user could not learn where to
 * look. There must be exactly one of these in the tree.
 *
 * It owns two things the pure layers cannot: the position preference (which
 * lives in `localStorage` and so cannot be read during a server render) and the
 * details modal (which needs a mounted dialog).
 */

import { useEffect, useState } from 'react';
import { ErrorDetails, Modal, Toast, ToastViewport } from '@instantmockapi/ui';

import { dismissToast, useToasts } from '../lib/toast';
import type { Toast as ToastModel } from '../lib/toast-store';
import {
  DEFAULT_TOAST_POSITION,
  readToastPosition,
  stacksUpward,
  TOAST_POSITION_CHANGED,
  TOAST_POSITION_KEY,
  type ToastPosition,
} from '../lib/toast-position';

export function ToastHost() {
  const toasts = useToasts();
  const [position, setPosition] = useState<ToastPosition>(DEFAULT_TOAST_POSITION);
  const [inspecting, setInspecting] = useState<ToastModel | null>(null);

  /**
   * The preference is read after mount, not during render.
   *
   * `localStorage` does not exist on the server, and reading it during render
   * would make the first client paint disagree with the server's — a hydration
   * mismatch. Unlike the theme there is nothing to flash: an empty viewport
   * looks identical wherever it is anchored.
   */
  useEffect(() => {
    setPosition(readToastPosition());
  }, []);

  /**
   * Follow the setting when it changes in this tab or another.
   *
   * The `storage` event covers other tabs; the custom event covers this one,
   * because a tab does not receive its own `storage` events. Without the second,
   * changing the position in Settings would appear to do nothing until reload.
   */
  useEffect(() => {
    const sync = (): void => setPosition(readToastPosition());
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === TOAST_POSITION_KEY) {
        sync();
      }
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(TOAST_POSITION_CHANGED, sync);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(TOAST_POSITION_CHANGED, sync);
    };
  }, []);

  // An empty region still announces itself to assistive tech on some
  // combinations, so it is not rendered until there is something to say.
  if (toasts.length === 0 && inspecting === null) {
    return null;
  }

  return (
    <>
      <ToastViewport
        position={position}
        stackUpward={stacksUpward(position)}
        hasUrgent={toasts.some((toast) => toast.duration === null)}
      >
        {toasts.map((toast) => (
          <Toast
            key={toast.id}
            variant={toast.variant}
            title={toast.title}
            detail={toast.detail}
            // `View details` is offered only when there is something to show.
            // A button that opens an empty panel is worse than no button.
            action={
              toast.action ??
              (toast.failure !== null && hasInspectableDetail(toast)
                ? { label: 'View details', onClick: () => setInspecting(toast) }
                : null)
            }
            onDismiss={() => dismissToast(toast.id)}
          />
        ))}
      </ToastViewport>

      <Modal
        open={inspecting !== null}
        onClose={() => setInspecting(null)}
        title={inspecting?.title ?? 'Details'}
      >
        {inspecting?.failure ? (
          <ErrorDetails
            details={inspecting.failure.details}
            code={inspecting.failure.code}
            status={inspecting.failure.status}
            requestId={inspecting.failure.requestId}
            occurredAt={new Date()}
          />
        ) : null}
      </Modal>
    </>
  );
}

/**
 * Whether a failure has anything worth a panel.
 *
 * Field detail is obviously worth it. So is a request id on its own — that is
 * the handle a user quotes when reporting a 500, and it is the only place it
 * appears.
 */
function hasInspectableDetail(toast: ToastModel): boolean {
  const failure = toast.failure;
  if (failure === null) {
    return false;
  }
  return failure.details.length > 0 || failure.requestId !== null;
}
