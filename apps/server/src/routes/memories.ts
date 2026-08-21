import type { FastifyInstance } from 'fastify';
import {
  NotFoundError,
  ValidationError,
  type MemoryEngine,
  type MemoryFilter,
  type MemoryInput,
  type MemoryKind,
  type MemoryRecord,
  type MemorySource,
  type RecallOptions,
} from '@mnemos/core';

interface ListQuery {
  namespace?: string;
  agentId?: string;
  kind?: string;
  source?: string;
  tags?: string;
  anyTags?: string;
  minImportance?: string;
  limit?: string;
  offset?: string;
  orderBy?: string;
  direction?: string;
  search?: string;
}

const ORDERABLE = ['createdAt', 'updatedAt', 'lastAccessedAt', 'importance', 'accessCount'];

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseLimit(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > max) {
    throw new ValidationError(`limit must be an integer between 1 and ${max}`);
  }
  return parsed;
}

/**
 * Serialise a record for the wire.
 *
 * Embeddings are stripped by default: they are the bulk of a record's bytes,
 * are useless to a client, and shipping a few hundred floats per row turns a
 * page of results into a megabyte. `?includeEmbeddings=true` opts back in for
 * export and debugging.
 */
function serialize(
  record: MemoryRecord,
  engine: MemoryEngine,
  includeEmbedding: boolean,
): Record<string, unknown> {
  const { embedding, ...rest } = record;
  return {
    ...rest,
    retention: Number(engine.retentionOf(record).toFixed(4)),
    ...(includeEmbedding && embedding ? { embedding } : {}),
    ...(embedding ? { embeddingDimensions: embedding.length } : {}),
  };
}

export function registerMemoryRoutes(app: FastifyInstance, engine: MemoryEngine): void {
  app.post<{ Body: MemoryInput | { memories: MemoryInput[] } }>(
    '/v1/memories',
    async (request, reply) => {
      const body = request.body;
      if (body && typeof body === 'object' && 'memories' in body) {
        if (!Array.isArray(body.memories) || body.memories.length === 0) {
          throw new ValidationError('memories must be a non-empty array');
        }
        if (body.memories.length > 500) {
          throw new ValidationError('at most 500 memories may be written per request');
        }
        const written = await engine.rememberMany(body.memories);
        return reply.status(201).send({
          count: written.length,
          deduplicated: written.filter((result) => result.deduplicated).length,
          memories: written.map((result) => serialize(result.record, engine, false)),
        });
      }

      const result = await engine.remember(body as MemoryInput);
      return reply
        .status(result.deduplicated ? 200 : 201)
        .send({
          memory: serialize(result.record, engine, false),
          deduplicated: result.deduplicated,
        });
    },
  );

  app.get<{ Querystring: ListQuery }>('/v1/memories', async (request) => {
    const query = request.query;
    const filter: MemoryFilter = {};
    if (query.namespace) filter.namespace = query.namespace;
    if (query.agentId) filter.agentId = query.agentId;
    const kinds = splitList(query.kind);
    if (kinds) filter.kinds = kinds as MemoryKind[];
    const sources = splitList(query.source);
    if (sources) filter.sources = sources as MemorySource[];
    const tags = splitList(query.tags);
    if (tags) filter.tags = tags;
    const anyTags = splitList(query.anyTags);
    if (anyTags) filter.anyTags = anyTags;
    if (query.minImportance) filter.minImportance = Number(query.minImportance);

    const limit = parseLimit(query.limit, 50, 500);
    const offset = Math.max(0, Number.parseInt(query.offset ?? '0', 10) || 0);
    const orderBy = ORDERABLE.includes(query.orderBy ?? '')
      ? (query.orderBy as 'createdAt')
      : 'createdAt';

    // A `search` parameter runs the full recall pipeline rather than a
    // substring match, so the browse view and the agent see the same ranking.
    if (query.search) {
      const results = await engine.recall(query.search, {
        filter,
        limit,
        reinforce: false,
      });
      return {
        total: results.length,
        limit,
        offset: 0,
        memories: results.map((result) => ({
          ...serialize(result.record, engine, false),
          score: Number(result.score.toFixed(4)),
          breakdown: result.breakdown,
        })),
      };
    }

    const [records, total] = await Promise.all([
      engine.list(filter, {
        limit,
        offset,
        orderBy,
        direction: query.direction === 'asc' ? 'asc' : 'desc',
      }),
      engine.count(filter),
    ]);

    return {
      total,
      limit,
      offset,
      memories: records.map((record) => serialize(record, engine, false)),
    };
  });

  app.get<{ Params: { id: string }; Querystring: { namespace?: string; includeEmbeddings?: string } }>(
    '/v1/memories/:id',
    async (request) => {
      const record = await engine.get(request.params.id, request.query.namespace);
      if (!record) throw new NotFoundError('Memory', request.params.id);
      return {
        memory: serialize(record, engine, request.query.includeEmbeddings === 'true'),
      };
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { content?: string; importance?: number; tags?: string[]; kind?: MemoryKind };
    Querystring: { namespace?: string };
  }>('/v1/memories/:id', async (request) => {
    const updated = await engine.update(
      request.params.id,
      request.body ?? {},
      request.query.namespace,
    );
    return { memory: serialize(updated, engine, false) };
  });

  app.delete<{ Params: { id: string }; Querystring: { namespace?: string } }>(
    '/v1/memories/:id',
    async (request, reply) => {
      const deleted = await engine.forget(request.params.id, request.query.namespace);
      if (!deleted) throw new NotFoundError('Memory', request.params.id);
      return reply.status(204).send();
    },
  );

  app.post<{ Body: { query: string } & RecallOptions & { namespace?: string } }>(
    '/v1/recall',
    async (request) => {
      const { query, namespace, ...options } = request.body ?? { query: '' };
      if (typeof query !== 'string') {
        throw new ValidationError('query must be a string');
      }
      const started = Date.now();
      const results = await engine.recall(query, {
        ...options,
        ...(namespace ? { namespace } : {}),
      });
      return {
        query,
        took: Date.now() - started,
        count: results.length,
        results: results.map((result) => ({
          memory: serialize(result.record, engine, false),
          score: Number(result.score.toFixed(4)),
          breakdown: result.breakdown,
        })),
      };
    },
  );

  app.post<{
    Body: { query: string; budgetTokens?: number; namespace?: string } & RecallOptions;
  }>('/v1/context', async (request) => {
    const { query, budgetTokens, namespace, ...options } = request.body ?? { query: '' };
    if (typeof query !== 'string') throw new ValidationError('query must be a string');

    const packed = await engine.buildContext(query, {
      ...options,
      ...(namespace ? { namespace } : {}),
      ...(budgetTokens ? { budgetTokens } : {}),
    });

    return {
      text: packed.text,
      estimatedTokens: packed.estimatedTokens,
      budgetTokens: packed.budgetTokens,
      utilization: Number(packed.utilization.toFixed(4)),
      included: packed.included.map((result) => ({
        id: result.record.id,
        kind: result.record.kind,
        score: Number(result.score.toFixed(4)),
      })),
      droppedCount: packed.dropped.length,
    };
  });
}
