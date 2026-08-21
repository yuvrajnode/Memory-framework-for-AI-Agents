import type { MemoryFilter, MemoryLink, MemoryRecord } from '../types.js';
import {
  applyQueryOptions,
  cloneRecord,
  matchesFilter,
  type MemoryPatch,
  type MemoryStore,
  type QueryOptions,
} from './types.js';

/**
 * Process-local store.
 *
 * The reference implementation and the default for tests, previews and
 * short-lived agent sessions. Records are keyed by `namespace/id`, with a
 * fingerprint index so duplicate detection stays O(1) instead of scanning.
 */
export class InMemoryStore implements MemoryStore {
  readonly id: string = 'in-memory';

  protected records = new Map<string, MemoryRecord>();
  protected fingerprints = new Map<string, string>();
  protected linkStore = new Map<string, MemoryLink>();

  async init(): Promise<void> {
    // Nothing to open.
  }

  protected key(namespace: string, id: string): string {
    return `${namespace}/${id}`;
  }

  protected fingerprintKey(namespace: string, fingerprint: string): string {
    return `${namespace}#${fingerprint}`;
  }

  async put(record: MemoryRecord): Promise<MemoryRecord> {
    const stored = cloneRecord(record);
    const existing = this.records.get(this.key(record.namespace, record.id));
    if (existing && existing.fingerprint !== stored.fingerprint) {
      this.fingerprints.delete(this.fingerprintKey(existing.namespace, existing.fingerprint));
    }
    this.records.set(this.key(stored.namespace, stored.id), stored);
    this.fingerprints.set(
      this.fingerprintKey(stored.namespace, stored.fingerprint),
      stored.id,
    );
    return cloneRecord(stored);
  }

  async putMany(records: MemoryRecord[]): Promise<MemoryRecord[]> {
    const result: MemoryRecord[] = [];
    for (const record of records) result.push(await this.put(record));
    return result;
  }

  async get(namespace: string, id: string): Promise<MemoryRecord | null> {
    const record = this.records.get(this.key(namespace, id));
    return record ? cloneRecord(record) : null;
  }

  async getMany(namespace: string, ids: string[]): Promise<MemoryRecord[]> {
    const result: MemoryRecord[] = [];
    for (const id of ids) {
      const record = this.records.get(this.key(namespace, id));
      if (record) result.push(cloneRecord(record));
    }
    return result;
  }

  async update(
    namespace: string,
    id: string,
    patch: MemoryPatch,
  ): Promise<MemoryRecord | null> {
    const existing = this.records.get(this.key(namespace, id));
    if (!existing) return null;
    const next: MemoryRecord = { ...existing, ...patch };
    return this.put(next);
  }

  async delete(namespace: string, id: string): Promise<boolean> {
    const existing = this.records.get(this.key(namespace, id));
    if (!existing) return false;
    this.records.delete(this.key(namespace, id));
    this.fingerprints.delete(this.fingerprintKey(namespace, existing.fingerprint));
    await this.deleteLinksFor(namespace, id);
    return true;
  }

  async deleteMany(namespace: string, ids: string[]): Promise<number> {
    let removed = 0;
    for (const id of ids) {
      if (await this.delete(namespace, id)) removed += 1;
    }
    return removed;
  }

  async query(filter: MemoryFilter, options?: QueryOptions): Promise<MemoryRecord[]> {
    const now = Date.now();
    const matched: MemoryRecord[] = [];
    for (const record of this.records.values()) {
      if (matchesFilter(record, filter, now)) matched.push(record);
    }
    return applyQueryOptions(matched, options).map(cloneRecord);
  }

  async count(filter: MemoryFilter): Promise<number> {
    const now = Date.now();
    let total = 0;
    for (const record of this.records.values()) {
      if (matchesFilter(record, filter, now)) total += 1;
    }
    return total;
  }

  async findByFingerprint(
    namespace: string,
    fingerprint: string,
  ): Promise<MemoryRecord | null> {
    const id = this.fingerprints.get(this.fingerprintKey(namespace, fingerprint));
    if (!id) return null;
    return this.get(namespace, id);
  }

  async listNamespaces(): Promise<string[]> {
    const namespaces = new Set<string>();
    for (const record of this.records.values()) namespaces.add(record.namespace);
    return [...namespaces].sort();
  }

  async clear(namespace?: string): Promise<number> {
    if (namespace === undefined) {
      const total = this.records.size;
      this.records.clear();
      this.fingerprints.clear();
      this.linkStore.clear();
      return total;
    }
    let removed = 0;
    for (const [key, record] of [...this.records]) {
      if (record.namespace !== namespace) continue;
      this.records.delete(key);
      this.fingerprints.delete(this.fingerprintKey(namespace, record.fingerprint));
      removed += 1;
    }
    for (const [key, link] of [...this.linkStore]) {
      if (link.namespace === namespace) this.linkStore.delete(key);
    }
    return removed;
  }

  async addLink(link: MemoryLink): Promise<MemoryLink> {
    this.linkStore.set(link.id, { ...link });
    return { ...link };
  }

  async listLinks(namespace: string, memoryId?: string): Promise<MemoryLink[]> {
    const result: MemoryLink[] = [];
    for (const link of this.linkStore.values()) {
      if (link.namespace !== namespace) continue;
      if (memoryId && link.fromId !== memoryId && link.toId !== memoryId) continue;
      result.push({ ...link });
    }
    return result.sort((a, b) => b.weight - a.weight);
  }

  async deleteLinksFor(namespace: string, memoryId: string): Promise<number> {
    let removed = 0;
    for (const [key, link] of [...this.linkStore]) {
      if (link.namespace !== namespace) continue;
      if (link.fromId !== memoryId && link.toId !== memoryId) continue;
      this.linkStore.delete(key);
      removed += 1;
    }
    return removed;
  }

  async close(): Promise<void> {
    // Nothing to close.
  }

  /** Total record count across every namespace. Handy in tests and metrics. */
  get size(): number {
    return this.records.size;
  }
}
