/**
 * The project workspace's tab set.
 *
 * Kept as data rather than JSX so the layout renders it in one loop and the route
 * files cannot drift from the strip — a tab whose route does not exist, or a route
 * with no tab, is the failure mode this prevents.
 */

import type { IconName } from '@instantmockapi/ui';

export interface ProjectTab {
  /** Path segment appended to `/projects/{id}`. Empty string is the index tab. */
  segment: string;
  label: string;
  icon: IconName;
}

/**
 * Seven tabs, matching the target design's shape with one substitution.
 *
 * **No Auth tab.** Hosted mock APIs have no per-project auth model — no keys, no
 * enforcement in the runtime, nothing in the schema. A tab explaining its own
 * absence is worse than no tab.
 *
 * **Files replaces it**, because generated artifacts (types, validators, docs,
 * Postman collections) are real, useful, and had no home in the design at all.
 */
export const PROJECT_TABS: readonly ProjectTab[] = [
  { segment: '', label: 'Overview', icon: 'home' },
  { segment: 'apis', label: 'APIs', icon: 'target' },
  { segment: 'schema', label: 'Schema', icon: 'layers' },
  { segment: 'versions', label: 'Versions', icon: 'clock' },
  { segment: 'auth', label: 'Auth', icon: 'lock' },
  { segment: 'mock-data', label: 'Mock Data', icon: 'database' },
  { segment: 'logs', label: 'Logs', icon: 'activity' },
  { segment: 'files', label: 'Files', icon: 'file-code' },
  { segment: 'activity', label: 'Activity', icon: 'clock' },
  { segment: 'settings', label: 'Settings', icon: 'settings' },
];

/**
 * Tabs an Auth API project has nothing to put in.
 *
 * Not hidden to tidy the strip — hidden because each one would render an empty
 * state explaining that this kind of project has no entities, which is a worse
 * answer than not offering the question. `Schema`, `APIs` and `Mock Data` all
 * enumerate entities, and an Auth API project has none.
 *
 * `Schema` is the arguable one: an auth project *may* gain an entity later, and
 * `editorCapabilities` supports it. But the route to do that is "Edit data
 * model" in the header, which stays available — a tab is a claim about what the
 * project is mostly made of, and for this kind that claim would be wrong.
 */
const AUTH_KIND_HIDDEN: readonly string[] = ['apis', 'schema', 'mock-data'];

/**
 * The auth configuration tab, relabelled for an Auth API project.
 *
 * On a Project API, `Auth` is one aspect among several and the name is right.
 * On a project that *is* authentication, a tab called `Auth` says nothing —
 * everything here is auth. What the user actually manages there is which
 * endpoints exist and what sign-up collects, so it takes the name the wizard
 * gave it.
 */
const AUTH_KIND_RELABEL: Record<string, string> = { auth: 'Endpoints' };

/**
 * The tabs a project of this kind should show.
 *
 * Derived from one list rather than three, so a new tab is added in a single
 * place and the filesystem guard still covers every route. An unrecognised or
 * absent kind gets the full set — the superset, so the failure mode is an
 * offered tab rather than a hidden one.
 */
export function projectTabsFor(kind: 'project' | 'single' | 'auth' | undefined): ProjectTab[] {
  if (kind !== 'auth') {
    return [...PROJECT_TABS];
  }
  return PROJECT_TABS.filter((tab) => !AUTH_KIND_HIDDEN.includes(tab.segment)).map((tab) => {
    const label = AUTH_KIND_RELABEL[tab.segment];
    return label === undefined ? tab : { ...tab, label };
  });
}

/** Absolute href for a tab. */
export function projectTabHref(projectId: string, segment: string): string {
  return segment === '' ? `/projects/${projectId}` : `/projects/${projectId}/${segment}`;
}

/**
 * Which tab a pathname is on.
 *
 * Matches the segment immediately after the project id and ignores anything
 * deeper, so `/projects/x/progress/job-1` — a route with no tab of its own —
 * resolves to no tab rather than falsely highlighting Overview.
 */
export function activeProjectTab(pathname: string, projectId: string): string | null {
  const base = `/projects/${projectId}`;
  if (pathname === base || pathname === `${base}/`) {
    return '';
  }
  if (!pathname.startsWith(`${base}/`)) {
    return null;
  }
  const segment = pathname.slice(base.length + 1).split('/')[0] ?? '';
  return PROJECT_TABS.some((tab) => tab.segment === segment) ? segment : null;
}

/**
 * Which routes get the wide content measure.
 *
 * `.ui-main` caps content at 1100px — a reading measure, and the right default
 * for prose and for the creation wizards. `--content-wide` (1440px) is an
 * explicit per-route opt-in, and until now only the dashboard used it, so a
 * project workspace on a 1920px display sat in a 1100px column with a ~700px
 * gutter of nothing.
 *
 * The project workspace is the same class of screen as the dashboard: tables,
 * logs, a request list, generated code. It earns the room.
 *
 * **The progress board deliberately does not.** The styles.css note is specific
 * about it — widening pulls each artifact's status chip away from its name,
 * across a gap nobody can track — so it keeps the narrow measure. The creation
 * wizards keep it too, being forms.
 */
export function usesWideContent(pathname: string): boolean {
  if (pathname === '/') {
    return true;
  }
  // A project workspace tab: /projects/{id} and /projects/{id}/{tab}.
  const match = /^\/projects\/[^/]+(?:\/([^/]+))?/.exec(pathname);
  if (match === null) {
    return false;
  }
  return match[1] !== 'progress';
}
