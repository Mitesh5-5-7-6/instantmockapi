/**
 * Password rules, in the browser (doc 13 §7.3).
 *
 * A deliberate duplicate of `passwordProblems` in the API's auth-service: the
 * API's copy is the one that decides, and this one exists so the form can say
 * what is wrong *before* a round trip and *before* the account is created. Client
 * validation that is not repeated on the server is worthless; server validation
 * with no client counterpart is merely slow.
 *
 * Keep the two in step. If they drift, the API wins and the user sees a message
 * they were not warned about.
 */

/** Matches MIN_PASSWORD_LENGTH in the API. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * The same short deny-list the API carries.
 *
 * Not a serious dictionary — a guard rail against the handful of choices that
 * would fall to a first guess. The real defence is the server's rate limit.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  'qwertyuiop',
  '1234567890',
  'letmein123',
  'iloveyou1',
  'admin12345',
  'welcome123',
  'instantmockapi',
]);

/**
 * Every reason a password is unacceptable, or an empty list.
 *
 * All of them at once, so the form shows the full picture instead of revealing
 * one rule per attempt.
 */
export function passwordProblems(password: string, email?: string): string[] {
  const problems: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    problems.push('This password is too common — pick something less guessable');
  }
  if (email !== undefined && email !== '') {
    const local = email.split('@')[0] ?? '';
    if (
      password.toLowerCase() === email.toLowerCase() ||
      password.toLowerCase() === local.toLowerCase()
    ) {
      problems.push('Do not use your email address as your password');
    }
  }
  return problems;
}

/**
 * The requirements as a checklist, each with whether it is met.
 *
 * Shown from the moment the field is focused rather than only after a failed
 * submit: a rule you learn by breaking it is a rule you had to guess.
 */
export interface PasswordRule {
  label: string;
  met: boolean;
}

export function passwordRules(password: string, email?: string): PasswordRule[] {
  const problems = new Set(passwordProblems(password, email));
  const has = (fragment: string) =>
    ![...problems].some((problem) => problem.toLowerCase().includes(fragment));
  return [
    { label: `At least ${MIN_PASSWORD_LENGTH} characters`, met: has('characters') },
    { label: 'Not a commonly used password', met: has('too common') },
    { label: 'Not your email address', met: has('email address') },
  ];
}

/**
 * A rough strength band, for the meter.
 *
 * Explicitly **not** a security control — it does not gate anything, and the
 * rules above are what actually decide. It is feedback: a bar that moves as you
 * type is what makes people choose longer passwords, which is the one property
 * that reliably matters.
 */
export type PasswordStrength = 'empty' | 'weak' | 'fair' | 'good' | 'strong';

export function passwordStrength(password: string, email?: string): PasswordStrength {
  if (password === '') {
    return 'empty';
  }
  if (passwordProblems(password, email).length > 0) {
    return 'weak';
  }
  // Length first, then variety — in that order, because length is what buys
  // entropy and variety is a tiebreaker.
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;
  if (password.length >= 20 || (password.length >= 16 && classes >= 3)) {
    return 'strong';
  }
  if (password.length >= 14 || classes >= 3) {
    return 'good';
  }
  return 'fair';
}

/** 0–1, for the width of the meter. */
export function strengthFraction(strength: PasswordStrength): number {
  switch (strength) {
    case 'empty':
      return 0;
    case 'weak':
      return 0.25;
    case 'fair':
      return 0.5;
    case 'good':
      return 0.75;
    case 'strong':
      return 1;
  }
}
