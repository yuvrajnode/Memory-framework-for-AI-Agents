import { tokenize } from '../util/text.js';

export interface Bm25Options {
  /** Term-frequency saturation. Higher values reward repetition more. */
  k1?: number;
  /** Length normalisation in [0, 1]. 0.75 is the standard default. */
  b?: number;
}

interface IndexedDocument {
  id: string;
  length: number;
  frequencies: Map<string, number>;
}

/**
 * BM25 ranking over a candidate set.
 *
 * Vector search alone reliably misses the things agents actually need to look
 * up by name — an order id, a flag like `--no-cache`, a person's surname.
 * Lexical scoring recovers those, so the two signals are blended rather than
 * chosen between.
 *
 * The index is built per query over the already-filtered candidate set. That
 * keeps IDF honest with respect to the corpus being searched and avoids
 * maintaining a second persistent index alongside the store.
 */
export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly documents: IndexedDocument[] = [];
  private readonly documentFrequency = new Map<string, number>();
  private averageLength = 0;

  constructor(options: Bm25Options = {}) {
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
  }

  /** Build the index from `id -> text` pairs. Replaces any previous contents. */
  static build(
    documents: { id: string; text: string }[],
    options?: Bm25Options,
  ): Bm25Index {
    const index = new Bm25Index(options);
    for (const document of documents) index.add(document.id, document.text);
    index.finalize();
    return index;
  }

  add(id: string, text: string): void {
    const terms = tokenize(text);
    const frequencies = new Map<string, number>();
    for (const term of terms) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
    for (const term of frequencies.keys()) {
      this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
    }
    this.documents.push({ id, length: terms.length, frequencies });
  }

  /** Compute the average document length. Call once after the last `add`. */
  finalize(): void {
    if (this.documents.length === 0) {
      this.averageLength = 0;
      return;
    }
    let total = 0;
    for (const document of this.documents) total += document.length;
    this.averageLength = total / this.documents.length;
  }

  /** Smoothed inverse document frequency, floored at zero. */
  private idf(term: string): number {
    const n = this.documents.length;
    const df = this.documentFrequency.get(term) ?? 0;
    if (df === 0) return 0;
    return Math.max(0, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  /**
   * Score every document against the query.
   *
   * Raw BM25 is unbounded, which makes it impossible to blend with the other
   * signals, so scores are divided by the best score in the result set. The
   * output is therefore relative within one query — exactly the semantics
   * ranking needs — and always lands in [0, 1].
   */
  score(query: string): Map<string, number> {
    const scores = new Map<string, number>();
    if (this.documents.length === 0) return scores;

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return scores;

    const uniqueTerms = [...new Set(queryTerms)];
    let best = 0;

    for (const document of this.documents) {
      let score = 0;
      for (const term of uniqueTerms) {
        const frequency = document.frequencies.get(term);
        if (!frequency) continue;
        const normalization =
          this.averageLength > 0
            ? 1 - this.b + this.b * (document.length / this.averageLength)
            : 1;
        score +=
          this.idf(term) *
          ((frequency * (this.k1 + 1)) / (frequency + this.k1 * normalization));
      }
      if (score > 0) {
        scores.set(document.id, score);
        if (score > best) best = score;
      }
    }

    if (best > 0) {
      for (const [id, score] of scores) scores.set(id, score / best);
    }
    return scores;
  }

  get size(): number {
    return this.documents.length;
  }
}
