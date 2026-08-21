import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/** Paths reachable without a key, so probes and the docs page always work. */
const PUBLIC_PATHS = new Set(['/health', '/ready', '/openapi.json', '/']);

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, so compare lengths separately
  // and still run the comparison to keep the timing profile flat.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Optional shared-secret auth.
 *
 * A single key is the right level of ceremony for a self-hosted memory
 * service: it stops the store being world-writable when the port is exposed,
 * without pretending to be a full identity system. Accepts either
 * `x-api-key` or an `Authorization: Bearer` header, and compares in constant
 * time so the key cannot be recovered by timing.
 */
export function registerAuth(app: FastifyInstance, apiKey: string | undefined): void {
  if (!apiKey) return;

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS' || PUBLIC_PATHS.has(request.url.split('?')[0] ?? '')) {
      return;
    }
    const header = request.headers['x-api-key'];
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    const presented = typeof header === 'string' ? header : bearer;

    if (!presented || !safeEqual(presented, apiKey)) {
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        message: 'A valid API key is required',
      });
    }
  });
}
