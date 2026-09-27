/**
 * Geometry of the 3D board that does not need three.js: how a world cell maps
 * to scene coordinates, how stacked layers are spaced, how the occupants of one
 * cell are packed into slots so every entity stays its own pickable figure,
 * the order that puts the acting and selected entities on the ground tier, the
 * count badge threshold, the far level of detail (figures vs. columns) and the
 * screen placement of the HTML overlay (labels, chips and badges never cover
 * each other: placeOverlay).
 * Pure functions (no React, no three, no DOM); tested by src/state/state.test.mjs.
 *
 * Conventions used by every 3D module: one scene unit = one world cell; scene
 * x = world x, scene y = up (height), scene z = -world y (world north, +y, is
 * scene -z, so the board reads like the 2D map from the default camera south of
 * it).  Layer i sits at scene y = i * LAYER_GAP; the tile top of a layer is its
 * y = 0 plane.
 *
 * DOCS: cells are never capped: a cell with 40 occupants gets 40 slots on tiers
 * of 16 (the upper tiers float 0.45 units above the one below), and the acting
 * and selected entities are always on tier 0.
 */

import type { EntityKind, Point } from "../api/types";

// DOCS: cellToScene(p, layer) = [p.x, layer * LAYER_GAP, -p.y]; packCell(n) gives n slots inside one tile (k x k grid, tiers of 16).

/** A scene position or offset: [x, y, z] in scene units (1 unit = 1 cell). */
export type Vec3 = [number, number, number];

/** Vertical distance between stacked layers, in scene units. */
export const LAYER_GAP = 3;

/** Height above a tier that the next tier of a crowded cell floats at. */
export const TIER_LIFT = 0.45;

/** Slots per tier: a 4 x 4 grid; slot i >= 16 goes to tier floor(i / 16). */
export const SLOTS_PER_TIER = 16;

/** Fraction of the tile width the slot grid spans (the rest is a margin to the tile edge). */
export const PACK_SPAN = 0.82;

/** Cells with at least this many occupants show a count badge. */
export const COUNT_BADGE_MIN = 5;

/** Camera-to-board distance above which the far LOD ("columns") is used ... */
export const LOD_COLUMNS_ABOVE = 60;
/** ... and below which the figures come back (hysteresis between the two). */
export const LOD_FIGURES_BELOW = 54;

/** Tallest column of the far LOD, in scene units. */
export const COLUMN_MAX_HEIGHT = 6;
/** Column height per occupant, in scene units (capped at COLUMN_MAX_HEIGHT). */
export const COLUMN_HEIGHT_PER_ENTITY = 0.25;

/** Opacity of a layer that is not the active one (the active layer is opaque). */
export const INACTIVE_LAYER_OPACITY = 0.3;

/** Scene y of the tile top of layer `i` (0-based). */
export function layerY(i: number): number {
  return i * LAYER_GAP;
}

/**
 * Scene position of the centre of cell `p` on layer `layer`, at the tile top:
 * [p.x, layerY(layer), -p.y] (never -0).  A figure standing on the tile adds its own height.
 */
export function cellToScene(p: Point, layer: number): Vec3 {
  return [p.x, layerY(layer), 0 - p.y];
}

/**
 * The cell under a scene point, from its x and z only (the layer's height is
 * irrelevant): { x: round(x), y: round(-z) }, never -0.  Works for negative
 * coordinates (Math.round rounds -2.5 up to -2, so cell edges belong to the
 * northern / eastern cell; callers that hit-test terrain should prefer faceCell).
 */
export function sceneToCell(x: number, z: number): Point {
  return { x: Math.round(x) || 0, y: Math.round(0 - z) || 0 };
}

/** 1 for the active layer, INACTIVE_LAYER_OPACITY (0.3) for every other. */
export function layerOpacity(i: number, active: number): number {
  return i === active ? 1 : INACTIVE_LAYER_OPACITY;
}

/**
 * The active layer after moving `delta` steps (PageUp +1, PageDown -1), clamped
 * to [0, count - 1].  With count <= 0 the result is 0.
 */
export function nextLayer(active: number, delta: number, count: number): number {
  const last = Math.max(0, count - 1);
  return Math.min(last, Math.max(0, active + delta));
}

/**
 * One place inside a tile.  `u` and `v` are offsets across the tile in (0, 1):
 * u grows with world x (east), v grows with world y (north), (0.5, 0.5) is the
 * centre.  `tier` is 0 on the ground; tier t floats TIER_LIFT * t above.
 * `scale` multiplies the figure's size (1 for at most four occupants).
 */
export interface Slot {
  u: number;
  v: number;
  tier: number;
  scale: number;
}

/**
 * Pack `n` occupants of one cell into slots, never dropping any.  n <= 1 gives
 * one centred slot at scale 1.  Otherwise k = ceil(sqrt(min(n, 16))) and the
 * slots form a k x k grid of pitch PACK_SPAN / k centred in the tile, filled
 * row by row (u fastest); the figure scale is 1 for k <= 2 and min(1, 2.6 / k)
 * beyond (k = 3 -> 0.87, k = 4 -> 0.65), so one occupant is never larger than
 * one of four.  Slot i >= 16 repeats the grid position of slot i mod 16 on
 * tier floor(i / 16).  The result is deterministic for a given n.
 */
export function packCell(n: number): Slot[] {
  const count = Math.max(0, Math.floor(n));
  if (count === 0) return [];
  if (count === 1) return [{ u: 0.5, v: 0.5, tier: 0, scale: 1 }];
  const k = Math.ceil(Math.sqrt(Math.min(count, SLOTS_PER_TIER)));
  const pitch = PACK_SPAN / k;
  const scale = k <= 2 ? 1 : Math.min(1, 2.6 / k);
  const perTier = k * k;
  const slots: Slot[] = [];
  for (let i = 0; i < count; i++) {
    const tier = Math.floor(i / perTier);
    const cell = i % perTier;
    const col = cell % k;
    const row = Math.floor(cell / k);
    slots.push({
      u: 0.5 + (col - (k - 1) / 2) * pitch,
      v: 0.5 + (row - (k - 1) / 2) * pitch,
      tier,
      scale,
    });
  }
  return slots;
}

/**
 * Scene offset of a slot from the centre of its tile top:
 * [u - 0.5, TIER_LIFT * tier, -(v - 0.5)] (v grows north, which is scene -z).
 */
export function slotOffset(slot: Slot): Vec3 {
  return [slot.u - 0.5, TIER_LIFT * slot.tier, 0 - (slot.v - 0.5)];
}

/** Scene position of a slot in cell `cell` on layer `layer`: cellToScene(cell, layer) + slotOffset(slot). */
export function slotScenePosition(cell: Point, slot: Slot, layer: number): Vec3 {
  const base = cellToScene(cell, layer);
  const off = slotOffset(slot);
  return [base[0] + off[0], base[1] + off[1], base[2] + off[2]];
}

/** The six kinds of figure the 3D view draws (a dead agent or plant is "dead"). */
export type FigureKind = "agent" | "dead" | "plant" | "fruit" | "seed" | "residue";

/**
 * What the layout needs to know about an entity: a structural subset of the 2D
 * map's MapMarker (components/inspect/logic.ts), which is assignable to it.
 */
export interface SlotMarker {
  id: string;
  kind: EntityKind;
  /** Dead agent or plant (drawn lying flat in the dead colour). */
  dead: boolean;
}

/** Drawing and packing order: living agents, dead ones, plants, fruit, seeds, residue. */
export const FIGURE_KIND_RANK: Record<FigureKind, number> = { agent: 0, dead: 1, plant: 2, fruit: 3, seed: 4, residue: 5 };

/** The figure kind of a marker: "dead" for a dead agent or plant, else its entity kind. */
export function figureKind(marker: SlotMarker): FigureKind {
  return marker.dead ? "dead" : marker.kind;
}

/**
 * Sort a cell's markers for slot assignment: the ids in `priorityIds` first (in
 * that order; nulls ignored), then by kind rank (living agent, dead, plant,
 * fruit, seed, residue), then by id.  Slot i of packCell(n) goes to element i,
 * so the acting and selected entities are always on tier 0 and a cell's slots
 * do not shuffle while its composition is unchanged.  Returns a new array.
 */
export function orderForSlots<M extends SlotMarker>(markers: readonly M[], priorityIds: readonly (string | null | undefined)[]): M[] {
  const priority = new Map<string, number>();
  priorityIds.forEach((id, index) => {
    if (id && !priority.has(id)) priority.set(id, index);
  });
  const rank = (m: M) => priority.get(m.id) ?? Number.POSITIVE_INFINITY;
  return [...markers].sort((a, b) => {
    const pa = rank(a);
    const pb = rank(b);
    if (pa !== pb) return pa < pb ? -1 : 1;
    return FIGURE_KIND_RANK[figureKind(a)] - FIGURE_KIND_RANK[figureKind(b)] || a.id.localeCompare(b.id);
  });
}

/** The count badge text of a cell with `n` occupants: String(n) from COUNT_BADGE_MIN (5), else null. */
export function countBadge(n: number): string | null {
  return n >= COUNT_BADGE_MIN ? String(n) : null;
}

/** Level of detail of the entity layer: individual figures or one column per occupied cell. */
export type LodMode = "figures" | "columns";

/**
 * The LOD for a camera `distance` (scene units from the eye to its look-at
 * point on the active board): "columns" above LOD_COLUMNS_ABOVE (60), "figures"
 * below LOD_FIGURES_BELOW (54), `previous` in between (hysteresis, so the view
 * never flickers at the threshold).
 */
export function lodMode(distance: number, previous: LodMode): LodMode {
  if (distance > LOD_COLUMNS_ABOVE) return "columns";
  if (distance < LOD_FIGURES_BELOW) return "figures";
  return previous;
}

/** Height of a far-LOD column over a cell with `n` occupants: min(6, 0.25 * n) scene units. */
export function columnHeight(n: number): number {
  return Math.min(COLUMN_MAX_HEIGHT, COLUMN_HEIGHT_PER_ENTITY * Math.max(0, n));
}

/** A rectangle on the screen in CSS pixels (viewport-local). */
export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One element of the 3D view's HTML overlay competing for room on the screen (see placeOverlay). */
export interface OverlayEntry {
  key: string;
  /** Placed before everything else at its first box, whatever it covers (the hovered or selected entity's label). */
  pinned?: boolean;
  /** Takes no room and is never dropped for overlap (a floating number); still counts towards the cap. */
  free?: boolean;
  /** Higher places first. */
  priority: number;
  /** Distance from the camera; among equal priorities the nearer places first. */
  depth: number;
  /** Candidate boxes in order of preference (full text, short text, nudged upwards ...). */
  boxes: readonly ScreenBox[];
}

/** The box an overlay entry was given: `box` indexes the entry's `boxes`. */
export interface OverlayPlacement {
  key: string;
  box: number;
}

/** Pixels kept free between two placed overlay elements. */
export const OVERLAY_GAP = 2;

/** True when `a` and `b` come closer than `gap` pixels (they touch or intersect when gap is 0). */
export function boxesOverlap(a: ScreenBox, b: ScreenBox, gap = 0): boolean {
  return a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap;
}

function overlayOrder(a: OverlayEntry, b: OverlayEntry): number {
  const pa = a.pinned ? 1 : 0;
  const pb = b.pinned ? 1 : 0;
  if (pa !== pb) return pb - pa;
  if (!a.pinned && a.priority !== b.priority) return b.priority - a.priority;
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Greedy, deterministic placement of the HTML overlay of one frame: pinned
 * entries first (nearest first), then by priority (highest first), depth
 * (nearest first) and key.  Each entry takes the first of its boxes that stays
 * `gap` px clear of every box placed before it and is left out of this frame
 * when none does (it comes back when the camera moves).  Pinned entries take
 * their first box whatever it covers; free entries take their first box and
 * block nothing.  At most `cap` entries are placed.  Returns the placements in
 * placement order; the result does not depend on the order of `entries`.
 */
export function placeOverlay(entries: readonly OverlayEntry[], cap: number, gap = OVERLAY_GAP): OverlayPlacement[] {
  const order = [...entries].sort(overlayOrder);
  const taken: ScreenBox[] = [];
  const out: OverlayPlacement[] = [];
  for (const entry of order) {
    if (out.length >= cap) break;
    if (entry.boxes.length === 0) continue;
    if (entry.free) {
      out.push({ key: entry.key, box: 0 });
      continue;
    }
    let chosen = entry.pinned ? 0 : -1;
    for (let i = 0; chosen < 0 && i < entry.boxes.length; i++) {
      const box = entry.boxes[i];
      if (!taken.some((t) => boxesOverlap(t, box, gap))) chosen = i;
    }
    if (chosen < 0) continue;
    taken.push(entry.boxes[chosen]);
    out.push({ key: entry.key, box: chosen });
  }
  return out;
}
