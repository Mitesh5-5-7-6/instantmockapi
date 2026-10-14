import { describe, expect, it } from 'vitest';
import {
  cleanList,
  cleanProse,
  fallbackProjectName,
  parseModelJson,
  sanitizeMeta,
} from './sanitize.js';

describe('cleanProse', () => {
  it('strips control characters, trims, and caps length', () => {
    expect(cleanProse('  hi\u0000there\u0007  ')).toBe('hithere');
    expect(cleanProse('x'.repeat(600))).toHaveLength(500);
    expect(cleanProse('abcdef', 3)).toBe('abc');
  });
  it('keeps newlines and non-Latin scripts', () => {
    expect(cleanProse('દર્દી\nरोगी')).toBe('દર્દી\nरोगी');
  });
  it('returns empty string for non-strings', () => {
    expect(cleanProse(42)).toBe('');
    expect(cleanProse(undefined)).toBe('');
  });
});

describe('cleanList', () => {
  it('drops empty and non-string items and truncates', () => {
    expect(cleanList(['a', '', 3, 'b', 'c'], 2)).toEqual(['a', 'b']);
    expect(cleanList('not a list', 3)).toEqual([]);
  });
});

describe('sanitizeMeta', () => {
  it('passes valid values through', () => {
    const meta = sanitizeMeta({
      detectedLanguage: 'gu',
      domain: 'hospital management',
      recommendedKind: 'single',
      kindRationale: 'one resource',
      name: 'Clinic API',
      description: 'd',
      authRecommendation: { recommended: true, reason: 'private data' },
      assumptions: ['a1'],
      questions: ['q1'],
    });
    expect(meta).toEqual({
      detectedLanguage: 'gu',
      domain: 'hospital management',
      recommendedKind: 'single',
      kindRationale: 'one resource',
      name: 'Clinic API',
      description: 'd',
      authRecommendation: { recommended: true, reason: 'private data' },
      assumptions: ['a1'],
      questions: ['q1'],
    });
  });
  it('falls back for invalid language tags and kinds, and never yields auth', () => {
    const meta = sanitizeMeta({ detectedLanguage: 'Gujarati!', recommendedKind: 'auth' });
    expect(meta.detectedLanguage).toBe('und');
    expect(meta.recommendedKind).toBe('project');
    expect(meta.authRecommendation).toEqual({ recommended: false, reason: '' });
  });
  it('caps lists at 8 assumptions and 3 questions', () => {
    const meta = sanitizeMeta({
      assumptions: Array.from({ length: 12 }, (_, i) => `a${i}`),
      questions: Array.from({ length: 6 }, (_, i) => `q${i}`),
    });
    expect(meta.assumptions).toHaveLength(8);
    expect(meta.questions).toHaveLength(3);
  });
  it('only treats a literal true as recommending auth', () => {
    expect(
      sanitizeMeta({ authRecommendation: { recommended: 'yes' } }).authRecommendation.recommended,
    ).toBe(false);
  });
});

describe('parseModelJson', () => {
  it('parses a bare object', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('parses an object wrapped in ```json fences (Review Focus #2)', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('parses an object preceded and followed by prose (Review Focus #2)', () => {
    expect(parseModelJson('Here is the blueprint:\n{"a":{"b":2}}\nHope this helps.')).toEqual({
      a: { b: 2 },
    });
  });
  it('throws SyntaxError when there is no object', () => {
    expect(() => parseModelJson('no json here')).toThrow(SyntaxError);
    expect(() => parseModelJson('')).toThrow(SyntaxError);
  });
});

describe('fallbackProjectName', () => {
  it('builds a title from the first meaningful words', () => {
    expect(fallbackProjectName('Create a gym membership API with trainers')).toBe(
      'Gym Membership Trainers API',
    );
  });
  it('returns a neutral name when no ASCII words exist', () => {
    expect(fallbackProjectName('મારે API જોઈએ')).toBe('Generated API');
  });
});
