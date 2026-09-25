/**
 * Holds a run open while the run page is shown and follows it: status and
 * live events through client.pollEvents (INTERFACES section 9 "Frontend
 * polling"), ~700 ms while the run is busy and slower while it is idle.
 *
 * Feed resets: when `feed_epoch` changes (the worker restarted) or seqs
 * rewind, the feed is cleared and reloaded from latest_seq - 300 so
 * uncommitted lines of a dead worker never linger.  A `run_not_open` answer
 * reopens the run once.  Leaving the page releases the run (closed shortly
 * after, see state/runSessions.ts).
 */

import { useEffect, useRef, useState } from "react";
import { INITIAL_FEED_WINDOW, POLL_INTERVAL_MS, pollEvents } from "../api/client";
import type { Event, RunStatus } from "../api/types";
import { mergeEvents } from "../state/feed";
import { acquireRun, errorText, isRunNotOpen, releaseRun, reopenRun } from "../state/runSessions";
import { isIdle } from "../state/statusText";

/** Poll interval while the run is paused, finished or in error. */
export const IDLE_POLL_INTERVAL_MS = 2500;

export interface RunFeed {
  status: RunStatus | null;
  events: Event[];
  opened: boolean;
  openError: string | null;
  pollError: string | null;
  /** Number of feed resets so far (shown in the log header). */
  resets: number;
  /** Apply a status returned by a command so the controls update at once. */
  applyStatus(status: RunStatus): void;
}

export function useRunFeed(runId: string): RunFeed {
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [opened, setOpened] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [resets, setResets] = useState(0);
  const [restartKey, setRestartKey] = useState(0);
  const epochRef = useRef<string | null>(null);
  const cursorRef = useRef(0);

  // Hold the run open while this page is mounted.
  useEffect(() => {
    let cancelled = false;
    acquireRun(runId)
      .then((s) => {
        if (cancelled) return;
        epochRef.current = s.feed_epoch;
        cursorRef.current = Math.max(0, s.latest_seq - INITIAL_FEED_WINDOW);
        setStatus(s);
        setOpened(true);
      })
      .catch((e) => {
        if (!cancelled) setOpenError(errorText(e));
      });
    return () => {
      cancelled = true;
      releaseRun(runId);
    };
  }, [runId]);

  const idle = isIdle(status);

  // Follow events and status; restarted when the idle/busy speed changes.
  useEffect(() => {
    if (!opened) return;
    let reopenTried = false;
    // Clear the feed and restart the poller at once from latest_seq - 300 (no wait for the next tick).
    const resetFeed = (st: RunStatus) => {
      epochRef.current = st.feed_epoch;
      cursorRef.current = Math.max(0, st.latest_seq - INITIAL_FEED_WINDOW);
      setEvents([]);
      setResets((n) => n + 1);
      setRestartKey((k) => k + 1);
    };
    const poller = pollEvents(
      runId,
      (incoming, st) => {
        reopenTried = false;
        setPollError(null);
        if (epochRef.current !== null && st.feed_epoch !== epochRef.current) {
          // A freshly started poller cannot notice the change itself.
          resetFeed(st);
          setStatus(st);
          return;
        }
        epochRef.current = st.feed_epoch;
        if (incoming.length > 0) {
          cursorRef.current = incoming[incoming.length - 1].seq;
          setEvents((previous) => mergeEvents(previous, incoming));
        }
        setStatus(st);
      },
      (error) => {
        if (isRunNotOpen(error) && !reopenTried) {
          reopenTried = true;
          reopenRun(runId)
            .then(() => setRestartKey((k) => k + 1))
            .catch((e) => setPollError(`The run is not open and reopening failed: ${errorText(e)}`));
          return;
        }
        setPollError(errorText(error));
      },
      idle ? IDLE_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
      cursorRef.current,
      resetFeed,
    );
    return () => poller.stop();
  }, [runId, opened, idle, restartKey]);

  return { status, events, opened, openError, pollError, resets, applyStatus: setStatus };
}
