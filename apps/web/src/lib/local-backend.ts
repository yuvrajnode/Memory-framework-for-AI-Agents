import { MemoryEngine, InMemoryStore, HashingEmbedder } from '@mnemos/core';
import type {
  Backend,
  ConsolidationResult,
  ContextResult,
  ListParams,
  ListResult,
  MaintenanceResult,
  MemoryGraph,
  MemoryInput,
  MemoryKind,
  MemoryRecord,
  MemoryStats,
  MemoryView,
  RankedMemory,
  RecallOptions,
} from './types.js';

/**
 * Runs the real framework in the browser tab.
 *
 * Not a mock and not a fixture: this is the same MemoryEngine the server
 * runs, over an InMemoryStore with the offline embedder. Because the core is
 * isomorphic, a static deploy of this dashboard is a fully working demo — the
 * ranking, decay and consolidation a visitor sees are the actual
 * implementation, not a simulation of it.
 */
export class LocalBackend implements Backend {
  readonly kind = 'local' as const;
  readonly label = 'In-browser engine';

  private readonly engine: MemoryEngine;

  constructor() {
    this.engine = new MemoryEngine({
      store: new InMemoryStore(),
      embedder: new HashingEmbedder({ dimensions: 384 }),
    });
  }

  private view = (record: MemoryRecord): MemoryView => {
    const { embedding, ...rest } = record;
    return {
      ...rest,
      retention: Number(this.engine.retentionOf(record).toFixed(4)),
      ...(embedding ? { embeddingDimensions: embedding.length } : {}),
    };
  };

  async remember(input: MemoryInput): Promise<MemoryView> {
    const { record } = await this.engine.remember(input);
    return this.view(record);
  }

  async rememberMany(inputs: MemoryInput[]): Promise<number> {
    return (await this.engine.rememberMany(inputs)).length;
  }

  async list(params: ListParams): Promise<ListResult> {
    if (params.search) {
      const results = await this.engine.recall(params.search, {
        ...(params.namespace ? { namespace: params.namespace } : {}),
        filter: this.filterFrom(params),
        limit: params.limit ?? 50,
        reinforce: false,
      });
      return { total: results.length, memories: results.map((r) => this.view(r.record)) };
    }

    const filter = { ...this.filterFrom(params) };
    const [records, total] = await Promise.all([
      this.engine.list(filter, {
        limit: params.limit ?? 50,
        offset: params.offset ?? 0,
        orderBy: params.orderBy ?? 'createdAt',
        direction: params.direction ?? 'desc',
      }),
      this.engine.count(filter),
    ]);
    return { total, memories: records.map(this.view) };
  }

  private filterFrom(params: ListParams) {
    return {
      ...(params.namespace ? { namespace: params.namespace } : {}),
      ...(params.kinds?.length ? { kinds: params.kinds } : {}),
      ...(params.tags?.length ? { tags: params.tags } : {}),
    };
  }

  async recall(
    query: string,
    options: RecallOptions & { namespace?: string },
  ): Promise<RankedMemory[]> {
    const results = await this.engine.recall(query, options);
    return results.map((result) => ({
      memory: this.view(result.record),
      score: result.score,
      breakdown: result.breakdown,
    }));
  }

  async buildContext(
    query: string,
    options: { budgetTokens: number; namespace?: string; limit?: number; diversity?: number },
  ): Promise<ContextResult> {
    const packed = await this.engine.buildContext(query, options);
    return {
      text: packed.text,
      estimatedTokens: packed.estimatedTokens,
      budgetTokens: packed.budgetTokens,
      utilization: packed.utilization,
      included: packed.included.map((result) => ({
        id: result.record.id,
        kind: result.record.kind,
        score: result.score,
      })),
      droppedCount: packed.dropped.length,
    };
  }

  async update(
    id: string,
    changes: { content?: string; importance?: number; tags?: string[]; kind?: MemoryKind },
    namespace?: string,
  ): Promise<MemoryView> {
    return this.view(await this.engine.update(id, changes, namespace));
  }

  async forget(id: string, namespace?: string): Promise<void> {
    await this.engine.forget(id, namespace);
  }

  async stats(namespace?: string): Promise<MemoryStats> {
    return this.engine.stats(namespace);
  }

  async namespaces(): Promise<{ namespace: string; count: number }[]> {
    const names = await this.engine.namespaces();
    return Promise.all(
      names.map(async (namespace) => ({
        namespace,
        count: await this.engine.count({ namespace }),
      })),
    );
  }

  async graph(namespace?: string, limit?: number): Promise<MemoryGraph> {
    return this.engine.graphSnapshot(namespace, limit);
  }

  async consolidate(namespace?: string): Promise<ConsolidationResult> {
    const summary = await this.engine.consolidate(namespace);
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
  }

  async maintain(
    namespace: string | undefined,
    options: { dryRun?: boolean; maxRecords?: number },
  ): Promise<MaintenanceResult> {
    return this.engine.maintain(namespace, options);
  }

  async clear(namespace?: string): Promise<number> {
    return this.engine.clear(namespace);
  }
}
