import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStore } from '../src/store/in-memory.js';
import { JsonFileStore } from '../src/store/json-file.js';
import { SqliteStore } from '../src/store/sqlite.js';
import type { MemoryStore } from '../src/store/types.js';
import { matchesFilter } from '../src/store/types.js';
import { makeRecord, DAY_MS } from './helpers.js';

/**
 * Every backend runs the identical suite. The point of the shared predicate
 * is that swapping a store cannot change what a query returns, and this is
 * the test that holds that promise honest.
 */
function behavesLikeAStore(name: string, create: () => Promise<MemoryStore>) {
  describe(name, () => {
    let store: MemoryStore;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      store = await create();
      await store.init();
    });

    afterEach(async () => {
      await store.close();
      await cleanup?.();
    });

    it('round-trips a record', async () => {
      const record = makeRecord({ content: 'deploy on friday', tags: ['ops'] });
      await store.put(record);
      const loaded = await store.get('test', record.id);
      expect(loaded?.content).toBe('deploy on friday');
      expect(loaded?.tags).toEqual(['ops']);
      expect(loaded?.embedding).toHaveLength(128);
    });

    it('returns null for a missing record', async () => {
      expect(await store.get('test', 'nope')).toBeNull();
    });

    it('isolates namespaces', async () => {
      await store.put(makeRecord({ content: 'alpha', namespace: 'a' }));
      await store.put(makeRecord({ content: 'beta', namespace: 'b' }));
      expect(await store.count({ namespace: 'a' })).toBe(1);
      expect((await store.query({ namespace: 'b' }))[0]?.content).toBe('beta');
    });

    it('upserts rather than duplicating on the same id', async () => {
      const record = makeRecord({ content: 'first' });
      await store.put(record);
      await store.put({ ...record, content: 'second', fingerprint: 'other' });
      expect(await store.count({ namespace: 'test' })).toBe(1);
      expect((await store.get('test', record.id))?.content).toBe('second');
    });

    it('finds a record by fingerprint', async () => {
      const record = makeRecord({ content: 'unique content here' });
      await store.put(record);
      const found = await store.findByFingerprint('test', record.fingerprint);
      expect(found?.id).toBe(record.id);
    });

    it('keeps both records when two share a content fingerprint', async () => {
      // Distinct memories can legitimately collide: a consolidation summary
      // may land on text identical to an episode, or the same sentence may be
      // filed under two kinds. Deduplication is the engine's decision, made
      // before the write — the store must not silently drop one.
      const first = makeRecord({ content: 'user prefers dark mode', kind: 'episodic' });
      const second = makeRecord({ content: 'user prefers dark mode', kind: 'semantic' });
      expect(first.fingerprint).toBe(second.fingerprint);

      await store.put({ ...first, createdAt: 1000 });
      await store.put({ ...second, createdAt: 2000 });

      expect(await store.count({ namespace: 'test' })).toBe(2);
    });

    it('resolves a fingerprint collision to the oldest record', async () => {
      const first = makeRecord({ content: 'colliding content here' });
      const second = makeRecord({ content: 'colliding content here' });
      await store.put({ ...second, createdAt: 2000 });
      await store.put({ ...first, createdAt: 1000 });

      const found = await store.findByFingerprint('test', first.fingerprint);
      expect(found?.id).toBe(first.id);
    });

    it('stops matching a fingerprint once its record is deleted', async () => {
      const record = makeRecord({ content: 'transient content' });
      await store.put(record);
      await store.delete('test', record.id);
      expect(await store.findByFingerprint('test', record.fingerprint)).toBeNull();
    });

    it('reindexes the fingerprint when content is rewritten', async () => {
      const record = makeRecord({ content: 'before the edit' });
      await store.put(record);
      const rewritten = makeRecord({ content: 'after the edit' });
      await store.put({ ...record, content: rewritten.content, fingerprint: rewritten.fingerprint });

      expect(await store.findByFingerprint('test', record.fingerprint)).toBeNull();
      expect((await store.findByFingerprint('test', rewritten.fingerprint))?.id).toBe(record.id);
    });

    it('requires every tag when filtering by tags', async () => {
      await store.put(makeRecord({ content: 'both', tags: ['a', 'b'] }));
      await store.put(makeRecord({ content: 'one', tags: ['a'] }));
      expect(await store.count({ namespace: 'test', tags: ['a', 'b'] })).toBe(1);
      expect(await store.count({ namespace: 'test', anyTags: ['a', 'b'] })).toBe(2);
    });

    it('hides expired records unless asked for them', async () => {
      await store.put(
        makeRecord({ content: 'ephemeral' }, { expiresAt: Date.now() - 1000 }),
      );
      expect(await store.count({ namespace: 'test' })).toBe(0);
      expect(
        await store.count({ namespace: 'test', excludeExpired: false }),
      ).toBe(1);
    });

    it('hides superseded records unless asked for them', async () => {
      await store.put(makeRecord({ content: 'old fact' }, { supersededBy: 'mem_new' }));
      expect(await store.count({ namespace: 'test' })).toBe(0);
      expect(
        await store.count({ namespace: 'test', excludeSuperseded: false }),
      ).toBe(1);
    });

    it('filters by kind, source, importance and creation window', async () => {
      const now = Date.now();
      await store.put(
        makeRecord({ content: 'a', kind: 'semantic', source: 'user', importance: 0.9 }),
      );
      await store.put(
        makeRecord(
          { content: 'b', kind: 'episodic', source: 'tool', importance: 0.2 },
          { createdAt: now - 10 * DAY_MS },
        ),
      );
      expect(await store.count({ namespace: 'test', kinds: ['semantic'] })).toBe(1);
      expect(await store.count({ namespace: 'test', sources: ['tool'] })).toBe(1);
      expect(await store.count({ namespace: 'test', minImportance: 0.5 })).toBe(1);
      expect(
        await store.count({ namespace: 'test', createdAfter: now - DAY_MS }),
      ).toBe(1);
    });

    it('sorts and paginates deterministically', async () => {
      for (let i = 0; i < 5; i += 1) {
        await store.put(makeRecord({ content: `note ${i}`, importance: i / 10 }));
      }
      const page = await store.query(
        { namespace: 'test' },
        { orderBy: 'importance', direction: 'desc', limit: 2 },
      );
      expect(page).toHaveLength(2);
      expect(page[0]!.importance).toBeGreaterThan(page[1]!.importance);

      const second = await store.query(
        { namespace: 'test' },
        { orderBy: 'importance', direction: 'desc', limit: 2, offset: 2 },
      );
      expect(second[0]!.id).not.toBe(page[0]!.id);
    });

    it('patches only the requested fields', async () => {
      const record = makeRecord({ content: 'keep me', tags: ['x'] });
      await store.put(record);
      const updated = await store.update('test', record.id, { importance: 0.95 });
      expect(updated?.importance).toBe(0.95);
      expect(updated?.content).toBe('keep me');
      expect(updated?.tags).toEqual(['x']);
    });

    it('reports a miss when updating an unknown record', async () => {
      expect(await store.update('test', 'ghost', { importance: 1 })).toBeNull();
    });

    it('deletes records and their edges together', async () => {
      const a = makeRecord({ content: 'node a' });
      const b = makeRecord({ content: 'node b' });
      await store.putMany([a, b]);
      await store.addLink({
        id: 'lnk_1',
        namespace: 'test',
        fromId: a.id,
        toId: b.id,
        relation: 'similar-to',
        weight: 0.9,
        createdAt: Date.now(),
      });
      expect(await store.listLinks('test')).toHaveLength(1);
      expect(await store.delete('test', a.id)).toBe(true);
      expect(await store.listLinks('test')).toHaveLength(0);
      expect(await store.delete('test', a.id)).toBe(false);
    });

    it('lists links touching either endpoint', async () => {
      await store.addLink({
        id: 'lnk_2',
        namespace: 'test',
        fromId: 'x',
        toId: 'y',
        relation: 'mentions-same',
        weight: 0.5,
        createdAt: Date.now(),
      });
      expect(await store.listLinks('test', 'y')).toHaveLength(1);
      expect(await store.listLinks('test', 'z')).toHaveLength(0);
    });

    it('clears a single namespace without touching others', async () => {
      await store.put(makeRecord({ content: 'keep', namespace: 'keep' }));
      await store.put(makeRecord({ content: 'drop', namespace: 'drop' }));
      expect(await store.clear('drop')).toBe(1);
      expect(await store.count({ namespace: 'keep' })).toBe(1);
    });

    it('enumerates namespaces', async () => {
      await store.put(makeRecord({ content: 'a', namespace: 'zeta' }));
      await store.put(makeRecord({ content: 'b', namespace: 'alpha' }));
      expect(await store.listNamespaces()).toEqual(['alpha', 'zeta']);
    });
  });
}

behavesLikeAStore('InMemoryStore', async () => new InMemoryStore());
behavesLikeAStore('SqliteStore', async () => new SqliteStore({ path: ':memory:' }));

describe('JsonFileStore', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mnemos-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('survives a restart', async () => {
    const path = join(directory, 'memory.json');
    const first = new JsonFileStore({ path, flushIntervalMs: 0 });
    await first.init();
    const record = makeRecord({ content: 'persisted across restarts' });
    await first.put(record);
    await first.addLink({
      id: 'lnk_p',
      namespace: 'test',
      fromId: record.id,
      toId: 'other',
      relation: 'similar-to',
      weight: 1,
      createdAt: Date.now(),
    });
    await first.close();

    const second = new JsonFileStore({ path });
    await second.init();
    expect((await second.get('test', record.id))?.content).toBe(
      'persisted across restarts',
    );
    expect(await second.listLinks('test')).toHaveLength(1);
    await second.close();
  });

  it('serialises concurrent flushes instead of racing on the temp file', async () => {
    const path = join(directory, 'concurrent.json');
    const store = new JsonFileStore({ path, flushIntervalMs: 0 });
    await store.init();
    // Each write schedules a flush immediately; before these were chained,
    // the first rename moved the shared temp file away and the second failed
    // with ENOENT.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.put(makeRecord({ content: `concurrent write ${i}` })),
      ),
    );
    await store.flush();
    await store.close();

    const reloaded = new JsonFileStore({ path });
    await reloaded.init();
    expect(await reloaded.count({ namespace: 'test' })).toBe(25);
    await reloaded.close();
  });

  it('starts empty when no snapshot exists yet', async () => {
    const store = new JsonFileStore({ path: join(directory, 'nested', 'new.json') });
    await store.init();
    expect(await store.count({})).toBe(0);
    await store.close();
  });
});

describe('matchesFilter', () => {
  it('treats an empty filter as matching everything', () => {
    expect(matchesFilter(makeRecord({ content: 'anything' }), {})).toBe(true);
  });

  it('uses the injected clock for TTL checks', () => {
    const record = makeRecord({ content: 'x' }, { expiresAt: 1_000 });
    expect(matchesFilter(record, {}, 999)).toBe(true);
    expect(matchesFilter(record, {}, 1_001)).toBe(false);
  });
});
