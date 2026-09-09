import { describe, it, expect } from 'vitest';
import { describeDocsSource, documentationViews, viewChangesHref } from './docs-version';

/**
 * Choosing which definition the Docs tab describes (Phase 4 §20, §21).
 *
 * The behaviour worth pinning is what the list *does not* offer: a duplicate
 * for a published version that is also the current one, a history entry for a
 * version already named above, a Draft option when no draft exists, or a
 * Published option on a project with nothing deployed. Each of those would ask
 * a reader to distinguish two things that are the same, or offer a view that
 * cannot load.
 */

const input = (over: Record<string, unknown> = {}) => ({
  currentVersion: 3,
  publishedVersion: 2,
  versions: [1, 2, 3],
  hasDraft: false,
  ...over,
});

const values = (over: Record<string, unknown> = {}) =>
  documentationViews(input(over) as never).map((option) => option.value);

describe('documentationViews', () => {
  it('offers current, published and the remaining history', () => {
    expect(values()).toEqual(['current', 'published', '1']);
  });

  it('adds the draft when one is open, before the published view', () => {
    expect(values({ hasDraft: true })).toEqual(['current', 'draft', 'published', '1']);
  });

  /**
   * One document, one option. When the published version *is* the current one,
   * two labels would name the same definition — and a reader who picked the
   * second would reasonably expect something different.
   */
  it('does not offer Published separately when it is the current version', () => {
    expect(values({ publishedVersion: 3 })).toEqual(['current', '2', '1']);
  });

  it('offers no Published view when nothing is deployed', () => {
    expect(values({ publishedVersion: null })).toEqual(['current', '2', '1']);
  });

  it('never repeats a version already named above', () => {
    const all = values({ versions: [1, 2, 3, 4], currentVersion: 4, publishedVersion: 2 });
    expect(all).toEqual(['current', 'published', '3', '1']);
    expect(new Set(all).size).toBe(all.length);
  });

  it('orders history newest first, whatever order it arrives in', () => {
    expect(values({ versions: [1, 5, 3], currentVersion: 6, publishedVersion: null })).toEqual([
      'current',
      '5',
      '3',
      '1',
    ]);
  });

  it('works for a project with a single version', () => {
    expect(values({ currentVersion: 1, publishedVersion: 1, versions: [1] })).toEqual(['current']);
  });

  /**
   * The current view's hint exists only when it could mislead — when the
   * definition has moved ahead of what is served. On a project where they
   * match, the hint would be noise.
   */
  it('warns that the current definition is not what is served, only when true', () => {
    const [current] = documentationViews(input() as never);
    expect(current?.hint).toContain('Not what the hosted API serves');

    const [matched] = documentationViews(input({ publishedVersion: 3 }) as never);
    expect(matched?.hint).toBeUndefined();
  });
});

describe('viewChangesHref', () => {
  /**
   * §21: reuse Phase 2's compare page rather than building a second diff. The
   * pair is (previous → this), which answers "what changed to get here".
   */
  it('links the previous version to this one', () => {
    expect(viewChangesHref('p1', '3', 3)).toBe('/projects/p1/versions/compare?from=2&to=3');
  });

  it('uses the resolved version, not the requested keyword', () => {
    // `published` resolves server-side, so the link has to follow the answer.
    expect(viewChangesHref('p1', 'published', 2)).toBe('/projects/p1/versions/compare?from=1&to=2');
  });

  it('offers nothing for v1, which has no predecessor', () => {
    expect(viewChangesHref('p1', 'current', 1)).toBeNull();
  });

  /**
   * A draft has no version number until it is committed, and the compare route
   * takes two numbers — so its changes are reviewed in the editor instead.
   */
  it('offers nothing for a draft', () => {
    expect(viewChangesHref('p1', 'draft', 3)).toBeNull();
  });
});

describe('describeDocsSource', () => {
  it('names a draft as never served', () => {
    expect(describeDocsSource('draft', 3, false)).toContain('not served');
  });

  it('says a served definition is served', () => {
    expect(describeDocsSource('version', 2, true)).toBe('v2, which the hosted API is serving');
  });

  it('says an unserved one is not', () => {
    expect(describeDocsSource('version', 1, false)).toBe('v1, which is not currently served');
  });
});
