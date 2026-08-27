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
  { segment: 'mock-data', label: 'Mock Data', icon: 'database' },
  { segment: 'logs', label: 'Logs', icon: 'activity' },
  { segment: 'files', label: 'Files', icon: 'file-code' },
  { segment: 'activity', label: 'Activity', icon: 'clock' },
  { segment: 'settings', label: 'Settings', icon: 'settings' },
];

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
