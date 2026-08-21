import { splitSentences, tokenize, truncate } from '../util/text.js';

export interface SummarizeRequest {
  /** The memories being distilled, most relevant first. */
  passages: string[];
  /** Soft target for the summary length, in characters. */
  maxChars?: number;
  /** Optional steer, e.g. "focus on the user's stated preferences". */
  instruction?: string;
}

/**
 * Turns several related memories into one.
 *
 * Kept as an interface because consolidation quality is the one place where a
 * hosted model is clearly worth the call — but the framework must still work,
 * and be testable, without one.
 */
export interface Summarizer {
  readonly id: string;
  summarize(request: SummarizeRequest): Promise<string>;
}

/**
 * Extractive summariser with no model behind it.
 *
 * Scores each sentence by the frequency of its terms across the whole
 * passage set, favours sentences that appear in several passages, and emits
 * the highest scoring ones in their original order. The result is not
 * elegant prose, but it is faithful — it can only ever restate text that was
 * already in the memories, so it cannot hallucinate a fact into long-term
 * storage. That property makes it a safe default.
 */
export class ExtractiveSummarizer implements Summarizer {
  readonly id = 'extractive-v1';

  private readonly maxSentences: number;

  constructor(options: { maxSentences?: number } = {}) {
    this.maxSentences = options.maxSentences ?? 3;
  }

  async summarize(request: SummarizeRequest): Promise<string> {
    return this.summarizeSync(request);
  }

  summarizeSync(request: SummarizeRequest): string {
    const maxChars = request.maxChars ?? 600;
    const sentences: { text: string; passage: number; order: number }[] = [];

    request.passages.forEach((passage, passageIndex) => {
      splitSentences(passage).forEach((sentence, order) => {
        sentences.push({ text: sentence, passage: passageIndex, order });
      });
    });

    if (sentences.length === 0) return '';
    if (sentences.length === 1) return truncate(sentences[0]!.text, maxChars);

    const termFrequency = new Map<string, number>();
    for (const sentence of sentences) {
      for (const term of new Set(tokenize(sentence.text))) {
        termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
      }
    }

    const scored = sentences.map((sentence, index) => {
      const terms = [...new Set(tokenize(sentence.text))];
      if (terms.length === 0) return { index, score: 0 };
      let score = 0;
      for (const term of terms) score += termFrequency.get(term) ?? 0;
      // Normalising by term count stops long sentences winning on bulk alone,
      // while the sqrt keeps a mild preference for substantive ones.
      return { index, score: (score / terms.length) * Math.sqrt(terms.length) };
    });

    const chosen = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maxSentences)
      .sort((a, b) => a.index - b.index)
      .map(({ index }) => sentences[index]!.text);

    return truncate(chosen.join(' '), maxChars);
  }
}

/** Minimal completion hook, so any provider can back the LLM summariser. */
export type CompletionFn = (prompt: string) => Promise<string>;

/**
 * Model-backed summariser.
 *
 * Falls back to the extractive summariser when the completion call fails, so
 * a provider outage degrades consolidation quality instead of stalling
 * maintenance entirely.
 */
export class LlmSummarizer implements Summarizer {
  readonly id: string;

  private readonly complete: CompletionFn;
  private readonly fallback = new ExtractiveSummarizer();

  constructor(complete: CompletionFn, id = 'llm') {
    this.complete = complete;
    this.id = id;
  }

  async summarize(request: SummarizeRequest): Promise<string> {
    const maxChars = request.maxChars ?? 600;
    const prompt = [
      'Merge the related memories below into a single durable statement of fact.',
      'Preserve concrete details: names, identifiers, numbers, preferences and constraints.',
      'Do not add anything that is not present in the memories. Do not speculate.',
      request.instruction ? `Additional guidance: ${request.instruction}` : '',
      `Answer with the statement only, under ${maxChars} characters.`,
      '',
      ...request.passages.map((passage, index) => `[${index + 1}] ${passage}`),
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const result = (await this.complete(prompt)).trim();
      if (result) return truncate(result, maxChars);
    } catch {
      // Fall through to the extractive path below.
    }
    return this.fallback.summarizeSync(request);
  }
}
