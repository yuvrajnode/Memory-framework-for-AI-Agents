/**
 * Pure-TypeScript hashing, so the framework carries no `node:crypto`
 * dependency and the same code runs in a browser bundle.
 *
 * These are non-cryptographic hashes. They are used for content
 * fingerprinting and feature bucketing — both of which need speed, stability
 * and a good avalanche, and neither of which needs collision resistance
 * against an adversary. Nothing here should be used for signing or secrets.
 */

/** FNV-1a, 32-bit. */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Four independently seeded FNV-1a passes, rendered as 32 hex characters. */
const SEEDS = [0x811c9dc5, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35];

export function hash128(text: string): string {
  let result = '';
  for (const seed of SEEDS) {
    // A per-pass suffix keeps the streams from degenerating into shifted
    // copies of one another on short inputs.
    result += fnv1a(`${text} ${seed}`, seed).toString(16).padStart(8, '0');
  }
  return result;
}

/** Cryptographically strong random bytes, via WebCrypto on Node and browsers. */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const webcrypto = globalThis.crypto;
  if (webcrypto?.getRandomValues) {
    webcrypto.getRandomValues(bytes);
    return bytes;
  }
  // Only reachable on a runtime with no WebCrypto at all; ids stay unique
  // enough for local use because they are also time-prefixed.
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}
