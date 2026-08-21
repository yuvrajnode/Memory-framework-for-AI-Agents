import { cosineScore } from '../embeddings/vector.js';
import { jaccard } from '../util/text.js';
import type { MemoryRecord } from '../types.js';

export interface ClusterOptions {
  /** Pairs at or above this similarity join the same cluster. */
  threshold: number;
  /** Clusters smaller than this are discarded as not worth consolidating. */
  minSize?: number;
  /** Upper bound on members, so one huge cluster cannot swallow a namespace. */
  maxSize?: number;
}

/**
 * Similarity between two records.
 *
 * Prefers cosine over embeddings and falls back to token-set overlap, so
 * clustering still works on records written before an embedder was
 * configured, or when a provider was briefly unavailable.
 */
export function recordSimilarity(a: MemoryRecord, b: MemoryRecord): number {
  if (a.embedding?.length && b.embedding?.length) {
    return cosineScore(a.embedding, b.embedding);
  }
  return jaccard(a.content, b.content);
}

/**
 * Single-link agglomerative clustering via union-find.
 *
 * Single-link is the right shape for consolidation: it chains together a
 * conversation that drifts across a topic ("prefers dark mode" → "hates the
 * light theme at night" → "set the editor to dark") without needing a
 * cluster count chosen upfront. Its usual weakness, chaining unrelated items
 * through a long bridge, is bounded by `maxSize`.
 *
 * O(n²) in the candidate count, which is fine because consolidation runs over
 * a capped batch during maintenance rather than on the request path.
 */
export function clusterRecords(
  records: MemoryRecord[],
  options: ClusterOptions,
): MemoryRecord[][] {
  const minSize = options.minSize ?? 2;
  const maxSize = options.maxSize ?? 12;
  const parent = records.map((_, index) => index);

  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    // Path compression, so repeated lookups stay near-constant.
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };

  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      if (recordSimilarity(records[i]!, records[j]!) >= options.threshold) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, MemoryRecord[]>();
  for (let index = 0; index < records.length; index += 1) {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(records[index]!);
    else groups.set(root, [records[index]!]);
  }

  const clusters: MemoryRecord[][] = [];
  for (const group of groups.values()) {
    if (group.length < minSize) continue;
    if (group.length <= maxSize) {
      clusters.push(group);
      continue;
    }
    // Over-sized clusters are split by importance, keeping the most salient
    // members together rather than truncating arbitrarily.
    const ordered = [...group].sort((a, b) => b.importance - a.importance);
    for (let offset = 0; offset < ordered.length; offset += maxSize) {
      const chunk = ordered.slice(offset, offset + maxSize);
      if (chunk.length >= minSize) clusters.push(chunk);
    }
  }
  return clusters;
}
