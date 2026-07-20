'use client';

/**
 * App shell (doc 11): sidebar nav + top bar with plan indicator and account.
 * Gates on auth — unauthenticated visitors see the sign-in card instead.
 */

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button, Card, Input, StatusChip } from '@instantmockapi/ui';
import { useLogin, useLogout, useMe } from '../lib/hooks';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard' },
  { href: '/new', label: 'New Project' },
  { href: '/templates', label: 'Templates' },
  { href: '/settings', label: 'Settings' },
];

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

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const me = useMe();
  const logout = useLogout();

  if (me.isError || (!me.isLoading && !me.data && !me.isFetching)) {
    return <LoginScreen />;
  }

  return (
    <div className="ui-shell">
      <aside className="ui-sidebar">
        <div className="ui-sidebar__brand">
          Instant<span>Mock</span>API
        </div>
        <nav className="ui-nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div>
        <header className="ui-topbar">
          <span className="ui-meta ui-mono">{me.data?.email ?? ''}</span>
          <div className="ui-row">
            {me.data ? <StatusChip status="active" label={`${me.data.plan} plan`} /> : null}
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
