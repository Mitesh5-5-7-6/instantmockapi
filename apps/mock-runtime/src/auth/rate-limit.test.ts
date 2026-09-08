import { describe, it, expect } from 'vitest';

import { authAttemptKey } from './rate-limit.js';

/**
 * §23's credential throttle: which requests get the tight bucket, and how they
 * are keyed.
 */

const PROJECT = '6a9f919cbcbe9d243bc01e2c';
const PUBLIC_ID = 'prj_7d5e9a2f1c';
/** A cold process resolves nothing; a warm one maps the public id. */
const cold = () => null;
const warm = (publicId: string) => (publicId === PUBLIC_ID ? PROJECT : null);

const key = (url: string, ip = '1.2.3.4', resolve = warm) => authAttemptKey(url, ip, resolve);

describe('which endpoints are throttled', () => {
  it('throttles the three credential endpoints', () => {
    for (const endpoint of ['signUp', 'signIn', 'refresh']) {
      expect(key(`/p/${PROJECT}/${endpoint}`), endpoint).not.toBeNull();
    }
  });

  /**
   * `/me` and `/logout` are deliberately out.
   *
   * Neither can be used to guess a credential — `/me` reads one that already
   * verified, and `/logout` answers 204 for an invalid token — so throttling
   * them would spend the credential budget on a client polling its own session.
   */
  it('leaves /me and /logout on the ordinary project bucket', () => {
    expect(key(`/p/${PROJECT}/me`)).toBeNull();
    expect(key(`/p/${PROJECT}/logout`)).toBeNull();
  });

  it('leaves entity traffic alone', () => {
    expect(key(`/p/${PROJECT}/order`)).toBeNull();
    expect(key(`/p/${PROJECT}/order/abc`)).toBeNull();
    expect(key(`/p/${PROJECT}`)).toBeNull();
  });

  it('is null for a path that parses to nothing', () => {
    expect(key('/healthz')).toBeNull();
    expect(key('/p')).toBeNull();
    expect(key('/p/not-an-id/signIn')).toBeNull();
  });

  it('matches either spelling, since both reach the same handler', () => {
    expect(key(`/p/${PROJECT}/signup`)).toBe(key(`/p/${PROJECT}/signUp`));
  });
});

describe('how the bucket is keyed', () => {
  /**
   * Per caller IP, not per project. Under the project-wide key an attacker's
   * guesses would come out of every legitimate caller's allowance, so the
   * throttle would itself be the denial of service.
   */
  it('separates callers', () => {
    expect(key(`/p/${PROJECT}/signIn`, '1.1.1.1')).not.toBe(key(`/p/${PROJECT}/signIn`, '2.2.2.2'));
  });

  it('separates projects, so one API cannot exhaust another', () => {
    const other = '6a9f919cbcbe9d243bc01e2d';
    expect(key(`/p/${PROJECT}/signIn`)).not.toBe(key(`/p/${other}/signIn`));
  });

  /**
   * One shared budget across the three endpoints. A bucket each would hand an
   * attacker three times the allowance for rotating between them.
   */
  it('puts all three endpoints in one bucket', () => {
    const signIn = key(`/p/${PROJECT}/signIn`);
    expect(key(`/p/${PROJECT}/signUp`)).toBe(signIn);
    expect(key(`/p/${PROJECT}/refresh`)).toBe(signIn);
  });

  /**
   * Both URL forms address one project, so keying on the raw segment would let
   * a caller double their allowance by alternating them — the same flaw the
   * project-wide generator already guards against.
   */
  it('canonicalises the pretty URL to the same bucket as the legacy one', () => {
    expect(key(`/p/${PUBLIC_ID}/shop/signIn`)).toBe(key(`/p/${PROJECT}/signIn`));
  });

  it('falls back to the public id on a cold process', () => {
    // The documented imprecision: one process's first request for a project it
    // has not resolved yet keys on the public id instead.
    const value = key(`/p/${PUBLIC_ID}/shop/signIn`, '1.2.3.4', cold);
    expect(value).toContain(PUBLIC_ID);
    expect(value).not.toBeNull();
  });

  it('namespaces the key so it cannot collide with a project bucket', () => {
    // The project-wide generator emits `proj:` and `ip:`; this must not land in
    // either, or credential attempts and entity traffic would share a counter.
    expect(key(`/p/${PROJECT}/signIn`)).toMatch(/^auth:/);
  });
});
