/**
 * Job routes (doc 08 §4): status snapshot, SSE live progress, and per-worker
 * retry. Ownership resolves through the job's parent project.
 */

import { randomUUID } from 'crypto';
import type { FastifyPluginAsync } from 'fastify';
import {
  AppError,
  WORKER_ARTIFACT_MAP,
  WORKER_IDS,
  type ArtifactType,
  type WorkerId,
} from '@instantmockapi/shared';
import type { EnvConfig } from '@instantmockapi/config';
import { Job, type IJob } from '@instantmockapi/db';
import { createOrResetArtifactRecord } from '@instantmockapi/registry';
import { enqueueGenerationJob } from '@instantmockapi/queue';
import { loadOwnedJob, notFound } from '../access.js';
import { toJobView } from '../serializers.js';

export interface JobRouteOptions {
  config: EnvConfig;
  sse?: {
    pollIntervalMs?: number;
    maxDurationMs?: number;
  };
}

function isTerminal(status: IJob['status']): boolean {
  return status === 'completed' || status === 'failed_partial';
}

export const jobRoutes: FastifyPluginAsync<JobRouteOptions> = async (app, options) => {
  app.addHook('onRequest', app.authenticate);

  const pollIntervalMs = options.sse?.pollIntervalMs ?? 1000;
  const maxDurationMs = options.sse?.maxDurationMs ?? 5 * 60_000;

  app.get('/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const { job } = await loadOwnedJob(jobId, request.authUser?.sub ?? '');
    return reply.send(toJobView(job));
  });

  // SSE live progress: emits `snapshot` events until the job reaches a
  // terminal state, the client disconnects, or the stream times out.
  app.get('/jobs/:jobId/stream', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const { job } = await loadOwnedJob(jobId, request.authUser?.sub ?? '');

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const send = (snapshot: IJob) => {
      reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(toJobView(snapshot))}\n\n`);
    };

    send(job);
    if (isTerminal(job.status)) {
      reply.raw.end();
      return;
    }

    let closed = false;
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(interval);
      clearTimeout(timeout);
      reply.raw.end();
    };

    const interval = setInterval(() => {
      void (async () => {
        const fresh = await Job.findById(job._id);
        if (closed) {
          return;
        }
        if (!fresh) {
          cleanup();
          return;
        }
        send(fresh);
        if (isTerminal(fresh.status)) {
          cleanup();
        }
      })().catch(cleanup);
    }, pollIntervalMs);
    const timeout = setTimeout(cleanup, maxDurationMs);
    request.raw.on('close', cleanup);
  });

  app.post(
    '/jobs/:jobId/workers/:worker/retry',
    {
      schema: {
        params: {
          type: 'object',
          required: ['jobId', 'worker'],
          properties: {
            jobId: { type: 'string' },
            worker: { type: 'string', enum: [...WORKER_IDS] },
          },
        },
      },
    },
    async (request, reply) => {
      const { jobId, worker } = request.params as { jobId: string; worker: WorkerId };
      const { job } = await loadOwnedJob(jobId, request.authUser?.sub ?? '');

      const entry = job.workers.find((w) => w.worker === worker);
      if (!entry) {
        throw notFound('Worker');
      }
      if (entry.status !== 'failed') {
        throw new AppError({
          code: 'CONFLICT',
          message: `Worker ${worker} is '${entry.status}'; only failed workers can be retried`,
        });
      }

      entry.status = 'queued';
      entry.error = null;
      job.status = 'queued';
      job.completedAt = null;

      // Reset this worker's registry rows back to pending
      const artifacts = job.requestedArtifacts.filter((artifact) =>
        WORKER_ARTIFACT_MAP[worker].includes(artifact as ArtifactType),
      ) as ArtifactType[];
      for (const artifactType of artifacts) {
        const reset = await createOrResetArtifactRecord(
          String(job.projectId),
          artifactType,
          job.version,
        );
        if (!reset.ok) {
          throw reset.error;
        }
      }
      await job.save();

      // Fresh queue jobId: the original (kept by removeOnFail) must not
      // deduplicate a deliberate manual retry
      const retryKey = `${job.idempotencyKey}:retry:${worker}:${randomUUID()}`;
      await enqueueGenerationJob(
        String(job.projectId),
        job.version,
        'partial',
        artifacts,
        retryKey,
        String(job._id),
      );

      return reply.status(202).send({ jobId: String(job._id), status: job.status });
    },
  );
};
