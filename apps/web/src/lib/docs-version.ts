/**
 * Choosing which definition the Docs tab describes (Phase 4 §20, §21).
 *
 * §20 requires the documentation to be version-aware, which on this side is two
 * questions: what may a reader choose, and what does each choice mean. Both are
 * here rather than in the page so they can be tested — `apps/web`'s vitest runs
 * in a node environment with no DOM, so rules live in modules and components
 * render them.
 */

/** The wire value for `?version=`. A number is stringified. */
export type DocsView = 'current' | 'draft' | 'published' | `${number}`;

export interface DocsViewOption {
  value: DocsView;
  label: string;
  /** Why a reader might pick this one, when the label alone is ambiguous. */
  hint?: string;
}

export interface DocsViewInput {
  currentVersion: number;
  /**
   * The published pointer, or null when nothing has been published.
   *
   * The API reports the pointer only when a deployment exists, and this side
   * follows: an option labelled "Published" on a project with no hosted URL
   * would offer a reader a distinction the platform does not have yet.
   */
  publishedVersion: number | null;
  /** Version numbers that have a stored snapshot, newest first or any order. */
  versions: readonly number[];
  /** Whether an uncommitted draft is open. */
  hasDraft: boolean;
}

/**
 * The views a reader may choose, in the order they should appear.
 *
 * Ordered newest-intent-first: the current definition, then the draft that sits
 * ahead of it, then the published one behind it, then history. That matches how
 * someone reasons about their own project — "what I have now, what I'm
 * changing, what's live, what it was".
 *
 * Duplicates are collapsed rather than shown twice: when the published version
 * *is* the current one, offering both would be two labels for one document.
 */
export function documentationViews(input: DocsViewInput): DocsViewOption[] {
  const options: DocsViewOption[] = [
    {
      value: 'current',
      label: `Current definition (v${input.currentVersion})`,
      hint:
        input.publishedVersion !== null && input.publishedVersion !== input.currentVersion
          ? 'What the editor shows. Not what the hosted API serves.'
          : undefined,
    },
  ];

  if (input.hasDraft) {
    options.push({
      value: 'draft',
      label: 'Draft (uncommitted)',
      hint: 'Edits you have not committed. Never served.',
    });
  }

  if (input.publishedVersion !== null && input.publishedVersion !== input.currentVersion) {
    options.push({
      value: 'published',
      label: `Published (v${input.publishedVersion})`,
      hint: 'The definition the hosted API is serving.',
    });
  }

  /*
   * History, newest first, excluding whatever is already offered above.
   *
   * The current version usually has a snapshot row of its own, so without the
   * exclusion the list would read "Current definition (v3)" followed by "v3".
   */
  const already = new Set<number>([input.currentVersion]);
  if (input.publishedVersion !== null) {
    already.add(input.publishedVersion);
  }
  for (const version of [...input.versions].sort((a, b) => b - a)) {
    if (already.has(version)) {
      continue;
    }
    options.push({ value: `${version}`, label: `v${version}` });
  }

  return options;
}

/**
 * The compare link §21 asks for, or null when there is nothing to compare.
 *
 * §21 says Technical Notes should offer "View Changes" and must not implement a
 * second diff engine — so this is a link into Phase 2's existing compare page,
 * which already renders `ChangeKind`, `risk`, `aspect` and `classifyImpact`.
 *
 * The pair is *(previous → this)*, because the question a reader has while
 * looking at one version's document is "what changed to get here". v1 has no
 * predecessor, and a draft is not a version, so both return null rather than a
 * link that would 404 or compare a thing against itself.
 */
export function viewChangesHref(
  projectId: string,
  view: DocsView,
  resolvedVersion: number,
): string | null {
  if (view === 'draft') {
    /*
     * A draft's changes are reviewed in the editor, not on the compare page:
     * the compare route takes two *version numbers*, and a draft has no number
     * of its own until it is committed.
     */
    return null;
  }
  if (resolvedVersion <= 1) {
    return null;
  }
  return `/projects/${projectId}/versions/compare?from=${resolvedVersion - 1}&to=${resolvedVersion}`;
}

/**
 * How a document's own view is described back to the reader.
 *
 * Reads off what the *server* resolved rather than what was requested, because
 * the two can differ — `published` and `current` both resolve to a number, and
 * `serving` is the server's answer about the deployment.
 */
export function describeDocsSource(source: string, version: number, serving: boolean): string {
  if (source === 'draft') {
    return 'the uncommitted draft — not served';
  }
  if (serving) {
    return `v${version}, which the hosted API is serving`;
  }
  return `v${version}, which is not currently served`;
}
