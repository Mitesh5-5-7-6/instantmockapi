import { describe, it, expect } from 'vitest';

import {
  STATUS_LABEL,
  describeProbe,
  maskToken,
  probeContradictsConfig,
  testerActions,
  testerStatus,
  type TesterSession,
} from './auth-tester';

const session = (over: Partial<TesterSession> = {}): TesterSession => ({
  email: 'end-user@example.com',
  accessToken: 'header.payload.signature',
  refreshToken: 'opaque-refresh',
  user: null,
  ...over,
});

describe('testerStatus', () => {
  it('is signed out with no session', () => {
    expect(testerStatus(null, false)).toBe('signed-out');
  });

  it('is authenticated with a token', () => {
    expect(testerStatus(session(), false)).toBe('authenticated');
  });

  /**
   * Cookie mode is a third state, not a variant of the other two.
   *
   * The tokens are in HttpOnly cookies, so the tester genuinely cannot see
   * them. Reporting that as signed out would contradict a working `/me`;
   * reporting it as authenticated with an empty token would suggest a fault.
   */
  it('reports a cookie session distinctly', () => {
    const cookieSession = session({ accessToken: null, refreshToken: null });
    expect(testerStatus(cookieSession, true)).toBe('cookie-session');
    expect(STATUS_LABEL['cookie-session']).not.toBe(STATUS_LABEL.authenticated);
    expect(STATUS_LABEL['cookie-session']).not.toBe(STATUS_LABEL['signed-out']);
  });

  it('is signed out when a non-cookie session lost its token', () => {
    expect(testerStatus(session({ accessToken: null }), false)).toBe('signed-out');
  });
});

describe('testerActions', () => {
  const actions = (over: Partial<Parameters<typeof testerActions>[0]> = {}) =>
    testerActions({
      status: 'authenticated',
      signup: true,
      refreshToken: true,
      hasRefreshToken: true,
      cookieAuth: false,
      ...over,
    });

  it('offers the full set on a live session', () => {
    expect(actions()).toEqual({
      signUp: true,
      signIn: true,
      refresh: true,
      me: true,
      logout: true,
      probe: true,
    });
  });

  /**
   * An endpoint the project does not generate must not be offered, or the
   * tester reports a 404 as though the user had done something wrong.
   */
  it('hides signUp and refresh when the project does not generate them', () => {
    expect(actions({ signup: false }).signUp).toBe(false);
    expect(actions({ refreshToken: false }).refresh).toBe(false);
  });

  it('withholds session actions while signed out', () => {
    const signedOut = actions({ status: 'signed-out' });
    expect(signedOut.me).toBe(false);
    expect(signedOut.logout).toBe(false);
    expect(signedOut.refresh).toBe(false);
  });

  /**
   * Seeing the 401 is half of §21's demonstration, and a disabled button would
   * hide the more instructive half.
   */
  it('offers the probe even when signed out', () => {
    expect(actions({ status: 'signed-out' }).probe).toBe(true);
  });

  it('offers refresh in cookie mode with no stored token', () => {
    // The browser holds the refresh cookie, so there is nothing for the tester
    // to have kept.
    expect(
      actions({ status: 'cookie-session', cookieAuth: true, hasRefreshToken: false }).refresh,
    ).toBe(true);
  });

  it('withholds refresh outside cookie mode when no token was kept', () => {
    expect(actions({ hasRefreshToken: false }).refresh).toBe(false);
  });
});

describe('maskToken', () => {
  it('never renders the value', () => {
    expect(maskToken('header.payload.signature')).not.toContain('signature');
  });

  it('does not leak the length', () => {
    // A 300-character row of dots is unreadable, and the length says a little
    // about the token. The copy action is how a user gets the value.
    expect(maskToken('a'.repeat(300))).toBe(maskToken('abc'));
  });

  it('shows a dash rather than dots for nothing', () => {
    expect(maskToken(null)).toBe('—');
    expect(maskToken('')).toBe('—');
  });
});

describe('describeProbe', () => {
  it('says what a 200 means for a protected endpoint', () => {
    expect(describeProbe({ status: 200, path: 'order' }, 'PROTECTED')).toContain(
      'accepted the token',
    );
  });

  it('tells a signed-out user what to do about a 401', () => {
    expect(describeProbe({ status: 401, path: 'order' }, 'PROTECTED')).toContain('Sign in');
  });

  /**
   * The most useful thing the panel can say. The tab shows the *draft* while
   * the tester calls the *published* API, so a public entity answering 401
   * means the live version predates the change — which reads as a product bug
   * until somebody explains it.
   */
  it('explains a 401 on an entity configured public', () => {
    const message = describeProbe({ status: 401, path: 'product' }, 'PUBLIC');
    expect(message).toContain('older version');
    expect(message).toContain('regenerate');
  });

  it('explains a 404 as an unpublished version rather than a missing entity', () => {
    expect(describeProbe({ status: 404, path: 'order' }, 'PROTECTED')).toContain('publish');
  });

  it('explains a 429 as the credential throttle', () => {
    expect(describeProbe({ status: 429, path: 'order' }, 'PROTECTED')).toContain('Wait a minute');
  });

  it('does not pretend to understand an unexpected status', () => {
    expect(describeProbe({ status: 503, path: 'order' }, 'PROTECTED')).toContain('unexpected');
  });
});

describe('probeContradictsConfig', () => {
  it('flags a public entity that refused the request', () => {
    expect(probeContradictsConfig({ status: 401, path: 'product' }, 'PUBLIC', false)).toBe(true);
  });

  /**
   * The serious direction: data the user believes is closed is open. Worth
   * flagging louder than the other way round, which is merely stale.
   */
  it('flags a protected entity that answered without a credential', () => {
    expect(probeContradictsConfig({ status: 200, path: 'order' }, 'PROTECTED', false)).toBe(true);
  });

  it('does not flag a protected entity answering an authenticated call', () => {
    expect(probeContradictsConfig({ status: 200, path: 'order' }, 'PROTECTED', true)).toBe(false);
  });

  it('does not flag a public entity answering normally', () => {
    expect(probeContradictsConfig({ status: 200, path: 'product' }, 'PUBLIC', false)).toBe(false);
  });
});
