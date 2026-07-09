/**
 * IPS Versioning and Snapshot Utilities.
 *
 * Implements logic to bump schema versions, generate snapshot templates,
 * and restore historical models into the current workspace draft (doc 03 §7, doc 07 §5).
 */

import type { InternalProjectSchema } from './types.js';

/** Deep clone a value using JSON serialization. */
export function deepClone<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

/**
 * Creates a copy of the IPS with version incremented by 1.
 */
export function bumpIPSVersion(schema: InternalProjectSchema): InternalProjectSchema {
  const cloned = deepClone(schema);
  cloned.version += 1;
  return cloned;
}

/**
 * Creates database-ready snapshot documents from a given IPS schema.
 * Matches `versions` collection schema from doc 07 §2.
 */
export function createIPSSnapshot(schema: InternalProjectSchema) {
  return {
    projectId: schema.projectId,
    version: schema.version,
    ipsSnapshot: {
      entities: deepClone(schema.entities),
    },
    configSnapshot: deepClone(schema.generationConfig),
    createdAt: new Date(),
  };
}

/**
 * Restores a historical snapshot forward onto the current project draft schema.
 * Replaces the current draft entities and generationConfig with snapshot contents,
 * while keeping the project identification intact. Bumps version number to target version.
 */
export function restoreIPSFromSnapshot(
  currentSchema: InternalProjectSchema,
  snapshot: {
    version: number;
    ipsSnapshot: { entities: any };
    configSnapshot: any;
  },
): InternalProjectSchema {
  const cloned = deepClone(currentSchema);
  cloned.entities = deepClone(snapshot.ipsSnapshot.entities);
  cloned.generationConfig = deepClone(snapshot.configSnapshot);
  // Restore copies the snapshot's state forward, keeping snapshot's schema version.
  // Next generation will bump this version forward (doc 03 §7).
  cloned.version = snapshot.version;
  return cloned;
}
