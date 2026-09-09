/**
 * Reading a project's canonical definition (Phase 4 §9, §12, §20).
 *
 * One place, because three routes now need the same answer — Technical Notes,
 * the AI context and the Blueprint — and a second copy of this normalisation is
 * a second chance to forget one of its two halves.
 *
 * §20 will make this version-aware (Stage 8): `resolveSnapshot` in
 * `version-service.ts` is the seam, and it already returns the `SchemaSnapshot`
 * this function builds by hand for the live project. Nothing here anticipates
 * that beyond leaving the shape compatible.
 */

import type { IProject } from '@instantmockapi/db';
import { normaliseSnapshot, type InternalProjectSchema } from '@instantmockapi/ips';

/**
 * The project's current definition, normalised, with its addressing overlaid.
 *
 * Two normalisations, each a bug if skipped:
 *
 * `normaliseSnapshot` overlays `generationConfig` over the copy embedded in
 * `ips` — which `generation-service` can leave stale — and materializes
 * relations, so derived identity and foreign-key fields are present. This is
 * the same normalisation the compare page performs, reused rather than
 * restated.
 *
 * The addressing overlay follows `apps/workers/src/processor.ts`: *addressing
 * comes from the live project document, never from a snapshot*. `publicId` and
 * `slug` are versionless properties of the project, so a slug edited after a
 * snapshot was taken must not make a document advertise the old path.
 *
 * The blueprint exporter is handed this same value and drops the addressing
 * again, by never asking for it — see `buildBlueprint`. That is deliberate: one
 * function answers "what is this project's definition", and each consumer
 * decides what belongs in its own output.
 */
export function definitionOf(project: IProject): InternalProjectSchema {
  const normalised = normaliseSnapshot({
    version: project.currentVersion,
    ips: project.ips as InternalProjectSchema,
    config: project.generationConfig,
  });
  return {
    ...normalised,
    kind: project.kind ?? 'project',
    ...(project.publicId ? { publicId: project.publicId } : {}),
    ...(project.slug ? { slug: project.slug } : {}),
  };
}
