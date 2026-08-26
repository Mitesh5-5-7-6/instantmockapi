/**
 * Typed client for the platform API (doc 08, doc 13 §1).
 *
 * ## Where the tokens live, and why
 *
 * The **access token is a module variable** — not `localStorage`, not a cookie
 * readable by script. It dies with the page, which is the point: an XSS bug can
 * only steal a credential that is about to expire anyway, and cannot reach into
 * storage for a durable one.
 *
 * The **refresh token is an httpOnly cookie** the API sets and this code never
 * sees. Because the access token does not survive a reload, the app must ask for
 * a new one on boot — `restoreSession()` below, which every consumer waits on
 * before the first authenticated request.
 *
 * That makes auth state genuinely asynchronous, which it was not before: the old
 * client could answer "is the user signed in" synchronously from
 * `localStorage`. Now the honest answer starts as `unknown` and resolves to
 * `authenticated` or `anonymous` once the boot refresh returns.
 */

import type { ApiErrorEnvelope, AuthSession } from './api-types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: { path: string; issue: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
}

/**
 * The header the API demands on every cookie-authenticated route.
 *
 * A browser cannot attach a custom header to a cross-origin request without
 * first passing a CORS preflight, and the preflight fails for any origin the API
 * does not allow — so this is what makes those routes un-forgeable from another
 * site. It must match `CSRF_HEADER_VALUE` in the API.
 */
const CSRF_HEADERS = { 'x-requested-with': 'instantmockapi' } as const;

/** Access token, in memory only. Never persisted anywhere. */
let accessToken: string | null = null;

export type AuthState = 'unknown' | 'authenticated' | 'anonymous';

let authState: AuthState = 'unknown';

const authListeners = new Set<() => void>();

/**
 * Subscribe to auth-state changes. Shaped for `useSyncExternalStore`.
 *
 * No `storage` event listener any more: with nothing in `localStorage` there is
 * nothing for another tab to observe. Cross-tab agreement now comes from the
 * shared cookie instead — each tab discovers the same session on its own boot,
 * and a sign-out in one tab is noticed by the others when their access token
 * next expires and the refresh is refused.
 */
export function subscribeAuth(listener: () => void): () => void {
  authListeners.add(listener);
  return () => {
    authListeners.delete(listener);
  };
}

export function getAuthState(): AuthState {
  return authState;
}

/** The server/hydration snapshot. Always `unknown` — there is no session there. */
export function getServerAuthState(): AuthState {
  return 'unknown';
}

function setAuth(state: AuthState, token: string | null): void {
  accessToken = token;
  if (authState === state) {
    // Still notify on a token swap within the same state (a silent refresh), so
    // nothing caches a stale header — but skip the render churn of an unchanged
    // state transition.
    return;
  }
  authState = state;
  for (const listener of authListeners) {
    listener();
  }
}

/** Record a session the API just handed us. */
export function adoptSession(session: { accessToken: string }): void {
  setAuth('authenticated', session.accessToken);
}

/** Forget the local session. Does not touch the cookie — only the API can. */
export function forgetSession(): void {
  setAuth('anonymous', null);
}

async function parseError(response: Response): Promise<ApiError> {
  let envelope: ApiErrorEnvelope | null = null;
  try {
    envelope = (await response.json()) as ApiErrorEnvelope;
  } catch {
    // non-JSON error body
  }
  return new ApiError(
    response.status,
    envelope?.error.code ?? 'INTERNAL_ERROR',
    envelope?.error.message ?? `Request failed with status ${response.status}`,
    envelope?.error.details,
  );
}

/**
 * Ask the API for a fresh access token using the refresh cookie.
 *
 * `credentials: 'include'` is mandatory and easy to omit: without it the browser
 * sends no cookie cross-origin and every refresh fails with a 401 that looks
 * exactly like an expired session.
 */
async function requestRefresh(): Promise<boolean> {
  try {
    const response = await fetch(`${apiBaseUrl()}/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: CSRF_HEADERS,
    });
    if (!response.ok) {
      // A 401 here is the ordinary answer for a visitor who is not signed in,
      // not an error worth surfacing.
      forgetSession();
      return false;
    }
    const session = (await response.json()) as AuthSession;
    adoptSession(session);
    return true;
  } catch {
    // Network failure. Deliberately *not* treated as "signed out": a flaky
    // connection would otherwise dump the user on the sign-in screen and lose
    // whatever they were doing.
    return false;
  }
}

/**
 * In-flight refresh, shared by every caller.
 *
 * Without this, a page that fires six queries at once and finds the access token
 * expired would send six refresh requests. Worse, under the old rotating-cookie
 * design five of them would have failed. The cookie no longer rotates, but
 * coalescing is still the difference between one request and a burst that hits
 * the endpoint's own rate limit.
 */
let inFlightRefresh: Promise<boolean> | null = null;

function refreshOnce(): Promise<boolean> {
  inFlightRefresh ??= requestRefresh().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

/**
 * Establish auth state at app boot.
 *
 * Called once, before anything else fetches. Until it resolves the state is
 * `unknown` and the shell shows its splash — rendering the sign-in screen during
 * that window would flash it at every already-signed-in visitor on every page
 * load.
 */
export function restoreSession(): Promise<boolean> {
  return refreshOnce();
}

/**
 * Authenticated JSON request against the platform API.
 *
 * On a 401 it refreshes once and retries. The retry is what makes a 900-second
 * access token invisible: the token expires mid-session, one request pays for a
 * refresh, and the user notices nothing.
 */
export async function apiFetch<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    retryOn401?: boolean;
    /** Send the refresh cookie and the CSRF header. Only /v1/auth needs this. */
    withCredentials?: boolean;
  } = {},
): Promise<T> {
  const { method = 'GET', body, retryOn401 = true, withCredentials = false } = options;

  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method,
    ...(withCredentials ? { credentials: 'include' as const } : {}),
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(accessToken !== null ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(withCredentials ? CSRF_HEADERS : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 401 && retryOn401 && (await refreshOnce())) {
    return apiFetch<T>(path, { method, body, withCredentials, retryOn401: false });
  }
  if (!response.ok) {
    throw await parseError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/**
 * Subscribe to a job's SSE progress stream (doc 08 §4). EventSource cannot carry
 * an Authorization header, so this parses the stream via fetch.
 * Returns an abort function.
 */
export function subscribeJobStream(
  jobId: string,
  onSnapshot: (snapshot: unknown) => void,
  onEnd?: () => void,
): () => void {
  const controller = new AbortController();

  void (async () => {
    try {
      const response = await fetch(`${apiBaseUrl()}/v1/jobs/${jobId}/stream`, {
        headers: accessToken !== null ? { authorization: `Bearer ${accessToken}` } : {},
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        onEnd?.();
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
          if (dataLine) {
            try {
              onSnapshot(JSON.parse(dataLine.slice('data: '.length)));
            } catch {
              // skip malformed frame
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // aborted or network failure — the poll-based job query still covers state
    } finally {
      onEnd?.();
    }
  })();

  return () => controller.abort();
}

/** The access token, for the few places that need it directly (artifact downloads). */
export function currentAccessToken(): string | null {
  return accessToken;
}
