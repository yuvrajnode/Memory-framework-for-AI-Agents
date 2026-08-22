import { useCallback, useMemo, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Empty, KindBadge, Meter, Panel, Segmented } from '../components/primitives.js';
import { useBackend } from '../lib/backend-context.js';
import { useAsync } from '../lib/use-async.js';
import { useToast } from '../lib/toast.js';
import {
  KIND_ORDER,
  absoluteTime,
  parseTags,
  percent,
  relativeTime,
} from '../lib/format.js';
import type { ListParams, MemoryKind, MemoryView } from '../lib/types.js';

type SortKey = NonNullable<ListParams['orderBy']>;

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'createdAt', label: 'Newest' },
  { value: 'importance', label: 'Important' },
  { value: 'lastAccessedAt', label: 'Recently used' },
  { value: 'accessCount', label: 'Most used' },
];

const PAGE_SIZE = 25;

/**
 * The explorer.
 *
 * Search here runs the full recall pipeline rather than a substring match, so
 * what an operator sees when investigating is exactly what the agent would
 * retrieve — a debugging view that disagreed with production ranking would be
 * worse than none.
 */
export function MemoriesView() {
  const { backend, namespace, revision, invalidate } = useBackend();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [kinds, setKinds] = useState<MemoryKind[]>([]);
  const [tagFilter, setTagFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('createdAt');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<MemoryView | null>(null);

  const tags = useMemo(() => parseTags(tagFilter), [tagFilter]);

  const { data, loading, error, reload } = useAsync(
    () =>
      backend.list({
        namespace,
        ...(kinds.length ? { kinds } : {}),
        ...(tags.length ? { tags } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        orderBy: sort,
      }),
    [backend, namespace, kinds.join(','), tags.join(','), search, sort, page, revision],
  );

  const refresh = useCallback(() => {
    invalidate();
    reload();
  }, [invalidate, reload]);

  const toggleKind = (kind: MemoryKind) => {
    setPage(0);
    setKinds((current) =>
      current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind],
    );
  };

  const remove = async (memory: MemoryView) => {
    try {
      await backend.forget(memory.id, namespace);
      toast('Memory forgotten', 'success');
      if (selected?.id === memory.id) setSelected(null);
      refresh();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Delete failed', 'error');
    }
  };

  const memories = data?.memories ?? [];
  const total = data?.total ?? 0;
  const searching = Boolean(search.trim());

  return (
    <div className="stack">
      <Panel
        title="Filter"
        action={
          <button type="button" className="button button--sm" onClick={refresh}>
            <Icon name="refresh" size={13} />
            Refresh
          </button>
        }
      >
        <div className="stack">
          <div className="row row--wrap">
            <div style={{ position: 'relative', flex: '1 1 320px' }}>
              <Icon
                name="search"
                size={14}
                className="search-icon"
              />
              <input
                className="input"
                style={{ paddingLeft: 34 }}
                value={search}
                placeholder="Search by meaning, not substring…"
                aria-label="Search memories"
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
              />
            </div>

            <input
              className="input"
              style={{ flex: '0 1 220px' }}
              value={tagFilter}
              placeholder="Tags (all must match)"
              aria-label="Filter by tags"
              onChange={(event) => {
                setTagFilter(event.target.value);
                setPage(0);
              }}
            />

            <Segmented
              ariaLabel="Sort order"
              value={sort}
              onChange={(value) => {
                setSort(value);
                setPage(0);
              }}
              options={SORTS}
            />
          </div>

          <div className="row row--tight row--wrap">
            <span className="label">Kinds</span>
            {KIND_ORDER.map((kind) => (
              <button
                key={kind}
                type="button"
                className="button button--sm"
                aria-pressed={kinds.includes(kind)}
                style={
                  kinds.includes(kind)
                    ? { borderColor: `var(--kind-${kind})`, color: `var(--kind-${kind})` }
                    : undefined
                }
                onClick={() => toggleKind(kind)}
              >
                {kind}
              </button>
            ))}
            {(kinds.length > 0 || tags.length > 0 || search) && (
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={() => {
                  setKinds([]);
                  setTagFilter('');
                  setSearch('');
                  setPage(0);
                }}
              >
                <Icon name="close" size={12} />
                Clear
              </button>
            )}
          </div>
        </div>
      </Panel>

      <Panel
        title={
          loading
            ? 'Loading…'
            : searching
              ? `${memories.length} ranked ${memories.length === 1 ? 'match' : 'matches'}`
              : `${total} ${total === 1 ? 'memory' : 'memories'}`
        }
        action={
          searching && <span className="xs faint">Ordered by recall score</span>
        }
        footer={
          !searching && total > PAGE_SIZE ? (
            <>
              <span className="xs faint tabular">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
              </span>
              <div className="push row row--tight">
                <button
                  type="button"
                  className="button button--sm"
                  disabled={page === 0}
                  onClick={() => setPage((current) => current - 1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="button button--sm"
                  disabled={(page + 1) * PAGE_SIZE >= total}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </button>
              </div>
            </>
          ) : undefined
        }
      >
        {error && (
          <p className="small" style={{ color: 'var(--danger)' }}>
            {error.message}
          </p>
        )}

        {!error && memories.length === 0 && !loading && (
          <Empty
            title={searching ? 'No matches' : 'Nothing stored yet'}
            body={
              searching
                ? 'Nothing scored above the threshold for that query. Recall is semantic and lexical, so an unrelated phrasing returns nothing rather than a weak guess.'
                : 'Write a memory from the Console and it will appear here.'
            }
          />
        )}

        {memories.length > 0 && (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: '46%' }}>Memory</th>
                  <th>Kind</th>
                  <th>Importance</th>
                  <th>Retention</th>
                  <th>Used</th>
                  <th>Age</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {memories.map((memory) => (
                  <tr key={memory.id}>
                    <td>
                      <button
                        type="button"
                        className="link-cell"
                        onClick={() => setSelected(memory)}
                      >
                        {memory.content}
                      </button>
                      {memory.tags.length > 0 && (
                        <div className="row row--tight row--wrap" style={{ marginTop: 6 }}>
                          {memory.tags.slice(0, 4).map((tag) => (
                            <span key={tag} className="tag">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      <KindBadge kind={memory.kind} />
                    </td>
                    <td style={{ minWidth: 92 }}>
                      <Meter value={memory.importance} label="Importance" />
                      <span className="tabular xs faint">{memory.importance.toFixed(2)}</span>
                    </td>
                    <td style={{ minWidth: 92 }}>
                      <Meter
                        value={memory.retention}
                        label="Retention"
                        color={retentionColor(memory.retention)}
                      />
                      <span className="tabular xs faint">{percent(memory.retention)}</span>
                    </td>
                    <td className="tabular xs faint">{memory.accessCount}</td>
                    <td className="tabular xs faint" title={absoluteTime(memory.createdAt)}>
                      {relativeTime(memory.createdAt)}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="button button--ghost button--sm button--danger"
                        aria-label={`Forget memory ${memory.id}`}
                        onClick={() => void remove(memory)}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {selected && (
        <EditPanel
          memory={selected}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function retentionColor(value: number): string {
  if (value > 0.6) return 'var(--kind-procedural)';
  if (value > 0.25) return 'var(--warning)';
  return 'var(--danger)';
}

function EditPanel({
  memory,
  onClose,
  onSaved,
}: {
  memory: MemoryView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { backend, namespace } = useBackend();
  const toast = useToast();

  const [content, setContent] = useState(memory.content);
  const [importance, setImportance] = useState(memory.importance);
  const [kind, setKind] = useState<MemoryKind>(memory.kind);
  const [tags, setTags] = useState(memory.tags.join(', '));
  const [saving, setSaving] = useState(false);

  const dirty =
    content !== memory.content ||
    importance !== memory.importance ||
    kind !== memory.kind ||
    tags !== memory.tags.join(', ');

  const save = async () => {
    setSaving(true);
    try {
      await backend.update(
        memory.id,
        { content, importance, kind, tags: parseTags(tags) },
        namespace,
      );
      toast('Memory updated', 'success');
      onSaved();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Update failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title={<span className="tabular xs">{memory.id}</span>}
      action={
        <button type="button" className="button button--ghost button--sm" onClick={onClose}>
          <Icon name="close" size={13} />
          Close
        </button>
      }
      footer={
        <>
          <span className="xs faint">
            Editing the content re-embeds the memory and recomputes its fingerprint.
          </span>
          <button
            type="button"
            className="button button--primary push"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            <Icon name="check" size={13} />
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      <div className="stack">
        <textarea
          className="textarea"
          value={content}
          aria-label="Memory content"
          onChange={(event) => setContent(event.target.value)}
        />

        <div className="row row--wrap">
          <div className="field" style={{ flex: '0 1 180px' }}>
            <label className="label" htmlFor="edit-kind">
              Kind
            </label>
            <select
              id="edit-kind"
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
          </div>

          <div className="field" style={{ flex: '1 1 200px' }}>
            <label className="label" htmlFor="edit-importance">
              Importance {importance.toFixed(2)}
            </label>
            <input
              id="edit-importance"
              className="range"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={importance}
              onChange={(event) => setImportance(Number(event.target.value))}
            />
          </div>

          <div className="field" style={{ flex: '1 1 240px' }}>
            <label className="label" htmlFor="edit-tags">
              Tags
            </label>
            <input
              id="edit-tags"
              className="input"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
            />
          </div>
        </div>

        <dl className="meta-grid">
          <Meta label="Created" value={absoluteTime(memory.createdAt)} />
          <Meta label="Last used" value={relativeTime(memory.lastAccessedAt)} />
          <Meta label="Recalls" value={String(memory.accessCount)} />
          <Meta label="Retention" value={percent(memory.retention)} />
          <Meta label="Source" value={memory.source} />
          <Meta
            label="Vector"
            value={memory.embeddingDimensions ? `${memory.embeddingDimensions}d` : 'none'}
          />
        </dl>
      </div>
    </Panel>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="tabular xs muted" style={{ marginTop: 2 }}>
        {value}
      </dd>
    </div>
  );
}
