import { cosineScore } from '../embeddings/vector.js';

export interface MmrCandidate {
  id: string;
  score: number;
  embedding?: number[];
  /** Fallback similarity basis when no embedding is present. */
  text: string;
}

/**
 * Rerank with Maximal Marginal Relevance.
 *
 * Top-k by score alone tends to return the same fact restated five ways,
 * which wastes the context window an agent is trying to fill. MMR greedily
 * picks the candidate maximising `(1 - λ)·relevance − λ·maxSimilarityToPicked`,
 * trading a little relevance for coverage.
 *
 * `lambda` is the caller's `diversity` option: 0 reproduces plain top-k, and
 * values around 0.3 give noticeably broader results without hurting quality.
 */
export function maximalMarginalRelevance(
  candidates: MmrCandidate[],
  lambda: number,
  limit: number,
): MmrCandidate[] {
  if (lambda <= 0 || candidates.length <= 1) {
    return candidates.slice(0, limit);
  }

  const remaining = [...candidates].sort((a, b) => b.score - a.score);
  const selected: MmrCandidate[] = [];

  // The highest scoring candidate is always taken first; MMR is only
  // meaningful relative to an existing selection.
  const first = remaining.shift();
  if (first) selected.push(first);

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;

    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i]!;
      let maxSimilarity = 0;
      for (const chosen of selected) {
        const similarity = similarityOf(candidate, chosen);
        if (similarity > maxSimilarity) maxSimilarity = similarity;
      }
      const value = (1 - lambda) * candidate.score - lambda * maxSimilarity;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }

    selected.push(remaining.splice(bestIndex, 1)[0]!);
  }

  return selected;
}

function similarityOf(a: MmrCandidate, b: MmrCandidate): number {
  if (a.embedding?.length && b.embedding?.length) {
    return cosineScore(a.embedding, b.embedding);
  }
  return textOverlap(a.text, b.text);
}

/** Token-set overlap, used when candidates have no embeddings to compare. */
function textOverlap(a: string, b: string): number {
  const left = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const right = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const term of left) {
    if (right.has(term)) shared += 1;
  }
  return shared / Math.min(left.size, right.size);
}
