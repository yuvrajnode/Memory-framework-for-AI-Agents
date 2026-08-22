import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StoreError } from '../errors.js';
import type { MemoryLink, MemoryRecord } from '../types.js';
import { InMemoryStore } from './in-memory.js';
import type { MemoryPatch } from './types.js';

interface Snapshot {
  version: 1;
  savedAt: number;
  records: MemoryRecord[];
  links: MemoryLink[];
}

export interface JsonFileStoreOptions {
  /** Path to the snapshot file. Parent directories are created on demand. */
  path: string;
  /**
   * Coalesce writes for this many milliseconds. A burst of ingests then costs
   * one disk write instead of one per record. Set 0 to persist synchronously.
   */
  flushIntervalMs?: number;
}

/**
 * Durable single-file store.
 *
 * Keeps the whole namespace in memory for query speed and mirrors it to a
 * JSON snapshot on disk. Writes go to a temp file and are then renamed, which
 * is atomic on POSIX, so a crash mid-write leaves the previous snapshot
 * intact rather than a half-written file.
 *
 * The right choice for single-node deployments and local development; reach
 * for {@link SqliteStore} once the working set outgrows memory.
 */
export class JsonFileStore extends InMemoryStore {
  override readonly id = 'json-file';

  private readonly path: string;
  private readonly flushIntervalMs: number;
  private flushTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  /**
   * Serialises writes. Two flushes overlapping would race on the temp file —
   * the first rename moves it away and the second finds nothing there — so
   * every flush is chained behind the one before it.
   */
  private writeChain: Promise<void> = Promise.resolve();
  private writeCounter = 0;

  constructor(options: JsonFileStoreOptions) {
    super();
    this.path = options.path;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
  }

  override async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new StoreError(`Could not read snapshot at ${this.path}`, {
        cause: String(error),
      });
    }

    try {
      const snapshot = JSON.parse(raw) as Snapshot;
      for (const record of snapshot.records ?? []) {
        await super.put(record);
      }
      for (const link of snapshot.links ?? []) {
        await super.addLink(link);
      }
    } catch (error) {
      throw new StoreError(`Snapshot at ${this.path} is corrupt`, {
        cause: String(error),
      });
    }
    this.dirty = false;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushIntervalMs === 0) {
      void this.flush().catch(() => undefined);
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch(() => undefined);
    }, this.flushIntervalMs);
    // A pending snapshot must never hold the process open on its own.
    this.flushTimer.unref?.();
  }

  /**
   * Write the current state to disk. Safe to call at any time, and safe to
   * call concurrently — overlapping calls queue rather than collide.
   */
  async flush(): Promise<void> {
    this.writeChain = this.writeChain.then(
      () => this.writeSnapshot(),
      () => this.writeSnapshot(),
    );
    return this.writeChain;
  }

  private async writeSnapshot(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const snapshot: Snapshot = {
      version: 1,
      savedAt: Date.now(),
      records: [...this.records.values()],
      links: [...this.linkStore.values()],
    };
    // The counter keeps concurrent processes and retries from sharing a temp
    // path even though the chain already serialises this instance's writes.
    this.writeCounter += 1;
    const temp = `${this.path}.${process.pid}.${this.writeCounter}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temp, JSON.stringify(snapshot), 'utf8');
      await rename(temp, this.path);
    } catch (error) {
      // Leave the store dirty so the next mutation retries the write.
      this.dirty = true;
      await rm(temp, { force: true }).catch(() => undefined);
      throw new StoreError(`Could not persist snapshot to ${this.path}`, {
        cause: String(error),
      });
    }
  }

  override async put(record: MemoryRecord): Promise<MemoryRecord> {
    const result = await super.put(record);
    this.markDirty();
    return result;
  }

  override async update(
    namespace: string,
    id: string,
    patch: MemoryPatch,
  ): Promise<MemoryRecord | null> {
    const result = await super.update(namespace, id, patch);
    if (result) this.markDirty();
    return result;
  }

  override async delete(namespace: string, id: string): Promise<boolean> {
    const result = await super.delete(namespace, id);
    if (result) this.markDirty();
    return result;
  }

  override async clear(namespace?: string): Promise<number> {
    const result = await super.clear(namespace);
    this.markDirty();
    return result;
  }

  override async addLink(link: MemoryLink): Promise<MemoryLink> {
    const result = await super.addLink(link);
    this.markDirty();
    return result;
  }

  override async deleteLinksFor(namespace: string, memoryId: string): Promise<number> {
    const result = await super.deleteLinksFor(namespace, memoryId);
    if (result > 0) this.markDirty();
    return result;
  }

  override async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Waits for any in-flight write, then persists whatever is still dirty.
    await this.flush();
  }
}
