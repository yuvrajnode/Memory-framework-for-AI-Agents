import { describe, expect, it } from 'vitest';
import { DecayModel, DEFAULT_DECAY_PROFILE } from '../src/pipeline/decay.js';
import { clusterRecords, recordSimilarity } from '../src/pipeline/clustering.js';
import { ExtractiveSummarizer, LlmSummarizer } from '../src/pipeline/summarizer.js';
import { Consolidator } from '../src/pipeline/consolidation.js';
import { MaintenanceRunner } from '../src/pipeline/maintenance.js';
import { InMemoryStore } from '../src/store/in-memory.js';
import { DAY_MS, embedder, makeRecord } from './helpers.js';

describe('DecayModel', () => {
  const decay = new DecayModel();
  const now = Date.now();

  it('reports full retention for a record just written', () => {
    expect(decay.retention(makeRecord({ content: 'fresh' }), now)).toBeCloseTo(1, 3);
  });

  it('halves retention after exactly one half-life', () => {
    // importance 0 and no accesses, so the effective half-life is the base
    // profile value with no boosts applied.
    const age = DEFAULT_DECAY_PROFILE.episodic;
    const record = makeRecord(
      { content: 'aging', importance: 0 },
      { createdAt: now - age, lastAccessedAt: now - age },
    );
    expect(decay.retention(record, now)).toBeCloseTo(0.5, 2);
  });

  it('applies the importance boost on top of the base half-life', () => {
    const age = DEFAULT_DECAY_PROFILE.episodic;
    const neutral = makeRecord(
      { content: 'aging', importance: 0 },
      { createdAt: now - age, lastAccessedAt: now - age },
    );
    const salient = makeRecord(
      { content: 'aging', importance: 1 },
      { createdAt: now - age, lastAccessedAt: now - age },
    );
    // A maximally important record gets double the half-life, so after one
    // base half-life it is still at 2^-0.5 rather than 0.5.
    expect(decay.retention(salient, now)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(decay.retention(salient, now)).toBeGreaterThan(decay.retention(neutral, now));
  });

  it('keeps procedural memories far longer than working memory', () => {
    const age = 30 * DAY_MS;
    const procedural = makeRecord(
      { content: 'how to', kind: 'procedural' },
      { createdAt: now - age, lastAccessedAt: now - age },
    );
    const working = makeRecord(
      { content: 'scratch', kind: 'working' },
      { createdAt: now - age, lastAccessedAt: now - age },
    );
    expect(decay.retention(procedural, now)).toBeGreaterThan(
      decay.retention(working, now) * 10,
    );
  });

  it('extends the half-life for important records', () => {
    const important = makeRecord({ content: 'x', importance: 1 });
    const trivial = makeRecord({ content: 'y', importance: 0 });
    expect(decay.halfLifeFor(important)).toBeGreaterThan(decay.halfLifeFor(trivial));
  });

  it('models the spacing effect: repeated recall extends retention', () => {
    const age = 14 * DAY_MS;
    const rehearsed = makeRecord(
      { content: 'x' },
      { createdAt: now - age, lastAccessedAt: now - age, accessCount: 20 },
    );
    const ignored = makeRecord(
      { content: 'y' },
      { createdAt: now - age, lastAccessedAt: now - age, accessCount: 0 },
    );
    expect(decay.retention(rehearsed, now)).toBeGreaterThan(decay.retention(ignored, now));
  });

  it('measures age from last access, so recall resets the clock', () => {
    const old = now - 60 * DAY_MS;
    const recalled = makeRecord({ content: 'x' }, { createdAt: old, lastAccessedAt: now });
    expect(decay.retention(recalled, now)).toBeCloseTo(1, 3);
  });

  it('never decays below the configured floor', () => {
    const ancient = makeRecord(
      { content: 'x', kind: 'working' },
      { createdAt: 0, lastAccessedAt: 0 },
    );
    expect(decay.retention(ancient, now)).toBeGreaterThanOrEqual(0.02);
  });

  it('projects when a record will reach a target retention', () => {
    const record = makeRecord({ content: 'x' });
    const projected = decay.projectedTime(record, 0.5, now);
    expect(decay.retention(record, projected)).toBeCloseTo(0.5, 2);
  });

  it('flags stale records against a threshold', () => {
    const cold = makeRecord(
      { content: 'x', kind: 'working' },
      { createdAt: now - 30 * DAY_MS, lastAccessedAt: now - 30 * DAY_MS },
    );
    expect(decay.isStale(cold, 0.1, now)).toBe(true);
    expect(decay.isStale(makeRecord({ content: 'y' }), 0.1, now)).toBe(false);
  });
});

describe('clusterRecords', () => {
  it('groups paraphrases and leaves outliers alone', () => {
    const records = [
      makeRecord({ content: 'the user prefers dark mode in the editor' }),
      makeRecord({ content: 'user prefers dark mode for the editor theme' }),
      makeRecord({ content: 'the user prefers a dark editor mode' }),
      makeRecord({ content: 'the invoice for march is overdue by ten days' }),
    ];
    const clusters = clusterRecords(records, { threshold: 0.7, minSize: 2 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });

  it('discards clusters below the minimum size', () => {
    const records = [
      makeRecord({ content: 'alpha unrelated topic entirely' }),
      makeRecord({ content: 'beta different subject matter' }),
    ];
    expect(clusterRecords(records, { threshold: 0.9, minSize: 2 })).toHaveLength(0);
  });

  it('splits an oversized cluster instead of returning one giant group', () => {
    const records = Array.from({ length: 9 }, (_, i) =>
      makeRecord({ content: `the user prefers dark mode variant ${i}`, importance: i / 10 }),
    );
    const clusters = clusterRecords(records, { threshold: 0.6, minSize: 2, maxSize: 3 });
    expect(clusters.length).toBeGreaterThan(1);
    for (const cluster of clusters) expect(cluster.length).toBeLessThanOrEqual(3);
  });

  it('handles an empty input', () => {
    expect(clusterRecords([], { threshold: 0.5 })).toEqual([]);
  });

  it('falls back to token overlap when embeddings are absent', () => {
    const a = makeRecord({ content: 'deploy the service on friday' }, { embedding: undefined });
    const b = makeRecord({ content: 'deploy the service on friday' }, { embedding: undefined });
    expect(recordSimilarity(a, b)).toBe(1);
  });
});

describe('ExtractiveSummarizer', () => {
  const summarizer = new ExtractiveSummarizer({ maxSentences: 2 });

  it('only emits text that was present in the input', async () => {
    const passages = [
      'The user prefers dark mode. They mentioned it twice.',
      'Dark mode is the preference for the editor.',
    ];
    const summary = await summarizer.summarize({ passages });
    for (const sentence of summary.split(/(?<=[.!?])\s+/)) {
      expect(passages.join(' ')).toContain(sentence.replace(/…$/, '').trim());
    }
  });

  it('respects the character budget', async () => {
    const summary = await summarizer.summarize({
      passages: ['A very long sentence about deployments. '.repeat(10)],
      maxChars: 60,
    });
    expect(summary.length).toBeLessThanOrEqual(61);
  });

  it('returns an empty string for empty input', async () => {
    expect(await summarizer.summarize({ passages: [] })).toBe('');
  });

  it('passes a single sentence straight through', async () => {
    expect(await summarizer.summarize({ passages: ['Just one thing here.'] })).toBe(
      'Just one thing here.',
    );
  });
});

describe('LlmSummarizer', () => {
  it('uses the model response when the call succeeds', async () => {
    const summarizer = new LlmSummarizer(async () => 'A distilled fact.');
    expect(await summarizer.summarize({ passages: ['a', 'b'] })).toBe('A distilled fact.');
  });

  it('falls back to extraction when the provider fails', async () => {
    const summarizer = new LlmSummarizer(async () => {
      throw new Error('provider down');
    });
    const result = await summarizer.summarize({
      passages: ['The deploy failed. Disk was full.'],
    });
    expect(result).toContain('deploy');
  });

  it('falls back when the model returns nothing usable', async () => {
    const summarizer = new LlmSummarizer(async () => '   ');
    expect(await summarizer.summarize({ passages: ['Something real.'] })).toBe(
      'Something real.',
    );
  });
});

describe('Consolidator', () => {
  const build = async () => {
    const store = new InMemoryStore();
    await store.init();
    return {
      store,
      consolidator: new Consolidator({
        store,
        embedder,
        summarizer: new ExtractiveSummarizer(),
      }),
    };
  };

  const oldRecord = (content: string) =>
    makeRecord(
      { content, kind: 'episodic', namespace: 'ns' },
      { createdAt: Date.now() - 5 * DAY_MS, lastAccessedAt: Date.now() - 5 * DAY_MS },
    );

  it('distils a cluster into one semantic record', async () => {
    const { store, consolidator } = await build();
    await store.putMany([
      oldRecord('The user prefers dark mode in the editor.'),
      oldRecord('User prefers dark mode for the editor theme.'),
      oldRecord('The user prefers a dark editor mode always.'),
    ]);

    const summary = await consolidator.run('ns', { similarityThreshold: 0.6 });
    expect(summary.created).toHaveLength(1);
    expect(summary.created[0]!.kind).toBe('semantic');
    expect(summary.created[0]!.derivedFrom).toHaveLength(3);
    expect(summary.supersededIds).toHaveLength(3);
  });

  it('hides the sources from ordinary queries but keeps them for provenance', async () => {
    const { store, consolidator } = await build();
    await store.putMany([
      oldRecord('The user prefers dark mode in the editor.'),
      oldRecord('User prefers dark mode for the editor theme.'),
      oldRecord('The user prefers a dark editor mode always.'),
    ]);
    await consolidator.run('ns', { similarityThreshold: 0.6 });

    expect(await store.count({ namespace: 'ns' })).toBe(1);
    expect(await store.count({ namespace: 'ns', excludeSuperseded: false })).toBe(4);
  });

  it('links each distilled fact back to its evidence', async () => {
    const { store, consolidator } = await build();
    await store.putMany([
      oldRecord('The user prefers dark mode in the editor.'),
      oldRecord('User prefers dark mode for the editor theme.'),
      oldRecord('The user prefers a dark editor mode always.'),
    ]);
    await consolidator.run('ns', { similarityThreshold: 0.6 });
    const links = await store.listLinks('ns');
    expect(links).toHaveLength(3);
    expect(links.every((link) => link.relation === 'derived-from')).toBe(true);
  });

  it('deletes the sources when keepSources is off', async () => {
    const { store, consolidator } = await build();
    await store.putMany([
      oldRecord('The user prefers dark mode in the editor.'),
      oldRecord('User prefers dark mode for the editor theme.'),
      oldRecord('The user prefers a dark editor mode always.'),
    ]);
    const summary = await consolidator.run('ns', {
      similarityThreshold: 0.6,
      keepSources: false,
    });
    expect(summary.deletedIds).toHaveLength(3);
    expect(await store.count({ namespace: 'ns', excludeSuperseded: false })).toBe(1);
  });

  it('leaves recent memories alone', async () => {
    const { store, consolidator } = await build();
    await store.putMany([
      makeRecord({ content: 'The user prefers dark mode.', namespace: 'ns' }),
      makeRecord({ content: 'User prefers dark mode too.', namespace: 'ns' }),
      makeRecord({ content: 'The user prefers dark mode always.', namespace: 'ns' }),
    ]);
    const summary = await consolidator.run('ns', { similarityThreshold: 0.6 });
    expect(summary.created).toHaveLength(0);
  });

  it('does nothing when there is not enough material', async () => {
    const { consolidator } = await build();
    expect((await consolidator.run('ns')).created).toHaveLength(0);
  });
});

describe('MaintenanceRunner', () => {
  const build = async () => {
    const store = new InMemoryStore();
    await store.init();
    return { store, runner: new MaintenanceRunner({ store, decay: new DecayModel() }) };
  };

  it('expires records past their TTL', async () => {
    const { store, runner } = await build();
    await store.put(
      makeRecord({ content: 'temp', namespace: 'ns' }, { expiresAt: Date.now() - 1 }),
    );
    const report = await runner.run('ns');
    expect(report.expired).toHaveLength(1);
    expect(await store.count({ namespace: 'ns', excludeExpired: false })).toBe(0);
  });

  it('evicts records that have gone cold', async () => {
    const { store, runner } = await build();
    const ancient = Date.now() - 200 * DAY_MS;
    await store.put(
      makeRecord(
        { content: 'forgotten', kind: 'working', namespace: 'ns' },
        { createdAt: ancient, lastAccessedAt: ancient },
      ),
    );
    expect((await runner.run('ns')).evictedStale).toHaveLength(1);
  });

  it('protects procedural memories and highly important ones', async () => {
    const { store, runner } = await build();
    const ancient = Date.now() - 3000 * DAY_MS;
    await store.putMany([
      makeRecord(
        { content: 'how to fix it', kind: 'procedural', namespace: 'ns' },
        { createdAt: ancient, lastAccessedAt: ancient },
      ),
      makeRecord(
        { content: 'critical fact', kind: 'working', importance: 0.95, namespace: 'ns' },
        { createdAt: ancient, lastAccessedAt: ancient },
      ),
    ]);
    expect((await runner.run('ns')).evictedStale).toHaveLength(0);
  });

  it('sheds the least valuable records under capacity pressure', async () => {
    const { store, runner } = await build();
    for (let i = 0; i < 10; i += 1) {
      await store.put(
        makeRecord({ content: `note ${i}`, importance: i / 10, namespace: 'ns' }),
      );
    }
    const report = await runner.run('ns', {
      maxRecords: 5,
      staleRetentionThreshold: 0,
      protectedImportance: 1.1,
    });
    expect(report.evictedCapacity).toHaveLength(5);
    const survivors = await store.query({ namespace: 'ns' });
    const lowest = Math.min(...survivors.map((record) => record.importance));
    expect(lowest).toBeGreaterThanOrEqual(0.5);
  });

  it('reports without mutating when dryRun is set', async () => {
    const { store, runner } = await build();
    await store.put(
      makeRecord({ content: 'temp', namespace: 'ns' }, { expiresAt: Date.now() - 1 }),
    );
    const report = await runner.run('ns', { dryRun: true });
    expect(report.expired).toHaveLength(1);
    expect(await store.count({ namespace: 'ns', excludeExpired: false })).toBe(1);
  });

  it('honours a TTL even on a protected kind', async () => {
    const { runner, store } = await build();
    await store.put(
      makeRecord(
        { content: 'procedure with an expiry', kind: 'procedural', namespace: 'ns' },
        { expiresAt: Date.now() - 1 },
      ),
    );
    expect((await runner.run('ns')).expired).toHaveLength(1);
  });

  it('keeps superseded records warm before pruning them', async () => {
    const { store, runner } = await build();
    await store.put(
      makeRecord({ content: 'just superseded', namespace: 'ns' }, { supersededBy: 'x' }),
    );
    expect((await runner.run('ns', { pruneSuperseded: true })).prunedSuperseded).toHaveLength(0);
  });
});
