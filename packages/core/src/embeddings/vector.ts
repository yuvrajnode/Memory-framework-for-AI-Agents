/** Dense vector helpers. All functions assume plain number arrays. */

/** Squared L2 norm. */
export function normSquared(vector: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < vector.length; i += 1) total += vector[i]! * vector[i]!;
  return total;
}

export function norm(vector: readonly number[]): number {
  return Math.sqrt(normSquared(vector));
}

/** Scale a vector to unit length in place-free fashion. Zero vectors pass through. */
export function normalizeVector(vector: readonly number[]): number[] {
  const magnitude = norm(vector);
  if (magnitude === 0) return [...vector];
  const result = new Array<number>(vector.length);
  for (let i = 0; i < vector.length; i += 1) result[i] = vector[i]! / magnitude;
  return result;
}

export function dot(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < length; i += 1) total += a[i]! * b[i]!;
  return total;
}

/**
 * Cosine similarity in [-1, 1]. Mismatched lengths are compared over their
 * shared prefix rather than throwing, so a store that outlived an embedder
 * change degrades instead of erroring.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const magnitude = norm(a) * norm(b);
  if (magnitude === 0) return 0;
  return dot(a, b) / magnitude;
}

/**
 * Cosine similarity rescaled to [0, 1] so it can be blended with the other
 * recall signals, which are all non-negative.
 */
export function cosineScore(a: readonly number[], b: readonly number[]): number {
  return (cosineSimilarity(a, b) + 1) / 2;
}

/** Element-wise mean of a set of vectors, used to build centroids. */
export function centroid(vectors: readonly (readonly number[])[]): number[] {
  if (vectors.length === 0) return [];
  const dimensions = vectors[0]!.length;
  const result = new Array<number>(dimensions).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dimensions; i += 1) result[i]! += vector[i] ?? 0;
  }
  for (let i = 0; i < dimensions; i += 1) result[i]! /= vectors.length;
  return result;
}
