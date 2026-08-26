'use client';

/**
 * App shell (doc 11): sidebar nav + top bar with plan indicator and account.
 * Gates on auth — unauthenticated visitors see the sign-in card instead.
 */

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button, Card, Icon, IconTile, Input } from '@instantmockapi/ui';
import { useAuthState, useLogin, useMe } from '../lib/hooks';
import { VISIBLE_NAV_ITEMS, isNavActive } from '../lib/nav-items';
import { SidebarPlanCard } from './sidebar-plan-card';
import { SidebarProfile } from './sidebar-profile';
import { TopSearch } from './top-search';
import { AppFooter } from './app-footer';

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
  const [navOpen, setNavOpen] = useState(false);

  // Close the drawer whenever the route changes. Without this, tapping a nav
  // link on a phone leaves the drawer sitting over the page it just opened.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  // Escape closes it too — it behaves like a dismissable overlay, so it should
  // answer to the key that dismisses one.
  useEffect(() => {
    if (!navOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setNavOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [navOpen]);

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
    <div className="ui-shell" data-nav-open={navOpen ? 'true' : undefined}>
      {/* Only rendered as a visible layer below 720px; above that the CSS keeps
          it display:none regardless of state. */}
      <div className="ui-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />

      <aside className="ui-sidebar" id="primary-nav">
        <div className="ui-row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
          <IconTile icon="code" tone="accent" size="sm" />
          <span className="ui-sidebar__brand">
            Instant<span>Mock</span>API
          </span>
        </div>
        <nav className="ui-nav" aria-label="Primary">
          {VISIBLE_NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              title={item.label}
              aria-current={isNavActive(pathname, item.href) ? 'page' : undefined}
            >
              {/* The anchor carries the label, not the Icon: beside visible text
                  an icon announcing "folder Projects" is noise, but in the
                  collapsed icon rail the text is hidden and the anchor's own
                  label is the only thing left to announce. */}
              <Icon name={item.icon} size={18} />
              {/* Wrapped rather than a bare text child: the collapsed sidebar
                  hides the label with CSS, which needs an element to target. */}
              <span className="ui-nav__label">{item.label}</span>
            </Link>
          ))}
        </nav>

        {/* Pinned to the bottom of the rail by one auto margin. */}
        <div className="ui-sidebar__footer">
          <SidebarPlanCard />
          <SidebarProfile />
        </div>
      </aside>
      <div className="ui-shell__content">
        <header className="ui-topbar">
          <Button
            className="ui-navtoggle"
            variant="ghost"
            size="sm"
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={navOpen}
            aria-controls="primary-nav"
            onClick={() => setNavOpen((open) => !open)}
          >
            <Icon name={navOpen ? 'x' : 'menu'} size={18} />
          </Button>
          <TopSearch />
          <Link href="/new">
            <Button size="sm">
              <Icon name="plus" size={16} /> New
            </Button>
          </Link>
        </header>
        {/* Opt-in per route: only the dashboard has two columns to fill. Every
            other screen keeps the 1100px reading measure. */}
        <main className={pathname === '/' ? 'ui-main ui-main--wide' : 'ui-main'}>{children}</main>
        <AppFooter />
      </div>
    </div>
  );
}
