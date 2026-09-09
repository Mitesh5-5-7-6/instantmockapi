// @instantmockapi/generator-docs — Worker E: OpenAPI spec + Postman collection
// from (IPS, examples). Pure functions; examples come from Worker D (doc 09 §4).
//
// Phase 4 adds Technical Notes, which are the same shape of thing — a pure
// projection of the canonical definition into a document — and so live here
// rather than in a fourth generator package. The difference is only in when they
// run: OpenAPI and Postman are worker artifacts, Technical Notes are built on
// demand by the API. Both read the IPS and nothing else.

export {
  generateOpenAPI,
  serverUrl,
  DEFAULT_HOSTED_BASE_URL,
  type DocsOptions,
} from './openapi.js';
export { generatePostmanCollection } from './postman.js';
export { type EntityExamples } from './examples.js';

export {
  buildDocumentationModel,
  flattenFields,
  type DocumentationMeta,
  type DocumentationModel,
  type NotesAuth,
  type NotesEndpoint,
  type NotesEntity,
  type NotesField,
  type NotesGeneration,
  type NotesProject,
  type NotesRelation,
  type NotesValidation,
  type RuntimeFacts,
} from './notes-model.js';

export { renderTechnicalNotes } from './notes-markdown.js';
export { renderAiContext, type AiContextOptions } from './notes-ai.js';
