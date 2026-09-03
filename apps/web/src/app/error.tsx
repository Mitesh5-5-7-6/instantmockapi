'use client';

/**
 * Fallback for an unexpected render error anywhere in the app.
 *
 * Next's App Router convention: a thrown error during render is caught here and
 * this replaces the segment's content, with the shell — sidebar, nav, the
 * notification outlet — still around it. That is why this is the ordinary case
 * and `global-error.tsx` is the last resort.
 *
 * §24 of the error spec: an unexpected runtime error must produce a controlled
 * experience rather than a blank page or a stack trace.
 */

import { useEffect } from 'react';
import { ErrorState } from '@instantmockapi/ui';

export default function SegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Developer-facing, not user-facing. The message and stack go to the console
    // (and to whatever collects it) while the user sees a sentence — §25 keeps
    // those two audiences apart.
    console.error('Unhandled render error', error);
  }, [error]);

  return (
    <ErrorState
      title="Something went wrong"
      detail="This part of the page could not be displayed. Trying again will usually fix it."
      onRetry={reset}
    >
      {/*
        Next's `digest` is a hash of the error, and the only handle a user can
        quote for a failure that never reached the API — so it is worth showing,
        in the same quiet register as a request id, and never as the message.
      */}
      {error.digest ? <span className="ui-meta ui-mono">Reference: {error.digest}</span> : null}
    </ErrorState>
  );
}
