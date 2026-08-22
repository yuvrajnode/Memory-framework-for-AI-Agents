import { describe, expect, it } from 'vitest';
import { Bm25Index } from '../src/retrieval/bm25.js';
import { maximalMarginalRelevance } from '../src/retrieval/mmr.js';
import { resolveWeights, scoreRecord } from '../src/retrieval/scoring.js';
import { DEFAULT_RECALL_WEIGHTS } from '../src/types.js';
import { DecayModel } from '../src/pipeline/decay.js';
import { DAY_MS, embedder, makeRecord } from './helpers.js';

describe('Bm25Index', () => {
  const documents = [
    { id: 'a', text: 'the deployment failed with error ENOSPC on runner-4' },
    { id: 'b', text: 'ada prefers oat milk in her morning coffee' },
    { id: 'c', text: 'a deployment to staging succeeded after the retry' },
  ];

  it('ranks the document containing the rare term first', () => {
    const scores = Bm25Index.build(documents).score('ENOSPC');
    expect([...scores.keys()]).toEqual(['a']);
  });

  it('normalises the best score to exactly 1', () => {
    const scores = Bm25Index.build(documents).score('deployment');
    expect(Math.max(...scores.values())).toBe(1);
  });

  it('scores every match within [0, 1]', () => {
    for (const score of Bm25Index.build(documents).score('deployment').values()) {
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('returns nothing for a query with no matching terms', () => {
    expect(Bm25Index.build(documents).score('kangaroo').size).toBe(0);
  });

  it('handles an empty corpus and an empty query', () => {
    expect(Bm25Index.build([]).score('anything').size).toBe(0);
    expect(Bm25Index.build(documents).score('   ').size).toBe(0);
  });

  it('prefers the shorter document when term frequency ties', () => {
    const scores = Bm25Index.build([
      { id: 'short', text: 'cache invalidation' },
      { id: 'long', text: `cache invalidation ${'padding word '.repeat(30)}` },
    ]).score('cache invalidation');
    expect(scores.get('short')!).toBeGreaterThan(scores.get('long')!);
  });
});

describe('scoreRecord', () => {
  const decay = new DecayModel();
  const now = Date.now();

  const context = (overrides: Partial<Parameters<typeof scoreRecord>[1]> = {}) => ({
    lexicalScores: new Map<string, number>(),
    weights: resolveWeights(),
    decay,
    now,
    ...overrides,
  });

  it('scores a fresh, on-topic record highly', () => {
    const record = makeRecord({ content: 'database connection timeout', importance: 0.8 });
    const { score } = scoreRecord(record, {
      ...context(),
      queryEmbedding: embedder.embedSync('database connection timed out'),
    });
    expect(score).toBeGreaterThan(0.5);
  });

  it('suppresses a cold record even when it matches the query', () => {
    const query = embedder.embedSync('database connection timed out');
    const fresh = makeRecord({ content: 'database connection timeout' });
    const stale = makeRecord(
      { content: 'database connection timeout' },
      { createdAt: now - 400 * DAY_MS, lastAccessedAt: now - 400 * DAY_MS },
    );
    const freshScore = scoreRecord(fresh, { ...context(), queryEmbedding: query }).score;
    const staleScore = scoreRecord(stale, { ...context(), queryEmbedding: query }).score;
    expect(staleScore).toBeLessThan(freshScore * 0.5);
  });

  it('reports a breakdown for every signal', () => {
    const record = makeRecord({ content: 'some memory' });
    const { breakdown } = scoreRecord(record, {
      ...context({ lexicalScores: new Map([[record.id, 0.6]]) }),
      queryEmbedding: embedder.embedSync('some memory'),
    });
    expect(breakdown.lexical).toBe(0.6);
    expect(breakdown.semantic).toBeGreaterThan(0.5);
    expect(breakdown.retention).toBeGreaterThan(0.99);
  });

  it('falls back to the other signals when a record has no embedding', () => {
    const record = makeRecord({ content: 'no vector here' }, { embedding: undefined });
    const { score, breakdown } = scoreRecord(record, {
      ...context({ lexicalScores: new Map([[record.id, 1]]) }),
      queryEmbedding: embedder.embedSync('no vector here'),
    });
    expect(breakdown.semantic).toBe(0);
    expect(score).toBeGreaterThan(0);
  });

  it('lets weights zero out a signal entirely', () => {
    const record = makeRecord({ content: 'matching text', importance: 1 });
    const weights = resolveWeights({
      semantic: 0,
      lexical: 0,
      recency: 0,
      usage: 0,
      importance: 1,
    });
    const { score } = scoreRecord(record, { ...context({ weights }) });
    expect(score).toBeCloseTo(1, 1);
  });

  it('never returns a score outside [0, 1]', () => {
    const record = makeRecord({ content: 'edge case', importance: 1 }, { accessCount: 10_000 });
    const { score } = scoreRecord(record, {
      ...context(),
      queryEmbedding: embedder.embedSync('edge case'),
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('resolveWeights', () => {
  it('merges partial overrides onto the defaults', () => {
    expect(resolveWeights({ semantic: 3 })).toMatchObject({
      semantic: 3,
      lexical: DEFAULT_RECALL_WEIGHTS.lexical,
    });
  });

  it('ignores non-finite values instead of poisoning the blend', () => {
    expect(resolveWeights({ semantic: Number.NaN }).semantic).toBe(1);
  });

  it('clamps negative weights to zero', () => {
    expect(resolveWeights({ recency: -5 }).recency).toBe(0);
  });
});

describe('maximalMarginalRelevance', () => {
  const candidates = [
    { id: '1', score: 0.9, text: 'deploy the api service to production' },
    { id: '2', score: 0.88, text: 'deploy the api service to prod environment' },
    { id: '3', score: 0.5, text: 'rotate the database credentials quarterly' },
  ];

  it('reproduces plain top-k when diversity is zero', () => {
    expect(maximalMarginalRelevance(candidates, 0, 2).map((c) => c.id)).toEqual(['1', '2']);
  });

  it('breaks up near-duplicates when diversity is high', () => {
    expect(maximalMarginalRelevance(candidates, 0.8, 2).map((c) => c.id)).toEqual(['1', '3']);
  });

  it('always keeps the top-scoring candidate', () => {
    expect(maximalMarginalRelevance(candidates, 0.9, 1)[0]!.id).toBe('1');
  });

  it('handles fewer candidates than the limit', () => {
    expect(maximalMarginalRelevance(candidates.slice(0, 1), 0.5, 5)).toHaveLength(1);
  });

  it('uses embeddings for similarity when present', () => {
    const withVectors = candidates.map((candidate) => ({
      ...candidate,
      embedding: embedder.embedSync(candidate.text),
    }));
    expect(maximalMarginalRelevance(withVectors, 0.7, 2).map((c) => c.id)).toEqual(['1', '3']);
  });
});
