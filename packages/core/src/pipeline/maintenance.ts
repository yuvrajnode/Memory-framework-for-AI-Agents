import type { MemoryStore } from '../store/types.js';
import type { MemoryKind, MemoryRecord } from '../types.js';
import type { DecayModel } from './decay.js';

export interface MaintenanceOptions {
  /** Delete records whose TTL has passed. */
  expireTtl?: boolean;
  /** Evict records that have cooled below this retention. 0 disables. */
  staleRetentionThreshold?: number;
  /** Hard cap on live records per namespace. 0 disables. */
  maxRecords?: number;
  /** Kinds that are never evicted, whatever the pressure. */
  protectedKinds?: MemoryKind[];
  /** Records more important than this are never evicted. */
  protectedImportance?: number;
  /** Also drop superseded records once they have cooled. */
  pruneSuperseded?: boolean;
  /** Report what would happen without mutating anything. */
  dryRun?: boolean;
}

export interface MaintenanceReport {
  scanned: number;
  expired: string[];
  evictedStale: string[];
  evictedCapacity: string[];
  prunedSuperseded: string[];
  dryRun: boolean;
}

const DEFAULTS: Required<Omit<MaintenanceOptions, 'protectedKinds'>> & {
  protectedKinds: MemoryKind[];
} = {
  expireTtl: true,
  staleRetentionThreshold: 0.05,
  maxRecords: 0,
  protectedKinds: ['procedural'],
  protectedImportance: 0.9,
  pruneSuperseded: false,
  dryRun: false,
};

/**
 * Garbage collection for a memory store.
 *
 * Three passes, in increasing order of aggression: explicit TTL, retention
 * decay, and finally capacity pressure. Splitting them matters because they
 * answer different questions — "was this always temporary?", "has this gone
 * cold?", and "am I simply out of room?" — and an operator wants to see which
 * one reclaimed a memory.
 *
 * Protection rules apply to the last two passes only: an explicit TTL is a
 * promise the caller made, and is always honoured.
 */
export class MaintenanceRunner {
  private readonly store: MemoryStore;
  private readonly decay: DecayModel;

  constructor(deps: { store: MemoryStore; decay: DecayModel }) {
    this.store = deps.store;
    this.decay = deps.decay;
  }

  async run(namespace: string, options: MaintenanceOptions = {}): Promise<MaintenanceReport> {
    const settings = { ...DEFAULTS, ...options };
    const now = Date.now();
    const report: MaintenanceReport = {
      scanned: 0,
      expired: [],
      evictedStale: [],
      evictedCapacity: [],
      prunedSuperseded: [],
      dryRun: settings.dryRun,
    };

    // excludeExpired/excludeSuperseded are switched off so maintenance can
    // see exactly the records normal queries hide from callers.
    const all = await this.store.query({
      namespace,
      excludeExpired: false,
      excludeSuperseded: false,
    });
    report.scanned = all.length;

    const removed = new Set<string>();

    if (settings.expireTtl) {
      for (const record of all) {
        if (record.expiresAt !== undefined && record.expiresAt <= now) {
          report.expired.push(record.id);
          removed.add(record.id);
        }
      }
    }

    if (settings.pruneSuperseded) {
      for (const record of all) {
        if (removed.has(record.id) || !record.supersededBy) continue;
        // Superseded records are kept while still warm so provenance lookups
        // right after a consolidation still resolve.
        if (this.decay.retention(record, now) < 0.5) {
          report.prunedSuperseded.push(record.id);
          removed.add(record.id);
        }
      }
    }

    const isProtected = (record: MemoryRecord): boolean =>
      settings.protectedKinds.includes(record.kind) ||
      record.importance >= settings.protectedImportance;

    if (settings.staleRetentionThreshold > 0) {
      for (const record of all) {
        if (removed.has(record.id) || record.supersededBy || isProtected(record)) continue;
        if (this.decay.retention(record, now) < settings.staleRetentionThreshold) {
          report.evictedStale.push(record.id);
          removed.add(record.id);
        }
      }
    }

    if (settings.maxRecords > 0) {
      const live = all.filter(
        (record) => !removed.has(record.id) && !record.supersededBy,
      );
      const overflow = live.length - settings.maxRecords;
      if (overflow > 0) {
        // Rank by retention × importance so eviction sheds what is both cold
        // and unimportant, rather than blindly dropping the oldest record.
        const ranked = live
          .filter((record) => !isProtected(record))
          .map((record) => ({
            record,
            value: this.decay.retention(record, now) * (0.25 + record.importance),
          }))
          .sort((a, b) => a.value - b.value);

        for (const { record } of ranked.slice(0, overflow)) {
          report.evictedCapacity.push(record.id);
          removed.add(record.id);
        }
      }
    }

    if (!settings.dryRun && removed.size > 0) {
      await this.store.deleteMany(namespace, [...removed]);
    }
    return report;
  }
}
