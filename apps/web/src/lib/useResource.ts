'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch on mount and whenever `key` changes. A reload keeps the previous data on screen until the
 * new answer arrives, so panels never flash empty.
 */
export function useResource<T>(load: ((signal: AbortSignal) => Promise<T>) | null, key: string): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(load !== null);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const fn = loadRef.current;
    if (!fn) return;
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    fn(ctl.signal)
      .then((d) => {
        if (!ctl.signal.aborted) setData(d);
      })
      .catch((e: Error) => {
        if (!ctl.signal.aborted && e.name !== 'AbortError') setError(e);
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => ctl.abort();
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** A one-shot action (POST): its result, error and pending state. */
export function useAction<A extends unknown[], T>(fn: (...args: A) => Promise<T>) {
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A): Promise<T | null> => {
    setPending(true);
    setError(null);
    try {
      const r = await fnRef.current(...args);
      setResult(r);
      return r;
    } catch (e) {
      setError(e as Error);
      return null;
    } finally {
      setPending(false);
    }
  }, []);
  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);
  return { run, result, error, pending, reset };
}
