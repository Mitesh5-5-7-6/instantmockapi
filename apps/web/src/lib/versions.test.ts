import { describe, it, expect } from 'vitest';

import type { VersionStatus } from './api-types';
import type { VersionView } from './hooks';
import { describeChangeType, summariseVersion, toVersionRow } from './versions';

/**
 * The rules §5 states, tested as functions rather than as rendering.
 *
 * `apps/web` runs vitest with `environment: 'node'` and no DOM, so anything
 * asserted about this screen has to live in a pure module — which is why the
 * view model exists separately from the page at all.
 */
function version(over: Partial<VersionView> = {}): VersionView {
  return {
    id: 'v1',
    projectId: 'p1',
    version: 1,
    note: null,
    createdAt: new Date().toISOString(),
    parentVersion: null,
    changeType: null,
    changeSummary: null,
    publishedAt: null,
    rollbackSourceVersion: null,
    ...over,
  };
}

const row = (status: VersionStatus | undefined, published: number | null, at = 1) =>
  toVersionRow(version({ version: at, ...(status === undefined ? {} : { status }) }), published);

describe('who can publish', () => {
  it('offers Publish on a READY version', () => {
    expect(row('READY', 1, 2).canPublish).toBe(true);
  });

  /**
   * `DEGRADED` is publishable, and that is a deliberate match to the server.
   *
   * A failed OpenAPI degrades a version rather than blocking it, so the
   * promotion policy accepts it. Excluding it here would produce a version the
   * server would happily publish and the UI never offered — the user would have
   * no way to bring their working API live because a docs generator failed.
   */
  it('offers Publish on a DEGRADED version, because the server accepts one', () => {
    expect(row('DEGRADED', 1, 2).canPublish).toBe(true);
  });

  it('never offers Publish on the live version', () => {
    // §5, explicitly. Re-publishing is a no-op the server tolerates; offering
    // the button would invite it.
    expect(row('PUBLISHED', 2, 2).canPublish).toBe(false);
    expect(row('READY', 2, 2).canPublish).toBe(false);
  });

  it.each<[VersionStatus, string]>([
    ['GENERATING', 'Still generating'],
    ['FAILED', 'Generation failed'],
    ['PENDING', 'Not generated yet'],
  ])('refuses %s and says why', (status, reason) => {
    const view = row(status, 1, 2);
    expect(view.canPublish).toBe(false);
    expect(view.publishBlockedReason).toBe(reason);
  });

  it('offers a retry on a failed version instead of a publish', () => {
    const view = row('FAILED', 1, 2);
    expect(view.canPublish).toBe(false);
    expect(view.canRetry).toBe(true);
  });

  it('points a superseded version at restore rather than at publish', () => {
    // Publishing an older version backwards is a rollback, which the server
    // refuses — so the row says what to do instead.
    const view = row('SUPERSEDED', 5, 2);
    expect(view.canPublish).toBe(false);
    expect(view.publishBlockedReason).toContain('Restore');
  });
});

describe('a row written before Phase 2', () => {
  it('is treated as unknown rather than as ready', () => {
    // No status on the wire means the server could not derive one. Guessing
    // READY would offer a Publish the server may refuse.
    const view = row(undefined, 1, 2);
    expect(view.status).toBeNull();
    expect(view.label).toBe('Unknown');
    expect(view.canPublish).toBe(false);
  });

  it('is still recognisable as the live one', () => {
    // The pointer, not the derived status, is what makes a row live — and §18
    // requires the live version to be unmistakable even for an old project.
    const view = row(undefined, 2, 2);
    expect(view.isLive).toBe(true);
    expect(view.label).toBe('Live');
    expect(view.tone).toBe('live');
  });
});

describe('the live pointer outranks the derived status', () => {
  it('shows the served version as live even if its artifacts have since failed', () => {
    // They agree in practice. If they ever disagree, the pointer is the one
    // answering requests, and reporting a running API as FAILED would be wrong.
    const view = row('FAILED', 3, 3);
    expect(view.isLive).toBe(true);
    expect(view.status).toBe('PUBLISHED');
    expect(view.canRetry).toBe(false);
  });
});

describe('tones', () => {
  it('gives DEGRADED an amber tone rather than green', () => {
    // Publishable, and worth looking at first.
    expect(row('DEGRADED', 1, 2).tone).toBe('progress');
  });

  it('keeps superseded and pending neutral, so a list is not a wall of colour', () => {
    expect(row('SUPERSEDED', 5, 2).tone).toBe('neutral');
    expect(row('PENDING', 1, 2).tone).toBe('neutral');
  });

  it('assigns a tone and a label to every declared status', () => {
    const statuses: VersionStatus[] = [
      'PUBLISHED',
      'SUPERSEDED',
      'READY',
      'DEGRADED',
      'GENERATING',
      'FAILED',
      'PENDING',
    ];
    for (const status of statuses) {
      const view = row(status, 99, 2);
      expect(view.label, status).not.toBe('');
      expect(['live', 'ready', 'progress', 'failed', 'neutral'], status).toContain(view.tone);
    }
  });
});

describe('summariseVersion', () => {
  const counts = (over: Partial<NonNullable<VersionView['changeSummary']>> = {}) => ({
    entitiesAdded: 0,
    entitiesRemoved: 0,
    entitiesModified: 0,
    fieldsAdded: 0,
    fieldsRemoved: 0,
    fieldsModified: 0,
    relationsAdded: 0,
    relationsRemoved: 0,
    relationsModified: 0,
    endpointsAdded: 0,
    endpointsRemoved: 0,
    endpointsModified: 0,
    ...over,
  });

  it('reports null when nothing was recorded, so the row can fall back to the note', () => {
    // Rendering "0 changes" would state a fact nobody established.
    expect(summariseVersion(version())).toBeNull();
    expect(summariseVersion(version({ changeSummary: counts() }))).toBeNull();
  });

  it('sums each kind across added, removed and modified', () => {
    expect(
      summariseVersion(
        version({
          changeSummary: counts({ fieldsAdded: 2, fieldsModified: 1, endpointsModified: 3 }),
        }),
      ),
    ).toBe('3 fields · 3 endpoints');
  });

  it('gets the singular right, including for entities', () => {
    expect(summariseVersion(version({ changeSummary: counts({ entitiesAdded: 1 }) }))).toBe(
      '1 entity',
    );
    expect(summariseVersion(version({ changeSummary: counts({ entitiesAdded: 2 }) }))).toBe(
      '2 entities',
    );
    expect(summariseVersion(version({ changeSummary: counts({ fieldsAdded: 1 }) }))).toBe(
      '1 field',
    );
  });
});

describe('describeChangeType', () => {
  it('names a rollback and where it came from', () => {
    expect(describeChangeType(version({ changeType: 'ROLLBACK', rollbackSourceVersion: 2 }))).toBe(
      'Rollback to v2',
    );
  });

  it('still names a rollback with no recorded source', () => {
    expect(describeChangeType(version({ changeType: 'ROLLBACK' }))).toBe('Rollback');
  });

  it('distinguishes a regeneration from an edit', () => {
    // The definition did not change, only which artifacts were built from it.
    // Without this, a history of three regenerations reads like three edits.
    expect(describeChangeType(version({ changeType: 'REGENERATION' }))).toBe('Regenerated');
  });

  it('says nothing for an ordinary feature version', () => {
    // The row already shows a timestamp and a change summary; "Feature" adds
    // noise to every line.
    expect(describeChangeType(version({ changeType: 'FEATURE' }))).toBeNull();
    expect(describeChangeType(version())).toBeNull();
  });

  it('names an initial version', () => {
    expect(describeChangeType(version({ changeType: 'INITIAL' }))).toBe('Initial version');
  });
});

describe('who can be rolled back to', () => {
  /**
   * Keyed on the definition version, not the live one. The draft a rollback
   * seeds is forked from the current definition, so restoring *that* version
   * produces a draft identical to it — the review screen would read "No
   * changes" and the button would look broken.
   */
  const rollback = (at: number, published: number | null, current: number | null) =>
    toVersionRow(version({ version: at }), published, current).canRollBack;

  it('offers a rollback to an older version', () => {
    expect(rollback(2, 4, 4)).toBe(true);
  });

  it('does not offer a rollback to the current definition', () => {
    expect(rollback(4, 4, 4)).toBe(false);
  });

  /**
   * The live version is a real rollback target when the definition has moved
   * past it — v4 live, v5 committed and generating: reverting the *definition*
   * to v4 is a genuine edit even though callers already get v4.
   */
  it('still offers a rollback to the live version when the definition has moved on', () => {
    expect(rollback(4, 4, 5)).toBe(true);
  });

  it('falls back to the live pointer while the project is still loading', () => {
    // Rather than offering a rollback that would turn out to be a no-op.
    expect(rollback(4, 4, null)).toBe(false);
    expect(rollback(2, 4, null)).toBe(true);
  });
});
