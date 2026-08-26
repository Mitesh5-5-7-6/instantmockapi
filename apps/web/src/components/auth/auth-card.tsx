'use client';

/**
 * The frame every auth page shares (doc 13 §7.2).
 *
 * One component rather than a layout file because these pages are not nested
 * under a common route segment — `/login` and `/auth/callback/google` are in
 * different parts of the tree — and because the brand lockup, the width and the
 * centring have to match exactly across all six or the pages visibly jump as you
 * move between them.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Icon, IconTile } from '@instantmockapi/ui';

export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="auth-page">
      <main className="auth-card">
        {/* The same lockup as the sidebar, so signing in does not feel like a
            different product from the app behind it. */}
        <Link href="/login" className="auth-card__brand" aria-label="InstantMockAPI">
          <IconTile icon="code" tone="accent" size="sm" />
          <span className="ui-sidebar__brand">
            Instant<span>Mock</span>API
          </span>
        </Link>

        <div className="auth-card__head">
          <h1>{title}</h1>
          {subtitle !== undefined ? <p className="ui-meta">{subtitle}</p> : null}
        </div>

        {children}

        {footer !== undefined ? <div className="auth-card__foot">{footer}</div> : null}
      </main>

      <p className="auth-page__aside">
        <Link href="/demo/project-api/ecommerce">
          <Icon name="play" size={14} /> Explore the E-commerce API demo
        </Link>
      </p>
    </div>
  );
}

/**
 * A confirmation panel — "check your inbox", "your address is confirmed".
 *
 * Separate from the form rather than a message above it: after a successful
 * submit the form is no longer the thing to interact with, and leaving it on
 * screen invites a second submission that will be rate-limited.
 */
export function AuthNotice({
  tone = 'accent',
  icon,
  title,
  children,
}: {
  tone?: 'accent' | 'success' | 'warning';
  icon: 'mail' | 'check' | 'alert';
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="auth-notice">
      <IconTile icon={icon} tone={tone} size="md" />
      <div className="ui-stack ui-stack--tight">
        <strong>{title}</strong>
        {children}
      </div>
    </div>
  );
}
