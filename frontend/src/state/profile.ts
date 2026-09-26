/**
 * Pure logic of the entity profile card (components/profile): which sections
 * a kind of entity has, keyboard movement in the section list, the turns an
 * agent acted in up to the viewed turn, and what one of those turns decided
 * and sent, read from the turn's events (INTERFACES section 8 event kinds:
 * decision, action, message_delivered, model_call_*, cognition_charged).
 * Tested by src/state/state.test.mjs.
 *
 * DOCS: the Decisions and Messages sections read committed turns only (the
 * turn index and GET /turns/{turn_id}/events); a turn's events never change
 * once saved, so the card caches them.
 */

import type { EntityKind, Event, Point, TurnIndexEntry, TurnView } from "../api/types";
import { pointKey } from "../api/types";

export type ProfileSectionId = "overview" | "decisions" | "skills" | "knowledge" | "messages" | "growth" | "rules" | "history";

export interface ProfileSection {
  id: ProfileSectionId;
  label: string;
}

const AGENT_SECTIONS: ProfileSection[] = [
  { id: "overview", label: "Overview" },
  { id: "decisions", label: "Decisions" },
  { id: "skills", label: "Skills" },
  { id: "knowledge", label: "Knowledge" },
  { id: "messages", label: "Messages" },
  { id: "history", label: "History" },
];
const PLANT_SECTIONS: ProfileSection[] = [
  { id: "overview", label: "Overview" },
  { id: "growth", label: "Growth" },
  { id: "rules", label: "Rules" },
  { id: "history", label: "History" },
];
const OTHER_SECTIONS: ProfileSection[] = [
  { id: "overview", label: "Overview" },
  { id: "history", label: "History" },
];

/** How many decision / message rows one page of the card shows. */
export const PROFILE_PAGE = 10;

/** The sections of the card for an entity kind, in navigation order. */
export function profileSections(kind: EntityKind): ProfileSection[] {
  if (kind === "agent") return AGENT_SECTIONS;
  if (kind === "plant") return PLANT_SECTIONS;
  return OTHER_SECTIONS;
}

/** `wanted` when the kind has that section, else the first one (Overview). */
export function sectionFor(kind: EntityKind, wanted: ProfileSectionId): ProfileSectionId {
  const sections = profileSections(kind);
  return sections.some((s) => s.id === wanted) ? wanted : sections[0].id;
}

/** Index of the section a key moves to in a list of `count` (arrows wrap, Home/End jump), or null for other keys. */
export function navTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowUp":
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Turns in which `agentId` acted, up to and including `shownTurnId` (the whole index when it is not listed), newest first. */
export function actingTurns(turns: readonly TurnIndexEntry[], agentId: string, shownTurnId: string): TurnIndexEntry[] {
  const end = turns.findIndex((t) => t.turn_id === shownTurnId);
  const upTo = end >= 0 ? turns.slice(0, end + 1) : turns;
  const result: TurnIndexEntry[] = [];
  for (let i = upTo.length - 1; i >= 0; i -= 1) {
    const t = upTo[i];
    if (t.kind === "agent_turn" && t.acting_agent_id === agentId) result.push(t);
  }
  return result;
}

/** Actions that carry a message. */
export const MESSAGE_ACTIONS: ReadonlySet<string> = new Set(["send", "broadcast"]);

/** Of `acting` (see actingTurns), the turns whose action sent a message. */
export function messageTurns(acting: readonly TurnIndexEntry[]): TurnIndexEntry[] {
  return acting.filter((t) => t.action_name !== null && MESSAGE_ACTIONS.has(t.action_name));
}

export interface DecisionSummary {
  /** The agent's thought from the turn's decision event (model decisions only). */
  thought: string | null;
  action: { name: string; args: Record<string, unknown> } | null;
  ok: boolean | null;
  reason: string | null;
  /** Charged by the world action. */
  costCompute: number;
  costEssence: number;
  /** Charged for thinking (model call completion / failure, cognition_charged). */
  thinkingCompute: number;
  viaSkill: boolean;
  skillName: string | null;
  /** Model call ids of the turn, in event order. */
  callIds: string[];
  /** Why there is no decision (invalid reply, failed call, unaffordable), or null. */
  problem: string | null;
  /** Other parts of the decision: "notebook updated", "saved skills: a, b", "deleted skills: c", "memory priorities: 2". */
  extras: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const THINKING_KINDS: ReadonlySet<string> = new Set(["model_call_completed", "model_call_failed", "cognition_charged"]);

/** What `agentId` decided and did in one turn, from that turn's events. */
export function decisionFromEvents(agentId: string, events: readonly Event[]): DecisionSummary {
  const own = events.filter((e) => e.actor === agentId);
  const decision = [...own].reverse().find((e) => e.kind === "decision");
  const actionEvent = [...own].reverse().find((e) => e.kind === "action");
  const details = actionEvent ? actionEvent.details : null;
  const action = record(details?.action);
  const result = record(details?.result);
  const callIds: string[] = [];
  for (const e of events) {
    const id = text(e.details.call_id);
    if (id && e.kind.startsWith("model_call_") && !callIds.includes(id)) callIds.push(id);
  }
  const invalid = events.find((e) => e.kind === "decision_invalid");
  const failed = events.find((e) => e.kind === "model_call_failed");
  const skip = events.find((e) => e.kind === "resource_skip");
  const problem = invalid
    ? (text(invalid.details.reason) ?? invalid.summary)
    : !actionEvent && failed
      ? (text(failed.details.error) ?? failed.summary)
      : !actionEvent && skip
        ? (text(skip.details.reason) ?? skip.summary)
        : null;
  return {
    thought: text(decision?.details.thought) ?? text(details?.thought),
    action: action && typeof action.name === "string" ? { name: action.name, args: record(action.args) ?? {} } : null,
    ok: typeof result?.ok === "boolean" ? result.ok : null,
    reason: text(result?.reason),
    costCompute: actionEvent ? number(result?.cost_compute ?? actionEvent.costs.compute) : 0,
    costEssence: actionEvent ? number(result?.cost_essence ?? actionEvent.costs.essence) : 0,
    thinkingCompute: events.filter((e) => THINKING_KINDS.has(e.kind)).reduce((sum, e) => sum + number(e.costs.compute), 0),
    viaSkill: details?.via_skill === true,
    skillName: text(details?.skill_name),
    callIds,
    problem,
    extras: decisionExtras(decision?.details ?? null),
  };
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "string" ? v : (text(record(v)?.name) ?? "?")));
}

function decisionExtras(details: Record<string, unknown> | null): string[] {
  if (!details) return [];
  const extras: string[] = [];
  if (details.notebook_updated === true) extras.push("notebook updated");
  const saved = names(details.saved_skills);
  if (saved.length) extras.push(`saved skills: ${saved.join(", ")}`);
  const deleted = names(details.deleted_skills);
  if (deleted.length) extras.push(`deleted skills: ${deleted.join(", ")}`);
  const priorities = Array.isArray(details.memory_priorities) ? details.memory_priorities.length : 0;
  if (priorities) extras.push(`memory priorities: ${priorities}`);
  return extras;
}

export interface SentMessage {
  kind: "send" | "broadcast";
  /** The addressed agent (send only). */
  recipient: string | null;
  message: string;
  ok: boolean | null;
  reason: string | null;
  /** Agents the message reached (message_delivered), empty when nobody heard it. */
  delivered: string[];
}

/** Messages `agentId` sent in one turn, from that turn's events (action send/broadcast + message_delivered). */
export function sentMessages(agentId: string, events: readonly Event[]): SentMessage[] {
  const out: SentMessage[] = [];
  const deliveries = events.filter((e) => e.actor === agentId && e.kind === "message_delivered");
  let delivery = 0;
  for (const e of events) {
    if (e.actor !== agentId || e.kind !== "action") continue;
    const action = record(e.details.action);
    const name = action?.name;
    if (name !== "send" && name !== "broadcast") continue;
    const args = record(action?.args) ?? {};
    const result = record(e.details.result);
    const ok = typeof result?.ok === "boolean" ? result.ok : null;
    // A delivery event follows each successful send/broadcast, in order.
    const reached = ok ? deliveries[delivery++] : undefined;
    const recipients = reached && Array.isArray(reached.details.recipients) ? reached.details.recipients.filter((r): r is string => typeof r === "string") : [];
    out.push({
      kind: name,
      recipient: name === "send" ? (text(args.recipient) ?? null) : null,
      message: typeof args.message === "string" ? args.message : "",
      ok,
      reason: text(result?.reason),
      delivered: recipients,
    });
  }
  return out;
}

/** The first `max` characters of a text on one line, with an ellipsis when cut. */
export function excerpt(value: string, max = 160): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Terrain at a point of a turn's map (null when the map has no cell there). */
export function terrainAt(turn: TurnView, position: Point): string | null {
  return turn.map.cells[pointKey(position)] ?? null;
}
