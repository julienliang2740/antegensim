/**
 * Follow a changing key at most once per `intervalMs` (the latest value always
 * lands at the next slot); with `immediate` the key follows at once.  Used so
 * a fast Play loop does not refetch the whole checkpoint on every commit.
 */

import { useEffect, useRef, useState } from "react";

export function useThrottledKey(value: string | null, intervalMs: number, immediate: boolean): string | null {
  const [shown, setShown] = useState(value);
  const lastRef = useRef(0);
  useEffect(() => {
    if (value === shown) return;
    const wait = immediate ? 0 : Math.max(0, lastRef.current + intervalMs - Date.now());
    const timer = setTimeout(() => {
      lastRef.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, shown, intervalMs, immediate]);
  return shown;
}
