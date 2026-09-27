/**
 * Colours of the 3D view, read from the same `--insp-*` CSS tokens as the 2D
 * map (frontend/src/inspect.css) so dark mode and any theme change apply to
 * both.  The view calls readPalette with a getComputedStyle-backed getter at
 * mount and on theme changes; this module parses the CSS colour strings,
 * fills in a grey for a missing token (and names it, so the view can log it
 * once), derives the health tint, the per-species hue shift, the darker
 * mountain sides and the dominant kind of a crowded cell for the far LOD.
 * Pure (no DOM); tested by src/state/state.test.mjs.
 *
 * Colours are linear-looking 0..1 RGB triples (the sRGB channel values / 255;
 * the scene hands them to three.js colours as-is).
 *
 * DOCS: the `.map3d` root must carry the `insp` class, because the tokens are
 * scoped to `.insp`; otherwise every token reads as "" and the palette is grey
 * with every name in `missing`.
 */

import type { FigureKind, SlotMarker } from "./map3dLayout";
import { FIGURE_KIND_RANK, figureKind } from "./map3dLayout";
import type { Rgb, TerrainPalette } from "./map3dTerrain";

// DOCS: readPalette(name => getComputedStyle(root).getPropertyValue(name)) -> Palette (missing tokens grey and listed); healthColour, speciesHueShift, kindColour, dominantKind.

export type { Rgb } from "./map3dTerrain";

/** Names of the palette roles, each backed by one CSS token. */
export type PaletteRole =
  | "bg"
  | "fg"
  | "muted"
  | "accent"
  | "outside"
  | "land"
  | "mountain"
  | "mountainLine"
  | "water"
  | "waterLine"
  | "grid"
  | "border"
  | "agent"
  | "dead"
  | "plant"
  | "fruit"
  | "seed"
  | "residue"
  | "highlight"
  | "entitySel"
  | "selInner"
  | "selOuter"
  | "good"
  | "warn"
  | "bad";

/** The CSS token behind each role (fruit is `--insp-other`, the 2D map's "other" colour). */
export const ROLE_TOKENS: Record<PaletteRole, string> = {
  bg: "--insp-bg",
  fg: "--insp-fg",
  muted: "--insp-muted",
  accent: "--insp-accent",
  outside: "--insp-outside",
  land: "--insp-land",
  mountain: "--insp-mountain",
  mountainLine: "--insp-mountain-line",
  water: "--insp-water",
  waterLine: "--insp-water-line",
  grid: "--insp-grid",
  border: "--insp-border-strong",
  agent: "--insp-agent",
  dead: "--insp-dead",
  plant: "--insp-plant",
  fruit: "--insp-other",
  seed: "--insp-seed",
  residue: "--insp-residue",
  highlight: "--insp-highlight",
  entitySel: "--insp-entity-sel",
  selInner: "--insp-sel-inner",
  selOuter: "--insp-sel-outer",
  good: "--insp-good",
  warn: "--insp-warn-border",
  bad: "--insp-bad",
};

/** Every `--insp-*` token the 3D view reads, in role order. */
export const PALETTE_TOKENS: readonly string[] = Object.values(ROLE_TOKENS);

/** Colour used for a token that is missing or unparseable. */
export const MISSING_COLOUR: Rgb = [0.5, 0.5, 0.5];

/** Mountain sides are this fraction darker than the top. */
export const MOUNTAIN_SIDE_DARKEN = 0.2;

/** Largest hue shift (degrees either way) a plant species gets. */
export const SPECIES_HUE_RANGE = 14;

/** How far agent-view (remembered) figures are blended toward the land colour. */
export const GHOST_BLEND = 0.5;

/** The resolved palette: one RGB per role, the grid's alpha, and the tokens that were missing. */
export type Palette = Record<PaletteRole, Rgb> & {
  /** Alpha of `--insp-grid` (0.16 in the shipped theme); 1 when the token has none. */
  gridAlpha: number;
  /** Token names that were empty or unparseable and fell back to MISSING_COLOUR. */
  missing: string[];
};

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function channel(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  if (t.endsWith("%")) {
    const pct = Number(t.slice(0, -1));
    return Number.isFinite(pct) ? clamp01(pct / 100) : null;
  }
  const v = Number(t);
  return Number.isFinite(v) ? clamp01(v / 255) : null;
}

function alphaChannel(text: string): number | null {
  const t = text.trim();
  if (t === "") return 1;
  if (t.endsWith("%")) {
    const pct = Number(t.slice(0, -1));
    return Number.isFinite(pct) ? clamp01(pct / 100) : null;
  }
  const v = Number(t);
  return Number.isFinite(v) ? clamp01(v) : null;
}

/**
 * Parse a CSS colour with its alpha: "#rgb", "#rgba", "#rrggbb", "#rrggbbaa",
 * "rgb(r, g, b)", "rgba(r, g, b, a)", the space-separated "rgb(r g b / a)"
 * form and percentages.  Returns [r, g, b, a] in 0..1, or null for anything
 * else ("", "transparent", a named colour, a var()).
 */
export function parseCssColorAlpha(text: string | null | undefined): [number, number, number, number] | null {
  if (typeof text !== "string") return null;
  const t = text.trim().toLowerCase();
  if (t === "") return null;
  if (t.startsWith("#")) {
    const hex = t.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const parts = hex.split("").map((c) => parseInt(c + c, 16) / 255);
      return [parts[0], parts[1], parts[2], hex.length === 4 ? parts[3] : 1];
    }
    if (hex.length === 6 || hex.length === 8) {
      const parts = [0, 2, 4, 6].filter((i) => i < hex.length).map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      return [parts[0], parts[1], parts[2], hex.length === 8 ? parts[3] : 1];
    }
    return null;
  }
  const m = /^rgba?\((.*)\)$/.exec(t);
  if (!m) return null;
  const inner = m[1];
  let parts: string[];
  let alphaText = "";
  if (inner.includes(",")) {
    parts = inner.split(",");
    if (parts.length === 4) alphaText = parts.pop() ?? "";
  } else {
    const slash = inner.split("/");
    parts = slash[0].trim().split(/\s+/);
    alphaText = slash[1] ?? "";
  }
  if (parts.length !== 3) return null;
  const r = channel(parts[0]);
  const g = channel(parts[1]);
  const b = channel(parts[2]);
  const a = alphaChannel(alphaText);
  if (r === null || g === null || b === null || a === null) return null;
  return [r, g, b, a];
}

/**
 * Parse a CSS colour to [r, g, b] in 0..1 (alpha dropped): hex 3/4/6/8 digits
 * and rgb()/rgba() in either syntax.  Null for anything else, including "".
 */
export function parseCssColor(text: string | null | undefined): Rgb | null {
  const c = parseCssColorAlpha(text);
  return c ? [c[0], c[1], c[2]] : null;
}

/**
 * Resolve every role through `getVar(tokenName)` (the value of a custom
 * property, e.g. from getComputedStyle(root).getPropertyValue).  A token that
 * comes back empty or unparseable gets MISSING_COLOUR and its name is appended
 * to `missing`, in role order.  Never throws on a getter that throws: the token
 * is treated as missing.
 */
export function readPalette(getVar: (name: string) => string): Palette {
  const missing: string[] = [];
  const out: Partial<Record<PaletteRole, Rgb>> = {};
  let gridAlpha = 1;
  for (const role of Object.keys(ROLE_TOKENS) as PaletteRole[]) {
    const token = ROLE_TOKENS[role];
    let raw = "";
    try {
      raw = getVar(token) ?? "";
    } catch {
      raw = "";
    }
    const parsed = parseCssColorAlpha(raw);
    if (parsed) {
      out[role] = [parsed[0], parsed[1], parsed[2]];
      if (role === "grid") gridAlpha = parsed[3];
    } else {
      out[role] = MISSING_COLOUR;
      missing.push(token);
    }
  }
  return { ...(out as Record<PaletteRole, Rgb>), gridAlpha, missing };
}

/** Channel-wise blend: a * (1 - t) + b * t, t clamped to [0, 1]. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** The colour scaled toward black by `fraction` (0.2 -> 20 % darker). */
export function darken(rgb: Rgb, fraction: number): Rgb {
  const k = 1 - clamp01(fraction);
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
}

/** The terrain colours for map3dTerrain: land, mountain, water tops and sides MOUNTAIN_SIDE_DARKEN darker. */
export function terrainPalette(palette: Palette): TerrainPalette {
  return { land: palette.land, mountain: palette.mountain, mountainSide: darken(palette.mountain, MOUNTAIN_SIDE_DARKEN), water: palette.water };
}

/**
 * Colour of an agent's health disc for `frac` = health / max_health, clamped to
 * [0, 1] (NaN counts as 0): bad (red) at 0, warn (gold) at 0.5, good (green) at
 * 1, linear between.
 */
export function healthColour(frac: number, palette: Palette): Rgb {
  const f = Number.isFinite(frac) ? clamp01(frac) : 0;
  return f <= 0.5 ? mix(palette.bad, palette.warn, f / 0.5) : mix(palette.warn, palette.good, (f - 0.5) / 0.5);
}

/**
 * A stable hue shift for a plant species, in whole degrees within
 * [-SPECIES_HUE_RANGE, SPECIES_HUE_RANGE]: an FNV-1a hash of the name, so the
 * same species has the same tint in every run and view.  "" gives 0.
 */
export function speciesHueShift(species: string): number {
  if (!species) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < species.length; i++) {
    h ^= species.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % (2 * SPECIES_HUE_RANGE + 1)) - SPECIES_HUE_RANGE;
}

/** RGB (0..1) to HSL with h in degrees [0, 360), s and l in 0..1. */
export function rgbToHsl(rgb: Rgb): [number, number, number] {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

/** HSL (h degrees, s and l in 0..1) to RGB in 0..1. */
export function hslToRgb(hsl: [number, number, number]): Rgb {
  const [hIn, s, l] = hsl;
  const h = ((hIn % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: Rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [clamp01(rgb[0] + m), clamp01(rgb[1] + m), clamp01(rgb[2] + m)];
}

/** The colour with its hue rotated by `degrees` (saturation and lightness kept); a grey is returned unchanged. */
export function shiftHue(rgb: Rgb, degrees: number): Rgb {
  const [h, s, l] = rgbToHsl(rgb);
  if (s === 0) return [rgb[0], rgb[1], rgb[2]];
  return hslToRgb([h + degrees, s, l]);
}

/** Base colour of a figure kind: agent, dead, plant, fruit (`--insp-other`), seed, residue. */
export function kindColour(kind: FigureKind, palette: Palette): Rgb {
  return palette[kind];
}

/** Colour of a plant figure: the plant token shifted by the species' hue; a dead plant is the dead colour. */
export function plantColour(species: string, dead: boolean, palette: Palette): Rgb {
  return dead ? palette.dead : shiftHue(palette.plant, speciesHueShift(species));
}

/** Agent-view figures: the colour blended GHOST_BLEND toward the land colour (a remembered sighting, not the truth). */
export function ghostTint(rgb: Rgb, palette: Palette): Rgb {
  return mix(rgb, palette.land, GHOST_BLEND);
}

/**
 * The kind a far-LOD column takes for a cell: "agent" when any living agent is
 * there, else the most frequent of dead / plant / fruit / seed / residue (ties
 * go to the earlier kind in drawing order), null for an empty cell.
 */
export function dominantKind(markers: readonly SlotMarker[]): FigureKind | null {
  if (markers.length === 0) return null;
  const counts: Partial<Record<FigureKind, number>> = {};
  for (const m of markers) {
    const k = figureKind(m);
    if (k === "agent") return "agent";
    counts[k] = (counts[k] ?? 0) + 1;
  }
  let best: FigureKind | null = null;
  for (const k of Object.keys(counts) as FigureKind[]) {
    if (best === null || (counts[k] ?? 0) > (counts[best] ?? 0) || ((counts[k] ?? 0) === (counts[best] ?? 0) && FIGURE_KIND_RANK[k] < FIGURE_KIND_RANK[best])) best = k;
  }
  return best;
}

/** "rgb(31, 95, 191)" for an Rgb, for the HTML overlay (labels, chips) when a token is not usable directly. */
export function rgbToCss(rgb: Rgb): string {
  return `rgb(${Math.round(clamp01(rgb[0]) * 255)}, ${Math.round(clamp01(rgb[1]) * 255)}, ${Math.round(clamp01(rgb[2]) * 255)})`;
}
