/**
 * One place that turns anything thrown into something a person can read.
 *
 * Every failure in the app arrives here first — an `ApiError` from the platform
 * API, a `NetworkError` from a request that never landed, or an arbitrary
 * exception from code that did something unexpected. It leaves as an
 * `AppFailure`: a sentence, a kind, and the technical detail kept separately for
 * a "View details" panel.
 *
 * ## Why this is a normaliser and not a renderer
 *
 * It decides *what* the failure is, never *where* it goes. That split is what
 * lets one action produce inline field errors and a single summarising toast
 * rather than one of each per layer that happens to catch the same error. The
 * routing lives in `use-action.ts`; the destinations live in `packages/ui`.
 *
 * ## What it will never produce
 *
 * `undefined`, `[object Object]`, `Failed to fetch`, a stack trace, or a JSON
 * blob. Those are the strings this module exists to intercept — they were
 * reaching users verbatim through `(cause as Error).message`.
 */

import { ApiError, NetworkError } from './api-client';

export type FailureKind =
  | 'VALIDATION'
  | 'AUTH'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMIT'
  | 'SERVER'
  | 'NETWORK'
  | 'UNKNOWN';

export interface FailureDetail {
  path: string;
  issue: string;
}

export interface AppFailure {
  kind: FailureKind;
  /** One sentence, suitable as a toast title or a form-error heading. */
  title: string;
  /** A second line when there is something useful to add. */
  detail: string | null;
  status: number | null;
  code: string | null;
  requestId: string | null;
  /** Field-level detail from the server, for inline mapping and the panel. */
  details: FailureDetail[];
  /**
   * Identity for deduplication.
   *
   * Two failures with the same key are the same failure as far as the user is
   * concerned, so the second refreshes the first notification instead of
   * stacking a duplicate beneath it.
   */
  key: string;
}

/**
 * Status → sentence, per §16 of the error spec.
 *
 * These are fallbacks. A server message that says something specific is better
 * than any of them, and `preferServerMessage` decides which one wins.
 */
const STATUS_TITLES: Record<number, string> = {
  400: 'Request could not be processed',
  401: 'Your session has expired',
  403: "You don't have permission to do that",
  404: 'Not found',
  409: 'This has changed since you loaded it',
  422: 'Some details need fixing',
  429: 'Too many requests',
  500: 'Something went wrong on the server',
  502: 'The service is temporarily unavailable',
  503: 'The service is temporarily unavailable',
  504: 'The service took too long to respond',
};

const STATUS_DETAILS: Record<number, string> = {
  401: 'Sign in again to continue.',
  409: 'Refresh and try again.',
  429: 'Please try again shortly.',
  502: 'Please try again in a moment.',
  503: 'Please try again in a moment.',
  504: 'Please try again in a moment.',
};

function kindForStatus(status: number): FailureKind {
  if (status === 401) return 'AUTH';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400 || status === 422) return 'VALIDATION';
  if (status >= 500) return 'SERVER';
  return 'UNKNOWN';
}

/**
 * Placeholder messages that carry no information.
 *
 * `parseError` produces the first when a response has no JSON body, and the API
 * replaces every 5xx message with the second. Preferring either over the
 * status-based sentence would show the user strictly less.
 */
function isUselessMessage(message: string): boolean {
  const trimmed = message.trim();
  return (
    trimmed === '' ||
    /^Request failed with status \d+$/.test(trimmed) ||
    trimmed === 'Internal server error'
  );
}

/**
 * Whether to show the server's own message.
 *
 * §16 closes with "if the backend provides a useful human-readable message,
 * prefer it" — discarding `IPS validation failed` or
 * `You already have a project using the slug 'shop'` in favour of a generic
 * status sentence would throw away the only specific thing we know.
 *
 * The exception is 5xx. An unhandled server error's message is a stack-adjacent
 * internal string, and the API deliberately replaces it before it leaves the
 * process. Echoing anything from that range risks leaking implementation detail
 * for no user benefit.
 */
function preferServerMessage(status: number, message: string): boolean {
  return status < 500 && !isUselessMessage(message);
}

function keyOf(parts: readonly (string | number | null)[]): string {
  return parts.map((part) => (part === null ? '' : String(part))).join('|');
}

/** How many fields a set of details actually names, counting each path once. */
export function countAffectedPaths(details: readonly FailureDetail[]): number {
  return new Set(details.map((entry) => entry.path)).size;
}

/**
 * A second line summarising field-level detail.
 *
 * `3 fields need attention` is more useful in a toast than the first of three
 * issues, because the user is about to look at the form anyway and the toast's
 * job is only to say that the operation failed and roughly why.
 */
function summariseDetails(details: readonly FailureDetail[]): string | null {
  const count = countAffectedPaths(details);
  if (count === 0) {
    return null;
  }
  return count === 1 ? '1 field needs attention.' : `${count} fields need attention.`;
}

function fromApiError(error: ApiError): AppFailure {
  const kind = kindForStatus(error.status);
  const useServer = preferServerMessage(error.status, error.message);
  const title = useServer
    ? error.message
    : (STATUS_TITLES[error.status] ?? 'Request could not be processed');

  return {
    kind,
    title,
    // Field detail beats a canned sentence: it says how much is wrong. Falls
    // back to the status hint, and finally to nothing rather than padding.
    detail: summariseDetails(error.details ?? []) ?? STATUS_DETAILS[error.status] ?? null,
    status: error.status,
    code: error.code,
    requestId: error.requestId ?? null,
    details: [...(error.details ?? [])],
    // The message is part of the key so two different validation failures on the
    // same endpoint are two notifications, while a retry of the same one is not.
    key: keyOf(['api', error.status, error.code, useServer ? error.message : '']),
  };
}

/**
 * Turn anything thrown into a failure that can be shown.
 *
 * Accepts `unknown` deliberately — `catch` and react-query both hand over
 * `unknown`, and a signature that demanded `Error` would push a cast to every
 * call site, which is where the raw-message bugs came from in the first place.
 */
export function normalizeError(cause: unknown): AppFailure {
  if (cause instanceof ApiError) {
    return fromApiError(cause);
  }

  if (cause instanceof NetworkError) {
    return {
      kind: 'NETWORK',
      title: 'Connection failed',
      detail: "We couldn't reach the API. Check your connection and try again.",
      status: null,
      code: 'NETWORK',
      requestId: null,
      details: [],
      // No status or message in the key: every network failure is the same
      // failure to a user, so a retry loop must not stack five identical toasts.
      key: 'network',
    };
  }

  // Anything else is a bug in our own code — a TypeError, a thrown string, a
  // rejected promise with no reason. The message is kept for the details panel
  // and for the console, and deliberately not shown as the title.
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    kind: 'UNKNOWN',
    title: 'Something went wrong',
    detail: 'The action could not be completed. Please try again.',
    status: null,
    code: 'UNKNOWN',
    requestId: null,
    details: message.trim() === '' ? [] : [{ path: 'error', issue: message }],
    key: keyOf(['unknown', message]),
  };
}

/**
 * Whether this failure is worth interrupting the user for.
 *
 * A 401 is not: the API client already refreshes once and retries, so a 401 that
 * survives that means the session is genuinely gone and the auth flow — not a
 * toast the user reads on the way to the sign-in page — is the response.
 */
export function isSessionExpiry(failure: AppFailure): boolean {
  return failure.kind === 'AUTH';
}

/**
 * Props for a `<FormError>`, from anything thrown.
 *
 * A one-liner, but it exists so the four auth forms cannot each invent their own
 * `{ title, detail }` mapping — which is how they came to disagree about whether
 * a network failure was worth rendering at all.
 */
export function formErrorProps(cause: unknown): { title: string; detail: string | null } {
  const failure = normalizeError(cause);
  return { title: failure.title, detail: failure.detail };
}
