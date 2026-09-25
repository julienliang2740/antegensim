/**
 * Pure helpers for the live activity feed (INTERFACES section 7 "Events";
 * spec U13 and "Display and historical inspection": identify round/turn,
 * actor, action, result and costs; distinguish pending activity from
 * completed effects; operator activity stays distinguishable).
 */

import type { Event, EventKind, RunStatus } from "../api/types";

/** The feed keeps at most this many lines in memory (older ones drop off the top). */
export const MAX_FEED_EVENTS = 3000;

/** Add new events, dropping duplicates by seq and keeping seq order. */
export function mergeEvents(current: readonly Event[], incoming: readonly Event[]): Event[] {
  if (incoming.length === 0) return current as Event[];
  const seen = new Set(current.map((e) => e.seq));
  const fresh = incoming.filter((e) => !seen.has(e.seq));
  if (fresh.length === 0) return current as Event[];
  const lastSeq = current.length > 0 ? current[current.length - 1].seq : -1;
  const appendable = fresh[0].seq > lastSeq && fresh.every((e, i) => i === 0 || e.seq > fresh[i - 1].seq);
  const merged = appendable ? [...current, ...fresh] : [...current, ...fresh].sort((a, b) => a.seq - b.seq);
  return merged.length > MAX_FEED_EVENTS ? merged.slice(merged.length - MAX_FEED_EVENTS) : merged;
}

/** "[r1 t3]" for agent turns, "[r1 end]" for round-end events, "[r0 init]" for the initial checkpoint. */
export function feedTag(event: Event): string {
  if (event.turn !== null && event.turn !== undefined) return `[r${event.round} t${event.turn}]`;
  if (event.turn_id.endsWith("_init")) return `[r${event.round} init]`;
  return `[r${event.round} end]`;
}

/** Charges on one line ("1 compute, 0.5 essence"); empty when nothing was charged. */
export function costText(event: Event): string {
  const parts: string[] = [];
  if (event.costs.compute) parts.push(`${roundForDisplay(event.costs.compute)} compute`);
  if (event.costs.essence) parts.push(`${roundForDisplay(event.costs.essence)} essence`);
  return parts.join(", ");
}

function roundForDisplay(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

export type CallOutcome = "completed" | "failed";

/** Call ids that have a completion or failure event in the feed, with which of the two it was. */
export function resolvedCallIds(events: readonly Event[]): Map<string, CallOutcome> {
  const ids = new Map<string, CallOutcome>();
  for (const e of events) {
    if (e.kind === "model_call_completed" || e.kind === "model_call_failed") {
      const id = e.details.call_id;
      if (typeof id === "string") ids.set(id, e.kind === "model_call_completed" ? "completed" : "failed");
    }
  }
  return ids;
}

export type PendingStatus = "waiting" | "answered" | "failed" | "no_answer";

/**
 * A `model_call_pending` event is never flipped by the backend: it is
 * "answered" once a completion with the same call id arrives, "failed" when
 * the resolving event is a model_call_failed (so the line never contradicts
 * the failure printed under it), "waiting" while the run is still inside that
 * turn, and "no_answer" when the turn moved on without one (for example after
 * an error and recovery).
 */
export function pendingStatus(event: Event, resolved: ReadonlyMap<string, CallOutcome>, status: RunStatus | null): PendingStatus {
  const callId = typeof event.details.call_id === "string" ? event.details.call_id : "";
  const outcome = callId ? resolved.get(callId) : undefined;
  if (outcome === "completed") return "answered";
  if (outcome === "failed") return "failed";
  if (status && (status.pending_model_call?.call_id === callId || status.active_turn_id === event.turn_id)) return "waiting";
  return "no_answer";
}

/** "$0.0133" for a reported provider cost; null when the provider reported none. */
export function usdText(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : null;
}

/**
 * Seqs of feed lines that belong to a DISCARDED attempt of `turn`: events with
 * the saved turn's id whose seq lies below the range the turn recorded.  A
 * failed attempt's round_started / turn_started lines are not carried into the
 * re-run (INTERFACES section 8 carries only the call and error events), so
 * once the turn commits they are no longer part of recorded history.
 */
export function discardedAttemptSeqs(events: readonly Event[], turn: { turn_id: string; event_seq_start: number } | null): number[] {
  if (!turn || turn.event_seq_start <= 0) return [];
  return events.filter((e) => e.turn_id === turn.turn_id && e.seq < turn.event_seq_start).map((e) => e.seq);
}

export type LineCategory = "operator" | "error" | "pending" | "world" | "system" | "agent" | "death";

const ERROR_KINDS: EventKind[] = ["error", "model_call_failed", "decision_invalid", "skill_error", "skill_rejected", "resource_skip"];
const DEATH_KINDS: EventKind[] = ["death", "damage", "starvation"];

/** Visual category of a feed line. */
export function lineCategory(event: Event): LineCategory {
  if (event.pending) return "pending";
  if (event.actor === "operator" || event.kind === "intervention" || event.kind === "operator_voice") return "operator";
  if (ERROR_KINDS.includes(event.kind)) return "error";
  if (event.kind === "action" && event.details.result && typeof event.details.result === "object" && (event.details.result as { ok?: unknown }).ok === false) {
    return "error";
  }
  if (DEATH_KINDS.includes(event.kind)) return "death";
  if (event.actor === "world") return "world";
  if (event.actor === "system") return "system";
  return "agent";
}

/** Bookkeeping kinds that the "hide routine world events" filter hides. */
export const ROUTINE_KINDS: EventKind[] = ["upkeep", "plant_growth", "fruit_spawned", "fruit_removed", "seed_spawned", "germination"];

/**
 * Extra detail printed after a feed line's summary (spec "Display and
 * historical inspection": show errors).  The summary of a failed model call
 * only names the status ("a01 got no answer from fake-heuristic: error"); the
 * cause is in `details.error` (INTERFACES section 7), and an invalid
 * decision's cause is in `details.reason`.
 */
export function eventDetailNote(event: Event): string | null {
  const d = event.details;
  if (event.kind === "model_call_failed") {
    const parts: string[] = [];
    if (typeof d.error === "string" && d.error) parts.push(d.error);
    if (typeof d.attempts === "number") parts.push(`${d.attempts} attempt${d.attempts === 1 ? "" : "s"}`);
    const usd = usdText(d.provider_cost_usd);
    if (d.interrupted === true) parts.push("interrupted by a restart");
    else if (d.infra === true) parts.push("infrastructure failure: no world compute charged");
    // The provider may still have billed the call (a reply that arrived but was rejected, or a timeout after work).
    if (usd && d.provider_cost_usd !== 0) parts.push(`provider billed ${usd} (in Real model usage)`);
    if (typeof d.latency_ms === "number") parts.push(`${(d.latency_ms / 1000).toFixed(1)} s`);
    return parts.length ? parts.join(" · ") : null;
  }
  if (event.kind === "model_call_completed") {
    const parts: string[] = [];
    if (typeof d.latency_ms === "number") parts.push(`${(d.latency_ms / 1000).toFixed(1)} s`);
    const usd = usdText(d.provider_cost_usd);
    if (usd) parts.push(`provider ${usd}`);
    const usage = d.usage && typeof d.usage === "object" ? (d.usage as { reasoning_tokens?: unknown }) : null;
    if (usage && typeof usage.reasoning_tokens === "number" && usage.reasoning_tokens > 0) parts.push(`${usage.reasoning_tokens} reasoning tokens (part of output)`);
    return parts.length ? parts.join(" · ") : null;
  }
  if (event.kind === "decision_invalid" && typeof d.reason === "string" && d.reason) return `reason: ${d.reason}`;
  if (event.kind === "error" && typeof d.message === "string" && d.message && !event.summary.includes(d.message)) return d.message;
  return null;
}

/** "r00001_t05_a01" -> "a01"; null for round-end and initial turn ids. */
export function agentOfTurnId(turnId: string): string | null {
  const match = /^r\d+_t\d+_(.+)$/.exec(turnId);
  return match ? match[1] : null;
}

/** What the feed says about the latest failed turn attempt (the run's `error` state). */
export interface FailedTurnInfo {
  turnId: string;
  agentId: string | null;
  /** From the attempt's model_call_pending event. */
  modelKey: string | null;
  callId: string | null;
  attempts: number | null;
  /** `details.error` of the attempt's latest model_call_failed event (the provider's own words). */
  callError: string | null;
  /** `details.message` of the `error` event (the same text as RunStatus.last_error). */
  message: string | null;
  infra: boolean | null;
  /** `details.provider_cost_usd` of the failed call: what the provider billed although the turn was lost. */
  providerCostUsd: number | null;
}

/**
 * The newest `error` event in the feed and the model call failure of the same
 * turn (INTERFACES section 8: a failed attempt's call record and `error`
 * event are carried, uncommitted, into the re-run of the same turn id).
 * Events at or below `committedSeq` belong to a saved turn and are ignored.
 */
export function latestFailedTurn(events: readonly Event[], committedSeq: number | null): FailedTurnInfo | null {
  let errorEvent: Event | null = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].kind === "error") {
      errorEvent = events[i];
      break;
    }
  }
  if (!errorEvent || (committedSeq !== null && errorEvent.seq <= committedSeq)) return null;
  const turnId = errorEvent.turn_id;
  const upTo = errorEvent.seq;
  const ofTurn = events.filter((e) => e.turn_id === turnId && e.seq <= upTo && (committedSeq === null || e.seq > committedSeq));
  const failed = [...ofTurn].reverse().find((e) => e.kind === "model_call_failed") ?? null;
  const callId = failed && typeof failed.details.call_id === "string" ? failed.details.call_id : null;
  const pending =
    ofTurn.find((e) => e.kind === "model_call_pending" && callId !== null && e.details.call_id === callId) ??
    [...ofTurn].reverse().find((e) => e.kind === "model_call_pending") ??
    null;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return {
    turnId,
    agentId: agentOfTurnId(turnId),
    modelKey: pending ? text(pending.details.model_key) : null,
    callId,
    attempts: failed && typeof failed.details.attempts === "number" ? failed.details.attempts : null,
    callError: failed ? text(failed.details.error) : null,
    message: text(errorEvent.details.message),
    infra: failed && typeof failed.details.infra === "boolean" ? failed.details.infra : null,
    providerCostUsd: failed && typeof failed.details.provider_cost_usd === "number" ? failed.details.provider_cost_usd : null,
  };
}

/**
 * How a feed line above the last saved turn is tagged: while a turn runs it
 * is "in progress"; when the run is idle (paused / error / finished) such a
 * line belongs to a failed or interrupted attempt that is carried into the
 * re-run of the same turn (INTERFACES section 8), not to a running turn.
 */
export function unsavedLineTag(status: RunStatus | null): string {
  if (status && (status.state === "paused" || status.state === "error" || status.state === "finished")) return "failed attempt: carried into the re-run";
  return "in progress";
}
