/**
 * Events of several committed turns (GET /api/runs/{run_id}/turns/{turn_id}/events),
 * loaded on demand and cached for the page's lifetime: a saved turn's events
 * never change.  Used by the entity profile card's Decisions and Messages
 * sections, which ask for one page of turns at a time.
 */

import { useEffect, useState } from "react";
import { getTurnEvents } from "../api/client";
import type { Event } from "../api/types";
import { errorText } from "../state/runSessions";

/** Cached requests, keyed "<run id> <turn id>"; the oldest are dropped past this many. */
const CACHE_SIZE = 400;
const cache = new Map<string, Promise<Event[]>>();

function load(runId: string, turnId: string): Promise<Event[]> {
  const key = `${runId} ${turnId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const request = getTurnEvents(runId, turnId);
  request.catch(() => cache.delete(key)); // a failed load is retried next time
  cache.set(key, request);
  if (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return request;
}

export interface TurnEvents {
  /** Events per turn id (only the turns loaded so far). */
  events: ReadonlyMap<string, Event[]>;
  /** Load errors per turn id. */
  errors: ReadonlyMap<string, string>;
}

const EMPTY: TurnEvents = { events: new Map(), errors: new Map() };

/** Load the events of `turnIds` of run `runId` (already loaded turns come from the cache). */
export function useTurnEvents(runId: string, turnIds: readonly string[]): TurnEvents {
  const [state, setState] = useState<{ runId: string; value: TurnEvents }>({ runId, value: EMPTY });
  const wanted = turnIds.join("\n");

  useEffect(() => {
    let cancelled = false;
    for (const turnId of wanted ? wanted.split("\n") : []) {
      load(runId, turnId)
        .then((events) => {
          if (cancelled) return;
          setState((previous) => {
            const base = previous.runId === runId ? previous.value : EMPTY;
            if (base.events.get(turnId) === events) return previous;
            const errors = new Map(base.errors);
            errors.delete(turnId);
            return { runId, value: { events: new Map(base.events).set(turnId, events), errors } };
          });
        })
        .catch((error) => {
          if (cancelled) return;
          setState((previous) => {
            const base = previous.runId === runId ? previous.value : EMPTY;
            return { runId, value: { events: base.events, errors: new Map(base.errors).set(turnId, errorText(error)) } };
          });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [runId, wanted]);

  return state.runId === runId ? state.value : EMPTY;
}
