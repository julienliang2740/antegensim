/**
 * Pure helpers of the shared working indicator (components/common/Working.tsx):
 * the elapsed-seconds counter that ticks client-side from a start timestamp
 * (a job's started_at, a message's created_at, or the moment the page first
 * saw the work when the server gives no start), and its "12 s" / "1 min 05 s"
 * text.
 *
 * DOCS: every place a model is working (Story Mode banner, interview, reader,
 * drawer, Storybook tab) shows the same indicator; the counter is computed from
 * the wall clock, never from a server-side elapsed value (written once per step,
 * so stale while a call runs).
 */

/** "12 s" under a minute, else "1 min 05 s". */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, "0")} s`;
}

/** Milliseconds since the epoch of an ISO timestamp or a millisecond number; null when missing or unparseable. */
export function startMs(start: string | number | null | undefined): number | null {
  if (start === null || start === undefined || start === "") return null;
  const t = typeof start === "number" ? start : Date.parse(start);
  return Number.isFinite(t) ? t : null;
}

/** Whole seconds from `start` to `now` (ms), never negative (clock skew); null when `start` is unknown. */
export function elapsedSince(start: string | number | null | undefined, now: number): number | null {
  const t = startMs(start);
  if (t === null) return null;
  return Math.max(0, Math.floor((now - t) / 1000));
}

/** When the current piece of work began, as the page first saw it. */
export interface WorkStart {
  key: string;
  startMs: number;
}

/**
 * Keep `prev` while the work is the same (same `key`); a new key starts at the
 * server's timestamp when there is one, else at `now` (the page saw it begin).
 */
export function trackStart(prev: WorkStart | null, key: string, serverStart: string | number | null | undefined, now: number): WorkStart {
  if (prev && prev.key === key) return prev;
  return { key, startMs: startMs(serverStart) ?? now };
}
