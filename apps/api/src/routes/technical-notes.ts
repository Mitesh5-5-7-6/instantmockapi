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
import type { IProject } from '@instantmockapi/db';
import {
  buildDocumentationModel,
  renderAiContext,
  renderTechnicalNotes,
  type DocumentationMeta,
  type RuntimeFacts,
} from '@instantmockapi/generator-docs';
import { loadOwnedProject } from '../access.js';
import { parseDefinitionSelector, resolveDefinition } from '../project-definition.js';

export interface TechnicalNotesRouteOptions {
  config: EnvConfig;
}

/**
 * The mutable facts, kept out of the definition's own sections.
 *
 * `runtime` is supplied by `resolveDefinition` rather than read off the project
 * here: §20 requires the runtime half to match the definition being documented,
 * and computing it per route is how three views end up with three answers.
 */
function metaOf(project: IProject, runtime: RuntimeFacts): DocumentationMeta {
  return {
    name: project.name,
    description: project.description ?? null,
    runtime,
  };
}

/**
 * The querystring both documents accept (§20).
 *
 * A string rather than an integer, because the value is a number *or* one of
 * two keywords — and `parseDefinitionSelector` returns a structured
 * `VALIDATION_ERROR` naming what is allowed, which is more useful than ajv's
 * type message.
 */
const VERSION_QUERYSTRING = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'string', maxLength: 16 },
  },
} as const;

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
   *
   * `?version=` selects which definition (§20): a number, `draft`, `published`,
   * or omitted for the current one.
   */
  app.get(
    '/projects/:id/technical-notes',
    { schema: { querystring: VERSION_QUERYSTRING } },
    async (request) => {
      const { id } = request.params as { id: string };
      const { version: requested } = request.query as { version?: string };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');

      const resolved = await resolveDefinition(project, parseDefinitionSelector(requested));
      const model = buildDocumentationModel(resolved.ips, metaOf(project, resolved.runtime));

      return {
        version: resolved.version,
        source: resolved.runtime.source ?? 'project',
        serving: resolved.runtime.serving ?? false,
        markdown: renderTechnicalNotes(model),
      };
    },
  );

  /**
   * The AI-ready context (§7).
   *
   * A separate route rather than a third field on the one above: §24 names it
   * separately, and it is fetched only when a user opens that view, so pairing
   * them would make every notes request pay for a document most requests do not
   * show.
   *
   * Version-aware for the same reason the notes are: the two documents describe
   * one project, and letting only one of them follow a version selection would
   * be exactly the divergence §9's shared model exists to prevent.
   *
   * `baseUrl` is passed only when the documented definition is the one actually
   * being served. A base URL beside a draft's field list produces client code
   * that fails against the live API — which is §20's trap, and worse in a
   * document written to be pasted into a code generator.
   */
  app.get(
    '/projects/:id/technical-notes/ai',
    { schema: { querystring: VERSION_QUERYSTRING } },
    async (request) => {
      const { id } = request.params as { id: string };
      const { version: requested } = request.query as { version?: string };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');

      const resolved = await resolveDefinition(project, parseDefinitionSelector(requested));
      const model = buildDocumentationModel(resolved.ips, metaOf(project, resolved.runtime));
      const hostedUrl = resolved.runtime.serving === true ? (project.hosted?.url ?? null) : null;

      return {
        version: resolved.version,
        source: resolved.runtime.source ?? 'project',
        serving: resolved.runtime.serving ?? false,
        context: renderAiContext(model, hostedUrl === null ? {} : { baseUrl: hostedUrl }),
      };
    },
  );
};
