import type { MemoryRecord, RecallResult } from './types.js';

export interface MemoryEvents {
  'memory:written': { record: MemoryRecord; deduplicated: boolean };
  'memory:updated': { record: MemoryRecord };
  'memory:deleted': { namespace: string; id: string };
  'memory:recalled': {
    namespace: string;
    query: string;
    results: RecallResult[];
    durationMs: number;
  };
  'memory:consolidated': { namespace: string; created: number; superseded: number };
  'memory:evicted': { namespace: string; ids: string[]; reason: string };
  error: { scope: string; error: unknown };
}

export type EventName = keyof MemoryEvents;
export type Listener<K extends EventName> = (payload: MemoryEvents[K]) => void;

/**
 * Typed, synchronous event bus.
 *
 * Deliberately not Node's EventEmitter: this needs to run unchanged in the
 * browser bundle of the dashboard, and the typed payload map catches
 * mismatched listeners at compile time. Listener failures are swallowed and
 * reported through the `error` channel so instrumentation can never break a
 * write path.
 */
export class EventBus {
  private readonly listeners = new Map<EventName, Set<(payload: never) => void>>();

  on<K extends EventName>(event: K, listener: Listener<K>): () => void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(listener as (payload: never) => void);
    return () => this.off(event, listener);
  }

  once<K extends EventName>(event: K, listener: Listener<K>): () => void {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  off<K extends EventName>(event: K, listener: Listener<K>): void {
    this.listeners.get(event)?.delete(listener as (payload: never) => void);
  }

  emit<K extends EventName>(event: K, payload: MemoryEvents[K]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        (handler as Listener<K>)(payload);
      } catch (error) {
        if (event === 'error') continue; // Never recurse on a failing error handler.
        this.emit('error', { scope: `listener:${String(event)}`, error });
      }
    }
  }

  removeAll(event?: EventName): void {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
  }

  listenerCount(event: EventName): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
