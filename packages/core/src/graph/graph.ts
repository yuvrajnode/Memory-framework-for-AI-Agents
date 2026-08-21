import { recordSimilarity } from '../pipeline/clustering.js';
import type { MemoryStore } from '../store/types.js';
import type { MemoryLink, MemoryRecord } from '../types.js';
import { createId } from '../util/id.js';
import { entityOverlap, extractEntities } from './entities.js';

export interface LinkOptions {
  /** Semantic similarity above which two memories are linked. */
  similarityThreshold?: number;
  /** Entity overlap above which two memories are linked. */
  entityThreshold?: number;
  /** Maximum edges created per record, keeping the graph readable. */
  maxLinksPerRecord?: number;
  /** Records compared against when linking. */
  candidateLimit?: number;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: MemoryRecord['kind'];
  importance: number;
  createdAt: number;
  /** Number of edges touching this node. */
  degree: number;
  tags: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight: number;
}

export interface MemoryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const DEFAULTS = {
  similarityThreshold: 0.72,
  entityThreshold: 0.5,
  maxLinksPerRecord: 5,
  candidateLimit: 250,
};

/**
 * Associative links between memories.
 *
 * Vector recall answers "what resembles this query". A graph answers the
 * different and often more useful question "what else came up around this",
 * which is how an agent follows a thread from a symptom to the fix it found
 * three sessions ago. Edges are built from two independent signals — dense
 * similarity and shared entities — because they fail in different places:
 * similarity misses two notes that share only an order id, entity overlap
 * misses two paraphrases with no proper nouns at all.
 */
export class GraphBuilder {
  private readonly store: MemoryStore;

  constructor(deps: { store: MemoryStore }) {
    this.store = deps.store;
  }

  /** Link one record against the recent neighbourhood. Returns new edges. */
  async linkRecord(record: MemoryRecord, options: LinkOptions = {}): Promise<MemoryLink[]> {
    const settings = { ...DEFAULTS, ...options };
    const candidates = await this.store.query(
      { namespace: record.namespace },
      { limit: settings.candidateLimit, orderBy: 'createdAt', direction: 'desc' },
    );

    const scored: { candidate: MemoryRecord; weight: number; relation: string }[] = [];
    for (const candidate of candidates) {
      if (candidate.id === record.id) continue;

      const similarity = recordSimilarity(record, candidate);
      if (similarity >= settings.similarityThreshold) {
        scored.push({ candidate, weight: similarity, relation: 'similar-to' });
        continue;
      }
      const overlap = entityOverlap(record.content, candidate.content);
      if (overlap >= settings.entityThreshold) {
        scored.push({ candidate, weight: overlap, relation: 'mentions-same' });
      }
    }

    const created: MemoryLink[] = [];
    for (const { candidate, weight, relation } of scored
      .sort((a, b) => b.weight - a.weight)
      .slice(0, settings.maxLinksPerRecord)) {
      // Ordering the endpoints makes the edge id stable, so re-linking a
      // record updates the existing edge rather than duplicating it.
      const [from, to] =
        record.id < candidate.id ? [record.id, candidate.id] : [candidate.id, record.id];
      const link: MemoryLink = {
        id: `lnk_${from}_${to}`,
        namespace: record.namespace,
        fromId: from,
        toId: to,
        relation,
        weight: Number(weight.toFixed(4)),
        createdAt: Date.now(),
      };
      created.push(await this.store.addLink(link));
    }
    return created;
  }

  /** Manually assert an edge, e.g. "caused-by" or "contradicts". */
  async connect(
    namespace: string,
    fromId: string,
    toId: string,
    relation: string,
    weight = 1,
  ): Promise<MemoryLink> {
    return this.store.addLink({
      id: createId('lnk'),
      namespace,
      fromId,
      toId,
      relation,
      weight,
      createdAt: Date.now(),
    });
  }

  /**
   * Breadth-first walk from a seed memory.
   *
   * Edge weight attenuates with each hop, so a second-degree neighbour has to
   * be strongly connected to compete with a direct one.
   */
  async neighborhood(
    namespace: string,
    memoryId: string,
    depth = 1,
    limit = 25,
  ): Promise<{ record: MemoryRecord; distance: number; weight: number }[]> {
    const visited = new Map<string, { distance: number; weight: number }>();
    let frontier: { id: string; weight: number }[] = [{ id: memoryId, weight: 1 }];
    visited.set(memoryId, { distance: 0, weight: 1 });

    for (let distance = 1; distance <= depth && frontier.length > 0; distance += 1) {
      const next: { id: string; weight: number }[] = [];
      for (const node of frontier) {
        for (const link of await this.store.listLinks(namespace, node.id)) {
          const neighbor = link.fromId === node.id ? link.toId : link.fromId;
          const weight = node.weight * link.weight * 0.8;
          const seen = visited.get(neighbor);
          if (seen && seen.weight >= weight) continue;
          visited.set(neighbor, { distance, weight });
          next.push({ id: neighbor, weight });
        }
      }
      frontier = next;
    }

    visited.delete(memoryId);
    const ranked = [...visited.entries()]
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, limit);

    const records = await this.store.getMany(
      namespace,
      ranked.map(([id]) => id),
    );
    const byId = new Map(records.map((record) => [record.id, record]));

    return ranked
      .map(([id, meta]) => {
        const record = byId.get(id);
        return record ? { record, distance: meta.distance, weight: meta.weight } : null;
      })
      .filter((entry): entry is { record: MemoryRecord; distance: number; weight: number } =>
        entry !== null,
      );
  }

  /** Snapshot the namespace as a graph, ready for visualisation. */
  async snapshot(namespace: string, limit = 150): Promise<MemoryGraph> {
    const records = await this.store.query(
      { namespace },
      { limit, orderBy: 'importance', direction: 'desc' },
    );
    const present = new Set(records.map((record) => record.id));
    const links = await this.store.listLinks(namespace);

    const edges: GraphEdge[] = links
      .filter((link) => present.has(link.fromId) && present.has(link.toId))
      .map((link) => ({
        id: link.id,
        source: link.fromId,
        target: link.toId,
        relation: link.relation,
        weight: link.weight,
      }));

    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }

    const nodes: GraphNode[] = records.map((record) => ({
      id: record.id,
      label: labelFor(record),
      kind: record.kind,
      importance: record.importance,
      createdAt: record.createdAt,
      degree: degree.get(record.id) ?? 0,
      tags: record.tags,
    }));

    return { nodes, edges };
  }
}

/** A short, human-readable handle for a record in a graph view. */
function labelFor(record: MemoryRecord): string {
  const entity = extractEntities(record.content, 1)[0];
  if (entity && entity.label.length <= 32) return entity.label;
  const words = record.content.split(/\s+/).slice(0, 6).join(' ');
  return words.length > 44 ? `${words.slice(0, 44)}…` : words;
}
