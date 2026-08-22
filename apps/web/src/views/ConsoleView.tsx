import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Field, KindBadge, Meter, Panel, Segmented } from '../components/primitives.js';
import { useBackend } from '../lib/backend-context.js';
import { useToast } from '../lib/toast.js';
import { KIND_DESCRIPTIONS, KIND_ORDER, parseTags, percent, relativeTime } from '../lib/format.js';
import type { ContextResult, MemoryKind, RankedMemory } from '../lib/types.js';

const SIGNALS = [
  { key: 'semantic', label: 'Semantic', hint: 'Cosine similarity to the query vector' },
  { key: 'lexical', label: 'Lexical', hint: 'BM25 overlap — rescues names and identifiers' },
  { key: 'recency', label: 'Recency', hint: 'How recently the memory was written' },
  { key: 'importance', label: 'Importance', hint: 'Salience assigned at write time' },
  { key: 'usage', label: 'Usage', hint: 'Reinforcement from previous recalls' },
] as const;

const EXAMPLE_QUERIES = [
  'how do I fix a runner that ran out of disk?',
  'when are we allowed to deploy?',
  'what caused the latency incident?',
  'what am I currently blocked on?',
];

/**
 * The console: write on the left, retrieve on the right.
 *
 * The retrieval side deliberately shows its work. A ranked list alone is
 * unfalsifiable — the operator cannot tell whether a result surfaced because
 * it matched, because it was recent, or because someone marked it important.
 * Exposing the per-signal breakdown next to each hit turns tuning the weights
 * from guesswork into something you can reason about.
 */
export function ConsoleView() {
  const { backend, namespace, invalidate, ready } = useBackend();
  const toast = useToast();

  const [mode, setMode] = useState<'recall' | 'context'>('recall');
  const [query, setQuery] = useState('how do I fix a runner that ran out of disk?');
  const [diversity, setDiversity] = useState(0.2);
  const [budget, setBudget] = useState(320);
  const [results, setResults] = useState<RankedMemory[] | null>(null);
  const [context, setContext] = useState<ContextResult | null>(null);
  const [searching, setSearching] = useState(false);

  const run = useCallback(
    async (nextQuery = query) => {
      if (!nextQuery.trim()) {
        toast('Enter something to recall', 'error');
        return;
      }
      setSearching(true);
      try {
        if (mode === 'recall') {
          setContext(null);
          setResults(
            await backend.recall(nextQuery, { namespace, limit: 8, diversity, reinforce: false }),
          );
        } else {
          setResults(null);
          setContext(
            await backend.buildContext(nextQuery, {
              namespace,
              budgetTokens: budget,
              limit: 20,
              diversity,
            }),
          );
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Recall failed', 'error');
      } finally {
        setSearching(false);
      }
    },
    [backend, budget, diversity, mode, namespace, query, toast],
  );

  // Run the opening query once the backend is up, so the console lands on a
  // worked example rather than an empty panel the visitor has to prime.
  const primed = useRef(false);
  useEffect(() => {
    if (!ready || primed.current) return;
    primed.current = true;
    void run();
  }, [ready, run]);

  return (
    <div className="split">
      <WritePanel
        onWritten={() => {
          invalidate();
          void run();
        }}
      />

      <div className="stack">
        <Panel
          title="Retrieve"
          action={
            <Segmented
              ariaLabel="Retrieval mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'recall', label: 'Ranked recall' },
                { value: 'context', label: 'Packed context' },
              ]}
            />
          }
          footer={
            <div className="row row--wrap row--tight xs faint">
              <span>Try:</span>
              {EXAMPLE_QUERIES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="button button--ghost button--sm"
                  onClick={() => {
                    setQuery(example);
                    void run(example);
                  }}
                >
                  {example}
                </button>
              ))}
            </div>
          }
        >
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <Field
              label="Query"
              htmlFor="recall-query"
              hint="Recall blends semantic, lexical, recency, importance and usage, then attenuates by retention."
            >
              <input
                id="recall-query"
                className="input"
                value={query}
                placeholder="What should the agent remember right now?"
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field>

            <div className="row row--wrap">
              <Field label={`Diversity ${diversity.toFixed(2)}`} htmlFor="diversity">
                <input
                  id="diversity"
                  className="range"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={diversity}
                  style={{ width: 180 }}
                  onChange={(event) => setDiversity(Number(event.target.value))}
                />
              </Field>

              {mode === 'context' && (
                <Field label={`Token budget ${budget}`} htmlFor="budget">
                  <input
                    id="budget"
                    className="range"
                    type="range"
                    min={80}
                    max={1200}
                    step={20}
                    value={budget}
                    style={{ width: 180 }}
                    onChange={(event) => setBudget(Number(event.target.value))}
                  />
                </Field>
              )}

              <button type="submit" className="button button--primary push" disabled={searching}>
                <Icon name="search" size={14} />
                {searching ? 'Working…' : mode === 'recall' ? 'Recall' : 'Assemble'}
              </button>
            </div>
          </form>
        </Panel>

        {results && <ResultList results={results} />}
        {context && <ContextPanel context={context} />}
      </div>
    </div>
  );
}

function WritePanel({ onWritten }: { onWritten: () => void }) {
  const { backend, namespace } = useBackend();
  const toast = useToast();

  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('episodic');
  const [importance, setImportance] = useState(0.5);
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!content.trim()) {
      toast('A memory needs some content', 'error');
      return;
    }
    setSaving(true);
    try {
      const record = await backend.remember({
        content,
        kind,
        importance,
        tags: parseTags(tags),
        namespace,
        source: 'user',
      });
      toast(`Stored ${record.id}`, 'success');
      setContent('');
      setTags('');
      onWritten();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not store the memory', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title="Write a memory"
      footer={
        <>
          <span className="xs faint">
            Restatements merge into the existing record rather than duplicating it.
          </span>
          <button
            type="button"
            className="button button--primary push"
            onClick={() => void submit()}
            disabled={saving}
          >
            <Icon name="plus" size={14} />
            {saving ? 'Storing…' : 'Remember'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field
          label="Content"
          htmlFor="write-content"
          hint={<>⌘/Ctrl + Enter to submit</>}
        >
          <textarea
            id="write-content"
            className="textarea"
            value={content}
            placeholder="Ada asked that migrations always run before the app rollout."
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </Field>

        <Field label="Kind" htmlFor="write-kind" hint={KIND_DESCRIPTIONS[kind]}>
          <select
            id="write-kind"
            className="select"
            value={kind}
            onChange={(event) => setKind(event.target.value as MemoryKind)}
          >
            {KIND_ORDER.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label={`Importance ${importance.toFixed(2)}`}
          htmlFor="write-importance"
          hint="Resists decay and lifts the memory at recall time."
        >
          <input
            id="write-importance"
            className="range"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={importance}
            onChange={(event) => setImportance(Number(event.target.value))}
          />
        </Field>

        <Field label="Tags" htmlFor="write-tags" hint="Comma separated. Used for hard filtering.">
          <input
            id="write-tags"
            className="input"
            value={tags}
            placeholder="deploy, database"
            onChange={(event) => setTags(event.target.value)}
          />
        </Field>
      </div>
    </Panel>
  );
}

function ResultList({ results }: { results: RankedMemory[] }) {
  if (results.length === 0) {
    return (
      <Panel title="Results">
        <p className="muted small">
          Nothing scored above the threshold. Either the namespace is empty, or the query
          shares no vocabulary and no entities with anything stored.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title={`Results · ${results.length}`}>
      <div className="stack">
        {results.map((result, index) => (
          <ResultRow key={result.memory.id} result={result} rank={index + 1} />
        ))}
      </div>
    </Panel>
  );
}

function ResultRow({ result, rank }: { result: RankedMemory; rank: number }) {
  const [open, setOpen] = useState(rank === 1);
  const { memory, breakdown } = result;

  return (
    <article
      style={{
        border: '1px solid var(--rule)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        style={{
          display: 'block',
          width: '100%',
          padding: 'var(--s3)',
          border: 0,
          background: 'transparent',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <div className="row row--tight" style={{ marginBottom: 'var(--s2)' }}>
          <span className="tabular faint xs">{String(rank).padStart(2, '0')}</span>
          <KindBadge kind={memory.kind} />
          <span className="tabular xs muted">{relativeTime(memory.createdAt)}</span>
          <span className="push tabular small" style={{ color: 'var(--accent)' }}>
            {result.score.toFixed(3)}
          </span>
          <Icon
            name="chevron"
            size={14}
            className={open ? 'rotated' : undefined}
          />
        </div>
        <p className="small" style={{ lineHeight: 1.6 }}>
          {memory.content}
        </p>
      </button>

      {open && (
        <div
          style={{
            padding: 'var(--s3)',
            borderTop: '1px solid var(--rule)',
            background: 'var(--surface-sunken)',
          }}
        >
          <span className="label">Why this surfaced</span>
          <div
            style={{
              display: 'grid',
              gap: 'var(--s2)',
              gridTemplateColumns: '84px 1fr 44px',
              alignItems: 'center',
              marginTop: 'var(--s2)',
            }}
          >
            {SIGNALS.map((signal) => (
              <SignalRow
                key={signal.key}
                label={signal.label}
                hint={signal.hint}
                value={breakdown[signal.key]}
              />
            ))}
            <SignalRow
              label="Retention"
              hint="Multiplies the blended score — a faded memory is suppressed, not merely ranked lower"
              value={breakdown.retention}
              emphasis
            />
          </div>

          {memory.tags.length > 0 && (
            <div className="row row--tight row--wrap" style={{ marginTop: 'var(--s3)' }}>
              {memory.tags.map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function SignalRow({
  label,
  hint,
  value,
  emphasis,
}: {
  label: string;
  hint: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <>
      <span className="xs muted" title={hint} style={emphasis ? { fontWeight: 500 } : undefined}>
        {label}
      </span>
      <Meter
        value={value}
        label={label}
        color={emphasis ? 'var(--kind-procedural)' : 'var(--accent)'}
      />
      <span className="tabular xs faint" style={{ textAlign: 'right' }}>
        {value.toFixed(2)}
      </span>
    </>
  );
}

function ContextPanel({ context }: { context: ContextResult }) {
  const toast = useToast();
  const over = context.utilization > 0.92;

  return (
    <Panel
      title="Assembled context"
      action={
        <button
          type="button"
          className="button button--sm"
          onClick={() => {
            void navigator.clipboard
              .writeText(context.text)
              .then(() => toast('Context copied', 'success'))
              .catch(() => toast('Clipboard is unavailable', 'error'));
          }}
        >
          <Icon name="copy" size={13} />
          Copy
        </button>
      }
      footer={
        <div className="stack stack--tight" style={{ width: '100%' }}>
          <div className="row row--tight xs">
            <span className="tabular">
              {context.estimatedTokens} / {context.budgetTokens} tokens
            </span>
            <span className="faint">·</span>
            <span className="faint">{context.included.length} included</span>
            {context.droppedCount > 0 && (
              <>
                <span className="faint">·</span>
                <span style={{ color: 'var(--warning)' }}>
                  {context.droppedCount} dropped for budget
                </span>
              </>
            )}
            <span className="push tabular faint">{percent(context.utilization)}</span>
          </div>
          <Meter
            value={context.utilization}
            label="Budget used"
            color={over ? 'var(--warning)' : 'var(--accent)'}
          />
        </div>
      }
    >
      <pre className="code">{context.text || 'Nothing fit in the budget.'}</pre>
    </Panel>
  );
}
