/**
 * Technical Notes and AI context (Phase 4 §10, §24).
 *
 * Two reads over the canonical definition. Neither stores anything, neither
 * takes a body, and neither can be reached without owning the project.
 *
 * ## Why the API builds these and the worker does not
 *
 * Every other document in the platform — OpenAPI, Postman, types, validators —
 * is an `Artifact`: a worker generates it, stores it, and the runtime or the
 * Files tab serves the stored copy. Technical Notes deliberately are not.
 *
 * §1 says the notes are derived *from* the canonical definition and must never
 * become configuration. Storing them would make that harder to keep true: a
 * stored copy has a version of its own, can be stale relative to the project,
 * and would need invalidating on every edit — which is a cache of a pure
 * function of data we already have. Building on demand means the notes cannot
 * disagree with the definition, because there is no second copy to disagree.
 *
 * The cost is a little CPU per request, on an explicitly-opened tab. The
 * benefit is that "the notes are wrong" is not a reachable state.
 *
 * ## No timestamp, deliberately
 *
 * `RuntimeFacts.generatedAt` exists and this route does not set it. §8 requires
 * the document to be deterministic, and §21 wants two versions of it to diff —
 * both of which a wall-clock stamp breaks, since every export of an unchanged
 * project would differ on one line. A download's own file date answers "when"
 * without putting it inside the document.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { EnvConfig } from '@instantmockapi/config';
import { publishedVersionOf, type IProject } from '@instantmockapi/db';
import {
  buildDocumentationModel,
  renderAiContext,
  renderTechnicalNotes,
  type DocumentationMeta,
} from '@instantmockapi/generator-docs';
import { loadOwnedProject } from '../access.js';
import { definitionOf } from '../project-definition.js';

export interface TechnicalNotesRouteOptions {
  config: EnvConfig;
}

/**
 * The mutable facts, kept out of the definition's own sections.
 *
 * `hosted.url` is the honest test for "something is live" — Phase 2 established
 * that `publishedVersion` alone can be a speculative pin written on first edit.
 */
function metaOf(project: IProject): DocumentationMeta {
  return {
    name: project.name,
    description: project.description ?? null,
    runtime: {
      status: project.status,
      publishedVersion: publishedVersionOf(project),
      hostedUrl: project.hosted?.url ?? null,
      source: 'project',
    },
  };
}

export const technicalNotesRoutes: FastifyPluginAsync<TechnicalNotesRouteOptions> = async (app) => {
  app.addHook('onRequest', app.authenticate);

  /**
   * The human document, as markdown and nothing else.
   *
   * The `DocumentationModel` is deliberately **not** sent, though it is right
   * here. Two reasons, and the second is the real one:
   *
   * `web-must-not-import-server` forbids the web app importing a generator at
   * severity error, so the model's ~90 lines of types would have to be
   * hand-mirrored in `api-types.ts` and would drift silently — nothing can
   * compile-check a mirror the rule forbids either side from importing.
   *
   * And the tab shows a rendered view, a raw view, and a download. Building the
   * rendered view from the same markdown the user downloads makes those three
   * the *same document* by construction. A model-driven rendered view would be
   * a third rendering of the definition, free to show something the `.md` does
   * not — which is the failure §9 exists to prevent, reintroduced one layer up.
   */
  app.get('/projects/:id/technical-notes', async (request) => {
    const { id } = request.params as { id: string };
    const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
    const model = buildDocumentationModel(definitionOf(project), metaOf(project));

    return { version: project.currentVersion, markdown: renderTechnicalNotes(model) };
  });

  /**
   * The AI-ready context (§7).
   *
   * A separate route rather than a third field on the one above: §24 names it
   * separately, and it is fetched only when a user opens that view, so pairing
   * them would make every notes request pay for a document most requests do not
   * show.
   *
   * `baseUrl` is passed only when the project is actually live. A guessed base
   * in a context document produces client code that fails against the real API,
   * which is worse than a document with relative paths and a stated base path.
   */
  app.get('/projects/:id/technical-notes/ai', async (request) => {
    const { id } = request.params as { id: string };
    const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
    const model = buildDocumentationModel(definitionOf(project), metaOf(project));
    const hostedUrl = project.hosted?.url ?? null;

    return {
      version: project.currentVersion,
      context: renderAiContext(model, hostedUrl === null ? {} : { baseUrl: hostedUrl }),
    };
  });
};
