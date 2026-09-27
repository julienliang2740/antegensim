/** Local playback of a fixed sequence of saved turns. Never sends a simulation command.
 * DOCS: replay waits for each checkpoint to load, pauses behind inspectors/in background,
 * and stops on the last recorded turn without returning to live or advancing the world.
 */
import { useCallback, useEffect, useState } from "react";
import type { TurnIndexEntry } from "../api/types";

export function useSavedReplay(props: {
  turns: readonly TurnIndexEntry[];
  shownId: string | null;
  loaded: boolean;
  blocked: boolean;
  onView(id: string): void;
}) {
  const [queue, setQueue] = useState<string[] | null>(null);
  const [token, setToken] = useState(0);
  const [intervalMs, setIntervalMs] = useState(2200);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  const stop = useCallback(() => setQueue(null), []);
  const start = () => {
    const at = props.turns.findIndex((turn) => turn.turn_id === props.shownId);
    if (at < 0) return;
    const saved = props.turns.slice(at).map((turn) => turn.turn_id);
    setQueue(saved);
    props.onView(saved[0]);
    setToken((old) => old + 1);
  };
  const replayOne = () => {
    stop();
    if (props.shownId) props.onView(props.shownId);
    setToken((old) => old + 1);
  };
  const { shownId, loaded, blocked, onView } = props;
  useEffect(() => {
    if (!queue || !shownId || !loaded || blocked || !visible) return;
    const at = queue.indexOf(shownId);
    const timer = window.setTimeout(() => {
      const next = at < 0 ? undefined : queue[at + 1];
      if (next) onView(next);
      else setQueue(null);
    }, intervalMs);
    return () => window.clearTimeout(timer);
  }, [queue, shownId, loaded, blocked, visible, intervalMs, token, onView]);
  return { playing: queue !== null, suspended: !loaded || blocked || !visible, token, intervalMs, setIntervalMs, start, stop, replayOne };
}
