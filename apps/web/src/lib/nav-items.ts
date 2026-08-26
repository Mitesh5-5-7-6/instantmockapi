/**
 * The sidebar's navigation model, and the rule for which item is highlighted.
 *
 * Kept out of the shell component so `isNavActive` can be tested — it has three
 * separate edge cases and a silent failure mode (two items highlighting at
 * once) that only a test will catch.
 *
 * The full nine-item nav from the design is declared here, with the four that
 * have no backing feature tagged `planned` and filtered out of what renders.
 * Declaring them costs nothing and keeps the intended shape visible in one
 * place; the alternative — deleting them — loses the design intent, and shipping
 * stub routes would teach users a feature exists. Promoting one is a one-word
 * change.
 */

import type { IconName } from '@instantmockapi/ui';

export interface NavItem {
  href: string;
  label: string;
  /** Typed against the real icon set, so a wrong name is a compile error. */
  icon: IconName;
  /** `planned` items are declared but never rendered. */
  status: 'ready' | 'planned';
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: 'home', status: 'ready' },
  { href: '/projects', label: 'Projects', icon: 'folder', status: 'ready' },
  { href: '/demo/project-api/ecommerce', label: 'Demo API', icon: 'play', status: 'ready' },
  { href: '/templates', label: 'Templates', icon: 'file-code', status: 'ready' },
  { href: '/collections', label: 'Collections', icon: 'layers', status: 'planned' },
  { href: '/requests', label: 'Requests', icon: 'inbox', status: 'planned' },
  { href: '/environments', label: 'Environments', icon: 'target', status: 'planned' },
  { href: '/analytics', label: 'Analytics', icon: 'bar-chart', status: 'planned' },
  { href: '/settings', label: 'Settings', icon: 'settings', status: 'ready' },
];

/** The items the sidebar actually renders. */
export const VISIBLE_NAV_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => item.status === 'ready');

/**
 * Whether a nav item should be marked as the current page.
 *
 * Prefix matching rather than equality, because the deep routes are where this
 * matters: on `/projects/{id}`, `/projects/{id}/ready` or `/new/single`, exact
 * equality highlights nothing at all and the sidebar looks broken.
 *
 * Two details that a naive `startsWith` gets wrong:
 *  - `'/'` has to be exact, or Dashboard lights up on every page.
 *  - the trailing slash in the prefix stops `/new` from matching `/newsletter`.
 */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
