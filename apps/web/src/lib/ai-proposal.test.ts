import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_PROMPTS,
  REVIEW_PROPOSAL_QUERY,
  RESPONSE_LANGUAGES,
  defaultResponseLanguage,
  examplesFor,
  isSettled,
  languageOptions,
  pollInterval,
  responseLanguageFor,
  stageLabel,
} from './ai-proposal';

describe('pollInterval', () => {
  const created = '2026-10-13T10:00:00.000Z';
  const t0 = Date.parse(created);
  // The view's updatedAt is what the helper measures from.
  it('polls every 2s for the first 30s, then every 5s, while generating', () => {
    expect(pollInterval({ status: 'generating', updatedAt: created }, t0 + 1_000)).toBe(2_000);
    expect(pollInterval({ status: 'generating', updatedAt: created }, t0 + 31_000)).toBe(5_000);
  });
  it('restarts the fast window when a retry bumps updatedAt', () => {
    const retriedAt = new Date(t0 + 3_600_000).toISOString();
    expect(
      pollInterval({ status: 'generating', updatedAt: retriedAt }, t0 + 3_600_000 + 1_000),
    ).toBe(2_000);
  });
  it('also polls while committing', () => {
    expect(pollInterval({ status: 'committing', updatedAt: created }, t0 + 1_000)).toBe(2_000);
  });
  it('stops polling once settled or when there is no data', () => {
    for (const status of ['ready', 'failed', 'cancelled', 'committed']) {
      expect(pollInterval({ status, updatedAt: created }, t0)).toBe(false);
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

describe('response language', () => {
  it('defaults to "same as my prompt", offered first', () => {
    expect(defaultResponseLanguage()).toBe('auto');
    expect(RESPONSE_LANGUAGES[0]).toEqual({ code: 'auto', label: 'Same as my prompt' });
  });
  it('offers the spec languages', () => {
    expect(RESPONSE_LANGUAGES.map((l) => l.code)).toEqual(
      expect.arrayContaining(['auto', 'en', 'hi', 'gu', 'es', 'fr', 'de']),
    );
  });
  it('sends no responseLanguage for auto, and the code otherwise', () => {
    expect(responseLanguageFor('auto')).toBeUndefined();
    expect(responseLanguageFor('gu')).toBe('gu');
  });
  it('shows English plus one example per other language on auto', () => {
    const examples = examplesFor('auto');
    expect(examples).toEqual(expect.arrayContaining(EXAMPLE_PROMPTS['en']!));
    expect(examples).toContain(EXAMPLE_PROMPTS['gu']![0]);
    expect(examples).toHaveLength(Object.values(EXAMPLE_PROMPTS).length + 1);
    expect(examplesFor('gu')).toEqual(EXAMPLE_PROMPTS['gu']);
  });
});

it('keeps polling a ready proposal while a translation is pending', () => {
  const now = Date.parse('2026-10-14T10:00:10.000Z');
  const view = {
    status: 'ready',
    updatedAt: '2026-10-14T10:00:00.000Z',
    translation: { status: 'pending' },
  };
  expect(pollInterval(view, now)).toBe(2_000);
  expect(pollInterval({ ...view, translation: { status: 'failed' } }, now)).toBe(false);
  expect(pollInterval({ ...view, translation: null }, now)).toBe(false);
});

describe('the review page query', () => {
  // The review page initialises only from a fetch made after it mounts. /new/ai replaces to
  // it straight after the fetch that saw 'ready', inside the app-wide 10 s staleTime, so
  // without always no mount fetch happens and the page waits forever.
  it('always refetches on mount', () => {
    expect(REVIEW_PROPOSAL_QUERY.refetchOnMount).toBe('always');
  });

  // A source scan (vitest here has no DOM, so the page cannot be rendered): the constant is
  // only a guard if the page actually passes it.
  it('is the one the review page passes', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/new/ai/[id]/page.tsx'), 'utf8');
    expect(page).toContain('useAiProposal(id, REVIEW_PROPOSAL_QUERY)');
  });
});

describe('languageOptions', () => {
  const listed = RESPONSE_LANGUAGES.filter((option) => option.code !== 'auto');

  it('offers the listed languages, without auto, when the current one is listed', () => {
    expect(languageOptions('en')).toEqual(listed);
    expect(languageOptions('gu').map((option) => option.code)).not.toContain('auto');
  });

  it.each(['mr', 'ja', 'en-US'])('puts an unlisted current language (%s) first', (code) => {
    const options = languageOptions(code);
    expect(options[0]).toEqual({ code, label: `${code} (current)` });
    expect(options.slice(1)).toEqual(listed);
  });
});
