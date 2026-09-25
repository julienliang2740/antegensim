/**
 * MapView: the plane as an SVG grid (spec U1 "click on a dot and open up who
 * and what is there"; spec "Display and historical inspection": terrain shown
 * distinctly, occupant counts per coordinate, hover quick stats, click selects
 * the point, simple navigation and coordinate lookup, colocated entities never
 * hidden behind overlapping dots).
 *
 * Geometry: world y grows upward (INTERFACES section 3: up = (0, +1)), so the
 * row of the largest y is drawn at the top.  Only the cells inside the
 * viewport are rendered, so large regions stay cheap.  Each occupied cell
 * shows up to four count badges in fixed slots (never overlapping dots):
 * top-left living agents "A", top-right dead agents/plants "✕", bottom-left
 * living plants "P", bottom-right fruit/seed/residue "F"/"S"/"R" ("O" when
 * mixed).  Below BADGE_MIN_CELL_PX a single total-count badge is drawn.
 *
 * The hover tooltip is rendered in a fixed layer on document.body (a portal),
 * beside the hovered cell and clamped to the browser window, so the map
 * viewport's overflow clipping can never cut it (crowded cells are an explicit
 * requirement).  Agent view (`agentViewOverlay`): the map draws only what the
 * selected agent has observed, each entity at the position it was last seen,
 * and the agent itself at its believed position (spec "agent-view overlay
 * shows only permitted information").
 */

import "../../inspect.css";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { Point, RemovedEntity, Terrain } from "../../api/types";
import { pointKey } from "../../api/types";
import { KindTag, NumberInput } from "./common";
import { DEAD_MARK, fmtPoint } from "./format";
import { entityMarkers, groupMarkersByPoint, groupRemovedByPoint, overlayMarkers } from "./logic";
import type { MapMarker } from "./logic";
import type { MapViewProps } from "./props";

/** Cell sizes in px for the zoom buttons. */
const ZOOM_LEVELS = [10, 14, 18, 24, 30, 36, 44, 56, 72, 96];
const DEFAULT_ZOOM_INDEX = 6; // 44 px
/** Below this cell size the four badges collapse into one total-count badge. */
const BADGE_MIN_CELL_PX = 30;
/** At or above this cell size a single living agent's badge shows its id instead of "A". */
const AGENT_ID_MIN_CELL_PX = 56;
/** Space for the axis labels. */
const AXIS_LEFT = 38;
const AXIS_TOP = 20;
/** Default viewport height and the initial width before the first measurement. */
const DEFAULT_HEIGHT = 520;
const DEFAULT_WIDTH = 640;
/** Arrow buttons pan by this many cells. */
const PAN_STEP_CELLS = 3;
/** A pointer that moves less than this between down and up is a click, not a drag. */
const CLICK_SLOP_PX = 4;
/** Hover tooltip: at most this many occupant lines, then "+N more". */
const TOOLTIP_MAX_OCCUPANTS = 8;
const TOOLTIP_WIDTH = 390;
/** Tooltip: distance from the hovered cell and from the window edges. */
const TOOLTIP_GAP = 10;
const TOOLTIP_MARGIN = 8;

interface CellCounts {
  livingAgents: MapMarker[];
  dead: number;
  plants: number;
  other: number;
  otherLetter: string;
  total: number;
}

function countCell(list: MapMarker[]): CellCounts {
  const livingAgents: MapMarker[] = [];
  let dead = 0;
  let plants = 0;
  let other = 0;
  const otherKinds = new Set<string>();
  for (const m of list) {
    if (m.dead) dead += 1;
    else if (m.kind === "agent") livingAgents.push(m);
    else if (m.kind === "plant") plants += 1;
    else {
      other += 1;
      otherKinds.add(m.kind);
    }
  }
  let otherLetter = "O";
  if (otherKinds.size === 1) {
    const only = [...otherKinds][0];
    otherLetter = only === "fruit" ? "F" : only === "seed" ? "S" : "R";
  }
  return { livingAgents, dead, plants, other, otherLetter, total: list.length };
}

function badgeLabel(letter: string, count: number): string {
  return count === 1 ? letter : `${letter}${count}`;
}

export function MapView(props: MapViewProps) {
  const { map, entities, selectedPoint, selectedEntityId, onSelectPoint, onSelectEntity } = props;
  const region = map.region;
  const height = props.heightPx ?? DEFAULT_HEIGHT;
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const overlay = props.agentViewOverlay ?? null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  // Start at the origin, or the nearest point of the region when the region excludes it.
  const [center, setCenter] = useState<Point>(() => ({
    x: Math.min(region.max_x, Math.max(region.min_x, 0)),
    y: Math.min(region.max_y, Math.max(region.min_y, 0)),
  }));
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [goto, setGoto] = useState<Point>({ x: 0, y: 0 });
  const [gotoMessage, setGotoMessage] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; center: Point; moved: boolean; pointerId: number } | null>(null);
  // Where the SVG sits in the browser window (updated on every pointer event): the
  // tooltip is positioned in window coordinates, outside the clipped viewport.
  const svgRect = useRef<{ left: number; top: number }>({ left: 0, top: 0 });

  // Track the container width so the SVG fills the panel.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A fixed-position tooltip would drift from its cell when the page scrolls or the window
  // resizes: hide it until the pointer moves again.
  useEffect(() => {
    if (hoverKey === null) return;
    const clear = () => setHoverKey(null);
    window.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    return () => {
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
    };
  }, [hoverKey]);

  const cellPx = ZOOM_LEVELS[zoomIndex];
  const plotW = Math.max(40, width - AXIS_LEFT);
  const plotH = Math.max(40, height - AXIS_TOP);

  const clampCenter = (p: Point): Point => ({
    x: Math.min(region.max_x, Math.max(region.min_x, p.x)),
    y: Math.min(region.max_y, Math.max(region.min_y, p.y)),
  });

  // World <-> screen.  Cell (x, y) spans [cellLeft(x), cellLeft(x) + cellPx].
  const cellLeft = (x: number) => AXIS_LEFT + plotW / 2 + (x - center.x) * cellPx - cellPx / 2;
  const cellTop = (y: number) => AXIS_TOP + plotH / 2 - (y - center.y) * cellPx - cellPx / 2;
  const cellAt = (px: number, py: number): Point => ({
    x: Math.round(center.x + (px - AXIS_LEFT - plotW / 2) / cellPx),
    y: Math.round(center.y - (py - AXIS_TOP - plotH / 2) / cellPx),
  });

  const halfCols = plotW / 2 / cellPx;
  const halfRows = plotH / 2 / cellPx;
  const viewMinX = Math.floor(center.x - halfCols - 0.5);
  const viewMaxX = Math.ceil(center.x + halfCols + 0.5);
  const viewMinY = Math.floor(center.y - halfRows - 0.5);
  const viewMaxY = Math.ceil(center.y + halfRows + 0.5);
  const isFullyVisible = (p: Point) =>
    cellLeft(p.x) >= AXIS_LEFT && cellLeft(p.x) + cellPx <= AXIS_LEFT + plotW && cellTop(p.y) >= AXIS_TOP && cellTop(p.y) + cellPx <= AXIS_TOP + plotH;

  // Keep an externally changed selection in view (history navigation, "Go to", inspector links).
  const selectedKey = selectedPoint ? pointKey(selectedPoint) : null;
  const [prevSelectedKey, setPrevSelectedKey] = useState<string | null>(null);
  if (selectedKey !== prevSelectedKey) {
    setPrevSelectedKey(selectedKey);
    if (selectedPoint && !isFullyVisible(selectedPoint)) setCenter(clampCenter(selectedPoint));
  }

  // Omniscient: every entity.  Agent view: the agent's sightings and itself (nothing else).
  const markers = useMemo(() => (overlay ? overlayMarkers(overlay) : entityMarkers(entities, props.rules)), [overlay, entities, props.rules]);
  const byPoint = useMemo(() => groupMarkersByPoint(markers), [markers]);
  const removedByPoint = useMemo(() => groupRemovedByPoint(overlay ? [] : (props.removed ?? [])), [overlay, props.removed]);
  const selectedMarker = useMemo(() => markers.find((m) => m.id === selectedEntityId) ?? null, [markers, selectedEntityId]);
  const highlightMarker = useMemo(
    () => (props.highlightAgentId ? (markers.find((m) => m.kind === "agent" && m.id === props.highlightAgentId) ?? null) : null),
    [markers, props.highlightAgentId],
  );

  const inRegion = (p: Point) => p.x >= region.min_x && p.x <= region.max_x && p.y >= region.min_y && p.y <= region.max_y;
  const terrainOf = (p: Point): Terrain | null => (inRegion(p) ? (map.cells[pointKey(p)] ?? "land") : null);

  // ---------------------------------------------------------------- actions
  const zoomTo = (index: number) => setZoomIndex(Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index)));
  const pan = (dx: number, dy: number) => setCenter((c) => clampCenter({ x: c.x + dx, y: c.y + dy }));
  const fitRegion = () => {
    const cols = region.max_x - region.min_x + 1;
    const rows = region.max_y - region.min_y + 1;
    let best = 0;
    ZOOM_LEVELS.forEach((px, i) => {
      if (px * cols <= plotW && px * rows <= plotH) best = i;
    });
    setZoomIndex(best);
    setCenter({ x: (region.min_x + region.max_x) / 2, y: (region.min_y + region.max_y) / 2 });
  };
  const goToPoint = () => {
    if (!inRegion(goto)) {
      setGotoMessage(`${fmtPoint(goto)} is outside the region (x ${region.min_x}..${region.max_x}, y ${region.min_y}..${region.max_y}).`);
      return;
    }
    setGotoMessage(null);
    setCenter(goto);
    onSelectPoint(goto);
  };

  const selectCell = (p: Point) => {
    if (!inRegion(p)) return;
    onSelectPoint(p);
    const occupants = byPoint.get(pointKey(p)) ?? [];
    if (occupants.length === 1) onSelectEntity(occupants[0].id);
  };

  // ---------------------------------------------------------------- pointer handling
  const localXY = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    svgRect.current = { left: rect.left, top: rect.top };
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  };
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, center, moved: false, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d && d.pointerId === e.pointerId) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) >= CLICK_SLOP_PX) d.moved = true;
      if (d.moved) {
        setHoverKey(null);
        setCenter(clampCenter({ x: d.center.x - dx / cellPx, y: d.center.y + dy / cellPx }));
        return;
      }
    }
    const { px, py } = localXY(e);
    if (px < AXIS_LEFT || py < AXIS_TOP) {
      setHoverKey(null);
      return;
    }
    const p = cellAt(px, py);
    const key = inRegion(p) ? pointKey(p) : null;
    if (key !== hoverKey) setHoverKey(key);
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d || d.moved) return;
    const { px, py } = localXY(e);
    if (px < AXIS_LEFT || py < AXIS_TOP) return;
    selectCell(cellAt(px, py));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 5 : 1;
    const handled: Record<string, () => void> = {
      ArrowUp: () => pan(0, step),
      ArrowDown: () => pan(0, -step),
      ArrowLeft: () => pan(-step, 0),
      ArrowRight: () => pan(step, 0),
      "+": () => zoomTo(zoomIndex + 1),
      "=": () => zoomTo(zoomIndex + 1),
      "-": () => zoomTo(zoomIndex - 1),
    };
    const action = handled[e.key];
    if (action) {
      e.preventDefault();
      action();
    }
  };

  // ---------------------------------------------------------------- render cells
  const xs: number[] = [];
  for (let x = Math.max(region.min_x, viewMinX); x <= Math.min(region.max_x, viewMaxX); x++) xs.push(x);
  const ys: number[] = [];
  for (let y = Math.max(region.min_y, viewMinY); y <= Math.min(region.max_y, viewMaxY); y++) ys.push(y);

  const regionLeft = cellLeft(region.min_x);
  const regionTop = cellTop(region.max_y);
  const regionW = (region.max_x - region.min_x + 1) * cellPx;
  const regionH = (region.max_y - region.min_y + 1) * cellPx;

  const terrainCells = [];
  const badgeCells = [];
  for (const y of ys) {
    for (const x of xs) {
      const key = `${x},${y}`;
      const terrain = map.cells[key] ?? "land";
      const left = cellLeft(x);
      const top = cellTop(y);
      terrainCells.push(
        <rect key={key} data-cell={key} data-coord={key} x={left} y={top} width={cellPx} height={cellPx} className={`insp-map-cell insp-t-${terrain}`} />,
      );
      if (terrain !== "land") {
        terrainCells.push(
          <rect key={`${key}-pat`} x={left} y={top} width={cellPx} height={cellPx} fill={`url(#${uid}-${terrain})`} pointerEvents="none" />,
        );
      }
      const occupants = byPoint.get(key);
      if (occupants && occupants.length > 0) {
        badgeCells.push(<CellBadges key={`b-${key}`} left={left} top={top} cellPx={cellPx} counts={countCell(occupants)} />);
      }
      if (showRemoved) {
        const removedHere = removedByPoint.get(key);
        if (removedHere && removedHere.length > 0 && cellPx >= BADGE_MIN_CELL_PX) {
          badgeCells.push(
            <text key={`r-${key}`} x={left + cellPx / 2} y={top + cellPx / 2 + 4} className="insp-map-removed" textAnchor="middle">
              ∅{removedHere.length}
            </text>,
          );
        }
      }
    }
  }

  // Axis labels, thinned so they never overlap.
  const xStride = Math.max(1, Math.ceil(26 / cellPx));
  const yStride = Math.max(1, Math.ceil(16 / cellPx));
  const xLabels = xs.filter((x) => x % xStride === 0 && cellLeft(x) + cellPx / 2 >= AXIS_LEFT + 8);
  const yLabels = ys.filter((y) => y % yStride === 0 && cellTop(y) + cellPx / 2 >= AXIS_TOP + 8);

  const outline = (p: Point | null, cls: string, inset: number, key: string) =>
    p && inRegion(p) ? (
      <rect key={key} x={cellLeft(p.x) + inset} y={cellTop(p.y) + inset} width={cellPx - 2 * inset} height={cellPx - 2 * inset} className={cls} />
    ) : null;

  const hoverPoint = hoverKey ? { x: parseInt(hoverKey.split(",")[0], 10), y: parseInt(hoverKey.split(",")[1], 10) } : null;
  const selectedMarkerPoint = selectedMarker && (!selectedPoint || pointKey(selectedMarker.position) !== selectedKey) ? selectedMarker.position : null;
  const hoverOccupants = byPoint.get(hoverKey ?? "") ?? [];
  const hoverRemoved = removedByPoint.get(hoverKey ?? "") ?? [];
  const tooltipShown = hoverPoint !== null && (hoverOccupants.length > 0 || hoverRemoved.length > 0);

  return (
    <div className="insp insp-mapview">
      <div className="insp-map-toolbar" role="toolbar" aria-label="Map navigation">
        <span className="insp-btn-group" aria-label="Pan">
          <button type="button" className="insp-btn" onClick={() => pan(-PAN_STEP_CELLS, 0)} title="Pan left (arrow key)">
            ◀ Left
          </button>
          <button type="button" className="insp-btn" onClick={() => pan(0, PAN_STEP_CELLS)} title="Pan up (+y)">
            ▲ Up
          </button>
          <button type="button" className="insp-btn" onClick={() => pan(0, -PAN_STEP_CELLS)} title="Pan down (-y)">
            ▼ Down
          </button>
          <button type="button" className="insp-btn" onClick={() => pan(PAN_STEP_CELLS, 0)} title="Pan right">
            Right ▶
          </button>
        </span>
        <span className="insp-btn-group" aria-label="Zoom">
          <button type="button" className="insp-btn" onClick={() => zoomTo(zoomIndex + 1)} disabled={zoomIndex >= ZOOM_LEVELS.length - 1}>
            Zoom in +
          </button>
          <button type="button" className="insp-btn" onClick={() => zoomTo(zoomIndex - 1)} disabled={zoomIndex <= 0}>
            Zoom out −
          </button>
          <button type="button" className="insp-btn" onClick={fitRegion} title="Show the whole region">
            Fit map
          </button>
          <button type="button" className="insp-btn" onClick={() => setCenter(clampCenter({ x: 0, y: 0 }))}>
            Center (0, 0)
          </button>
          <button
            type="button"
            className="insp-btn"
            disabled={!selectedPoint}
            onClick={() => selectedPoint && setCenter(clampCenter(selectedPoint))}
          >
            Center selection
          </button>
        </span>
        <form
          className="insp-goto"
          onSubmit={(e) => {
            e.preventDefault();
            goToPoint();
          }}
        >
          <span>Go to</span>
          <label>
            x <NumberInput integer value={goto.x} ariaLabel="Go to x" onChange={(x) => setGoto((g) => ({ ...g, x }))} className="insp-num-short" />
          </label>
          <label>
            y <NumberInput integer value={goto.y} ariaLabel="Go to y" onChange={(y) => setGoto((g) => ({ ...g, y }))} className="insp-num-short" />
          </label>
          <button type="submit" className="insp-btn insp-btn-primary">
            Go
          </button>
        </form>
      </div>
      {gotoMessage ? <div className="insp-error-text">{gotoMessage}</div> : null}
      {overlay ? (
        <div className="insp-banner insp-banner-agentview insp-map-agentview-note">
          <strong>Agent view: only what {overlay.agentName} ({overlay.agentId}) has observed.</strong> Each entity is drawn where {overlay.agentId} last saw it
          (its records name the round); {overlay.agentId} itself is drawn at its believed position
          {overlay.believedPosition ? "" : " (unknown: nothing disclosed yet, so it is not drawn)"}. True positions, values and unobserved entities are hidden.
        </div>
      ) : props.agentView ? (
        <div className="insp-banner insp-banner-warn insp-map-agentview-note">
          Agent view is on, but no agent is selected (or its knowledge is still loading), so the map shows everything. Select an agent to see only what it has observed.
        </div>
      ) : null}

      <div
        ref={containerRef}
        className="insp-map-viewport"
        style={{ height }}
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label="World map. Drag or use arrow keys to pan, + and - to zoom, click a cell to select it."
      >
        <svg
          width={width}
          height={height}
          className="insp-map-svg"
          role="img"
          aria-label={`Map of region x ${region.min_x}..${region.max_x}, y ${region.min_y}..${region.max_y}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (drag.current = null)}
          onPointerLeave={() => {
            if (!drag.current) setHoverKey(null);
          }}
        >
          <defs>
            <clipPath id={`${uid}-plot`}>
              <rect x={AXIS_LEFT} y={AXIS_TOP} width={plotW} height={plotH} />
            </clipPath>
            <pattern id={`${uid}-mountain`} patternUnits="userSpaceOnUse" width={8} height={8}>
              <path d="M-2,2 l4,-4 M0,8 l8,-8 M6,10 l4,-4" className="insp-pat-mountain" />
            </pattern>
            <pattern id={`${uid}-water`} patternUnits="userSpaceOnUse" width={12} height={8}>
              <path d="M0,5 q3,-3 6,0 t6,0" className="insp-pat-water" fill="none" />
            </pattern>
          </defs>
          <rect x={AXIS_LEFT} y={AXIS_TOP} width={plotW} height={plotH} className="insp-map-outside" />
          <g clipPath={`url(#${uid}-plot)`}>
            {terrainCells}
            <rect x={regionLeft} y={regionTop} width={regionW} height={regionH} className="insp-map-region-border" />
            {xs.includes(0) ? (
              <line x1={cellLeft(0) + cellPx / 2} x2={cellLeft(0) + cellPx / 2} y1={regionTop} y2={regionTop + regionH} className="insp-map-originline" />
            ) : null}
            {ys.includes(0) ? (
              <line x1={regionLeft} x2={regionLeft + regionW} y1={cellTop(0) + cellPx / 2} y2={cellTop(0) + cellPx / 2} className="insp-map-originline" />
            ) : null}
            {/* Outlines first so the count badges stay fully readable on top of them. */}
            {outline(highlightMarker ? highlightMarker.position : null, "insp-map-highlight", 1.5, "hl")}
            {outline(selectedMarkerPoint, "insp-map-entity-sel", 2.5, "es")}
            {outline(hoverPoint, "insp-map-hover", 0.75, "hv")}
            {outline(selectedPoint, "insp-map-sel-outer", 1.5, "so")}
            {outline(selectedPoint, "insp-map-sel-inner", 3.5, "si")}
            {badgeCells}
          </g>
          <rect x={0} y={0} width={width} height={AXIS_TOP} className="insp-map-axisband" />
          <rect x={0} y={0} width={AXIS_LEFT} height={height} className="insp-map-axisband" />
          {xLabels.map((x) => (
            <text key={`xl${x}`} x={cellLeft(x) + cellPx / 2} y={AXIS_TOP - 6} textAnchor="middle" className={`insp-map-axis${x === 0 ? " insp-map-axis-zero" : ""}`}>
              {x}
            </text>
          ))}
          {yLabels.map((y) => (
            <text key={`yl${y}`} x={AXIS_LEFT - 6} y={cellTop(y) + cellPx / 2 + 4} textAnchor="end" className={`insp-map-axis${y === 0 ? " insp-map-axis-zero" : ""}`}>
              {y}
            </text>
          ))}
          <text x={4} y={13} className="insp-map-axis-title">
            y↑ x→
          </text>
        </svg>
        {tooltipShown && hoverPoint
          ? createPortal(
              <div className="insp insp-tooltip-layer">
                <HoverTooltip
                  point={hoverPoint}
                  terrain={terrainOf(hoverPoint)}
                  occupants={hoverOccupants}
                  removed={hoverRemoved}
                  agentViewOf={overlay ? `${overlay.agentName} (${overlay.agentId})` : null}
                  anchor={{ left: svgRect.current.left + cellLeft(hoverPoint.x), top: svgRect.current.top + cellTop(hoverPoint.y), size: cellPx }}
                />
              </div>,
              document.body,
            )
          : null}
      </div>

      <div className="insp-map-status">
        <span>
          {hoverPoint ? (
            <>
              Hover {fmtPoint(hoverPoint)} {terrainOf(hoverPoint)} · {hoverOccupants.length} {overlay ? "known here" : "occupants"}
            </>
          ) : (
            <>Hover a cell for quick stats; click to list every occupant.</>
          )}
        </span>
        <span>
          Selected: {selectedPoint ? `${fmtPoint(selectedPoint)} ${terrainOf(selectedPoint) ?? "outside region"}` : "none"}
          {selectedMarker ? ` · entity ${selectedMarker.id}` : ""}
        </span>
        {overlay ? null : (
          <label className="insp-small">
            <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> show removed-entity markers (∅n)
          </label>
        )}
      </div>
      <MapLegend />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

function CellBadges(props: { left: number; top: number; cellPx: number; counts: CellCounts }) {
  const { left, top, cellPx, counts } = props;
  if (cellPx < BADGE_MIN_CELL_PX) {
    const r = Math.max(4, cellPx * 0.36);
    const hasAgent = counts.livingAgents.length > 0;
    return (
      <g pointerEvents="none">
        <circle cx={left + cellPx / 2} cy={top + cellPx / 2} r={r} className={hasAgent ? "insp-badge-agent" : "insp-badge-total"} />
        {cellPx >= 14 ? (
          <text x={left + cellPx / 2} y={top + cellPx / 2 + r * 0.4} textAnchor="middle" className="insp-badge-text" style={{ fontSize: r * 1.15 }}>
            {counts.total}
          </text>
        ) : null}
      </g>
    );
  }
  const half = cellPx / 2;
  const fontSize = Math.min(17, Math.max(10, cellPx * 0.28));
  const badgeH = Math.min(half - 3, fontSize + 6);
  const slots: { dx: number; dy: number; label: string; cls: string }[] = [];
  const agentCount = counts.livingAgents.length;
  if (agentCount > 0) {
    const label = agentCount === 1 && cellPx >= AGENT_ID_MIN_CELL_PX ? counts.livingAgents[0].id : badgeLabel("A", agentCount);
    slots.push({ dx: 0, dy: 0, label, cls: "insp-badge-agent" });
  }
  if (counts.dead > 0) slots.push({ dx: half, dy: 0, label: badgeLabel(DEAD_MARK, counts.dead), cls: "insp-badge-dead" });
  if (counts.plants > 0) slots.push({ dx: 0, dy: half, label: badgeLabel("P", counts.plants), cls: "insp-badge-plant" });
  if (counts.other > 0) slots.push({ dx: half, dy: half, label: badgeLabel(counts.otherLetter, counts.other), cls: "insp-badge-other" });
  return (
    <g pointerEvents="none">
      {slots.map((s, i) => {
        const maxW = s.dx === 0 && s.label.length > 3 ? cellPx - 3 : half - 2;
        const textW = s.label.length * fontSize * 0.62 + 6;
        const w = Math.min(maxW, Math.max(badgeH, textW));
        // Squeeze the glyphs rather than let the label spill out of its badge.
        const squeeze = textW > w ? { textLength: w - 4, lengthAdjust: "spacingAndGlyphs" as const } : {};
        const x = w <= half - 2 ? left + s.dx + (half - w) / 2 : left + s.dx + 1.5;
        const y = top + s.dy + (half - badgeH) / 2;
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={badgeH} rx={badgeH / 2.5} className={s.cls} />
            <text x={x + w / 2} y={y + badgeH / 2 + fontSize * 0.36} textAnchor="middle" className="insp-badge-text" style={{ fontSize }} {...squeeze}>
              {s.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Tooltip (fixed layer on document.body, beside the cell, never clipped)
// ---------------------------------------------------------------------------

interface HoverTooltipProps {
  point: Point;
  terrain: Terrain | null;
  occupants: MapMarker[];
  removed: RemovedEntity[];
  /** Agent view: "Name (id)" of the viewing agent, else null. */
  agentViewOf: string | null;
  /** The hovered cell in window coordinates. */
  anchor: { left: number; top: number; size: number };
}

/**
 * Place the tooltip beside the hovered cell: to its right when there is room, else to
 * its left; only when neither fits (a very narrow window) below or above it.  Always
 * inside the browser window, never over the cell.
 */
function placeTooltip(el: HTMLElement, anchor: { left: number; top: number; size: number }): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left: number;
  if (anchor.left + anchor.size + TOOLTIP_GAP + w <= vw - TOOLTIP_MARGIN) left = anchor.left + anchor.size + TOOLTIP_GAP;
  else if (anchor.left - TOOLTIP_GAP - w >= TOOLTIP_MARGIN) left = anchor.left - TOOLTIP_GAP - w;
  else left = Math.max(TOOLTIP_MARGIN, Math.min(vw - TOOLTIP_MARGIN - w, anchor.left));
  const beside = left >= anchor.left + anchor.size || left + w <= anchor.left;
  let top: number;
  if (beside) top = Math.max(TOOLTIP_MARGIN, Math.min(vh - TOOLTIP_MARGIN - h, anchor.top));
  else if (anchor.top + anchor.size + TOOLTIP_GAP + h <= vh - TOOLTIP_MARGIN) top = anchor.top + anchor.size + TOOLTIP_GAP;
  else top = Math.max(TOOLTIP_MARGIN, anchor.top - TOOLTIP_GAP - h);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function HoverTooltip(props: HoverTooltipProps) {
  const { point, terrain, occupants, removed, anchor } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const shown = occupants.slice(0, TOOLTIP_MAX_OCCUPANTS);
  const more = occupants.length - shown.length;
  // Measured after layout, before paint: the tooltip starts off-screen and is moved into place.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) placeTooltip(el, anchor);
  });
  const width = Math.min(TOOLTIP_WIDTH, Math.max(160, window.innerWidth - 2 * TOOLTIP_MARGIN));
  const maxHeight = Math.max(80, window.innerHeight - 2 * TOOLTIP_MARGIN);
  return (
    <div ref={ref} className="insp-tooltip" style={{ left: -10000, top: 0, width, maxHeight }} role="tooltip">
      <div className="insp-tooltip-head">
        <strong>{fmtPoint(point)}</strong> {terrain ?? "outside region"} ·{" "}
        {props.agentViewOf ? `${occupants.length} known here` : `${occupants.length} ${occupants.length === 1 ? "occupant" : "occupants"}`}
      </div>
      {props.agentViewOf ? <div className="insp-tooltip-agentview">agent view: only what {props.agentViewOf} has observed</div> : null}
      {shown.length === 0 ? <div className="insp-muted">Nobody and nothing here.</div> : null}
      <ul>
        {shown.map((m) => (
          <li key={m.id} className={m.dead ? "insp-dead" : undefined}>
            <KindTag kind={m.kind} dead={m.dead} /> <strong>{m.title}</strong>
            {m.self ? <span className="insp-badge insp-badge-info">you</span> : null}
            <div className="insp-tooltip-stats">{m.line}</div>
          </li>
        ))}
      </ul>
      {more > 0 ? <div className="insp-tooltip-more">+{more} more — click the cell to list all</div> : null}
      {removed.length > 0 ? (
        <div className="insp-tooltip-removed">
          Removed here earlier: {removed.slice(0, 3).map((r) => `${r.id} (${r.reason}, round ${r.round})`).join(", ")}
          {removed.length > 3 ? ` +${removed.length - 3} more` : ""}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function MapLegend() {
  return (
    <div className="insp-legend" aria-label="Map legend">
      <span className="insp-legend-item">
        <span className="insp-swatch insp-swatch-land" /> land
      </span>
      <span className="insp-legend-item">
        <span className="insp-swatch insp-swatch-mountain" /> mountain (impassable)
      </span>
      <span className="insp-legend-item">
        <span className="insp-swatch insp-swatch-water" /> water (no plants)
      </span>
      <span className="insp-legend-item">
        <span className="insp-swatch insp-swatch-outside" /> outside region
      </span>
      <span className="insp-legend-sep" />
      <span className="insp-legend-item">
        <span className="insp-legend-badge insp-badge-agent-bg">A3</span> living agents (count)
      </span>
      <span className="insp-legend-item">
        <span className="insp-legend-badge insp-badge-dead-bg">{DEAD_MARK}</span> dead agent / plant
      </span>
      <span className="insp-legend-item">
        <span className="insp-legend-badge insp-badge-plant-bg">P2</span> living plants
      </span>
      <span className="insp-legend-item">
        <span className="insp-legend-badge insp-badge-other-bg">F</span> fruit · <b>S</b> seed · <b>R</b> residue · <b>O</b> mixed
      </span>
      <span className="insp-legend-item">
        <span className="insp-legend-badge insp-badge-total-bg">5</span> zoomed out: occupants in the cell (blue = has a living agent)
      </span>
      <span className="insp-legend-sep" />
      <span className="insp-legend-item">
        <span className="insp-swatch insp-swatch-selected" /> selected cell
      </span>
      <span className="insp-legend-item">
        <span className="insp-swatch insp-swatch-highlight" /> acting / highlighted agent
      </span>
    </div>
  );
}
