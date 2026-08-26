/**
 * PKCE and the OAuth handshake nonce (doc 13 §6, RFC 7636).
 *
 * Two separate secrets doing two separate jobs, and it is worth being clear
 * about which is which:
 *
 * **PKCE** protects the *authorization code*. The verifier stays in this tab; only
 * its SHA-256 goes to Google. An attacker who intercepts the code cannot redeem
 * it without the verifier, so a code leaked through a referrer header, a shared
 * screen or browser history is useless on its own.
 *
 * **`state`** protects the *handshake*. It is echoed back by Google and compared
 * here, so a callback the user did not initiate — an attacker's link carrying
 * their own code — is rejected before it is exchanged.
 *
 * Neither replaces the other. PKCE with no `state` accepts a forced login;
 * `state` with no PKCE leaves the code redeemable by whoever sees it.
 */

/**
 * 32 bytes, base64url — 43 characters, inside RFC 7636's 43–128 range.
 *
 * base64url specifically: the verifier travels in a POST body and the challenge
 * in a query string, and standard base64's `+` and `/` would need escaping in
 * both.
 */
const VERIFIER_BYTES = 32;
const STATE_BYTES = 16;

function randomBase64Url(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64UrlEncode(buffer);
}

/**
 * base64url of raw bytes, by hand.
 *
 * `btoa` needs a binary string and emits standard base64, so the padding and the
 * two substituted characters have to be fixed up. Built via `String.fromCharCode`
 * over the array rather than a spread, which blows the argument limit on a large
 * buffer.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh PKCE code verifier. */
export function createVerifier(): string {
  return randomBase64Url(VERIFIER_BYTES);
}

/** A fresh `state` nonce for the authorization request. */
export function randomState(): string {
  return randomBase64Url(STATE_BYTES);
}

/**
 * The S256 challenge for a verifier: base64url(SHA-256(ascii(verifier))).
 *
 * Async because `crypto.subtle.digest` is. Only S256 is offered — the `plain`
 * method RFC 7636 also allows sends the verifier itself in the query string,
 * which defeats the entire mechanism.
 */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Where the PKCE state lives between the redirect and the callback. */
const VERIFIER_KEY = 'instantmockapi.pkce.verifier';
const STATE_KEY = 'instantmockapi.pkce.state';
const RETURN_TO_KEY = 'instantmockapi.pkce.returnTo';

/**
 * `sessionStorage`, not `localStorage`.
 *
 * The handshake is per-tab and lives for seconds. `localStorage` would share it
 * across tabs, so two sign-ins started at once would overwrite each other's
 * verifier and both would fail — and it would outlive the attempt, leaving a
 * stale verifier to be matched against a later callback.
 */
export interface PendingHandshake {
  verifier: string;
  state: string;
  returnTo: string | null;
}

export function rememberHandshake(handshake: PendingHandshake): void {
  try {
    sessionStorage.setItem(VERIFIER_KEY, handshake.verifier);
    sessionStorage.setItem(STATE_KEY, handshake.state);
    if (handshake.returnTo !== null) {
      sessionStorage.setItem(RETURN_TO_KEY, handshake.returnTo);
    } else {
      sessionStorage.removeItem(RETURN_TO_KEY);
    }
  } catch {
    // Storage can be unavailable (private mode, blocked site data). The callback
    // then finds nothing and refuses the exchange, which is the safe direction.
  }
}

/**
 * Read and immediately clear the pending handshake.
 *
 * Clearing on read is what makes it single-use: a replayed callback URL finds
 * nothing and is refused, rather than being exchanged a second time.
 */
export function takeHandshake(): PendingHandshake | null {
  try {
    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    const state = sessionStorage.getItem(STATE_KEY);
    const returnTo = sessionStorage.getItem(RETURN_TO_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(RETURN_TO_KEY);
    if (verifier === null || state === null) {
      return null;
    }
    return { verifier, state, returnTo };
  } catch {
    return null;
  }
}

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}

/**
 * Google's authorization URL.
 *
 * `scope` is `openid email profile` and nothing more: the only thing wanted from
 * Google is a verified identity, and asking for more would put a consent screen
 * full of unnecessary permissions in front of every new user.
 */
export function googleAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Skips the account chooser for a returning user with one Google account,
  // which is the common case and the difference between one click and three.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

/** The redirect URI, which must match the one registered with Google exactly. */
export function googleRedirectUri(origin: string): string {
  return `${origin}/auth/callback/google`;
}
