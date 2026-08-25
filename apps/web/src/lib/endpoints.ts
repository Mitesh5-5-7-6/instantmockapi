/**
 * Re-export of the endpoint/snippet module, which now lives in
 * `@instantmockapi/shared` so the platform API can compute the same figures.
 *
 * This barrel exists so the move stayed a move: the four consumers
 * (`snippet-tabs`, `explore/page`, `ready/page`, and this module's own test
 * suite) keep importing from `../lib/endpoints` and needed no edits. Prefer
 * importing from `@instantmockapi/shared` directly in new code.
 *
 * `HttpMethod` is deliberately not re-exported here — it was a local duplicate
 * of the canonical union in `shared/constants`, and re-exporting both from one
 * barrel is a compile error. Import it from `@instantmockapi/shared`.
 */

export {
  type IpsField,
  type IpsRelation,
  type IpsEntity,
  type EndpointRow,
  type SnippetLanguage,
  type SnippetInput,
  SNIPPET_LANGUAGES,
  entityEndpoints,
  projectEndpoints,
  countEndpoints,
  exampleBody,
  exampleQuery,
  buildSnippet,
  pythonLiteral,
  endpointUrl,
} from '@instantmockapi/shared';
