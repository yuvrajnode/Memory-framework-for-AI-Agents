import type { EmbeddingProvider } from '../embeddings/types.js';
import { embedOne } from '../embeddings/types.js';
import type { DecayModel } from '../pipeline/decay.js';
import type { MemoryStore } from '../store/types.js';
import type { MemoryFilter, MemoryRecord, RecallOptions, RecallResult } from '../types.js';
import { Bm25Index } from './bm25.js';
import { maximalMarginalRelevance, type MmrCandidate } from './mmr.js';
import { resolveWeights, scoreRecord } from './scoring.js';

export interface RetrieverOptions {
  store: MemoryStore;
  embedder: EmbeddingProvider;
  decay: DecayModel;
  /** Candidates scored per query when the caller does not specify. */
  defaultCandidatePool?: number;
  defaultLimit?: number;
}

const DEFAULT_LIMIT = 8;
const DEFAULT_POOL = 400;

/**
 * Hybrid recall over a memory store.
 *
 * The pipeline is deliberately explicit rather than clever:
 *
 *   1. Hard-filter in the store (namespace, kind, tags, time, TTL).
 *   2. Take a bounded candidate pool, newest first.
 *   3. Build a per-query BM25 index over exactly that pool.
 *   4. Blend semantic, lexical, recency, importance and usage signals, then
 *      attenuate by retention.
 *   5. Drop anything under `minScore`, then rerank with MMR for diversity.
 *
 * Step 2 is what keeps recall predictable as a namespace grows: cost is
 * linear in the pool size, not in the store size.
 */
export class Retriever {
  private readonly store: MemoryStore;
  private readonly embedder: EmbeddingProvider;
  private readonly decay: DecayModel;
  private readonly defaultCandidatePool: number;
  private readonly defaultLimit: number;

  constructor(options: RetrieverOptions) {
    this.store = options.store;
    this.embedder = options.embedder;
    this.decay = options.decay;
    this.defaultCandidatePool = options.defaultCandidatePool ?? DEFAULT_POOL;
    this.defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult[]> {
    const limit = options.limit ?? this.defaultLimit;
    const pool = Math.max(limit, options.candidatePool ?? this.defaultCandidatePool);
    const filter: MemoryFilter = options.filter ?? {};

    const candidates = await this.store.query(filter, {
      limit: pool,
      orderBy: 'createdAt',
      direction: 'desc',
    });
    if (candidates.length === 0) return [];

    return this.rank(query, candidates, options, limit);
  }

  /**
   * Rank an already-fetched candidate set.
   *
   * Exposed separately so callers that have their own candidate generation
   * (a graph walk, a hand-picked working set) can reuse the scoring stack.
   */
  async rank(
    query: string,
    candidates: MemoryRecord[],
    options: RecallOptions = {},
    limit = this.defaultLimit,
  ): Promise<RecallResult[]> {
    const trimmedQuery = query.trim();
    const now = Date.now();

    // Embedding the query is the only network hop in the path, so it is
    // skipped entirely for an empty query (a pure browse).
    const queryEmbedding = trimmedQuery
      ? await embedOne(this.embedder, trimmedQuery)
      : undefined;

    const lexicalScores = trimmedQuery
      ? Bm25Index.build(
          candidates.map((record) => ({ id: record.id, text: record.content })),
        ).score(trimmedQuery)
      : new Map<string, number>();

    const weights = resolveWeights(options.weights);
    const scored = candidates.map((record) => {
      const { score, breakdown } = scoreRecord(record, {
        ...(queryEmbedding ? { queryEmbedding } : {}),
        lexicalScores,
        weights,
        decay: this.decay,
        now,
      });
      return { record, score, breakdown } satisfies RecallResult;
    });

    const minScore = options.minScore ?? 0;
    const eligible = scored
      .filter((result) => result.score >= minScore)
      .sort((a, b) => b.score - a.score);

    const diversity = options.diversity ?? 0;
    if (diversity <= 0) return eligible.slice(0, limit);

    // Reranking a bounded window keeps MMR's quadratic step cheap while still
    // giving it enough material to diversify from.
    const window = eligible.slice(0, Math.max(limit * 4, limit));
    const byId = new Map(window.map((result) => [result.record.id, result]));
    const mmrCandidates: MmrCandidate[] = window.map((result) => ({
      id: result.record.id,
      score: result.score,
      text: result.record.content,
      ...(result.record.embedding ? { embedding: result.record.embedding } : {}),
    }));

    return maximalMarginalRelevance(mmrCandidates, diversity, limit)
      .map((candidate) => byId.get(candidate.id))
      .filter((result): result is RecallResult => result !== undefined);
  }
}
