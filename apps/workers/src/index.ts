// @instantmockapi/workers — Worker host process (doc 10).
// Consumes generation jobs from BullMQ and drives the generator DAG.

import { logger, getErrorMessage } from '@instantmockapi/shared';
import { connectDB, disconnectDB } from '@instantmockapi/db';
import { closeQueue, createGenerationWorker } from '@instantmockapi/queue';
import { createStorage } from '@instantmockapi/storage';
import { processGenerationJob } from './processor.js';

const WORKER_CONCURRENCY = Number.parseInt(process.env['WORKER_CONCURRENCY'] ?? '2', 10);

async function main(): Promise<void> {
  await connectDB();
  const storage = createStorage();

  const worker = createGenerationWorker((payload) => processGenerationJob(payload, { storage }), {
    concurrency: Number.isNaN(WORKER_CONCURRENCY) ? 2 : WORKER_CONCURRENCY,
  });
  logger.info('Worker host running', { concurrency: WORKER_CONCURRENCY });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('Worker host shutting down', { signal });
    void (async () => {
      await worker.close();
      await closeQueue();
      await disconnectDB();
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  logger.error('Worker host failed to start', { error: getErrorMessage(error) });
  process.exit(1);
});
