'use client';

/**
 * App shell (doc 11): sidebar nav + top bar with plan indicator and account.
 * Gates on auth — unauthenticated visitors see the sign-in card instead.
 */

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button, Card, Input, StatusChip } from '@instantmockapi/ui';
import { useAuthState, useLogin, useLogout, useMe } from '../lib/hooks';
import { VISIBLE_NAV_ITEMS, isNavActive } from '../lib/nav-items';

function LoginScreen() {
  const login = useLogin();
  const [email, setEmail] = useState('');
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Card className="ui-stack">
        <div>
          <h1 style={{ marginBottom: 'var(--space-1)' }}>
            Instant<span style={{ color: 'var(--accent)' }}>Mock</span>API
          </h1>
          <p className="ui-meta">Turn a schema into a working backend in minutes.</p>
        </div>
        <form
          className="ui-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (email) {
              login.mutate(email);
            }
          }}
        >
          <Input
            type="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-label="Email"
          />
          <Button type="submit" disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : 'Continue with email'}
          </Button>
          {login.isError ? (
            <p className="ui-error" role="alert">
              {login.error.message}
            </p>
          ) : null}
        </form>
      </Card>
    </div>
  );
}

function Splash() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <p className="ui-meta">Loading…</p>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const authState = useAuthState();
  const me = useMe();
  const logout = useLogout();

  // No token, or the token was rejected (apiFetch clears it after a failed
  // refresh) — back to sign-in. Both flip reactively, so signing in swaps the
  // screen over without a page refresh.
  if (authState === 'anonymous' || me.isError) {
    return <LoginScreen />;
  }

  // Auth state not resolved yet (server render / pre-hydration), or /v1/me
  // still in flight.
  if (authState === 'unknown' || !me.data) {
    return <Splash />;
  }

  return (
    <div className="ui-shell">
      <aside className="ui-sidebar">
        <div className="ui-sidebar__brand">
          Instant<span>Mock</span>API
        </div>
        <nav className="ui-nav" aria-label="Primary">
          {VISIBLE_NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isNavActive(pathname, item.href) ? 'page' : undefined}
            >
              {/* Wrapped rather than a bare text child: the collapsed sidebar
                  hides the label with CSS, which needs an element to target. */}
              <span className="ui-nav__label">{item.label}</span>
            </Link>
          ))}
        </nav>
      </aside>
      <div>
        <header className="ui-topbar">
          <span className="ui-meta ui-mono">{me.data.email}</span>
          <div className="ui-row">
            <StatusChip status="active" label={`${me.data.plan} plan`} />
            <Button variant="ghost" size="sm" onClick={() => logout.mutate()}>
              Sign out
            </Button>
          </div>
        </header>
        <main className="ui-main">{children}</main>
      </div>
    </div>
  );
}
