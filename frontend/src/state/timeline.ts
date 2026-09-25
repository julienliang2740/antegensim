/**
 * Pure helpers for history navigation (spec U6 "clicking left and right arrow
 * buttons"; "Display and historical inspection": left/right round
 * navigation, turn selection, live/history indicator).  Turns come from
 * GET /runs/{id}/turns (TurnIndexEntry, commit order).
 */

import type { TurnIndexEntry } from "../api/types";
import type { AgentNamer } from "./statusText";

/**
 * Replace every entry of round >= fromRound with `incoming` (an incremental
 * GET /turns?from_round=fromRound answer).  Entries stay in commit order.
 */
export function mergeTurnIndex(existing: readonly TurnIndexEntry[], incoming: readonly TurnIndexEntry[], fromRound: number): TurnIndexEntry[] {
  const kept = existing.filter((t) => t.round < fromRound);
  return [...kept, ...incoming];
}

/** Highest round present in the index (0 when empty). */
export function lastRound(turns: readonly TurnIndexEntry[]): number {
  return turns.length > 0 ? turns[turns.length - 1].round : 0;
}

export function firstRound(turns: readonly TurnIndexEntry[]): number {
  return turns.length > 0 ? turns[0].round : 0;
}

export function turnsOfRound(turns: readonly TurnIndexEntry[], round: number): TurnIndexEntry[] {
  return turns.filter((t) => t.round === round);
}

/** The turn `delta` steps away from `turnId` in commit order, or null at either end. */
export function neighborTurnId(turns: readonly TurnIndexEntry[], turnId: string, delta: number): string | null {
  const index = turns.findIndex((t) => t.turn_id === turnId);
  if (index < 0) return null;
  const target = turns[index + delta];
  return target ? target.turn_id : null;
}

/** The last recorded turn of `round` (its round end once committed), or null. */
export function lastTurnOfRound(turns: readonly TurnIndexEntry[], round: number): string | null {
  const inRound = turnsOfRound(turns, round);
  return inRound.length > 0 ? inRound[inRound.length - 1].turn_id : null;
}

/** Round of a turn id ("r00012_t03_a05" -> 12). */
export function roundOfTurnId(turnId: string): number {
  const match = /^r(\d+)_/.exec(turnId);
  return match ? parseInt(match[1], 10) : 0;
}

/** Readable option text for the turn selector; always contains the turn id. */
export function turnOptionLabel(entry: TurnIndexEntry, name: AgentNamer): string {
  if (entry.kind === "init") return `Initial state — ${entry.turn_id}`;
  if (entry.kind === "round_end") {
    const extra = entry.intervention_count > 0 ? ` · ${entry.intervention_count} edit(s)` : "";
    return `Round ${entry.round} end${extra} — ${entry.turn_id}`;
  }
  const what = entry.action_name ? `${entry.action_name} ${entry.ok === false ? "failed" : "ok"}` : describeSource(entry.decision_source);
  const extra = entry.intervention_count > 0 ? ` · ${entry.intervention_count} edit(s)` : "";
  const turnNo = entry.turn_index !== null ? `t${String(entry.turn_index).padStart(2, "0")}` : "t?";
  return `${turnNo} · ${name(entry.acting_agent_id)} · ${what}${extra} — ${entry.turn_id}`;
}

function describeSource(source: TurnIndexEntry["decision_source"]): string {
  switch (source) {
    case "skipped_dead":
      return "skipped (dead)";
    case "skipped_removed":
      return "skipped (removed)";
    case "skipped_unaffordable":
      return "skipped (cannot afford a decision)";
    case "wait":
      return "waiting";
    case "skill":
      return "skill step";
    case "model":
      return "no action (invalid decision)";
    case "none":
      return "no action";
  }
}

/** The latest turn at or before `shownTurnId` in which `agentId` took a model decision. */
export function latestModelTurn(turns: readonly TurnIndexEntry[], agentId: string, shownTurnId: string): TurnIndexEntry | null {
  const end = turns.findIndex((t) => t.turn_id === shownTurnId);
  const upTo = end >= 0 ? turns.slice(0, end + 1) : turns;
  for (let i = upTo.length - 1; i >= 0; i -= 1) {
    const t = upTo[i];
    if (t.acting_agent_id === agentId && t.decision_source === "model") return t;
  }
  return null;
}
