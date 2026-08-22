import { randomBytes } from './hash.js';

const ALPHABET = '0123456789abcdefghijkmnpqrstuvwxyz';

/**
 * A short, sortable-ish, URL-safe identifier.
 *
 * The first eight characters encode the creation time in base-32, so ids sort
 * chronologically in a plain string sort — convenient when eyeballing a store
 * dump or paging through a table without a secondary index.
 */
export function createId(prefix = 'mem'): string {
  const now = Date.now();
  let time = '';
  let cursor = now;
  while (cursor > 0) {
    time = ALPHABET[cursor % 32]! + time;
    cursor = Math.floor(cursor / 32);
  }
  const entropy = randomBytes(6);
  let suffix = '';
  for (const byte of entropy) {
    suffix += ALPHABET[byte % 32];
  }
  return `${prefix}_${time.padStart(8, '0')}${suffix}`;
}

/** A full RFC 4122 v4 UUID, for callers that need one. */
export function createUuid(): string {
  const webcrypto = globalThis.crypto;
  if (webcrypto?.randomUUID) return webcrypto.randomUUID();
  // Manual v4 assembly for runtimes without randomUUID: set the version and
  // variant bits by hand, then render in the canonical grouping.
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20),
  ].join('-');
}
