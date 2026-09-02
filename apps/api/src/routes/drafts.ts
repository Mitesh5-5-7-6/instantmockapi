/**
 * Draft routes (Phase 1): fork, read, edit, analyse, commit, discard.
 *
 *     POST   /projects/:id/draft          fork from the active definition
 *     GET    /projects/:id/draft          the draft, with staleness
 *     PATCH  /projects/:id/draft          apply an edit
 *     DELETE /projects/:id/draft          discard
 *     GET    /projects/:id/draft/impact   the review-changes panel
 *     POST   /projects/:id/draft/refork   discard and re-fork a stale draft
 *     POST   /projects/:id/draft/commit   become the new definition, pending generation
 *
 * Every rule lives in `draft-service.ts`; these handlers only translate HTTP.
 * Commit responds 202, not 200 — it enqueues generation, and the new version is
 * not serving traffic when the response is written.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { ArtifactType } from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import { loadOwnedProject } from '../access.js';
import { REGENERATABLE_ARTIFACTS } from '../generation-config.js';
import {
  analyseDraft,
  applyDraftEdit,
  commitDraft,
  discardDraft,
  loadDraft,
  openDraft,
  refork,
  toDraftAnalysisResponse,
  toDraftResponse,
} from '../draft-service.js';

export interface DraftRouteOptions {
  config: EnvConfig;
}

export const draftRoutes: FastifyPluginAsync<DraftRouteOptions> = async (app, { config }) => {
  app.addHook('onRequest', app.authenticate);

  app.post('/projects/:id/draft', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
    const { draft, created } = await openDraft(project);
    // 200 when resuming, 201 when forking — a UI can then say "resuming your
    // unsaved changes" without a second request to find out.
    return reply
      .status(created ? 201 : 200)
      .send(
        toDraftResponse({ project, draft, stale: draft.baseVersion !== project.currentVersion }),
      );
  });

  app.get('/projects/:id/draft', async (request, reply) => {
    const ctx = await loadDraft(
      await loadOwnedProject((request.params as { id: string }).id, request.authUser?.sub ?? ''),
    );
    return reply.send(toDraftResponse(ctx));
  });

  app.patch(
    '/projects/:id/draft',
    {
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            ips: { type: 'object' },
            generationConfig: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      const ctx = await loadDraft(
        await loadOwnedProject((request.params as { id: string }).id, request.authUser?.sub ?? ''),
      );
      // A stale draft is still editable. Blocking the edit would trap the user's
      // work behind an error; the staleness is reported on every read and
      // enforced at commit, which is the only point where it can do damage.
      const draft = await applyDraftEdit(
        ctx,
        request.body as {
          ips?: Record<string, unknown>;
          generationConfig?: Record<string, unknown>;
        },
        config,
      );
      return reply.send(toDraftResponse({ ...ctx, draft }));
    },
  );

  app.get('/projects/:id/draft/impact', async (request, reply) => {
    const ctx = await loadDraft(
      await loadOwnedProject((request.params as { id: string }).id, request.authUser?.sub ?? ''),
    );
    return reply.send(toDraftAnalysisResponse(analyseDraft(ctx)));
  });

  app.delete('/projects/:id/draft', async (request, reply) => {
    await discardDraft(
      await loadDraft(
        await loadOwnedProject((request.params as { id: string }).id, request.authUser?.sub ?? ''),
      ),
    );
    return reply.status(204).send();
  });

  app.post('/projects/:id/draft/refork', async (request, reply) => {
    const project = await loadOwnedProject(
      (request.params as { id: string }).id,
      request.authUser?.sub ?? '',
    );
    const draft = await refork(project);
    return reply.send(toDraftResponse({ project, draft, stale: false }));
  });

  app.post(
    '/projects/:id/draft/commit',
    {
      // Committing with no body is the ordinary case — every field below is
      // optional, and a client that wants the defaults sends nothing. Without
      // this, Fastify validates an absent body against the object schema and
      // answers 400 "body must be object", which reads as a malformed request
      // when the request was simply empty.
      preValidation: (request, _reply, done) => {
        request.body ??= {};
        done();
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            acknowledgeRisk: { type: 'boolean' },
            note: { type: 'string', maxLength: 500 },
            artifacts: {
              type: 'array',
              minItems: 1,
              uniqueItems: true,
              items: { type: 'string', enum: [...REGENERATABLE_ARTIFACTS] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const project = await loadOwnedProject(
        (request.params as { id: string }).id,
        request.authUser?.sub ?? '',
      );
      const ctx = await loadDraft(project);
      const body = (request.body ?? {}) as {
        acknowledgeRisk?: boolean;
        note?: string;
        artifacts?: ArtifactType[];
      };

      const result = await commitDraft({
        ctx,
        plan: request.authUser?.plan ?? 'free',
        ...(body.artifacts ? { artifacts: body.artifacts } : {}),
        ...(body.acknowledgeRisk !== undefined ? { acknowledgeRisk: body.acknowledgeRisk } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      });

      const payload = {
        committed: result.committed,
        version: result.version ?? null,
        // Unchanged by a commit, and returned so a client can see that for itself
        // rather than taking the invariant on trust.
        publishedVersion: result.publishedVersion,
        job: result.job ? { jobId: result.job.jobId, status: result.job.status } : null,
        ...(result.reason ? { reason: result.reason } : {}),
        analysis: toDraftAnalysisResponse(result.analysis),
      };

      // 200 for a no-op commit: nothing was queued, so 202 would promise progress
      // that will never arrive.
      return reply.status(result.committed ? 202 : 200).send(payload);
    },
  );
};
