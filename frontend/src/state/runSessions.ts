/**
 * Which runs this browser tab holds open, and the open/close calls that go
 * with it (INTERFACES section 9: "the frontend calls open when entering a run
 * and close when leaving"; spec "Sessions and run controls").
 *
 * Rules implemented here:
 *   - open/close requests are sent one at a time, in order, so a quick
 *     leave-and-return (or React StrictMode's mount/unmount/mount) can never
 *     have a late "close" undo a newer "open";
 *   - closing is deferred by CLOSE_DELAY_MS and cancelled when the same run is
 *     acquired again in the meantime;
 *   - when the page is unloaded every held run is closed with sendBeacon (a
 *     plain POST that survives the unload), so a live-provider run cannot keep
 *     spending after the tab is gone.
 */

import { API_BASE, ApiClientError, closeRun, openRun } from "../api/client";
import type { RunStatus } from "../api/types";

const CLOSE_DELAY_MS = 400;

const holders = new Map<string, number>();
const closeTimers = new Map<string, ReturnType<typeof setTimeout>>();
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

/** Hold `runId` open (POST open, idempotent on the backend). */
export function acquireRun(runId: string): Promise<RunStatus> {
  holders.set(runId, (holders.get(runId) ?? 0) + 1);
  const timer = closeTimers.get(runId);
  if (timer !== undefined) {
    clearTimeout(timer);
    closeTimers.delete(runId);
  }
  return enqueue(() => openRun(runId));
}

/** Open again after a `run_not_open` answer (the backend restarted or another tab closed it). */
export function reopenRun(runId: string): Promise<RunStatus> {
  return enqueue(() => openRun(runId));
}

/** Stop holding `runId`; the run is closed shortly after unless it is acquired again. */
export function releaseRun(runId: string): void {
  const count = (holders.get(runId) ?? 1) - 1;
  if (count > 0) {
    holders.set(runId, count);
    return;
  }
  holders.delete(runId);
  const timer = setTimeout(() => {
    closeTimers.delete(runId);
    if (holders.has(runId)) return;
    void enqueue(() => closeRun(runId)).catch(() => undefined);
  }, CLOSE_DELAY_MS);
  closeTimers.set(runId, timer);
}

/** True while this tab holds the run open. */
export function isHeld(runId: string): boolean {
  return holders.has(runId);
}

function closeEverythingOnUnload(): void {
  const ids = new Set([...holders.keys(), ...closeTimers.keys()]);
  for (const runId of ids) {
    const url = `${API_BASE}/api/runs/${encodeURIComponent(runId)}/close`;
    if (typeof navigator.sendBeacon === "function") navigator.sendBeacon(url);
    else void fetch(url, { method: "POST", keepalive: true }).catch(() => undefined);
  }
  holders.clear();
  closeTimers.clear();
}

if (typeof window !== "undefined") window.addEventListener("pagehide", closeEverythingOnUnload);

/**
 * Call `task`; when the backend answers `run_not_open` (409), reopen the run
 * once and retry (client.ts error-handling contract).
 */
export async function withReopen<T>(runId: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (isRunNotOpen(error) && isHeld(runId)) {
      await reopenRun(runId);
      return task();
    }
    throw error;
  }
}

export function isRunNotOpen(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === "run_not_open";
}

/** A readable one-line message for any thrown value. */
export function errorText(error: unknown): string {
  if (error instanceof ApiClientError) {
    const problems = error.problems.map((p) => (p.path ? `${p.path}: ${p.message}` : p.message));
    return problems.length > 0 ? `${error.message} (${problems.join("; ")})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
