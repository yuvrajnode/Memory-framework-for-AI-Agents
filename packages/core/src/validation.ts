import { ValidationError } from './errors.js';
import {
  MEMORY_KINDS,
  MEMORY_SOURCES,
  type MemoryFilter,
  type MemoryInput,
  type MemoryKind,
  type MemorySource,
  type Metadata,
  type RecallOptions,
} from './types.js';
import { clamp } from './util/time.js';

/** Upper bound on a single memory's content, in characters. */
export const MAX_CONTENT_LENGTH = 20_000;
export const MAX_TAGS = 32;
export const MAX_TAG_LENGTH = 64;
export const MAX_METADATA_KEYS = 64;
export const MAX_NAMESPACE_LENGTH = 128;

const NAMESPACE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

function assert(condition: unknown, message: string, details?: unknown): asserts condition {
  if (!condition) throw new ValidationError(message, details);
}

export function validateNamespace(namespace: string): string {
  assert(typeof namespace === 'string', 'namespace must be a string');
  const trimmed = namespace.trim();
  assert(trimmed.length > 0, 'namespace must not be empty');
  assert(
    trimmed.length <= MAX_NAMESPACE_LENGTH,
    `namespace must be at most ${MAX_NAMESPACE_LENGTH} characters`,
  );
  assert(
    NAMESPACE_PATTERN.test(trimmed),
    'namespace may contain letters, digits, dot, colon, dash and underscore, and must start alphanumeric',
    { namespace: trimmed },
  );
  return trimmed;
}

export function validateKind(kind: unknown): MemoryKind {
  assert(
    typeof kind === 'string' && (MEMORY_KINDS as readonly string[]).includes(kind),
    `kind must be one of ${MEMORY_KINDS.join(', ')}`,
    { kind },
  );
  return kind as MemoryKind;
}

export function validateSource(source: unknown): MemorySource {
  assert(
    typeof source === 'string' && (MEMORY_SOURCES as readonly string[]).includes(source),
    `source must be one of ${MEMORY_SOURCES.join(', ')}`,
    { source },
  );
  return source as MemorySource;
}

export function normalizeTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return [];
  assert(Array.isArray(tags), 'tags must be an array of strings');
  assert(tags.length <= MAX_TAGS, `at most ${MAX_TAGS} tags are allowed`);
  const seen = new Set<string>();
  for (const raw of tags) {
    assert(typeof raw === 'string', 'every tag must be a string', { tag: raw });
    const tag = raw.trim().toLowerCase();
    if (!tag) continue;
    assert(tag.length <= MAX_TAG_LENGTH, `tags must be at most ${MAX_TAG_LENGTH} characters`, { tag });
    seen.add(tag);
  }
  return [...seen].sort();
}

export function normalizeMetadata(metadata: unknown): Metadata {
  if (metadata === undefined || metadata === null) return {};
  assert(
    typeof metadata === 'object' && !Array.isArray(metadata),
    'metadata must be a flat object',
  );
  const entries = Object.entries(metadata as Record<string, unknown>);
  assert(
    entries.length <= MAX_METADATA_KEYS,
    `metadata may hold at most ${MAX_METADATA_KEYS} keys`,
  );
  const result: Metadata = {};
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    assert(
      value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean',
      `metadata.${key} must be a string, number, boolean or null`,
      { key, value },
    );
    assert(
      typeof value !== 'number' || Number.isFinite(value),
      `metadata.${key} must be a finite number`,
      { key },
    );
    result[key] = value as Metadata[string];
  }
  return result;
}

/** Validate and normalise a write payload. Throws `ValidationError` on bad input. */
export function validateMemoryInput(input: MemoryInput): Required<
  Pick<MemoryInput, 'content' | 'kind' | 'source' | 'tags' | 'metadata' | 'importance'>
> &
  MemoryInput {
  assert(input && typeof input === 'object', 'a memory payload is required');
  assert(typeof input.content === 'string', 'content must be a string');
  const content = input.content.trim();
  assert(content.length > 0, 'content must not be empty');
  assert(
    content.length <= MAX_CONTENT_LENGTH,
    `content must be at most ${MAX_CONTENT_LENGTH} characters`,
    { length: content.length },
  );

  if (input.ttlMs !== undefined) {
    assert(
      typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs) && input.ttlMs > 0,
      'ttlMs must be a positive number of milliseconds',
    );
  }
  if (input.createdAt !== undefined) {
    assert(
      typeof input.createdAt === 'number' && Number.isFinite(input.createdAt),
      'createdAt must be an epoch timestamp in milliseconds',
    );
  }
  if (input.importance !== undefined) {
    assert(
      typeof input.importance === 'number' && Number.isFinite(input.importance),
      'importance must be a number in [0, 1]',
    );
  }

  return {
    ...input,
    content,
    kind: input.kind === undefined ? 'episodic' : validateKind(input.kind),
    source: input.source === undefined ? 'agent' : validateSource(input.source),
    tags: normalizeTags(input.tags),
    metadata: normalizeMetadata(input.metadata),
    importance: clamp(input.importance ?? 0.5, 0, 1),
  };
}

export function validateFilter(filter: MemoryFilter | undefined): MemoryFilter {
  if (!filter) return {};
  const result: MemoryFilter = { ...filter };
  if (filter.namespace !== undefined) result.namespace = validateNamespace(filter.namespace);
  if (filter.kinds !== undefined) {
    assert(Array.isArray(filter.kinds), 'filter.kinds must be an array');
    result.kinds = filter.kinds.map(validateKind);
  }
  if (filter.sources !== undefined) {
    assert(Array.isArray(filter.sources), 'filter.sources must be an array');
    result.sources = filter.sources.map(validateSource);
  }
  if (filter.tags !== undefined) result.tags = normalizeTags(filter.tags);
  if (filter.anyTags !== undefined) result.anyTags = normalizeTags(filter.anyTags);
  if (filter.minImportance !== undefined) {
    result.minImportance = clamp(filter.minImportance, 0, 1);
  }
  return result;
}

export function validateRecallOptions(options: RecallOptions | undefined): RecallOptions {
  if (!options) return {};
  const result: RecallOptions = { ...options, filter: validateFilter(options.filter) };
  if (options.limit !== undefined) {
    assert(
      Number.isInteger(options.limit) && options.limit > 0 && options.limit <= 500,
      'limit must be an integer between 1 and 500',
    );
  }
  if (options.candidatePool !== undefined) {
    assert(
      Number.isInteger(options.candidatePool) && options.candidatePool > 0,
      'candidatePool must be a positive integer',
    );
  }
  if (options.diversity !== undefined) result.diversity = clamp(options.diversity, 0, 1);
  if (options.minScore !== undefined) result.minScore = clamp(options.minScore, 0, 1);
  return result;
}
