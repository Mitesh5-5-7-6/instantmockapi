import { describe, it, expect } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  passwordProblems,
  passwordRules,
  passwordStrength,
  strengthFraction,
} from './password';

describe('passwordProblems', () => {
  it('accepts a long, unremarkable password', () => {
    expect(passwordProblems('correct-horse-battery', 'ada@example.com')).toEqual([]);
  });

  it('requires length rather than symbol classes', () => {
    // NIST 800-63B: mandated composition rules mostly produce `Password1!`.
    expect(passwordProblems('Sh0rt!')).toEqual([`Use at least ${MIN_PASSWORD_LENGTH} characters`]);
    expect(passwordProblems('all lower case letters')).toEqual([]);
  });

  it('rejects the deny-listed passwords case-insensitively', () => {
    expect(passwordProblems('password123')[0]).toMatch(/too common/i);
    // Otherwise the list is bypassed by holding shift.
    expect(passwordProblems('PassWord123')[0]).toMatch(/too common/i);
  });

  it('rejects a password derived from the email', () => {
    expect(passwordProblems('ada@example.com', 'ada@example.com')[0]).toMatch(/email address/i);
    expect(passwordProblems('adalovelace', 'adalovelace@example.com')[0]).toMatch(/email address/i);
  });

  it('needs no email to be useful', () => {
    // The signup form validates as you type, before the email field is filled.
    expect(passwordProblems('short')).toHaveLength(1);
    expect(passwordProblems('a-perfectly-fine-one')).toEqual([]);
  });

  it('reports every problem at once', () => {
    // So the form shows them together instead of one rule per attempt.
    expect(passwordProblems('password', 'password@example.com')).toHaveLength(3);
  });
});

describe('passwordRules', () => {
  it('marks each requirement met or unmet', () => {
    const rules = passwordRules('short', 'ada@example.com');
    expect(rules.map((rule) => rule.met)).toEqual([false, true, true]);
  });

  it('marks all three met for an acceptable password', () => {
    expect(passwordRules('a-perfectly-fine-one', 'ada@example.com').every((r) => r.met)).toBe(true);
  });

  /**
   * An empty field shows the length rule as unmet and the others as met, so the
   * checklist reads as "here is what you need" rather than as three failures
   * before a single keystroke.
   */
  it('does not read as all-failed before anything is typed', () => {
    const rules = passwordRules('', 'ada@example.com');
    expect(rules.filter((rule) => !rule.met)).toHaveLength(1);
  });

  it('keeps the labels in step with the minimum', () => {
    expect(passwordRules('')[0]?.label).toContain(String(MIN_PASSWORD_LENGTH));
  });
});

describe('passwordStrength', () => {
  it('reports empty distinctly from weak', () => {
    // An empty field should show no bar at all, not a red one — nothing has been
    // rejected yet.
    expect(passwordStrength('')).toBe('empty');
    expect(passwordStrength('short')).toBe('weak');
  });

  it('treats anything the rules reject as weak', () => {
    expect(passwordStrength('password123')).toBe('weak');
    expect(passwordStrength('ada@example.com', 'ada@example.com')).toBe('weak');
  });

  it('rewards length over variety', () => {
    // The property worth encouraging: a long all-lowercase passphrase beats a
    // short one with punctuation in it.
    const long = passwordStrength('correct horse battery staple');
    const shortAndFussy = passwordStrength('Ab3$Ab3$Ab');
    expect(strengthFraction(long)).toBeGreaterThan(strengthFraction(shortAndFussy));
  });

  it('rises monotonically as a password grows', () => {
    const fractions = [
      'abcdefghij',
      'abcdefghijklmn',
      'abcdefghijklmnopqrst',
      'abcdefghijklmnopqrstuvwxyz',
    ].map((password) => strengthFraction(passwordStrength(password)));
    // A meter that goes backwards as you add characters teaches the wrong thing.
    for (let i = 1; i < fractions.length; i += 1) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1] as number);
    }
  });

  it('never reports strong for something the API would reject', () => {
    for (const password of ['password123', 'short', '']) {
      expect(passwordStrength(password)).not.toBe('strong');
    }
  });
});

describe('strengthFraction', () => {
  it('spans zero to one', () => {
    expect(strengthFraction('empty')).toBe(0);
    expect(strengthFraction('strong')).toBe(1);
  });

  it('orders the bands', () => {
    const bands = (['empty', 'weak', 'fair', 'good', 'strong'] as const).map(strengthFraction);
    expect(bands).toEqual([...bands].sort((a, b) => a - b));
  });
});
