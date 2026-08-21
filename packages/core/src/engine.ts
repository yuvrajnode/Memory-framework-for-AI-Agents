import { packContext, type PackOptions, type PackedContext } from './context/packer.js';
import { HashingEmbedder } from './embeddings/hashing.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import { EventBus } from './events.js';
import { NotFoundError, ValidationError } from './errors.js';
import { GraphBuilder, type LinkOptions, type MemoryGraph } from './graph/graph.js';
import {
  Consolidator,
  type ConsolidationOptions,
  type ConsolidationSummary,
} from './pipeline/consolidation.js';
import { DecayModel, type DecayOptions } from './pipeline/decay.js';
import {
  MaintenanceRunner,
  type MaintenanceOptions,
  type MaintenanceReport,
} from './pipeline/maintenance.js';
import { ExtractiveSummarizer, type Summarizer } from './pipeline/summarizer.js';
import { createRecord } from './record.js';
import { Retriever } from './retrieval/retriever.js';
import { InMemoryStore } from './store/in-memory.js';
import type { MemoryStore, QueryOptions } from './store/types.js';
import type {
  MemoryFilter,
  MemoryInput,
  MemoryKind,
  MemoryRecord,
  MemorySource,
  MemoryStats,
  RecallOptions,
  RecallResult,
} from './types.js';
import { MEMORY_KINDS, MEMORY_SOURCES } from './types.js';
import { estimateTokens, fingerprint, jaccard } from './util/text.js';
import { clamp } from './util/time.js';
import { validateFilter, validateNamespace, validateRecallOptions } from './validation.js';

export interface MemoryEngineOptions {
  store?: MemoryStore;
  embedder?: EmbeddingProvider;
  summarizer?: Summarizer;
  /** Namespace used when a call does not specify one. */
  defaultNamespace?: string;
  decay?: DecayOptions;
  /**
   * Suppress writes that restate an existing memory. Exact matches are caught
   * by fingerprint; near matches by token overlap above `dedupeThreshold`.
   */
  deduplicate?: boolean;
  dedupeThreshold?: number;
  /** Build graph edges automatically on write. */
  autoLink?: boolean;
  linkOptions?: LinkOptions;
}

export interface WriteResult {
  record: MemoryRecord;
  /** True when the write merged into an existing memory instead of creating one. */
  deduplicated: boolean;
}

export interface ContextOptions extends RecallOptions {
  namespace?: string;
  pack?: Partial<PackOptions>;
}

const DEFAULT_NAMESPACE = 'default';
const DEFAULT_DEDUPE_THRESHOLD = 0.92;

/**
 * The framework's public surface.
 *
 * Wires the store, embedder, decay model, retriever, consolidator, graph and
 * maintenance runner into one object with a small API: `remember`, `recall`,
 * `buildContext`, plus maintenance. Every collaborator is injectable, and the
 * defaults are chosen so `new MemoryEngine()` is immediately usable with no
 * configuration, no API key and no network.
 */
export class MemoryEngine {
  readonly store: MemoryStore;
  readonly embedder: EmbeddingProvider;
  readonly decay: DecayModel;
  readonly events = new EventBus();
  readonly graph: GraphBuilder;

  private readonly retriever: Retriever;
  private readonly consolidator: Consolidator;
  private readonly maintenance: MaintenanceRunner;
  private readonly defaultNamespace: string;
  private readonly deduplicate: boolean;
  private readonly dedupeThreshold: number;
  private readonly autoLink: boolean;
  private readonly linkOptions: LinkOptions;
  private ready: Promise<void> | null = null;

  constructor(options: MemoryEngineOptions = {}) {
    this.store = options.store ?? new InMemoryStore();
    this.embedder = options.embedder ?? new HashingEmbedder();
    this.decay = new DecayModel(options.decay);
    this.defaultNamespace = options.defaultNamespace ?? DEFAULT_NAMESPACE;
    this.deduplicate = options.deduplicate ?? true;
    this.dedupeThreshold = options.dedupeThreshold ?? DEFAULT_DEDUPE_THRESHOLD;
    this.autoLink = options.autoLink ?? true;
    this.linkOptions = options.linkOptions ?? {};

    this.retriever = new Retriever({
      store: this.store,
      embedder: this.embedder,
      decay: this.decay,
    });
    this.consolidator = new Consolidator({
      store: this.store,
      embedder: this.embedder,
      summarizer: options.summarizer ?? new ExtractiveSummarizer(),
    });
    this.maintenance = new MaintenanceRunner({ store: this.store, decay: this.decay });
    this.graph = new GraphBuilder({ store: this.store });
  }

  /** Open the backing store. Idempotent, and awaited implicitly by every call. */
  async init(): Promise<void> {
    this.ready ??= this.store.init();
    return this.ready;
  }

  private resolveNamespace(namespace?: string): string {
    return validateNamespace(namespace ?? this.defaultNamespace);
  }

  // ---------------------------------------------------------------- writes

  /** Write a memory, deduplicating against what is already stored. */
  async remember(input: MemoryInput): Promise<WriteResult> {
    await this.init();
    const namespace = this.resolveNamespace(input.namespace);

    if (this.deduplicate) {
      const existing = await this.findDuplicate(namespace, input);
      if (existing) {
        const merged = await this.reinforce(existing, input);
        this.events.emit('memory:written', { record: merged, deduplicated: true });
        return { record: merged, deduplicated: true };
      }
    }

    const [embedding] = await this.embedder.embed([input.content]);
    const record = createRecord(input, {
      namespace,
      ...(embedding ? { embedding } : {}),
    });
    await this.store.put(record);

    if (this.autoLink) {
      // Linking is best-effort: a graph failure must never fail a write.
      try {
        await this.graph.linkRecord(record, this.linkOptions);
      } catch (error) {
        this.events.emit('error', { scope: 'autoLink', error });
      }
    }

    this.events.emit('memory:written', { record, deduplicated: false });
    return { record, deduplicated: false };
  }

  /** Write several memories, sharing one embedding round trip. */
  async rememberMany(inputs: MemoryInput[]): Promise<WriteResult[]> {
    await this.init();
    const results: WriteResult[] = [];
    for (const input of inputs) results.push(await this.remember(input));
    return results;
  }

  private async findDuplicate(
    namespace: string,
    input: MemoryInput,
  ): Promise<MemoryRecord | null> {
    const exact = await this.store.findByFingerprint(namespace, fingerprint(input.content));
    if (exact) return exact;

    // Near-duplicate detection is deliberately lexical and scoped to recent
    // records: it is a cheap guard against a chatty agent restating itself,
    // not a semantic merge, which is consolidation's job.
    const recent = await this.store.query(
      { namespace, ...(input.kind ? { kinds: [input.kind] } : {}) },
      { limit: 60, orderBy: 'createdAt', direction: 'desc' },
    );
    for (const candidate of recent) {
      if (jaccard(candidate.content, input.content) >= this.dedupeThreshold) return candidate;
    }
    return null;
  }

  /** Merge a repeat write into an existing record, strengthening it. */
  private async reinforce(record: MemoryRecord, input: MemoryInput): Promise<MemoryRecord> {
    const now = Date.now();
    const tags = [...new Set([...record.tags, ...(input.tags ?? [])])].sort();
    const updated = await this.store.update(record.namespace, record.id, {
      // Repetition is evidence of salience, so importance ratchets up slowly.
      importance: clamp(Math.max(record.importance, input.importance ?? 0) + 0.05, 0, 1),
      accessCount: record.accessCount + 1,
      lastAccessedAt: now,
      updatedAt: now,
      tags,
      metadata: { ...record.metadata, ...(input.metadata ?? {}) },
    });
    return updated ?? record;
  }

  // ---------------------------------------------------------------- reads

  async recall(query: string, options: ContextOptions = {}): Promise<RecallResult[]> {
    await this.init();
    const namespace = this.resolveNamespace(options.namespace ?? options.filter?.namespace);
    const validated = validateRecallOptions(options);
    const started = Date.now();

    const results = await this.retriever.recall(query, {
      ...validated,
      filter: { ...validated.filter, namespace },
    });

    if (options.reinforce !== false) {
      await this.markAccessed(namespace, results.map((result) => result.record));
    }

    this.events.emit('memory:recalled', {
      namespace,
      query,
      results,
      durationMs: Date.now() - started,
    });
    return results;
  }

  /**
   * Recall and pack in one call — the entry point an agent runtime uses on
   * every turn. Returns the prompt block plus exactly what went into it.
   */
  async buildContext(
    query: string,
    options: ContextOptions & { budgetTokens?: number } = {},
  ): Promise<PackedContext> {
    const budgetTokens = options.pack?.budgetTokens ?? options.budgetTokens ?? 800;
    // Over-fetch, because packing is budget-bound rather than count-bound and
    // short memories let more of them fit.
    const results = await this.recall(query, {
      ...options,
      limit: options.limit ?? 20,
    });
    return packContext(results, {
      includeTimestamps: true,
      ...options.pack,
      budgetTokens,
    });
  }

  async get(id: string, namespace?: string): Promise<MemoryRecord | null> {
    await this.init();
    return this.store.get(this.resolveNamespace(namespace), id);
  }

  async list(
    filter: MemoryFilter = {},
    options: QueryOptions = {},
  ): Promise<MemoryRecord[]> {
    await this.init();
    const namespace = this.resolveNamespace(filter.namespace);
    return this.store.query({ ...validateFilter(filter), namespace }, options);
  }

  async count(filter: MemoryFilter = {}): Promise<number> {
    await this.init();
    const namespace = this.resolveNamespace(filter.namespace);
    return this.store.count({ ...validateFilter(filter), namespace });
  }

  /** Attach the live retention score to a record, for UI and debugging. */
  retentionOf(record: MemoryRecord, now = Date.now()): number {
    return this.decay.retention(record, now);
  }

  // -------------------------------------------------------------- mutation

  async update(
    id: string,
    changes: Partial<Pick<MemoryInput, 'content' | 'importance' | 'tags' | 'metadata' | 'kind'>>,
    namespace?: string,
  ): Promise<MemoryRecord> {
    await this.init();
    const resolved = this.resolveNamespace(namespace);
    const existing = await this.store.get(resolved, id);
    if (!existing) throw new NotFoundError('Memory', id);

    const patch: Parameters<MemoryStore['update']>[2] = { updatedAt: Date.now() };

    if (changes.content !== undefined) {
      const content = changes.content.trim();
      if (!content) throw new ValidationError('content must not be empty');
      patch.content = content;
      patch.fingerprint = fingerprint(content);
      const [embedding] = await this.embedder.embed([content]);
      if (embedding) patch.embedding = embedding;
    }
    if (changes.importance !== undefined) patch.importance = clamp(changes.importance, 0, 1);
    if (changes.tags !== undefined) patch.tags = [...new Set(changes.tags)].sort();
    if (changes.metadata !== undefined) patch.metadata = changes.metadata;
    if (changes.kind !== undefined) patch.kind = changes.kind;

    const updated = await this.store.update(resolved, id, patch);
    if (!updated) throw new NotFoundError('Memory', id);
    this.events.emit('memory:updated', { record: updated });
    return updated;
  }

  async forget(id: string, namespace?: string): Promise<boolean> {
    await this.init();
    const resolved = this.resolveNamespace(namespace);
    const deleted = await this.store.delete(resolved, id);
    if (deleted) this.events.emit('memory:deleted', { namespace: resolved, id });
    return deleted;
  }

  /** Record that memories were used, which resets their decay clock. */
  private async markAccessed(namespace: string, records: MemoryRecord[]): Promise<void> {
    const now = Date.now();
    for (const record of records) {
      await this.store.update(namespace, record.id, {
        lastAccessedAt: now,
        accessCount: record.accessCount + 1,
      });
    }
  }

  // ------------------------------------------------------------ maintenance

  async consolidate(
    namespace?: string,
    options: ConsolidationOptions = {},
  ): Promise<ConsolidationSummary> {
    await this.init();
    const resolved = this.resolveNamespace(namespace);
    const summary = await this.consolidator.run(resolved, options);
    this.events.emit('memory:consolidated', {
      namespace: resolved,
      created: summary.created.length,
      superseded: summary.supersededIds.length,
    });
    return summary;
  }

  async maintain(
    namespace?: string,
    options: MaintenanceOptions = {},
  ): Promise<MaintenanceReport> {
    await this.init();
    const resolved = this.resolveNamespace(namespace);
    const report = await this.maintenance.run(resolved, options);
    const evicted = [
      ...report.expired,
      ...report.evictedStale,
      ...report.evictedCapacity,
      ...report.prunedSuperseded,
    ];
    if (evicted.length > 0 && !report.dryRun) {
      this.events.emit('memory:evicted', {
        namespace: resolved,
        ids: evicted,
        reason: 'maintenance',
      });
    }
    return report;
  }

  async graphSnapshot(namespace?: string, limit?: number): Promise<MemoryGraph> {
    await this.init();
    return this.graph.snapshot(this.resolveNamespace(namespace), limit);
  }

  // ---------------------------------------------------------------- meta

  async stats(namespace?: string): Promise<MemoryStats> {
    await this.init();
    const resolved = this.resolveNamespace(namespace);
    const records = await this.store.query({ namespace: resolved });
    const links = await this.store.listLinks(resolved);
    const now = Date.now();

    const byKind = Object.fromEntries(
      MEMORY_KINDS.map((kind) => [kind, 0]),
    ) as Record<MemoryKind, number>;
    const bySource = Object.fromEntries(
      MEMORY_SOURCES.map((source) => [source, 0]),
    ) as Record<MemorySource, number>;

    let importanceTotal = 0;
    let retentionTotal = 0;
    let accesses = 0;
    let tokens = 0;
    let oldest: number | null = null;
    let newest: number | null = null;

    for (const record of records) {
      byKind[record.kind] += 1;
      bySource[record.source] += 1;
      importanceTotal += record.importance;
      retentionTotal += this.decay.retention(record, now);
      accesses += record.accessCount;
      tokens += estimateTokens(record.content);
      if (oldest === null || record.createdAt < oldest) oldest = record.createdAt;
      if (newest === null || record.createdAt > newest) newest = record.createdAt;
    }

    const total = records.length;
    return {
      total,
      byKind,
      bySource,
      averageImportance: total > 0 ? importanceTotal / total : 0,
      averageRetention: total > 0 ? retentionTotal / total : 0,
      oldestCreatedAt: oldest,
      newestCreatedAt: newest,
      totalAccesses: accesses,
      links: links.length,
      approximateTokens: tokens,
    };
  }

  async namespaces(): Promise<string[]> {
    await this.init();
    return this.store.listNamespaces();
  }

  async clear(namespace?: string): Promise<number> {
    await this.init();
    return this.store.clear(this.resolveNamespace(namespace));
  }

  async close(): Promise<void> {
    await this.store.close();
    this.events.removeAll();
  }
}
