/**
 * Unknown-field policy: what a write does with a key the schema never declared.
 *
 * Before this existed the hosted runtime stored and echoed such keys while the
 * generated Zod dropped them, so a `POST` that visibly worked against the mock
 * lost data the moment a client parsed the response with the schema the same
 * generation had handed it. One setting now decides it, and every surface reads
 * this module rather than deciding for itself.
 */

import {
  DEFAULT_UNKNOWN_FIELDS,
  UNKNOWN_FIELD_POLICIES,
  type GenerationConfig,
  type UnknownFieldPolicy,
} from './types.js';

/**
 * Normalize an unknown `unknownFields` value into a policy.
 *
 * Absent or malformed input resolves to `allow`, which is exactly what every
 * config generated before this setting existed already did — so "missing" means
 * "behave as you did yesterday", never "start rejecting my callers' requests".
 * This is the mirror of `resolveQueryFeatures`, where missing means off for the
 * same reason and reaches the opposite default.
 */
export function resolveUnknownFields(input: unknown): UnknownFieldPolicy {
  return typeof input === 'string' && (UNKNOWN_FIELD_POLICIES as readonly string[]).includes(input)
    ? (input as UnknownFieldPolicy)
    : DEFAULT_UNKNOWN_FIELDS;
}

/** Policy of a generation config, defaulted for pre-setting documents. */
export function unknownFieldPolicy(
  config: Pick<GenerationConfig, 'unknownFields'> | null | undefined,
): UnknownFieldPolicy {
  return resolveUnknownFields(config?.unknownFields);
}

/**
 * How much a move between two policies can hurt a caller.
 *
 * Read by both the risk in `changes.ts` and the impact in `classification.ts`,
 * so the commit dialog and the compare page cannot disagree about a direction
 * only one of them computed.
 *
 * - **widening** — `reject` → anything. Requests that used to 400 now succeed.
 * - **narrowing** — anything → `reject`. Requests that used to succeed now 400.
 * - **lossy** — `allow` → `strip`. Nothing starts failing; extra keys silently
 *   stop coming back, which is the harder class of breakage to notice.
 */
export function unknownFieldsDirection(
  before: UnknownFieldPolicy,
  after: UnknownFieldPolicy,
): 'widening' | 'narrowing' | 'lossy' | 'none' {
  if (before === after) {
    return 'none';
  }
  if (after === 'reject') {
    return 'narrowing';
  }
  if (before === 'reject') {
    return 'widening';
  }
  // The only pair left is allow ↔ strip.
  return after === 'strip' ? 'lossy' : 'widening';
}

/** One-line description of a policy, for diff summaries and docs. */
export function describeUnknownFields(policy: UnknownFieldPolicy): string {
  switch (policy) {
    case 'reject':
      return 'rejected with 422';
    case 'strip':
      return 'dropped before storing';
    default:
      return 'stored and echoed back';
  }
}
