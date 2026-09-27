/**
 * The centre column's map view choice ("2D map" or "3D view"): the localStorage
 * key it is remembered under and the parser that turns a stored string back into
 * a mode.  RunPage reads the key in a useState initialiser (inside try/catch,
 * because storage can be blocked) and writes it whenever the choice changes.
 * Also the focus handoff between the switch's two copies (one in each view's
 * legend): a switch made from a focused radio asks the copy that shows the new
 * view to take the focus.  No React, no DOM; tested by src/state/state.test.mjs.
 *
 * DOCS: the view choice is a browser preference like the panel sizes, not part
 * of the hash route; anything but the exact string "3d" means the 2D map.
 */

// DOCS: `empyrean.map.view` holds "2d" | "3d"; the default and every unknown value is "2d".

/** The two ways the centre column can show the world. */
export type MapViewMode = "2d" | "3d";

/** localStorage key of the remembered map view ("2d" | "3d"). */
export const MAP_VIEW_STORAGE_KEY = "empyrean.map.view";

/** The default view: the SVG map, which needs no WebGL. */
export const DEFAULT_MAP_VIEW_MODE: MapViewMode = "2d";

/**
 * Parse a stored view mode.  Exactly "3d" selects the 3D view; null (nothing
 * stored), "2d" and any other string give the 2D map, so a corrupted or older
 * value never leaves the page without a map.
 */
export function parseMapViewMode(raw: string | null): MapViewMode {
  return raw === "3d" ? "3d" : "2d";
}

/** The mode whose switch copy should take the focus next (a single pending request; see requestSwitchFocus). */
const focusRequest: { mode: MapViewMode | null } = { mode: null };

/**
 * Ask the switch copy that shows `mode` to take the focus when it becomes visible (the other
 * view's legend), so a keyboard user never keeps the focus on a hidden radio.  `null` cancels.
 */
export function requestSwitchFocus(mode: MapViewMode | null): void {
  focusRequest.mode = mode;
}

/** True once for the copy showing the requested mode (the request is then cleared); false otherwise. */
export function takeSwitchFocus(mode: MapViewMode): boolean {
  if (focusRequest.mode !== mode) return false;
  focusRequest.mode = null;
  return true;
}
