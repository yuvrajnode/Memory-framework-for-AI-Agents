import type { MemoryFilter, MemoryLink, MemoryRecord } from '../types.js';

export type MemoryOrderBy =
  | 'createdAt'
  | 'updatedAt'
  | 'lastAccessedAt'
  | 'importance'
  | 'accessCount';

export interface QueryOptions {
  limit?: number;
  offset?: number;
  orderBy?: MemoryOrderBy;
  direction?: 'asc' | 'desc';
}

/** Fields the engine is allowed to mutate after a record is written. */
export type MemoryPatch = Partial<
  Pick<
    MemoryRecord,
    | 'content'
    | 'embedding'
    | 'tags'
    | 'metadata'
    | 'importance'
    | 'kind'
    | 'updatedAt'
    | 'lastAccessedAt'
    | 'accessCount'
    | 'expiresAt'
    | 'supersededBy'
    | 'derivedFrom'
    | 'fingerprint'
  >
>;

/**
 * Persistence contract.
 *
 * Deliberately narrow: the store owns durability and hard filtering, while
 * scoring, decay and consolidation live in the engine. That split means a new
 * backend only has to implement CRUD plus a predicate, and inherits the whole
 * retrieval stack unchanged.
 */
export interface MemoryStore {
  /** Identifies the backend in logs and health checks, e.g. "sqlite". */
  readonly id: string;

  /** Create schema / open handles. Must be idempotent. */
  init(): Promise<void>;

  put(record: MemoryRecord): Promise<MemoryRecord>;
  putMany(records: MemoryRecord[]): Promise<MemoryRecord[]>;
  get(namespace: string, id: string): Promise<MemoryRecord | null>;
  getMany(namespace: string, ids: string[]): Promise<MemoryRecord[]>;
  update(namespace: string, id: string, patch: MemoryPatch): Promise<MemoryRecord | null>;
  delete(namespace: string, id: string): Promise<boolean>;
  deleteMany(namespace: string, ids: string[]): Promise<number>;

  query(filter: MemoryFilter, options?: QueryOptions): Promise<MemoryRecord[]>;
  count(filter: MemoryFilter): Promise<number>;

  /** Exact-restatement lookup used to suppress duplicate writes. */
  findByFingerprint(namespace: string, fingerprint: string): Promise<MemoryRecord | null>;

  listNamespaces(): Promise<string[]>;
  /** Remove every record in a namespace, or in all of them. Returns the count. */
  clear(namespace?: string): Promise<number>;

  addLink(link: MemoryLink): Promise<MemoryLink>;
  listLinks(namespace: string, memoryId?: string): Promise<MemoryLink[]>;
  deleteLinksFor(namespace: string, memoryId: string): Promise<number>;

  close(): Promise<void>;
}

const DEFAULT_ORDER: MemoryOrderBy = 'createdAt';

/**
 * Shared predicate so every backend filters identically.
 *
 * `now` is injected rather than read from the clock so a query and the TTL
 * checks inside it see a single consistent instant.
 */
export function matchesFilter(
  record: MemoryRecord,
  filter: MemoryFilter,
  now: number = Date.now(),
): boolean {
  if (filter.namespace !== undefined && record.namespace !== filter.namespace) return false;
  if (filter.agentId !== undefined && record.agentId !== filter.agentId) return false;
  if (filter.kinds?.length && !filter.kinds.includes(record.kind)) return false;
  if (filter.sources?.length && !filter.sources.includes(record.source)) return false;
  if (filter.createdAfter !== undefined && record.createdAt < filter.createdAfter) return false;
  if (filter.createdBefore !== undefined && record.createdAt > filter.createdBefore) return false;
  if (filter.minImportance !== undefined && record.importance < filter.minImportance) return false;

  if (filter.tags?.length) {
    for (const tag of filter.tags) {
      if (!record.tags.includes(tag)) return false;
    }
  }
  if (filter.anyTags?.length && !filter.anyTags.some((tag) => record.tags.includes(tag))) {
    return false;
  }

  if (filter.excludeSuperseded !== false && record.supersededBy) return false;
  if (
    filter.excludeExpired !== false &&
    record.expiresAt !== undefined &&
    record.expiresAt <= now
  ) {
    return false;
  }
  return true;
}

/** Shared sort + pagination, applied after filtering. */
export function applyQueryOptions(
  records: MemoryRecord[],
  options: QueryOptions = {},
): MemoryRecord[] {
  const orderBy = options.orderBy ?? DEFAULT_ORDER;
  const sign = options.direction === 'asc' ? 1 : -1;
  const sorted = [...records].sort((a, b) => {
    const delta = (a[orderBy] ?? 0) - (b[orderBy] ?? 0);
    // Tie-break on id so pagination is stable across calls.
    return delta === 0 ? a.id.localeCompare(b.id) : delta * sign;
  });
  const offset = options.offset ?? 0;
  const limit = options.limit ?? sorted.length;
  return sorted.slice(offset, offset + limit);
}

/** Defensive copy so callers cannot mutate a store's internal state. */
export function cloneRecord(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    tags: [...record.tags],
    metadata: { ...record.metadata },
    ...(record.embedding ? { embedding: [...record.embedding] } : {}),
    ...(record.derivedFrom ? { derivedFrom: [...record.derivedFrom] } : {}),
  };
}
