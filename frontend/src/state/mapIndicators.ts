/**
 * Drawable action marks of the viewed turn for the 2D map, computed from the shared
 * TurnEffect list (state/turnEffects.ts) and nothing else: a badge on the acting agent,
 * a move arrow, rings on the entities an action touched, links across cells, the
 * observed cell, a broadcast reach and the amounts (damage, gained, healed) to print.
 * Pure (no React); MapView resolves cells to dot centres and draws.  Tested by
 * src/state/state.test.mjs ("map indicators: ...").
 *
 * DOCS: marks show the VIEWED turn only (live: the last saved turn); the pending agent's
 * pulsing ring is separate and comes from RunStatus, not from here.  Rings, links and amounts
 * appear only for an action that took effect: a failed one draws only its red badge (a
 * blocked move also its ⊣ stroke).
 */

import type { Direction, Point, TurnKind } from "../api/types";
import { parseTurnId } from "../api/types";
import type { TurnEffect } from "./turnEffects";
import { stepDirection } from "./turnEffects";

export type Glyph = "move" | "attack" | "message" | "absorb" | "transfer" | "recover" | "upgrade" | "wait" | "observe" | "query" | "skill" | "none";
export type Tone = "act" | "bad" | "good" | "absorb" | "message" | "query" | "dead" | "growth" | "fruit" | "seed" | "voice";

export type Mark =
  | { type: "badge"; id: string; at: Point; glyph: Glyph; direction: Direction | null; ok: boolean }
  | { type: "arrow"; id: string; from: Point; to: Point; ok: boolean }
  | { type: "ring"; id: string; at: Point; tone: Tone }
  | { type: "link"; fromId: string | null; toId: string | null; from: Point; to: Point; tone: Tone; dashed: boolean }
  | { type: "cell"; at: Point; tone: "query" }
  | { type: "reach"; id: string; at: Point; radiusCells: number }
  | { type: "amount"; id: string | null; at: Point; text: string; tone: "bad" | "good" };

export interface TurnMarks {
  turnId: string;
  /** parseTurnId(turnId).kind ("init" for an empty id). */
  kind: TurnKind;
  /** Agent turns: the acting agent (from the effect, else from the turn id); null otherwise. */
  actorId: string | null;
  /** At most MAX_MARKS, in drawing order. */
  marks: Mark[];
  /** Every entity id a mark names (unique, no nulls): the dot priority list of the map. */
  markedIds: string[];
  /** Marks cut by MAX_MARKS. */
  dropped: number;
}

export interface MarkOptions {
  /** Agent view: the viewing agent; only its own badge and arrow are kept. */
  agentViewOf?: string | null;
  /** Agent view: where the overlay draws the viewer (its believed position). */
  agentViewAt?: Point | null;
  /** The acting agent's communication range in cells (the map reads it from entities); null → no reach mark. */
  communicationRange?: number | null;
  /** Position of an entity in the viewed turn (the map's markers); used for the no-action badge and for targets without a recorded cell. */
  positionOf?: (id: string) => Point | null;
}

export const MAX_MARKS = 60;
export const ACTING_KINDS: ReadonlySet<TurnEffect["kind"]> = new Set(["move", "attack", "message", "absorb", "transfer", "recover", "upgrade", "wait", "observe", "query", "skill"]);

const WORLD_ACTORS = new Set(["world", "operator"]);

/** The acting agent's effect: the first one of an action kind whose actor is an agent, or null. */
export function findActing(effects: readonly TurnEffect[]): TurnEffect | null {
  return effects.find((e) => ACTING_KINDS.has(e.kind) && !WORLD_ACTORS.has(e.actor)) ?? null;
}

/** The badge glyph of an action effect ("none" for world events). */
export function glyphFor(effect: TurnEffect): Glyph {
  switch (effect.kind) {
    case "move":
    case "attack":
    case "message":
    case "absorb":
    case "transfer":
    case "recover":
    case "upgrade":
    case "wait":
    case "observe":
    case "query":
    case "skill":
      return effect.kind;
    default:
      return "none";
  }
}

/** Every id a mark list names, unique, in order. */
export function markedIds(marks: readonly Mark[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  for (const m of marks) {
    if (m.type === "link") {
      add(m.fromId);
      add(m.toId);
    } else if (m.type !== "cell") add(m.id);
  }
  return out;
}

/** Short numbers for amounts: 5, 2.5, 0.25 (same as turnEffects' labels). */
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

/** The cell of `effect.targets[i]`: its recorded point when every target has one, else the map's position, else null. */
function targetPoint(effect: TurnEffect, i: number, opts: MarkOptions): Point | null {
  if (effect.targetPoints.length === effect.targets.length) return effect.targetPoints[i] ?? null;
  return opts.positionOf?.(effect.targets[i]) ?? null;
}

function stepOf(from: Point | null, to: Point | null): Direction | null {
  if (!from || !to) return null;
  const dir = stepDirection(from, to);
  return dir === "up" || dir === "down" || dir === "left" || dir === "right" ? dir : null;
}

/**
 * The marks of the acting agent's effect (never cut by MAX_MARKS).  A failed action draws its
 * red badge only (a blocked move also its failed arrow): nothing was hit, fed from, heard,
 * given or queried, so no ring, link or amount may say otherwise.
 */
function actingMarks(e: TurnEffect, opts: MarkOptions): Mark[] {
  const marks: Mark[] = [];
  const at = e.at;
  if (at) marks.push({ type: "badge", id: e.actor, at, glyph: glyphFor(e), direction: e.kind === "move" ? stepOf(e.from, e.to) : null, ok: e.ok });
  if (e.kind === "move" && e.from && e.to) marks.push({ type: "arrow", id: e.actor, from: e.from, to: e.to, ok: e.ok });
  if (!e.ok) return marks;
  const link = (fromId: string | null, from: Point | null, toId: string | null, to: Point | null, tone: Tone, dashed: boolean) => {
    if (from && to && !samePoint(from, to)) marks.push({ type: "link", fromId, toId, from, to, tone, dashed });
  };
  switch (e.kind) {
    case "attack": {
      const target = e.targets[0];
      const tp = target ? targetPoint(e, 0, opts) : null;
      if (target && tp) {
        marks.push({ type: "ring", id: target, at: tp, tone: "bad" });
        link(e.actor, at, target, tp, "bad", false);
        if (e.amount !== null) marks.push({ type: "amount", id: target, at: tp, text: `−${fmt(e.amount)}`, tone: "bad" });
      }
      break;
    }
    case "message": {
      e.targets.forEach((target, i) => {
        const tp = targetPoint(e, i, opts);
        if (!tp) return;
        marks.push({ type: "ring", id: target, at: tp, tone: "message" });
        link(e.actor, at, target, tp, "message", true);
      });
      const range = opts.communicationRange;
      if (e.broadcast && at && typeof range === "number" && range >= 0) marks.push({ type: "reach", id: e.actor, at, radiusCells: range });
      break;
    }
    case "absorb": {
      const source = e.targets[0];
      const sp = source ? targetPoint(e, 0, opts) : null;
      if (source && sp) {
        marks.push({ type: "ring", id: source, at: sp, tone: "absorb" });
        link(source, sp, e.actor, at, "absorb", false);
      }
      if (at && e.amount !== null) marks.push({ type: "amount", id: e.actor, at, text: `+${fmt(e.amount)}`, tone: "good" });
      break;
    }
    case "transfer": {
      const recipient = e.targets[0];
      const rp = recipient ? targetPoint(e, 0, opts) : null;
      if (recipient && rp) {
        marks.push({ type: "ring", id: recipient, at: rp, tone: "good" });
        link(e.actor, at, recipient, rp, "good", false);
        if (e.amount !== null) marks.push({ type: "amount", id: recipient, at: rp, text: `+${fmt(e.amount)}`, tone: "good" });
      }
      break;
    }
    case "recover":
      if (at && e.amount !== null) marks.push({ type: "amount", id: e.actor, at, text: `+${fmt(e.amount)}`, tone: "good" });
      break;
    case "observe":
      if (e.to) {
        marks.push({ type: "cell", at: e.to, tone: "query" });
        link(e.actor, at, null, e.to, "query", true);
      }
      break;
    case "query": {
      const target = e.targets[0];
      const tp = target ? targetPoint(e, 0, opts) : null;
      if (target && tp) {
        marks.push({ type: "ring", id: target, at: tp, tone: "query" });
        link(e.actor, at, target, tp, "query", true);
      }
      break;
    }
    default:
      break; // move (its arrow is above); upgrade, wait, skill: badge only
  }
  return marks;
}

/** The marks of one world effect (death, starvation, growth, fruit, seed, germination, voice). */
function worldMarks(e: TurnEffect, opts: MarkOptions): Mark[] {
  const marks: Mark[] = [];
  const target = e.targets[0] ?? "";
  switch (e.kind) {
    case "death":
      if (target && e.at) marks.push({ type: "ring", id: target, at: e.at, tone: "dead" });
      break;
    case "starvation":
      if (target && e.at) {
        marks.push({ type: "ring", id: target, at: e.at, tone: "bad" });
        if (e.amount !== null) marks.push({ type: "amount", id: target, at: e.at, text: `−${fmt(e.amount)}`, tone: "bad" });
      }
      break;
    case "growth":
      if (target && e.at) marks.push({ type: "ring", id: target, at: e.at, tone: "growth" });
      break;
    case "fruit":
    case "seed":
    case "germination":
      if (e.at) marks.push({ type: "ring", id: target, at: e.at, tone: e.kind === "fruit" ? "fruit" : e.kind === "seed" ? "seed" : "growth" });
      break;
    case "voice":
      e.targets.forEach((id, i) => {
        const tp = targetPoint(e, i, opts);
        if (tp) marks.push({ type: "ring", id, at: tp, tone: "voice" });
      });
      break;
    default:
      break;
  }
  return marks;
}

/**
 * The marks of a turn from its effects (the acting effect first, then the world effects in
 * order).  One ring per entity id (the first wins; rings with an empty id are never
 * deduplicated).  The acting effect's marks are never cut; the world marks are cut at
 * MAX_MARKS in total.  Agent view keeps only the viewer's own badge and arrow at its
 * believed position.
 */
export function turnMarks(effects: readonly TurnEffect[], turnId: string, opts: MarkOptions = {}): TurnMarks {
  const parsed = turnId ? parseTurnId(turnId) : null;
  const kind: TurnKind = parsed?.kind ?? "init";
  const acting = findActing(effects);
  const actorId = kind === "agent_turn" ? (acting?.actor ?? parsed?.agentId ?? null) || null : null;

  const marks: Mark[] = [];
  const ringed = new Set<string>();
  const push = (m: Mark): void => {
    if (m.type === "ring" && m.id) {
      if (ringed.has(m.id)) return;
      ringed.add(m.id);
    }
    marks.push(m);
  };
  if (acting) {
    for (const m of actingMarks(acting, opts)) push(m);
  } else if (kind === "agent_turn" && actorId) {
    const at = opts.positionOf?.(actorId) ?? null;
    if (at) push({ type: "badge", id: actorId, at, glyph: "none", direction: null, ok: true });
  }
  let dropped = 0;
  for (const e of effects) {
    if (e === acting || ACTING_KINDS.has(e.kind)) continue;
    for (const m of worldMarks(e, opts)) {
      if (m.type === "ring" && m.id && ringed.has(m.id)) continue;
      if (marks.length >= MAX_MARKS) dropped += 1;
      else push(m);
    }
  }

  let kept = marks;
  const viewer = opts.agentViewOf ?? null;
  if (viewer) {
    const viewerAt = opts.agentViewAt ?? null;
    kept = marks.filter((m) => {
      if (!viewerAt) return false;
      if (m.type === "badge") return m.id === viewer && samePoint(m.at, viewerAt);
      if (m.type === "arrow") return m.id === viewer && samePoint(m.ok ? m.to : m.from, viewerAt);
      return false;
    });
  }
  return { turnId, kind, actorId, marks: kept, markedIds: markedIds(kept), dropped };
}

const SUMMARY_KINDS: ReadonlyArray<[TurnEffect["kind"], (n: number) => string]> = [
  ["growth", (n) => `${n} grew`],
  ["fruit", (n) => `${n} fruit`],
  ["seed", (n) => `${n} seed${n === 1 ? "" : "s"}`],
  ["germination", (n) => `${n} germinated`],
  ["starvation", (n) => `${n} starving`],
  ["death", (n) => `${n} died`],
  ["voice", (n) => `${n} voice${n === 1 ? "" : "s"}`],
];

/** " · 3 grew · 2 fruit · 1 died" for the world effects of a list (empty when there are none). */
function worldSummary(effects: readonly TurnEffect[]): string {
  let out = "";
  for (const [kind, phrase] of SUMMARY_KINDS) {
    const n = effects.filter((e) => e.kind === kind).length;
    if (n > 0) out += ` · ${phrase(n)}`;
  }
  return out;
}

/**
 * One line naming what the viewed turn did, the text twin of the marks:
 * "Turn r00012_t03_a03 · Aster (a03) attacked a05 (12 damage, killed)",
 * "Turn r00012_end · round 12 ended · 3 grew · 1 died", "Turn r00000_init · initial state";
 * with a pending agent, " · <who> is deciding now" is appended.
 */
export function captionFor(effects: readonly TurnEffect[], turnId: string, nameOf: (id: string) => string, pendingAgentId?: string | null): string {
  const parsed = turnId ? parseTurnId(turnId) : null;
  let text = `Turn ${turnId}`;
  if (!parsed || parsed.kind === "init") text += " · initial state";
  else if (parsed.kind === "round_end") text += ` · round ${parsed.round} ended${worldSummary(effects)}`;
  else {
    const acting = findActing(effects);
    if (acting) text += ` · ${nameOf(acting.actor)} ${acting.label}`;
    else text += ` · ${nameOf(parsed.agentId ?? "?")} took no action${worldSummary(effects)}`;
  }
  if (pendingAgentId) text += ` · ${nameOf(pendingAgentId)} is deciding now`;
  return text;
}
