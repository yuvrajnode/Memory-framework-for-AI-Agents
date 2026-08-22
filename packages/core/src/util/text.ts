import { hash128 } from './hash.js';

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
 * Scripts written without spaces between words. A run of these characters is
 * one "token" to a whitespace splitter, which is useless for retrieval.
 */
const UNSEGMENTED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/** Everything that is not a letter, a digit, or intra-token punctuation. */
const SEPARATORS = /[^\p{L}\p{N}_./-]+/gu;

/**
 * Character bigrams, the standard segmentation fallback for scripts with no
 * word boundaries. Two adjacent characters carry enough signal for both
 * lexical matching and the hashing embedder.
 */
function characterBigrams(token: string): string[] {
  const characters = [...token];
  if (characters.length <= 1) return characters;
  const grams: string[] = [];
  for (let i = 0; i < characters.length - 1; i += 1) {
    grams.push(characters[i]! + characters[i + 1]!);
  }
  return grams;
}

/**
 * Split text into normalised terms.
 *
 * Two things this has to get right that a naive `split(/\W+/)` does not:
 *
 * - **Identifiers.** `user_id`, `POST /orders` and `v2.1` are exactly what
 *   agents look memories up by, so digits, underscores, dots and slashes stay
 *   inside a token rather than shattering it into noise.
 * - **Non-Latin scripts.** Matching on `[a-z]` silently reduces Japanese,
 *   Arabic, Cyrillic and every other non-Latin text to zero tokens — which
 *   makes those memories unsearchable, unembeddable, and (since two empty
 *   token sets look identical) indistinguishable from each other. Unicode
 *   property escapes keep every script, and unsegmented scripts fall back to
 *   character bigrams because whitespace tells you nothing about where their
 *   words begin.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];

  for (const raw of text.toLowerCase().split(SEPARATORS)) {
    const token = raw.replace(/^[-./]+|[-./]+$/gu, '');
    if (!token) continue;

    if (UNSEGMENTED.test(token)) {
      tokens.push(...characterBigrams(token));
      continue;
    }
    // Single characters carry almost no signal in segmented scripts, and stop
    // words carry less than the noise they add.
    if (token.length > 1 && !STOP_WORDS.has(token)) tokens.push(token);
  }

  return tokens;
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
  return hash128(normalize(text));
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
  // Two texts with nothing extractable are not evidence of a duplicate, so
  // this reports "no signal" rather than the set-theoretic answer of 1.
  // Callers use this to decide whether to merge memories; claiming certainty
  // from an absence of data is the expensive direction to be wrong in.
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
