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
export {
  toBuilderShape,
  validateShape,
  type BuilderShape,
  type ShapeLimits,
  type ShapeOptions,
} from './shape.js';
export {
  LANGUAGE_CODE,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  buildRepairTurn,
  buildUserTurn,
  neutralise,
} from './prompt.js';
export {
  GeminiProvider,
  ProviderError,
  type GeminiProviderOptions,
  type LLMProvider,
  type LLMRequest,
  type LLMTurn,
  type ProviderErrorKind,
} from './provider.js';
export {
  proposeBlueprint,
  type ProposalStage,
  type ProposeDeps,
  type ProposeOutcome,
} from './propose.js';
export { editableBlueprint } from './edit.js';
export { createScriptedProvider, fakeOutputJson } from './testing.js';
export {
  TRANSLATE_PROMPT,
  buildTranslateTurn,
  proseOf,
  readTranslation,
  translateProse,
  withProse,
  type ProposalProse,
  type TranslateOutcome,
} from './translate.js';
