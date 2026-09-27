/**
 * Dot layout of one map cell (spec U1 "click on a dot and open up who and what
 * is there"; "Display and historical inspection": colocated entities must stay
 * individually selectable rather than hiding behind overlapping dots).
 *
 * Every entity of a cell is one dot, colour-coded by kind.  One zoom level has
 * ONE dot diameter (DOT_TABLE): nothing about a cell's contents changes it, so
 * "same size = same thing" holds across the board.  A cell lays its dots out on
 * a square grid: at the normal pitch while they fit (roomy), tighter down to
 * PACKED_PITCH_RATIO of the diameter when they do not (packed, with a count
 * badge in the top-right corner showing the total), and beyond the packed
 * capacity the first ordered entities get the free slots while the badge still
 * shows the total (over).  Grid slots under the badge stay empty, so every
 * drawn dot is visible and clickable.  Below DOT_MIN_CELL_PX (far mode) a cell
 * is one kind-coloured group tile whose area grows with the count (tileFor).
 *
 * Pure functions (no React): MapView draws the layout and hit-tests the
 * pointer against it (hitCell), so a hovered or clicked dot is known exactly.
 * Tested by src/state/state.test.mjs ("map dots: ...").
 */

// DOCS: circles are individuals, squares (far mode) are groups; the dot size depends on the zoom
// level only; a packed cell shows every occupant plus a total-count badge in its top-right corner
// (no dot sits under the badge), an over-full cell the first N and the total.

import type { MapMarker } from "./logic";

/** Cell sizes in px for the zoom buttons (index DEFAULT_ZOOM_INDEX opens by default). */
export const ZOOM_LEVELS = [10, 14, 18, 24, 30, 36, 44, 56, 72, 96, 128, 160, 200, 260, 340];
export const DEFAULT_ZOOM_INDEX = 6; // 44 px
/** Below this cell size a cell shows one group tile instead of dots (far mode). */
export const DOT_MIN_CELL_PX = 24;
/** Packed cells compress the centre distance down to this share of the dot diameter (neighbours overlap by at most 25 %). */
export const PACKED_PITCH_RATIO = 0.75;
/** From this cell size the count badge is a pill in the top-right corner; below it bare digits in that corner. */
export const BADGE_PILL_MIN_CELL_PX = 36;
/** A dot may reach under the (opaque) count pill by at most this many px; grid slots closer to it stay empty. */
export const PILL_GRAZE_PX = 1;
/** Bare digits are thin strokes: a dot centre stays at least this share of the radius outside their box. */
export const DIGITS_CLEAR_RATIO = 0.5;

export type DotKind = "agent" | "dead" | "plant" | "fruit" | "seed" | "residue";

/** Drawing order inside a cell: living agents, dead ones, plants, fruit, seeds, residue. */
export const KIND_RANK: Record<DotKind, number> = { agent: 0, dead: 1, plant: 2, fruit: 3, seed: 4, residue: 5 };

/** One row of DOT_TABLE: the dot geometry of a zoom level. */
export interface DotSpec {
  cellPx: number;
  /** Space kept free at the cell edge. */
  pad: number;
  /** cellPx − 2·pad. */
  inner: number;
  /** Dot diameter. */
  d: number;
  /** Centre distance at normal spacing. */
  pitch: number;
  /** Dots per row at normal spacing (capacity colsNormal²). */
  colsNormal: number;
  /** Dots per row when packed (capacity colsPacked²). */
  colsPacked: number;
}

const DOT_ROWS: ReadonlyArray<readonly [cellPx: number, pad: number, d: number, pitch: number]> = [
  [24, 2, 8, 10],
  [30, 2, 8, 10],
  [36, 2, 8, 10],
  [44, 2, 9, 11],
  [56, 3, 10, 12],
  [72, 3, 12, 15],
  [96, 4, 14, 17],
  [128, 4, 16, 19],
  [160, 6, 18, 22],
  [200, 6, 20, 24],
  [260, 8, 22, 26],
  [340, 8, 24, 28],
];

/** One diameter and pitch per zoom level from DOT_MIN_CELL_PX up; d and both capacities never fall as cellPx grows. */
export const DOT_TABLE: readonly DotSpec[] = DOT_ROWS.map(([cellPx, pad, d, pitch]) => {
  const inner = cellPx - 2 * pad;
  return { cellPx, pad, inner, d, pitch, colsNormal: Math.floor(inner / pitch), colsPacked: Math.floor(inner / (PACKED_PITCH_RATIO * d)) };
});

/** The table row with the largest cellPx ≤ the argument (the first row below DOT_MIN_CELL_PX; callers check that first). */
export function dotSpec(cellPx: number): DotSpec {
  let row = DOT_TABLE[0];
  for (const spec of DOT_TABLE) {
    if (spec.cellPx <= cellPx) row = spec;
    else break;
  }
  return row;
}

export interface Dot {
  marker: MapMarker;
  kind: DotKind;
  /** Centre relative to the cell's top-left corner. */
  cx: number;
  cy: number;
  r: number;
}

/** The total-count badge of a packed or over-full cell (coordinates relative to the cell). */
export interface CellBadge {
  /** Total occupants of the cell (drawn or not). */
  count: number;
  /** "pill" in the top-right corner (cellPx ≥ BADGE_PILL_MIN_CELL_PX), "bare" digits in that corner below it.  x, y, w, h: the drawn box (pill or digits with their halo), also the hit box. */
  style: "pill" | "bare";
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
}

export type CellMode = "roomy" | "packed" | "over";

export interface CellDots {
  spec: DotSpec;
  mode: CellMode;
  dots: Dot[];
  /** Entities drawn (= total unless over). */
  shown: number;
  total: number;
  cols: number;
  rows: number;
  /** Centre distance used (spec.pitch when roomy, inner / cols otherwise). */
  pitch: number;
  /** Dots the grid can hold: cols·rows minus the slots under the badge (shown = min(total, capacity)). */
  capacity: number;
  /** Top-left corner of the dot block. */
  x0: number;
  y0: number;
  badge: CellBadge | null;
  /** "below": a label under every dot of the single row; "none" otherwise. */
  labels: "below" | "none";
  labelY: number;
  labelFontSize: number;
}

export function dotKind(m: MapMarker): DotKind {
  if (m.dead) return "dead";
  return m.kind;
}

/** Short label under a dot: agent ids as they are, other ids without leading zeros (p0003 -> p3, res0012 -> r12). */
export function dotLabel(m: MapMarker): string {
  if (m.kind === "agent") return m.id;
  const match = /^([A-Za-z]+?)0*(\d+)$/.exec(m.id);
  if (!match) return m.id.slice(0, 4);
  const prefix = m.kind === "residue" ? "r" : match[1].charAt(0);
  return `${prefix}${match[2]}`;
}

/**
 * Sort a cell's markers for drawing (KIND_RANK, then id).  When not every dot fits, the
 * priority ids (acting, pending and selected entities, entities a mark names) keep a dot:
 * the first `capacity` of them in priority order (unknown ids and repeats ignored) are
 * pinned among the drawn dots, the free places go to the others in drawing order, and
 * everything else follows (no marker is dropped).
 */
export function orderMarkers(markers: readonly MapMarker[], priorityIds: readonly (string | null | undefined)[], capacity: number): MapMarker[] {
  const byRank = (a: MapMarker, b: MapMarker) => KIND_RANK[dotKind(a)] - KIND_RANK[dotKind(b)] || a.id.localeCompare(b.id);
  const sorted = [...markers].sort(byRank);
  if (sorted.length <= capacity) return sorted;
  const index = new Map(sorted.map((m, i) => [m.id, i]));
  const wanted = [...new Set(priorityIds.filter((id): id is string => !!id && index.has(id)))].slice(0, Math.max(0, capacity));
  if (wanted.every((id) => (index.get(id) ?? 0) < capacity)) return sorted;
  const pinned = new Set(wanted);
  const rest = sorted.filter((m) => !pinned.has(m.id));
  const keep = capacity - pinned.size;
  const visible = rest.slice(0, keep).concat(sorted.filter((m) => pinned.has(m.id))).sort(byRank);
  return visible.concat(rest.slice(keep));
}

function countBadge(count: number, cellPx: number): CellBadge {
  const text = count > 999 ? "999+" : String(count);
  if (cellPx >= BADGE_PILL_MIN_CELL_PX) {
    const h = Math.max(10, Math.min(16, Math.round(0.28 * cellPx)));
    const fontSize = Math.max(8, h - 3);
    const w = Math.round(text.length * 0.62 * fontSize) + 6;
    return { count, style: "pill", text, x: cellPx - 1 - w, y: 1, w, h, fontSize };
  }
  // Bare 9 px digits right-aligned in the top-right corner; the box includes their 1.25 px halo.
  const fontSize = 9;
  const w = Math.round(text.length * 0.62 * fontSize) + 2;
  return { count, style: "bare", text, x: cellPx - 1 - w, y: 1, w, h: 9, fontSize };
}

/**
 * Distance from a point (cell coordinates) to the badge as drawn, 0 inside: a pill is a
 * rectangle with fully rounded ends (rx = h / 2), bare digits are their box.
 */
export function badgeDistance(badge: CellBadge, x: number, y: number): number {
  if (badge.style === "pill") {
    const rr = badge.h / 2;
    const left = badge.x + rr;
    const right = Math.max(left, badge.x + badge.w - rr);
    const sx = Math.min(Math.max(x, left), right);
    return Math.max(0, Math.hypot(x - sx, y - (badge.y + rr)) - rr);
  }
  const dx = Math.max(badge.x - x, 0, x - (badge.x + badge.w));
  const dy = Math.max(badge.y - y, 0, y - (badge.y + badge.h));
  return Math.hypot(dx, dy);
}

interface Grid {
  cols: number;
  rows: number;
  pitch: number;
  x0: number;
  y0: number;
  /** Usable dot centres, row-major from the top-left, without the slots under the badge. */
  slots: { cx: number; cy: number }[];
}

/** How far a dot centre of radius r must stay from the badge (badgeDistance) to be drawn. */
export function badgeClearance(badge: CellBadge, r: number): number {
  return badge.style === "pill" ? r - PILL_GRAZE_PX : DIGITS_CLEAR_RATIO * r;
}

function grid(cols: number, rows: number, pitch: number, x0: number, y0: number, r: number, badge: CellBadge | null): Grid {
  const clear = badge ? badgeClearance(badge, r) : 0;
  const slots: Grid["slots"] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cx = x0 + (col + 0.5) * pitch;
      const cy = y0 + (row + 0.5) * pitch;
      if (badge && badgeDistance(badge, cx, cy) < clear) continue;
      slots.push({ cx, cy });
    }
  }
  return { cols, rows, pitch, x0, y0, slots };
}

/**
 * The packed grid for n dots beside the badge: the fewest columns (widest pitch) and then the
 * fewest rows whose free slots hold all n, or null when even colsPacked² minus the badge's
 * slots cannot (the cell is over-full).
 */
function packedGrid(n: number, spec: DotSpec, cellPx: number, badge: CellBadge): Grid | null {
  const r = spec.d / 2;
  for (let cols = Math.ceil(Math.sqrt(n)); cols <= spec.colsPacked; cols += 1) {
    const pitch = spec.inner / cols;
    for (let rows = Math.ceil(n / cols); rows <= cols; rows += 1) {
      const g = grid(cols, rows, pitch, spec.pad, (cellPx - rows * pitch) / 2, r, badge);
      if (g.slots.length >= n) return g;
    }
  }
  return null;
}

/**
 * Lay out `markers` inside a cell of `cellPx` pixels: a square grid, row-major from the
 * top-left, a partial last row left-aligned.  A packed or over-full cell gets its count badge
 * first and the grid slots under it stay empty, so no dot hides beneath the badge.  Returns
 * null when the cell is in far mode (the caller draws a group tile) or holds nothing.
 */
export function layoutCell(markers: readonly MapMarker[], cellPx: number, priorityIds: readonly (string | null | undefined)[] = []): CellDots | null {
  const n = markers.length;
  if (n === 0 || cellPx < DOT_MIN_CELL_PX) return null;
  const spec = dotSpec(cellPx);
  const r = spec.d / 2;
  let mode: CellMode;
  let badge: CellBadge | null = null;
  let g: Grid;
  if (n <= spec.colsNormal * spec.colsNormal) {
    mode = "roomy";
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    g = grid(cols, rows, spec.pitch, (cellPx - cols * spec.pitch) / 2, (cellPx - rows * spec.pitch) / 2, r, null);
  } else {
    badge = countBadge(n, cellPx);
    const packed = packedGrid(n, spec, cellPx, badge);
    mode = packed ? "packed" : "over";
    g = packed ?? grid(spec.colsPacked, spec.colsPacked, spec.inner / spec.colsPacked, spec.pad, spec.pad, r, badge);
  }
  const shown = Math.min(n, g.slots.length);
  const ordered = orderMarkers(markers, priorityIds, shown);
  const dots: Dot[] = ordered.slice(0, shown).map((marker, i) => ({ marker, kind: dotKind(marker), cx: g.slots[i].cx, cy: g.slots[i].cy, r }));
  const { cols, rows, pitch, x0, y0 } = g;
  const labels: CellDots["labels"] = rows === 1 && (cellPx - pitch) / 2 >= 12 && (n === 1 || pitch >= 22) ? "below" : "none";
  return {
    spec,
    mode,
    dots,
    shown,
    total: n,
    cols,
    rows,
    pitch,
    capacity: g.slots.length,
    x0,
    y0,
    badge,
    labels,
    labelY: y0 + pitch + 9,
    labelFontSize: cellPx < 96 ? 10 : 11,
  };
}

export type CellHit = { kind: "badge"; badge: CellBadge } | { kind: "dot"; dot: Dot };

/**
 * What lies under a point given relative to the cell's top-left corner: the count badge
 * (its drawn shape) first, else the dot whose centre is NEAREST among those within r + 2 (in
 * packed cells the tolerances of neighbours overlap, so a click between two dots goes to the
 * nearer one).  No dot centre lies under the badge (layoutCell), so every dot stays clickable.
 */
export function hitCell(layout: CellDots | null, x: number, y: number): CellHit | null {
  if (!layout) return null;
  const b = layout.badge;
  if (b && badgeDistance(b, x, y) === 0) return { kind: "badge", badge: b };
  let best: Dot | null = null;
  let bestDist = Infinity;
  for (const dot of layout.dots) {
    const dist = Math.hypot(x - dot.cx, y - dot.cy);
    if (dist <= dot.r + 2 && dist < bestDist) {
      best = dot;
      bestDist = dist;
    }
  }
  return best ? { kind: "dot", dot: best } : null;
}

/** Far mode: the group tile of one cell. */
export interface GroupTile {
  /** Side of the centred square (0.5 px steps); grows with log2(count + 1) up to cellPx − 2. */
  side: number;
  /** "agent" when a living agent is there, else the most numerous kind (KIND_RANK breaks ties). */
  kind: DotKind;
  count: number;
  /** Kinds present with their counts, in KIND_RANK order (the 2 px bar along the bottom edge when ≥ 2). */
  shares: { kind: DotKind; count: number }[];
  showCount: boolean;
  fontSize: number;
  text: string;
  showBar: boolean;
}

/** The group tile of a far-mode cell: area says how many, colour which kind.  Null for an empty cell. */
export function tileFor(markers: readonly MapMarker[], cellPx: number): GroupTile | null {
  const count = markers.length;
  if (count === 0) return null;
  const inner = cellPx - 2;
  const side = Math.round(inner * (0.5 + 0.5 * Math.min(1, Math.log2(count + 1) / 4)) * 2) / 2;
  const counts = new Map<DotKind, number>();
  for (const m of markers) {
    const k = dotKind(m);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const shares = [...counts.entries()].map(([kind, n]) => ({ kind, count: n })).sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  let kind: DotKind = "agent";
  if (!counts.has("agent")) {
    kind = shares.reduce((best, s) => (s.count > best.count ? s : best), shares[0]).kind;
  }
  const showCount = cellPx >= 14 && count >= 2;
  return {
    side,
    kind,
    count,
    shares,
    showCount,
    fontSize: cellPx === 14 ? 8 : 9,
    text: count > 99 ? "99+" : String(count),
    showBar: cellPx >= 14 && shares.length >= 2,
  };
}
