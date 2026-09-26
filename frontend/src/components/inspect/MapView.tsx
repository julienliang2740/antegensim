/**
 * MapView: the plane as an SVG grid (spec U1 "click on a dot and open up who
 * and what is there"; spec "Display and historical inspection": terrain shown
 * distinctly, occupant counts per coordinate, hover quick stats, click selects
 * the point, simple navigation and coordinate lookup, colocated entities never
 * hidden behind overlapping dots).
 *
 * Geometry: world y grows upward (INTERFACES section 3: up = (0, +1)), so the
 * row of the largest y is drawn at the top.  Only the cells inside the
 * viewport are rendered, so large regions stay cheap.
 *
 * Occupants: one dot per entity, colour-coded by kind (living agent blue, dead
 * agent or plant grey with an x, plant green, fruit orange, seed brown,
 * residue purple), laid out on a small grid inside the cell (mapDots.ts).
 * When a cell is too small for every dot, the dots that fit are drawn with a
 * "+N" count; zooming in reveals the rest.  The acting agent's dot has a
 * dashed ring, the selected entity's dot a thick ring.  Hovering a dot shows
 * the cell tooltip with that entity's row highlighted; clicking a dot selects
 * the entity (and its cell).  Below DOT_MIN_CELL_PX a cell shows one count.
 *
 * The hover tooltip is rendered in a fixed layer on document.body (a portal),
 * beside the hovered cell and clamped to the browser window, so the map
 * viewport's overflow clipping can never cut it (crowded cells are an explicit
 * requirement).  Agent view (`agentViewOverlay`): the map draws only what the
 * selected agent has observed, each entity at the position it was last seen,
 * and the agent itself at its believed position (spec "agent-view overlay
 * shows only permitted information").
 *
 * `fill`: the map takes the height of its container (the run page's centre
 * column) instead of `heightPx`.  On first measurement a small region is
 * zoomed to fit, so a one-cell arena opens large.
 */

import "../../inspect.css";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, Ref } from "react";
import type { Point, RemovedEntity, Terrain } from "../../api/types";
import { pointKey } from "../../api/types";
import { KindTag, NumberInput } from "./common";
import { fmtPoint } from "./format";
import { entityMarkers, groupMarkersByPoint, groupRemovedByPoint, overlayMarkers } from "./logic";
import type { MapMarker } from "./logic";
import { DOT_LABEL_MIN_PX, DOT_MIN_CELL_PX, dotAt, dotKind, dotLabel, layoutCell } from "./mapDots";
import type { CellDots, Dot, DotKind } from "./mapDots";
import type { MapViewProps } from "./props";

/** Cell sizes in px for the zoom buttons (the last levels fit 16+ entities as large dots). */
const ZOOM_LEVELS = [10, 14, 18, 24, 30, 36, 44, 56, 72, 96, 128, 160, 200, 260, 340];
const DEFAULT_ZOOM_INDEX = 6; // 44 px
/** Space for the axis labels. */
const AXIS_LEFT = 38;
const AXIS_TOP = 20;
/** Default viewport height and the initial size before the first measurement. */
const DEFAULT_HEIGHT = 520;
const DEFAULT_WIDTH = 640;
/** Smallest map height in fill mode. */
const MIN_FILL_HEIGHT = 220;
/** Arrow buttons pan by this many cells. */
const PAN_STEP_CELLS = 3;
/** A pointer that moves less than this between down and up is a click, not a drag. */
const CLICK_SLOP_PX = 4;
const TOOLTIP_WIDTH = 390;
/** Moving onto another cell replaces the tooltip after this delay, so the pointer can cross a neighbouring cell on its way into the tooltip. */
const TOOLTIP_SWITCH_MS = 220;
/** Tooltip: distance from the hovered cell and from the window edges. */
const TOOLTIP_GAP = 6;
const TOOLTIP_MARGIN = 8;

interface Hover {
  key: string;
  /** The dot under the pointer, if any. */
  entityId: string | null;
}

export function MapView(props: MapViewProps) {
  const { map, entities, selectedPoint, selectedEntityId, onSelectPoint, onSelectEntity } = props;
  const region = map.region;
  const fill = props.fill ?? false;
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const overlay = props.agentViewOverlay ?? null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: DEFAULT_WIDTH, height: props.heightPx ?? DEFAULT_HEIGHT, measured: false });
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  // Start at the origin, or the nearest point of the region when the region excludes it.
  const [center, setCenter] = useState<Point>(() => ({
    x: Math.min(region.max_x, Math.max(region.min_x, 0)),
    y: Math.min(region.max_y, Math.max(region.min_y, 0)),
  }));
  const [hover, setHover] = useState<Hover | null>(null);
  // The tooltip's cell: the last hovered occupied cell.  It stays after the pointer leaves the map
  // (so the pointer can move into it and scroll it) until another cell is hovered, Escape, "×", a
  // click outside the map and the tooltip, or a new selection.
  const [tip, setTip] = useState<Hover | null>(null);
  const tipTimer = useRef<number | null>(null);
  /** After a click selected something in this cell, hovering it again does not reopen the tooltip until the pointer leaves the cell. */
  const suppressKey = useRef<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [, setPlaceTick] = useState(0);
  // Entity kinds hidden on the map by the legend toggles (occupant lists and the tooltip stay complete).
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<DotKind>>(() => loadHiddenKinds(props.persistKey));
  useEffect(() => saveHiddenKinds(props.persistKey, hiddenKinds), [props.persistKey, hiddenKinds]);
  /** True while the view is "fit map": a resize of the map column fits the region again. */
  const [fitted, setFitted] = useState(false);
  function cancelTipTimer() {
    if (tipTimer.current !== null) window.clearTimeout(tipTimer.current);
    tipTimer.current = null;
  }
  function closeTip() {
    cancelTipTimer();
    setTip(null);
  }
  const [showRemoved, setShowRemoved] = useState(false);
  const [goto, setGoto] = useState<Point>({ x: 0, y: 0 });
  const [gotoMessage, setGotoMessage] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; center: Point; moved: boolean; pointerId: number } | null>(null);

  // Track the container size so the SVG fills the panel (and, in fill mode, its height).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((observed) => {
      const rect = observed[0].contentRect;
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w <= 0) return;
      setSize((old) => {
        const height = fill ? Math.max(MIN_FILL_HEIGHT, h) : old.height;
        return old.width === w && old.height === height && old.measured ? old : { width: w, height, measured: true };
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fill]);
  const width = size.width;
  const height = fill ? size.height : (props.heightPx ?? DEFAULT_HEIGHT);

  // The tooltip is fixed-positioned beside its cell: follow the cell when the page scrolls or the
  // window resizes (scrolling inside the tooltip itself changes nothing).
  useEffect(() => {
    if (tip === null) return;
    const replace = (e: Event) => {
      if (e.target instanceof Node && tooltipRef.current?.contains(e.target)) return;
      setPlaceTick((n) => n + 1);
    };
    window.addEventListener("scroll", replace, true);
    window.addEventListener("resize", replace);
    return () => {
      window.removeEventListener("scroll", replace, true);
      window.removeEventListener("resize", replace);
    };
  }, [tip]);

  // Dismiss: Escape anywhere, or a press outside both the map and the tooltip.
  useEffect(() => {
    if (tip === null) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") closeTip();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      if (target && (tooltipRef.current?.contains(target) || svgRef.current?.contains(target))) return;
      closeTip();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [tip]);
  useEffect(() => () => cancelTipTimer(), []);

  const cellPx = ZOOM_LEVELS[zoomIndex];
  const plotW = Math.max(40, width - AXIS_LEFT);
  const plotH = Math.max(40, height - AXIS_TOP);

  /** Largest zoom level at which the whole region fits the plot. */
  const fitIndex = (w: number, h: number) => {
    const cols = region.max_x - region.min_x + 1;
    const rows = region.max_y - region.min_y + 1;
    let best = 0;
    ZOOM_LEVELS.forEach((px, i) => {
      if (px * cols <= w && px * rows <= h) best = i;
    });
    return best;
  };

  // First real measurement: a region that fits at the default zoom or larger opens fitted
  // (a small arena fills the map); a large region stays at the default zoom around the origin.
  const [autoFitted, setAutoFitted] = useState(false);
  if (size.measured && !autoFitted) {
    setAutoFitted(true);
    const best = fitIndex(Math.max(40, size.width - AXIS_LEFT), Math.max(40, (fill ? size.height : height) - AXIS_TOP));
    if (best > DEFAULT_ZOOM_INDEX) {
      setZoomIndex(best);
      setCenter({ x: (region.min_x + region.max_x) / 2, y: (region.min_y + region.max_y) / 2 });
      setFitted(true);
    }
  }
  // The map column was resized (window, splitters): a fitted view fits again; any other view keeps its zoom and centre.
  const dims = `${width}x${height}`;
  const [prevDims, setPrevDims] = useState(dims);
  if (dims !== prevDims) {
    setPrevDims(dims);
    if (fitted && autoFitted) {
      setZoomIndex(fitIndex(plotW, plotH));
      setCenter({ x: (region.min_x + region.max_x) / 2, y: (region.min_y + region.max_y) / 2 });
    }
  }

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
    if (selectedPoint && !isFullyVisible(selectedPoint)) {
      setCenter(clampCenter(selectedPoint));
      setFitted(false);
    }
  }
  // A new selection (on the map, in a list, by "Find") closes the tooltip.
  const selectionKey = `${selectedKey ?? ""}|${selectedEntityId ?? ""}`;
  const [prevSelectionKey, setPrevSelectionKey] = useState(selectionKey);
  if (selectionKey !== prevSelectionKey) {
    setPrevSelectionKey(selectionKey);
    if (tip !== null) setTip(null);
  }

  // Omniscient: every entity.  Agent view: the agent's sightings and itself (nothing else).
  const markers = useMemo(() => (overlay ? overlayMarkers(overlay) : entityMarkers(entities, props.rules)), [overlay, entities, props.rules]);
  const byPoint = useMemo(() => groupMarkersByPoint(markers), [markers]);
  // What the map draws: the legend toggles hide whole kinds (dots and counts only).
  const drawnByPoint = useMemo(
    () => (hiddenKinds.size === 0 ? byPoint : groupMarkersByPoint(markers.filter((m) => !hiddenKinds.has(dotKind(m))))),
    [byPoint, markers, hiddenKinds],
  );
  const removedByPoint = useMemo(() => groupRemovedByPoint(overlay ? [] : (props.removed ?? [])), [overlay, props.removed]);
  const selectedMarker = useMemo(() => markers.find((m) => m.id === selectedEntityId) ?? null, [markers, selectedEntityId]);
  const highlightId = props.highlightAgentId ?? null;
  const highlightMarker = useMemo(
    () => (highlightId ? (markers.find((m) => m.kind === "agent" && m.id === highlightId) ?? null) : null),
    [markers, highlightId],
  );

  const inRegion = (p: Point) => p.x >= region.min_x && p.x <= region.max_x && p.y >= region.min_y && p.y <= region.max_y;
  const terrainOf = (p: Point): Terrain | null => (inRegion(p) ? (map.cells[pointKey(p)] ?? "land") : null);
  const priority = [highlightId, selectedEntityId];
  const layoutOf = (key: string): CellDots | null => {
    const list = drawnByPoint.get(key);
    return list && list.length > 0 ? layoutCell(list, cellPx, priority) : null;
  };

  // ---------------------------------------------------------------- actions
  const zoomTo = (index: number) => {
    setZoomIndex(Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index)));
    setFitted(false);
  };
  const pan = (dx: number, dy: number) => {
    setCenter((c) => clampCenter({ x: c.x + dx, y: c.y + dy }));
    setFitted(false);
  };
  const fitRegion = () => {
    setZoomIndex(fitIndex(plotW, plotH));
    setCenter({ x: (region.min_x + region.max_x) / 2, y: (region.min_y + region.max_y) / 2 });
    setFitted(true);
  };
  const goToPoint = () => {
    if (!inRegion(goto)) {
      setGotoMessage(`${fmtPoint(goto)} is outside the region (x ${region.min_x}..${region.max_x}, y ${region.min_y}..${region.max_y}).`);
      return;
    }
    setGotoMessage(null);
    setCenter(goto);
    setFitted(false);
    onSelectPoint(goto);
  };

  /** A click on a cell: select the point; a dot (or a cell with one entity) also selects that entity. */
  const selectCell = (p: Point, dotId: string | null) => {
    if (!inRegion(p)) return;
    onSelectPoint(p);
    const occupants = byPoint.get(pointKey(p)) ?? [];
    if (dotId) onSelectEntity(dotId);
    else if (occupants.length === 1) onSelectEntity(occupants[0].id);
  };

  // ---------------------------------------------------------------- pointer handling
  const localXY = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  };
  /** The cell and the dot under a pointer position (null outside the plot or the region). */
  const hitTest = (px: number, py: number): { point: Point; key: string; dot: Dot | null } | null => {
    if (px < AXIS_LEFT || py < AXIS_TOP) return null;
    const point = cellAt(px, py);
    if (!inRegion(point)) return null;
    const key = pointKey(point);
    const dot = dotAt(layoutOf(key), px - cellLeft(point.x), py - cellTop(point.y));
    return { point, key, dot };
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
        setHover(null);
        setFitted(false);
        setCenter(clampCenter({ x: d.center.x - dx / cellPx, y: d.center.y + dy / cellPx }));
        return;
      }
    }
    const { px, py } = localXY(e);
    const hit = hitTest(px, py);
    const next: Hover | null = hit ? { key: hit.key, entityId: hit.dot?.marker.id ?? null } : null;
    if (next?.key !== hover?.key || next?.entityId !== hover?.entityId) setHover(next);
    followTip(next);
  };
  /** Move the tooltip to the hovered cell: at once from nothing or within the same cell, after a short delay to another cell. */
  const followTip = (next: Hover | null) => {
    if (next === null) return;
    if (suppressKey.current !== null) {
      if (suppressKey.current === next.key) return;
      suppressKey.current = null;
    }
    const hasContent = (byPoint.get(next.key)?.length ?? 0) > 0 || (removedByPoint.get(next.key)?.length ?? 0) > 0;
    if (!hasContent) {
      cancelTipTimer();
      return;
    }
    if (tip === null || tip.key === next.key) {
      cancelTipTimer();
      if (tip?.key !== next.key || tip.entityId !== next.entityId) setTip(next);
      return;
    }
    if (tipTimer.current !== null && tipTimer.current !== undefined) window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => {
      tipTimer.current = null;
      setTip(next);
    }, TOOLTIP_SWITCH_MS);
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d || d.moved) return;
    const { px, py } = localXY(e);
    const hit = hitTest(px, py);
    if (hit) {
      closeTip();
      suppressKey.current = hit.key;
      selectCell(hit.point, hit.dot?.marker.id ?? null);
    }
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
  const occupantCells = [];
  let hiddenAnywhere = false;
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
      const occupants = drawnByPoint.get(key);
      if (occupants && occupants.length > 0) {
        const layout = layoutCell(occupants, cellPx, priority);
        if (layout) {
          if (layout.hidden > 0) hiddenAnywhere = true;
          occupantCells.push(
            <CellDotsView
              key={`d-${key}`}
              left={left}
              top={top}
              layout={layout}
              actingId={highlightId}
              selectedId={selectedEntityId}
              hoverId={hover?.key === key ? hover.entityId : null}
            />,
          );
        } else {
          hiddenAnywhere = hiddenAnywhere || occupants.length > 1;
          occupantCells.push(<AggregateMarker key={`d-${key}`} left={left} top={top} cellPx={cellPx} occupants={occupants} />);
        }
      }
      if (showRemoved) {
        const removedHere = removedByPoint.get(key);
        if (removedHere && removedHere.length > 0 && cellPx >= 30) {
          occupantCells.push(
            <text key={`r-${key}`} x={left + cellPx - 3} y={top + 11} className="insp-map-removed" textAnchor="end">
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

  const keyPoint = (key: string): Point => ({ x: parseInt(key.split(",")[0], 10), y: parseInt(key.split(",")[1], 10) });
  const hoverPoint = hover ? keyPoint(hover.key) : null;
  const selectedMarkerPoint = selectedMarker && (!selectedPoint || pointKey(selectedMarker.position) !== selectedKey) ? selectedMarker.position : null;
  const hoverOccupants = byPoint.get(hover?.key ?? "") ?? [];
  const hoverMarker = hover?.entityId ? (hoverOccupants.find((m) => m.id === hover.entityId) ?? null) : null;
  const tipPoint = tip ? keyPoint(tip.key) : null;
  const tipOccupants = byPoint.get(tip?.key ?? "") ?? [];
  const tipRemoved = removedByPoint.get(tip?.key ?? "") ?? [];
  // Shown while its cell is at least partly inside the plot (panning it away hides it).
  const tipVisible =
    tipPoint !== null &&
    (tipOccupants.length > 0 || tipRemoved.length > 0) &&
    cellLeft(tipPoint.x) + cellPx > AXIS_LEFT &&
    cellLeft(tipPoint.x) < AXIS_LEFT + plotW &&
    cellTop(tipPoint.y) + cellPx > AXIS_TOP &&
    cellTop(tipPoint.y) < AXIS_TOP + plotH;
  const hiddenKindNames = DOT_KINDS.filter((k) => hiddenKinds.has(k.kind)).map((k) => k.label);
  // With dots the acting agent carries its own ring; the dashed cell outline is kept for zoomed-out cells.
  const dotsShown = cellPx >= DOT_MIN_CELL_PX;
  const zoomOutLimit = zoomIndex <= 0;
  const zoomInLimit = zoomIndex >= ZOOM_LEVELS.length - 1;

  return (
    <div className={`insp insp-mapview${fill ? " insp-mapview-fill" : ""}`}>
      <div className="insp-map-toolbar" role="toolbar" aria-label="Map navigation">
        <span className="insp-btn-group" aria-label="Pan">
          <button type="button" className="insp-btn insp-btn-icon" onClick={() => pan(-PAN_STEP_CELLS, 0)} aria-label="Pan left" title="Pan left (arrow keys)">
            ◀
          </button>
          <button type="button" className="insp-btn insp-btn-icon" onClick={() => pan(0, PAN_STEP_CELLS)} aria-label="Pan up" title="Pan up (+y)">
            ▲
          </button>
          <button type="button" className="insp-btn insp-btn-icon" onClick={() => pan(0, -PAN_STEP_CELLS)} aria-label="Pan down" title="Pan down (-y)">
            ▼
          </button>
          <button type="button" className="insp-btn insp-btn-icon" onClick={() => pan(PAN_STEP_CELLS, 0)} aria-label="Pan right" title="Pan right">
            ▶
          </button>
        </span>
        <span className="insp-btn-group" aria-label="Zoom">
          <button type="button" className="insp-btn insp-btn-icon" onClick={() => zoomTo(zoomIndex - 1)} disabled={zoomOutLimit} aria-label="Zoom out" title="Zoom out (-)">
            −
          </button>
          <span className="insp-zoom-level" title="Cell size at this zoom">
            {cellPx} px
          </span>
          <button type="button" className="insp-btn insp-btn-icon" onClick={() => zoomTo(zoomIndex + 1)} disabled={zoomInLimit} aria-label="Zoom in" title="Zoom in (+): crowded cells show every dot">
            +
          </button>
          <button type="button" className="insp-btn" onClick={fitRegion} title="Show the whole region">
            Fit map
          </button>
          <button type="button" className="insp-btn" onClick={() => setCenter(clampCenter({ x: 0, y: 0 }))} title="Center the view on (0, 0)">
            Origin
          </button>
          <button
            type="button"
            className="insp-btn"
            disabled={!selectedPoint}
            onClick={() => selectedPoint && setCenter(clampCenter(selectedPoint))}
            title="Center the view on the selected cell"
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
        style={fill ? undefined : { height }}
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label="World map. Drag or use arrow keys to pan, + and - to zoom, click a cell or a dot to select it."
      >
        <svg
          ref={svgRef}
          width={width}
          height={height}
          className={`insp-map-svg${hover?.entityId ? " insp-map-svg-dot" : ""}`}
          role="img"
          aria-label={`Map of region x ${region.min_x}..${region.max_x}, y ${region.min_y}..${region.max_y}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (drag.current = null)}
          onPointerLeave={() => {
            // The tooltip stays (the pointer may be on its way into it); only the hover outline goes.
            if (!drag.current) setHover(null);
            cancelTipTimer();
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
            {/* Outlines first so the dots stay fully readable on top of them. */}
            {dotsShown ? null : outline(highlightMarker ? highlightMarker.position : null, "insp-map-highlight", 1.5, "hl")}
            {dotsShown ? null : outline(selectedMarkerPoint, "insp-map-entity-sel", 2.5, "es")}
            {outline(hoverPoint, "insp-map-hover", 0.75, "hv")}
            {outline(selectedPoint, "insp-map-sel-outer", 1.5, "so")}
            {outline(selectedPoint, "insp-map-sel-inner", 3.5, "si")}
            {occupantCells}
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
        {tipVisible && tipPoint && tip
          ? createPortal(
              <div className="insp insp-tooltip-layer">
                <HoverTooltip
                  ref={tooltipRef}
                  point={tipPoint}
                  terrain={terrainOf(tipPoint)}
                  occupants={tipOccupants}
                  removed={tipRemoved}
                  focusId={tip.entityId}
                  agentViewOf={overlay ? `${overlay.agentName} (${overlay.agentId})` : null}
                  getAnchor={() => {
                    const box = svgRef.current?.getBoundingClientRect();
                    return { left: (box?.left ?? 0) + cellLeft(tipPoint.x), top: (box?.top ?? 0) + cellTop(tipPoint.y), size: cellPx };
                  }}
                  onEnter={cancelTipTimer}
                  onClose={closeTip}
                  onPick={(id) => {
                    closeTip();
                    onSelectPoint(tipPoint);
                    onSelectEntity(id);
                  }}
                />
              </div>,
              document.body,
            )
          : null}
      </div>

      {/* Two fixed-height single lines (long text is cut with an ellipsis): hovering changes their
          text, never their height, so the map above never moves under the pointer. */}
      <div className="insp-map-status">
        <div className="insp-map-status-line insp-map-status-hover" title="Hover a dot or cell for quick stats; click a dot to select that entity, a cell to list everything there.">
          {hoverPoint ? (
            hoverMarker ? (
              <>
                Dot <strong>{hoverMarker.title}</strong> at {fmtPoint(hoverPoint)}: click to select it.
              </>
            ) : (
              <>
                Cell {fmtPoint(hoverPoint)} {terrainOf(hoverPoint)} · {hoverOccupants.length} {overlay ? "known here" : "occupants"}
              </>
            )
          ) : (
            <>Hover a dot or cell for quick stats; click a dot to select it, a cell to list everything there.</>
          )}
        </div>
        <div className="insp-map-status-line insp-map-status-row">
          <span className="insp-map-status-item">
            Selected: {selectedPoint ? `${fmtPoint(selectedPoint)} ${terrainOf(selectedPoint) ?? "outside region"}` : "none"}
            {selectedMarker ? ` · ${selectedMarker.title}` : ""}
          </span>
          {hiddenAnywhere ? <span className="insp-map-status-item insp-map-zoomhint">Some cells show “+N”: zoom in to see every dot.</span> : null}
          {hiddenKindNames.length > 0 ? <span className="insp-map-status-item insp-map-kindhint">Not drawn: {hiddenKindNames.join(", ")}</span> : null}
          {overlay ? null : (
            <label className="insp-small insp-map-status-item">
              <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> show removed-entity markers (∅n)
            </label>
          )}
        </div>
      </div>
      <MapLegend
        hidden={hiddenKinds}
        onToggle={(kind) =>
          setHiddenKinds((old) => {
            const next = new Set(old);
            if (next.has(kind)) next.delete(kind);
            else next.add(kind);
            return next;
          })
        }
        onShowAll={() => setHiddenKinds(new Set())}
        onHideAll={() => setHiddenKinds(new Set(DOT_KINDS.map((k) => k.kind)))}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dots
// ---------------------------------------------------------------------------

function CellDotsView(props: { left: number; top: number; layout: CellDots; actingId: string | null; selectedId: string | null; hoverId: string | null }) {
  const { left, top, layout } = props;
  return (
    <g pointerEvents="none" transform={`translate(${left} ${top})`}>
      {layout.dots.map((d) => (
        <EntityDot key={d.marker.id} dot={d} acting={d.marker.id === props.actingId} selected={d.marker.id === props.selectedId} hovered={d.marker.id === props.hoverId} />
      ))}
      {layout.more ? (
        <text x={layout.more.x} y={layout.more.y} textAnchor="middle" className="insp-dot-more" style={{ fontSize: layout.more.fontSize }}>
          +{layout.hidden}
        </text>
      ) : null}
    </g>
  );
}

function EntityDot(props: { dot: Dot; acting: boolean; selected: boolean; hovered: boolean }) {
  const { dot, acting, selected, hovered } = props;
  const { cx, cy, r } = dot;
  const diameter = r * 2;
  const cross = r * 0.5;
  const label = diameter >= DOT_LABEL_MIN_PX ? dotLabel(dot.marker) : null;
  const fontSize = Math.min(13, Math.max(8, diameter * (label && label.length > 3 ? 0.3 : 0.36)));
  return (
    <g>
      {selected ? <circle cx={cx} cy={cy} r={r + Math.max(3, r * 0.28)} className="insp-dot-ring-selected" /> : null}
      {acting ? <circle cx={cx} cy={cy} r={r + Math.max(2, r * 0.16)} className="insp-dot-ring-acting" /> : null}
      <circle cx={cx} cy={cy} r={r} className={`insp-dot insp-dot-${dot.kind}${hovered ? " insp-dot-hover" : ""}`} />
      {dot.kind === "dead" ? (
        <path d={`M${cx - cross},${cy - cross} L${cx + cross},${cy + cross} M${cx + cross},${cy - cross} L${cx - cross},${cy + cross}`} className="insp-dot-cross" />
      ) : null}
      {label && dot.kind !== "dead" ? (
        <text x={cx} y={cy + fontSize * 0.36} textAnchor="middle" className="insp-dot-label" style={{ fontSize }}>
          {label}
        </text>
      ) : null}
      {label && dot.kind === "dead" ? (
        <text x={cx} y={cy + r + fontSize + 1} textAnchor="middle" className="insp-dot-label-below" style={{ fontSize: Math.min(11, fontSize) }}>
          {label}
        </text>
      ) : null}
    </g>
  );
}

/** Zoomed far out: one circle with the occupant count (blue when a living agent is there). */
function AggregateMarker(props: { left: number; top: number; cellPx: number; occupants: MapMarker[] }) {
  const { left, top, cellPx, occupants } = props;
  const r = Math.max(3.5, cellPx * 0.36);
  const hasAgent = occupants.some((m) => m.kind === "agent" && !m.dead);
  const single = occupants.length === 1 ? occupants[0] : null;
  const cls = single ? `insp-dot insp-dot-${single.dead ? "dead" : single.kind}` : hasAgent ? "insp-dot insp-dot-agent" : "insp-dot insp-dot-mixed";
  return (
    <g pointerEvents="none">
      <circle cx={left + cellPx / 2} cy={top + cellPx / 2} r={r} className={cls} />
      {occupants.length > 1 && cellPx >= 14 ? (
        <text x={left + cellPx / 2} y={top + cellPx / 2 + r * 0.4} textAnchor="middle" className="insp-dot-label" style={{ fontSize: r * 1.15 }}>
          {occupants.length}
        </text>
      ) : null}
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
  /** The hovered dot's entity: its row is highlighted. */
  focusId: string | null;
  /** Agent view: "Name (id)" of the viewing agent, else null. */
  agentViewOf: string | null;
  /** The tooltip's cell in window coordinates (read at every placement, so it follows pans, scrolls and resizes). */
  getAnchor(): { left: number; top: number; size: number };
  /** The pointer entered the tooltip (a pending switch to another cell is cancelled). */
  onEnter(): void;
  onClose(): void;
  /** Select an occupant listed in the tooltip. */
  onPick(id: string): void;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Place the tooltip beside the hovered cell: to its right when there is room, else to
 * its left; only when neither fits (a very narrow window) below or above it.  Always
 * inside the browser window, never over the cell.  A cell larger than the window
 * leaves no room beside it: the tooltip then sits at the window's right edge.
 */
function placeTooltip(el: HTMLElement, anchor: { left: number; top: number; size: number }): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left: number;
  if (anchor.left + anchor.size + TOOLTIP_GAP + w <= vw - TOOLTIP_MARGIN) left = anchor.left + anchor.size + TOOLTIP_GAP;
  else if (anchor.left - TOOLTIP_GAP - w >= TOOLTIP_MARGIN) left = anchor.left - TOOLTIP_GAP - w;
  else left = Math.max(TOOLTIP_MARGIN, Math.min(vw - TOOLTIP_MARGIN - w, anchor.left + anchor.size - w));
  const beside = left >= anchor.left + anchor.size || left + w <= anchor.left;
  let top: number;
  if (beside) top = Math.max(TOOLTIP_MARGIN, Math.min(vh - TOOLTIP_MARGIN - h, anchor.top));
  else if (anchor.top + anchor.size + TOOLTIP_GAP + h <= vh - TOOLTIP_MARGIN) top = anchor.top + anchor.size + TOOLTIP_GAP;
  else if (anchor.top - TOOLTIP_GAP - h >= TOOLTIP_MARGIN) top = anchor.top - TOOLTIP_GAP - h;
  else top = Math.max(TOOLTIP_MARGIN, Math.min(vh - TOOLTIP_MARGIN - h, anchor.top + TOOLTIP_GAP));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

/**
 * The cell's details beside it: every occupant (scrollable), the hovered dot's row highlighted,
 * rows clickable to select that entity, "×" to close.  Interactive: the pointer can move into it.
 */
function HoverTooltip(props: HoverTooltipProps) {
  const { point, terrain, occupants, removed, focusId } = props;
  const localRef = useRef<HTMLDivElement | null>(null);
  const focus = focusId ? (occupants.find((m) => m.id === focusId) ?? null) : null;
  // Measured after layout, before paint: the tooltip starts off-screen and is moved into place.
  useLayoutEffect(() => {
    const el = localRef.current;
    if (el) placeTooltip(el, props.getAnchor());
  });
  const setRefs = (el: HTMLDivElement | null) => {
    localRef.current = el;
    const outer = props.ref;
    if (typeof outer === "function") outer(el);
    else if (outer) (outer as { current: HTMLDivElement | null }).current = el;
  };
  const width = Math.min(TOOLTIP_WIDTH, Math.max(160, window.innerWidth - 2 * TOOLTIP_MARGIN));
  const maxHeight = Math.max(80, Math.min(560, window.innerHeight * 0.72));
  return (
    <div
      ref={setRefs}
      className="insp-tooltip insp-tooltip-interactive"
      style={{ left: -10000, top: 0, width, maxHeight }}
      role="dialog"
      aria-label={`Cell ${fmtPoint(point)}`}
      onPointerEnter={props.onEnter}
      onKeyDown={(e) => {
        // Keys typed here never pan the map; Escape closes the tooltip.
        e.stopPropagation();
        if (e.key === "Escape") props.onClose();
      }}
    >
      <div className="insp-tooltip-head">
        <span>
          <strong>{fmtPoint(point)}</strong> {terrain ?? "outside region"} ·{" "}
          {props.agentViewOf ? `${occupants.length} known here` : `${occupants.length} ${occupants.length === 1 ? "occupant" : "occupants"}`}
        </span>
        <button type="button" className="insp-tooltip-close" aria-label="Close cell details" title="Close (Esc)" onClick={props.onClose}>
          ×
        </button>
      </div>
      {focus ? (
        <div className="insp-tooltip-focus-head">
          <KindTag kind={focus.kind} dead={focus.dead} /> <strong>{focus.title}</strong>: {focus.line}
        </div>
      ) : null}
      {props.agentViewOf ? <div className="insp-tooltip-agentview">agent view: only what {props.agentViewOf} has observed</div> : null}
      {occupants.length === 0 ? <div className="insp-muted">Nobody and nothing here.</div> : null}
      <ul className="insp-tooltip-rows">
        {occupants.map((m) => (
          <li key={m.id} className={`${m.dead ? "insp-dead" : ""}${m.id === focusId ? " insp-tooltip-focus" : ""}`}>
            <button type="button" className="insp-tooltip-row" title={`Select ${m.title}`} onClick={() => props.onPick(m.id)}>
              <KindTag kind={m.kind} dead={m.dead} /> <strong>{m.title}</strong>
              {m.self ? <span className="insp-badge insp-badge-info">you</span> : null}
              <span className="insp-tooltip-stats">{m.line}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="insp-tooltip-hint">Click a row to select it · Esc or × closes · stays open when the pointer leaves the map</div>
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
// Legend (always shown directly under the map)
// ---------------------------------------------------------------------------

function LegendDot(props: { kind: string; dead?: boolean; ring?: "acting" | "selected" }) {
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden="true" className="insp-legend-dot">
      {props.ring === "selected" ? <circle cx={9} cy={9} r={7.5} className="insp-dot-ring-selected" /> : null}
      {props.ring === "acting" ? <circle cx={9} cy={9} r={7.5} className="insp-dot-ring-acting" /> : null}
      <circle cx={9} cy={9} r={props.ring ? 4.5 : 6} className={`insp-dot insp-dot-${props.kind}`} />
      {props.dead ? <path d="M6,6 L12,12 M12,6 L6,12" className="insp-dot-cross" /> : null}
    </svg>
  );
}

/** The entity kinds of the legend toggles (DotKind order), with their labels. */
const DOT_KINDS: { kind: DotKind; label: string; dead?: boolean }[] = [
  { kind: "agent", label: "living agent" },
  { kind: "dead", label: "dead agent / plant", dead: true },
  { kind: "plant", label: "plant" },
  { kind: "fruit", label: "fruit" },
  { kind: "seed", label: "seed" },
  { kind: "residue", label: "residue" },
];

const HIDDEN_KINDS_STORAGE = "empyrean.map.hiddenKinds.";

function loadHiddenKinds(persistKey: string | undefined): ReadonlySet<DotKind> {
  if (!persistKey) return new Set();
  try {
    const raw = window.localStorage.getItem(HIDDEN_KINDS_STORAGE + persistKey);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    const known = new Set<string>(DOT_KINDS.map((k) => k.kind));
    return new Set(Array.isArray(list) ? (list.filter((k) => typeof k === "string" && known.has(k)) as DotKind[]) : []);
  } catch {
    return new Set();
  }
}

function saveHiddenKinds(persistKey: string | undefined, hidden: ReadonlySet<DotKind>): void {
  if (!persistKey) return;
  try {
    window.localStorage.setItem(HIDDEN_KINDS_STORAGE + persistKey, JSON.stringify([...hidden]));
  } catch {
    // Storage blocked (private window): the toggles still work for this page.
  }
}

/**
 * Legend (always shown under the map).  The entity kinds are toggle chips: ON (boxed in blue)
 * draws that kind on the map, OFF (dimmed, no box) hides its dots and counts; occupant lists
 * and the cell tooltip stay complete.  Rings and terrain are plain legend entries.  Chips have
 * the same size in both states, so toggling never moves the map.
 */
function MapLegend(props: { hidden: ReadonlySet<DotKind>; onToggle(kind: DotKind): void; onShowAll(): void; onHideAll(): void }) {
  return (
    <div className="insp-legend" aria-label="Map legend">
      <span className="insp-legend-title">Show</span>
      {DOT_KINDS.map((k) => {
        const on = !props.hidden.has(k.kind);
        return (
          <button
            key={k.kind}
            type="button"
            role="checkbox"
            aria-checked={on}
            className={`insp-legend-chip${on ? " is-on" : ""}`}
            title={on ? `Hide ${k.label} dots on the map` : `Show ${k.label} dots on the map`}
            onClick={() => props.onToggle(k.kind)}
          >
            <LegendDot kind={k.kind} dead={k.dead} /> {k.label}
          </button>
        );
      })}
      <button type="button" className="insp-btn insp-btn-small" onClick={props.onShowAll} disabled={props.hidden.size === 0}>
        Select all
      </button>
      <button type="button" className="insp-btn insp-btn-small" onClick={props.onHideAll} disabled={props.hidden.size === DOT_KINDS.length}>
        Unselect all
      </button>
      <span className="insp-legend-sep" />
      <span className="insp-legend-item">
        <span className="insp-legend-more">+N</span> more than fit: zoom in
      </span>
      <span className="insp-legend-item">
        <LegendDot kind="agent" ring="acting" /> acting agent
      </span>
      <span className="insp-legend-item">
        <LegendDot kind="agent" ring="selected" /> selected entity
      </span>
      <span className="insp-legend-item">
        <span className="insp-swatch insp-swatch-selected" /> selected cell
      </span>
      <span className="insp-legend-sep" />
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
    </div>
  );
}
