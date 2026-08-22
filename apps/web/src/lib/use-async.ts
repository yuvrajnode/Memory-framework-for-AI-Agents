import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Run an async function and track its state.
 *
 * Results from a superseded call are discarded by sequence number rather than
 * by an abort signal, because the local backend is a plain promise with
 * nothing to abort — without this, a slow first query can overwrite the
 * answer to a later one.
 */
export function useAsync<T>(factory: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const sequence = useRef(0);

  const reload = useCallback(() => setNonce((current) => current + 1), []);

  useEffect(() => {
    const current = ++sequence.current;
    setLoading(true);

    factory().then(
      (result) => {
        if (current !== sequence.current) return;
        setData(result);
        setError(undefined);
        setLoading(false);
      },
      (caught: unknown) => {
        if (current !== sequence.current) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        setLoading(false);
      },
    );
    // The factory identity changes every render, so dependencies are the
    // caller's explicit list plus the reload nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload };
}
