import { describe, it, expect } from 'vitest';
import { NAV_ITEMS, VISIBLE_NAV_ITEMS, isNavActive } from './nav-items';

describe('isNavActive', () => {
  it('highlights a nav item on its own page', () => {
    expect(isNavActive('/projects', '/projects')).toBe(true);
    expect(isNavActive('/settings', '/settings')).toBe(true);
  });

  it('highlights the parent on a deep route — the bug this exists to fix', () => {
    // Under exact equality none of these highlighted anything, so the sidebar
    // went blank the moment you opened a project.
    expect(isNavActive('/projects/abc123', '/projects')).toBe(true);
    expect(isNavActive('/projects/abc123/ready', '/projects')).toBe(true);
    expect(isNavActive('/projects/abc123/progress/job1', '/projects')).toBe(true);
  });

  it('matches Dashboard only on the root', () => {
    // Every href starts with '/', so a plain prefix test would light Dashboard
    // up on every page in the app.
    expect(isNavActive('/', '/')).toBe(true);
    expect(isNavActive('/projects', '/')).toBe(false);
    expect(isNavActive('/settings', '/')).toBe(false);
  });

  it('does not match a sibling route that merely shares a prefix', () => {
    // The trailing slash in the comparison is what stops this.
    expect(isNavActive('/newsletter', '/new')).toBe(false);
    expect(isNavActive('/projectsomething', '/projects')).toBe(false);
    expect(isNavActive('/settings-old', '/settings')).toBe(false);
  });

  it('still matches the real child of such a route', () => {
    expect(isNavActive('/new/single', '/new')).toBe(true);
    expect(isNavActive('/new/project', '/new')).toBe(true);
  });

  it('does not match an unrelated path', () => {
    expect(isNavActive('/templates', '/projects')).toBe(false);
  });
});

describe('the nav model', () => {
  it('renders only items with a real destination', () => {
    expect(VISIBLE_NAV_ITEMS.map((item) => item.href)).toEqual([
      '/',
      '/projects',
      '/demo/project-api/ecommerce',
      '/templates',
      '/settings',
    ]);
  });

  it('keeps the planned items declared but unrendered', () => {
    const planned = NAV_ITEMS.filter((item) => item.status === 'planned').map((item) => item.href);
    expect(planned).toEqual(['/collections', '/requests', '/environments', '/analytics']);
    for (const href of planned) {
      expect(VISIBLE_NAV_ITEMS.some((item) => item.href === href)).toBe(false);
    }
  });

  it('never highlights two items at once', () => {
    // The failure mode: add /projects/single as a nav item and both it and
    // /projects light up, with nothing on screen explaining why. Asserting no
    // visible href is a prefix of another is cheaper than longest-match logic,
    // and it fails the moment someone introduces the conflict.
    for (const item of VISIBLE_NAV_ITEMS) {
      for (const other of VISIBLE_NAV_ITEMS) {
        if (item.href === other.href || other.href === '/') {
          continue;
        }
        expect(item.href.startsWith(`${other.href}/`)).toBe(false);
      }
    }
  });

  it('gives every item an icon name, so the sidebar can render one per row', () => {
    for (const item of NAV_ITEMS) {
      expect(item.icon).toMatch(/^[a-z][a-z-]*$/);
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});
