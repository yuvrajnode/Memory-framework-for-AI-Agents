import type { FastifyInstance } from 'fastify';
import type {
  ConsolidationOptions,
  MaintenanceOptions,
  MemoryEngine,
} from '@mnemos/core';

/** Namespace-level operations: stats, graph, maintenance and bulk clears. */
export function registerAdminRoutes(app: FastifyInstance, engine: MemoryEngine): void {
  app.get('/v1/namespaces', async () => {
    const namespaces = await engine.namespaces();
    const withCounts = await Promise.all(
      namespaces.map(async (namespace) => ({
        namespace,
        count: await engine.count({ namespace }),
      })),
    );
    return { namespaces: withCounts };
  });

  app.get<{ Querystring: { namespace?: string } }>('/v1/stats', async (request) => {
    return { stats: await engine.stats(request.query.namespace) };
  });

  app.get<{ Querystring: { namespace?: string; limit?: string } }>(
    '/v1/graph',
    async (request) => {
      const limit = Math.min(
        Math.max(Number.parseInt(request.query.limit ?? '120', 10) || 120, 1),
        500,
      );
      return engine.graphSnapshot(request.query.namespace, limit);
    },
  );

  app.post<{ Body: ConsolidationOptions & { namespace?: string } }>(
    '/v1/consolidate',
    async (request) => {
      const { namespace, ...options } = request.body ?? {};
      const summary = await engine.consolidate(namespace, options);
      return {
        examined: summary.examined,
        clusters: summary.clusters,
        created: summary.created.map((record) => ({
          id: record.id,
          content: record.content,
          derivedFrom: record.derivedFrom ?? [],
        })),
        superseded: summary.supersededIds.length,
        deleted: summary.deletedIds.length,
      };
    },
  );

  app.post<{ Body: MaintenanceOptions & { namespace?: string } }>(
    '/v1/maintenance',
    async (request) => {
      const { namespace, ...options } = request.body ?? {};
      return { report: await engine.maintain(namespace, options) };
    },
  );

  app.delete<{ Querystring: { namespace?: string; confirm?: string } }>(
    '/v1/memories',
    async (request, reply) => {
      // Wiping a namespace is unrecoverable, so it takes an explicit
      // acknowledgement rather than a bare DELETE.
      if (request.query.confirm !== 'true') {
        return reply.status(400).send({
          error: 'BadRequest',
          code: 'CONFIRMATION_REQUIRED',
          message: 'Pass ?confirm=true to clear a namespace',
        });
      }
      const removed = await engine.clear(request.query.namespace);
      return { removed };
    },
  );
}
