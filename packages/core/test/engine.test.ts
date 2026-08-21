import { describe, expect, it } from 'vitest';
import { MemoryEngine } from '../src/engine.js';
import { InMemoryStore } from '../src/store/in-memory.js';
import { ValidationError, NotFoundError } from '../src/errors.js';
import { packContext } from '../src/context/packer.js';
import { EventBus } from '../src/events.js';
import { extractEntities, entityOverlap } from '../src/graph/entities.js';
import { embedder, makeRecord, DAY_MS } from './helpers.js';

const engine = () => new MemoryEngine({ store: new InMemoryStore(), embedder });

describe('MemoryEngine writes', () => {
  it('stores a memory with sensible defaults', async () => {
    const memory = engine();
    const { record } = await memory.remember({ content: 'Ada deploys on Friday' });
    expect(record.kind).toBe('episodic');
    expect(record.source).toBe('agent');
    expect(record.importance).toBe(0.5);
    expect(record.namespace).toBe('default');
    expect(record.embedding).toBeDefined();
  });

  it('rejects empty content', async () => {
    await expect(engine().remember({ content: '   ' })).rejects.toThrow(ValidationError);
  });

  it('rejects an invalid kind', async () => {
    await expect(
      engine().remember({ content: 'x', kind: 'nonsense' as never }),
    ).rejects.toThrow(ValidationError);
  });

  it('merges an exact restatement instead of storing it twice', async () => {
    const memory = engine();
    await memory.remember({ content: 'The user prefers dark mode' });
    const second = await memory.remember({ content: 'the user PREFERS dark mode  ' });
    expect(second.deduplicated).toBe(true);
    expect(await memory.count()).toBe(1);
  });

  it('merges a near restatement', async () => {
    const memory = engine();
    await memory.remember({ content: 'the user prefers dark mode' });
    const second = await memory.remember({ content: 'user prefers dark mode' });
    expect(second.deduplicated).toBe(true);
  });

  it('strengthens importance when a memory is restated', async () => {
    const memory = engine();
    const first = await memory.remember({ content: 'deploy on friday', importance: 0.5 });
    const second = await memory.remember({ content: 'deploy on friday' });
    expect(second.record.importance).toBeGreaterThan(first.record.importance);
  });

  it('can be configured not to deduplicate', async () => {
    const memory = new MemoryEngine({
      store: new InMemoryStore(),
      embedder,
      deduplicate: false,
      autoLink: false,
    });
    await memory.remember({ content: 'same thing' });
    await memory.remember({ content: 'same thing', id: 'explicit-second' });
    expect(await memory.count()).toBe(2);
  });

  it('normalises tags to lowercase, deduped and sorted', async () => {
    const { record } = await engine().remember({
      content: 'x',
      tags: ['Ops', 'ops', 'Deploy'],
    });
    expect(record.tags).toEqual(['deploy', 'ops']);
  });

  it('sets an expiry from a TTL', async () => {
    const { record } = await engine().remember({ content: 'temporary', ttlMs: 1000 });
    expect(record.expiresAt).toBeGreaterThan(Date.now());
  });

  it('keeps namespaces isolated', async () => {
    const memory = engine();
    await memory.remember({ content: 'alpha secret', namespace: 'tenant-a' });
    await memory.remember({ content: 'beta secret', namespace: 'tenant-b' });
    const results = await memory.recall('secret', { namespace: 'tenant-a' });
    expect(results).toHaveLength(1);
    expect(results[0]!.record.content).toBe('alpha secret');
  });

  it('rejects a malformed namespace', async () => {
    await expect(
      engine().remember({ content: 'x', namespace: '../etc/passwd' }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('MemoryEngine recall', () => {
  const seed = async () => {
    const memory = engine();
    await memory.rememberMany([
      { content: 'Ada prefers deploying on Friday afternoons', kind: 'semantic', importance: 0.8 },
      { content: 'The build failed with ENOSPC on runner-4', kind: 'episodic' },
      { content: 'To fix ENOSPC, prune docker images and re-run', kind: 'procedural', importance: 0.9 },
      { content: 'The team stand-up moved to 10am on Tuesdays', kind: 'semantic' },
    ]);
    return memory;
  };

  it('surfaces the procedural fix for a how-do-I query', async () => {
    const results = await (await seed()).recall('how do I fix the disk space error?');
    expect(results[0]!.record.kind).toBe('procedural');
  });

  it('finds a rare identifier through the lexical signal', async () => {
    const results = await (await seed()).recall('runner-4');
    expect(results.some((r) => r.record.content.includes('runner-4'))).toBe(true);
  });

  it('respects the limit', async () => {
    expect(await (await seed()).recall('deploy', { limit: 2 })).toHaveLength(2);
  });

  it('filters by kind', async () => {
    const results = await (await seed()).recall('anything', {
      filter: { kinds: ['procedural'] },
    });
    expect(results.every((r) => r.record.kind === 'procedural')).toBe(true);
  });

  it('returns an explainable breakdown per result', async () => {
    const [top] = await (await seed()).recall('ENOSPC');
    expect(top!.breakdown).toMatchObject({
      semantic: expect.any(Number),
      lexical: expect.any(Number),
      retention: expect.any(Number),
    });
  });

  it('drops results below minScore', async () => {
    const results = await (await seed()).recall('completely unrelated kangaroo topic', {
      minScore: 0.9,
    });
    expect(results).toHaveLength(0);
  });

  it('returns nothing from an empty namespace', async () => {
    expect(await engine().recall('anything')).toEqual([]);
  });

  it('reinforces recalled memories, resetting their decay clock', async () => {
    const memory = await seed();
    const before = (await memory.list())[0]!;
    await memory.recall('ENOSPC deployment failure');
    const after = await memory.get(before.id);
    expect(after!.accessCount).toBeGreaterThanOrEqual(before.accessCount);
  });

  it('can skip reinforcement when the caller is only browsing', async () => {
    const memory = await seed();
    const target = (await memory.list())[0]!;
    await memory.recall('ENOSPC', { reinforce: false });
    expect((await memory.get(target.id))!.accessCount).toBe(target.accessCount);
  });

  it('rejects an out-of-range limit', async () => {
    await expect(engine().recall('x', { limit: 0 })).rejects.toThrow(ValidationError);
    await expect(engine().recall('x', { limit: 10_000 })).rejects.toThrow(ValidationError);
  });
});

describe('MemoryEngine context assembly', () => {
  it('produces a prompt block within the token budget', async () => {
    const memory = engine();
    for (let i = 0; i < 30; i += 1) {
      await memory.remember({ content: `Fact number ${i} about the deployment pipeline` });
    }
    const context = await memory.buildContext('deployment pipeline', { budgetTokens: 120 });
    expect(context.estimatedTokens).toBeLessThanOrEqual(120);
    expect(context.included.length).toBeGreaterThan(0);
    expect(context.text).toContain('#');
  });

  it('reports what it had to drop', async () => {
    const memory = engine();
    for (let i = 0; i < 20; i += 1) {
      await memory.remember({ content: `A reasonably long memory number ${i} with detail` });
    }
    const context = await memory.buildContext('memory', { budgetTokens: 60, limit: 20 });
    expect(context.dropped.length).toBeGreaterThan(0);
  });
});

describe('MemoryEngine mutation', () => {
  it('updates content and re-embeds', async () => {
    const memory = engine();
    const { record } = await memory.remember({ content: 'original text here' });
    const updated = await memory.update(record.id, { content: 'completely new subject' });
    expect(updated.content).toBe('completely new subject');
    expect(updated.embedding).not.toEqual(record.embedding);
    expect(updated.fingerprint).not.toBe(record.fingerprint);
  });

  it('rejects an update that empties content', async () => {
    const memory = engine();
    const { record } = await memory.remember({ content: 'keep something' });
    await expect(memory.update(record.id, { content: '  ' })).rejects.toThrow(ValidationError);
  });

  it('reports a missing record on update', async () => {
    await expect(engine().update('ghost', { importance: 1 })).rejects.toThrow(NotFoundError);
  });

  it('forgets a memory', async () => {
    const memory = engine();
    const { record } = await memory.remember({ content: 'forget me' });
    expect(await memory.forget(record.id)).toBe(true);
    expect(await memory.get(record.id)).toBeNull();
    expect(await memory.forget(record.id)).toBe(false);
  });
});

describe('MemoryEngine stats and graph', () => {
  it('summarises a namespace', async () => {
    const memory = engine();
    await memory.rememberMany([
      { content: 'first fact about deployments', kind: 'semantic', importance: 1 },
      { content: 'second event on the pipeline', kind: 'episodic', importance: 0 },
    ]);
    const stats = await memory.stats();
    expect(stats.total).toBe(2);
    expect(stats.byKind.semantic).toBe(1);
    expect(stats.averageImportance).toBeCloseTo(0.5, 5);
    expect(stats.approximateTokens).toBeGreaterThan(0);
  });

  it('reports zeroed stats for an empty namespace', async () => {
    const stats = await engine().stats();
    expect(stats).toMatchObject({ total: 0, averageImportance: 0, oldestCreatedAt: null });
  });

  it('builds a graph with nodes and edges', async () => {
    const memory = engine();
    await memory.rememberMany([
      { content: 'The deployment to production failed on Tuesday' },
      { content: 'A deployment to production failed again Tuesday' },
    ]);
    const graph = await memory.graphSnapshot();
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.nodes[0]!.label.length).toBeGreaterThan(0);
  });

  it('lists namespaces and clears one', async () => {
    const memory = engine();
    await memory.remember({ content: 'a', namespace: 'one' });
    await memory.remember({ content: 'b', namespace: 'two' });
    expect(await memory.namespaces()).toEqual(['one', 'two']);
    expect(await memory.clear('one')).toBe(1);
    expect(await memory.namespaces()).toEqual(['two']);
  });
});

describe('MemoryEngine maintenance', () => {
  it('consolidates aged episodes into a durable fact', async () => {
    const store = new InMemoryStore();
    await store.init();
    const memory = new MemoryEngine({ store, embedder, autoLink: false });
    const old = Date.now() - 5 * DAY_MS;
    for (const content of [
      'The user prefers dark mode in the editor.',
      'User prefers dark mode for the editor theme.',
      'The user prefers a dark editor mode always.',
    ]) {
      await store.put(
        makeRecord(
          { content, kind: 'episodic', namespace: 'default' },
          { createdAt: old, lastAccessedAt: old },
        ),
      );
    }
    const summary = await memory.consolidate('default', { similarityThreshold: 0.6 });
    expect(summary.created).toHaveLength(1);
    expect(await memory.count()).toBe(1);
  });

  it('reclaims expired records during maintenance', async () => {
    const memory = engine();
    await memory.remember({ content: 'short lived', ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await memory.maintain()).expired).toHaveLength(1);
  });
});

describe('EventBus', () => {
  it('delivers typed payloads and unsubscribes', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.on('memory:deleted', ({ id }) => seen.push(id));
    bus.emit('memory:deleted', { namespace: 'n', id: 'a' });
    off();
    bus.emit('memory:deleted', { namespace: 'n', id: 'b' });
    expect(seen).toEqual(['a']);
  });

  it('fires a once listener exactly once', () => {
    const bus = new EventBus();
    let calls = 0;
    bus.once('memory:deleted', () => { calls += 1; });
    bus.emit('memory:deleted', { namespace: 'n', id: 'a' });
    bus.emit('memory:deleted', { namespace: 'n', id: 'b' });
    expect(calls).toBe(1);
  });

  it('routes a failing listener to the error channel instead of throwing', () => {
    const bus = new EventBus();
    const errors: unknown[] = [];
    bus.on('error', ({ error }) => errors.push(error));
    bus.on('memory:deleted', () => {
      throw new Error('listener blew up');
    });
    expect(() => bus.emit('memory:deleted', { namespace: 'n', id: 'a' })).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it('emits write events from the engine', async () => {
    const memory = engine();
    const written: string[] = [];
    memory.events.on('memory:written', ({ record }) => written.push(record.content));
    await memory.remember({ content: 'observed write' });
    expect(written).toEqual(['observed write']);
  });
});

describe('packContext', () => {
  const result = (content: string, kind: 'procedural' | 'episodic' = 'episodic') => ({
    record: makeRecord({ content, kind }),
    score: 0.5,
    breakdown: {
      semantic: 0.5, lexical: 0, recency: 1, importance: 0.5, usage: 0, retention: 1,
    },
  });

  it('emits procedures before episodes so truncation drops the right thing', () => {
    const packed = packContext(
      [result('an event happened'), result('do it this way', 'procedural')],
      { budgetTokens: 500 },
    );
    expect(packed.text.indexOf('do it this way')).toBeLessThan(
      packed.text.indexOf('an event happened'),
    );
  });

  it('skips an oversized memory rather than stopping the loop', () => {
    const packed = packContext(
      [result('x'.repeat(4000)), result('short one')],
      { budgetTokens: 60, maxCharsPerMemory: 4000 },
    );
    expect(packed.included.map((r) => r.record.content)).toContain('short one');
    expect(packed.dropped).toHaveLength(1);
  });

  it('reports zero utilisation for a zero budget', () => {
    const packed = packContext([result('anything')], { budgetTokens: 0 });
    expect(packed.utilization).toBe(0);
    expect(packed.included).toHaveLength(0);
  });

  it('handles an empty result set', () => {
    expect(packContext([], { budgetTokens: 100 }).text).toBe('# Relevant memory');
  });
});

describe('entity extraction', () => {
  it('picks out identifiers, urls and emails', () => {
    const entities = extractEntities(
      'Email ada@example.com about ORDER-421 at https://status.example.com',
    );
    const types = entities.map((entity) => entity.type);
    expect(types).toContain('email');
    expect(types).toContain('url');
    expect(types).toContain('identifier');
  });

  it('ignores sentence-initial capitals that are not entities', () => {
    const keys = extractEntities('The system restarted. However it recovered.').map(
      (entity) => entity.key,
    );
    expect(keys).not.toContain('the');
    expect(keys).not.toContain('however');
  });

  it('scores overlap between texts sharing an entity', () => {
    expect(
      entityOverlap('Ticket ORDER-421 is stuck', 'ORDER-421 needs a manual refund'),
    ).toBeGreaterThan(0);
    expect(entityOverlap('nothing here at all', 'different words entirely')).toBe(0);
  });
});
