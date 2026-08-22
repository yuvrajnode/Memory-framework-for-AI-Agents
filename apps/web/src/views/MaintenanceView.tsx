import { useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Panel, Stat } from '../components/primitives.js';
import { useBackend } from '../lib/backend-context.js';
import { useToast } from '../lib/toast.js';
import type { ConsolidationResult, MaintenanceResult } from '../lib/types.js';

/**
 * Destructive operations, kept behind explanations.
 *
 * Consolidation and eviction permanently change what an agent knows, so each
 * panel states what it will do before it does it, maintenance defaults to a
 * dry run, and clearing a namespace requires typing its name. The friction is
 * the feature.
 */
export function MaintenanceView() {
  return (
    <div className="stack">
      <p className="page__lede">
        Left alone, a long-lived store degrades into an append-only transcript: the same
        fact restated fifty times, scratch notes from months ago competing with current
        ones. These operations are how it stays useful.
      </p>

      <ConsolidatePanel />
      <MaintenancePanel />
      <DangerPanel />
    </div>
  );
}

function ConsolidatePanel() {
  const { backend, namespace, invalidate } = useBackend();
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ConsolidationResult | null>(null);

  const run = async () => {
    setRunning(true);
    try {
      const summary = await backend.consolidate(namespace);
      setResult(summary);
      invalidate();
      toast(
        summary.created.length > 0
          ? `Distilled ${summary.created.length} new ${summary.created.length === 1 ? 'fact' : 'facts'}`
          : 'Nothing was similar enough to consolidate',
        summary.created.length > 0 ? 'success' : 'info',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Consolidation failed', 'error');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Panel
      title="Consolidate"
      footer={
        <>
          <span className="xs faint">
            Only episodes older than a day are eligible, so live context is never
            rewritten underneath a running agent.
          </span>
          <button
            type="button"
            className="button button--primary push"
            onClick={() => void run()}
            disabled={running}
          >
            <Icon name="spark" size={14} />
            {running ? 'Clustering…' : 'Run consolidation'}
          </button>
        </>
      }
    >
      <p className="small muted">
        Clusters related episodes and distils each group into one semantic fact. The
        summariser is extractive by default, so it can only restate text that is already
        stored — it cannot invent a detail and promote it into long-term memory. Sources
        are marked superseded rather than deleted, so the chain from a fact back to its
        evidence survives.
      </p>

      {result && (
        <div className="stack" style={{ marginTop: 'var(--s4)' }}>
          <div className="grid-stats">
            <Stat label="Examined" value={result.examined} />
            <Stat label="Clusters" value={result.clusters} />
            <Stat label="Created" value={result.created.length} />
            <Stat label="Superseded" value={result.superseded} />
          </div>

          {result.created.length > 0 && (
            <div className="stack stack--tight">
              <span className="label">Distilled facts</span>
              {result.created.map((memory) => (
                <div key={memory.id} className="result-card">
                  <p className="small">{memory.content}</p>
                  <p className="xs faint" style={{ marginTop: 4 }}>
                    from {memory.derivedFrom.length} memories
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function MaintenancePanel() {
  const { backend, namespace, invalidate } = useBackend();
  const toast = useToast();

  const [dryRun, setDryRun] = useState(true);
  const [maxRecords, setMaxRecords] = useState(0);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<MaintenanceResult | null>(null);

  const run = async () => {
    setRunning(true);
    try {
      const result = await backend.maintain(namespace, {
        dryRun,
        ...(maxRecords > 0 ? { maxRecords } : {}),
      });
      setReport(result);
      if (!dryRun) invalidate();
      const total =
        result.expired.length +
        result.evictedStale.length +
        result.evictedCapacity.length +
        result.prunedSuperseded.length;
      toast(
        dryRun
          ? `${total} ${total === 1 ? 'record' : 'records'} would be reclaimed`
          : `Reclaimed ${total} ${total === 1 ? 'record' : 'records'}`,
        'success',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Maintenance failed', 'error');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Panel
      title="Reclaim"
      action={
        <label className="row row--tight xs">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(event) => setDryRun(event.target.checked)}
          />
          Dry run
        </label>
      }
      footer={
        <>
          <span className="xs faint">
            Procedural memories and anything above 0.9 importance are never evicted.
          </span>
          <button
            type="button"
            className={`button push ${dryRun ? '' : 'button--danger'}`}
            onClick={() => void run()}
            disabled={running}
          >
            <Icon name={dryRun ? 'search' : 'trash'} size={14} />
            {running ? 'Scanning…' : dryRun ? 'Preview' : 'Reclaim now'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">
          Three passes in increasing order of aggression: explicit TTL expiry, then
          retention-based staleness, then capacity pressure. They are separate because
          they answer different questions — was this always temporary, has it gone cold,
          or am I simply out of room — and you should be able to see which one took a
          memory.
        </p>

        <div className="field" style={{ maxWidth: 320 }}>
          <label className="label" htmlFor="max-records">
            Capacity cap {maxRecords === 0 ? '(off)' : maxRecords}
          </label>
          <input
            id="max-records"
            className="range"
            type="range"
            min={0}
            max={200}
            step={5}
            value={maxRecords}
            onChange={(event) => setMaxRecords(Number(event.target.value))}
          />
          <span className="field__hint">
            Over the cap, eviction ranks by retention × importance, so it sheds what is
            both cold and unimportant rather than merely the oldest.
          </span>
        </div>

        {report && (
          <div className="stack stack--tight">
            <div className="row row--tight">
              <span className="label">Report</span>
              {report.dryRun && (
                <span className="badge badge--working">Nothing was deleted</span>
              )}
            </div>
            <div className="grid-stats">
              <Stat label="Scanned" value={report.scanned} />
              <Stat label="TTL expired" value={report.expired.length} />
              <Stat label="Cold" value={report.evictedStale.length} />
              <Stat label="Over capacity" value={report.evictedCapacity.length} />
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function DangerPanel() {
  const { backend, namespace, invalidate } = useBackend();
  const toast = useToast();
  const [confirmation, setConfirmation] = useState('');
  const [clearing, setClearing] = useState(false);

  const armed = confirmation === namespace;

  const clear = async () => {
    setClearing(true);
    try {
      const removed = await backend.clear(namespace);
      toast(`Cleared ${removed} ${removed === 1 ? 'memory' : 'memories'}`, 'success');
      setConfirmation('');
      invalidate();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Clear failed', 'error');
    } finally {
      setClearing(false);
    }
  };

  return (
    <Panel title="Clear namespace">
      <div className="stack">
        <p className="small muted">
          Permanently deletes every memory and association in{' '}
          <code className="tabular">{namespace}</code>. There is no undo and no export
          step — type the namespace name to confirm you meant this one.
        </p>
        <div className="row row--wrap">
          <input
            className="input"
            style={{ maxWidth: 260 }}
            value={confirmation}
            placeholder={namespace}
            aria-label={`Type ${namespace} to confirm`}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          <button
            type="button"
            className="button button--danger"
            disabled={!armed || clearing}
            onClick={() => void clear()}
          >
            <Icon name="warning" size={14} />
            {clearing ? 'Clearing…' : 'Clear everything'}
          </button>
        </div>
      </div>
    </Panel>
  );
}
