/**
 * The §21 auth tester's state machine.
 *
 * §21 asks for a panel that signs up, signs in, refreshes, reads `/me`, logs
 * out, and then calls a protected endpoint to show 200 or 401 — against the
 * **actual hosted mock API**, not a simulation. Simulating it would test this
 * page rather than the thing the user is trying to check.
 *
 * Pure, so the transitions are testable under `environment: 'node'`. The
 * component owns the fetches; everything about *what state we are in and what
 * is offered next* is here.
 *
 * ## The tokens are the user's own
 *
 * These credentials belong to an end user of the user's own mock API. They are
 * not platform secrets, so holding them in component state is appropriate —
 * but they are still credentials, so they are masked rather than rendered, and
 * offered through a copy action instead. A token printed as text ends up in
 * screenshots and screen shares.
 *
 * Nothing is persisted. A reload signs the tester out, which is the honest
 * behaviour for a scratchpad and avoids leaving a live token in `localStorage`
 * where the hosted API's own users could never have put one.
 */

export interface TesterSession {
  email: string;
  accessToken: string | null;
  refreshToken: string | null;
  /** What `/me` last returned, for §21's user line. */
  user: Record<string, unknown> | null;
}

export type TesterStatus = 'signed-out' | 'authenticated' | 'cookie-session';

/**
 * Cookie mode has a third state, and collapsing it would make the panel lie.
 *
 * The tokens are in HttpOnly cookies, so the tester genuinely cannot see them —
 * `accessToken` is null while the session is live. Reporting that as signed out
 * would contradict a working `/me`; reporting it as `authenticated` with an
 * empty token would suggest something had gone wrong.
 */
export function testerStatus(session: TesterSession | null, cookieAuth: boolean): TesterStatus {
  if (session === null) {
    return 'signed-out';
  }
  if (cookieAuth) {
    return 'cookie-session';
  }
  return session.accessToken === null ? 'signed-out' : 'authenticated';
}

export const STATUS_LABEL: Record<TesterStatus, string> = {
  'signed-out': 'Signed out',
  authenticated: 'Authenticated',
  'cookie-session': 'Authenticated (cookie)',
};

/** Which `StatusChip` tone the dot takes. */
export const STATUS_TONE: Record<TesterStatus, string> = {
  'signed-out': 'draft',
  authenticated: 'live',
  'cookie-session': 'live',
};

export interface TesterActions {
  signUp: boolean;
  signIn: boolean;
  refresh: boolean;
  me: boolean;
  logout: boolean;
  /** Call a protected endpoint, which is the point of the whole panel. */
  probe: boolean;
}

/**
 * What the panel offers, given the project's config and the current session.
 *
 * `signUp`/`refresh` follow the project — an endpoint the project does not
 * generate must not be offered, or the tester reports a 404 as though the user
 * had done something wrong.
 *
 * `probe` is offered when signed out too, deliberately: seeing the 401 is half
 * of §21's demonstration, and a disabled button would hide the more instructive
 * half.
 */
export function testerActions(params: {
  status: TesterStatus;
  signup: boolean;
  refreshToken: boolean;
  hasRefreshToken: boolean;
  cookieAuth: boolean;
}): TesterActions {
  const live = params.status !== 'signed-out';
  return {
    signUp: params.signup,
    signIn: true,
    // In cookie mode the browser holds the refresh cookie, so no stored token
    // is needed — which is why `hasRefreshToken` is not consulted there.
    refresh: params.refreshToken && live && (params.cookieAuth || params.hasRefreshToken),
    me: live,
    logout: live,
    probe: true,
  };
}

/**
 * A credential, masked.
 *
 * Length-independent: showing the real length of a token leaks a little about
 * it and, more practically, a 300-character row of dots is unreadable. The
 * copy action is how a user gets the value.
 */
export function maskToken(token: string | null): string {
  return token === null || token === '' ? '—' : '••••••••';
}

export interface ProbeResult {
  status: number;
  /** The entity path called, so the panel can name it. */
  path: string;
}

/**
 * §21's verdict line.
 *
 * Says what the status *means* for the endpoint rather than restating the code:
 * a developer reading `401` already knows the number, and what they are
 * checking is whether their configuration did what they intended.
 */
export function describeProbe(result: ProbeResult, expected: 'PUBLIC' | 'PROTECTED'): string {
  const { status, path } = result;
  if (status === 200) {
    return expected === 'PROTECTED'
      ? `200 — /${path} accepted the token.`
      : `200 — /${path} is public and answered without a token.`;
  }
  if (status === 401) {
    return expected === 'PROTECTED'
      ? `401 — /${path} requires a token. Sign in and try again.`
      : `401 — /${path} refused the request, but this entity is configured public. The live API is serving an older version; regenerate and publish.`;
  }
  if (status === 429) {
    return `429 — too many credential attempts. Wait a minute and retry.`;
  }
  if (status === 404) {
    return `404 — /${path} is not on the live API. Generate and publish this version first.`;
  }
  return `${status} — unexpected response from /${path}.`;
}

/**
 * Whether a probe result contradicts the saved configuration.
 *
 * The most useful thing this panel can tell a user, and the one their own
 * reading of the UI cannot: the tab shows the *draft* while the tester calls
 * the *published* API. A public entity answering 401 means the live version
 * predates the change — which looks like a bug in the product until somebody
 * says otherwise.
 */
export function probeContradictsConfig(
  result: ProbeResult,
  expected: 'PUBLIC' | 'PROTECTED',
  authenticated: boolean,
): boolean {
  if (expected === 'PUBLIC') {
    return result.status === 401;
  }
  // A protected endpoint answering 200 without a credential is the serious
  // direction: data the user believes is closed is open.
  return !authenticated && result.status === 200;
}
