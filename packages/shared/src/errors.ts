/**
 * Structured application error with machine-readable code, human message,
 * and optional field-level details. Used across all packages/apps for
 * consistent error handling (doc 08 §7, doc 17 §5).
 */

/** Field-level error detail for validation and parse errors. */
export interface ErrorDetail {
  /** JSON-path to the offending field (e.g., "addresses[0].location.city") */
  readonly path: string;
  /** Human-readable description of the issue */
  readonly issue: string;
}

/**
 * Machine-readable error codes used throughout the platform.
 * Kept as a const union so exhaustiveness checking works.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'PARSE_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  /**
   * The credentials were right but the address has not been confirmed.
   *
   * Distinct from UNAUTHORIZED on purpose: the sign-in screen has something
   * useful to offer here — a resend button — and cannot tell the two apart from
   * a status code alone.
   */
  | 'EMAIL_NOT_VERIFIED'
  /**
   * The request succeeded but an email we owed the user could not be sent.
   *
   * Its own code so a screen can offer to try again — the alternative is
   * matching on the message text, which breaks the first time it is reworded.
   */
  | 'EMAIL_SEND_FAILED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  /**
   * The draft was forked from a version the project has since moved past.
   *
   * Its own code rather than a bare CONFLICT because the client can do something
   * specific with it: the response carries `baseVersion` and `currentVersion`,
   * so a screen can say which version the edits were based on and offer to
   * re-fork. Silently merging instead would apply an edit reasoned about against
   * a definition that no longer exists.
   */
  | 'STALE_DRAFT'
  | 'RATE_LIMIT_EXCEEDED'
  | 'PLAN_LIMIT_EXCEEDED'
  | 'DEPTH_LIMIT_EXCEEDED'
  | 'GENERATION_ERROR'
  | 'INTERNAL_ERROR';

/**
 * Structured application error.
 *
 * All cross-boundary errors use this shape instead of raw strings (doc 17 §5).
 * Maps cleanly to the HTTP error envelope (doc 08 §7).
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details: ReadonlyArray<ErrorDetail>;

  constructor(params: {
    code: ErrorCode;
    message: string;
    statusCode?: number;
    details?: ErrorDetail[];
  }) {
    super(params.message);
    this.name = 'AppError';
    this.code = params.code;
    this.statusCode = params.statusCode ?? errorCodeToStatus(params.code);
    this.details = params.details ?? [];
  }

  /** Serialize to the uniform error response envelope (doc 08 §7). */
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details.length > 0 ? { details: this.details } : {}),
      },
    };
  }
}

/** Extract a human-readable message from an unknown thrown value. */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Default HTTP status code mapping for error codes. */
function errorCodeToStatus(code: ErrorCode): number {
  const map: Record<ErrorCode, number> = {
    VALIDATION_ERROR: 422,
    PARSE_ERROR: 422,
    NOT_FOUND: 404,
    UNAUTHORIZED: 401,
    // 403, not 401: the password was correct, so re-prompting for credentials
    // (which is what a 401 asks a client to do) would send the user in a loop.
    EMAIL_NOT_VERIFIED: 403,
    // 502, not 500: nothing here is broken — an upstream service we depend on
    // refused. Worth distinguishing in logs and dashboards, because the fix is
    // a configuration change rather than a code one.
    EMAIL_SEND_FAILED: 502,
    FORBIDDEN: 403,
    CONFLICT: 409,
    // 409, like CONFLICT: the request was well-formed and authorised, and the
    // only problem is that the world moved underneath it.
    STALE_DRAFT: 409,
    RATE_LIMIT_EXCEEDED: 429,
    PLAN_LIMIT_EXCEEDED: 403,
    DEPTH_LIMIT_EXCEEDED: 422,
    GENERATION_ERROR: 500,
    INTERNAL_ERROR: 500,
  };
  return map[code];
}
