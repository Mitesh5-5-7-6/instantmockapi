'use client';

/**
 * App shell (doc 11): sidebar nav + top bar with plan indicator and account.
 *
 * Gates on auth — an unauthenticated visitor is redirected to `/login`. The
 * sign-in form used to live *in here* as a card, which meant it had no URL;
 * see `PUBLIC_PREFIXES` below for why that changed.
 */

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button, Icon, IconTile } from '@instantmockapi/ui';
import { useMe, useRestoreSession } from '../lib/hooks';
import { VISIBLE_NAV_ITEMS, isNavActive } from '../lib/nav-items';
import { usesWideContent } from '../lib/project-tabs';
import { SidebarPlanCard } from './sidebar-plan-card';
import { SidebarProfile } from './sidebar-profile';
import { TopSearch } from './top-search';
import { AppFooter } from './app-footer';

/**
 * Paths that render bare, with no shell and no auth gate.
 *
 * The sign-in form used to be a card rendered *inside* this component, which
 * meant it had no URL of its own — nothing could link to it, a failed
 * verification could not send anyone anywhere, and the browser's back button did
 * nothing useful. These are real routes instead.
 *
 * An allowlist rather than a Next route group (`app/(auth)/` + `app/(app)/`):
 * the route group is the tidier structure but means moving every existing page
 * directory, and this is three lines and reversible. The route group stays
 * available if the auth surface grows.
 */
const PUBLIC_PREFIXES = [
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/auth/',
  // Demo routes are public product surfaces — replacing them with a sign-in
  // screen would make the marketing link dead for exactly the people it is for.
  '/demo',
] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) =>
      pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
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
  const router = useRouter();
  // Mounted here, above everything that fetches: the access token lives in memory
  // only, so on every page load the app has to spend one request asking the API
  // whether the refresh cookie is still good.
  const authState = useRestoreSession();
  const me = useMe();
  const [navOpen, setNavOpen] = useState(false);
  const isPublic = isPublicPath(pathname);

  // Redirect rather than render a sign-in card in place: an unauthenticated
  // visitor to /projects should end up at a URL that says /login, so the browser
  // history and any deep link behave sensibly. `me.isError` is included because a
  // rejected session looks the same to the user as no session.
  const shouldRedirect = !isPublic && (authState === 'anonymous' || me.isError);
  useEffect(() => {
    if (shouldRedirect) {
      router.replace('/login');
    }
  }, [shouldRedirect, router]);

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

  // Auth pages and demo routes render bare — no shell, no gate. Checked before
  // anything else so an unauthenticated visitor can actually reach /login rather
  // than being redirected to it from itself.
  if (isPublic) {
    return <>{children}</>;
  }

  // Not signed in, or the session was rejected — send them to the sign-in route.
  // `router.replace`, not a rendered card: the URL has to change, or a failed
  // verification link has nowhere to send anyone and the back button does
  // nothing. The redirect lives in an effect because navigating during render is
  // not allowed.
  if (authState === 'anonymous' || me.isError) {
    return <Splash />;
  }

  // Auth state not resolved yet — the server render, or the boot refresh still
  // in flight — or /v1/me still loading. Rendering anything decisive here would
  // flash a sign-in screen at already-signed-in visitors on every page load.
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
          <Link href="/demo-api" style={{ marginLeft: 'var(--space-2)' }}>
            <Button size="sm">
              <Icon name="play" size={16} /> Demo API
            </Button>
          </Link>
        </header>
        {/* Opt-in per route: only the dashboard has two columns to fill. Every
            other screen keeps the 1100px reading measure. */}
        <main className={usesWideContent(pathname) ? 'ui-main ui-main--wide' : 'ui-main'}>
          {children}
        </main>
        <AppFooter />
      </div>
    </div>
  );
}
