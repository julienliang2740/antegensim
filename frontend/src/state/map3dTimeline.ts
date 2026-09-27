/**
 * The 3D view's turn animations as data: buildTimeline turns the viewed turn's
 * effects (state/turnEffects.ts, the only input besides slot positions) into a
 * list of timed clips, sampleTimeline evaluates them at a time to per-entity
 * overrides (offset, scale, tilt, tint) and transient effects (trails, beams,
 * rings, particles, floating numbers), and scaleTimeline squeezes a timeline for
 * fast live play.  The scene applies a sample to the instances it names; it never
 * reads effects itself.  Pure (no React, no three, no DOM); tested by
 * src/state/state.test.mjs.
 *
 * Every clip is an arrival into the viewed turn's saved state: the scene first
 * snaps every figure to the turn (positions, life, sizes), then a sample adds a
 * delta that shrinks to nothing by the clip's end, so the last frame always
 * equals the saved turn.  An override is therefore relative: offset [0, 0, 0],
 * scale 1, tilt 0 and tint null mean "as saved".  Times are milliseconds from
 * the start of the timeline; every clip ends by TIMELINE_MAX_MS (700).
 * Positions are scene units (see map3dLayout: x = world x, y up, z = -world y).
 *
 * DOCS: missing data never throws; an unknown origin, target or slot (a teleport
 * by set_stat, an entity already removed) leaves the chip alone with no motion.
 * Numbers come from TurnEffect.amount and the ripple from TurnEffect.broadcast;
 * labels are only displayed, never parsed.
 */

import type { Point } from "../api/types";
import type { Vec3 } from "./map3dLayout";
import type { EffectKind, TurnEffect } from "./turnEffects";

// DOCS: buildTimeline(effects, ctx) -> { clips, duration <= 700 ms }; sampleTimeline(tl, tMs) -> per-entity deltas (offset, scale, tilt, tint) + fx list; scaleTimeline(tl, f) for fast live play.

/** Longest timeline, ms: the run plays at one turn per second and the view must be still by then. */
export const TIMELINE_MAX_MS = 700;
/** Height of an action chip above its figure's anchor, scene units. */
export const CHIP_HEIGHT = 0.9;
/** Delay between successive spawn pops (fruit, seeds, germinations), ms, shortened when many spawn. */
export const SPAWN_STAGGER_MS = 30;
/** At most this many spawns of one turn pop in; the rest appear at once. */
export const MAX_ANIMATED_SPAWNS = 40;
/** Duration of one spawn pop, ms. */
export const SPAWN_POP_MS = 300;
/** Peak height of the hop a moving figure makes, scene units. */
export const SLIDE_HOP = 0.15;
/** A dying figure starts this much above its saved (lying) pose and sinks onto it. */
export const DEATH_SINK = 0.15;
/** Height of a message recipient's bounce, scene units. */
export const BOUNCE_HEIGHT = 0.12;
/** How far an attacker lunges toward its target (fraction of the distance). */
export const LUNGE_FRACTION = 0.3;
/** How far a floating number rises over its lifetime, scene units. */
export const FLOAT_RISE = 0.5;
/** Height above the figure's anchor a floating number starts at, scene units. */
export const FLOAT_START_HEIGHT = 0.7;
/** Start radius of the broadcast ripple, scene units; it grows to the sender's communication range. */
export const RIPPLE_START_RADIUS = 0.2;
/** Ripple end radius when the sender's communication range is unknown. */
export const DEFAULT_COMM_RANGE = 3;
/** How high an upgrade's ring rises, scene units. */
export const UPGRADE_RISE = 0.6;
/** Points in a particle stream (absorb, transfer). */
export const PARTICLE_COUNT = 24;
/** Start scale of a growth pop (the plant grows from 80 % of its new size). */
export const GROWTH_POP_FROM = 0.8;

/** What the scene tells the timeline about the viewed turn. */
export interface TimelineContext {
  /** Scene position of the entity's slot in the viewed turn (the saved pose), or null when it has no figure. */
  slotOf(id: string): Vec3 | null;
  /** cellToScene of the active layer (the tile-top centre of a cell). */
  cellCentre(p: Point): Vec3;
  /** Agent.stats.communication_range of an agent, in cells, for the broadcast ripple; null when unknown. */
  commRange(id: string): number | null;
  /** Animations off or prefers-reduced-motion: every clip gets duration 0 and the sample is the end state at once. */
  reducedMotion: boolean;
}

/** Clip kinds that move one figure (keyed by entity id). */
export type EntityClipKind = "slide" | "lunge" | "flash" | "tilt" | "bounce" | "pop";
/** Clip kinds drawn by the pooled fx objects (not attached to an instance). */
export type FxKind = "trail" | "puff" | "float" | "ripple" | "beam" | "particles" | "pulse" | "quad";
export type ClipKind = EntityClipKind | FxKind;

/** Colour roles a clip can ask for; the scene maps them to palette tokens (bad = red, good = green, warn = gold, accent = blue, resource = the absorb/transfer stream). */
export type ClipColour = "bad" | "good" | "warn" | "accent" | "resource";

/**
 * One timed animation.  For entity clips `id` is the figure to move and
 * `from`/`to` are what the kind needs (slide: start position and the saved
 * slot; lunge: the actor's and the target's slots; tilt: `from` the start
 * offset).  For fx clips `id` is the actor (informative) and `from`/`to` are
 * the anchor(s) in scene units.  `value` is kind-specific: ripple end radius,
 * pop start scale, pulse rise, tilt start angle (radians).  `text` is the
 * floating number.  t0 <= t1 <= TIMELINE_MAX_MS.
 */
export interface Clip {
  kind: ClipKind;
  effectKind: EffectKind;
  id: string | null;
  t0: number;
  t1: number;
  from: Vec3 | null;
  to: Vec3 | null;
  colour: ClipColour | null;
  text: string | null;
  value: number | null;
}

export interface Timeline {
  clips: Clip[];
  /** max t1 of the clips (0 for an empty or reduced-motion timeline), ms. */
  duration: number;
}

/**
 * Delta to apply to one figure's saved pose: add `offset` (scene units) to its
 * position, multiply its size by `scale`, add `tilt` (radians about the axis
 * a lying figure rotates on) to its rotation, blend the instance colour toward
 * the palette colour of `tint` (null: no blend).  A finished figure has no entry.
 */
export interface EntitySample {
  offset: Vec3;
  scale: number;
  tilt: number;
  tint: ClipColour | null;
}

/**
 * One transient effect at time t.  `position` is where a point effect sits
 * now (puff, ripple, pulse, quad, float), `from`/`to` the ends of a line or
 * stream (trail, beam, particles; for particles `progress` is how far along
 * the stream the points are).  `radius` is the current ring radius (ripple,
 * pulse, puff), `opacity` in [0, 1], `progress` the eased 0..1 progress.
 */
export interface FxState {
  kind: FxKind;
  effectKind: EffectKind;
  id: string | null;
  progress: number;
  opacity: number;
  position: Vec3;
  from: Vec3;
  to: Vec3;
  radius: number;
  colour: ClipColour | null;
  text: string | null;
}

export interface Sample {
  entities: Map<string, EntitySample>;
  fx: FxState[];
  /** True once tMs >= duration: nothing left to animate, the scene shows the saved turn. */
  done: boolean;
}

/** Where an action chip goes: CHIP_HEIGHT above the actor's figure (or the effect's cell), one per target for a voice. */
export interface ChipPlacement {
  effect: TurnEffect;
  /** The entity the chip hangs over (null when it hangs over a bare cell). */
  id: string | null;
  position: Vec3;
}

/** Quadratic ease in and out: slow start and end.  t in [0, 1]. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2;
}

/** Quadratic ease out: fast start, slow end.  t in [0, 1]. */
export function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** Ease out with a small overshoot past 1 before settling (a "pop").  t in [0, 1]. */
export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/**
 * Linear progress of a clip at `tMs`, in [0, 1]: 0 before t0, 1 from t1 on.
 * A clip with t1 <= t0 (zero duration) is always at 1.
 */
export function progress(clip: Clip, tMs: number): number {
  if (clip.t1 <= clip.t0) return 1;
  return Math.min(1, Math.max(0, (tMs - clip.t0) / (clip.t1 - clip.t0)));
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function mul(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** "+5", "-2.5": ASCII sign and at most two decimals, like the labels of turnEffects. */
export function formatAmount(amount: number, sign: "+" | "-"): string {
  const abs = Math.abs(amount);
  const text = Number.isInteger(abs) ? String(abs) : String(Math.round(abs * 100) / 100);
  return `${sign}${text}`;
}

interface Builder {
  ctx: TimelineContext;
  clips: Clip[];
  tilted: Set<string>;
}

function push(b: Builder, kind: ClipKind, effectKind: EffectKind, t0: number, t1: number, fields: Partial<Omit<Clip, "kind" | "effectKind" | "t0" | "t1">>): void {
  b.clips.push({
    kind,
    effectKind,
    id: fields.id ?? null,
    t0,
    t1: Math.min(TIMELINE_MAX_MS, t1),
    from: fields.from ?? null,
    to: fields.to ?? null,
    colour: fields.colour ?? null,
    text: fields.text ?? null,
    value: fields.value ?? null,
  });
}

/** The actor's slot, else the centre of the effect's cell, else null. */
function anchorOf(ctx: TimelineContext, id: string, at: Point | null): Vec3 | null {
  return ctx.slotOf(id) ?? (at ? ctx.cellCentre(at) : null);
}

function floatClip(b: Builder, e: TurnEffect, anchor: Vec3, text: string, colour: ClipColour, t0: number, t1: number): void {
  push(b, "float", e.kind, t0, t1, { id: e.actor, from: add(anchor, [0, FLOAT_START_HEIGHT, 0]), text, colour });
}

function tiltClip(b: Builder, e: TurnEffect, id: string, t0: number, t1: number): void {
  if (b.tilted.has(id)) return;
  if (!b.ctx.slotOf(id)) return;
  b.tilted.add(id);
  push(b, "tilt", e.kind, t0, t1, { id, from: [0, DEATH_SINK, 0], value: -Math.PI / 2 });
}

function buildAction(b: Builder, e: TurnEffect): void {
  const { ctx } = b;
  const target = e.targets[0] ?? null;
  switch (e.kind) {
    case "move": {
      const slot = ctx.slotOf(e.actor);
      if (!e.ok) {
        const anchor = anchorOf(ctx, e.actor, e.at);
        if (anchor) push(b, "puff", e.kind, 0, 400, { id: e.actor, from: anchor, colour: "bad" });
        return;
      }
      if (!e.from || !e.to) return;
      if (slot) push(b, "slide", e.kind, 0, 450, { id: e.actor, from: ctx.cellCentre(e.from), to: slot });
      push(b, "trail", e.kind, 0, 600, { id: e.actor, from: ctx.cellCentre(e.from), to: ctx.cellCentre(e.to) });
      return;
    }
    case "attack": {
      if (!e.ok || !target) return;
      const actorSlot = ctx.slotOf(e.actor);
      const targetSlot = ctx.slotOf(target);
      if (!targetSlot) return;
      if (actorSlot) push(b, "lunge", e.kind, 0, 240, { id: e.actor, from: actorSlot, to: targetSlot });
      push(b, "flash", e.kind, 120, 600, { id: target, colour: "bad" });
      if (e.amount !== null) floatClip(b, e, targetSlot, formatAmount(e.amount, "-"), "bad", 120, 700);
      return;
    }
    case "message": {
      if (!e.ok) return;
      const anchor = anchorOf(ctx, e.actor, e.at);
      if (e.broadcast) {
        if (anchor) push(b, "ripple", e.kind, 0, 600, { id: e.actor, from: anchor, colour: "accent", value: Math.max(RIPPLE_START_RADIUS, ctx.commRange(e.actor) ?? DEFAULT_COMM_RANGE) });
        for (const id of e.targets) {
          if (ctx.slotOf(id)) push(b, "bounce", e.kind, 350, 600, { id });
        }
        return;
      }
      if (!anchor) return;
      for (const id of e.targets) {
        const to = ctx.slotOf(id);
        if (to) push(b, "beam", e.kind, 0, 400, { id: e.actor, from: anchor, to, colour: "accent" });
      }
      return;
    }
    case "absorb": {
      if (!e.ok) return;
      const actorSlot = ctx.slotOf(e.actor);
      if (!actorSlot) return;
      const source = target ? ctx.slotOf(target) : null;
      if (source) push(b, "particles", e.kind, 0, 450, { id: e.actor, from: source, to: actorSlot, colour: "resource" });
      if (e.amount !== null) floatClip(b, e, actorSlot, formatAmount(e.amount, "+"), "good", 300, 700);
      return;
    }
    case "transfer": {
      if (!e.ok) return;
      const actorSlot = ctx.slotOf(e.actor);
      const to = target ? ctx.slotOf(target) : null;
      if (!to) return;
      if (actorSlot) push(b, "particles", e.kind, 0, 450, { id: e.actor, from: actorSlot, to, colour: "resource" });
      if (e.amount !== null) floatClip(b, e, to, formatAmount(e.amount, "+"), "good", 300, 700);
      return;
    }
    case "recover": {
      if (!e.ok) return;
      const anchor = anchorOf(ctx, e.actor, e.at);
      if (!anchor) return;
      push(b, "pulse", e.kind, 0, 500, { id: e.actor, from: anchor, to: anchor, colour: "good", value: 0 });
      if (e.amount !== null) floatClip(b, e, anchor, formatAmount(e.amount, "+"), "good", 0, 600);
      return;
    }
    case "upgrade": {
      if (!e.ok) return;
      const anchor = anchorOf(ctx, e.actor, e.at);
      if (!anchor) return;
      push(b, "pulse", e.kind, 0, 500, { id: e.actor, from: anchor, to: add(anchor, [0, UPGRADE_RISE, 0]), colour: "warn", value: UPGRADE_RISE });
      return;
    }
    case "observe": {
      if (!e.ok || !e.to) return;
      push(b, "quad", e.kind, 0, 450, { id: e.actor, from: ctx.cellCentre(e.to), colour: "accent" });
      return;
    }
    case "query": {
      if (!e.ok || !target) return;
      const anchor = anchorOf(ctx, e.actor, e.at);
      const to = ctx.slotOf(target);
      if (anchor && to) push(b, "beam", e.kind, 0, 300, { id: e.actor, from: anchor, to, colour: "accent" });
      return;
    }
    case "death": {
      if (target) tiltClip(b, e, target, 0, 500);
      return;
    }
    case "growth": {
      if (target && ctx.slotOf(target)) push(b, "pop", e.kind, 0, 450, { id: target, value: GROWTH_POP_FROM });
      return;
    }
    case "starvation": {
      if (!target) return;
      const slot = ctx.slotOf(target);
      if (!slot) return;
      push(b, "flash", e.kind, 0, 400, { id: target, colour: "bad" });
      if (e.amount !== null) floatClip(b, e, slot, formatAmount(e.amount, "-"), "bad", 0, 600);
      return;
    }
    case "wait":
    case "skill":
    case "voice":
    case "fruit":
    case "seed":
    case "germination":
    default:
      return;
  }
}

function buildSpawns(b: Builder, spawns: readonly TurnEffect[]): void {
  const animated = spawns.slice(0, MAX_ANIMATED_SPAWNS);
  const stagger = Math.min(SPAWN_STAGGER_MS, (TIMELINE_MAX_MS - SPAWN_POP_MS) / Math.max(1, animated.length - 1));
  animated.forEach((e, i) => {
    const id = e.targets[0];
    if (!id || !b.ctx.slotOf(id)) return;
    const t0 = Math.round(i * stagger);
    push(b, "pop", e.kind, t0, t0 + SPAWN_POP_MS, { id, value: 0 });
  });
}

/**
 * Turn the viewed turn's effects into a timeline.  Per effect kind (missing
 * data degrades to no clip, never an error):
 * move ok: slide (actor, from the origin cell to its slot, 0-450, with a hop)
 * and a trail line (0-600); move failed: a red puff over the actor (0-400).
 * attack ok with a target that has a slot: lunge (0-240), red flash of the
 * target (120-600, 3 pulses), floating "-amount" (120-700); a kill is animated
 * by the same turn's death effect (one tilt per id).  message: broadcast ->
 * ripple from the actor to commRange (0-600) and a bounce of each recipient
 * (350-600); send -> a beam to each recipient (0-400).  absorb / transfer:
 * particle stream (0-450) and floating "+amount" over the receiver (300-700).
 * recover: green pulse under the actor (0-500) and "+amount"; upgrade: gold
 * pulse rising (0-500).  observe: translucent quad at `to` (0-450).  query:
 * thin beam to the target (0-300).  death: tilt from upright to lying with a
 * sink (0-500).  growth: pop 0.8 -> 1 (0-450).  fruit / seed / germination:
 * pop 0 -> 1 (300 ms each), staggered by up to 30 ms, at most 40 animated (the
 * stagger shrinks so the last pop still ends by 700 ms).  starvation: red
 * flash (0-400) and "-amount".  wait, skill, voice and failed actions: no
 * clips (the chip alone).  `reducedMotion` zeroes every t0 and t1.
 */
export function buildTimeline(effects: readonly TurnEffect[], ctx: TimelineContext): Timeline {
  const b: Builder = { ctx, clips: [], tilted: new Set() };
  const spawns: TurnEffect[] = [];
  for (const e of effects) {
    if (e.kind === "fruit" || e.kind === "seed" || e.kind === "germination") spawns.push(e);
    else buildAction(b, e);
  }
  buildSpawns(b, spawns);
  if (ctx.reducedMotion) {
    for (const c of b.clips) {
      c.t0 = 0;
      c.t1 = 0;
    }
  }
  let duration = 0;
  for (const c of b.clips) duration = Math.max(duration, c.t1);
  return { clips: b.clips, duration };
}

/** The timeline's total length in ms (0 when nothing animates); at most TIMELINE_MAX_MS by construction. */
export function timelineDuration(tl: Timeline): number {
  return tl.duration;
}

/**
 * A copy of the timeline with every t0, t1 and the duration multiplied by
 * `factor` (0.6 * interval / 700 for fast live play; a factor <= 0 makes every
 * clip instantaneous).  The clips themselves are copied, not shared.
 */
export function scaleTimeline(tl: Timeline, factor: number): Timeline {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 0;
  return { clips: tl.clips.map((c) => ({ ...c, t0: c.t0 * f, t1: c.t1 * f })), duration: tl.duration * f };
}

function mergeEntity(entities: Map<string, EntitySample>, id: string, delta: Partial<EntitySample>): void {
  const cur = entities.get(id) ?? { offset: [0, 0, 0], scale: 1, tilt: 0, tint: null };
  entities.set(id, {
    offset: delta.offset ? add(cur.offset, delta.offset) : cur.offset,
    scale: cur.scale * (delta.scale ?? 1),
    tilt: cur.tilt + (delta.tilt ?? 0),
    tint: delta.tint ?? cur.tint,
  });
}

function sampleEntity(entities: Map<string, EntitySample>, c: Clip, p: number): void {
  if (!c.id) return;
  switch (c.kind) {
    case "slide": {
      if (!c.from || !c.to) return;
      const start = sub(c.from, c.to);
      const offset = add(mul(start, 1 - easeInOut(p)), [0, SLIDE_HOP * Math.sin(Math.PI * p), 0]);
      mergeEntity(entities, c.id, { offset });
      return;
    }
    case "lunge": {
      if (!c.from || !c.to) return;
      mergeEntity(entities, c.id, { offset: mul(sub(c.to, c.from), LUNGE_FRACTION * Math.sin(Math.PI * p)) });
      return;
    }
    case "flash": {
      const on = (p * 3) % 1 < 0.5;
      mergeEntity(entities, c.id, { tint: on ? c.colour : null });
      return;
    }
    case "tilt": {
      const remaining = 1 - easeInOut(p);
      mergeEntity(entities, c.id, { offset: mul(c.from ?? [0, 0, 0], remaining), tilt: (c.value ?? -Math.PI / 2) * remaining });
      return;
    }
    case "bounce": {
      mergeEntity(entities, c.id, { offset: [0, BOUNCE_HEIGHT * Math.sin(Math.PI * p), 0] });
      return;
    }
    case "pop": {
      const s0 = c.value ?? 0;
      mergeEntity(entities, c.id, { scale: Math.max(0, s0 + (1 - s0) * easeOutBack(p)) });
      return;
    }
    default:
      return;
  }
}

function sampleFx(c: Clip, p: number): FxState | null {
  const from = c.from;
  if (!from) return null;
  const to = c.to ?? from;
  const base = { kind: c.kind as FxKind, effectKind: c.effectKind, id: c.id, colour: c.colour, text: c.text, from, to };
  switch (c.kind) {
    case "trail":
      return { ...base, progress: p, opacity: 1 - p, position: from, radius: 0 };
    case "puff": {
      const e = easeOut(p);
      return { ...base, progress: e, opacity: 1 - p, position: add(from, [0, 0.3 + 0.3 * e, 0]), radius: 0.15 + 0.35 * e };
    }
    case "ripple": {
      const e = easeOut(p);
      const end = c.value ?? DEFAULT_COMM_RANGE;
      return { ...base, progress: e, opacity: 0.8 * (1 - p), position: from, radius: RIPPLE_START_RADIUS + (end - RIPPLE_START_RADIUS) * e };
    }
    case "beam":
      return { ...base, progress: p, opacity: 1 - p, position: lerp3(from, to, 0.5), radius: 0 };
    case "particles": {
      const e = easeInOut(p);
      return { ...base, progress: e, opacity: 1 - p * p, position: lerp3(from, to, e), radius: 0 };
    }
    case "pulse": {
      const e = easeOut(p);
      return { ...base, progress: e, opacity: 1 - p, position: lerp3(from, to, e), radius: 0.2 + 0.5 * e };
    }
    case "quad":
      return { ...base, progress: p, opacity: 0.5 * (1 - p), position: from, radius: 0.5 };
    case "float": {
      const e = easeOut(p);
      return { ...base, progress: e, opacity: Math.min(1, (1 - p) / 0.4), position: add(from, [0, FLOAT_RISE * e, 0]), radius: 0 };
    }
    default:
      return null;
  }
}

/**
 * Evaluate the timeline at `tMs` (clamped at 0).  Entity clips that have not
 * ended contribute a delta (offsets add, scales multiply, tilts add, the last
 * tint wins); a clip that has not started holds its start pose (a mover sits
 * at its origin, a spawn is at scale 0).  Finished clips contribute nothing
 * and an entry whose delta is the identity (offset 0, scale 1, tilt 0, no
 * tint: a bounce that has not started) is dropped, so at the end `entities`
 * is empty and `fx` is [].  `done` is tMs >= duration.
 */
export function sampleTimeline(tl: Timeline, tMs: number): Sample {
  const t = Math.max(0, tMs);
  const entities = new Map<string, EntitySample>();
  const fx: FxState[] = [];
  for (const c of tl.clips) {
    if (t >= c.t1) continue;
    const p = progress(c, t);
    switch (c.kind) {
      case "slide":
      case "lunge":
      case "flash":
      case "tilt":
      case "bounce":
      case "pop":
        sampleEntity(entities, c, p);
        break;
      default: {
        const state = sampleFx(c, p);
        if (state) fx.push(state);
      }
    }
  }
  for (const [id, e] of entities) {
    if (e.offset[0] === 0 && e.offset[1] === 0 && e.offset[2] === 0 && e.scale === 1 && e.tilt === 0 && e.tint === null) entities.delete(id);
  }
  return { entities, fx, done: t >= tl.duration };
}

/**
 * Where the action chips of the viewed turn go: one per effect, CHIP_HEIGHT
 * above the actor's slot (else above the effect's cell); a voice gets one chip
 * over each recipient that has a figure.  Effects with no known anchor get no
 * chip.  Chips are not timed: they stay while the turn is viewed.
 */
export function chipPlacements(effects: readonly TurnEffect[], ctx: TimelineContext): ChipPlacement[] {
  const out: ChipPlacement[] = [];
  for (const effect of effects) {
    if (effect.kind === "voice") {
      for (const id of effect.targets) {
        const slot = ctx.slotOf(id);
        if (slot) out.push({ effect, id, position: add(slot, [0, CHIP_HEIGHT, 0]) });
      }
      continue;
    }
    const slot = ctx.slotOf(effect.actor);
    if (slot) {
      out.push({ effect, id: effect.actor, position: add(slot, [0, CHIP_HEIGHT, 0]) });
      continue;
    }
    const targetSlot = effect.targets[0] ? ctx.slotOf(effect.targets[0]) : null;
    if (targetSlot) {
      out.push({ effect, id: effect.targets[0], position: add(targetSlot, [0, CHIP_HEIGHT, 0]) });
      continue;
    }
    if (effect.at) out.push({ effect, id: null, position: add(ctx.cellCentre(effect.at), [0, CHIP_HEIGHT, 0]) });
  }
  return out;
}

/** Sanity check for tests and the view: every clip ends by TIMELINE_MAX_MS and after it starts. */
export function timelineIsValid(tl: Timeline): boolean {
  return tl.clips.every((c) => c.t0 >= 0 && c.t1 >= c.t0 && c.t1 <= TIMELINE_MAX_MS) && tl.duration <= TIMELINE_MAX_MS;
}
