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

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send(error.toJSON());
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
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details },
      });
      return;
    }

    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      logger.error('Unhandled API error', {
        error: getErrorMessage(error),
        method: request.method,
        url: request.url,
      });
    }
    void reply.status(status).send({
      error: {
        code: statusToCode(status),
        message: status >= 500 ? 'Internal server error' : getErrorMessage(error),
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    });
  });
}
