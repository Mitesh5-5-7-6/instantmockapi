/**
 * In-memory StorageClient for tests and infrastructure-free local runs.
 */

import type { StorageClient, StorageObject } from './types.js';

export interface MemoryStorage extends StorageClient {
  /** Test helper: all stored keys, sorted. */
  keys(): string[];
  clear(): void;
}

export function createMemoryStorage(): MemoryStorage {
  const objects = new Map<string, StorageObject>();

  return {
    async put(key, body, contentType) {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      objects.set(key, { body: bytes, contentType });
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
    keys() {
      return [...objects.keys()].sort();
    },
    clear() {
      objects.clear();
    },
  };
}
