/**
 * CacheService construction + the Redis on/off decision.
 *
 * Redis is treated as an optimization, never a hard dependency of the cache
 * path: when it is off (local dev, tests, or an explicit REDIS_ENABLED=false)
 * the service runs L1-only and every consumer keeps working unchanged.
 */

import Redis from 'ioredis';
import { logger } from '@instantmockapi/shared';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import { CacheService } from './service.js';

let sharedClient: Redis | null = null;

/**
 * One ioredis client per process for all cache traffic. BullMQ keeps its own
 * connection (it requires `maxRetriesPerRequest: null` and holds a blocking
 * socket), so the two are deliberately not shared.
 */
export function getCacheRedis(config: EnvConfig = loadEnvConfig()): Redis | null {
  if (!config.redisEnabled) {
    return null;
  }
  if (sharedClient) {
    return sharedClient;
  }
  sharedClient = new Redis(config.redisUrl, {
    lazyConnect: false,
    // Cache reads must not queue behind a dead connection: fail fast, let
    // CacheService fall through to the origin loader.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });
  sharedClient.on('error', (error: Error) => {
    logger.warn('Cache Redis connection error', { error: error.message });
  });
  return sharedClient;
}

export function createCacheService(config: EnvConfig = loadEnvConfig()): CacheService {
  const redis = getCacheRedis(config);
  if (!redis) {
    logger.info('Cache running in memory-only mode (Redis disabled)', {
      nodeEnv: config.nodeEnv,
    });
  }
  return new CacheService({
    redis,
    l1MaxEntries: config.cacheL1MaxEntries,
    l1MaxBytes: config.cacheL1MaxBytes,
    l1MaxTtlSeconds: config.cacheL1TtlSeconds,
  });
}

/** L1-only service. Used by tests and by any infrastructure-free local run. */
export function createMemoryCacheService(
  options: { l1MaxEntries?: number; l1MaxBytes?: number; l1MaxTtlSeconds?: number } = {},
): CacheService {
  return new CacheService({ redis: null, ...options });
}

export async function closeCacheRedis(): Promise<void> {
  if (sharedClient) {
    await sharedClient.quit().catch(() => undefined);
    sharedClient = null;
  }
}
