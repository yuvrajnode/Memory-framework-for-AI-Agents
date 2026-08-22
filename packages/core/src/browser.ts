/**
 * Browser-safe entry point.
 *
 * Identical to the main entry except that the two Node-only stores
 * (`JsonFileStore`, `SqliteStore`) are omitted, since they reach for `node:fs`
 * and `node:sqlite`. Everything else in the framework — the engine, hybrid
 * retrieval, decay, consolidation, the graph and the context packer — is
 * pure TypeScript and runs unchanged in a bundle.
 *
 * That makes a fully client-side deployment possible: the dashboard can run
 * the real engine against an InMemoryStore with no server at all.
 *
 * ```ts
 * import { MemoryEngine, InMemoryStore } from '@mnemos/core/browser';
 * ```
 */

export { MemoryEngine } from './engine.js';
export type { ContextOptions, MemoryEngineOptions, WriteResult } from './engine.js';

export * from './types.js';
export * from './errors.js';
export * from './record.js';
export * from './validation.js';
export * from './events.js';

export * from './util/index.js';
export * from './embeddings/index.js';
export * from './retrieval/index.js';
export * from './pipeline/index.js';
export * from './graph/index.js';
export * from './context/index.js';

export * from './store/types.js';
export { InMemoryStore } from './store/in-memory.js';

export const VERSION = '0.1.0';
