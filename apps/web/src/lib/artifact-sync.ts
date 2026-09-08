/**
 * Rendering rules for §18's sync report.
 *
 * > Selective regeneration must never create invisible inconsistency.
 *
 * The server computes *what* is behind (`evaluateSyncState`); this decides what
 * the Files tab says about it. Kept as pure functions because `apps/web`'s
 * vitest runs with `environment: 'node'` — there is no DOM, so a rule that
 * lives inside a component cannot be tested at all.
 *
 * ## Why this is not simply "render the missing list"
 *
 * The report's `missing` means "no completed artifact at any version", which is
 * true of every file of a project whose first generation is still running. A
 * badge there would tell a user that the thing currently generating had never
 * been generated. The row's own `StatusChip` already says `pending`, so the
 * only `missing` worth a word is a file with no registry row at all — a type
 * the configuration asks for that no generation has ever staged.
 *
 * So the two conditions are reported differently, and neither is allowed to
 * borrow the other's wording:
 *
 * | condition | claim | remedy |
 * | --- | --- | --- |
 * | out of sync | the download describes a schema the API no longer serves | regenerate it |
 * | never staged | the configuration asks for it and it does not exist | generate it |
 */

import type { SyncReportView } from './api-types';

/** The per-card marker on a file that is behind the served version. */
export interface OutOfSyncBadge {
  label: string;
  /**
   * Which version it was built from and which one is live — the badge is
   * useless without both numbers, since "out of sync" alone does not say how
   * far behind or what it is behind.
   */
  detail: string;
}

export function outOfSyncBadge(
  artifactType: string,
  sync: SyncReportView | null,
): OutOfSyncBadge | null {
  if (sync === null) {
    return null;
  }
  const state = sync.artifacts.find((entry) => entry.artifactType === artifactType);
  if (state === undefined || !state.outOfSync || state.generatedVersion === null) {
    return null;
  }
  return {
    label: 'Out of sync',
    detail: `Built from v${state.generatedVersion} · the API serves v${sync.publishedVersion}`,
  };
}

export interface SyncNotice {
  variant: 'warning' | 'info';
  title: string;
  detail: string;
}

/**
 * The page-level summary, at most one notice per condition.
 *
 * A per-card badge is easy to miss in a scrolling grid, and the user who needs
 * this warning is the one who deselected the file and moved on. Both notices
 * can appear at once — suppressing "never generated" because something else is
 * stale would hide one problem behind another.
 *
 * `presentTypes` is the artifact types that have a registry row, which is what
 * separates "never staged" from "staged and still running".
 */
export function syncNotices(
  sync: SyncReportView | null,
  presentTypes: readonly string[],
): SyncNotice[] {
  if (sync === null) {
    return [];
  }
  const notices: SyncNotice[] = [];

  if (sync.outOfSync.length > 0) {
    const plural = sync.outOfSync.length > 1;
    notices.push({
      variant: 'warning',
      title: `${sync.outOfSync.length} file${plural ? 's are' : ' is'} behind the live API`,
      detail:
        `${formatList(sync.outOfSync)} ${plural ? 'were' : 'was'} built from an earlier ` +
        `version. The API is serving v${sync.publishedVersion}, so ${plural ? 'these downloads describe' : 'this download describes'} ` +
        `a schema it no longer returns. Regenerate ${plural ? 'them' : 'it'} to bring ${plural ? 'them' : 'it'} back in step.`,
    });
  }

  const neverStaged = sync.missing.filter((type) => !presentTypes.includes(type));
  if (neverStaged.length > 0) {
    const plural = neverStaged.length > 1;
    notices.push({
      variant: 'info',
      title: `${neverStaged.length} file${plural ? 's have' : ' has'} never been generated`,
      detail:
        `${formatList(neverStaged)} ${plural ? 'are' : 'is'} in this project's configuration ` +
        `but ${plural ? 'have' : 'has'} not been produced yet. Regenerate to add ${plural ? 'them' : 'it'}.`,
    });
  }

  return notices;
}

/** `a`, `a and b`, `a, b and c` — read aloud rather than comma-joined. */
export function formatList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items[0] ?? '';
  }
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}
