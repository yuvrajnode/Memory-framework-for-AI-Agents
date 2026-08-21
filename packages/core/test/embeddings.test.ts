import { describe, expect, it, vi } from 'vitest';
import { HashingEmbedder } from '../src/embeddings/hashing.js';
import { OpenAIEmbedder } from '../src/embeddings/openai.js';
import { centroid, cosineScore, cosineSimilarity, norm, normalizeVector } from '../src/embeddings/vector.js';
import { EmbeddingError } from '../src/errors.js';

describe('vector maths', () => {
  it('normalises to unit length', () => {
    expect(norm(normalizeVector([3, 4]))).toBeCloseTo(1, 10);
  });

  it('passes zero vectors through instead of dividing by zero', () => {
    expect(normalizeVector([0, 0])).toEqual([0, 0]);
  });

  it('scores identical vectors at 1 and opposites at -1', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('rescales cosine into [0, 1] for blending', () => {
    expect(cosineScore([1, 0], [-1, 0])).toBeCloseTo(0, 10);
    expect(cosineScore([1, 0], [0, 1])).toBeCloseTo(0.5, 10);
  });

  it('compares mismatched lengths over the shared prefix rather than throwing', () => {
    expect(() => cosineSimilarity([1, 0, 0], [1, 0])).not.toThrow();
  });

  it('averages vectors into a centroid', () => {
    expect(centroid([[0, 2], [2, 0]])).toEqual([1, 1]);
  });
});

describe('HashingEmbedder', () => {
  const embedder = new HashingEmbedder({ dimensions: 256 });

  it('is deterministic', () => {
    expect(embedder.embedSync('deploy on friday')).toEqual(
      embedder.embedSync('deploy on friday'),
    );
  });

  it('emits unit vectors of the configured width', () => {
    const vector = embedder.embedSync('some memory content');
    expect(vector).toHaveLength(256);
    expect(norm(vector)).toBeCloseTo(1, 6);
  });

  it('returns a zero vector for empty input without erroring', () => {
    expect(embedder.embedSync('   ')).toEqual(new Array(256).fill(0));
  });

  it('ranks related text above unrelated text', () => {
    const query = embedder.embedSync('the database connection timed out');
    const related = embedder.embedSync('database connection timeout while querying');
    const unrelated = embedder.embedSync('ada prefers oat milk in her coffee');
    expect(cosineSimilarity(query, related)).toBeGreaterThan(
      cosineSimilarity(query, unrelated),
    );
  });

  it('tolerates morphological variation via character n-grams', () => {
    const a = embedder.embedSync('deployment pipeline');
    const b = embedder.embedSync('deploying pipelines');
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.2);
  });

  it('aligns batch output with batch input', async () => {
    const [first, second] = await embedder.embed(['alpha text', 'beta text']);
    expect(first).toEqual(embedder.embedSync('alpha text'));
    expect(second).toEqual(embedder.embedSync('beta text'));
  });
});

describe('OpenAIEmbedder', () => {
  const ok = (vectors: number[][]) =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        data: vectors.map((embedding, index) => ({ index, embedding })),
      }),
    }) as unknown as Response;

  it('refuses to construct without a key', () => {
    expect(() => new OpenAIEmbedder({ apiKey: '' })).toThrow(EmbeddingError);
  });

  it('restores order when the API returns results out of sequence', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { index: 1, embedding: [2] },
              { index: 0, embedding: [1] },
            ],
          }),
        }) as unknown as Response,
    );
    const embedder = new OpenAIEmbedder({ apiKey: 'k', fetchImpl: fetchImpl as never });
    expect(await embedder.embed(['a', 'b'])).toEqual([[1], [2]]);
  });

  it('splits oversized inputs into batches', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return ok(body.input.map(() => [1]));
    });
    const embedder = new OpenAIEmbedder({
      apiKey: 'k',
      batchSize: 2,
      fetchImpl: fetchImpl as never,
    });
    const result = await embedder.embed(['a', 'b', 'c', 'd', 'e']);
    expect(result).toHaveLength(5);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('substitutes blank inputs, which the API rejects', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      expect(body.input[0]).toBe(' ');
      return ok([[1]]);
    });
    const embedder = new OpenAIEmbedder({ apiKey: 'k', fetchImpl: fetchImpl as never });
    await embedder.embed(['']);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not retry a non-retryable status', async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 401, text: async () => 'bad key' }) as unknown as Response,
    );
    const embedder = new OpenAIEmbedder({ apiKey: 'k', fetchImpl: fetchImpl as never });
    await expect(embedder.embed(['a'])).rejects.toThrow(EmbeddingError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retries a rate limit and succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 429, text: async () => 'slow down' } as unknown as Response;
      }
      return ok([[1, 2]]);
    });
    const embedder = new OpenAIEmbedder({ apiKey: 'k', fetchImpl: fetchImpl as never });
    expect(await embedder.embed(['a'])).toEqual([[1, 2]]);
    expect(calls).toBe(2);
  });
});
