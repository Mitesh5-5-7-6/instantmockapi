import { describe, it, expect } from 'vitest';

import type { ArtifactSyncStateView, SyncReportView } from './api-types';
import { formatList, outOfSyncBadge, syncNotices } from './artifact-sync';

const state = (
  artifactType: string,
  over: Partial<ArtifactSyncStateView> = {},
): ArtifactSyncStateView => ({
  artifactType,
  generatedVersion: 4,
  outOfSync: false,
  missing: false,
  ...over,
});

const report = (over: Partial<SyncReportView> = {}): SyncReportView => ({
  publishedVersion: 4,
  artifacts: [],
  outOfSync: [],
  missing: [],
  ...over,
});

/** The §18 scenario: v4 is live, the OpenAPI was left at v3. */
const stale = report({
  artifacts: [
    state('hosted_api'),
    state('openapi', { generatedVersion: 3, outOfSync: true }),
    state('zod'),
  ],
  outOfSync: ['openapi'],
});

describe('outOfSyncBadge', () => {
  it('names both versions, since neither alone says how far behind', () => {
    const badge = outOfSyncBadge('openapi', stale)!;
    expect(badge.detail).toContain('v3');
    expect(badge.detail).toContain('v4');
  });

  it('says nothing about a file that is in step', () => {
    expect(outOfSyncBadge('zod', stale)).toBeNull();
  });

  it('says nothing when the view is pinned to a version', () => {
    // The route sends `sync: null` there, and a pinned view is a question about
    // one snapshot rather than about the registry's current state.
    expect(outOfSyncBadge('openapi', null)).toBeNull();
  });

  it('says nothing about a type the report does not cover', () => {
    expect(outOfSyncBadge('ips', stale)).toBeNull();
  });

  /**
   * `missing` is not a badge. It is true of every file of a project whose first
   * generation is still running, and the row's own StatusChip already reads
   * `pending` — so a badge here would tell the user the thing currently
   * generating had never been generated.
   */
  it('does not badge a file that has simply never completed', () => {
    const fresh = report({
      publishedVersion: null,
      artifacts: [state('openapi', { generatedVersion: null, missing: true })],
      missing: ['openapi'],
    });
    expect(outOfSyncBadge('openapi', fresh)).toBeNull();
  });
});

describe('syncNotices', () => {
  const present = ['json_schema', 'zod', 'openapi', 'hosted_api'];

  it('warns once, naming the files, the live version and the remedy', () => {
    const [notice, ...rest] = syncNotices(stale, present);
    expect(rest).toEqual([]);
    expect(notice!.variant).toBe('warning');
    expect(notice!.title).toBe('1 file is behind the live API');
    expect(notice!.detail).toContain('openapi');
    expect(notice!.detail).toContain('v4');
    expect(notice!.detail).toContain('Regenerate');
  });

  it('gets the plural right and reads the list aloud', () => {
    const notice = syncNotices(
      report({ outOfSync: ['openapi', 'postman'], artifacts: [] }),
      present,
    )[0]!;
    expect(notice.title).toBe('2 files are behind the live API');
    expect(notice.detail).toContain('openapi and postman');
  });

  it('says nothing at all when everything agrees', () => {
    expect(syncNotices(report(), present)).toEqual([]);
  });

  it('says nothing when the view is pinned to a version', () => {
    expect(syncNotices(null, present)).toEqual([]);
  });

  /**
   * A file mid-generation has a registry row, so the status chip covers it. A
   * file the configuration asks for with no row at all is invisible — there is
   * no card for it on the page — which is the only `missing` worth a sentence.
   */
  it('ignores a missing file that has a row, and names one that does not', () => {
    const notices = syncNotices(
      report({ missing: ['openapi', 'yup'] }),
      ['openapi'], // openapi is staged and pending; yup was never staged at all
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.variant).toBe('info');
    expect(notices[0]!.detail).toContain('yup');
    expect(notices[0]!.detail).not.toContain('openapi');
  });

  it('does not borrow the stale wording for a file that never existed', () => {
    // "Out of date" is false of something that was never produced, and the
    // remedy differs, so the two notices must not converge on one phrasing.
    const notice = syncNotices(report({ missing: ['yup'] }), [])[0]!;
    expect(notice.detail).not.toContain('behind');
    expect(notice.detail).not.toContain('no longer');
  });

  it('reports both conditions at once rather than hiding one behind the other', () => {
    const notices = syncNotices(
      report({
        artifacts: [state('openapi', { generatedVersion: 3, outOfSync: true })],
        outOfSync: ['openapi'],
        missing: ['yup'],
      }),
      ['openapi'],
    );
    expect(notices.map((notice) => notice.variant)).toEqual(['warning', 'info']);
  });
});

describe('formatList', () => {
  it('handles one, two and three', () => {
    expect(formatList(['a'])).toBe('a');
    expect(formatList(['a', 'b'])).toBe('a and b');
    expect(formatList(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('is empty for nothing, rather than "undefined"', () => {
    expect(formatList([])).toBe('');
  });
});
