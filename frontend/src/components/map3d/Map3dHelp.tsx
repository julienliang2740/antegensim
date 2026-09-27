/**
 * The 3D view's help card: the key and pointer bindings of the board as a
 * table (role dialog "3D map controls"), shown on the first 3D open (the
 * localStorage flag HELP_SEEN_KEY), by the toolbar's "Controls", "?" or "H",
 * and hidden by "Close", Escape or a click on the board.
 */

// DOCS: .map3d-help[role=dialog][aria-label="3D map controls"]; first-open flag localStorage empyrean.map3d.helpSeen = "1".

import { useEffect, useRef } from "react";

/** localStorage flag: "1" once the card has been shown. */
export const HELP_SEEN_KEY = "empyrean.map3d.helpSeen";

const HELP_ROWS: { keys: string; does: string }[] = [
  { keys: "W A S D", does: "fly forward, back and sideways (faster the higher you are)" },
  { keys: "Space / Shift", does: "go up / go down" },
  { keys: "Q E or ← →", does: "turn left / right" },
  { keys: "↑ ↓", does: "look up / look down" },
  { keys: "Left drag", does: "look around" },
  { keys: "Right or middle drag", does: "pan across the board" },
  { keys: "Wheel or pinch", does: "zoom toward the point under the pointer" },
  { keys: "Click a figure or its label", does: "select the entity (opens its profile card)" },
  { keys: "Click a tile", does: "select the cell (its only occupant, if one, is selected too)" },
  { keys: "PageUp / PageDown", does: "layer up / layer down" },
  { keys: "F / T / Home", does: "frame the region / top view / focus the selected cell" },
  { keys: "R", does: "replay the viewed turn's animations" },
  { keys: "? or H", does: "show or hide this card" },
  { keys: "Escape", does: "close this card, else the cell tooltip, else cancel a drag" },
];

export function Map3dHelp(props: { onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      className="map3d-help"
      role="dialog"
      aria-label="3D map controls"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div className="map3d-help-head">
        <strong>3D map controls</strong>
        <button ref={closeRef} type="button" className="insp-btn insp-btn-small" onClick={props.onClose}>
          Close
        </button>
      </div>
      <table className="map3d-help-table">
        <tbody>
          {HELP_ROWS.map((row) => (
            <tr key={row.keys}>
              <th scope="row">{row.keys}</th>
              <td>{row.does}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="map3d-help-note">Keys work while the board has focus: click it first. No Ctrl or Alt chords.</p>
    </div>
  );
}
