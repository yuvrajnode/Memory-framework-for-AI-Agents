import { tokenize } from '../util/text.js';

export interface Entity {
  /** Canonical lowercase form, used for matching. */
  key: string;
  /** Surface form as it appeared in the text. */
  label: string;
  type: EntityType;
  /** Occurrence count within the analysed text. */
  count: number;
}

export type EntityType =
  | 'person'
  | 'organization'
  | 'identifier'
  | 'url'
  | 'email'
  | 'date'
  | 'concept';

const TITLE_CASE = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,3})\b/g;
const URL = /\bhttps?:\/\/[^\s<>"')]+/g;
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const IDENTIFIER = /\b(?:[a-z]+[_-][a-z0-9_-]{2,}|[A-Z]{2,}-\d+|v\d+(?:\.\d+)+)\b/g;
const DATE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/g;

/**
 * Words that pass the title-case heuristic but are almost never entities.
 * Sentence-initial capitalisation is the main source of noise here.
 */
const TITLE_CASE_STOP = new Set([
  'The', 'This', 'That', 'These', 'Those', 'There', 'Then', 'They', 'When',
  'While', 'Where', 'What', 'Which', 'After', 'Before', 'Because', 'However',
  'Also', 'Since', 'Should', 'Would', 'Could', 'Please', 'Note', 'User',
  'Agent', 'System',
]);

const ORG_SUFFIX = /\b(inc|llc|ltd|corp|gmbh|labs?|technologies|systems|group)\b/i;

/**
 * Lightweight entity extraction.
 *
 * Rule-based on purpose. A memory framework should not require a model just
 * to index memories, and the high-value entities in agent memory — ids, URLs,
 * emails, version strings, proper nouns — are exactly the ones regular
 * expressions handle reliably. Callers wanting model-grade NER can extract
 * their own entities and pass them as tags.
 */
export function extractEntities(text: string, limit = 12): Entity[] {
  const found = new Map<string, Entity>();

  const record = (label: string, type: EntityType) => {
    const key = label.toLowerCase().trim();
    if (!key) return;
    const existing = found.get(key);
    if (existing) {
      existing.count += 1;
      // A more specific type wins over the generic concept fallback.
      if (existing.type === 'concept' && type !== 'concept') existing.type = type;
      return;
    }
    found.set(key, { key, label: label.trim(), type, count: 1 });
  };

  for (const match of text.matchAll(URL)) record(match[0], 'url');
  for (const match of text.matchAll(EMAIL)) record(match[0], 'email');
  for (const match of text.matchAll(DATE)) record(match[0], 'date');
  for (const match of text.matchAll(IDENTIFIER)) record(match[0], 'identifier');

  for (const match of text.matchAll(TITLE_CASE)) {
    const label = match[1]!;
    const firstWord = label.split(/\s+/)[0]!;
    if (TITLE_CASE_STOP.has(firstWord)) continue;
    // A capitalised word at the very start of the text is ambiguous, so it
    // only counts when it recurs elsewhere.
    if (match.index === 0 && !label.includes(' ')) continue;
    record(label, ORG_SUFFIX.test(label) ? 'organization' : 'person');
  }

  // Frequent salient terms round out the set when the text has no proper
  // nouns at all, which is common for procedural memories.
  if (found.size < limit) {
    const frequencies = new Map<string, number>();
    for (const term of tokenize(text)) {
      if (term.length < 4) continue;
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
    const salient = [...frequencies.entries()]
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1]);
    for (const [term] of salient) {
      if (found.size >= limit) break;
      if (!found.has(term)) record(term, 'concept');
    }
  }

  return [...found.values()]
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

/** Entity overlap between two texts, in [0, 1]. Drives associative linking. */
export function entityOverlap(a: string, b: string): number {
  const left = new Set(extractEntities(a).map((entity) => entity.key));
  const right = new Set(extractEntities(b).map((entity) => entity.key));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const key of left) {
    if (right.has(key)) shared += 1;
  }
  return shared / Math.min(left.size, right.size);
}
