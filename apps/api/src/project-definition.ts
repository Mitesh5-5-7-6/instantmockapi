/**
 * Reading a project's canonical definition (Phase 4 §9, §12, §20).
 *
 * One place, because five callers now need the same answer — Technical Notes,
 * the AI context, blueprint export, duplicate, and §20's version-aware views —
 * and a second copy of this normalisation is a second chance to forget one of
 * its two halves.
 */

import { hasPendingRegeneration, publishedVersionOf, type IProject } from '@instantmockapi/db';
import { AppError } from '@instantmockapi/shared';
import {
  normaliseSnapshot,
  type InternalProjectSchema,
  type SchemaSnapshot,
} from '@instantmockapi/ips';
import type { RuntimeFacts } from '@instantmockapi/generator-docs';
import { loadDraft } from './draft-service.js';
import { resolveSnapshot } from './version-service.js';

/**
 * A snapshot's definition, normalised, with the project's addressing overlaid.
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
 * snapshot was taken must not make a document advertise the old path. That
 * matters more here than anywhere: a historical version's snapshot may carry a
 * slug from before a rename.
 *
 * The blueprint exporter is handed this same value and drops the addressing
 * again, by never asking for it — see `buildBlueprint`. That is deliberate: one
 * function answers "what is this definition", and each consumer decides what
 * belongs in its own output.
 */
export function definitionOfSnapshot(
  project: IProject,
  snapshot: SchemaSnapshot,
): InternalProjectSchema {
  const normalised = normaliseSnapshot(snapshot);
  return {
    ...normalised,
    kind: project.kind ?? 'project',
    ...(project.publicId ? { publicId: project.publicId } : {}),
    ...(project.slug ? { slug: project.slug } : {}),
  };
}

/** The project's *current* definition — what the editor shows. */
export function definitionOf(project: IProject): InternalProjectSchema {
  return definitionOfSnapshot(project, {
    version: project.currentVersion,
    ips: project.ips as InternalProjectSchema,
    config: project.generationConfig,
  });
}

/* ────────────────── version-aware documentation (§20) ────────────────── */

/**
 * Which definition a document should describe.
 *
 * §20 names three views — a historical version, the draft, the published
 * version — and the platform has a fourth that predates them: the current
 * definition, which is what the editor shows and is not necessarily published.
 * All four are here because collapsing "current" into "published" would make
 * the default view lie the moment someone edits without publishing.
 */
export type DefinitionSelector =
  | { kind: 'current' }
  | { kind: 'draft' }
  | { kind: 'published' }
  | { kind: 'version'; version: number };

/**
 * Read a selector off the wire.
 *
 * One parameter taking a number or one of two keywords, rather than two
 * parameters. `?version=draft` reads as a thing a person would type, and the
 * keywords are race-free in a way a number is not: `published` resolves on the
 * server, so a client that read `publishedVersion` a second before the pointer
 * moved still gets the version that is actually live.
 */
export function parseDefinitionSelector(raw: string | undefined): DefinitionSelector {
  if (raw === undefined || raw === '' || raw === 'current') {
    return { kind: 'current' };
  }
  if (raw === 'draft') {
    return { kind: 'draft' };
  }
  if (raw === 'published') {
    return { kind: 'published' };
  }
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      message: `'${raw}' is not a version`,
      details: [
        {
          path: 'version',
          issue:
            "must be a positive integer, 'draft', 'published', or omitted for the current definition",
        },
      ],
    });
  }
  return { kind: 'version', version };
}

export interface ResolvedDefinition {
  ips: InternalProjectSchema;
  /** The definition version being documented. */
  version: number;
  /** The facts that move on their own, matched to *this* definition (§20). */
  runtime: RuntimeFacts;
}

/**
 * The definition a selector names, with runtime facts that cannot mislead.
 *
 * ## The §20 rule, in one place
 *
 * "Never accidentally combine draft configuration with published runtime
 * configuration." The dangerous line is the hosted URL: printed beside a
 * definition it does not serve, a reader reasonably concludes it does, and then
 * writes client code against a field list the live API rejects.
 *
 * So `serving` is computed here, once, from the only honest test — is the
 * documented definition the published one — and every document inherits it.
 * Putting that decision in the renderer, or leaving it to each route, is how
 * three views end up with three different answers.
 *
 * ## Uses the Phase 2 model as it stands
 *
 * `resolveSnapshot` already answers "give me version N, or the live definition
 * when N is current, or a 404 explaining that N was never snapshotted", and
 * `publishedVersionOf` answers where the published pointer sits. Neither is
 * touched, and no second publication mechanism appears — §20 forbids both.
 */
export async function resolveDefinition(
  project: IProject,
  selector: DefinitionSelector,
): Promise<ResolvedDefinition> {
  /*
   * Two facts that are easy to conflate, and the whole §20 rule turns on
   * keeping them apart.
   *
   * `publishedVersionOf` returns a *number, never null* — it falls back to
   * `currentVersion` — so it answers "which version is the published pointer
   * on", not "is anything published". Phase 2 established the same thing from
   * the other side: `pinPublishedVersion` writes that pointer speculatively on
   * a project's first edit, so its presence is not evidence of a deployment.
   *
   * `hosted.url` is the only honest test for "something is actually live". So
   * `publishedVersion` is reported to the document *only* when there is a
   * deployment for it to describe — otherwise the phrase "published version"
   * in a document would name a version nobody can call.
   */
  const pointer = publishedVersionOf(project);
  const live = project.hosted?.url ?? null;
  const hasDeployment = live !== null;
  const publishedVersion = hasDeployment ? pointer : undefined;

  if (selector.kind === 'draft') {
    const { draft, stale } = await loadDraft(project);
    return {
      ips: definitionOfSnapshot(project, {
        version: draft.baseVersion,
        ips: draft.ips,
        config: draft.generationConfig,
      }),
      version: draft.baseVersion,
      runtime: {
        source: 'draft',
        ...(publishedVersion === undefined ? {} : { publishedVersion }),
        /*
         * A draft is never served: it has not been committed, so no version
         * carries it and no deployment can. Stated as `false` rather than left
         * absent so the document says so out loud.
         */
        serving: false,
        // No `hostedUrl`: the renderer would suppress it anyway, and handing
        // over a URL this view must not print invites someone to "fix" that.
        /*
         * A stale draft is worth naming here rather than only in the editor.
         * Its diff is against a definition that has since moved, so a reader
         * comparing this document to the current one would find differences
         * nobody made.
         */
        ...(stale
          ? { status: 'draft (stale — the project has moved on since it was forked)' }
          : {}),
      },
    };
  }

  /*
   * `published` resolves to the pointer even when nothing is deployed.
   *
   * A 404 was the first answer here and it was worse: the pointer always names
   * a real version, so refusing would read as "this project has no versions"
   * when the truth is "that version is not live". The document says the latter
   * out loud via `serving: false`.
   */
  const version =
    selector.kind === 'version'
      ? selector.version
      : selector.kind === 'published'
        ? pointer
        : project.currentVersion;

  const { snapshot, ref } = await resolveSnapshot(project, version);
  const serving = hasDeployment && version === pointer;

  return {
    ips: definitionOfSnapshot(project, snapshot),
    version,
    runtime: {
      source: ref.source,
      ...(publishedVersion === undefined ? {} : { publishedVersion }),
      serving,
      /*
       * Only the serving definition gets the URL and the project's status —
       * both describe the deployment, not any particular definition.
       *
       * `pendingRegeneration` goes with them: it means "the definition has
       * moved ahead of what is served", which is only a coherent statement
       * when something is served.
       */
      ...(serving
        ? {
            status: project.status,
            hostedUrl: live,
            pendingRegeneration: hasPendingRegeneration(project),
          }
        : {}),
    },
  };
}
