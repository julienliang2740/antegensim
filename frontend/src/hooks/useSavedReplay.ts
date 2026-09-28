/** Local playback through the latest saved turn. Never sends a simulation command.
 * Waits for checkpoint loads and follows additions to the existing turn index.
 * The starting turn is selected explicitly by the replay controls.
 */
import { useCallback, useEffect, useState } from "react";
import type { TurnIndexEntry } from "../api/types";

export function useSavedReplay(props: {
  turns: readonly TurnIndexEntry[];
  shownId: string | null;
  latestSavedId: string | null;
  loaded: boolean;
  blocked: boolean;
  onView(id: string): void;
}) {
  const [playing, setPlaying] = useState(false);
  const [token, setToken] = useState(0);
  const [intervalMs, setIntervalMs] = useState(2200);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  const stop = useCallback(() => setPlaying(false), []);
  const start = (turnId: string) => {
    const first = props.turns.find((turn) => turn.turn_id === turnId);
    if (!first) return;
    setPlaying(true);
    props.onView(first.turn_id);
    setToken((old) => old + 1);
  };
  const replayOne = () => {
    stop();
    if (props.shownId) props.onView(props.shownId);
    setToken((old) => old + 1);
  };
  const { shownId, loaded, blocked, onView } = props;
  const at = props.turns.findIndex((turn) => turn.turn_id === shownId);
  const nextId = at >= 0 ? props.turns[at + 1]?.turn_id ?? null : null;
  const caughtUp = shownId === props.latestSavedId && nextId === null;
  useEffect(() => {
    if (!playing || !shownId || !loaded || blocked || !visible) return;
    const timer = window.setTimeout(() => {
      if (nextId) onView(nextId);
      else if (caughtUp) setPlaying(false);
      // Otherwise the status is ahead of the index. Its existing refresh supplies the next id.
    }, intervalMs);
    return () => window.clearTimeout(timer);
  }, [playing, shownId, loaded, blocked, visible, intervalMs, token, onView, nextId, caughtUp]);
  return { playing, suspended: !loaded || blocked || !visible || (!nextId && !caughtUp), token, intervalMs, setIntervalMs, start, stop, replayOne };
}
