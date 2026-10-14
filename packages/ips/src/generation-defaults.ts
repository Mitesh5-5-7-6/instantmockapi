import { HTTP_METHODS } from '@instantmockapi/shared';
import { ALL_QUERY_FEATURES } from './query.js';
import { NEW_PROJECT_UNKNOWN_FIELDS, type GenerationConfig } from './types.js';

/**
 * The generation config every new project starts with.
 *
 * One definition shared by every creation path — the wizard's builder payload,
 * the AI proposal worker and AI commit — so a project created by AI cannot
 * quietly differ from one created by hand. Previously a private function in
 * apps/api, which the worker cannot import.
 *
 * Every method and query feature is on, because a fresh project should expose
 * the whole surface and the wizard turns things off. Unknown fields are
 * rejected from the first request: a mock API earns its keep by catching the
 * client/schema mismatch, and silently storing an undeclared field teaches
 * nothing. Loosening is a setting away; not being told is not recoverable.
 *
 * Fresh arrays and objects on every call: callers spread and modify the result.
 */
export function newProjectGenerationConfig(mockRecords: number): GenerationConfig {
  return {
    validators: ['zod'],
    types: ['typescript'],
    methods: [...HTTP_METHODS],
    mockRecords,
    features: { ...ALL_QUERY_FEATURES },
    unknownFields: NEW_PROJECT_UNKNOWN_FIELDS,
  };
}
