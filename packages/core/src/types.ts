/**
 * Core domain model for Mnemos.
 *
 * The framework models agent memory after the coarse divisions used in
 * cognitive psychology, because those divisions map cleanly onto operational
 * decisions an agent runtime actually has to make: what to keep verbatim,
 * what to compress, what to expire, and what to always keep in context.
 */

/**
 * The kind of memory a record holds. Kinds differ in how they decay, how they
 * are consolidated, and how heavily they are weighted at recall time.
 */
export type MemoryKind =
  /** A timestamped record of something that happened. Decays fastest. */
  | 'episodic'
  /** A distilled fact or preference. Long lived, promoted from episodes. */
  | 'semantic'
  /** A learned how-to: a routine, a workflow, a repair for a known failure. */
  | 'procedural'
  /** Scratch state scoped to the current task. Expires with the task. */
  | 'working';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'episodic',
  'semantic',
  'procedural',
  'working',
];

/** Where a memory came from, used for provenance and trust weighting. */
export type MemorySource = 'user' | 'agent' | 'tool' | 'system' | 'import';

export const MEMORY_SOURCES: readonly MemorySource[] = [
  'user',
  'agent',
  'tool',
  'system',
  'import',
];

/** Arbitrary user-supplied metadata. Values stay JSON-serialisable. */
export type Metadata = Record<string, string | number | boolean | null>;

/**
 * A single unit of memory.
 *
 * Records are immutable in spirit: `content` edits produce a new embedding and
 * bump `updatedAt`, while access bookkeeping (`lastAccessedAt`, `accessCount`)
 * is maintained by the engine rather than by callers.
 */
export interface MemoryRecord {
  /** Stable identifier, unique within a namespace. */
  id: string;
  /** Tenancy boundary. Recall never crosses namespaces. */
  namespace: string;
  /** The agent or session this memory belongs to, if scoped. */
  agentId?: string;
  kind: MemoryKind;
  source: MemorySource;
  /** The memory itself, as natural language. */
  content: string;
  /** Dense vector used for semantic recall. Length matches the embedder. */
  embedding?: number[];
  /** Free-form labels used for hard filtering. */
  tags: string[];
  metadata: Metadata;
  /**
   * Caller-assigned salience in [0, 1]. Importance resists decay and boosts
   * recall; it is the main lever an agent has over what it keeps.
   */
  importance: number;
  /** Epoch millis. */
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  /** How many times this record has been returned by a recall. */
  accessCount: number;
  /** Epoch millis after which the record is eligible for hard deletion. */
  expiresAt?: number;
  /** Ids of records this one was distilled from, if consolidated. */
  derivedFrom?: string[];
  /** Set when a consolidation superseded this record. */
  supersededBy?: string;
  /** Content hash used for near-duplicate suppression. */
  fingerprint: string;
}

/** The payload accepted when writing a new memory. */
export interface MemoryInput {
  content: string;
  kind?: MemoryKind;
  source?: MemorySource;
  namespace?: string;
  agentId?: string;
  tags?: string[];
  metadata?: Metadata;
  importance?: number;
  /** Time-to-live in milliseconds, relative to write time. */
  ttlMs?: number;
  /** Override the generated id, e.g. when importing. */
  id?: string;
  /** Override the write timestamp, e.g. when backfilling history. */
  createdAt?: number;
}

/** Hard filters applied before scoring. */
export interface MemoryFilter {
  namespace?: string;
  agentId?: string;
  kinds?: MemoryKind[];
  sources?: MemorySource[];
  /** A record matches if it carries every listed tag. */
  tags?: string[];
  /** A record matches if it carries at least one listed tag. */
  anyTags?: string[];
  createdAfter?: number;
  createdBefore?: number;
  minImportance?: number;
  /** Exclude records that a consolidation has replaced. Defaults to true. */
  excludeSuperseded?: boolean;
  /** Exclude records past their TTL. Defaults to true. */
  excludeExpired?: boolean;
}

/** Relative weights applied to each recall signal. Need not sum to one. */
export interface RecallWeights {
  /** Cosine similarity between the query and the record embedding. */
  semantic: number;
  /** BM25 lexical overlap, which rescues exact names and identifiers. */
  lexical: number;
  /** Exponential recency, so fresh context wins ties. */
  recency: number;
  /** Caller-assigned salience. */
  importance: number;
  /** Reinforcement from prior successful recalls. */
  usage: number;
}

export const DEFAULT_RECALL_WEIGHTS: RecallWeights = {
  semantic: 1,
  lexical: 0.45,
  recency: 0.25,
  importance: 0.35,
  usage: 0.15,
};

export interface RecallOptions {
  /** Maximum number of records to return. */
  limit?: number;
  filter?: MemoryFilter;
  weights?: Partial<RecallWeights>;
  /** Drop candidates whose final score falls below this threshold. */
  minScore?: number;
  /**
   * Diversity of the result set in [0, 1]. Zero returns the highest scoring
   * records even if they repeat each other; higher values trade a little
   * relevance for coverage using Maximal Marginal Relevance.
   */
  diversity?: number;
  /**
   * How many candidates to score before reranking. Larger values improve
   * recall quality at a linear cost.
   */
  candidatePool?: number;
  /** Record the recall as an access, reinforcing the returned memories. */
  reinforce?: boolean;
}

/** The per-signal breakdown behind a recall score, kept for explainability. */
export interface ScoreBreakdown {
  semantic: number;
  lexical: number;
  recency: number;
  importance: number;
  usage: number;
  /** Multiplicative decay factor applied to the blended score. */
  retention: number;
}

export interface RecallResult {
  record: MemoryRecord;
  /** Final blended score in roughly [0, 1]. */
  score: number;
  breakdown: ScoreBreakdown;
}

/** A typed edge between two memories or entities. */
export interface MemoryLink {
  id: string;
  namespace: string;
  fromId: string;
  toId: string;
  relation: string;
  weight: number;
  createdAt: number;
}

/** Aggregate counters describing the state of a namespace. */
export interface MemoryStats {
  total: number;
  byKind: Record<MemoryKind, number>;
  bySource: Record<MemorySource, number>;
  averageImportance: number;
  /** Mean retention across live records, i.e. how "warm" the store is. */
  averageRetention: number;
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
  totalAccesses: number;
  links: number;
  /** Approximate token footprint of all stored content. */
  approximateTokens: number;
}
