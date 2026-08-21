import { tokenize } from '../util/text.js';
import { normalizeVector } from './vector.js';
import type { EmbeddingProvider } from './types.js';

/** FNV-1a, 32-bit. Fast, well distributed, and dependency free. */
function hash32(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Character n-grams, which give the embedder tolerance to typos and morphology. */
function characterGrams(token: string, size: number): string[] {
  const padded = `^${token}$`;
  if (padded.length <= size) return [padded];
  const grams: string[] = [];
  for (let i = 0; i <= padded.length - size; i += 1) {
    grams.push(padded.slice(i, i + size));
  }
  return grams;
}

export interface HashingEmbedderOptions {
  /** Vector width. Larger reduces collisions; 384 mirrors common small models. */
  dimensions?: number;
  /** Also hash adjacent word pairs, which captures short-range word order. */
  useBigrams?: boolean;
  /** Character n-gram width used for subword robustness. Set 0 to disable. */
  charGramSize?: number;
}

/**
 * A deterministic, offline embedding provider built on the hashing trick.
 *
 * This is not a neural embedder and does not claim to be: it projects
 * token, bigram and character-trigram counts into a fixed-width space with
 * signed hashing and sublinear term weighting. In practice that captures
 * lexical and morphological similarity well enough to develop, test and demo
 * the whole retrieval stack with no API key, no network and no cold start —
 * and because it is deterministic, retrieval tests are reproducible.
 *
 * Swap in {@link OpenAIEmbedder} (or any {@link EmbeddingProvider}) for
 * production semantics; nothing else in the framework changes.
 */
export class HashingEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;

  private readonly useBigrams: boolean;
  private readonly charGramSize: number;

  constructor(options: HashingEmbedderOptions = {}) {
    this.dimensions = options.dimensions ?? 384;
    this.useBigrams = options.useBigrams ?? true;
    this.charGramSize = options.charGramSize ?? 3;
    this.id = `hashing-v1-${this.dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedSync(text));
  }

  /** Synchronous path, useful in tests and hot loops. */
  embedSync(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = tokenize(text);
    if (tokens.length === 0) return vector;

    // Occurrences and per-feature salience are tracked separately: term
    // frequency must stay an integer count for the sublinear scaling below to
    // behave, while salience says how much a *class* of feature is trusted.
    const counts = new Map<string, number>();
    const salience = new Map<string, number>();
    const bump = (feature: string, weight: number) => {
      counts.set(feature, (counts.get(feature) ?? 0) + 1);
      salience.set(feature, weight);
    };

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      bump(`w:${token}`, 1);

      if (this.charGramSize > 0) {
        for (const gram of characterGrams(token, this.charGramSize)) {
          // Subword features are supporting evidence, not primary signal.
          bump(`c:${gram}`, 0.35);
        }
      }
      if (this.useBigrams && i + 1 < tokens.length) {
        bump(`b:${token}~${tokens[i + 1]!}`, 0.6);
      }
    }

    for (const [feature, count] of counts) {
      // Sublinear scaling keeps a repeated word from dominating the vector.
      const weight = (salience.get(feature) ?? 1) * (1 + Math.log(count));
      const index = hash32(feature) % this.dimensions;
      // A second, independent hash picks the sign, which makes collisions
      // cancel out on average instead of accumulating.
      const sign = hash32(feature, 0x9e3779b1) & 1 ? 1 : -1;
      vector[index]! += sign * weight;
    }

    return normalizeVector(vector);
  }
}
