/**
 * Builder Adapter for the Manual Schema Builder interface.
 *
 * Verifies that the manually constructed model matches the IPS specification (doc 04 §F2, doc 09 §2).
 */

import { type ProjectKind, type Result, ok, err } from '@instantmockapi/shared';
import {
  validateIPS,
  type AuthConfig,
  type InternalProjectSchema,
  type Entity,
  type GenerationConfig,
} from '@instantmockapi/ips';

/**
 * Creates and validates an IPS draft from the Visual Schema Builder inputs.
 */
export function parseBuilderPayload(
  projectId: string,
  _projectName: string,
  entities: Entity[],
  generationConfig: GenerationConfig,
  /**
   * Authentication chosen in the wizard (Phase 3 §1, §2).
   *
   * Optional, and omitted rather than defaulted when absent: a project created
   * without answering the question has no `authentication` block at all, which
   * is the same shape every pre-Phase-3 project carries. Writing
   * `{ mode: 'NONE' }` here would make "never asked" and "asked and declined"
   * different documents that behave identically — and the first version's diff
   * would then show a change nobody made.
   */
  authentication?: AuthConfig,
  /**
   * What the project generates (Phase 3 §4).
   *
   * Needed **before** validation, not merely on the finished document:
   * `validateIPS` runs below, and its at-least-one-entity rule is waived for
   * `auth` alone. Stamping the kind on afterwards would let an entity-less Auth
   * API project fail the very check the kind exempts it from.
   */
  kind?: ProjectKind,
): Result<InternalProjectSchema, Error> {
  const ips: InternalProjectSchema = {
    projectId,
    version: 1,
    ...(kind === undefined ? {} : { kind }),
    entities,
    generationConfig,
    ...(authentication !== undefined && authentication.mode !== 'NONE' ? { authentication } : {}),
  };

  const validationResult = validateIPS(ips);
  if (!validationResult.ok) {
    return err(validationResult.error);
  }

  return ok(ips);
}
