import type { MemoryKind, RecallResult } from '../types.js';
import { estimateTokens, truncate } from '../util/text.js';

export interface PackOptions {
  /** Token budget for the assembled block, including headers. */
  budgetTokens: number;
  /**
   * Order sections by kind. Procedural instructions come first because they
   * change how the model behaves; raw episodes come last because they are the
   * cheapest thing to lose to truncation.
   */
  kindOrder?: MemoryKind[];
  /** Emit a `## Section` header per kind. */
  groupByKind?: boolean;
  /** Include the recall score next to each memory. */
  includeScores?: boolean;
  /** Include relative timestamps, e.g. "3d ago". */
  includeTimestamps?: boolean;
  /** Truncate any single memory to this many characters. */
  maxCharsPerMemory?: number;
  /** Text placed above the memories. */
  header?: string;
}

export interface PackedContext {
  /** The assembled block, ready to drop into a system prompt. */
  text: string;
  /** Records that fit, in emission order. */
  included: RecallResult[];
  /** Records dropped for want of budget. */
  dropped: RecallResult[];
  estimatedTokens: number;
  budgetTokens: number;
  /** Fraction of the budget consumed, in [0, 1]. */
  utilization: number;
}

const DEFAULT_KIND_ORDER: MemoryKind[] = ['procedural', 'semantic', 'working', 'episodic'];

const KIND_HEADINGS: Record<MemoryKind, string> = {
  procedural: 'Learned procedures',
  semantic: 'Known facts',
  working: 'Current task state',
  episodic: 'Recent events',
};

/**
 * Assemble recalled memories into a token-bounded prompt block.
 *
 * The budget is the whole point. Recall that returns "the best twelve
 * memories" is not useful to a runtime that has 800 tokens to spend; what it
 * needs is the best set that *fits*. Packing is therefore greedy over the
 * ranked results, with two deliberate choices:
 *
 *   - Sections are emitted in behavioural order, so if truncation bites it
 *     drops raw episodes rather than the procedures that shape the response.
 *   - A memory that does not fit is skipped rather than ending the loop, so a
 *     single long record cannot starve every shorter one behind it.
 */
export function packContext(
  results: RecallResult[],
  options: PackOptions,
): PackedContext {
  const kindOrder = options.kindOrder ?? DEFAULT_KIND_ORDER;
  const groupByKind = options.groupByKind ?? true;
  const maxChars = options.maxCharsPerMemory ?? 400;
  const budget = Math.max(0, options.budgetTokens);
  const now = Date.now();

  const header = options.header ?? 'Relevant memory';
  const lines: string[] = [];
  let used = 0;

  const push = (line: string): boolean => {
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) return false;
    lines.push(line);
    used += cost;
    return true;
  };

  if (header) push(`# ${header}`);

  const included: RecallResult[] = [];
  const dropped: RecallResult[] = [];

  const groups = groupByKind
    ? kindOrder
        .map((kind) => ({
          kind,
          items: results.filter((result) => result.record.kind === kind),
        }))
        .filter((group) => group.items.length > 0)
    : [{ kind: null, items: results }];

  for (const group of groups) {
    let headerWritten = !groupByKind || group.kind === null;
    const heading = group.kind ? `\n## ${KIND_HEADINGS[group.kind]}` : '';

    for (const result of group.items) {
      const body = truncate(result.record.content, maxChars);
      const annotations: string[] = [];
      if (options.includeTimestamps) annotations.push(relativeTime(result.record.createdAt, now));
      if (options.includeScores) annotations.push(`score ${result.score.toFixed(2)}`);
      if (result.record.tags.length > 0) {
        annotations.push(result.record.tags.slice(0, 3).join(', '));
      }
      const suffix = annotations.length > 0 ? `  _(${annotations.join(' · ')})_` : '';
      const line = `- ${body}${suffix}`;

      // The section heading is only paid for once a member actually fits,
      // so an empty section never consumes budget.
      if (!headerWritten) {
        const headingCost = estimateTokens(heading) + 1;
        const lineCost = estimateTokens(line) + 1;
        if (used + headingCost + lineCost > budget) {
          dropped.push(result);
          continue;
        }
        lines.push(heading);
        used += headingCost;
        headerWritten = true;
      }

      if (push(line)) included.push(result);
      else dropped.push(result);
    }
  }

  const text = lines.join('\n').trim();
  return {
    text,
    included,
    dropped,
    estimatedTokens: used,
    budgetTokens: budget,
    utilization: budget > 0 ? Math.min(1, used / budget) : 0,
  };
}

function relativeTime(timestamp: number, now: number): string {
  const delta = Math.max(0, now - timestamp);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`;
}
