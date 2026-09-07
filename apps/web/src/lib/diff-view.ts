/**
 * How the comparison page presents a diff.
 *
 * Pure, so the rules are testable — `apps/web` runs vitest with no DOM, so
 * anything asserted about this screen has to live in a function.
 *
 * Two rules do the work here, and both are about not lying:
 *
 * 1. **A glyph and a label, never colour alone** (§34). `+` / `−` / `~` carry
 *    the shape, an impact chip carries the severity, and the row text stays
 *    neutral — which is also what keeps a 400-row diff from becoming a wall of
 *    red and green, and what keeps the theme's green budget intact.
 * 2. **A backward comparison is a hypothetical.** `v4 → v2` is what a rollback
 *    *would* do, so the heading says "would" rather than presenting it as
 *    something that has happened.
 */

import type {
  ChangeImpact,
  ChangeType,
  GroupStatus,
  MatchingReportView,
  SchemaChangeView,
  TruncatedValue,
  VersionComparison,
} from './api-types';

/** The glyph for a change's shape. §34: colour is never the only indication. */
export const CHANGE_GLYPH: Record<ChangeType, string> = {
  ADDED: '+',
  REMOVED: '−',
  MODIFIED: '~',
  // A rename is a modification with a direction, and the arrow says so better
  // than a tilde does.
  RENAMED: '→',
};

export const GROUP_GLYPH: Record<GroupStatus, string> = {
  added: '+',
  removed: '−',
  modified: '~',
  renamed: '→',
};

/** The impact axis in words. Always shown as text, never as colour alone. */
export const IMPACT_LABEL: Record<ChangeImpact, string> = {
  BREAKING: 'Breaking',
  POTENTIALLY_BREAKING: 'May break callers',
  NON_BREAKING: 'Safe',
};

/**
 * Which `StatusChip` status renders each impact.
 *
 * Reusing the chip rather than restyling: it already enforces the coloured-dot,
 * neutral-label rule that keeps a long list readable.
 */
export const IMPACT_CHIP: Record<ChangeImpact, string> = {
  BREAKING: 'failed',
  POTENTIALLY_BREAKING: 'generating',
  NON_BREAKING: 'ready',
};

/** A `before`/`after` value that was too large to send whole. */
export function isTruncated(value: unknown): value is TruncatedValue {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { __truncated?: unknown }).__truncated === true
  );
}

/**
 * One side of a before/after pair, as a string a panel can show.
 *
 * `null` means "absent", which is different from the string `"null"` — an added
 * field has no before, and rendering `null` there would claim it used to hold
 * one. Callers distinguish the two.
 */
export function formatValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (isTruncated(value)) {
    return value.preview;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

export interface ValuePair {
  before: string | null;
  after: string | null;
  /** True when either side was capped on the wire. */
  truncated: boolean;
}

/**
 * The side-by-side pair for one change (§15).
 *
 * Built from `change.before`/`after` alone — the snapshots never cross the wire,
 * and they are not needed: a field group collects that field's type,
 * requiredness and validation changes together, so the panel is a render of one
 * group rather than of two schemas.
 */
export function valuePair(change: SchemaChangeView): ValuePair {
  return {
    before: formatValue(change.before),
    after: formatValue(change.after),
    truncated: isTruncated(change.before) || isTruncated(change.after),
  };
}

/** §36's header line. */
export function summaryLine(comparison: VersionComparison): string {
  const { total, changeTypes } = comparison.summary;
  if (total === 0) {
    return 'No changes';
  }
  const parts: string[] = [];
  const add = (count: number, word: string): void => {
    if (count > 0) {
      parts.push(`${count} ${word}`);
    }
  };
  add(changeTypes.ADDED, 'added');
  add(changeTypes.REMOVED, 'removed');
  add(changeTypes.MODIFIED, 'modified');
  add(changeTypes.RENAMED, 'renamed');

  return `${total} ${total === 1 ? 'change' : 'changes'} · ${parts.join(', ')}`;
}

/**
 * The heading, phrased for the direction.
 *
 * A backward pair is the user browsing history, so its impact report describes
 * something that has not happened. Saying "these APIs are affected" would be a
 * claim about the present; "would change" is the truth.
 */
export function directionHeading(comparison: VersionComparison): string {
  const { from, to, direction } = comparison;
  return direction === 'backward'
    ? `If you restored v${to.version}, this is what would change from v${from.version}`
    : `What changed between v${from.version} and v${to.version}`;
}

export type MatchingNoticeLevel = 'none' | 'entity' | 'page';

export interface MatchingNotice {
  level: MatchingNoticeLevel;
  message: string | null;
}

/**
 * How loudly to warn that a comparison rested on names.
 *
 * Three levels, and the gradation is the point: a caveat on a confident
 * comparison trains people to ignore the one that matters.
 *
 * - **none** — everything id-matched. Say nothing.
 * - **entity** — mixed. Badge the groups that earned it, not the whole page.
 * - **page** — neither side had ids. The whole structural comparison rests on
 *   names, and that has to appear above the summary.
 */
export function matchingNotice(matching: MatchingReportView): MatchingNotice {
  if (matching.legacyBothSides) {
    return {
      level: 'page',
      message:
        'These versions were snapshotted before this project had stable element ids, so they ' +
        'were compared by name. Renames cannot be detected: a renamed entity or field appears ' +
        'below as one removal and one addition. Additions, removals, type changes and validation ' +
        'changes are accurate.',
    };
  }
  if (matching.byName > 0) {
    return {
      level: 'entity',
      message:
        'Some entities had no stable id in one of these versions and were matched by name. A ' +
        'rename within them appears as a removal plus an addition.',
    };
  }
  return { level: 'none', message: null };
}

/**
 * The empty state (§38), gated on how the comparison was made.
 *
 * "No changes" is only an unqualified truth when both sides were id-matched.
 * Under name matching a rename would have surfaced as remove+add — so zero
 * changes really does mean identical — but the reader deserves to know which
 * question was answered, which is what turns the old "no changes detected" lie
 * into a true claim.
 */
export function emptyStateMessage(comparison: VersionComparison): string {
  return comparison.matching.legacyBothSides
    ? 'No differences found (compared by name).'
    : 'No changes detected between these versions.';
}
