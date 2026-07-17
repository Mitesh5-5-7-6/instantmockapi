/**
 * Object-storage abstraction (doc 13 §6: storageRef downloads are
 * server-mediated, never public URLs).
 *
 * Two implementations: S3-compatible (production/MinIO) and in-memory
 * (tests, local development without infrastructure).
 */

export interface StorageObject {
  body: Uint8Array;
  contentType: string;
}

export interface StorageClient {
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  /** Returns null when the key does not exist. */
  get(key: string): Promise<StorageObject | null>;
  delete(key: string): Promise<void>;
}
