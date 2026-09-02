/**
 * Version runtime state, read from the artifact registry (Phase 1).
 *
 * The step between "a job settled" and "should the live pointer move":
 *
 *     Job settles
 *          ▼
 *     Artifact statuses updated
 *          ▼
 *     Version runtime state recalculated   ← this module
 *          ▼
 *     Promotion policy evaluated           ← packages/shared/src/promotion.ts
 *          ▼
 *     project.publishedVersion moves
 *
 * ## Why it reads the registry rather than trusting the job
 *
 * A partial regenerate touches a subset of artifacts. "What this job produced"
 * and "what this version has" are therefore different questions, and only the
 * second decides whether the runtime can be pointed at the version. A job that
 * regenerated only `openapi` says nothing about whether `hosted_api` exists — but
 * the version might already have a completed one from an earlier job, in which
 * case it is perfectly serveable.
 *
 * That distinction is what makes Phase 1's affected-artifacts-only regeneration
 * safe: regenerate three of nine artifacts, and readiness is still judged on all
 * nine.
 *
 * ## Why readiness is computed, not stored
 *
 * A `Version.runtimeStatus` column would be a cache of the artifact rows, and a
 * cache that can drift from the thing it caches. The rows are already indexed on
 * `{projectId, artifactType, version}`, so this is one cheap query at the only
 * moment the answer is needed. The `Artifact` collection stays the single source
 * of truth for what exists.
 */

import type { ArtifactOutcome, ArtifactType } from '@instantmockapi/shared';
// Type-only: keeps this module usable from a lean projection.
import type { Types } from 'mongoose';
import { Artifact } from './models/artifact.js';

/**
 * Every artifact row recorded for one version, reduced to the promotion
 * policy's input shape.
 *
 * Absent rows are simply not returned. The policy treats "never generated" and
 * "generated and failed" identically for a required artifact, because to the
 * runtime they are the same thing: no config to serve.
 */
export async function versionArtifactOutcomes(
  projectId: string | Types.ObjectId,
  version: number,
): Promise<ArtifactOutcome[]> {
  const rows = await Artifact.find({ projectId, version })
    .select('artifactType status')
    .lean<{ artifactType: ArtifactType; status: ArtifactOutcome['status'] }[]>();

  return rows.map((row) => ({ artifactType: row.artifactType, status: row.status }));
}
