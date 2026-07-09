/**
 * Builder Adapter for the Manual Schema Builder interface.
 *
 * Verifies that the manually constructed model matches the IPS specification (doc 04 §F2, doc 09 §2).
 */

import { type Result, ok, err } from '@instantmockapi/shared';
import { validateIPS, type InternalProjectSchema, type Entity, type GenerationConfig } from '@instantmockapi/ips';

/**
 * Creates and validates an IPS draft from the Visual Schema Builder inputs.
 */
export function parseBuilderPayload(
  projectId: string,
  _projectName: string,
  entities: Entity[],
  generationConfig: GenerationConfig,
): Result<InternalProjectSchema, Error> {
  const ips: InternalProjectSchema = {
    projectId,
    version: 1,
    entities,
    generationConfig,
  };

  const validationResult = validateIPS(ips);
  if (!validationResult.ok) {
    return err(validationResult.error);
  }

  return ok(ips);
}
