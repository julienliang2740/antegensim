/**
 * Load data whenever `key` changes (null = nothing to load).  The previous
 * data stays visible while the next key loads, so views do not flicker
 * during live polling; answers for an outdated key are ignored.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../state/runSessions";

export interface Fetched<T> {
  data: T | null;
  /** The key `data` belongs to (null before the first answer). */
  dataKey: string | null;
  error: string | null;
  loading: boolean;
  reload(): void;
  /** Replace the data locally (for example with the answer of a POST). */
  set(value: T): void;
}

export function useFetched<T>(key: string | null, load: () => Promise<T>): Fetched<T> {
  const [data, setData] = useState<T | null>(null);
  const [dataKey, setDataKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** "<key>#<nonce>" of the last request that finished (loading is derived from it). */
  const [settled, setSettled] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  // Declared before the loading effect so it runs first and the load sees the latest closure.
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    const request = `${key}#${nonce}`;
    loadRef
      .current()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setDataKey(key);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setSettled(request);
      });
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const set = useCallback(
    (value: T) => {
      setData(value);
      setDataKey(key);
    },
    [key],
  );
  const loading = key !== null && settled !== `${key}#${nonce}`;
  return { data, dataKey, error, loading, reload, set };
}
