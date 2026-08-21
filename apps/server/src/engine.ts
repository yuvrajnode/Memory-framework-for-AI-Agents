import { join } from 'node:path';
import {
  HashingEmbedder,
  InMemoryStore,
  JsonFileStore,
  MemoryEngine,
  OpenAIEmbedder,
  SqliteStore,
  type EmbeddingProvider,
  type MemoryStore,
} from '@mnemos/core';
import type { ServerConfig } from './config.js';

function createStore(config: ServerConfig): MemoryStore {
  switch (config.store) {
    case 'memory':
      return new InMemoryStore();
    case 'json':
      return new JsonFileStore({ path: join(config.dataDir, 'mnemos.json') });
    case 'sqlite':
      return new SqliteStore({ path: join(config.dataDir, 'mnemos.db') });
  }
}

function createEmbedder(config: ServerConfig): EmbeddingProvider {
  if (config.embedder === 'openai' && config.openaiApiKey) {
    return new OpenAIEmbedder({
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      dimensions: config.embeddingDimensions,
    });
  }
  return new HashingEmbedder({ dimensions: config.embeddingDimensions });
}

/** Build the engine described by the config and open its store. */
export async function createEngine(config: ServerConfig): Promise<MemoryEngine> {
  const engine = new MemoryEngine({
    store: createStore(config),
    embedder: createEmbedder(config),
    defaultNamespace: config.defaultNamespace,
  });
  await engine.init();
  return engine;
}
