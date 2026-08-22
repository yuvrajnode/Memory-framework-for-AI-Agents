import { describe, expect, it } from 'vitest';
import { MemoryEngine } from '../src/engine.js';
import { InMemoryStore } from '../src/store/in-memory.js';
import { HashingEmbedder } from '../src/embeddings/hashing.js';
import { EVAL_QUERIES, evalCorpus } from './fixtures/corpus.js';
import { jaccard } from '../src/util/text.js';
import type { RecallResult } from '../src/types.js';

const embedder = new HashingEmbedder({ dimensions: 384 });

async function seededEngine(): Promise<MemoryEngine> {
  const engine = new MemoryEngine({
    store: new InMemoryStore(),
    embedder,
    autoLink: false,
    deduplicate: false,
  });
  for (const memory of evalCorpus()) await engine.remember(memory);
  return engine;
}

function refOf(result: RecallResult): string {
  return String(result.record.metadata['ref'] ?? '');
}

/**
 * Ranking quality, measured rather than asserted anecdotally.
 *
 * A retrieval system can pass every unit test and still rank badly, because
 * unit tests check mechanism and ranking is an aggregate property. This suite
 * runs a labelled corpus and pins the aggregate metrics, so a change that
 * quietly degrades recall fails here instead of in someone's agent.
 *
 * The thresholds sit below the measured values with deliberate headroom: they
 * exist to catch regressions, not to freeze the current numbers.
 */
describe('retrieval quality', () => {
  it('ranks the expected memory first for most queries', async () => {
    const engine = await seededEngine();
    let hits = 0;
    const misses: string[] = [];

    for (const { query, expected } of EVAL_QUERIES) {
      const results = await engine.recall(query, { limit: 5, reinforce: false });
      if (results[0] && refOf(results[0]) === expected) hits += 1;
      else misses.push(`${query} → ${results[0] ? refOf(results[0]) : 'nothing'} (want ${expected})`);
    }

    const accuracy = hits / EVAL_QUERIES.length;
    expect(accuracy, `top-1 misses:\n${misses.join('\n')}`).toBeGreaterThanOrEqual(0.5);
  });

  it('holds mean reciprocal rank above the regression floor', async () => {
    const engine = await seededEngine();
    let total = 0;

    for (const { query, expected } of EVAL_QUERIES) {
      const results = await engine.recall(query, { limit: 12, reinforce: false });
      const rank = results.findIndex((result) => refOf(result) === expected) + 1;
      total += rank > 0 ? 1 / rank : 0;
    }

    expect(total / EVAL_QUERIES.length).toBeGreaterThanOrEqual(0.6);
  });

  it('finds the expected memory somewhere in the top five', async () => {
    const engine = await seededEngine();
    let recalled = 0;

    for (const { query, expected } of EVAL_QUERIES) {
      const results = await engine.recall(query, { limit: 5, reinforce: false });
      if (results.some((result) => refOf(result) === expected)) recalled += 1;
    }

    expect(recalled / EVAL_QUERIES.length).toBeGreaterThanOrEqual(0.8);
  });

  it('retrieves exact identifiers through the lexical signal', async () => {
    const engine = await seededEngine();
    // These are precisely the lookups dense retrieval alone fails: a ticket
    // id and a column name carry no distributional meaning.
    for (const { query, expected } of [
      { query: 'INC-204', expected: 'event-inc-204' },
      { query: 'orders.customer_id', expected: 'event-inc-204-cause' },
      { query: 'runner-4', expected: 'event-build-4821' },
    ]) {
      const results = await engine.recall(query, { limit: 3, reinforce: false });
      expect(
        results.some((result) => refOf(result) === expected),
        `"${query}" did not retrieve ${expected}`,
      ).toBe(true);
    }
  });

  it('separates the correct answer from the best wrong one', async () => {
    const engine = await seededEngine();
    let gaps = 0;
    let counted = 0;

    for (const { query, expected } of EVAL_QUERIES) {
      const results = await engine.recall(query, { limit: 12, reinforce: false });
      const correct = results.find((result) => refOf(result) === expected);
      const bestWrong = results.find((result) => refOf(result) !== expected);
      if (!correct || !bestWrong) continue;
      gaps += correct.score - bestWrong.score;
      counted += 1;
    }

    // A positive mean margin means the ranking is genuinely discriminating
    // rather than winning on ties.
    expect(gaps / counted).toBeGreaterThan(0);
  });

  it('keeps unrelated queries from returning confident matches', async () => {
    const engine = await seededEngine();
    const results = await engine.recall(
      'what is the airspeed velocity of an unladen swallow',
      { limit: 5, reinforce: false, minScore: 0.35 },
    );
    expect(results).toHaveLength(0);
  });

  it('returns a less self-similar result set when diversity is raised', async () => {
    const engine = await seededEngine();
    const plain = await engine.recall('deploy', { limit: 4, diversity: 0, reinforce: false });
    const diverse = await engine.recall('deploy', { limit: 4, diversity: 0.7, reinforce: false });

    // MMR optimises coverage of the query, not variety of kinds, so the
    // measure has to be mean pairwise similarity within the result set.
    const selfSimilarity = (results: RecallResult[]): number => {
      let total = 0;
      let pairs = 0;
      for (let i = 0; i < results.length; i += 1) {
        for (let j = i + 1; j < results.length; j += 1) {
          total += jaccard(results[i]!.record.content, results[j]!.record.content);
          pairs += 1;
        }
      }
      return pairs === 0 ? 0 : total / pairs;
    };

    expect(diverse).toHaveLength(plain.length);
    expect(selfSimilarity(diverse)).toBeLessThanOrEqual(selfSimilarity(plain));
  });
});
