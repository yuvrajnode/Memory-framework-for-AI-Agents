import { createHash } from 'node:crypto';

/**
 * A compact English stop list. Kept deliberately short: aggressive stopping
 * hurts lexical recall on agent memories, which are full of short imperative
 * sentences where words like "not" and "no" carry the meaning.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'i', 'in', 'is', 'it', 'its',
  'of', 'on', 'or', 'she', 'that', 'the', 'their', 'them', 'they', 'this',
  'to', 'was', 'were', 'will', 'with', 'you', 'your',
]);

/**
 * Split text into normalised terms.
 *
 * Identifiers matter in agent memory (`user_id`, `POST /orders`, `v2.1`), so
 * the tokenizer keeps digits, underscores, dots and slashes inside a token
 * instead of shattering them into noise.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_./\-\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^[-./]+|[-./]+$/g, ''))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/** Tokens with stop words retained, for fingerprinting and dedup. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Stable content hash used to detect exact restatements before they are
 * written. Normalisation means casing and whitespace differences collapse.
 */
export function fingerprint(text: string): string {
  return createHash('sha256').update(normalize(text)).digest('hex').slice(0, 32);
}

/**
 * Jaccard similarity over token sets, in [0, 1].
 *
 * Used as a cheap pre-filter for near-duplicates so the engine does not need
 * an embedding round trip to notice that "user prefers dark mode" and "the
 * user prefers dark mode" are the same memory.
 */
export function jaccard(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const term of left) {
    if (right.has(term)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

/**
 * Estimate token count without pulling in a tokenizer dependency.
 *
 * Calibrated against cl100k_bpe on English prose and code: roughly four
 * characters per token, with a floor of one token per whitespace word so that
 * long identifier-heavy text is not undercounted.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  const words = text.trim().split(/\s+/).length;
  return Math.max(Math.ceil(chars / 4), words);
}

/** Split prose into sentences, keeping terminal punctuation attached. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'`])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Trim to a character budget on a word boundary, with an ellipsis. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
