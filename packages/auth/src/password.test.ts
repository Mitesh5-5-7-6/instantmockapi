import { describe, it, expect } from 'vitest';
import { PASSWORD_COST, hashPassword, needsRehash, verifyPassword } from './password.js';

// scrypt at N=2^16 is deliberately slow. These are the only slow tests in the
// package, so the timeout is raised rather than the cost lowered — testing a
// weaker KDF than production uses would defeat the point.
const SLOW = 20_000;

describe('hashPassword', () => {
  it(
    'produces a PHC-style string carrying its own cost parameters',
    async () => {
      const hash = await hashPassword('correct horse battery staple');
      const [scheme, n, r, p, salt, key] = hash.split('$');
      expect(scheme).toBe('scrypt');
      expect(Number(n)).toBe(PASSWORD_COST.N);
      expect(Number(r)).toBe(PASSWORD_COST.r);
      expect(Number(p)).toBe(PASSWORD_COST.p);
      expect((salt ?? '').length).toBeGreaterThan(0);
      expect((key ?? '').length).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    'never contains the password',
    async () => {
      const hash = await hashPassword('hunter2-is-a-terrible-password');
      expect(hash).not.toContain('hunter2');
    },
    SLOW,
  );

  it(
    'salts, so the same password hashes differently every time',
    async () => {
      const [a, b] = await Promise.all([
        hashPassword('same-password'),
        hashPassword('same-password'),
      ]);
      expect(a).not.toBe(b);
      // ...and both still verify.
      expect(await verifyPassword('same-password', a)).toBe(true);
      expect(await verifyPassword('same-password', b)).toBe(true);
    },
    SLOW,
  );
});

describe('verifyPassword', () => {
  it(
    'accepts the right password and rejects a wrong one',
    async () => {
      const hash = await hashPassword('s3cret-passphrase');
      expect(await verifyPassword('s3cret-passphrase', hash)).toBe(true);
      expect(await verifyPassword('s3cret-passphras', hash)).toBe(false);
      expect(await verifyPassword('S3cret-passphrase', hash)).toBe(false);
      expect(await verifyPassword('', hash)).toBe(false);
    },
    SLOW,
  );

  it(
    'matches a password typed with a different unicode normalisation',
    async () => {
      // "café" as e-with-acute vs e + combining acute. Same password to a human,
      // different bytes — and it would silently fail to match without NFKC.
      const composed = 'café-password';
      const decomposed = 'café-password';
      expect(composed).not.toBe(decomposed);
      const hash = await hashPassword(composed);
      expect(await verifyPassword(decomposed, hash)).toBe(true);
    },
    SLOW,
  );

  it('returns false — never throws — for a malformed stored hash', async () => {
    // A corrupt row must fail one sign-in, not 500 the endpoint.
    for (const stored of [
      '',
      'not-a-hash',
      'scrypt$65536$8$1$onlyfiveparts',
      'scrypt$65536$8$1$c2FsdA$', // empty key
      'scrypt$65536$8$1$$aGFzaA', // empty salt
      'bcrypt$65536$8$1$c2FsdA$aGFzaA', // wrong scheme
      'scrypt$notanumber$8$1$c2FsdA$aGFzaA',
      'scrypt$65536$0$1$c2FsdA$aGFzaA', // r below bounds
      'scrypt$65536$8$0$c2FsdA$aGFzaA', // p below bounds
    ]) {
      await expect(verifyPassword('anything', stored)).resolves.toBe(false);
    }
  });

  it('refuses a cost parameter outside the safe bounds', async () => {
    // The attack this prevents: scrypt's memory cost is 128 * N * r, so a
    // tampered hash claiming N = 2^30 would make one verification allocate
    // gigabytes. Parsing rejects it instead of trusting the stored number.
    for (const stored of [
      'scrypt$1073741824$8$1$c2FsdA$aGFzaA', // 2^30 — far too large
      'scrypt$1024$8$1$c2FsdA$aGFzaA', // 2^10 — too weak
      'scrypt$65535$8$1$c2FsdA$aGFzaA', // not a power of two
      'scrypt$65536$64$1$c2FsdA$aGFzaA', // r above bounds
    ]) {
      await expect(verifyPassword('anything', stored)).resolves.toBe(false);
    }
  });

  it(
    'verifies a hash made with weaker but still legal parameters',
    async () => {
      // The whole point of storing the cost: raising N must not lock anyone out.
      // This hash was produced at N=2^14 with the same derivation.
      const { scrypt } = await import('node:crypto');
      const { promisify } = await import('node:util');
      const derive = promisify(scrypt);
      const salt = Buffer.from('legacy-salt-1234');
      const key = (await derive('old-password'.normalize('NFKC'), salt, 64, {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 128 * 16384 * 8 * 2,
      })) as Buffer;
      const legacy = `scrypt$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;

      expect(await verifyPassword('old-password', legacy)).toBe(true);
      expect(await verifyPassword('wrong', legacy)).toBe(false);
    },
    SLOW,
  );
});

describe('needsRehash', () => {
  it(
    'is false for a hash at the current cost',
    async () => {
      expect(needsRehash(await hashPassword('current'))).toBe(false);
    },
    SLOW,
  );

  it('is true for a weaker hash, so sign-in can upgrade it', () => {
    expect(needsRehash('scrypt$16384$8$1$c2FsdA$aGFzaA')).toBe(true);
  });

  it('is true for anything unparseable', () => {
    expect(needsRehash('garbage')).toBe(true);
  });
});
