import { createRecord } from '../src/record.js';
import { HashingEmbedder } from '../src/embeddings/hashing.js';
import type { MemoryInput, MemoryRecord } from '../src/types.js';

export const embedder = new HashingEmbedder({ dimensions: 128 });

/** Build a fully-formed record with an embedding, for store and scoring tests. */
export function makeRecord(
  input: MemoryInput & { namespace?: string },
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  const record = createRecord(input, {
    namespace: input.namespace ?? 'test',
    embedding: embedder.embedSync(input.content),
  });
  return { ...record, ...overrides };
}

export const DAY_MS = 24 * 60 * 60 * 1000;
