// @instantmockapi/ai — AI proposal core: provider, generic prompt, shape coercion, repair loop.
// Domain-free by rule: nothing in this package may know about any business domain.

export * from './types.js';
export {
  cleanList,
  cleanProse,
  fallbackProjectName,
  isRecord,
  parseModelJson,
  sanitizeMeta,
  PROSE_MAX,
} from './sanitize.js';
export { toBuilderShape, validateShape, type BuilderShape } from './shape.js';
