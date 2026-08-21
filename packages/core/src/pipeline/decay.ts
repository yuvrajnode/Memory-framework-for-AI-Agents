import type { MemoryKind, MemoryRecord } from '../types.js';
import { DAY, HOUR, clamp, exponentialDecay } from '../util/time.js';

/** Base half-life per memory kind, in milliseconds. */
export type DecayProfile = Record<MemoryKind, number>;

/**
 * Defaults chosen to mirror how the four kinds are actually used:
 * working memory is scratch state for one task, episodes fade over days,
 * distilled facts persist for months, and learned procedures effectively
 * do not decay unless they stop being used.
 */
export const DEFAULT_DECAY_PROFILE: DecayProfile = {
  working: 2 * HOUR,
  episodic: 7 * DAY,
  semantic: 120 * DAY,
  procedural: 365 * DAY,
};

export interface DecayOptions {
  profile?: Partial<DecayProfile>;
  /**
   * How much importance extends a half-life. At 1.0, a maximally important
   * record lives twice as long as a neutral one.
   */
  importanceBoost?: number;
  /**
   * How much repeated recall extends a half-life, modelling the spacing
   * effect. Applied to log(1 + accessCount) so the first few recalls matter
   * far more than the fiftieth.
   */
  usageBoost?: number;
  /** Records never decay below this floor, so nothing becomes unrecallable. */
  floor?: number;
}

const DEFAULTS: Required<Omit<DecayOptions, 'profile'>> = {
  importanceBoost: 1,
  usageBoost: 0.6,
  floor: 0.02,
};

/**
 * Ebbinghaus-style forgetting.
 *
 * Retention is an exponential decay on the time since a record was last
 * *touched* — created or recalled — rather than since creation. Recall
 * therefore reinforces a memory, which is the behaviour that makes a store
 * self-curating: what an agent keeps using stays warm, and what it never
 * revisits cools until eviction reclaims it.
 */
export class DecayModel {
  private readonly profile: DecayProfile;
  private readonly importanceBoost: number;
  private readonly usageBoost: number;
  private readonly floor: number;

  constructor(options: DecayOptions = {}) {
    this.profile = { ...DEFAULT_DECAY_PROFILE, ...options.profile };
    this.importanceBoost = options.importanceBoost ?? DEFAULTS.importanceBoost;
    this.usageBoost = options.usageBoost ?? DEFAULTS.usageBoost;
    this.floor = options.floor ?? DEFAULTS.floor;
  }

  /** The effective half-life of a record after importance and usage boosts. */
  halfLifeFor(record: MemoryRecord): number {
    const base = this.profile[record.kind] ?? DEFAULT_DECAY_PROFILE.episodic;
    const importanceFactor = 1 + this.importanceBoost * clamp(record.importance, 0, 1);
    const usageFactor = 1 + this.usageBoost * Math.log1p(record.accessCount);
    return base * importanceFactor * usageFactor;
  }

  /** Retention in [floor, 1]: 1 is freshly touched, near-floor is cold. */
  retention(record: MemoryRecord, now: number = Date.now()): number {
    const lastTouched = Math.max(record.lastAccessedAt, record.createdAt);
    const age = Math.max(0, now - lastTouched);
    const value = exponentialDecay(age, this.halfLifeFor(record));
    return clamp(Math.max(value, this.floor), 0, 1);
  }

  /** True once a record has cooled past `threshold` and is eviction-eligible. */
  isStale(record: MemoryRecord, threshold: number, now: number = Date.now()): boolean {
    return this.retention(record, now) < threshold;
  }

  /**
   * When a record will cool to `target`, as an epoch timestamp. Useful for
   * scheduling maintenance instead of polling every record continuously.
   */
  projectedTime(record: MemoryRecord, target: number, now: number = Date.now()): number {
    const clamped = clamp(target, this.floor, 1);
    if (clamped >= 1) return now;
    const lastTouched = Math.max(record.lastAccessedAt, record.createdAt);
    const halfLives = Math.log(clamped) / Math.log(0.5);
    return lastTouched + halfLives * this.halfLifeFor(record);
  }
}
