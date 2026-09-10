// @instantmockapi/api — Core REST API (Fastify) entrypoint.
// Connects MongoDB, builds the server, listens, and shuts down cleanly.

import { logger, getErrorMessage } from '@instantmockapi/shared';
import { loadEnvConfig } from '@instantmockapi/config';
import { connectDB, disconnectDB } from '@instantmockapi/db';
import { closeQueue, createGenerationWorker } from '@instantmockapi/queue';
import { createStorage } from '@instantmockapi/storage';
import { processGenerationJob, settleExhaustedJob } from '@instantmockapi/workers';
import { buildServer } from './server.js';

// Single-service deployments (free PaaS tiers) run the generator DAG in this
// process rather than the dedicated host of doc 10 §5. The request that
// enqueues a job is also what keeps the instance awake, so the embedded worker
// is running exactly when there is work — no external keep-alive needed.
// Unset elsewhere: apps/workers stays the deployment of record.
const RUN_WORKER_IN_PROCESS = process.env['RUN_WORKER_IN_PROCESS'] === 'true';

// Deliberately 1, not the standalone host's 2: generation competes with request
// serving for the same CPU and heap when embedded.
const EMBEDDED_CONCURRENCY = Number.parseInt(process.env['WORKER_CONCURRENCY'] ?? '1', 10);

async function main(): Promise<void> {
  const config = loadEnvConfig();

  await connectDB();
  const storage = createStorage(config);
  const app = await buildServer({ config, storage });

  const worker = RUN_WORKER_IN_PROCESS
    ? createGenerationWorker((payload) => processGenerationJob(payload, { storage }), {
        concurrency: Number.isNaN(EMBEDDED_CONCURRENCY) ? 1 : EMBEDDED_CONCURRENCY,
        onExhausted: settleExhaustedJob,
      })
    : null;
  if (worker) {
    logger.info('Embedded generation worker started', { concurrency: EMBEDDED_CONCURRENCY });
  }

  await app.listen({ port: config.apiPort, host: '0.0.0.0' });
  logger.info('Platform API listening', { port: config.apiPort, env: config.nodeEnv });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('Shutting down', { signal });
    void (async () => {
      await app.close();
      // Must precede closeQueue(): the worker shares the queue's Redis
      // connection, and draining in-flight jobs needs it still open.
      await worker?.close();
      await closeQueue();
      await disconnectDB();
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  logger.error('API failed to start', { error: getErrorMessage(error) });
  process.exit(1);
});
