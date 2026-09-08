import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_TABS, activeProjectTab, projectTabHref, usesWideContent } from './project-tabs';

const ID = '6a8e85c01cd07f3a6413b60a';

describe('PROJECT_TABS', () => {
  it('has exactly one index tab', () => {
    // Two empty segments would both claim `/projects/{id}` and both highlight.
    expect(PROJECT_TABS.filter((tab) => tab.segment === '')).toHaveLength(1);
  });

  it('has unique segments and labels', () => {
    expect(new Set(PROJECT_TABS.map((tab) => tab.segment)).size).toBe(PROJECT_TABS.length);
    expect(new Set(PROJECT_TABS.map((tab) => tab.label)).size).toBe(PROJECT_TABS.length);
  });

  /**
   * This assertion used to be its inverse.
   *
   * Through Phases 1 and 2 the rule was *no Auth tab*, for a stated reason:
   * "nothing backs it — no per-project keys, no runtime enforcement, no
   * schema." Phase 3 built all three (`MockAuthSecret`, the runtime's
   * protection gate, `ips.authentication`), so the guard was satisfied the only
   * way it should have been, by building the thing rather than by deleting the
   * check.
   *
   * Kept as a positive assertion rather than removed, so the tab cannot quietly
   * disappear either — and `every tab has a route` below still refuses a tab
   * that links to a 404.
   */
  it('offers an Auth tab, now that Phase 3 backs one', () => {
    expect(PROJECT_TABS.map((tab) => tab.label)).toContain('Auth');
  });

  it('gives generated artifacts a home', () => {
    // Real and useful, and absent from the target design entirely.
    expect(PROJECT_TABS.map((tab) => tab.label)).toContain('Files');
  });
});

/**
 * The guard that was missing.
 *
 * `PROJECT_TABS` listed a Settings tab for which no `page.tsx` was ever written,
 * so the strip rendered a link straight to a Next 404. Every other test in this
 * file passed — they check the pure href/segment round trip, which cannot know
 * whether a file exists on disk.
 *
 * Touching the filesystem in a unit test is a deliberate exception: the thing
 * being asserted *is* a filesystem fact, and nothing cheaper catches it.
 */
describe('every tab has a route', () => {
  const ROUTES = join(process.cwd(), 'src', 'app', 'projects', '[id]');

  it.each([...PROJECT_TABS])('$label resolves to a page file', (tab) => {
    const file =
      tab.segment === '' ? join(ROUTES, 'page.tsx') : join(ROUTES, tab.segment, 'page.tsx');
    expect(existsSync(file), `${tab.label} tab points at a route with no page: ${file}`).toBe(true);
  });
});

describe('projectTabHref', () => {
  it('keeps the index tab on the bare project path', () => {
    // Not `/projects/{id}/overview` — a redundant segment for the default view,
    // and it would make the canonical project URL a redirect.
    expect(projectTabHref(ID, '')).toBe(`/projects/${ID}`);
  });

  it('appends other segments', () => {
    expect(projectTabHref(ID, 'logs')).toBe(`/projects/${ID}/logs`);
  });

  it('builds a resolvable href for every tab', () => {
    for (const tab of PROJECT_TABS) {
      expect(activeProjectTab(projectTabHref(ID, tab.segment), ID)).toBe(tab.segment);
    }
  });
});

describe('activeProjectTab', () => {
  it('resolves the index tab, with or without a trailing slash', () => {
    expect(activeProjectTab(`/projects/${ID}`, ID)).toBe('');
    expect(activeProjectTab(`/projects/${ID}/`, ID)).toBe('');
  });

  it('resolves a named tab', () => {
    expect(activeProjectTab(`/projects/${ID}/settings`, ID)).toBe('settings');
  });

  it('ignores anything deeper than the tab segment', () => {
    // A deep link inside a tab still highlights that tab.
    expect(activeProjectTab(`/projects/${ID}/files/openapi`, ID)).toBe('files');
  });

  /**
   * `/progress/{jobId}` is a real route with no tab of its own. Falling back to
   * the index tab would light up Overview while the user is on the progress
   * board — telling them they are somewhere they are not.
   */
  it('returns null for a route that has no tab', () => {
    expect(activeProjectTab(`/projects/${ID}/progress/job-1`, ID)).toBeNull();
    expect(activeProjectTab(`/projects/${ID}/ready`, ID)).toBeNull();
  });

  it('returns null for another project, and for unrelated paths', () => {
    expect(activeProjectTab('/projects/other/logs', ID)).toBeNull();
    expect(activeProjectTab('/projects', ID)).toBeNull();
    expect(activeProjectTab('/', ID)).toBeNull();
  });

  /**
   * A prefix collision: the id must be a whole segment. Without the `/`
   * boundary, `/projects/{ID}extra/logs` would resolve as this project.
   */
  it('does not match a project id that is only a prefix', () => {
    expect(activeProjectTab(`/projects/${ID}extra/logs`, ID)).toBeNull();
  });
});

describe('usesWideContent', () => {
  it('widens the dashboard', () => {
    expect(usesWideContent('/')).toBe(true);
  });

  /**
   * The gutter a user asked about: at 1920px the workspace sat in a 1100px
   * column. These screens are tables, logs and generated code, not prose.
   */
  it('widens every project workspace tab', () => {
    for (const tab of PROJECT_TABS) {
      expect(usesWideContent(projectTabHref(ID, tab.segment)), tab.label).toBe(true);
    }
  });

  it('widens the editor', () => {
    expect(usesWideContent(`/projects/${ID}/edit`)).toBe(true);
  });

  /**
   * `styles.css` is specific about this one: widening pulls each artifact's
   * status chip away from its name across a gap nobody can track.
   */
  it('leaves the progress board narrow', () => {
    expect(usesWideContent(`/projects/${ID}/progress`)).toBe(false);
    expect(usesWideContent(`/projects/${ID}/progress/job-1`)).toBe(false);
  });

  it('leaves the creation wizards and everything else narrow', () => {
    expect(usesWideContent('/new/project')).toBe(false);
    expect(usesWideContent('/new/single')).toBe(false);
    expect(usesWideContent('/projects')).toBe(false);
    expect(usesWideContent('/settings')).toBe(false);
    expect(usesWideContent('/demo-api')).toBe(false);
  });
});
