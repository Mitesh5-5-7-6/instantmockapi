import { describe, it, expect } from 'vitest';

import { evaluateSyncState, type ArtifactVersionRow } from './sync-state.js';
import type { ArtifactType } from './constants.js';

/**
 * §18: *"Selective regeneration must never create invisible inconsistency."*
 *
 * Deselecting an affected artifact is allowed. What is not allowed is the user
 * not knowing — so these tests are mostly about the distinctions that make the
 * warning honest rather than alarming.
 */

const row = (
  artifactType: ArtifactType,
  version: number,
  status: ArtifactVersionRow['status'] = 'completed',
): ArtifactVersionRow => ({ artifactType, version, status });

const EXPECTED: ArtifactType[] = ['hosted_api', 'openapi', 'zod'];

const report = (rows: ArtifactVersionRow[], publishedVersion: number | null = 4) =>
  evaluateSyncState({ publishedVersion, rows, expected: EXPECTED });

describe('an artifact behind the served version', () => {
  it('is reported as out of sync, with the version it was built from', () => {
    // The exact §18 scenario: the schema is v4, the OpenAPI is v3, and the
    // download describes an API that is no longer being served.
    const result = report([row('hosted_api', 4), row('openapi', 3), row('zod', 4)]);

    expect(result.outOfSync).toEqual(['openapi']);
    const openapi = result.artifacts.find((a) => a.artifactType === 'openapi')!;
    expect(openapi.generatedVersion).toBe(3);
    expect(openapi.missing).toBe(false);
  });

  it('reports nothing when every artifact matches', () => {
    const result = report([row('hosted_api', 4), row('openapi', 4), row('zod', 4)]);
    expect(result.outOfSync).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('does not flag an artifact AHEAD of the served version', () => {
    // Per-artifact version skew is a designed feature: regenerating one
    // artifact at v5 while v4 is still live is ahead, not stale. Flagging it
    // would tell the user their newest output was out of date.
    const result = report([row('hosted_api', 4), row('openapi', 5), row('zod', 4)]);
    expect(result.outOfSync).toEqual([]);
  });
});

describe('missing is not the same as out of sync', () => {
  /**
   * The remedy differs — "generate it" rather than "regenerate it" — so
   * conflating them would tell a user their never-built Postman collection was
   * out of date.
   */
  it('reports an artifact that never completed as missing, not stale', () => {
    const result = report([row('hosted_api', 4), row('zod', 4)]);

    expect(result.missing).toEqual(['openapi']);
    expect(result.outOfSync).toEqual([]);
    const openapi = result.artifacts.find((a) => a.artifactType === 'openapi')!;
    expect(openapi.generatedVersion).toBeNull();
  });

  it('ignores an artifact the project does not ask for', () => {
    // A project generating no Postman collection has not lost one.
    const result = evaluateSyncState({
      publishedVersion: 4,
      rows: [row('hosted_api', 4)],
      expected: ['hosted_api'],
    });
    expect(result.missing).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
  });
});

describe('only a completed artifact counts', () => {
  /**
   * A pending, generating or failed row says nothing about what is on disk from
   * an earlier run — so it must not overwrite the version that actually exists.
   */
  it('ignores an in-flight row and keeps the last completed version', () => {
    const result = report([
      row('hosted_api', 4),
      row('openapi', 3),
      row('openapi', 4, 'generating'),
      row('zod', 4),
    ]);

    // The v4 attempt has not finished, so v3 is still what is downloadable —
    // and still out of sync.
    const openapi = result.artifacts.find((a) => a.artifactType === 'openapi')!;
    expect(openapi.generatedVersion).toBe(3);
    expect(result.outOfSync).toEqual(['openapi']);
  });

  it('treats a failed attempt as absent rather than as progress', () => {
    const result = report([row('hosted_api', 4), row('openapi', 4, 'failed'), row('zod', 4)]);
    expect(result.missing).toEqual(['openapi']);
  });

  it('takes the newest completed version when several exist', () => {
    const result = report([
      row('hosted_api', 4),
      row('openapi', 2),
      row('openapi', 3),
      row('zod', 4),
    ]);
    expect(result.artifacts.find((a) => a.artifactType === 'openapi')!.generatedVersion).toBe(3);
  });
});

describe('the baseline is the published version', () => {
  /**
   * Not `currentVersion`. An artifact matching what is being served is
   * consistent with what callers actually get; an uncommitted edit ahead of it
   * is `pendingRegeneration`, a different condition with a different remedy.
   *
   * Conflating them would flag every artifact of every project the moment
   * somebody opened the editor.
   */
  it('reports nothing out of sync when nothing has been published', () => {
    const result = report([row('hosted_api', 1), row('openapi', 1), row('zod', 1)], null);
    expect(result.outOfSync).toEqual([]);
    expect(result.publishedVersion).toBeNull();
  });

  it('compares against the served version even when artifacts exist beyond it', () => {
    const result = report([row('hosted_api', 4), row('openapi', 3), row('zod', 9)], 4);
    // zod at v9 is ahead of the live v4 and is fine; openapi at v3 is behind.
    expect(result.outOfSync).toEqual(['openapi']);
  });
});

describe('the report shape', () => {
  it('lists every expected artifact, in the order asked for', () => {
    // So a UI renders a stable grid rather than a list that reorders as
    // artifacts come and go.
    const result = report([row('hosted_api', 4)]);
    expect(result.artifacts.map((a) => a.artifactType)).toEqual(EXPECTED);
  });

  it('never reports an artifact as both missing and out of sync', () => {
    const result = report([row('hosted_api', 3)]);
    for (const state of result.artifacts) {
      expect(state.missing && state.outOfSync, state.artifactType).toBe(false);
    }
  });
});
