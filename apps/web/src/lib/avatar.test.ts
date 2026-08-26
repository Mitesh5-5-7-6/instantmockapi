import { describe, it, expect } from 'vitest';
import { avatarFor, initialsOf, toneOf } from './avatar';

describe('initialsOf', () => {
  it('takes the first and last word', () => {
    // Not the first two: the surname is the more identifying half, so
    // "Mitesh Kumar Sonagra" is MS rather than MK.
    expect(initialsOf('Mitesh Sonagra')).toBe('MS');
    expect(initialsOf('Mitesh Kumar Sonagra')).toBe('MS');
  });

  it('takes two letters from a single word', () => {
    expect(initialsOf('Weather')).toBe('WE');
  });

  it('reads an email as its local part', () => {
    // Otherwise "ada@example.com" would produce "AD" from a token that includes
    // the host, and every user at the same domain would look related.
    expect(initialsOf('ada@example.com')).toBe('AD');
  });

  it('tolerates extra whitespace', () => {
    expect(initialsOf('  Student   ERP  ')).toBe('SE');
  });

  it('never returns an empty string', () => {
    // A blank circle reads as a broken image.
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });

  it('is uppercase regardless of input', () => {
    expect(initialsOf('student erp')).toBe('SE');
  });

  it('handles non-Latin names without throwing', () => {
    expect(initialsOf('日本 語')).toBe('日語');
    expect(initialsOf('Ünal Öz')).toBe('ÜÖ');
  });
});

describe('toneOf', () => {
  it('is deterministic — the same seed always gives the same tone', () => {
    // The property that matters: a project must not change colour between the
    // dashboard row and its own page, or between two renders of either.
    const seeds = ['Student ERP', 'Weather API', 'a', '', '507f1f77bcf86cd799439011'];
    for (const seed of seeds) {
      expect(toneOf(seed)).toBe(toneOf(seed));
    }
  });

  it('always returns a tone the design system defines', () => {
    const allowed = ['accent', 'violet', 'success', 'warning', 'cyan', 'error'];
    for (let index = 0; index < 200; index += 1) {
      expect(allowed).toContain(toneOf(`project-${index}`));
    }
  });

  it('is order-sensitive, so anagrams mostly get different tones', () => {
    // Not asserted per-pair: with six tones any two seeds collide ~1 in 6 times
    // by chance, so a single pair differing would be luck rather than a property.
    //
    // What IS a property: order sensitivity. An order-insensitive hash (a plain
    // char-code sum) puts every anagram pair on the same tone — 0 of 20. So does
    // `hash * 31 + c` taken mod 6, because 31 ≡ 1 (mod 6) collapses it to that
    // sum; that measured 1 of 20 and is why `toneOf` avalanches the hash before
    // the modulo. This threshold catches a regression to either.
    const pairs: [string, string][] = [
      ['abc', 'cba'],
      ['listen', 'silent'],
      ['stop', 'pots'],
      ['Student ERP', 'ERP Student'],
      ['dog', 'god'],
      ['evil', 'vile'],
      ['node', 'done'],
      ['tar', 'rat'],
      ['form', 'from'],
      ['item', 'time'],
      ['name', 'mean'],
      ['skate', 'stake'],
      ['below', 'elbow'],
      ['cider', 'cried'],
      ['dusty', 'study'],
      ['night', 'thing'],
      ['spare', 'pears'],
      ['angel', 'glean'],
      ['east', 'seat'],
      ['ab', 'ba'],
    ];
    const differing = pairs.filter(([a, b]) => toneOf(a) !== toneOf(b)).length;
    expect(differing).toBeGreaterThan(pairs.length / 2);
  });

  it('spreads across the palette rather than favouring one tone', () => {
    const counts = new Map<string, number>();
    for (let index = 0; index < 300; index += 1) {
      const tone = toneOf(`project-${index}`);
      counts.set(tone, (counts.get(tone) ?? 0) + 1);
    }
    // Every tone gets used, and none takes more than half.
    expect(counts.size).toBe(6);
    for (const count of counts.values()) {
      expect(count).toBeLessThan(150);
    }
  });

  it('handles an empty seed', () => {
    expect(typeof toneOf('')).toBe('string');
  });
});

describe('avatarFor', () => {
  it('bundles initials and tone', () => {
    expect(avatarFor('Student ERP')).toEqual({
      initials: 'SE',
      tone: toneOf('Student ERP'),
    });
  });

  it('accepts a separate seed, so a rename keeps the colour', () => {
    // Seeding on the project id rather than the name means renaming a project
    // does not reshuffle its colour in a list the user has learned to scan.
    const byId = avatarFor('Old Name', 'project-123');
    const afterRename = avatarFor('New Name', 'project-123');
    expect(afterRename.tone).toBe(byId.tone);
    expect(afterRename.initials).not.toBe(byId.initials);
  });
});
