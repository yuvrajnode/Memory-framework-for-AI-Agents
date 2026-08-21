/**
 * Pluggable embedding provider.
 *
 * Providers are async and batch-oriented because every hosted embedding API
 * is, and the engine always has a batch available at write time.
 */
export interface EmbeddingProvider {
  /** Stable identifier recorded alongside vectors, e.g. "hashing-v1". */
  readonly id: string;
  /** Vector width. Fixed for the lifetime of the provider instance. */
  readonly dimensions: number;
  /** Embed a batch. The result must align index-for-index with the input. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Convenience wrapper for the single-text case. */
export async function embedOne(
  provider: EmbeddingProvider,
  text: string,
): Promise<number[]> {
  const [vector] = await provider.embed([text]);
  return vector ?? new Array<number>(provider.dimensions).fill(0);
}
