import { randomUUID, randomBytes } from 'node:crypto';

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
  return randomUUID();
}
