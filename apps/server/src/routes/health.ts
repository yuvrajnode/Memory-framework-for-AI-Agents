import type { FastifyInstance } from 'fastify';
import type { MemoryEngine } from '@mnemos/core';
import type { ServerConfig } from '../config.js';

const startedAt = Date.now();

/**
 * Liveness and readiness, split on purpose.
 *
 * `/health` answers "is the process up" and must never touch the store, so an
 * orchestrator does not restart a healthy container because a disk was slow.
 * `/ready` actually exercises the store, which is what a load balancer needs
 * before sending traffic.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  engine: MemoryEngine,
  config: ServerConfig,
): void {
  app.get('/health', async () => ({
    status: 'ok',
    uptimeMs: Date.now() - startedAt,
    version: process.env['npm_package_version'] ?? '0.1.0',
  }));

  app.get('/ready', async (_request, reply) => {
    try {
      await engine.namespaces();
      return {
        status: 'ready',
        store: config.store,
        embedder: engine.embedder.id,
        dimensions: engine.embedder.dimensions,
      };
    } catch (error) {
      return reply.status(503).send({
        status: 'unavailable',
        code: 'STORE_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'Store is not reachable',
      });
    }
  });

  app.get('/', async () => ({
    name: 'mnemos',
    description: 'Memory framework for AI agents',
    docs: '/openapi.json',
    endpoints: [
      'POST /v1/memories',
      'GET /v1/memories',
      'POST /v1/recall',
      'POST /v1/context',
      'GET /v1/stats',
      'GET /v1/graph',
      'POST /v1/consolidate',
      'POST /v1/maintenance',
    ],
  }));
}
