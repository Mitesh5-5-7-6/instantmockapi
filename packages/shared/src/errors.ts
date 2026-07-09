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
  | 'FORBIDDEN'
  | 'CONFLICT'
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

/** Default HTTP status code mapping for error codes. */
function errorCodeToStatus(code: ErrorCode): number {
  const map: Record<ErrorCode, number> = {
    VALIDATION_ERROR: 422,
    PARSE_ERROR: 422,
    NOT_FOUND: 404,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    CONFLICT: 409,
    RATE_LIMIT_EXCEEDED: 429,
    PLAN_LIMIT_EXCEEDED: 403,
    DEPTH_LIMIT_EXCEEDED: 422,
    GENERATION_ERROR: 500,
    INTERNAL_ERROR: 500,
  };
  return map[code];
}
