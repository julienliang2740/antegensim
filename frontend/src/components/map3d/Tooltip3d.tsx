/**
 * The 3D view's cell tooltip: the same interactive card as the 2D map's
 * (classes insp-tooltip insp-tooltip-interactive, role dialog "Cell (x, y)",
 * every occupant as a clickable row, the hovered one marked, "Close (Esc)"),
 * rendered in a portal on document.body and re-placed beside the cell's
 * projection on every rendered frame through `placeRef` (the view calls it
 * from the scene's frame hook, so it follows the camera without a React
 * render per frame).
 */

// DOCS: rows are button.insp-tooltip-row; the card follows the hovered cell as the camera moves and hides while the cell is off screen.

import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Point, RemovedEntity, Terrain } from "../../api/types";
import { KindTag } from "../inspect/common";
import { fmtPoint } from "../inspect/format";
import type { MapMarker } from "../inspect/logic";

/** Anchor of the tooltip in viewport (client) pixels: the box the card is placed beside. */
export interface TooltipAnchor {
  left: number;
  top: number;
  size: number;
}

export interface Tooltip3dProps {
  cell: Point;
  terrain: Terrain | null;
  occupants: readonly MapMarker[];
  removed: readonly RemovedEntity[];
  /** The hovered entity's id (its row is highlighted and marked "hovered"). */
  focusId: string | null;
  /** Agent view: "Aster (a01)" of the viewing agent, else null. */
  agentViewOf: string | null;
  /** The cell's projection now, or null while it is off screen (the card hides). */
  getAnchor(): TooltipAnchor | null;
  /** Receives the placement function (null on unmount) so the frame loop can re-place the card. */
  register(place: (() => void) | null): void;
  onEnter(): void;
  onLeave(): void;
  onClose(): void;
  onPick(id: string): void;
}

const WIDTH = 390;
const GAP = 6;
const MARGIN = 8;

function place(el: HTMLElement, anchor: TooltipAnchor | null): void {
  if (!anchor) {
    el.style.visibility = "hidden";
    return;
  }
  el.style.visibility = "";
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left: number;
  if (anchor.left + anchor.size + GAP + w <= vw - MARGIN) left = anchor.left + anchor.size + GAP;
  else if (anchor.left - GAP - w >= MARGIN) left = anchor.left - GAP - w;
  else left = Math.max(MARGIN, Math.min(vw - MARGIN - w, anchor.left + anchor.size - w));
  const beside = left >= anchor.left + anchor.size || left + w <= anchor.left;
  let top: number;
  if (beside) top = Math.max(MARGIN, Math.min(vh - MARGIN - h, anchor.top));
  else if (anchor.top + anchor.size + GAP + h <= vh - MARGIN) top = anchor.top + anchor.size + GAP;
  else if (anchor.top - GAP - h >= MARGIN) top = anchor.top - GAP - h;
  else top = Math.max(MARGIN, Math.min(vh - MARGIN - h, anchor.top + GAP));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

export function Tooltip3d(props: Tooltip3dProps) {
  const { cell, terrain, occupants, removed, focusId } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fn = () => place(el, props.getAnchor());
    fn();
    props.register(fn);
    return () => props.register(null);
  });
  useLayoutEffect(() => {
    if (!focusId) return;
    listRef.current?.querySelector<HTMLElement>("li.insp-tooltip-focus")?.scrollIntoView({ block: "nearest" });
  }, [focusId]);
  const width = Math.min(WIDTH, Math.max(160, window.innerWidth - 2 * MARGIN));
  const maxHeight = Math.max(80, Math.min(560, window.innerHeight * 0.72));
  return createPortal(
    <div className="insp insp-tooltip-layer">
      <div
        ref={ref}
        className="insp-tooltip insp-tooltip-interactive map3d-tooltip"
        style={{ left: -10000, top: 0, width, maxHeight }}
        role="dialog"
        aria-label={`Cell ${fmtPoint(cell)}`}
        onPointerEnter={props.onEnter}
        onPointerLeave={props.onLeave}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            props.onClose();
          }
        }}
      >
        <div className="insp-tooltip-head">
          <span>
            <strong>{fmtPoint(cell)}</strong> {terrain ?? (props.agentViewOf ? "unknown" : "outside region")} ·{" "}
            {props.agentViewOf ? `${occupants.length} known here` : `${occupants.length} ${occupants.length === 1 ? "occupant" : "occupants"}`}
          </span>
          <button type="button" className="insp-tooltip-close" aria-label="Close cell details" title="Close (Esc)" onClick={props.onClose}>
            ×
          </button>
        </div>
        {props.agentViewOf ? <div className="insp-tooltip-agentview">agent view: only what {props.agentViewOf} has observed</div> : null}
        {occupants.length === 0 ? <div className="insp-muted">Nobody and nothing here.</div> : null}
        <ul className="insp-tooltip-rows" ref={listRef}>
          {occupants.map((m) => (
            <li key={m.id} className={`${m.dead ? "insp-dead" : ""}${m.id === focusId ? " insp-tooltip-focus" : ""}`}>
              <button type="button" className="insp-tooltip-row" title={`Select ${m.title}`} onClick={() => props.onPick(m.id)}>
                <KindTag kind={m.kind} dead={m.dead} /> <strong>{m.title}</strong>
                {m.self ? <span className="insp-badge insp-badge-info">you</span> : null}
                {m.id === focusId ? <span className="insp-badge insp-badge-info">hovered</span> : null}
                <span className="insp-tooltip-stats">{m.line}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="insp-tooltip-hint">Click a row to select it · move away to close</div>
        {removed.length > 0 ? (
          <div className="insp-tooltip-removed">
            Removed here earlier: {removed.slice(0, 3).map((r) => `${r.id} (${r.reason}, round ${r.round})`).join(", ")}
            {removed.length > 3 ? ` +${removed.length - 3} more` : ""}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
