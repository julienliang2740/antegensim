/**
 * Run data that follows commits: the turn index (incremental GET /turns) and
 * historical checkpoints (GET /turns/{id}, cached because committed turns
 * never change).
 */

import { useEffect, useRef, useState } from "react";
import { getTurn, listTurns } from "../api/client";
import type { TurnIndexEntry, TurnView } from "../api/types";
import { errorText } from "../state/runSessions";
import { lastRound, mergeTurnIndex } from "../state/timeline";
import { useFetched } from "./useFetched";
import type { Fetched } from "./useFetched";

const HISTORY_CACHE_SIZE = 40;

/** The run's turn index, refreshed from the last known round whenever `commitKey` changes. */
export function useTurnIndex(runId: string, commitKey: string | null): { turns: TurnIndexEntry[]; error: string | null } {
  const [turns, setTurns] = useState<TurnIndexEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const turnsRef = useRef<TurnIndexEntry[]>([]);
  const requestRef = useRef(0);

  useEffect(() => {
    if (commitKey === null) return;
    const request = ++requestRef.current;
    const from = turnsRef.current.length > 0 ? lastRound(turnsRef.current) : undefined;
    listTurns(runId, from)
      .then((incoming) => {
        if (request !== requestRef.current) return; // a newer refresh is on its way
        const merged = from === undefined ? incoming : mergeTurnIndex(turnsRef.current, incoming, from);
        turnsRef.current = merged;
        setTurns(merged);
        setError(null);
      })
      .catch((e) => {
        if (request === requestRef.current) setError(errorText(e));
      });
  }, [runId, commitKey]);

  return { turns, error };
}

/** A recorded checkpoint of this run (null turnId = nothing to load). */
export function useHistoryView(runId: string, turnId: string | null): Fetched<TurnView> {
  const cache = useRef(new Map<string, TurnView>());
  return useFetched<TurnView>(turnId, async () => {
    const id = turnId ?? "";
    const cached = cache.current.get(id);
    if (cached) return cached;
    const view = await getTurn(runId, id);
    cache.current.set(id, view);
    if (cache.current.size > HISTORY_CACHE_SIZE) {
      const oldest = cache.current.keys().next().value;
      if (oldest !== undefined) cache.current.delete(oldest);
    }
    return view;
  });
}
