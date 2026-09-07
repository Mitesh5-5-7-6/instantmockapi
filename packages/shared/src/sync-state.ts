/**
 * Which generated artifacts are behind the definition (Phase 2 §18).
 *
 * ## The rule this enforces
 *
 * > Selective regeneration must never create invisible inconsistency.
 *
 * §17 lets a user deselect an affected artifact, which is a real convenience —
 * a docs rebuild is slow and often not urgent. But the moment they do, the
 * OpenAPI on disk describes a schema the API no longer serves, and nothing about
 * the download says so. The user's next move is to hand that spec to somebody.
 *
 * So the deselection is allowed and the consequence is *named*: an artifact
 * whose newest completed version is behind the definition is out of sync, and
 * says which version it was built from.
 *
 * ## Why this is computed rather than stored
 *
 * `Artifact` is already keyed `(projectId, artifactType, version)`, so "which
 * version is this artifact at" is a fact the registry holds. A stored
 * `outOfSync` flag would be a cache of it — and one that goes stale in the one
 * direction that matters, because it would have to be cleared by whatever
 * regenerates the artifact.
 *
 * ## Which version is the baseline
 *
 * The **published** version, not `currentVersion`. An artifact matching the
 * version that is actually being served is consistent with what callers get; an
 * uncommitted or ungenerated edit ahead of it is a separate condition
 * (`pendingRegeneration`) with a separate remedy. Conflating them would flag
 * every artifact of every project the instant somebody opened the editor.
 */

import type { ArtifactType } from './constants.js';

/** One artifact, reduced to what the comparison needs. */
export interface ArtifactVersionRow {
  artifactType: ArtifactType;
  version: number;
  /** Only a completed artifact counts — a failed one is absent, not stale. */
  status: 'pending' | 'generating' | 'completed' | 'failed';
}

export interface ArtifactSyncState {
  artifactType: ArtifactType;
  /** The newest version this artifact completed at, or null if never. */
  generatedVersion: number | null;
  /** True when it is behind the version being served. */
  outOfSync: boolean;
  /**
   * True when it has never completed at any version.
   *
   * Distinct from out-of-sync: there is nothing stale to warn about, and the
   * remedy is "generate it" rather than "regenerate it". A UI that conflated
   * them would tell a user their missing Postman collection was out of date.
   */
  missing: boolean;
}

export interface SyncReport {
  /** The version the comparison was made against. */
  publishedVersion: number | null;
  artifacts: ArtifactSyncState[];
  /** Artifacts behind the published version. Empty when everything agrees. */
  outOfSync: ArtifactType[];
  /** Artifacts that have never completed. */
  missing: ArtifactType[];
}

/**
 * Compare every artifact against the version being served.
 *
 * `expected` is the artifact set the project's configuration asks for, so an
 * artifact nobody selected is not reported as missing — a project generating no
 * Postman collection has not lost one.
 */
export function evaluateSyncState(params: {
  publishedVersion: number | null;
  rows: readonly ArtifactVersionRow[];
  expected: readonly ArtifactType[];
}): SyncReport {
  const { publishedVersion, rows, expected } = params;

  // Newest COMPLETED version per type. A row that is pending, generating or
  // failed says nothing about what is on disk from an earlier run.
  const newest = new Map<ArtifactType, number>();
  for (const row of rows) {
    if (row.status !== 'completed') {
      continue;
    }
    const current = newest.get(row.artifactType);
    if (current === undefined || row.version > current) {
      newest.set(row.artifactType, row.version);
    }
  }

  const artifacts: ArtifactSyncState[] = expected.map((artifactType) => {
    const generatedVersion = newest.get(artifactType) ?? null;
    return {
      artifactType,
      generatedVersion,
      missing: generatedVersion === null,
      // Nothing published means nothing is being served, so nothing can be
      // inconsistent with it yet.
      outOfSync:
        publishedVersion !== null &&
        generatedVersion !== null &&
        generatedVersion < publishedVersion,
    };
  });

  return {
    publishedVersion,
    artifacts,
    outOfSync: artifacts.filter((state) => state.outOfSync).map((state) => state.artifactType),
    missing: artifacts.filter((state) => state.missing).map((state) => state.artifactType),
  };
}
