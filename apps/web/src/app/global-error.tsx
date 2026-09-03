'use client';

/**
 * Last-resort fallback: the root layout itself failed.
 *
 * This replaces the entire document, which is why it renders its own `<html>`
 * and `<body>` — there is no layout left to provide them. It also means none of
 * the app's chrome is available: no sidebar, no notification outlet, and no
 * `@instantmockapi/ui` component can be relied upon, since a broken import is
 * one of the ways to get here.
 *
 * So the styling is inline. That is a deliberate exception to the design
 * system's rules rather than an oversight: a fallback that depends on the thing
 * that just failed is not a fallback.
 */

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Unhandled application error', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          // Hard-coded to the dark theme's tokens. The stylesheet may not have
          // loaded, and unreadable text is a worse failure than the wrong theme.
          background: '#000000',
          color: '#f2f2f2',
          fontFamily: "'Geist', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        <main style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ fontSize: 25, fontWeight: 600, margin: '0 0 8px' }}>Something went wrong</h1>
          <p style={{ color: '#a1a1aa', fontSize: 14, margin: '0 0 20px' }}>
            The application could not be loaded. Reloading will usually fix it.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: 40,
              padding: '0 16px',
              border: '1px solid #242424',
              borderRadius: 10,
              background: 'transparent',
              color: '#f2f2f2',
              font: 'inherit',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {error.digest ? (
            <p
              style={{
                marginTop: 20,
                color: '#a1a1aa',
                fontSize: 12,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
