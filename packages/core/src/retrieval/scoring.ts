import {
  DEFAULT_RECALL_WEIGHTS,
  type MemoryRecord,
  type RecallWeights,
  type ScoreBreakdown,
} from '../types.js';
import { DAY, clamp, exponentialDecay } from '../util/time.js';
import { cosineScore } from '../embeddings/vector.js';
import type { DecayModel } from '../pipeline/decay.js';

export interface ScoringContext {
  queryEmbedding?: number[];
  lexicalScores: Map<string, number>;
  weights: RecallWeights;
  decay: DecayModel;
  now: number;
  /** Half-life of the recency signal. Independent of the retention model. */
  recencyHalfLifeMs?: number;
}

const DEFAULT_RECENCY_HALF_LIFE = 3 * DAY;

/** Merge caller-supplied weights over the defaults, dropping non-finite values. */
export function resolveWeights(partial?: Partial<RecallWeights>): RecallWeights {
  if (!partial) return { ...DEFAULT_RECALL_WEIGHTS };
  const merged = { ...DEFAULT_RECALL_WEIGHTS };
  for (const key of Object.keys(merged) as (keyof RecallWeights)[]) {
    const value = partial[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      merged[key] = Math.max(0, value);
    }
  }
  return merged;
}

/**
 * Score one record against a query.
 *
 * Five signals are combined as a weighted mean, then multiplied by the
 * record's retention. The multiplication is the important part: a cold memory
 * is not merely ranked lower, it is suppressed proportionally to how far it
 * has faded — which is what stops a store from surfacing year-old scratch
 * notes just because they happen to share vocabulary with the query.
 */
export function scoreRecord(record: MemoryRecord, context: ScoringContext): {
  score: number;
  breakdown: ScoreBreakdown;
} {
  const { weights, now } = context;

  const semantic =
    context.queryEmbedding && record.embedding && record.embedding.length > 0
      ? cosineScore(context.queryEmbedding, record.embedding)
      : 0;

  const lexical = context.lexicalScores.get(record.id) ?? 0;

  const recency = exponentialDecay(
    Math.max(0, now - record.createdAt),
    context.recencyHalfLifeMs ?? DEFAULT_RECENCY_HALF_LIFE,
  );

  const importance = clamp(record.importance, 0, 1);

  // Saturating so a heavily-used memory cannot crowd out everything else:
  // ten recalls gets roughly 0.7, a hundred roughly 0.9.
  const usage = 1 - 1 / (1 + Math.log1p(record.accessCount));

  const retention = context.decay.retention(record, now);

  const totalWeight =
    weights.semantic + weights.lexical + weights.recency + weights.importance + weights.usage;

  const blended =
    totalWeight === 0
      ? 0
      : (semantic * weights.semantic +
          lexical * weights.lexical +
          recency * weights.recency +
          importance * weights.importance +
          usage * weights.usage) /
        totalWeight;

  return {
    score: clamp(blended * retention, 0, 1),
    breakdown: { semantic, lexical, recency, importance, usage, retention },
  };
}
