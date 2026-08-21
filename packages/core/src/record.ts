import type { MemoryInput, MemoryRecord } from './types.js';
import { createId } from './util/id.js';
import { fingerprint } from './util/text.js';
import { clamp } from './util/time.js';
import { validateMemoryInput } from './validation.js';

export interface CreateRecordOptions {
  namespace: string;
  embedding?: number[];
  now?: number;
}

/**
 * Build a fully-formed record from a write payload.
 *
 * Centralised so every path that mints a memory — the public write API,
 * consolidation, imports — produces identical bookkeeping. In particular
 * `lastAccessedAt` starts at creation time, which is what makes a fresh
 * record score as fully retained.
 */
export function createRecord(
  input: MemoryInput,
  options: CreateRecordOptions,
): MemoryRecord {
  const validated = validateMemoryInput(input);
  const now = options.now ?? Date.now();
  const createdAt = validated.createdAt ?? now;

  const record: MemoryRecord = {
    id: validated.id ?? createId(),
    namespace: options.namespace,
    kind: validated.kind,
    source: validated.source,
    content: validated.content,
    tags: validated.tags,
    metadata: validated.metadata,
    importance: clamp(validated.importance, 0, 1),
    createdAt,
    updatedAt: now,
    lastAccessedAt: createdAt,
    accessCount: 0,
    fingerprint: fingerprint(validated.content),
  };

  if (validated.agentId) record.agentId = validated.agentId;
  if (options.embedding) record.embedding = options.embedding;
  if (validated.ttlMs !== undefined) record.expiresAt = createdAt + validated.ttlMs;

  return record;
}
