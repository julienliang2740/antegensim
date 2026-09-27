/**
 * Plain-language run status and which run controls are allowed
 * (INTERFACES section 3 "Status machine"; spec "Sessions and run controls":
 * show round, turn, acting agent and status incl. waiting for a model and
 * errors; "Pause requested" while a turn finishes; prevent overlapping
 * commands).
 */

import type { ModelInfo, RunSettings, RunState, RunStatus } from "../api/types";
import { roundOfTurnId } from "./timeline";

/** States in which no turn is being worked on. */
export const IDLE_STATES: RunState[] = ["paused", "finished", "error"];

export function isIdle(status: RunStatus | null): boolean {
  return status === null || IDLE_STATES.includes(status.state);
}

export type AgentNamer = (agentId: string | null | undefined) => string;

/** Short state word shown in the big badge. */
export function stateWord(state: RunState): string {
  switch (state) {
    case "paused":
      return "Paused";
    case "running":
      return "Running";
    case "turn_active":
      return "Turn in progress";
    case "waiting_model":
      return "Waiting for model";
    case "pause_requested":
      return "Pause requested";
    case "error":
      return "Error";
    case "finished":
      return "Finished";
  }
}

/** One sentence describing what the run is doing now. */
export function stateSentence(status: RunStatus, name: AgentNamer): string {
  const command =
    status.active_command === "play"
      ? "playing continuously"
      : status.active_command === "step_round"
        ? "stepping to the end of the round"
        : status.active_command === "run_turn"
          ? "running one turn"
          : null;
  switch (status.state) {
    case "paused":
      return "Paused at a turn boundary. Nothing runs until you start the simulation, advance one turn or finish the round.";
    case "running":
      return `Running (${command ?? "starting"}).`;
    case "turn_active":
      return `Turn in progress for ${name(status.acting_agent_id)}${command ? ` (${command})` : ""}.`;
    case "waiting_model": {
      const call = status.pending_model_call;
      return `Waiting for model: ${name(call?.agent_id ?? status.acting_agent_id)}${call ? ` (${call.model_key})` : ""}${command ? `, ${command}` : ""}.`;
    }
    case "pause_requested":
      return "Pause requested: the current turn finishes and is saved, then the run pauses.";
    case "error":
      return "Error: the turn was not committed. Recover (pause) discards the failed attempt and re-runs the same turn next time.";
    case "finished":
      return `Finished${status.finished_reason ? `: ${status.finished_reason}` : ""}. Run commands apply staged edits and re-check the finish condition.`;
  }
}

/**
 * What the next Run turn does.  `next_step` is computed from the last saved
 * checkpoint, so the round comes from current_turn_id (status.round is the
 * in-progress round while a turn runs).
 */
export function nextStepText(status: RunStatus, name: AgentNamer): string {
  if (status.active_turn_id) return `finish ${status.active_turn_id} (in progress)`;
  const savedRound = roundOfTurnId(status.current_turn_id);
  switch (status.next_step) {
    case "agent_turn":
      return status.next_agent_id ? `agent turn for ${name(status.next_agent_id)}` : "agent turn";
    case "round_end":
      return `round ${savedRound} end (plants grow, upkeep, cleanup)`;
    case "new_round": {
      const order = status.next_round_order;
      if (order && order.length > 0) {
        // Every agent, in order: an operator targeting a later agent needs to see how many
        // paid turns come first (the Next step row wraps instead of cutting the text).
        const shown = order.map((id) => name(id)).join(", ");
        return `start round ${savedRound + 1} — likely order (${order.length} agents): ${shown} (predicted; staged edits can change it)`;
      }
      return `start round ${savedRound + 1} (new initiative order)`;
    }
  }
}

export interface ControlAvailability {
  runTurn: boolean;
  play: boolean;
  pause: boolean;
  stepRound: boolean;
  recover: boolean;
}

/**
 * run_turn / play / step_round are accepted in paused and finished; pause in
 * running / turn_active / waiting_model; in error only pause ("Recover").
 * `commandInFlight` blocks everything so two commands never overlap.
 */
export function controlAvailability(status: RunStatus | null, commandInFlight: boolean): ControlAvailability {
  if (!status || commandInFlight) return { runTurn: false, play: false, pause: false, stepRound: false, recover: false };
  const canStart = status.state === "paused" || status.state === "finished";
  const active = status.state === "running" || status.state === "turn_active" || status.state === "waiting_model";
  return { runTurn: canStart, play: canStart, pause: active, stepRound: canStart, recover: status.state === "error" };
}

/** Seconds since an ISO timestamp, for "waiting for 3.2 s". */
export function secondsSince(iso: string, now: number): number {
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, (now - started) / 1000);
}

/**
 * True when every model assigned in `settings` (run default and per-agent
 * overrides) is a fake model; null while either list is unknown.  Fake calls
 * cost nothing and their token counts are estimates, so the status bar must
 * not present them as real provider usage (spec "Budget delivery and
 * inspection": real usage is separate from world compute).
 */
export function allModelsFake(settings: RunSettings | null, models: readonly ModelInfo[] | null): boolean | null {
  if (!settings || !models || models.length === 0) return null;
  const keys = [settings.default_model_key, ...Object.values(settings.model_overrides)];
  const providers = new Map(models.map((m) => [m.key, m.provider]));
  if (keys.some((key) => !providers.has(key))) return null;
  return keys.every((key) => providers.get(key) === "fake");
}

/** Label of the acting-agent fact: the in-progress turn while active, otherwise the last saved turn (INTERFACES section 3). */
export function actingAgentLabel(status: RunStatus): string {
  return status.active_turn_id ? "Acting agent" : "Acting agent (last saved turn)";
}
