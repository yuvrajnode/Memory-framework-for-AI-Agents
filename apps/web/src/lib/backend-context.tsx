import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { LocalBackend } from './local-backend.js';
import { RemoteBackend } from './remote-backend.js';
import { seedMemories } from './seed.js';
import type { Backend } from './types.js';

interface BackendState {
  backend: Backend;
  /** Bumped whenever data changes, so views can refetch without prop drilling. */
  revision: number;
  invalidate: () => void;
  namespace: string;
  setNamespace: (namespace: string) => void;
  ready: boolean;
}

const BackendContext = createContext<BackendState | null>(null);

export function useBackend(): BackendState {
  const state = useContext(BackendContext);
  if (!state) throw new Error('useBackend must be used inside BackendProvider');
  return state;
}

/** Where the API lives. Empty means same origin, which is the deployed case. */
const API_URL = import.meta.env['VITE_API_URL'] ?? '';
const API_KEY = import.meta.env['VITE_API_KEY'] as string | undefined;

/**
 * Chooses a backend at startup.
 *
 * A configured API is probed first; if it does not answer, the dashboard
 * falls back to running the engine in the tab and seeds it with a realistic
 * corpus. That ordering is what makes one build work both as an operator
 * console against a real server and as a self-contained static demo.
 */
export function BackendProvider({ children }: { children: ReactNode }) {
  const [backend, setBackend] = useState<Backend>(() => new LocalBackend());
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [namespace, setNamespace] = useState('default');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (API_URL !== '' || import.meta.env.PROD) {
        const reachable = await RemoteBackend.probe(API_URL, API_KEY);
        if (cancelled) return;
        if (reachable) {
          setBackend(new RemoteBackend(API_URL, API_KEY));
          setReady(true);
          return;
        }
      }

      const local = new LocalBackend();
      await local.rememberMany(seedMemories());
      if (cancelled) return;
      setBackend(local);
      setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<BackendState>(
    () => ({
      backend,
      revision,
      invalidate: () => setRevision((current) => current + 1),
      namespace,
      setNamespace,
      ready,
    }),
    [backend, revision, namespace, ready],
  );

  return <BackendContext.Provider value={value}>{children}</BackendContext.Provider>;
}
