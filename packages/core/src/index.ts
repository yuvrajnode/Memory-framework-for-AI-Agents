/**
 * Mnemos — a memory framework for AI agents.
 *
 * The quickest possible start, with no configuration and no API key:
 *
 * ```ts
 * import { MemoryEngine } from '@mnemos/core';
 *
 * const memory = new MemoryEngine();
 * await memory.remember({ content: 'Ada deploys on Fridays', kind: 'semantic' });
 * const { text } = await memory.buildContext('when does Ada deploy?');
 * ```
 */

export { MemoryEngine } from './engine.js';
export type {
  ContextOptions,
  MemoryEngineOptions,
  WriteResult,
} from './engine.js';

export * from './types.js';
export * from './errors.js';
export * from './record.js';
export * from './validation.js';
export * from './events.js';

export * from './util/index.js';
export * from './embeddings/index.js';
export * from './store/index.js';
export * from './retrieval/index.js';
export * from './pipeline/index.js';
export * from './graph/index.js';
export * from './context/index.js';

export const VERSION = '0.1.0';
