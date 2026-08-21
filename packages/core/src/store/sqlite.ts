import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { StoreError } from '../errors.js';
import type { MemoryFilter, MemoryLink, MemoryRecord } from '../types.js';
import {
  applyQueryOptions,
  matchesFilter,
  type MemoryPatch,
  type MemoryStore,
  type QueryOptions,
} from './types.js';

/** Minimal structural types for `node:sqlite`, so the import stays optional. */
interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteStoreOptions {
  /** File path, or ":memory:" for an ephemeral database. */
  path: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id             TEXT NOT NULL,
  namespace      TEXT NOT NULL,
  agent_id       TEXT,
  kind           TEXT NOT NULL,
  source         TEXT NOT NULL,
  content        TEXT NOT NULL,
  embedding      TEXT,
  tags           TEXT NOT NULL DEFAULT '[]',
  metadata       TEXT NOT NULL DEFAULT '{}',
  importance     REAL NOT NULL DEFAULT 0.5,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_access_at INTEGER NOT NULL,
  access_count   INTEGER NOT NULL DEFAULT 0,
  expires_at     INTEGER,
  derived_from   TEXT,
  superseded_by  TEXT,
  fingerprint    TEXT NOT NULL,
  PRIMARY KEY (namespace, id)
);

CREATE INDEX IF NOT EXISTS idx_memories_ns_created ON memories (namespace, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_ns_kind    ON memories (namespace, kind);
CREATE INDEX IF NOT EXISTS idx_memories_ns_agent   ON memories (namespace, agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_expires    ON memories (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_fingerprint
  ON memories (namespace, fingerprint);

CREATE TABLE IF NOT EXISTS links (
  id         TEXT PRIMARY KEY,
  namespace  TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  relation   TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_links_from ON links (namespace, from_id);
CREATE INDEX IF NOT EXISTS idx_links_to   ON links (namespace, to_id);
`;

const COLUMNS = `id, namespace, agent_id, kind, source, content, embedding, tags, metadata,
  importance, created_at, updated_at, last_access_at, access_count, expires_at,
  derived_from, superseded_by, fingerprint`;

/**
 * SQLite-backed store using Node's built-in `node:sqlite` driver.
 *
 * Chosen over `better-sqlite3` so the package installs with zero native
 * build steps — important for containers and serverless images. The driver is
 * imported dynamically so environments without it fail with an actionable
 * message at `init()` rather than at module load.
 *
 * Hard filters that SQL expresses well (namespace, kind, time, importance)
 * are pushed into the query; tag matching and TTL semantics are applied in
 * TypeScript through the shared predicate, so results are identical to every
 * other backend.
 */
export class SqliteStore implements MemoryStore {
  readonly id = 'sqlite';

  private db: SqliteDatabase | null = null;
  private readonly path: string;

  constructor(options: SqliteStoreOptions) {
    this.path = options.path;
  }

  async init(): Promise<void> {
    if (this.db) return;
    if (this.path !== ':memory:') {
      await mkdir(dirname(this.path), { recursive: true });
    }
    // Loaded through createRequire rather than a static or dynamic import:
    // bundlers routinely fail to resolve `node:sqlite` (it postdates their
    // builtin lists) and would otherwise break the build of any app that
    // merely imports this module without using it.
    let DatabaseSync: new (path: string) => SqliteDatabase;
    try {
      const require = createRequire(import.meta.url);
      ({ DatabaseSync } = require('node:sqlite') as {
        DatabaseSync: new (path: string) => SqliteDatabase;
      });
    } catch (error) {
      throw new StoreError(
        'node:sqlite is unavailable. Use Node 22.5+ or switch to the json-file store.',
        { cause: String(error) },
      );
    }
    this.db = new DatabaseSync(this.path);
    // WAL keeps readers from blocking the ingest path; NORMAL sync is the
    // usual durability/throughput tradeoff for a WAL database.
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  private get handle(): SqliteDatabase {
    if (!this.db) throw new StoreError('SqliteStore.init() must be awaited before use');
    return this.db;
  }

  async put(record: MemoryRecord): Promise<MemoryRecord> {
    // A rewritten record may collide with another row's fingerprint; clearing
    // the stale row first keeps the unique index and dedup semantics aligned.
    this.handle
      .prepare('DELETE FROM memories WHERE namespace = ? AND fingerprint = ? AND id <> ?')
      .run(record.namespace, record.fingerprint, record.id);

    this.handle
      .prepare(
        `INSERT INTO memories (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (namespace, id) DO UPDATE SET
           agent_id = excluded.agent_id,
           kind = excluded.kind,
           source = excluded.source,
           content = excluded.content,
           embedding = excluded.embedding,
           tags = excluded.tags,
           metadata = excluded.metadata,
           importance = excluded.importance,
           updated_at = excluded.updated_at,
           last_access_at = excluded.last_access_at,
           access_count = excluded.access_count,
           expires_at = excluded.expires_at,
           derived_from = excluded.derived_from,
           superseded_by = excluded.superseded_by,
           fingerprint = excluded.fingerprint`,
      )
      .run(
        record.id,
        record.namespace,
        record.agentId ?? null,
        record.kind,
        record.source,
        record.content,
        record.embedding ? JSON.stringify(record.embedding) : null,
        JSON.stringify(record.tags),
        JSON.stringify(record.metadata),
        record.importance,
        record.createdAt,
        record.updatedAt,
        record.lastAccessedAt,
        record.accessCount,
        record.expiresAt ?? null,
        record.derivedFrom ? JSON.stringify(record.derivedFrom) : null,
        record.supersededBy ?? null,
        record.fingerprint,
      );
    return record;
  }

  async putMany(records: MemoryRecord[]): Promise<MemoryRecord[]> {
    if (records.length === 0) return [];
    this.handle.exec('BEGIN');
    try {
      for (const record of records) await this.put(record);
      this.handle.exec('COMMIT');
    } catch (error) {
      this.handle.exec('ROLLBACK');
      throw new StoreError('Batch write failed and was rolled back', {
        cause: String(error),
      });
    }
    return records;
  }

  async get(namespace: string, id: string): Promise<MemoryRecord | null> {
    const row = this.handle
      .prepare(`SELECT ${COLUMNS} FROM memories WHERE namespace = ? AND id = ?`)
      .get(namespace, id);
    return row ? rowToRecord(row) : null;
  }

  async getMany(namespace: string, ids: string[]): Promise<MemoryRecord[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.handle
      .prepare(
        `SELECT ${COLUMNS} FROM memories WHERE namespace = ? AND id IN (${placeholders})`,
      )
      .all(namespace, ...ids);
    return rows.map(rowToRecord);
  }

  async update(
    namespace: string,
    id: string,
    patch: MemoryPatch,
  ): Promise<MemoryRecord | null> {
    const existing = await this.get(namespace, id);
    if (!existing) return null;
    return this.put({ ...existing, ...patch });
  }

  async delete(namespace: string, id: string): Promise<boolean> {
    await this.deleteLinksFor(namespace, id);
    const result = this.handle
      .prepare('DELETE FROM memories WHERE namespace = ? AND id = ?')
      .run(namespace, id);
    return Number(result.changes) > 0;
  }

  async deleteMany(namespace: string, ids: string[]): Promise<number> {
    let removed = 0;
    for (const id of ids) {
      if (await this.delete(namespace, id)) removed += 1;
    }
    return removed;
  }

  /** Translate the SQL-expressible part of a filter into a WHERE clause. */
  private buildWhere(filter: MemoryFilter): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.namespace !== undefined) {
      clauses.push('namespace = ?');
      params.push(filter.namespace);
    }
    if (filter.agentId !== undefined) {
      clauses.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.kinds?.length) {
      clauses.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`);
      params.push(...filter.kinds);
    }
    if (filter.sources?.length) {
      clauses.push(`source IN (${filter.sources.map(() => '?').join(', ')})`);
      params.push(...filter.sources);
    }
    if (filter.createdAfter !== undefined) {
      clauses.push('created_at >= ?');
      params.push(filter.createdAfter);
    }
    if (filter.createdBefore !== undefined) {
      clauses.push('created_at <= ?');
      params.push(filter.createdBefore);
    }
    if (filter.minImportance !== undefined) {
      clauses.push('importance >= ?');
      params.push(filter.minImportance);
    }
    if (filter.excludeSuperseded !== false) {
      clauses.push('superseded_by IS NULL');
    }
    if (filter.excludeExpired !== false) {
      clauses.push('(expires_at IS NULL OR expires_at > ?)');
      params.push(Date.now());
    }
    return {
      sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  }

  async query(filter: MemoryFilter, options?: QueryOptions): Promise<MemoryRecord[]> {
    const { sql, params } = this.buildWhere(filter);
    const rows = this.handle.prepare(`SELECT ${COLUMNS} FROM memories${sql}`).all(...params);
    const now = Date.now();
    const records = rows.map(rowToRecord).filter((record) => matchesFilter(record, filter, now));
    return applyQueryOptions(records, options);
  }

  async count(filter: MemoryFilter): Promise<number> {
    // Tag filters are not expressible in the WHERE clause, so counting with
    // them present has to go through the shared predicate.
    if (filter.tags?.length || filter.anyTags?.length) {
      return (await this.query(filter)).length;
    }
    const { sql, params } = this.buildWhere(filter);
    const row = this.handle
      .prepare(`SELECT COUNT(*) AS total FROM memories${sql}`)
      .get(...params);
    return Number(row?.['total'] ?? 0);
  }

  async findByFingerprint(
    namespace: string,
    fingerprint: string,
  ): Promise<MemoryRecord | null> {
    const row = this.handle
      .prepare(`SELECT ${COLUMNS} FROM memories WHERE namespace = ? AND fingerprint = ?`)
      .get(namespace, fingerprint);
    return row ? rowToRecord(row) : null;
  }

  async listNamespaces(): Promise<string[]> {
    const rows = this.handle
      .prepare('SELECT DISTINCT namespace FROM memories ORDER BY namespace')
      .all();
    return rows.map((row) => String(row['namespace']));
  }

  async clear(namespace?: string): Promise<number> {
    if (namespace === undefined) {
      const result = this.handle.prepare('DELETE FROM memories').run();
      this.handle.prepare('DELETE FROM links').run();
      return Number(result.changes);
    }
    const result = this.handle
      .prepare('DELETE FROM memories WHERE namespace = ?')
      .run(namespace);
    this.handle.prepare('DELETE FROM links WHERE namespace = ?').run(namespace);
    return Number(result.changes);
  }

  async addLink(link: MemoryLink): Promise<MemoryLink> {
    this.handle
      .prepare(
        `INSERT INTO links (id, namespace, from_id, to_id, relation, weight, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET weight = excluded.weight`,
      )
      .run(
        link.id,
        link.namespace,
        link.fromId,
        link.toId,
        link.relation,
        link.weight,
        link.createdAt,
      );
    return link;
  }

  async listLinks(namespace: string, memoryId?: string): Promise<MemoryLink[]> {
    const rows = memoryId
      ? this.handle
          .prepare(
            'SELECT * FROM links WHERE namespace = ? AND (from_id = ? OR to_id = ?) ORDER BY weight DESC',
          )
          .all(namespace, memoryId, memoryId)
      : this.handle
          .prepare('SELECT * FROM links WHERE namespace = ? ORDER BY weight DESC')
          .all(namespace);
    return rows.map(rowToLink);
  }

  async deleteLinksFor(namespace: string, memoryId: string): Promise<number> {
    const result = this.handle
      .prepare('DELETE FROM links WHERE namespace = ? AND (from_id = ? OR to_id = ?)')
      .run(namespace, memoryId, memoryId);
    return Number(result.changes);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  const record: MemoryRecord = {
    id: String(row['id']),
    namespace: String(row['namespace']),
    kind: String(row['kind']) as MemoryRecord['kind'],
    source: String(row['source']) as MemoryRecord['source'],
    content: String(row['content']),
    tags: parseJson<string[]>(row['tags'], []),
    metadata: parseJson<MemoryRecord['metadata']>(row['metadata'], {}),
    importance: Number(row['importance']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    lastAccessedAt: Number(row['last_access_at']),
    accessCount: Number(row['access_count']),
    fingerprint: String(row['fingerprint']),
  };
  if (row['agent_id'] != null) record.agentId = String(row['agent_id']);
  if (row['embedding'] != null) record.embedding = parseJson<number[]>(row['embedding'], []);
  if (row['expires_at'] != null) record.expiresAt = Number(row['expires_at']);
  if (row['derived_from'] != null) {
    record.derivedFrom = parseJson<string[]>(row['derived_from'], []);
  }
  if (row['superseded_by'] != null) record.supersededBy = String(row['superseded_by']);
  return record;
}

function rowToLink(row: Record<string, unknown>): MemoryLink {
  return {
    id: String(row['id']),
    namespace: String(row['namespace']),
    fromId: String(row['from_id']),
    toId: String(row['to_id']),
    relation: String(row['relation']),
    weight: Number(row['weight']),
    createdAt: Number(row['created_at']),
  };
}
