import type { MemoryKind } from './types.js';

export const KIND_LABELS: Record<MemoryKind, string> = {
  episodic: 'Episodic',
  semantic: 'Semantic',
  procedural: 'Procedural',
  working: 'Working',
};

export const KIND_DESCRIPTIONS: Record<MemoryKind, string> = {
  episodic: 'Something that happened, at a point in time. Fades over days.',
  semantic: 'A distilled fact or preference. Long lived.',
  procedural: 'A learned routine or repair. Effectively permanent while used.',
  working: 'Scratch state for the task in hand. Expires with it.',
};

export const KIND_ORDER: MemoryKind[] = ['procedural', 'semantic', 'episodic', 'working'];

/** Relative time, phrased the way a person would say it. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const delta = now - timestamp;
  if (delta < 0) return 'scheduled';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

export function absoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Percentage with no decimals, for meters and axis labels. */
export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Split a comma or newline separated tag input into normalised tags. */
export function parseTags(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[,\n]/)
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
