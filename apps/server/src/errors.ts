import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isMnemosError } from '@mnemos/core';

/**
 * Single error boundary for the API.
 *
 * The core already raises errors carrying a machine-readable code and an HTTP
 * status, so the handler mostly passes them through. Anything unrecognised is
 * reported as a 500 with a generic message: internal failure details belong in
 * the log, not in a response body a client might surface to a user.
 */
export function registerErrorHandler(app: FastifyInstance, isProduction: boolean): void {
  app.setErrorHandler((raw: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const error = raw as Error & { statusCode?: number; code?: string };
    if (isMnemosError(error)) {
      request.log.info({ code: error.code, path: request.url }, error.message);
      return reply.status(error.status).send(error.toJSON());
    }

    const status = error.statusCode;
    if (typeof status === 'number' && status < 500) {
      return reply.status(status).send({
        error: error.name,
        code: error.code ?? 'BAD_REQUEST',
        message: error.message,
      });
    }

    request.log.error({ err: error, path: request.url }, 'Unhandled request failure');
    return reply.status(500).send({
      error: 'InternalServerError',
      code: 'INTERNAL_ERROR',
      message: isProduction ? 'An unexpected error occurred' : error.message,
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: 'NotFound',
      code: 'ROUTE_NOT_FOUND',
      message: `No route for ${request.method} ${request.url}`,
    }),
  );
}
