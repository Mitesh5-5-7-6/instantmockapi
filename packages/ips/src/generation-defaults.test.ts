import { describe, expect, it } from 'vitest';
import { HTTP_METHODS } from '@instantmockapi/shared';
import {
  ALL_QUERY_FEATURES,
  NEW_PROJECT_UNKNOWN_FIELDS,
  newProjectGenerationConfig,
} from './index.js';

describe('newProjectGenerationConfig', () => {
  it('exposes the whole surface and rejects unknown fields, with the given record count', () => {
    expect(newProjectGenerationConfig(25)).toEqual({
      validators: ['zod'],
      types: ['typescript'],
      methods: [...HTTP_METHODS],
      mockRecords: 25,
      features: { ...ALL_QUERY_FEATURES },
      unknownFields: NEW_PROJECT_UNKNOWN_FIELDS,
    });
  });

  it('returns a fresh object each call so callers cannot mutate a shared default', () => {
    const a = newProjectGenerationConfig(10);
    a.methods.pop();
    expect(newProjectGenerationConfig(10).methods).toHaveLength(HTTP_METHODS.length);
  });
});
