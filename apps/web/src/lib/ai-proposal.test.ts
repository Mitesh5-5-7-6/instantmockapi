import { describe, expect, it } from 'vitest';
import {
  RESPONSE_LANGUAGES,
  defaultResponseLanguage,
  isSettled,
  pollInterval,
  stageLabel,
} from './ai-proposal';

describe('pollInterval', () => {
  const created = '2026-10-13T10:00:00.000Z';
  const t0 = Date.parse(created);
  it('polls every 2s for the first 30s, then every 5s, while generating', () => {
    expect(pollInterval({ status: 'generating', createdAt: created }, t0 + 1_000)).toBe(2_000);
    expect(pollInterval({ status: 'generating', createdAt: created }, t0 + 31_000)).toBe(5_000);
  });
  it('also polls while committing', () => {
    expect(pollInterval({ status: 'committing', createdAt: created }, t0 + 1_000)).toBe(2_000);
  });
  it('stops polling once settled or when there is no data', () => {
    for (const status of ['ready', 'failed', 'cancelled', 'committed']) {
      expect(pollInterval({ status, createdAt: created }, t0)).toBe(false);
    }
    expect(pollInterval(undefined)).toBe(false);
  });
});

describe('isSettled', () => {
  it('is false only while generating or committing', () => {
    expect(isSettled('generating')).toBe(false);
    expect(isSettled('committing')).toBe(false);
    expect(isSettled('ready')).toBe(true);
  });
});

describe('stageLabel', () => {
  it('describes each stage and falls back sensibly', () => {
    expect(stageLabel('queued')).toMatch(/queue/i);
    expect(stageLabel('repairing')).toMatch(/fix/i);
    expect(stageLabel(null)).toMatch(/working/i);
  });
});

describe('defaultResponseLanguage', () => {
  it('uses the browser language when supported, else English', () => {
    expect(defaultResponseLanguage('gu-IN')).toBe('gu');
    expect(defaultResponseLanguage('xx-YY')).toBe('en');
    expect(defaultResponseLanguage(undefined)).toBe('en');
  });
  it('offers the spec languages', () => {
    expect(RESPONSE_LANGUAGES.map((l) => l.code)).toEqual(
      expect.arrayContaining(['en', 'hi', 'gu', 'es', 'fr', 'de']),
    );
  });
});
