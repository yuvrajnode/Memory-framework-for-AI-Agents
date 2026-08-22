import { useMemo, useState } from 'react';
import { DecayModel, DEFAULT_DECAY_PROFILE } from '@mnemos/core';
import { BarChart, LineChart, ProportionBar, type Bar } from '../components/charts.js';
import { Empty, Panel, Stat } from '../components/primitives.js';
import { useBackend } from '../lib/backend-context.js';
import { useAsync } from '../lib/use-async.js';
import { KIND_LABELS, KIND_ORDER, compactNumber, percent, relativeTime } from '../lib/format.js';
import type { MemoryKind } from '../lib/types.js';

const DAY = 24 * 60 * 60 * 1000;

/** Retention buckets, coarse enough to read at a glance. */
const BANDS = [
  { label: '0–20%', min: 0, max: 0.2, color: 'var(--danger)' },
  { label: '20–40%', min: 0.2, max: 0.4, color: 'var(--warning)' },
  { label: '40–60%', min: 0.4, max: 0.6, color: 'var(--kind-episodic)' },
  { label: '60–80%', min: 0.6, max: 0.8, color: 'var(--kind-semantic)' },
  { label: '80–100%', min: 0.8, max: 1.01, color: 'var(--kind-procedural)' },
];

export function InsightsView() {
  const { backend, namespace, revision } = useBackend();

  const { data: stats, loading } = useAsync(
    () => backend.stats(namespace),
    [backend, namespace, revision],
  );
  const { data: page } = useAsync(
    () => backend.list({ namespace, limit: 500 }),
    [backend, namespace, revision],
  );

  const memories = page?.memories ?? [];

  const kindBars = useMemo<Bar[]>(
    () =>
      KIND_ORDER.map((kind) => ({
        label: KIND_LABELS[kind],
        value: stats?.byKind[kind] ?? 0,
        color: `var(--kind-${kind})`,
      })),
    [stats],
  );

  const retentionBars = useMemo<Bar[]>(
    () =>
      BANDS.map((band) => ({
        label: band.label,
        color: band.color,
        value: memories.filter(
          (memory) => memory.retention >= band.min && memory.retention < band.max,
        ).length,
      })),
    [memories],
  );

  const sourceBars = useMemo<Bar[]>(() => {
    if (!stats) return [];
    return Object.entries(stats.bySource)
      .filter(([, count]) => count > 0)
      .map(([source, count]) => ({ label: source, value: count }));
  }, [stats]);

  const coldest = useMemo(
    () => [...memories].sort((a, b) => a.retention - b.retention).slice(0, 5),
    [memories],
  );

  if (loading && !stats) {
    return <Empty title="Reading the store" body="Gathering statistics for this namespace." />;
  }

  if (stats && stats.total === 0) {
    return (
      <Empty
        title="Nothing to measure yet"
        body="Insights describe a populated namespace: composition by kind and source, how retention is distributed, and which memories are closest to being forgotten."
      />
    );
  }

  return (
    <div className="stack">
      <div className="grid-stats">
        <Stat
          label="Memories"
          value={compactNumber(stats?.total ?? 0)}
          note={`${stats?.links ?? 0} associations`}
        />
        <Stat
          label="Mean retention"
          value={percent(stats?.averageRetention ?? 0)}
          note="How warm the store is overall"
        />
        <Stat
          label="Mean importance"
          value={(stats?.averageImportance ?? 0).toFixed(2)}
          note="Caller-assigned salience"
        />
        <Stat
          label="Recalls"
          value={compactNumber(stats?.totalAccesses ?? 0)}
          note="Each one resets a decay clock"
        />
        <Stat
          label="Footprint"
          value={`${compactNumber(stats?.approximateTokens ?? 0)}`}
          note="Approximate tokens if fully inlined"
        />
        <Stat
          label="Span"
          value={
            stats?.oldestCreatedAt ? relativeTime(stats.oldestCreatedAt).replace(' ago', '') : '—'
          }
          note="Age of the oldest memory"
        />
      </div>

      <div className="split">
        <Panel title="Composition by kind">
          <div className="stack">
            <ProportionBar segments={kindBars} />
            <BarChart bars={kindBars} />
          </div>
        </Panel>

        <Panel
          title="Retention distribution"
          action={<span className="xs faint">live, recomputed per record</span>}
        >
          <BarChart bars={retentionBars} />
          <p className="xs faint" style={{ marginTop: 'var(--s3)' }}>
            Retention falls with time since a memory was last touched and rises with
            importance and repeated recall. Anything in the leftmost band is a candidate
            for eviction on the next maintenance pass.
          </p>
        </Panel>
      </div>

      <DecayExplorer />

      <div className="split">
        <Panel title="Where memories come from">
          {sourceBars.length > 0 ? (
            <BarChart bars={sourceBars} />
          ) : (
            <p className="small muted">No provenance recorded yet.</p>
          )}
        </Panel>

        <Panel
          title="Closest to being forgotten"
          action={<span className="xs faint">lowest retention first</span>}
        >
          {coldest.length === 0 ? (
            <p className="small muted">Nothing stored.</p>
          ) : (
            <div className="stack stack--tight">
              {coldest.map((memory) => (
                <div key={memory.id} className="row row--tight">
                  <span
                    className="dot"
                    style={{ background: `var(--kind-${memory.kind})` }}
                    aria-hidden="true"
                  />
                  <span className="small" style={{ flex: 1, minWidth: 0 }}>
                    <span className="ellipsis">{memory.content}</span>
                  </span>
                  <span className="tabular xs faint">{percent(memory.retention)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

/**
 * An interactive model of the decay curve.
 *
 * Forgetting is the least intuitive part of the framework, and a table of
 * half-lives does not convey how sharply importance and rehearsal bend the
 * curve. This computes the real DecayModel — the same class the engine uses —
 * across a horizon, so the plot is the actual behaviour rather than an
 * illustration of it.
 */
function DecayExplorer() {
  const [importance, setImportance] = useState(0.5);
  const [accessCount, setAccessCount] = useState(0);
  const [horizonDays, setHorizonDays] = useState(60);

  const series = useMemo(() => {
    const decay = new DecayModel();
    const now = Date.now();
    const steps = 96;

    return KIND_ORDER.map((kind) => ({
      label: `${KIND_LABELS[kind]} · ${formatHalfLife(DEFAULT_DECAY_PROFILE[kind])}`,
      color: `var(--kind-${kind})`,
      points: Array.from({ length: steps + 1 }, (_, index) => {
        const ageDays = (index / steps) * horizonDays;
        const timestamp = now - ageDays * DAY;
        return {
          x: ageDays,
          y: decay.retention(
            {
              id: 'probe',
              namespace: 'probe',
              kind: kind as MemoryKind,
              source: 'agent',
              content: '',
              tags: [],
              metadata: {},
              importance,
              createdAt: timestamp,
              updatedAt: timestamp,
              lastAccessedAt: timestamp,
              accessCount,
              fingerprint: 'probe',
            },
            now,
          ),
        };
      }),
    }));
  }, [importance, accessCount, horizonDays]);

  return (
    <Panel
      title="Decay model"
      action={<span className="xs faint">computed with the engine's own DecayModel</span>}
    >
      <div className="stack">
        <div className="row row--wrap">
          <div className="field" style={{ flex: '1 1 180px' }}>
            <label className="label" htmlFor="decay-importance">
              Importance {importance.toFixed(2)}
            </label>
            <input
              id="decay-importance"
              className="range"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={importance}
              onChange={(event) => setImportance(Number(event.target.value))}
            />
          </div>
          <div className="field" style={{ flex: '1 1 180px' }}>
            <label className="label" htmlFor="decay-accesses">
              Prior recalls {accessCount}
            </label>
            <input
              id="decay-accesses"
              className="range"
              type="range"
              min={0}
              max={40}
              step={1}
              value={accessCount}
              onChange={(event) => setAccessCount(Number(event.target.value))}
            />
          </div>
          <div className="field" style={{ flex: '1 1 180px' }}>
            <label className="label" htmlFor="decay-horizon">
              Horizon {horizonDays}d
            </label>
            <input
              id="decay-horizon"
              className="range"
              type="range"
              min={7}
              max={365}
              step={7}
              value={horizonDays}
              onChange={(event) => setHorizonDays(Number(event.target.value))}
            />
          </div>
        </div>

        <LineChart
          series={series}
          xMax={horizonDays}
          xLabel="days since last touched"
          markers={[{ x: horizonDays / 2, label: `${Math.round(horizonDays / 2)}d` }]}
        />

        <p className="xs faint">
          Raising importance or rehearsal count stretches every half-life, which is why a
          procedure an agent keeps using effectively stops decaying while an unrevisited
          scratch note is gone within a day.
        </p>
      </div>
    </Panel>
  );
}

function formatHalfLife(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  return days < 365 ? `${Math.round(days)}d` : `${(days / 365).toFixed(1)}y`;
}
