// @instantmockapi/storage — S3-compatible object storage for generated
// artifacts, plus an in-memory implementation for tests (doc 06, doc 13 §6).

export { type StorageClient, type StorageObject } from './types.js';
export { createMemoryStorage, type MemoryStorage } from './memory.js';
export { createS3Storage } from './s3.js';
export { createMongoStorage } from './mongo.js';
export { createStorage } from './factory.js';
export {
  artifactKey,
  bundleKey,
  isBundleKey,
  encodeBundle,
  decodeBundle,
  type ArtifactBundle,
} from './keys.js';
