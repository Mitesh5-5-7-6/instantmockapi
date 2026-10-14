import type { ProposalMeta } from './types.js';

/** Upper bound for any single prose string the model returns. */
export const PROSE_MAX = 500;
const MAX_ASSUMPTIONS = 8;
const MAX_QUESTIONS = 3;
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Z]{2})?$/;
// Everything below U+0020 except \t \n \r, plus DEL. Kept: every printable
// character in every script — Gujarati and Devanagari explanations are the point.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Model prose made safe to store and render as text.
 *
 * The UI renders these as React text nodes (escaped), so this is not an XSS
 * filter — it bounds size and removes characters that corrupt logs and terminals.
 */
export function cleanProse(value: unknown, max: number = PROSE_MAX): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(CONTROL_CHARS, '').trim().slice(0, max);
}

export function cleanList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => cleanProse(item))
    .filter((item) => item.length > 0)
    .slice(0, maxItems);
}

export function sanitizeMeta(raw: Record<string, unknown>): ProposalMeta {
  const auth = isRecord(raw['authRecommendation']) ? raw['authRecommendation'] : {};
  const language = raw['detectedLanguage'];
  return {
    detectedLanguage:
      typeof language === 'string' && LANGUAGE_TAG.test(language) ? language : 'und',
    domain: cleanProse(raw['domain'], 80),
    // Anything but an explicit "single" is a project — including "auth", which
    // the AI path never produces (an Auth API has no entities to propose).
    recommendedKind: raw['recommendedKind'] === 'single' ? 'single' : 'project',
    kindRationale: cleanProse(raw['kindRationale']),
    name: cleanProse(raw['name'], 120),
    description: cleanProse(raw['description']),
    authRecommendation: {
      recommended: auth['recommended'] === true,
      reason: cleanProse(auth['reason']),
    },
    assumptions: cleanList(raw['assumptions'], MAX_ASSUMPTIONS),
    questions: cleanList(raw['questions'], MAX_QUESTIONS),
  };
}

/**
 * The first `{` to the last `}` of the model's text, parsed.
 *
 * JSON mode makes a bare object the norm, but models still occasionally wrap it
 * in a fence or a sentence. Recovering here is cheaper and more reliable than
 * spending the one repair call on formatting.
 */
export function parseModelJson(text: string): unknown {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new SyntaxError('The response did not contain a JSON object');
  }
  return JSON.parse(unfenced.slice(start, end + 1));
}

const STOP_WORDS = new Set([
  'with',
  'and',
  'the',
  'a',
  'an',
  'for',
  'of',
  'to',
  'into',
  'that',
  'has',
]);

/**
 * A name derived from the prompt's words, for when neither the user nor the
 * model supplied one. Domain-free on purpose: it only reshapes what was typed.
 */
export function fallbackProjectName(prompt: string): string {
  const words = prompt
    .replace(/^\s*(create|generate|build|make|i need|please)\s+/i, '')
    .replace(/\bapi\b/gi, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word.toLowerCase()));
  if (words.length === 0) {
    return 'Generated API';
  }
  const title = words
    .slice(0, 3)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
  return `${title} API`;
}
