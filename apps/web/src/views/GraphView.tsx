import { useEffect, useMemo, useRef, useState } from 'react';
import { Empty, Panel } from '../components/primitives.js';
import { useBackend } from '../lib/backend-context.js';
import { useAsync } from '../lib/use-async.js';
import { KIND_LABELS, KIND_ORDER } from '../lib/format.js';
import { buildLayout, nodeAt, type Layout, type LayoutNode } from '../lib/force-layout.js';
import type { MemoryKind } from '../lib/types.js';

const HEIGHT = 560;

/**
 * The association graph.
 *
 * Rendered to canvas rather than SVG: a few hundred nodes plus their edges is
 * more DOM than is worth creating for a picture that is redrawn on every
 * hover, and canvas keeps the hover feedback instant. Hit-testing is done
 * against the layout directly, which is cheap at this size.
 */
export function GraphView() {
  const { backend, namespace, revision } = useBackend();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [width, setWidth] = useState(900);
  const [hovered, setHovered] = useState<LayoutNode | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  const { data, loading } = useAsync(
    () => backend.graph(namespace, 160),
    [backend, namespace, revision],
  );

  // Track the container width so the layout fills whatever space it is given.
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(320, entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo<Layout | null>(
    () => (data ? buildLayout(data, { width, height: HEIGHT }) : null),
    [data, width],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    draw(canvas, layout, width, hovered);
  }, [layout, width, hovered]);

  const connectedIds = useMemo(() => {
    if (!hovered || !layout) return new Set<string>();
    const ids = new Set<string>();
    for (const edge of layout.edges) {
      if (edge.source.id === hovered.id) ids.add(edge.target.id);
      if (edge.target.id === hovered.id) ids.add(edge.source.id);
    }
    return ids;
  }, [hovered, layout]);

  const isEmpty = !loading && (!data || data.nodes.length === 0);
  const noEdges = data && data.nodes.length > 0 && data.edges.length === 0;

  return (
    <div className="stack">
      <p className="page__lede">
        Edges are written automatically at ingest time from two independent signals:
        vector similarity, and shared entities such as identifiers, people and URLs.
        They fail in different places — similarity misses two notes that share only an
        order id, entity overlap misses two paraphrases with no proper nouns — so both
        run.
      </p>

      <Panel
        title={
          data
            ? `${data.nodes.length} nodes · ${data.edges.length} edges`
            : 'Loading…'
        }
        action={<Legend />}
        footer={
          hovered ? (
            <span className="small">
              <strong>{hovered.label}</strong>
              <span className="faint">
                {' '}· {KIND_LABELS[hovered.kind as MemoryKind] ?? hovered.kind} ·{' '}
                {hovered.degree} {hovered.degree === 1 ? 'edge' : 'edges'}
              </span>
            </span>
          ) : (
            <span className="xs faint">
              Hover a node to isolate its neighbourhood. Node size tracks importance and
              degree.
            </span>
          )
        }
      >
        <div ref={wrapperRef} style={{ position: 'relative' }}>
          {isEmpty && (
            <Empty
              title="No graph yet"
              body="Write a few related memories and edges will appear as the engine links them."
            />
          )}

          {noEdges && (
            <p className="small muted" style={{ marginBottom: 'var(--s3)' }}>
              These memories are stored but none are related closely enough to link.
              Try writing two notes that mention the same person, ticket or system.
            </p>
          )}

          {!isEmpty && (
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={`Association graph with ${data?.nodes.length ?? 0} memories`}
              style={{ width: '100%', height: HEIGHT, display: 'block', cursor: hovered ? 'pointer' : 'default' }}
              onMouseMove={(event) => {
                if (!layout) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const y = event.clientY - rect.top;
                setPointer({ x, y });
                setHovered(nodeAt(layout, x, y));
              }}
              onMouseLeave={() => {
                setHovered(null);
                setPointer(null);
              }}
            />
          )}

          {hovered && pointer && (
            <div
              className="graph-tooltip"
              style={{
                left: Math.min(pointer.x + 14, width - 260),
                top: Math.max(8, pointer.y - 12),
              }}
            >
              <span className={`badge badge--${hovered.kind}`}>
                {KIND_LABELS[hovered.kind as MemoryKind] ?? hovered.kind}
              </span>
              <p className="xs" style={{ marginTop: 6 }}>
                {hovered.label}
              </p>
              <p className="xs faint tabular" style={{ marginTop: 4 }}>
                importance {hovered.importance.toFixed(2)} ·{' '}
                {connectedIds.size} connected
              </p>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

function Legend() {
  return (
    <div className="row row--tight row--wrap">
      {KIND_ORDER.map((kind) => (
        <span key={kind} className="row row--tight xs faint">
          <span
            className="dot"
            style={{ background: `var(--kind-${kind})` }}
            aria-hidden="true"
          />
          {KIND_LABELS[kind]}
        </span>
      ))}
    </div>
  );
}

/** Read a CSS custom property so the canvas follows the active theme. */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function draw(
  canvas: HTMLCanvasElement,
  layout: Layout,
  width: number,
  hovered: LayoutNode | null,
): void {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = HEIGHT * ratio;

  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, HEIGHT);

  const rule = token('--rule-strong', '#d3ccbc');
  const ink = token('--ink', '#17150f');
  const faint = token('--ink-faint', '#948d7e');
  const accent = token('--accent', '#be4b27');

  const connected = new Set<string>();
  if (hovered) {
    connected.add(hovered.id);
    for (const edge of layout.edges) {
      if (edge.source.id === hovered.id) connected.add(edge.target.id);
      if (edge.target.id === hovered.id) connected.add(edge.source.id);
    }
  }

  for (const edge of layout.edges) {
    const active =
      !hovered || edge.source.id === hovered.id || edge.target.id === hovered.id;
    context.beginPath();
    context.moveTo(edge.source.x, edge.source.y);
    context.lineTo(edge.target.x, edge.target.y);
    context.strokeStyle = active ? (hovered ? accent : rule) : rule;
    context.globalAlpha = active ? 0.25 + edge.weight * 0.55 : 0.08;
    context.lineWidth = active && hovered ? 1.6 : 1;
    context.stroke();
  }
  context.globalAlpha = 1;

  for (const node of layout.nodes) {
    const dimmed = hovered !== null && !connected.has(node.id);
    context.globalAlpha = dimmed ? 0.2 : 1;

    context.beginPath();
    context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    context.fillStyle = token(`--kind-${node.kind}`, faint);
    context.fill();

    if (hovered?.id === node.id) {
      context.lineWidth = 2;
      context.strokeStyle = ink;
      context.stroke();
    }
  }

  drawLabels(context, layout, hovered, connected, faint, ink);
  context.globalAlpha = 1;
}

interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Label pass, run after every node is drawn.
 *
 * Labels are placed greedily in order of prominence and any that would
 * overlap an already-placed one is dropped. Without this the picture degrades
 * into overstruck text the moment a graph gets dense — better to name the
 * dozen memories that matter than to name all of them illegibly.
 */
function drawLabels(
  context: CanvasRenderingContext2D,
  layout: Layout,
  hovered: LayoutNode | null,
  connected: Set<string>,
  faint: string,
  ink: string,
): void {
  context.font = '11px ui-monospace, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'top';

  const ranked = [...layout.nodes].sort(
    (a, b) =>
      Number(hovered?.id === b.id) - Number(hovered?.id === a.id) ||
      b.importance + b.degree * 0.1 - (a.importance + a.degree * 0.1),
  );

  const placed: LabelBox[] = [];

  for (const node of ranked) {
    if (hovered !== null && !connected.has(node.id)) continue;

    const label = node.label.length > 26 ? `${node.label.slice(0, 26)}…` : node.label;
    const width = context.measureText(label).width;
    const box: LabelBox = {
      left: node.x - width / 2 - 3,
      right: node.x + width / 2 + 3,
      top: node.y + node.radius + 4,
      bottom: node.y + node.radius + 17,
    };

    const collides = placed.some(
      (other) =>
        box.left < other.right &&
        box.right > other.left &&
        box.top < other.bottom &&
        box.bottom > other.top,
    );
    if (collides) continue;

    placed.push(box);
    context.fillStyle = hovered?.id === node.id ? ink : faint;
    context.fillText(label, node.x, box.top);
  }
}
