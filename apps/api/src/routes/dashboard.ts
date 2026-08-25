/**
 * Dashboard route: one composite read for the whole landing screen.
 *
 * Not a list endpoint, so it returns a bare object rather than the
 * `{ data, meta }` envelope — there is nothing to paginate.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { EnvConfig } from '@instantmockapi/config';
import { buildDashboard } from '../dashboard-service.js';

export interface DashboardRouteOptions {
  config: EnvConfig;
}

export const dashboardRoutes: FastifyPluginAsync<DashboardRouteOptions> = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/dashboard',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // An enum, not a `maximum`. The request log is retained for 30 days,
            // so 90 is not a smaller valid answer — it is a window whose left
            // half would come back structurally empty while looking truthful.
            days: { type: 'integer', enum: [7, 14, 30], default: 7 },
            activityLimit: { type: 'integer', minimum: 1, maximum: 20, default: 6 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { days?: number; activityLimit?: number };
      // Owner comes from the token subject, never from a parameter — this is the
      // only thing scoping the whole payload to the caller.
      const view = await buildDashboard(
        request.authUser?.sub ?? '',
        { days: query.days ?? 7, activityLimit: query.activityLimit ?? 6 },
        request.authUser?.plan ?? 'free',
      );
      return reply.send(view);
    },
  );
};
