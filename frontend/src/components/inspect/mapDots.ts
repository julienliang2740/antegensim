/**
 * Dot layout of one map cell (spec U1 "click on a dot and open up who and what
 * is there"; "Display and historical inspection": colocated entities must stay
 * individually selectable rather than hiding behind overlapping dots).
 *
 * Every entity of a cell is one dot, colour-coded by kind, laid out on a small
 * grid inside the cell so dots never overlap.  When the cell is too small for
 * all of them at the current zoom, the dots that fit are drawn and the last row
 * carries a "+N" count; zooming in (a larger cell) reveals the rest.  Below
 * DOT_MIN_CELL_PX a cell shows one aggregate count marker instead.
 *
 * Pure functions (no React): MapView draws the layout and hit-tests the
 * pointer against it, so a hovered or clicked dot is known exactly.
 */

import type { MapMarker } from "./logic";

/** Below this cell size a cell shows one aggregate count marker instead of dots. */
export const DOT_MIN_CELL_PX = 24;
/** Smallest distance between dot centres (dot diameter is about 72% of it). */
const MIN_PITCH_PX = 11;
/** Largest dot diameter, however far the map is zoomed in. */
const MAX_DOT_PX = 44;
/** Dots at least this wide carry a short label (a01, p1, f12, r3). */
export const DOT_LABEL_MIN_PX = 24;

export type DotKind = "agent" | "dead" | "plant" | "fruit" | "seed" | "residue";

export interface Dot {
  marker: MapMarker;
  kind: DotKind;
  /** Centre relative to the cell's top-left corner. */
  cx: number;
  cy: number;
  r: number;
}

export interface CellDots {
  dots: Dot[];
  /** Entities not drawn as dots (shown as "+N"); 0 when every entity has a dot. */
  hidden: number;
  /** Where the "+N" label goes (relative to the cell), when hidden > 0. */
  more: { x: number; y: number; fontSize: number } | null;
}

/** Drawing order inside a cell: living agents, dead ones, plants, fruit, seeds, residue. */
const KIND_RANK: Record<DotKind, number> = { agent: 0, dead: 1, plant: 2, fruit: 3, seed: 4, residue: 5 };

export function dotKind(m: MapMarker): DotKind {
  if (m.dead) return "dead";
  return m.kind;
}

/** Short label inside a large dot: agent ids as they are, other ids without leading zeros (p0003 -> p3, res0012 -> r12). */
export function dotLabel(m: MapMarker): string {
  if (m.kind === "agent") return m.id;
  const match = /^([A-Za-z]+?)0*(\d+)$/.exec(m.id);
  if (!match) return m.id.slice(0, 4);
  const prefix = m.kind === "residue" ? "r" : match[1].charAt(0);
  return `${prefix}${match[2]}`;
}

/**
 * Sort a cell's markers for drawing.  When not every dot fits, the acting agent
 * and the selected entity are moved to the front so they always keep a dot.
 */
export function orderMarkers(markers: readonly MapMarker[], priorityIds: readonly (string | null | undefined)[], capacity: number): MapMarker[] {
  const byRank = (a: MapMarker, b: MapMarker) => KIND_RANK[dotKind(a)] - KIND_RANK[dotKind(b)] || a.id.localeCompare(b.id);
  const sorted = [...markers].sort(byRank);
  if (sorted.length <= capacity) return sorted;
  const promoted = new Set(priorityIds.filter((id): id is string => !!id && sorted.findIndex((m) => m.id === id) >= capacity));
  if (promoted.size === 0) return sorted;
  const rest = sorted.filter((m) => !promoted.has(m.id));
  const keep = capacity - promoted.size;
  const visible = rest.slice(0, keep).concat(sorted.filter((m) => promoted.has(m.id))).sort(byRank);
  return visible.concat(rest.slice(keep));
}

/**
 * Lay out `markers` inside a cell of `cellPx` pixels.  Returns null when the
 * cell is too small for dots (the caller draws an aggregate marker).
 */
export function layoutCell(markers: readonly MapMarker[], cellPx: number, priorityIds: readonly (string | null | undefined)[] = []): CellDots | null {
  const n = markers.length;
  if (n === 0 || cellPx < DOT_MIN_CELL_PX) return null;
  const pad = Math.max(2, cellPx * 0.07);
  const inner = cellPx - 2 * pad;
  const maxCols = Math.max(1, Math.floor(inner / MIN_PITCH_PX));
  const wantCols = Math.ceil(Math.sqrt(n));
  // Room for one dot only: a crowded cell shows the aggregate marker instead.
  if (maxCols < 2 && n > 1) return null;

  let cols: number;
  let rows: number;
  let shown: number;
  let hidden = 0;
  if (wantCols <= maxCols) {
    cols = wantCols;
    rows = Math.ceil(n / cols);
    shown = n;
  } else {
    // Too many: fill every row but the last with dots; the last row holds "+N".
    cols = maxCols;
    rows = maxCols;
    const slots = cols * Math.max(1, rows - 1);
    shown = Math.min(n, slots);
    hidden = n - shown;
  }
  const pitch = inner / Math.max(cols, rows);
  const r = Math.min(MAX_DOT_PX, pitch * 0.74) / 2;
  const gridW = cols * pitch;
  const usedRows = hidden > 0 ? rows : Math.ceil(shown / cols);
  const gridH = usedRows * pitch;
  const x0 = (cellPx - gridW) / 2;
  const y0 = (cellPx - gridH) / 2;

  const ordered = orderMarkers(markers, priorityIds, shown);
  const dots: Dot[] = ordered.slice(0, shown).map((marker, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return { marker, kind: dotKind(marker), cx: x0 + (col + 0.5) * pitch, cy: y0 + (row + 0.5) * pitch, r };
  });
  let more: CellDots["more"] = null;
  if (hidden > 0) {
    const fontSize = Math.max(9, Math.min(15, pitch * 0.62));
    more = { x: cellPx / 2, y: y0 + (rows - 0.5) * pitch + fontSize * 0.35, fontSize };
  }
  return { dots, hidden, more };
}

/** The dot under a point given relative to the cell's top-left corner (a small margin makes small dots easy to hit). */
export function dotAt(layout: CellDots | null, x: number, y: number): Dot | null {
  if (!layout) return null;
  for (const d of layout.dots) {
    if (Math.hypot(x - d.cx, y - d.cy) <= d.r + 2) return d;
  }
  return null;
}
