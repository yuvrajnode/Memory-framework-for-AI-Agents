import type {
  MemoryFilter,
  MemoryGraph,
  MemoryInput,
  MemoryKind,
  MemoryRecord,
  MemoryStats,
  RecallOptions,
  ScoreBreakdown,
} from '@mnemos/core';

export type { MemoryFilter, MemoryGraph, MemoryInput, MemoryKind, MemoryRecord, MemoryStats, RecallOptions, ScoreBreakdown };

/** A record as the UI consumes it: embeddings stripped, retention resolved. */
export interface MemoryView extends Omit<MemoryRecord, 'embedding'> {
  retention: number;
  embeddingDimensions?: number;
}

export interface RankedMemory {
  memory: MemoryView;
  score: number;
  breakdown: ScoreBreakdown;
}

export interface ContextResult {
  text: string;
  estimatedTokens: number;
  budgetTokens: number;
  utilization: number;
  included: { id: string; kind: MemoryKind; score: number }[];
  droppedCount: number;
}

export interface ListResult {
  total: number;
  memories: MemoryView[];
}

export interface ConsolidationResult {
  examined: number;
  clusters: number;
  created: { id: string; content: string; derivedFrom: string[] }[];
  superseded: number;
  deleted: number;
}

export interface MaintenanceResult {
  scanned: number;
  expired: string[];
  evictedStale: string[];
  evictedCapacity: string[];
  prunedSuperseded: string[];
  dryRun: boolean;
}

export interface ListParams {
  namespace?: string;
  kinds?: MemoryKind[];
  tags?: string[];
  search?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'createdAt' | 'importance' | 'lastAccessedAt' | 'accessCount';
  direction?: 'asc' | 'desc';
}

/**
 * What the UI needs from a memory system, regardless of where it runs.
 *
 * Both the in-browser engine and the REST client implement this, which is
 * what lets the dashboard be a genuine static deploy: with no API reachable
 * it runs the real framework locally instead of showing a broken screen.
 */
export interface Backend {
  readonly kind: 'local' | 'remote';
  readonly label: string;

  remember(input: MemoryInput): Promise<MemoryView>;
  rememberMany(inputs: MemoryInput[]): Promise<number>;
  list(params: ListParams): Promise<ListResult>;
  recall(query: string, options: RecallOptions & { namespace?: string }): Promise<RankedMemory[]>;
  buildContext(
    query: string,
    options: { budgetTokens: number; namespace?: string; limit?: number; diversity?: number },
  ): Promise<ContextResult>;
  update(
    id: string,
    changes: { content?: string; importance?: number; tags?: string[]; kind?: MemoryKind },
    namespace?: string,
  ): Promise<MemoryView>;
  forget(id: string, namespace?: string): Promise<void>;
  stats(namespace?: string): Promise<MemoryStats>;
  namespaces(): Promise<{ namespace: string; count: number }[]>;
  graph(namespace?: string, limit?: number): Promise<MemoryGraph>;
  consolidate(namespace?: string): Promise<ConsolidationResult>;
  maintain(namespace: string | undefined, options: { dryRun?: boolean; maxRecords?: number }): Promise<MaintenanceResult>;
  clear(namespace?: string): Promise<number>;
}
