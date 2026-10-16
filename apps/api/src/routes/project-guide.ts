/**
 * The AI-written guide on the Docs tab.
 *
 *     GET  /projects/:id/guide             the stored guide, or start it
 *     POST /projects/:id/guide/regenerate  write it again
 *
 * Both follow the Docs tab's `?version=` selector. A draft gets no guide: it
 * changes on every save, so writing one per draft would pay for guides nobody
 * keeps. The exact AI Context stays at `/technical-notes/ai`, unchanged.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { EnvConfig } from '@instantmockapi/config';
import { loadOwnedProject } from '../access.js';
import { parseDefinitionSelector, resolveDefinition } from '../project-definition.js';
import { ensureGuide, regenerateGuide, toGuideView } from '../project-guide.js';

export interface ProjectGuideRouteOptions {
  config: EnvConfig;
}

const QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: { version: { type: 'string', maxLength: 16 } },
} as const;

const unavailable = (reason: string) => ({
  status: 'unavailable' as const,
  markdown: null,
  error: null,
  reason,
});

export const projectGuideRoutes: FastifyPluginAsync<ProjectGuideRouteOptions> = async (
  app,
  { config },
) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/projects/:id/guide', { schema: { querystring: QUERY } }, async (request) => {
    const { id } = request.params as { id: string };
    const selector = parseDefinitionSelector((request.query as { version?: string }).version);
    const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
    if (selector.kind === 'draft') {
      return unavailable('The guide is written for saved versions. Commit the draft to get one.');
    }
    if (!config.geminiApiKey) {
      return unavailable('AI is not configured on this server.');
    }
    const resolved = await resolveDefinition(project, selector);
    return toGuideView(await ensureGuide(project, resolved));
  });

  app.post(
    '/projects/:id/guide/regenerate',
    {
      // Each run is a model call; the stored guide is the normal path.
      config: { rateLimit: { max: 10, timeWindow: 60 * 60_000 } },
      schema: { querystring: QUERY },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const selector = parseDefinitionSelector((request.query as { version?: string }).version);
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
      if (selector.kind === 'draft' || !config.geminiApiKey) {
        return reply.status(200).send(unavailable('No guide is written for this view.'));
      }
      const resolved = await resolveDefinition(project, selector);
      return reply.status(202).send(toGuideView(await regenerateGuide(project, resolved)));
    },
  );
};
