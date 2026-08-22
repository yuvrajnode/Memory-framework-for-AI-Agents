import type { MemoryGraph } from './types.js';

export interface LayoutNode {
  id: string;
  label: string;
  kind: string;
  importance: number;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

export interface LayoutEdge {
  source: LayoutNode;
  target: LayoutNode;
  weight: number;
  relation: string;
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

/**
 * A small force-directed layout.
 *
 * Written rather than imported: d3-force is 20kB for three forces, and a
 * graph of at most a few hundred memory nodes does not need quadtree
 * approximation. Repulsion is O(n²) and honest about it — at this size that
 * is a fraction of a millisecond per tick.
 */
export interface ForceOptions {
  width: number;
  height: number;
  /** Ideal edge length. */
  linkDistance?: number;
  /** Strength of node-node repulsion. */
  charge?: number;
  /** Pull toward the centre, which keeps disconnected nodes on screen. */
  gravity?: number;
  iterations?: number;
}

export function buildLayout(graph: MemoryGraph, options: ForceOptions): Layout {
  const {
    width,
    height,
    linkDistance = 78,
    // Tuned empirically against node counts from 8 to 160: below roughly
    // 12000 the centring force wins and the graph collapses into an
    // illegible ball, and above 20000 sparse graphs pin themselves to the
    // canvas edges.
    charge = 16000,
    gravity = 0.03,
    iterations = 320,
  } = options;

  const centerX = width / 2;
  const centerY = height / 2;

  // Seeding on a circle rather than at random makes the layout deterministic:
  // the same graph always settles the same way, so a re-render does not
  // reshuffle the picture the operator was reading.
  const nodes: LayoutNode[] = graph.nodes.map((node, index) => {
    const angle = (index / Math.max(1, graph.nodes.length)) * Math.PI * 2;
    const spread = Math.min(width, height) * 0.32;
    return {
      id: node.id,
      label: node.label,
      kind: node.kind,
      importance: node.importance,
      degree: node.degree,
      x: centerX + Math.cos(angle) * spread,
      y: centerY + Math.sin(angle) * spread,
      vx: 0,
      vy: 0,
      radius: 5 + node.importance * 7 + Math.min(node.degree, 6) * 0.9,
    };
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: LayoutEdge[] = [];
  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source && target) {
      edges.push({ source, target, weight: edge.weight, relation: edge.relation });
    }
  }

  for (let step = 0; step < iterations; step += 1) {
    // Cooling: large early moves to escape the seed ring, small late ones so
    // the final frame is stable rather than jittering.
    const alpha = 1 - step / iterations;

    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distanceSq = dx * dx + dy * dy;
        if (distanceSq < 0.01) {
          // Perfectly coincident nodes have no direction to separate along,
          // so nudge them apart deterministically by index.
          dx = (i % 2 === 0 ? 1 : -1) * 0.5;
          dy = (j % 2 === 0 ? 1 : -1) * 0.5;
          distanceSq = dx * dx + dy * dy;
        }
        const distance = Math.sqrt(distanceSq);
        // Capped, because an inverse-square force at very short range would
        // otherwise fling coincident nodes off the canvas in a single tick.
        const force = Math.min(charge / distanceSq, 40) * alpha;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    for (const edge of edges) {
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const distance = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
      // Stronger edges pull harder, so tightly related memories cluster.
      const strength = ((distance - linkDistance) / distance) * 0.08 * edge.weight * alpha;
      const fx = dx * strength;
      const fy = dy * strength;
      edge.source.vx += fx;
      edge.source.vy += fy;
      edge.target.vx -= fx;
      edge.target.vy -= fy;
    }

    for (const node of nodes) {
      node.vx += (centerX - node.x) * gravity * alpha;
      node.vy += (centerY - node.y) * gravity * alpha;

      node.vx *= 0.82;
      node.vy *= 0.82;
      node.x += node.vx;
      node.y += node.vy;

      // Keep everything inside the viewport, radius included.
      const margin = node.radius + 24;
      node.x = Math.max(margin, Math.min(width - margin, node.x));
      node.y = Math.max(margin, Math.min(height - margin, node.y));
    }
  }

  return { nodes, edges };
}

/** Nearest node to a point, within its own radius plus a touch target. */
export function nodeAt(layout: Layout, x: number, y: number): LayoutNode | null {
  let best: LayoutNode | null = null;
  let bestDistance = Infinity;
  for (const node of layout.nodes) {
    const dx = node.x - x;
    const dy = node.y - y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance <= node.radius + 8 && distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}
