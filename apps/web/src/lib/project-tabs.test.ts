import { describe, it, expect } from 'vitest';
import { PROJECT_TABS, activeProjectTab, projectTabHref } from './project-tabs';

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

  it('does not offer an Auth tab', () => {
    // Nothing backs it: no per-project keys, no runtime enforcement, no schema.
    expect(PROJECT_TABS.map((tab) => tab.label)).not.toContain('Auth');
  });

  it('gives generated artifacts a home', () => {
    // Real and useful, and absent from the target design entirely.
    expect(PROJECT_TABS.map((tab) => tab.label)).toContain('Files');
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
