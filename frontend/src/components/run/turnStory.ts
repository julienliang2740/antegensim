/**
 * Plain-language pieces of a turn record (spec U5 "all actions and state per
 * turn"; "Display and historical inspection": identify who did what, the
 * result and the costs; expose changes alongside their action/model records).
 * Pure functions (no React) used by TurnRecordTab to tell a turn as a story
 * an operator can read top to bottom.
 */

import type { ActionResult, Agent, Event, FieldChange, TurnRecord, TurnView } from "../../api/types";
import { findEntity } from "../../api/types";
import { fmtNum, fmtPoint } from "../inspect";
import { compactValue, describeRecordChange } from "../../state/changes";
import type { AgentNamer } from "../../state/statusText";

export type TurnAction = NonNullable<TurnRecord["action"]>;

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return fmtNum(value);
  if (value && typeof value === "object" && "x" in value && "y" in value) return fmtPoint(value as { x: number; y: number });
  return compactValue(value, 60);
}

function num(value: unknown): string {
  return typeof value === "number" ? fmtNum(value) : str(value);
}

/** "fruit f0004", "residue res0002", "plant p0001 (berry)", "a05 Eos" — what an id refers to in the viewed turn. */
export function describeId(id: unknown, view: TurnView | null, name: AgentNamer): string {
  if (typeof id !== "string") return str(id);
  if (id === "self") return "itself";
  const entity = view ? (findEntity(view.entities, id) ?? null) : null;
  if (entity?.kind === "agent" || /^a\d+$/.test(id)) return name(id);
  if (entity?.kind === "plant") return `plant ${id} (${entity.species})`;
  if (entity) return `${entity.kind} ${id}`;
  const removed = view?.entities.removed[id];
  if (removed) return `${removed.kind} ${id}`;
  if (/^f\d+$/.test(id)) return `fruit ${id}`;
  if (/^res\d+$/.test(id)) return `residue ${id}`;
  if (/^p\d+$/.test(id)) return `plant ${id}`;
  if (/^s\d+$/.test(id)) return `seed ${id}`;
  return id;
}

/** Past-tense phrase for what the agent did: "attacked a05 Eos with 5 compute". */
export function actionPhrase(action: TurnAction, view: TurnView | null, name: AgentNamer): string {
  const a = action.args;
  switch (action.name) {
    case "move":
      return `moved ${str(a.direction)}`;
    case "observe":
      return `observed ${str(a.point)}${typeof a.page === "number" && a.page > 0 ? ` (page ${a.page})` : ""}`;
    case "query":
      return `queried ${describeId(a.entity, view, name)}`;
    case "send":
      return `sent a message to ${describeId(a.recipient, view, name)}`;
    case "broadcast":
      return "broadcast a message";
    case "absorb":
      return `absorbed ${str(a.resource)} from ${describeId(a.source, view, name)}`;
    case "transfer":
      return `transferred ${num(a.amount)} ${str(a.resource)} to ${describeId(a.recipient, view, name)}`;
    case "recover":
      return `recovered health with a budget of ${num(a.compute_budget)} compute`;
    case "attack":
      return `attacked ${describeId(a.target, view, name)} with a budget of ${num(a.compute_budget)} compute`;
    case "upgrade":
      return `upgraded ${str(a.attribute)}`;
    case "wait":
      return `waited ${num(a.rounds)} turn(s)`;
    case "run_skill":
      return `ran skill ${str(a.skill)}`;
    default:
      return `did ${action.name}`;
  }
}

/** What happened when there is no action: the decision source in words. */
export function noActionPhrase(turn: TurnRecord, events: readonly Event[]): string {
  switch (turn.decision_source) {
    case "skipped_unaffordable":
      return "was skipped: it could not afford to think (not enough compute for the minimum decision packet)";
    case "skipped_dead":
      return "was skipped: it is dead";
    case "skipped_removed":
      return "was skipped: it was removed from the world";
    case "wait":
      return "kept waiting (a wait action from an earlier turn)";
    case "model": {
      const failed = events.some((e) => e.kind === "model_call_failed");
      const invalid = events.some((e) => e.kind === "decision_invalid");
      if (invalid) return "made no valid decision, so nothing happened";
      if (failed) return "got no usable answer from its model, so nothing happened";
      return "took no action";
    }
    case "skill":
      return "continued its skill without a world action";
    default:
      return "took no action";
  }
}

/** Effects of an action result as readable lines (the same facts the backend tells the agent). */
export function effectLines(result: ActionResult, view: TurnView | null, name: AgentNamer): string[] {
  const e = result.effects;
  const lines: string[] = [];
  const used = new Set<string>();
  const take = (...keys: string[]) => keys.forEach((k) => used.add(k));
  if (e.from !== undefined && e.to !== undefined && typeof e.to === "object") {
    lines.push(`Moved from ${str(e.from)} to ${str(e.to)}.`);
    take("from", "to");
  }
  if (e.gained !== undefined) {
    lines.push(
      `Took ${num(e.processed)} ${str(e.resource)} from ${describeId(e.source, view, name)}: gained ${num(e.gained)}, lost ${num(e.lost)} in absorption.`,
    );
    take("processed", "gained", "lost", "source", "resource");
  }
  if (e.transferred !== undefined) {
    lines.push(`Gave ${num(e.transferred)} ${str(e.resource)} to ${describeId(e.to, view, name)}.`);
    take("transferred", "resource", "to");
  }
  if (e.healed !== undefined) {
    lines.push(`Healed ${num(e.healed)}; health is now ${num(e.health)}.`);
    take("healed", "health");
  }
  if (e.damage !== undefined) {
    lines.push(`Dealt ${num(e.damage)} damage to ${describeId(e.target, view, name)}; its health is now ${num(e.target_health_after)}${e.killed ? " and it died" : ""}.`);
    take("damage", "target", "target_health_after", "killed");
  }
  if (e.purchased !== undefined) {
    lines.push(`Bought ${str(e.purchased)}: now ${num(e.new_value)} (price ${num(e.compute)} compute${typeof e.essence === "number" && e.essence > 0 ? ` + ${num(e.essence)} essence` : ""}).`);
    take("purchased", "new_value", "compute", "essence");
  }
  if (e.waiting_turns !== undefined) {
    lines.push(`Will wait ${num(e.waiting_turns)} turn(s).`);
    take("waiting_turns");
  }
  if (e.delivered !== undefined) {
    lines.push(e.delivered ? "The message was delivered." : "The message was not delivered.");
    take("delivered");
  }
  if (e.delivered_visible !== undefined) {
    lines.push(`Heard by ${num(e.delivered_visible)} agent(s) in range.`);
    take("delivered_visible");
  }
  for (const [key, value] of Object.entries(e)) {
    if (!used.has(key)) lines.push(`${key.replace(/_/g, " ")}: ${str(value)}`);
  }
  return lines;
}

/** "gained 12 compute", "dealt 10 damage", "moved to (1, 0)": the one effect worth a headline. */
export function headlineEffect(result: ActionResult, view: TurnView | null, name: AgentNamer): string | null {
  const e = result.effects;
  if (e.gained !== undefined) return `gained ${num(e.gained)} ${str(e.resource)}`;
  if (e.damage !== undefined) return `dealt ${num(e.damage)} damage${e.killed ? `, killed ${describeId(e.target, view, name)}` : ""}`;
  if (e.healed !== undefined) return `healed ${num(e.healed)}`;
  if (e.to !== undefined && typeof e.to === "object") return `now at ${str(e.to)}`;
  if (e.transferred !== undefined) return `gave ${num(e.transferred)} ${str(e.resource)}`;
  if (e.purchased !== undefined) return `${str(e.purchased)} now ${num(e.new_value)}`;
  return null;
}

/** "cost 5 compute" / "cost 3 compute + 1 essence" (the action's charge; thinking is separate). */
export function chargeText(result: ActionResult): string {
  return `cost ${fmtNum(result.cost_compute)} compute${result.cost_essence > 0 ? ` + ${fmtNum(result.cost_essence)} essence` : ""}`;
}

/** Labelled arguments of an action ("compute budget: 5"). */
export function argRows(action: TurnAction, view: TurnView | null, name: AgentNamer): { label: string; value: string }[] {
  return Object.entries(action.args).map(([key, value]) => {
    const label = key.replace(/_/g, " ");
    if (["target", "recipient", "source", "entity"].includes(key)) return { label, value: describeId(value, view, name) };
    if (key === "message" && typeof value === "string") return { label, value: `“${value}”` };
    if (key === "arguments" && Array.isArray(value)) return { label, value: value.length ? value.map((v) => str(v)).join(", ") : "(none)" };
    return { label, value: str(value) };
  });
}

/** The agent's own thought and decision extras, from the turn's `decision` event. */
export interface DecisionInfo {
  thought: string | null;
  notebookUpdated: boolean;
  savedSkills: string[];
  deletedSkills: string[];
  memoryPriorities: number;
}

export function decisionInfo(events: readonly Event[]): DecisionInfo | null {
  const decision = [...events].reverse().find((e) => e.kind === "decision");
  if (!decision) return null;
  const d = decision.details;
  const names = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : v && typeof v === "object" && "name" in v ? String((v as { name: unknown }).name) : "?")) : [];
  return {
    thought: typeof d.thought === "string" && d.thought.trim() ? d.thought.trim() : null,
    notebookUpdated: d.notebook_updated === true,
    savedSkills: names(d.saved_skills),
    deletedSkills: names(d.deleted_skills),
    memoryPriorities: Array.isArray(d.memory_priorities) ? d.memory_priorities.length : 0,
  };
}

/** Why a model turn produced no decision (invalid reply or failed call), from the events. */
export function decisionProblem(events: readonly Event[]): string | null {
  const invalid = events.find((e) => e.kind === "decision_invalid");
  if (invalid && typeof invalid.details.reason === "string") return invalid.details.reason;
  const failed = events.find((e) => e.kind === "model_call_failed");
  if (failed) return typeof failed.details.error === "string" && failed.details.error ? failed.details.error : failed.summary;
  const skip = events.find((e) => e.kind === "resource_skip");
  if (skip && typeof skip.details.reason === "string") return skip.details.reason;
  return null;
}

const THINKING_KINDS = new Set(["model_call_completed", "model_call_failed", "cognition_charged"]);

/** Compute charged for thinking (cognition) in this turn: it is carried by the model call's completion or failure event. */
export function thinkingCost(events: readonly Event[]): number {
  return events.filter((e) => THINKING_KINDS.has(e.kind)).reduce((sum, e) => sum + (e.costs.compute || 0), 0);
}

/** Compute charged for running skill instructions (the interpreter) in this turn. */
export function interpreterCost(events: readonly Event[]): number {
  return events.filter((e) => e.kind.startsWith("skill_")).reduce((sum, e) => sum + (e.costs.compute || 0), 0);
}

// ---------------------------------------------------------------------------
// State change
// ---------------------------------------------------------------------------

export interface StatRow {
  label: string;
  before: string;
  after: string;
  delta: string | null;
  changed: boolean;
}

function deltaText(before: number, after: number): string | null {
  const d = after - before;
  if (Math.abs(d) < 1e-9) return null;
  return `${d > 0 ? "+" : "−"}${fmtNum(Math.abs(d))}`;
}

/** Compute, health, essence (and position, life) of an agent before and after. */
export function agentStatRows(before: Agent | null, after: Agent | null): StatRow[] {
  const rows: StatRow[] = [];
  const numRow = (label: string, b: number | undefined, a: number | undefined, suffix = "") => {
    rows.push({
      label,
      before: b === undefined ? "—" : `${fmtNum(b)}${suffix}`,
      after: a === undefined ? "—" : `${fmtNum(a)}${suffix}`,
      delta: b !== undefined && a !== undefined ? deltaText(b, a) : null,
      changed: b !== a,
    });
  };
  numRow("compute", before?.stats.compute, after?.stats.compute);
  numRow("health", before?.stats.health, after?.stats.health, "");
  numRow("essence", before?.stats.essence, after?.stats.essence);
  const bp = before ? fmtPoint(before.position) : "—";
  const ap = after ? fmtPoint(after.position) : "—";
  if (bp !== ap) rows.push({ label: "position", before: bp, after: ap, delta: null, changed: true });
  if (before && after && before.alive !== after.alive) rows.push({ label: "alive", before: String(before.alive), after: String(after.alive), delta: null, changed: true });
  return rows;
}

/** Agent ids an action result names besides the actor (attack target, transfer recipient). */
export function otherAgentsTouched(result: ActionResult | null, actorId: string | null): string[] {
  if (!result) return [];
  const ids = [result.effects.target, result.effects.to].filter((v): v is string => typeof v === "string" && /^a\d+$/.test(v) && v !== actorId);
  return Array.from(new Set(ids));
}

// ---------------------------------------------------------------------------
// Edits (interventions): changed fields only
// ---------------------------------------------------------------------------

export interface ChangeLine {
  path: string;
  text: string;
}

const MAX_LEAVES = 12;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Leaf-level differences between two JSON values ("rules.plant_species.berry.fruit_energy: 60 → 70"). */
function leafDiff(path: string, before: unknown, after: unknown, out: ChangeLine[]): void {
  if (out.length > MAX_LEAVES) return;
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
    for (const k of keys) leafDiff(`${path}.${k}`, before[k], after[k], out);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    before.forEach((b, i) => leafDiff(`${path}[${i}]`, b, after[i], out));
    return;
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  out.push({ path, text: `${compactValue(before, 60)} → ${compactValue(after, 60)}` });
}

/** One readable line per changed field of a FieldChange (knowledge records as one sentence). */
export function changeLines(change: FieldChange): ChangeLine[] {
  const sentence = describeRecordChange(change);
  if (sentence) return [{ path: change.path, text: sentence }];
  const out: ChangeLine[] = [];
  leafDiff(change.path, change.before, change.after, out);
  if (out.length === 0) out.push({ path: change.path, text: `${compactValue(change.before, 60)} → ${compactValue(change.after, 60)}` });
  return out;
}

// ---------------------------------------------------------------------------
// Round end
// ---------------------------------------------------------------------------

export interface RoundEndSummary {
  growth: string[];
  spawns: string[];
  upkeep: { agentId: string; paid: number; owed: number }[];
  starvation: string[];
  deaths: string[];
  other: string[];
  ended: string | null;
}

export function roundEndSummary(events: readonly Event[]): RoundEndSummary {
  const s: RoundEndSummary = { growth: [], spawns: [], upkeep: [], starvation: [], deaths: [], other: [], ended: null };
  for (const e of events) {
    switch (e.kind) {
      case "plant_growth":
        s.growth.push(e.summary);
        break;
      case "fruit_spawned":
      case "seed_spawned":
      case "germination":
      case "fruit_removed":
      case "residue_created":
        s.spawns.push(e.summary);
        break;
      case "upkeep":
        s.upkeep.push({
          agentId: typeof e.details.agent_id === "string" ? e.details.agent_id : e.actor,
          paid: typeof e.details.paid === "number" ? e.details.paid : e.costs.compute,
          owed: typeof e.details.owed === "number" ? e.details.owed : e.costs.compute,
        });
        break;
      case "starvation":
        s.starvation.push(e.summary);
        break;
      case "death":
        s.deaths.push(e.summary);
        break;
      case "round_ended":
        s.ended = e.summary;
        break;
      case "round_started":
        break;
      default:
        if (e.kind !== "intervention") s.other.push(e.summary);
    }
  }
  return s;
}
