/**
 * Glyphs of the 3D view's action chips: one inline-SVG path per effect kind
 * (move, attack, message, ...) in a 24 x 24 viewBox, a diagonal strike added
 * for a failed action, and the chip's text (the effect's label, shortened).
 * The paths are strokes (fill none, stroke-width 2, round caps and joins) so
 * they take the chip's text colour and stay crisp at 12 to 16 px.  No Unicode
 * pictographs anywhere: those fall back to colour emoji on some platforms.
 * Pure; tested by src/state/state.test.mjs.
 *
 * DOCS: the 2D map's badges use their own letters and paths (design_2d.md); the
 * two views need not share a glyph table.
 */

import type { EffectKind, TurnEffect } from "./turnEffects";

// DOCS: glyphFor(kind, ok) -> { path, label } (ASCII SVG path data, 24 x 24, stroke style); chipText(effect) -> label cut to 40 characters.

/** The viewBox every glyph path is drawn in. */
export const GLYPH_VIEWBOX = "0 0 24 24";
/** Stroke width the paths are designed for (in viewBox units). */
export const GLYPH_STROKE_WIDTH = 2;
/** Longest chip text, in characters (including the ellipsis). */
export const CHIP_TEXT_MAX = 40;
/** The diagonal strike appended to a failed action's glyph. */
export const STRIKE_PATH = "M4 20 L20 4";

/** An SVG path (stroke style, viewBox GLYPH_VIEWBOX) and a short accessible name. */
export interface Glyph {
  path: string;
  label: string;
}

const PATHS: Record<EffectKind, string> = {
  // arrow pointing right
  move: "M4 12 H18 M13 7 L18 12 L13 17",
  // two crossed blades with short guards
  attack: "M5 19 L19 5 M4 15 L9 20 M19 19 L5 5 M20 15 L15 20",
  // envelope
  message: "M3 6 H21 V18 H3 Z M3 6 L12 13 L21 6",
  // arrow down into a cup
  absorb: "M12 3 V13 M8 9 L12 13 L16 9 M5 15 V20 H19 V15",
  // two arrows, right above left
  transfer: "M4 8 H17 M14 5 L17 8 L14 11 M20 16 H7 M10 13 L7 16 L10 19",
  // plus
  recover: "M12 5 V19 M5 12 H19",
  // chevron up
  upgrade: "M5 15 L12 8 L19 15",
  // pause bars
  wait: "M9 5 V19 M15 5 V19",
  // eye
  observe: "M2 12 C6 5 18 5 22 12 C18 19 6 19 2 12 Z M9 12 A3 3 0 1 0 15 12 A3 3 0 1 0 9 12",
  // question mark
  query: "M9 9 A3 3 0 1 1 12 12 V14 M12 18 V18.5",
  // gear: ring with eight teeth
  skill: "M8 12 A4 4 0 1 0 16 12 A4 4 0 1 0 8 12 M12 3 V6 M12 18 V21 M3 12 H6 M18 12 H21 M5.6 5.6 L7.8 7.8 M16.2 16.2 L18.4 18.4 M5.6 18.4 L7.8 16.2 M16.2 7.8 L18.4 5.6",
  // skull outline with two eyes and a nose
  death: "M12 3 C7.5 3 4 6.5 4 11 C4 14 6 16 8 17 V21 H16 V17 C18 16 20 14 20 11 C20 6.5 16.5 3 12 3 Z M7.5 11 A1.5 1.5 0 1 0 10.5 11 A1.5 1.5 0 1 0 7.5 11 M13.5 11 A1.5 1.5 0 1 0 16.5 11 A1.5 1.5 0 1 0 13.5 11 M11 16 L12 14 L13 16",
  // leaf with a midrib
  growth: "M5 19 C5 9 12 4 20 4 C20 12 15 19 5 19 Z M5 19 L14 10",
  // sprout: stem with two leaves
  fruit: "M12 21 V11 M12 14 C8 14 5 12 5 8 C9 8 12 10 12 14 M12 11 C12 7 15 4 19 4 C19 8 16 11 12 11",
  seed: "M12 21 V11 M12 14 C8 14 5 12 5 8 C9 8 12 10 12 14 M12 11 C12 7 15 4 19 4 C19 8 16 11 12 11",
  germination: "M12 21 V11 M12 14 C8 14 5 12 5 8 C9 8 12 10 12 14 M12 11 C12 7 15 4 19 4 C19 8 16 11 12 11",
  // exclamation mark
  starvation: "M12 4 V14 M12 18 V18.5",
  // megaphone
  voice: "M4 10 V14 H7 L15 19 V5 L7 10 Z M18 9 C20 10 20 14 18 15",
};

const LABELS: Record<EffectKind, string> = {
  move: "move",
  attack: "attack",
  message: "message",
  absorb: "absorb",
  transfer: "transfer",
  recover: "recover",
  upgrade: "upgrade",
  wait: "wait",
  observe: "observe",
  query: "query",
  skill: "skill",
  death: "death",
  growth: "growth",
  fruit: "fruit",
  seed: "seed",
  germination: "germination",
  starvation: "starvation",
  voice: "operator voice",
};

/** Every effect kind, in the order of the glyph table (for tests and legends). */
export const GLYPH_KINDS: readonly EffectKind[] = Object.keys(PATHS) as EffectKind[];

/**
 * The glyph of an effect kind.  `ok === false` appends STRIKE_PATH (a diagonal
 * across the icon) and adds " (failed)" to the label.  Unknown kinds (not
 * possible in TypeScript, possible from stored data) get the skill gear.
 */
export function glyphFor(kind: EffectKind, ok: boolean): Glyph {
  const path = PATHS[kind] ?? PATHS.skill;
  const label = LABELS[kind] ?? String(kind);
  return ok ? { path, label } : { path: `${path} ${STRIKE_PATH}`, label: `${label} (failed)` };
}

/**
 * The chip's text: the effect's label, cut to CHIP_TEXT_MAX characters with a
 * trailing ellipsis when longer (the full label stays in the chip's title).
 */
export function chipText(effect: Pick<TurnEffect, "label">): string {
  const label = effect.label.trim();
  if (label.length <= CHIP_TEXT_MAX) return label;
  return `${label.slice(0, CHIP_TEXT_MAX - 1).trimEnd()}…`;
}

/** CSS class suffix of a chip: the kind, plus "failed" when the action failed. */
export function chipClasses(effect: Pick<TurnEffect, "kind" | "ok">): string {
  return effect.ok ? `map3d-chip map3d-chip-${effect.kind}` : `map3d-chip map3d-chip-${effect.kind} map3d-chip-failed`;
}
