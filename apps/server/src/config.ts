import { EmbeddingError } from '@mnemos/core';

export type StoreKind = 'memory' | 'json' | 'sqlite';
export type EmbedderKind = 'hashing' | 'openai';

export interface ServerConfig {
  host: string;
  port: number;
  nodeEnv: 'development' | 'production' | 'test';
  logLevel: string;
  store: StoreKind;
  dataDir: string;
  embedder: EmbedderKind;
  openaiApiKey?: string;
  openaiModel: string;
  embeddingDimensions: number;
  /** Comma-separated origins, or "*" to allow any. */
  corsOrigins: string[];
  rateLimitMax: number;
  rateLimitWindowMs: number;
  /** When set, every request must present it as `x-api-key` or a bearer token. */
  apiKey?: string;
  defaultNamespace: string;
  bodyLimitBytes: number;
  /** Run consolidation and maintenance on a timer. 0 disables. */
  maintenanceIntervalMs: number;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return value;
}

function readEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`Environment variable ${name} must be one of ${allowed.join(', ')}`);
  }
  return raw as T;
}

/**
 * Read configuration from the environment, failing fast on anything invalid.
 *
 * A bad value here is a deployment error, and it is far cheaper to crash on
 * boot with a precise message than to serve traffic with a silently wrong
 * default — so nothing is coerced quietly.
 */
export function loadConfig(): ServerConfig {
  const nodeEnv = readEnum(
    'NODE_ENV',
    ['development', 'production', 'test'] as const,
    'development',
  );
  const embedder = readEnum('EMBEDDER', ['hashing', 'openai'] as const, 'hashing');
  const openaiApiKey = process.env['OPENAI_API_KEY'];

  if (embedder === 'openai' && !openaiApiKey) {
    throw new EmbeddingError('EMBEDDER=openai requires OPENAI_API_KEY to be set');
  }

  const corsOrigins = (process.env['CORS_ORIGINS'] ?? '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const config: ServerConfig = {
    host: process.env['HOST'] ?? '0.0.0.0',
    port: readInt('PORT', 8080),
    nodeEnv,
    logLevel: process.env['LOG_LEVEL'] ?? (nodeEnv === 'production' ? 'info' : 'debug'),
    store: readEnum('STORE', ['memory', 'json', 'sqlite'] as const, 'sqlite'),
    dataDir: process.env['DATA_DIR'] ?? './data',
    embedder,
    openaiModel: process.env['OPENAI_EMBEDDING_MODEL'] ?? 'text-embedding-3-small',
    embeddingDimensions: readInt('EMBEDDING_DIMENSIONS', embedder === 'openai' ? 1536 : 384),
    corsOrigins,
    rateLimitMax: readInt('RATE_LIMIT_MAX', 240),
    rateLimitWindowMs: readInt('RATE_LIMIT_WINDOW_MS', 60_000),
    defaultNamespace: process.env['DEFAULT_NAMESPACE'] ?? 'default',
    bodyLimitBytes: readInt('BODY_LIMIT_BYTES', 1_048_576),
    maintenanceIntervalMs: readInt('MAINTENANCE_INTERVAL_MS', 0),
  };

  if (openaiApiKey) config.openaiApiKey = openaiApiKey;
  if (process.env['API_KEY']) config.apiKey = process.env['API_KEY'];

  return config;
}
