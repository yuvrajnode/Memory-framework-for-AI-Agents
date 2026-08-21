export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** Clamp a number into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Map an age in milliseconds onto (0, 1] using exponential decay.
 *
 * `halfLifeMs` is the age at which the score reaches 0.5, which is a more
 * intuitive knob than a raw lambda when tuning recall behaviour.
 */
export function exponentialDecay(ageMs: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0) return 1;
  const age = Math.max(0, ageMs);
  return Math.pow(0.5, age / halfLifeMs);
}

/** Render a duration the way an operator would say it out loud. */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < MINUTE) return `${Math.round(abs / SECOND)}s`;
  if (abs < HOUR) return `${Math.round(abs / MINUTE)}m`;
  if (abs < DAY) return `${Math.round(abs / HOUR)}h`;
  return `${Math.round(abs / DAY)}d`;
}
