/**
 * Uniform error envelope for the platform API (doc 08 §7).
 *
 * Every failure — thrown AppError, Fastify schema-validation error, rate-limit
 * rejection, unknown route, or unexpected crash — is serialized to
 * `{ error: { code, message, details? } }` with the documented status code.
 */

import type { FastifyError, FastifyInstance } from 'fastify';
import { AppError, getErrorMessage, logger, type ErrorCode } from '@instantmockapi/shared';

function statusToCode(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMIT_EXCEEDED';
    default:
      return status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
  }
}

/**
 * Stamp the request's correlation id onto an envelope.
 *
 * Done here rather than in `AppError.toJSON()` because an `AppError` is a pure
 * value with no request context — it is thrown from services, workers and pure
 * packages that have no `request` to ask. Threading one through every
 * constructor to reach this line would be a worse trade than merging once at the
 * boundary that already has it.
 */
function withRequestId(
  envelope: { error: { code: string; message: string; details?: unknown } },
  requestId: string,
): unknown {
  return { error: { ...envelope.error, requestId } };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send(withRequestId(error.toJSON(), request.id));
      return;
    }

    // Fastify (ajv) schema-validation failures → 400 with field-level details
    if (error.validation) {
      const context = error.validationContext ?? 'body';
      const details = error.validation.map((issue) => ({
        path: `${context}${issue.instancePath.replaceAll('/', '.')}`,
        issue: issue.message ?? 'is invalid',
      }));
      void reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details,
          requestId: request.id,
        },
      });
      return;
    }

    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      // The id is logged alongside, which is the whole point: the user quotes
      // what the envelope gave them and this line is findable.
      logger.error('Unhandled API error', {
        error: getErrorMessage(error),
        method: request.method,
        url: request.url,
        requestId: request.id,
      });
    }
    void reply.status(status).send({
      error: {
        code: statusToCode(status),
        // 5xx messages are replaced, not echoed. An unhandled error's message is
        // a stack-adjacent internal string — a driver failure, a Redis timeout —
        // and a caller has no use for it beyond learning about our internals.
        message: status >= 500 ? 'Internal server error' : getErrorMessage(error),
        requestId: request.id,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        requestId: request.id,
      },
    });
  });
}
