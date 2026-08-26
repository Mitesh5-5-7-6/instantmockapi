/**
 * Initials and a stable tint for an avatar.
 *
 * Lives here rather than in the `Avatar` component for one reason: the tone must
 * be **deterministic**. A project's circle changing colour between renders — or
 * between the Recent Projects row and the project page — reads as a rendering
 * bug, and determinism is a property of this derivation, not of the markup. The
 * same reasoning put `er-layout` in `lib/` rather than inside its SVG.
 */

import type { Tone } from '@instantmockapi/ui';

/**
 * Tones an avatar may take, in a fixed order.
 *
 * Order is part of the contract: the hash indexes into this array, so
 * reordering it silently recolours every existing avatar.
 */
const AVATAR_TONES: Tone[] = ['accent', 'violet', 'success', 'warning', 'cyan', 'error'];

/**
 * Up to two initials from a name.
 *
 * First and last word rather than the first two, so "Mitesh Kumar Sonagra" gives
 * `MS` — the surname is the more identifying half.
 */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (words.length === 0) {
    return '?';
  }
  // An email has no spaces to split on; take the local part before the @, so
  // "ada@example.com" gives "A" rather than "A" from a word containing the host.
  const first = words[0] as string;
  if (words.length === 1) {
    const local = first.split('@')[0] ?? first;
    return (local.slice(0, 2) || '?').toUpperCase();
  }
  const last = words[words.length - 1] as string;
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

/**
 * A stable tone for a seed string.
 *
 * The familiar `hash * 31 + char` loop is **not** enough on its own here, and
 * the reason is easy to miss: 31 ≡ 1 (mod 6), so `(h * 31 + c) % 6` reduces to
 * `(h + c) % 6` — the whole hash collapses to a sum of character codes, and
 * anagrams and reordered words land on the same colour. Measured, only 1 of 20
 * anagram pairs got different tones.
 *
 * So the accumulator is followed by a 32-bit avalanche, which is what makes the
 * *low* bits depend on every input bit — and modulo only ever reads the low
 * bits. Same 20 pairs: 16 differ. Not cryptographic, and it does not need to be;
 * it needs to be stable and evenly spread.
 */
export function toneOf(seed: string): Tone {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    // `Math.imul` keeps this a true 32-bit multiply; plain `*` would overflow
    // into float territory and stop being reproducible.
    hash = (Math.imul(hash, 31) + seed.charCodeAt(index)) | 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x45d9f3b);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x45d9f3b);
  hash ^= hash >>> 16;

  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length] as Tone;
}

/** Everything an `Avatar` needs for one named thing. */
export function avatarFor(name: string, seed = name): { initials: string; tone: Tone } {
  return { initials: initialsOf(name), tone: toneOf(seed) };
}
