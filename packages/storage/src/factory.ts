/**
 * Storage driver selection.
 *
 * STORAGE_DRIVER=mongo  -> artifacts live in MongoDB GridFS (**the default**)
 * STORAGE_DRIVER=s3     -> S3-compatible object storage
 *
 * Keeping the choice behind one factory means swapping backends later is an
 * env change, not a code change: every call site just asks for a StorageClient.
 *
 * **GridFS is the default**, which this comment previously got backwards — it
 * announced s3 as the default while the line below fell back to mongo. Worth
 * correcting rather than tidying: the wrong version was believed over the code,
 * and it put "artifacts are in object storage" into a document describing a
 * deployment whose artifacts are in the database. `INFRASTRUCTURE.md`'s "Where
 * artifacts live" records the real V1 arrangement and its trade-off.
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
