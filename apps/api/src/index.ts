// @instantmockapi/api — Core REST API (Fastify) entrypoint.
// Connects MongoDB, builds the server, listens, and shuts down cleanly.

import { logger, getErrorMessage } from '@instantmockapi/shared';
import { loadEnvConfig } from '@instantmockapi/config';
import { connectDB, disconnectDB } from '@instantmockapi/db';
import { closeQueue } from '@instantmockapi/queue';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadEnvConfig();

  await connectDB();
  const app = await buildServer({ config });
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
