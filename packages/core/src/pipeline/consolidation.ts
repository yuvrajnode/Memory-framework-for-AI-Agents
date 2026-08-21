import type { EmbeddingProvider } from '../embeddings/types.js';
import { createRecord } from '../record.js';
import type { MemoryStore } from '../store/types.js';
import type { MemoryFilter, MemoryKind, MemoryRecord } from '../types.js';
import { DAY, clamp } from '../util/time.js';
import { clusterRecords } from './clustering.js';
import type { Summarizer } from './summarizer.js';

export interface ConsolidationOptions {
  /** Only records at least this old are eligible, so live context is left alone. */
  minAgeMs?: number;
  /** Similarity at which two memories are considered the same topic. */
  similarityThreshold?: number;
  /** Minimum cluster size worth distilling. */
  minClusterSize?: number;
  /** Maximum records examined per run, bounding the O(n²) clustering step. */
  batchSize?: number;
  /** Kinds eligible for consolidation. */
  kinds?: MemoryKind[];
  /** Kind assigned to the distilled record. */
  targetKind?: MemoryKind;
  /**
   * Keep the originals, marked as superseded, instead of deleting them.
   * Defaults to true: an audit trail from a fact back to the episodes that
   * produced it is usually worth the storage.
   */
  keepSources?: boolean;
  /** Cap on the summary length, in characters. */
  maxSummaryChars?: number;
}

export interface ConsolidationSummary {
  examined: number;
  clusters: number;
  created: MemoryRecord[];
  supersededIds: string[];
  deletedIds: string[];
}

const DEFAULTS = {
  minAgeMs: DAY,
  similarityThreshold: 0.82,
  minClusterSize: 3,
  batchSize: 300,
  kinds: ['episodic'] as MemoryKind[],
  targetKind: 'semantic' as MemoryKind,
  keepSources: true,
  maxSummaryChars: 600,
};

export interface ConsolidatorDeps {
  store: MemoryStore;
  embedder: EmbeddingProvider;
  summarizer: Summarizer;
}

/**
 * Promotes clusters of related episodes into single semantic facts.
 *
 * This is the mechanism that keeps a long-lived agent from drowning in its
 * own transcript: fifty turns about a user's deployment preferences collapse
 * into one durable statement, which then decays on the far slower semantic
 * half-life. The originals are marked superseded rather than deleted, so the
 * provenance chain from fact back to evidence survives.
 */
export class Consolidator {
  private readonly store: MemoryStore;
  private readonly embedder: EmbeddingProvider;
  private readonly summarizer: Summarizer;

  constructor(deps: ConsolidatorDeps) {
    this.store = deps.store;
    this.embedder = deps.embedder;
    this.summarizer = deps.summarizer;
  }

  async run(
    namespace: string,
    options: ConsolidationOptions = {},
  ): Promise<ConsolidationSummary> {
    const settings = { ...DEFAULTS, ...options };
    const now = Date.now();

    const filter: MemoryFilter = {
      namespace,
      kinds: settings.kinds,
      createdBefore: now - settings.minAgeMs,
    };
    const candidates = await this.store.query(filter, {
      limit: settings.batchSize,
      orderBy: 'createdAt',
      direction: 'asc',
    });

    const summary: ConsolidationSummary = {
      examined: candidates.length,
      clusters: 0,
      created: [],
      supersededIds: [],
      deletedIds: [],
    };
    if (candidates.length < settings.minClusterSize) return summary;

    const clusters = clusterRecords(candidates, {
      threshold: settings.similarityThreshold,
      minSize: settings.minClusterSize,
    });
    summary.clusters = clusters.length;

    for (const cluster of clusters) {
      const created = await this.consolidateCluster(namespace, cluster, settings, summary);
      if (created) summary.created.push(created);
    }
    return summary;
  }

  private async consolidateCluster(
    namespace: string,
    cluster: MemoryRecord[],
    settings: typeof DEFAULTS,
    summary: ConsolidationSummary,
  ): Promise<MemoryRecord | null> {
    // Most important first, so a truncated summary keeps the salient parts.
    const ordered = [...cluster].sort((a, b) => b.importance - a.importance);
    const content = await this.summarizer.summarize({
      passages: ordered.map((record) => record.content),
      maxChars: settings.maxSummaryChars,
    });
    if (!content.trim()) return null;

    const [embedding] = await this.embedder.embed([content]);

    // A distilled fact inherits the strongest salience in its cluster, with a
    // small bonus for corroboration: several episodes agreeing is evidence.
    const importance = clamp(
      Math.max(...ordered.map((record) => record.importance)) +
        Math.min(0.15, 0.03 * (ordered.length - 1)),
      0,
      1,
    );

    const tags = [...new Set(ordered.flatMap((record) => record.tags))].sort();
    const agentId = ordered.find((record) => record.agentId)?.agentId;

    const record = createRecord(
      {
        content,
        kind: settings.targetKind,
        source: 'system',
        importance,
        tags,
        ...(agentId ? { agentId } : {}),
        metadata: {
          consolidated: true,
          sourceCount: ordered.length,
          summarizer: this.summarizer.id,
        },
      },
      { namespace, ...(embedding ? { embedding } : {}) },
    );
    record.derivedFrom = ordered.map((source) => source.id);

    await this.store.put(record);

    for (const source of ordered) {
      if (settings.keepSources) {
        await this.store.update(namespace, source.id, {
          supersededBy: record.id,
          updatedAt: Date.now(),
        });
        summary.supersededIds.push(source.id);
      } else {
        await this.store.delete(namespace, source.id);
        summary.deletedIds.push(source.id);
      }
      await this.store.addLink({
        id: `lnk_${record.id}_${source.id}`,
        namespace,
        fromId: record.id,
        toId: source.id,
        relation: 'derived-from',
        weight: 1,
        createdAt: Date.now(),
      });
    }

    return record;
  }
}
