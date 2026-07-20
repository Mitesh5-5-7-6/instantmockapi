// @instantmockapi/mock-runtime — Hosted Mock API server entrypoint (doc 08 §9).
// Serves per-project CRUD at /p/{projectId}/{entity} from generated config + seed data.

import { logger, getErrorMessage } from '@instantmockapi/shared';
import { loadEnvConfig } from '@instantmockapi/config';
import { connectDB, disconnectDB } from '@instantmockapi/db';
import { createS3Storage } from '@instantmockapi/storage';
import { createRedisCache } from './cache.js';
import { buildMockRuntime } from './server.js';

async function main(): Promise<void> {
  const config = loadEnvConfig();

  await connectDB();
  const app = await buildMockRuntime({
    config,
    storage: createS3Storage(config),
    cache: createRedisCache(config),
  });
  await app.listen({ port: config.mockRuntimePort, host: '0.0.0.0' });
  logger.info('Mock runtime listening', { port: config.mockRuntimePort, env: config.nodeEnv });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('Mock runtime shutting down', { signal });
    void (async () => {
      await app.close();
      await disconnectDB();
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  logger.error('Mock runtime failed to start', { error: getErrorMessage(error) });
  process.exit(1);
});
