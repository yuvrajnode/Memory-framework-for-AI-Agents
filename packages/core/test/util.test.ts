import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  fingerprint,
  jaccard,
  splitSentences,
  tokenize,
  truncate,
} from '../src/util/text.js';
import { createId } from '../src/util/id.js';
import { clamp, exponentialDecay, formatDuration } from '../src/util/time.js';

describe('tokenize', () => {
  it('keeps identifiers intact instead of shattering them', () => {
    expect(tokenize('call POST /v2/orders with user_id=42')).toContain('user_id');
    expect(tokenize('call POST /v2/orders with user_id=42')).toContain('v2/orders');
  });

  it('drops stop words and single characters', () => {
    expect(tokenize('the a of it deploy')).toEqual(['deploy']);
  });

  it('retains negation, which carries meaning in agent memories', () => {
    expect(tokenize('do not retry the request')).toContain('not');
  });
});

describe('fingerprint', () => {
  it('collapses casing and whitespace differences', () => {
    expect(fingerprint('Dark  Mode  Preferred')).toBe(fingerprint('dark mode preferred'));
  });

  it('separates genuinely different content', () => {
    expect(fingerprint('dark mode')).not.toBe(fingerprint('light mode'));
  });
});

describe('jaccard', () => {
  it('scores restatements highly', () => {
    expect(jaccard('user prefers dark mode', 'the user prefers dark mode')).toBeGreaterThan(0.9);
  });

  it('scores unrelated text near zero', () => {
    expect(jaccard('deploy on friday', 'the cat sat quietly')).toBe(0);
  });

  it('treats two empty strings as identical', () => {
    expect(jaccard('', '')).toBe(1);
  });
});

describe('estimateTokens', () => {
  it('returns zero for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('never undercounts word-dense text', () => {
    const text = 'a b c d e f g h';
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(8);
  });
});

describe('splitSentences', () => {
  it('keeps terminal punctuation attached', () => {
    expect(splitSentences('One thing. Two things! Three?')).toEqual([
      'One thing.',
      'Two things!',
      'Three?',
    ]);
  });
});

describe('truncate', () => {
  it('leaves short strings untouched', () => {
    expect(truncate('short', 20)).toBe('short');
  });

  it('cuts on a word boundary and marks the elision', () => {
    const result = truncate('the quick brown fox jumps over', 16);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(17);
  });
});

describe('createId', () => {
  it('sorts chronologically as a plain string', async () => {
    const first = createId();
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = createId();
    expect(first < second).toBe(true);
  });

  it('is unique across a tight loop', () => {
    const ids = new Set(Array.from({ length: 500 }, () => createId()));
    expect(ids.size).toBe(500);
  });
});

describe('time helpers', () => {
  it('halves at exactly one half-life', () => {
    expect(exponentialDecay(1000, 1000)).toBeCloseTo(0.5, 10);
  });

  it('clamps NaN to the lower bound rather than propagating it', () => {
    expect(clamp(Number.NaN, 0, 1)).toBe(0);
  });

  it('formats durations at human scale', () => {
    expect(formatDuration(90_000)).toBe('2m');
    expect(formatDuration(3 * 24 * 3600 * 1000)).toBe('3d');
  });
});
