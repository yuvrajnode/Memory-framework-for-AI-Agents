import type {
  Backend,
  ConsolidationResult,
  ContextResult,
  ListParams,
  ListResult,
  MaintenanceResult,
  MemoryGraph,
  MemoryInput,
  MemoryKind,
  MemoryStats,
  MemoryView,
  RankedMemory,
  RecallOptions,
} from './types.js';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Talks to a running Mnemos server. */
export class RemoteBackend implements Backend {
  readonly kind = 'remote' as const;
  readonly label: string;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.label = this.baseUrl || 'same origin';
  }

  /**
   * Probe readiness, so the UI can fall back before the user hits an error.
   *
   * A 200 is not sufficient evidence: a static host serving this dashboard
   * will happily answer /ready with the SPA fallback HTML, and treating that
   * as a live API leaves every subsequent call parsing markup as JSON. The
   * probe therefore requires the actual readiness payload.
   */
  static async probe(baseUrl: string, apiKey?: string): Promise<boolean> {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/ready`, {
        headers: {
          accept: 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
        },
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return false;
      if (!response.headers.get('content-type')?.includes('application/json')) return false;
      const payload = (await response.json().catch(() => null)) as { status?: string } | null;
      return payload?.status === 'ready';
    } catch {
      return false;
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`, window.location.origin);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
        ...init.headers,
      },
    });

    if (response.status === 204) return undefined as T;

    const payload = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    if (!response.ok) {
      throw new ApiError(
        payload?.message ?? `Request failed with status ${response.status}`,
        response.status,
        payload?.code ?? 'REQUEST_FAILED',
      );
    }
    if (payload === null) {
      // A 200 that is not JSON means something other than the API answered —
      // a proxy error page, or a static host's SPA fallback.
      throw new ApiError(
        `Expected JSON from ${path} but the response could not be parsed`,
        response.status,
        'MALFORMED_RESPONSE',
      );
    }
    return payload as T;
  }

  async remember(input: MemoryInput): Promise<MemoryView> {
    const result = await this.request<{ memory: MemoryView }>('/v1/memories', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return result.memory;
  }

  async rememberMany(inputs: MemoryInput[]): Promise<number> {
    const result = await this.request<{ count: number }>('/v1/memories', {
      method: 'POST',
      body: JSON.stringify({ memories: inputs }),
    });
    return result.count;
  }

  async list(params: ListParams): Promise<ListResult> {
    return this.request<ListResult>('/v1/memories', {
      query: {
        namespace: params.namespace,
        kind: params.kinds?.join(','),
        tags: params.tags?.join(','),
        search: params.search,
        limit: params.limit ?? 50,
        offset: params.offset ?? 0,
        orderBy: params.orderBy,
        direction: params.direction,
      },
    });
  }

  async recall(
    query: string,
    options: RecallOptions & { namespace?: string },
  ): Promise<RankedMemory[]> {
    const result = await this.request<{ results: RankedMemory[] }>('/v1/recall', {
      method: 'POST',
      body: JSON.stringify({ query, ...options }),
    });
    return result.results;
  }

  async buildContext(
    query: string,
    options: { budgetTokens: number; namespace?: string; limit?: number; diversity?: number },
  ): Promise<ContextResult> {
    return this.request<ContextResult>('/v1/context', {
      method: 'POST',
      body: JSON.stringify({ query, ...options }),
    });
  }

  async update(
    id: string,
    changes: { content?: string; importance?: number; tags?: string[]; kind?: MemoryKind },
    namespace?: string,
  ): Promise<MemoryView> {
    const result = await this.request<{ memory: MemoryView }>(`/v1/memories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
      query: { namespace },
    });
    return result.memory;
  }

  async forget(id: string, namespace?: string): Promise<void> {
    await this.request<void>(`/v1/memories/${id}`, {
      method: 'DELETE',
      query: { namespace },
    });
  }

  async stats(namespace?: string): Promise<MemoryStats> {
    const result = await this.request<{ stats: MemoryStats }>('/v1/stats', {
      query: { namespace },
    });
    return result.stats;
  }

  async namespaces(): Promise<{ namespace: string; count: number }[]> {
    const result = await this.request<{ namespaces: { namespace: string; count: number }[] }>(
      '/v1/namespaces',
    );
    return result.namespaces;
  }

  async graph(namespace?: string, limit?: number): Promise<MemoryGraph> {
    return this.request<MemoryGraph>('/v1/graph', { query: { namespace, limit } });
  }

  async consolidate(namespace?: string): Promise<ConsolidationResult> {
    return this.request<ConsolidationResult>('/v1/consolidate', {
      method: 'POST',
      body: JSON.stringify({ namespace }),
    });
  }

  async maintain(
    namespace: string | undefined,
    options: { dryRun?: boolean; maxRecords?: number },
  ): Promise<MaintenanceResult> {
    const result = await this.request<{ report: MaintenanceResult }>('/v1/maintenance', {
      method: 'POST',
      body: JSON.stringify({ namespace, ...options }),
    });
    return result.report;
  }

  async clear(namespace?: string): Promise<number> {
    const result = await this.request<{ removed: number }>('/v1/memories', {
      method: 'DELETE',
      query: { namespace, confirm: 'true' },
    });
    return result.removed;
  }
}
