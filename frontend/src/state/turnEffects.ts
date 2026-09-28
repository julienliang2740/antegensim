/**
 * What happened in the viewed turn, as a list of effects the map views can
 * show: the acting agent's action (a move with its path, an attack and its
 * target, a message and its recipients, ...) and the world events of the turn
 * (deaths, plant growth, fruit and seeds, germination, starvation, an
 * operator voice).  Read from the TurnView's record (`turn.action`,
 * `turn.action_result`) and its events; nothing is inferred from the live feed,
 * so browsing history shows the indicators of the turn on screen.
 *
 * Pure functions (no React, no fetch), shared by the 2D map's action
 * indicators and the 3D view's animations.  Tested by src/state/state.test.mjs.
 *
 * DOCS: an effect is a fact of the saved turn (record + events), never a guess
 * from partial feed lines; the 2D and 3D views only decide how to draw it.
 */

import type { Event, Point, TurnView } from "../api/types";
import { findEntity } from "../api/types";

/** The kinds of effect a turn can show.  Agent actions first, then world events. */
export type EffectKind =
  | "move"
  | "attack"
  | "message"
  | "absorb"
  | "transfer"
  | "recover"
  | "upgrade"
  | "wait"
  | "observe"
  | "query"
  | "skill"
  | "death"
  | "growth"
  | "fruit"
  | "seed"
  | "germination"
  | "starvation"
  | "voice";

export interface TurnEffect {
  kind: EffectKind;
  /** The agent that acted, or "world" / "operator" for world events. */
  actor: string;
  /** Where the indicator sits: the actor's cell after the action, the plant's or the dead entity's cell.  Null when unknown. */
  at: Point | null;
  /** A move's origin (also set for a failed move, whose `to` is the blocked cell). */
  from: Point | null;
  /** A move's destination, or the observed point. */
  to: Point | null;
  /** Entities affected: attack target, message recipients, absorbed source, transfer recipient, the dead entity, the grown plant, the new fruit. */
  targets: string[];
  /** The cells of `targets` in the viewed turn (unknown ones dropped), used to draw arcs and flashes. */
  targetPoints: Point[];
  /** False when the action failed (the indicator is drawn as an attempt). */
  ok: boolean;
  /** The number the effect moved: attack damage, absorbed gain, transferred amount, healed health, starvation loss; null otherwise. */
  amount: number | null;
  /** True for the message effect of a `broadcast` action (a send is false). */
  broadcast: boolean;
  /** One short phrase: "moved up", "attacked a05 (5 damage)", "broadcast to 3 agents", "a02 died (attack)". */
  label: string;
}

/** Cell one step from `from` in a move direction (INTERFACES section 3: up = +y). */
export function moveTarget(from: Point, direction: unknown): Point {
  switch (direction) {
    case "up":
      return { x: from.x, y: from.y + 1 };
    case "down":
      return { x: from.x, y: from.y - 1 };
    case "left":
      return { x: from.x - 1, y: from.y };
    case "right":
      return { x: from.x + 1, y: from.y };
    default:
      return from;
  }
}

/** The map direction of a step from `from` to `to` ("up", "down", "left", "right", "diagonal" or "still"). */
export function stepDirection(from: Point, to: Point): "up" | "down" | "left" | "right" | "diagonal" | "still" {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return "still";
  if (dx !== 0 && dy !== 0) return "diagonal";
  if (dy > 0) return "up";
  if (dy < 0) return "down";
  return dx > 0 ? "right" : "left";
}

function isPoint(value: unknown): value is Point {
  return !!value && typeof value === "object" && typeof (value as Point).x === "number" && typeof (value as Point).y === "number";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Short numbers for labels: 5, 2.5, 0.25. */
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** The cell of an entity in the viewed turn (dead ones stay; removed ones keep their last cell), or null. */
export function entityPosition(view: TurnView, id: string): Point | null {
  const entity = findEntity(view.entities, id);
  if (entity) return entity.position;
  const removed = view.entities.removed[id];
  return removed ? removed.position : null;
}

function pointsOf(view: TurnView, ids: readonly string[]): Point[] {
  const points: Point[] = [];
  for (const id of ids) {
    const p = entityPosition(view, id);
    if (p) points.push(p);
  }
  return points;
}

function effect(view: TurnView, partial: Partial<TurnEffect> & Pick<TurnEffect, "kind" | "actor" | "label">): TurnEffect {
  const targets = partial.targets ?? [];
  return {
    at: partial.at ?? null,
    from: partial.from ?? null,
    to: partial.to ?? null,
    targets,
    targetPoints: partial.targetPoints ?? pointsOf(view, targets),
    ok: partial.ok ?? true,
    amount: partial.amount ?? null,
    broadcast: partial.broadcast ?? false,
    ...partial,
  } as TurnEffect;
}

/**
 * The events that belong to the viewed turn.  The live TurnView also carries the events
 * emitted since the saved checkpoint (a turn still in progress); those are never this
 * turn's effects.
 */
export function ownEvents(view: TurnView): Event[] {
  const turnId = view.turn.turn_id;
  return view.events.filter((e) => e.turn_id === turnId);
}

/** Recipients of the acting agent's message in this turn (from the message_delivered event), or []. */
function deliveredTo(events: readonly Event[], sender: string): string[] {
  for (const e of events) {
    if (e.kind === "message_delivered" && e.actor === sender) return strings(e.details.recipients);
  }
  return [];
}

/**
 * The acting agent's action as an effect, or null when the turn had none (init,
 * round end, a skipped or waiting agent, a model failure).
 */
export function actingEffect(view: TurnView): TurnEffect | null {
  const action = view.turn.action;
  const actor = view.turn.acting_agent_id;
  if (!action || !actor) return null;
  const result = view.turn.action_result;
  const ok = result?.ok ?? true;
  const effects = result?.effects ?? {};
  const args = action.args ?? {};
  const at = entityPosition(view, actor);
  const events = ownEvents(view);
  const via = action.via_skill && action.skill_name ? ` via skill ${action.skill_name}` : "";
  const failed = ok ? "" : ` (failed: ${result?.reason ?? "unknown"})`;
  switch (action.name) {
    case "move": {
      const from = isPoint(effects.from) ? effects.from : at;
      const to = isPoint(effects.to) ? effects.to : from ? moveTarget(from, args.direction) : null;
      return effect(view, { kind: "move", actor, at: ok ? (to ?? at) : at, from, to, ok, label: `moved ${str(args.direction) ?? ""}`.trim() + via + failed });
    }
    case "attack": {
      const target = str(args.target) ?? str(effects.target);
      const damage = num(effects.damage);
      const killed = effects.killed === true;
      const detail = ok && damage !== null ? ` (${fmt(damage)} damage${killed ? ", killed" : ""})` : "";
      return effect(view, { kind: "attack", actor, at, targets: target ? [target] : [], ok, amount: ok ? damage : null, label: `attacked ${target ?? "?"}${detail}${via}${failed}` });
    }
    case "send": {
      const recipient = str(args.recipient);
      const delivered = deliveredTo(events, actor);
      const targets = delivered.length > 0 ? delivered : recipient ? [recipient] : [];
      return effect(view, { kind: "message", actor, at, targets, ok, label: `sent a message to ${recipient ?? "?"}${via}${failed}` });
    }
    case "broadcast": {
      const targets = deliveredTo(events, actor);
      return effect(view, { kind: "message", actor, at, targets, ok, broadcast: true, label: `broadcast to ${targets.length} agent${targets.length === 1 ? "" : "s"}${via}${failed}` });
    }
    case "absorb": {
      const source = str(args.source) ?? str(effects.source);
      const gained = num(effects.gained);
      const detail = ok && gained !== null ? ` (+${fmt(gained)} ${str(args.resource) ?? str(effects.resource) ?? ""})`.replace(/ \)$/, ")") : "";
      return effect(view, { kind: "absorb", actor, at, targets: source ? [source] : [], ok, amount: ok ? gained : null, label: `absorbed from ${source ?? "?"}${detail}${via}${failed}` });
    }
    case "transfer": {
      const to = str(args.recipient) ?? str(effects.to);
      const amount = num(effects.transferred) ?? num(args.amount);
      const detail = amount !== null ? ` ${fmt(amount)} ${str(args.resource) ?? str(effects.resource) ?? ""}`.replace(/ $/, "") : "";
      return effect(view, { kind: "transfer", actor, at, targets: to ? [to] : [], ok, amount: ok ? amount : null, label: `transferred${detail} to ${to ?? "?"}${via}${failed}` });
    }
    case "recover": {
      const healed = num(effects.healed);
      return effect(view, { kind: "recover", actor, at, ok, amount: ok ? healed : null, label: `recovered${ok && healed !== null ? ` ${fmt(healed)} health` : ""}${via}${failed}` });
    }
    case "upgrade":
      return effect(view, { kind: "upgrade", actor, at, ok, label: `upgraded ${str(args.attribute) ?? str(effects.purchased) ?? "?"}${via}${failed}` });
    case "wait": {
      const rounds = num(args.rounds) ?? num(effects.waiting_turns);
      return effect(view, { kind: "wait", actor, at, ok, label: `waits${rounds !== null ? ` ${fmt(rounds)} turn${rounds === 1 ? "" : "s"}` : ""}${via}${failed}` });
    }
    case "observe": {
      const point = isPoint(args.point) ? args.point : null;
      return effect(view, { kind: "observe", actor, at, to: point, targetPoints: point ? [point] : [], ok, label: `${ok ? "looked" : "tried to look"} at what is in cell${point ? ` (${point.x}, ${point.y})` : ""}${via}${failed}` });
    }
    case "query": {
      const target = str(args.entity);
      const targets = target && target !== "self" ? [target] : [];
      const verb = ok ? "checked" : "tried to check";
      const detail = target === "self" ? `${verb} their own stats and resources` : `${verb} details about ${target ?? "an entity"}`;
      return effect(view, { kind: "query", actor, at, targets, ok, label: `${detail}${via}${failed}` });
    }
    case "run_skill":
      return effect(view, { kind: "skill", actor, at, ok, label: `ran skill ${str(args.skill) ?? "?"}${failed}` });
    default:
      return effect(view, { kind: "skill", actor, at, ok, label: `did ${action.name}${via}${failed}` });
  }
}

/** The world events of the turn as effects (deaths, growth, fruit, seeds, germination, starvation, voice). */
export function worldEffects(view: TurnView): TurnEffect[] {
  const out: TurnEffect[] = [];
  for (const e of ownEvents(view)) {
    const d = e.details ?? {};
    switch (e.kind) {
      case "death": {
        const id = str(d.entity_id);
        if (!id) break;
        out.push(effect(view, { kind: "death", actor: "world", at: entityPosition(view, id), targets: [id], label: `${id} died (${str(d.cause) ?? "unknown"})` }));
        break;
      }
      case "plant_growth": {
        const id = str(d.plant_id);
        if (!id) break;
        out.push(effect(view, { kind: "growth", actor: id, at: entityPosition(view, id), targets: [id], label: `${id} reached ${str(d.stage) ?? "a new stage"}` }));
        break;
      }
      case "fruit_spawned":
      case "seed_spawned": {
        const plant = str(d.plant_id) ?? "world";
        const id = str(d.entity_id);
        const at = isPoint(d.position) ? d.position : plant !== "world" ? entityPosition(view, plant) : null;
        const kind = e.kind === "fruit_spawned" ? "fruit" : "seed";
        out.push(effect(view, { kind, actor: plant, at, targets: id ? [id] : [], targetPoints: at ? [at] : [], label: `${plant} grew ${kind} ${id ?? ""}`.trim() }));
        break;
      }
      case "germination": {
        const plant = str(d.plant_id);
        const seed = str(d.entity_id);
        const at = isPoint(d.position) ? d.position : plant ? entityPosition(view, plant) : null;
        out.push(effect(view, { kind: "germination", actor: seed ?? "world", at, targets: plant ? [plant] : [], targetPoints: at ? [at] : [], label: `${seed ?? "a seed"} germinated into ${plant ?? "a plant"}` }));
        break;
      }
      case "starvation": {
        const id = str(d.agent_id) ?? e.actor;
        const loss = num(d.health_loss);
        out.push(effect(view, { kind: "starvation", actor: "world", at: entityPosition(view, id), targets: [id], amount: loss, label: `${id} starves${loss !== null ? ` (-${fmt(loss)} health)` : ""}` }));
        break;
      }
      case "operator_voice": {
        const targets = strings(d.recipients).length > 0 ? strings(d.recipients) : strings(d.agent_ids);
        out.push(effect(view, { kind: "voice", actor: "operator", at: null, targets, label: `operator voice to ${targets.length > 0 ? targets.join(", ") : "agents"}` }));
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Every effect of the viewed turn: the acting agent's action first, then the world events in order. */
export function turnEffects(view: TurnView | null): TurnEffect[] {
  if (!view) return [];
  const acting = actingEffect(view);
  const world = worldEffects(view);
  return acting ? [acting, ...world] : world;
}

/** Effects indexed by the cell they sit at ("x,y"), for per-cell drawing. */
export function effectsByPoint(effects: readonly TurnEffect[]): Map<string, TurnEffect[]> {
  const map = new Map<string, TurnEffect[]>();
  for (const e of effects) {
    if (!e.at) continue;
    const key = `${e.at.x},${e.at.y}`;
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  }
  return map;
}
