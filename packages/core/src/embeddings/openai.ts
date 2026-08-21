import { EmbeddingError } from '../errors.js';
import type { EmbeddingProvider } from './types.js';

export interface OpenAIEmbedderOptions {
  apiKey: string;
  /** Defaults to text-embedding-3-small, the best cost/quality tradeoff. */
  model?: string;
  /** Override for Azure OpenAI or a compatible gateway. */
  baseUrl?: string;
  /** Requested output width. The API truncates larger models to this. */
  dimensions?: number;
  /** Texts per HTTP call. The API caps a request at 2048 inputs. */
  batchSize?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Retries on 429 and 5xx, with exponential backoff. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

const MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

/**
 * Embedding provider backed by the OpenAI embeddings API.
 *
 * Batches, retries idempotently on rate limits and transient failures, and
 * fails loudly on anything else so a misconfigured key never silently
 * degrades recall to zero vectors.
 */
export class OpenAIEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIEmbedderOptions) {
    if (!options.apiKey) {
      throw new EmbeddingError('OpenAIEmbedder requires an apiKey');
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'text-embedding-3-small';
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.dimensions = options.dimensions ?? MODEL_DIMENSIONS[this.model] ?? 1536;
    this.batchSize = Math.min(options.batchSize ?? 128, 2048);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.id = `openai:${this.model}:${this.dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const batch = texts.slice(offset, offset + this.batchSize);
      results.push(...(await this.embedBatch(batch)));
    }
    return results;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    // The API rejects empty strings, so substitute a single space and let the
    // caller keep index alignment.
    const inputs = batch.map((text) => (text.trim() ? text : ' '));

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await delay(Math.min(2 ** attempt * 250, 8_000));
      }
      try {
        return await this.request(inputs);
      } catch (error) {
        lastError = error;
        if (error instanceof EmbeddingError && !isRetryable(error)) throw error;
      }
    }
    throw new EmbeddingError(
      `Embedding request failed after ${this.maxRetries + 1} attempts`,
      { cause: String(lastError) },
    );
  }

  private async request(inputs: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: inputs,
          ...(this.model.startsWith('text-embedding-3')
            ? { dimensions: this.dimensions }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new EmbeddingError(
          `OpenAI embeddings responded ${response.status}`,
          { status: response.status, body: body.slice(0, 500) },
        );
      }

      const payload = (await response.json()) as {
        data?: { index: number; embedding: number[] }[];
      };
      if (!payload.data || payload.data.length !== inputs.length) {
        throw new EmbeddingError('OpenAI embeddings returned a malformed payload');
      }
      // The API documents ordered output, but sorting by index makes the
      // alignment guarantee explicit rather than assumed.
      return [...payload.data]
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.embedding);
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new EmbeddingError(`Embedding request timed out after ${this.timeoutMs}ms`);
      }
      throw new EmbeddingError('Embedding request failed', { cause: String(error) });
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRetryable(error: EmbeddingError): boolean {
  const status = (error.details as { status?: number } | undefined)?.status;
  if (status === undefined) return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
