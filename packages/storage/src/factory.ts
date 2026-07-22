/**
 * Storage driver selection.
 *
 * STORAGE_DRIVER=mongo  -> artifacts live in MongoDB GridFS (no extra service)
 * STORAGE_DRIVER=s3     -> S3-compatible object storage (default)
 *
 * Keeping the choice behind one factory means swapping backends later is an
 * env change, not a code change: every call site just asks for a StorageClient.
 */

import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import type { StorageClient } from './types.js';
import { createS3Storage } from './s3.js';
import { createMongoStorage } from './mongo.js';

export type StorageDriver = 's3' | 'mongo';

export function createStorage(config: EnvConfig = loadEnvConfig()): StorageClient {
  const driver = (config.storageDriver ?? 'mongo').toLowerCase() as StorageDriver;

  if (driver === 'mongo') {
    return createMongoStorage(config.storageMongoBucket ?? 'artifacts');
  }

  return createS3Storage(config);
}
