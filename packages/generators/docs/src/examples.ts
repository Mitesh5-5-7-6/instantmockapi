/**
 * Example records consumed by the docs generator.
 *
 * The one IPS-mediated exception to generator purity (doc 09 §4): Worker E
 * embeds Worker D's example responses so docs and the live mock API always
 * agree. Keyed by lowercased entity name.
 */

export type EntityExamples = Record<string, Record<string, unknown>[]>;

/** First example record for an entity, or an empty object placeholder. */
export function firstExample(
  examples: EntityExamples,
  entityName: string,
): Record<string, unknown> {
  return examples[entityName.toLowerCase()]?.[0] ?? {};
}

/** Up to `count` example records for list responses. */
export function exampleList(
  examples: EntityExamples,
  entityName: string,
  count = 2,
): Record<string, unknown>[] {
  return (examples[entityName.toLowerCase()] ?? []).slice(0, count);
}
