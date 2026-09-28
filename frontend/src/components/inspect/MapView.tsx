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
 * residue purple), laid out on a grid inside the cell (mapDots.ts).  Every
 * dot at one zoom level has the same diameter; a crowded cell packs its dots
 * tighter and shows the total in a count badge (clicking the badge pins the
 * cell tooltip); a lone dot carries its id under it from 36 px cells.  Below
 * DOT_MIN_CELL_PX (far mode) a cell is one kind-coloured square tile whose
 * size grows with the count: circles are individuals, squares are groups.
 *
 * Action marks (state/mapIndicators.ts, from the `effects` prop = the viewed
 * turn's turnEffects): a purple badge on the agent that acted naming
 * its action (red when it failed), an arrow along its move, rings on the
 * entities the turn touched, links across cells, the observed cell, a
 * broadcast reach and the amounts moved.  The layer is keyed by `turnId`, so
 * its short entrance animation plays once per turn change.  The status line
 * keeps the caption of the viewed turn visible while the map is hovered.  The acting
 * agent's dot has a dashed ring, which pulses while that agent is deciding
 * (`pendingAgentId`); the selected entity's dot has a thick ring.
 *
 * The hover tooltip is rendered in a fixed layer on document.body (a portal),
 * beside the hovered cell and clamped to the browser window, so the map
 * viewport's overflow clipping can never cut it (crowded cells are an explicit
 * requirement).  Agent view (`agentViewOverlay`): the map draws only what the
 * selected agent has observed, each entity at the position it was last seen,
 * and the agent itself at its believed position (spec "agent-view overlay
 * shows only permitted information"); marks are then the viewer's own badge and
 * arrow only.
 *
 * `fill`: the map takes the height of its container (the run page's centre
 * column) instead of `heightPx`.  On first measurement a small region is
 * zoomed to fit, so a one-cell arena opens large.
 */

import "../../inspect.css";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, Ref, ReactNode } from "react";
import type { Point, RemovedEntity, Terrain } from "../../api/types";
import { pointKey } from "../../api/types";
import { captionFor, findActing, turnMarks } from "../../state/mapIndicators";
import type { Glyph, Mark, TurnMarks } from "../../state/mapIndicators";
import type { TurnEffect } from "../../state/turnEffects";
import { KindTag, NumberInput } from "./common";
import { fmtPoint } from "./format";
import { entityMarkers, groupMarkersByPoint, groupRemovedByPoint, overlayMarkers } from "./logic";
import type { MapMarker } from "./logic";
import { DEFAULT_ZOOM_INDEX, DOT_MIN_CELL_PX, ZOOM_LEVELS, dotKind, dotLabel, dotSpec, hitCell, layoutCell, tileFor } from "./mapDots";
import type { CellBadge, CellDots, Dot, DotKind, GroupTile } from "./mapDots";
import type { MapViewProps } from "./props";

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
/** Only the short gap between the cell and its card gets a handoff window. */
const TOOLTIP_TRANSIT_MS = 120;
/** Tooltip: distance from the hovered cell and from the window edges. */
const TOOLTIP_GAP = 6;
const TOOLTIP_MARGIN = 8;
const EMPTY_EFFECTS: readonly TurnEffect[] = [];

interface Hover {
  key: string;
  /** The dot under the pointer, if any. */
  entityId: string | null;
  /** The pointer is on the cell's count badge. */
  badge: boolean;
}

export function MapView(props: MapViewProps) {
  const { map, entities, selectedPoint, selectedEntityId, onSelectPoint, onSelectEntity } = props;
  const region = map.region;
  const fill = props.fill ?? false;
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const overlay = props.agentViewOverlay ?? null;
  const effects = props.effects ?? EMPTY_EFFECTS;
  const turnId = props.turnId ?? null;
  const pendingAgentId = props.pendingAgentId ?? null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: DEFAULT_WIDTH, height: props.heightPx ?? DEFAULT_HEIGHT, measured: false });
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  // Start at the origin, or the nearest point of the region when the region excludes it.
  const [center, setCenter] = useState<Point>(() => ({
    x: Math.min(region.max_x, Math.max(region.min_x, 0)),
    y: Math.min(region.max_y, Math.max(region.min_y, 0)),
  }));
  const [hover, setHover] = useState<Hover | null>(null);
  // The tooltip follows the hovered occupied cell and closes when the pointer leaves both it and the map.
  const [tip, setTip] = useState<Hover | null>(null);
  const tipDismissTimer = useRef<number | null>(null);
  const tipTransitListener = useRef<((event: PointerEvent) => void) | null>(null);
  /** After a click selected something in this cell, hovering it again does not reopen the tooltip until the pointer leaves the cell. */
  const suppressKey = useRef<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [, setPlaceTick] = useState(0);
  // Entity kinds hidden on the map by the legend toggles (occupant lists and the tooltip stay complete).
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<DotKind>>(() => loadHiddenKinds(props.persistKey));
  useEffect(() => saveHiddenKinds(props.persistKey, hiddenKinds), [props.persistKey, hiddenKinds]);
  // The "Action marks" legend chip (default on).
  const [showMarks, setShowMarks] = useState<boolean>(() => loadShowMarks(props.persistKey));
  useEffect(() => saveShowMarks(props.persistKey, showMarks), [props.persistKey, showMarks]);
  // The legend's "Key" (what dots, badges, rings and colours mean): collapsed by default, so the map keeps its height.
  const [keyOpen, setKeyOpen] = useState<boolean>(() => loadKeyOpen(props.persistKey));
  useEffect(() => saveKeyOpen(props.persistKey, keyOpen), [props.persistKey, keyOpen]);
  /** True while the view is "fit map": a resize of the map column fits the region again. */
  const [fitted, setFitted] = useState(false);
  function cancelTipDismiss() {
    if (tipDismissTimer.current !== null) window.clearTimeout(tipDismissTimer.current);
    tipDismissTimer.current = null;
    if (tipTransitListener.current) document.removeEventListener("pointermove", tipTransitListener.current);
    tipTransitListener.current = null;
  }
  function dismissTipSoon() {
    cancelTipDismiss();
    tipTransitListener.current = (event) => {
      if (!nearTooltip(event.clientX, event.clientY)) closeTip();
    };
    document.addEventListener("pointermove", tipTransitListener.current);
    tipDismissTimer.current = window.setTimeout(() => {
      cancelTipDismiss();
      setTip(null);
    }, TOOLTIP_TRANSIT_MS);
  }
  function closeTip() {
    cancelTipDismiss();
    setTip(null);
  }
  function nearTooltip(clientX: number, clientY: number): boolean {
    const rect = tooltipRef.current?.getBoundingClientRect();
    return !!rect && clientX >= rect.left - 14 && clientX <= rect.right + 14 && clientY >= rect.top - 14 && clientY <= rect.bottom + 14;
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
  useEffect(() => () => cancelTipDismiss(), []);

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

  // Start with the whole region visible. Explicit zoom/pan then keeps the user's framing.
  const [autoFitted, setAutoFitted] = useState(false);
  if (size.measured && !autoFitted) {
    setAutoFitted(true);
    const best = fitIndex(Math.max(40, size.width - AXIS_LEFT), Math.max(40, (fill ? size.height : height) - AXIS_TOP));
    setZoomIndex(best);
    setCenter({ x: (region.min_x + region.max_x) / 2, y: (region.min_y + region.max_y) / 2 });
    setFitted(true);
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

  const clampCenter = useCallback((p: Point): Point => ({
    x: Math.min(region.max_x, Math.max(region.min_x, p.x)),
    y: Math.min(region.max_y, Math.max(region.min_y, p.y)),
  }), [region]);

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
  const inView = (p: Point) => p.x >= viewMinX && p.x <= viewMaxX && p.y >= viewMinY && p.y <= viewMaxY;
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
  // A new selection (on the map, in a list, by "Find") closes the tooltip, unless a count-badge click
  // just pinned it on the cell that is now selected (tip.badge: opened from the badge).
  const selectionKey = `${selectedKey ?? ""}|${selectedEntityId ?? ""}`;
  const [prevSelectionKey, setPrevSelectionKey] = useState(selectionKey);
  if (selectionKey !== prevSelectionKey) {
    setPrevSelectionKey(selectionKey);
    if (tip !== null && !(tip.badge && tip.key === selectedKey)) setTip(null);
  }

  // Omniscient: every entity.  Agent view: the agent's sightings and itself (nothing else).
  const markers = useMemo(() => (overlay ? overlayMarkers(overlay) : entityMarkers(entities, props.rules)), [overlay, entities, props.rules]);
  const byPoint = useMemo(() => groupMarkersByPoint(markers), [markers]);
  const markerById = useMemo(() => new Map(markers.map((m) => [m.id, m] as const)), [markers]);
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
  const pendingMarker = useMemo(
    () => (pendingAgentId ? (markers.find((m) => m.kind === "agent" && m.id === pendingAgentId) ?? null) : null),
    [markers, pendingAgentId],
  );

  // The viewed turn's action marks (mapIndicators.ts): a pure function of the effects and the turn id.
  const actingEffect = useMemo(() => findActing(effects), [effects]);
  const communicationRange = useMemo(() => {
    if (overlay || !actingEffect) return null;
    const agent = entities.find((e) => e.kind === "agent" && e.id === actingEffect.actor);
    return agent && agent.kind === "agent" ? agent.stats.communication_range : null;
  }, [overlay, actingEffect, entities]);
  const marks = useMemo(
    () =>
      turnMarks(effects, turnId ?? "", {
        agentViewOf: overlay ? overlay.agentId : null,
        agentViewAt: overlay ? overlay.believedPosition : null,
        communicationRange,
        positionOf: (id) => markerById.get(id)?.position ?? null,
      }),
    [effects, turnId, overlay, communicationRange, markerById],
  );
  const nameOf = (id: string) => markerById.get(id)?.title ?? id;
  const caption = turnId ? captionFor(effects, turnId, nameOf, pendingAgentId) + (marks.dropped > 0 ? ` · +${marks.dropped} marks not drawn` : "") : null;
  const plainCaption = caption?.replace(/^Turn \S+ · /, "") ?? null;

  const inRegion = (p: Point) => p.x >= region.min_x && p.x <= region.max_x && p.y >= region.min_y && p.y <= region.max_y;
  const terrainOf = (p: Point): Terrain | null => inRegion(p) ? (overlay ? overlay.knownTerrain[pointKey(p)] ?? null : map.cells[pointKey(p)] ?? "land") : null;
  const terrainLabel = (p: Point) => terrainOf(p) ?? (overlay && inRegion(p) ? "unknown" : "outside region");
  /** Entities that keep a dot when a cell overflows: acting, pending, selected, then everything a mark names. */
  const priority = [highlightId, pendingAgentId, selectedEntityId, ...marks.markedIds];
  // Layouts and far-mode tiles are computed once per render (in the cell loop below); the pointer
  // handlers of this render and the marks layer read the same maps, so nothing is laid out twice.
  const layouts = new Map<string, CellDots | null>();
  const tiles = new Map<string, GroupTile | null>();

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

  // Non-passive listener keeps wheel zoom inside the board, anchored under the cursor.
  useEffect(() => {
    const viewport = containerRef.current;
    if (!viewport) return;
    let accumulated = 0;
    let lastZoom = 0;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      accumulated += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? plotH : 1);
      const now = performance.now();
      if (Math.abs(accumulated) < 35 || now - lastZoom < 80) return;
      const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, zoomIndex + (accumulated < 0 ? 1 : -1)));
      accumulated = 0;
      lastZoom = now;
      if (next === zoomIndex) return;
      const box = viewport.getBoundingClientRect();
      const dx = event.clientX - box.left - AXIS_LEFT - plotW / 2;
      const dy = event.clientY - box.top - AXIS_TOP - plotH / 2;
      const scaleDelta = 1 / cellPx - 1 / ZOOM_LEVELS[next];
      setCenter(clampCenter({ x: center.x + dx * scaleDelta, y: center.y - dy * scaleDelta }));
      setZoomIndex(next);
      setFitted(false);
      closeTip();
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [zoomIndex, center.x, center.y, plotW, plotH, cellPx, clampCenter]);

  // ---------------------------------------------------------------- pointer handling
  const localXY = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  };
  /** The cell and the dot or count badge under a pointer position (null outside the plot or the region). */
  const hitTest = (px: number, py: number): { point: Point; key: string; dot: Dot | null; badge: CellBadge | null } | null => {
    if (px < AXIS_LEFT || py < AXIS_TOP) return null;
    const point = cellAt(px, py);
    if (!inRegion(point)) return null;
    const key = pointKey(point);
    const hit = hitCell(layouts.get(key) ?? null, px - cellLeft(point.x), py - cellTop(point.y));
    return { point, key, dot: hit?.kind === "dot" ? hit.dot : null, badge: hit?.kind === "badge" ? hit.badge : null };
  };
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    drag.current ={ x: e.clientX, y: e.clientY, center, moved: false, pointerId: e.pointerId };
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
    const next: Hover | null = hit ? { key: hit.key, entityId: hit.dot?.marker.id ?? null, badge: hit.badge !== null } : null;
    if (next?.key !== hover?.key || next?.entityId !== hover?.entityId || next?.badge !== hover?.badge) setHover(next);
    if (tip && nearTooltip(e.clientX, e.clientY)) {
      cancelTipDismiss();
      return;
    }
    if (next) followTip(next);
    else closeTip();
  };
  /** Follow the occupied cell immediately; empty cells dismiss the old card. */
  const followTip = (next: Hover | null) => {
    if (next === null) return;
    cancelTipDismiss();
    if (suppressKey.current !== null) {
      if (suppressKey.current === next.key) return;
      suppressKey.current = null;
    }
    const hasContent = (byPoint.get(next.key)?.length ?? 0) > 0 || (removedByPoint.get(next.key)?.length ?? 0) > 0;
    if (!hasContent) {
      closeTip();
      return;
    }
    if (tip?.key !== next.key || tip.entityId !== next.entityId || tip.badge !== next.badge) setTip(next);
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d || d.moved) return;
    const { px, py } = localXY(e);
    const hit = hitTest(px, py);
    if (!hit) return;
    if (hit.badge) {
      // The count badge: select the cell and pin its tooltip, so every occupant is one click away.
      suppressKey.current = null;
      setTip({ key: hit.key, entityId: null, badge: true });
      if (inRegion(hit.point)) onSelectPoint(hit.point);
      return;
    }
    closeTip();
    suppressKey.current = hit.key;
    selectCell(hit.point, hit.dot?.marker.id ?? null);
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

  // With dots the acting agent carries its own ring; the dashed cell outline is kept for far-mode cells.
  const dotsShown = cellPx >= DOT_MIN_CELL_PX;
  const farMode = !dotsShown;
  const terrainCells = [];
  const occupantCells = [];
  let packedCells = 0;
  /** Packed cells whose dots do not all fit even packed (the badge shows the total). */
  let overCells = 0;
  for (const y of ys) {
    for (const x of xs) {
      const key = `${x},${y}`;
      const terrain = overlay ? overlay.knownTerrain[key] ?? null : map.cells[key] ?? "land";
      const left = cellLeft(x);
      const top = cellTop(y);
      terrainCells.push(
        <rect key={key} data-cell={key} data-coord={key} x={left} y={top} width={cellPx} height={cellPx} className={`insp-map-cell insp-t-${terrain ?? "fog"}`} />,
      );
      if (terrain === "mountain" || terrain === "water") {
        terrainCells.push(
          <rect key={`${key}-pat`} x={left} y={top} width={cellPx} height={cellPx} fill={`url(#${uid}-${terrain})`} pointerEvents="none" />,
        );
      }
      const occupants = drawnByPoint.get(key);
      if (occupants && occupants.length > 0) {
        if (dotsShown) {
          const layout = layoutCell(occupants, cellPx, priority);
          layouts.set(key, layout);
          if (layout) {
            if (layout.mode !== "roomy") packedCells += 1;
            if (layout.mode === "over") overCells += 1;
            occupantCells.push(
              <CellDotsView
                key={`d-${key}`}
                left={left}
                top={top}
                layout={layout}
                actingId={highlightId}
                pendingId={pendingAgentId}
                selectedId={selectedEntityId}
                hoverId={hover?.key === key ? hover.entityId : null}
              />,
            );
          }
        } else {
          const tile = tileFor(occupants, cellPx);
          tiles.set(key, tile);
          if (tile) occupantCells.push(<GroupTileView key={`d-${key}`} left={left} top={top} cellPx={cellPx} tile={tile} />);
        }
      }
      if (showRemoved) {
        const removedHere = removedByPoint.get(key);
        if (removedHere && removedHere.length > 0 && cellPx >= 30) {
          occupantCells.push(
            <text key={`r-${key}`} x={left + 3} y={top + cellPx - 3} className="insp-map-removed" textAnchor="start">
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
  const zoomOutLimit = zoomIndex <= 0;
  const zoomInLimit = zoomIndex >= ZOOM_LEVELS.length - 1;
  const highlightPending = highlightMarker !== null && pendingMarker !== null && highlightMarker.id === pendingMarker.id;
  const badgeMark = marks.marks.find((m): m is Extract<Mark, { type: "badge" }> => m.type === "badge") ?? null;
  const cellsWord = (n: number) => `${n} ${n === 1 ? "cell" : "cells"}`;
  // Zooming in spreads packed dots, except at the last zoom level: there the count badge is the way to
  // everyone.  The status line is one short line; the hint's title says it in full.
  const packedHint: { text: string; title: string } | null =
    packedCells === 0
      ? null
      : !zoomInLimit
        ? { text: `${cellsWord(packedCells)} packed: zoom in to spread the dots`, title: "Zoom in (+) to spread the dots of the packed cells; the count badge shows each cell's total" }
        : overCells > 0
          ? { text: `${cellsWord(overCells)} over capacity: click the count`, title: "At the largest zoom some cells hold more than fit: the count badge shows the total, click it to list every occupant" }
          : { text: `${cellsWord(packedCells)} packed: click the count`, title: "The count badge shows the cell's total; click it to list every occupant" };

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
          <button type="button" className="insp-btn insp-btn-icon" onClick={() => zoomTo(zoomIndex + 1)} disabled={zoomInLimit} aria-label="Zoom in" title="Zoom in (+): crowded cells spread their dots">
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
          <strong>{overlay.agentName} ({overlay.agentId})'s view.</strong> Dark cells have no observed terrain. Known entities appear where {overlay.agentId} last saw them;
          {" "}{overlay.agentId} itself appears at its believed position
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
        aria-label="World map. Drag or use arrow keys to pan, scroll or use + and - to zoom, click a cell or a dot to select it."
      >
        <svg
          ref={svgRef}
          width={width}
          height={height}
          className={`insp-map-svg${hover?.entityId || hover?.badge ? " insp-map-svg-dot" : ""}`}
          role="img"
          aria-label={`Map of region x ${region.min_x}..${region.max_x}, y ${region.min_y}..${region.max_y}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (drag.current = null)}
          onPointerLeave={(e) => {
            if (!drag.current) setHover(null);
            if (nearTooltip(e.clientX, e.clientY)) dismissTipSoon();
            else closeTip();
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
            <marker id={`${uid}-arrowhead`} markerWidth={4} markerHeight={4} refX={3.5} refY={2} orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L4,2 L0,4 z" className="insp-mark-arrowhead" />
            </marker>
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
            {dotsShown ? null : outline(highlightMarker ? highlightMarker.position : null, `insp-map-highlight${highlightPending ? " insp-ring-pending" : ""}`, 1.5, "hl")}
            {dotsShown || highlightPending ? null : outline(pendingMarker ? pendingMarker.position : null, "insp-map-highlight insp-ring-pending", 1.5, "pd")}
            {dotsShown ? null : outline(selectedMarkerPoint, "insp-map-entity-sel", 2.5, "es")}
            {outline(hoverPoint, "insp-map-hover", 0.75, "hv")}
            {outline(selectedPoint, "insp-map-sel-outer", 1.5, "so")}
            {outline(selectedPoint, "insp-map-sel-inner", 3.5, "si")}
            {occupantCells}
            {showMarks && turnId ? (
              <g key={`${turnId}:${props.replayToken ?? 0}`} style={{ "--turn-motion-ms": `${props.replayDurationMs ?? 900}ms` } as CSSProperties} className="insp-marks" data-turn-id={turnId} data-kind={marks.kind} data-action={badgeMark?.glyph ?? ""} pointerEvents="none">
                <TurnMotion
                  effects={overlay ? effects.filter((effect) => effect.actor === overlay.agentId && effect.kind === "move") : effects}
                  cellPx={cellPx} cellLeft={cellLeft} cellTop={cellTop} layouts={layouts}
                />
                <MarksLayer
                  marks={marks}
                  action={actingEffect}
                  cellPx={cellPx}
                  farMode={farMode}
                  uid={uid}
                  cellLeft={cellLeft}
                  cellTop={cellTop}
                  layouts={layouts}
                  tiles={tiles}
                  inView={inView}
                  plotW={plotW}
                  plotH={plotH}
                />
              </g>
            ) : null}
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
                  onEnter={cancelTipDismiss}
                  onLeave={closeTip}
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

      {/* Fixed-height lines keep the turn explanation visible while hover details change. */}
      <div className="insp-map-status">
        <div className="insp-map-status-line insp-map-status-action" data-turn-id={turnId ?? undefined} title={caption ?? undefined}>
          <strong>This turn:</strong> {plainCaption ?? "No saved action yet"}
        </div>
        <div
          className="insp-map-status-line insp-map-status-hover"
          title="Hover a dot or cell for quick stats; click a dot to select that entity, a cell to list everything there, a count badge to list a packed cell."
        >
          {hoverPoint ? (
            hoverMarker ? (
              <>
                Dot <strong>{hoverMarker.title}</strong> at {fmtPoint(hoverPoint)}: click to select it.
              </>
            ) : (
              <>
                Cell {fmtPoint(hoverPoint)} {terrainLabel(hoverPoint)} · {hoverOccupants.length} {overlay ? "known here" : "occupants"}
                {hover?.badge ? " · click the count to list every occupant" : ""}
              </>
            )
          ) : <>Hover a dot or cell to see what is there.</>}
        </div>
        <div className="insp-map-status-line insp-map-status-row">
          <span className="insp-map-status-item">
            Selected: {selectedPoint ? `${fmtPoint(selectedPoint)} ${terrainLabel(selectedPoint)}` : "none"}
            {selectedMarker ? ` · ${selectedMarker.title}` : ""}
          </span>
          {packedHint ? (
            <span className="insp-map-status-item insp-map-zoomhint" title={packedHint.title}>
              {packedHint.text}
            </span>
          ) : null}
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
        showMarks={showMarks}
        onToggleMarks={() => setShowMarks((on) => !on)}
        keyOpen={keyOpen}
        onToggleKey={() => setKeyOpen((open) => !open)}
        extra={props.legendExtra}
      />
    </div>
  );
}

/** Short visual cues anchored to recorded actors/targets; never predicts simulation outcomes. */
function TurnMotion(props: {
  effects: readonly TurnEffect[];
  cellPx: number;
  cellLeft(x: number): number;
  cellTop(y: number): number;
  layouts: ReadonlyMap<string, CellDots | null>;
}) {
  const anchor = (point: Point, id?: string) => {
    const dot = props.layouts.get(pointKey(point))?.dots.find((entry) => entry.marker.id === id);
    return { x: props.cellLeft(point.x) + (dot?.cx ?? props.cellPx / 2), y: props.cellTop(point.y) + (dot?.cy ?? props.cellPx / 2) };
  };
  const radius = Math.max(5, Math.min(13, props.cellPx * 0.2));
  return <g className="turn-motion" aria-hidden="true">{props.effects.slice(0, 24).map((effect, index) => {
    if (!effect.at) return null;
    const sourcePoint = effect.kind === "move" && effect.ok ? effect.from ?? effect.at : effect.at;
    let source = anchor(sourcePoint, effect.kind === "move" ? undefined : effect.actor);
    let target = anchor(effect.kind === "move" ? effect.to ?? effect.at : effect.targetPoints[0] ?? effect.to ?? effect.at, effect.targets[0]);
    if (effect.kind === "absorb") [source, target] = [target, source];
    const colour = !effect.ok || effect.kind === "attack" || effect.kind === "starvation" ? "bad"
      : ["recover", "growth", "fruit", "seed", "germination"].includes(effect.kind) ? "good"
      : ["absorb", "transfer", "upgrade"].includes(effect.kind) ? "resource" : "accent";
    const travelling = effect.ok && ["move", "attack", "message", "transfer", "absorb", "query"].includes(effect.kind);
    const end = effect.kind === "attack" || effect.kind === "starvation" ? target : source;
    const style = { "--cue-x": `${target.x - source.x}px`, "--cue-y": `${target.y - source.y}px` } as CSSProperties;
    return <g key={index} className={`turn-cue turn-cue-${colour}`} data-effect-kind={effect.kind} data-ok={effect.ok}>
      {travelling ? <>
        <line className="turn-cue-trail" x1={source.x} y1={source.y} x2={target.x} y2={target.y} pathLength={1} />
        <g transform={`translate(${source.x} ${source.y})`}><g className="turn-cue-travel" style={style}>
          {effect.kind === "message" ? <path d="M-6,-4 H6 V4 H-6 Z M-6,-4 L0,1 L6,-4" />
            : <circle r={effect.kind === "attack" ? 4 : 3} className="turn-cue-particle" />}
        </g></g>
      </> : null}
      <g transform={`translate(${end.x} ${end.y})`}><g className="turn-cue-impact">
        <circle r={radius} className="turn-cue-halo" />
        {!effect.ok ? <path d="M-5,-5 L5,5 M5,-5 L-5,5" />
          : effect.kind === "attack" ? <path d="M-8,0 L-4,-2 L-6,-7 L0,-4 L5,-8 L4,-2 L9,1 L4,3 L6,8 L0,5 L-5,8 L-4,3 Z" />
          : effect.kind === "wait" ? <path d="M-5,-6 H5 M-5,6 H5 M-4,-6 L4,6 M4,-6 L-4,6" />
          : effect.kind === "recover" ? <path d="M0,-6 V6 M-6,0 H6" />
          : effect.kind === "upgrade" ? <path d="M-5,1 L0,-5 L5,1 M0,-5 V7" />
          : effect.kind === "observe" || effect.kind === "query" ? <><ellipse rx={7} ry={4} /><circle r={2} /></>
          : effect.kind === "death" ? <path d="M-5,-5 L5,5 M5,-5 L-5,5" />
          : effect.kind === "skill" ? <path d="M-5,-5 L0,0 L-5,5 M1,5 H6" />
          : null}
      </g></g>
    </g>;
  })}</g>;
}

// ---------------------------------------------------------------------------
// Dots
// ---------------------------------------------------------------------------

function CellDotsView(props: { left: number; top: number; layout: CellDots; actingId: string | null; pendingId: string | null; selectedId: string | null; hoverId: string | null }) {
  const { left, top, layout } = props;
  return (
    <g pointerEvents="none" transform={`translate(${left} ${top})`}>
      {layout.dots.map((d) => (
        <EntityDot
          key={d.marker.id}
          dot={d}
          acting={d.marker.id === props.actingId}
          pending={d.marker.id === props.pendingId}
          selected={d.marker.id === props.selectedId}
          hovered={d.marker.id === props.hoverId}
          label={layout.labels === "below" ? dotLabel(d.marker) : null}
          labelY={layout.labelY}
          labelFontSize={layout.labelFontSize}
        />
      ))}
      {layout.badge ? <CountBadge badge={layout.badge} /> : null}
    </g>
  );
}

function EntityDot(props: { dot: Dot; acting: boolean; pending: boolean; selected: boolean; hovered: boolean; label: string | null; labelY: number; labelFontSize: number }) {
  const { dot, acting, pending, selected, hovered, label } = props;
  const { cx, cy, r } = dot;
  const cross = r * 0.5;
  return (
    <g>
      {selected ? <circle cx={cx} cy={cy} r={r + Math.max(3, r * 0.28)} className="insp-dot-ring-selected" /> : null}
      {acting || pending ? <circle cx={cx} cy={cy} r={r + Math.max(2, r * 0.16)} className={`insp-dot-ring-acting${pending ? " insp-ring-pending" : ""}`} /> : null}
      <DotGlyph kind={dot.kind} cx={cx} cy={cy} r={r} className={`insp-dot${hovered ? " insp-dot-hover" : ""}`} />
      {dot.kind === "dead" ? (
        <path d={`M${cx - cross},${cy - cross} L${cx + cross},${cy + cross} M${cx + cross},${cy - cross} L${cx - cross},${cy + cross}`} className="insp-dot-cross" />
      ) : null}
      {label ? (
        <text x={cx} y={props.labelY} textAnchor="middle" className="insp-dot-label-below" style={{ fontSize: props.labelFontSize }}>
          {label}
        </text>
      ) : null}
    </g>
  );
}

/** Entity silhouettes share the dot's existing radius so layout and hit testing stay unchanged. */
function DotGlyph(props: { kind: string; cx: number; cy: number; r: number; className?: string }) {
  const { kind, cx, cy, r, className = "" } = props;
  const transform = `translate(${cx} ${cy}) scale(${r / 4})`;
  const cls = `insp-dot-shape insp-dot-${kind}${className ? ` ${className}` : ""}`;
  if (kind === "plant") return <g transform={transform} className={cls} data-dot-radius={r}><path d="M0,-4 C-1.1,-2.8 -3.6,-2.4 -3.5,-0.7 C-3.4,0.7 -1.8,1.5 -0.4,0.7 C-1.2,2.5 -2.3,3.2 -2.3,3.2 L2.3,3.2 C2.3,3.2 1.2,2.5 0.4,0.7 C1.8,1.5 3.4,0.7 3.5,-0.7 C3.6,-2.4 1.1,-2.8 0,-4 Z" /><path d="M0,0.2 V3.3" className="insp-dot-stem" /></g>;
  if (kind === "fruit") return <path transform={transform} d="M0,-4 C0.5,-3.1 1.3,-3 2,-2.2 L4,0 L0,4 L-4,0 L-2,-2.2 C-1.3,-3 -0.5,-3.1 0,-4 Z" className={cls} data-dot-radius={r} />;
  if (kind === "seed") return <ellipse transform={transform} cx={0} cy={0} rx={2.6} ry={4} className={cls} data-dot-radius={r} />;
  if (kind === "residue") return <path transform={transform} d="M0,-4 L3.3,-1.4 L2.5,2.6 L0,4 L-2.5,2.6 L-3.3,-1.4 Z" className={cls} data-dot-radius={r} />;
  return <circle cx={cx} cy={cy} r={r} className={`${cls} insp-dot-round`} data-dot-radius={r} />;
}

/** The total-occupant count of a packed cell: a pill in the top-right corner, or bare digits in that corner in small cells (no dot sits under either). */
function CountBadge(props: { badge: CellBadge }) {
  const b = props.badge;
  if (b.style === "pill") {
    return (
      <g className="insp-dot-badge" data-count={b.count}>
        <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={b.h / 2} className="insp-dot-badge-bg" />
        <text x={b.x + b.w / 2} y={b.y + b.h / 2 + 0.36 * b.fontSize} textAnchor="middle" className="insp-dot-badge-text" style={{ fontSize: b.fontSize }}>
          {b.text}
        </text>
      </g>
    );
  }
  return (
    <g className="insp-dot-badge" data-count={b.count}>
      <text x={b.x + b.w - 1.25} y={b.y + b.h / 2 + 0.36 * b.fontSize} textAnchor="end" className="insp-dot-badge-text is-bare" style={{ fontSize: b.fontSize }}>
        {b.text}
      </text>
    </g>
  );
}

/** Far mode: one kind-coloured square per occupied cell, bigger with the count, digits from 14 px, a kind bar when mixed. */
function GroupTileView(props: { left: number; top: number; cellPx: number; tile: GroupTile }) {
  const { left, top, cellPx, tile } = props;
  const cx = left + cellPx / 2;
  const cy = top + cellPx / 2;
  const half = tile.side / 2;
  const segments: { kind: DotKind; x: number; w: number }[] = [];
  if (tile.showBar) {
    const total = tile.shares.reduce((sum, s) => sum + s.count, 0);
    const barW = tile.side - 2;
    let x = cx - half + 1;
    tile.shares.forEach((s, i) => {
      const last = i === tile.shares.length - 1;
      const w = last ? Math.max(1, cx + half - 1 - x) : Math.max(1, (barW * s.count) / total);
      segments.push({ kind: s.kind, x, w });
      x += w;
    });
  }
  return (
    <g pointerEvents="none">
      <rect x={cx - half} y={cy - half} width={tile.side} height={tile.side} rx={1.5} className={`insp-tile insp-tile-${tile.kind}`} data-count={tile.count} />
      {segments.map((s) => (
        <rect key={s.kind} x={s.x} y={cy + half - 3} width={s.w} height={2} className={`insp-kbar insp-kbar-${s.kind}`} />
      ))}
      {tile.showCount ? (
        <text x={cx} y={cy + 0.36 * tile.fontSize} textAnchor="middle" className="insp-tile-count" style={{ fontSize: tile.fontSize }}>
          {tile.text}
        </text>
      ) : null}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Action marks of the viewed turn (mapIndicators.ts decides what; this draws where)
// ---------------------------------------------------------------------------

interface Anchor {
  x: number;
  y: number;
  r: number;
}

const ACTION_BADGE_WORDS: Record<Glyph, string> = {
  move: "Moved",
  attack: "Attacked",
  message: "Sent message",
  absorb: "Collected resources",
  transfer: "Gave resources",
  recover: "Healed",
  upgrade: "Improved ability",
  wait: "Waited",
  observe: "Looked at cell",
  query: "Checked details",
  skill: "Used a skill",
  none: "No action",
};

function actionBadgeLabel(mark: Extract<Mark, { type: "badge" }>, action: TurnEffect | null): string {
  let text = ACTION_BADGE_WORDS[mark.glyph];
  if (mark.glyph === "message" && action?.broadcast) text = "Broadcast message";
  if (mark.glyph === "observe" && action?.to) text = `Looked at cell (${action.to.x}, ${action.to.y})`;
  if (mark.glyph === "query" && action?.label.includes("own stats")) text = "Checked own stats";
  else if (mark.glyph === "query" && action?.targets[0]) text = `Checked ${action.targets[0]}`;
  return mark.ok ? text : `Failed: ${text.toLowerCase()}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function MarksLayer(props: {
  marks: TurnMarks;
  action: TurnEffect | null;
  cellPx: number;
  farMode: boolean;
  uid: string;
  cellLeft(x: number): number;
  cellTop(y: number): number;
  layouts: ReadonlyMap<string, CellDots | null>;
  tiles: ReadonlyMap<string, GroupTile | null>;
  inView(p: Point): boolean;
  plotW: number;
  plotH: number;
}) {
  const { cellPx: C, farMode, cellLeft, cellTop, layouts, tiles, inView } = props;
  const D = farMode ? Math.max(4, C * 0.6) : dotSpec(C).d;
  const centre = (p: Point) => ({ x: cellLeft(p.x) + C / 2, y: cellTop(p.y) + C / 2 });
  /** Where a mark for entity `id` at cell `point` sits: its dot's centre, else the cell centre (hidden kinds, far mode, unknown ids). */
  const anchorOf = (id: string | null, point: Point): Anchor => {
    const key = pointKey(point);
    const dot = id ? layouts.get(key)?.dots.find((d) => d.marker.id === id) : undefined;
    if (dot) return { x: cellLeft(point.x) + dot.cx, y: cellTop(point.y) + dot.cy, r: dot.r };
    const c = centre(point);
    return { x: c.x, y: c.y, r: farMode ? (tiles.get(key)?.side ?? C - 2) / 2 : D / 2 };
  };
  const badgeMark = props.marks.marks.find((m) => m.type === "badge");
  /** The acting agent's dot: amounts on other entities are printed on the side away from it, clear of its badge. */
  const actorAnchor = badgeMark ? anchorOf(badgeMark.id, badgeMark.at) : null;
  const out = [];
  let i = 0;
  for (const m of props.marks.marks) {
    i += 1;
    const points = m.type === "arrow" || m.type === "link" ? [m.from, m.to] : [m.at];
    if (!points.some(inView)) continue;
    switch (m.type) {
      case "badge": {
        const cls = `insp-mark-badge${m.ok ? "" : " is-failed"}${m.glyph === "none" ? " is-none" : ""}`;
        const a = anchorOf(m.id, m.at);
        const label = actionBadgeLabel(m, props.action);
        const badgeW = Math.min(props.plotW - 8, Math.ceil(label.length * 6.1 + 16));
        const badgeH = 20;
        const x = clamp(a.x - badgeW / 2, AXIS_LEFT + 4, AXIS_LEFT + props.plotW - badgeW - 4);
        const above = a.y - a.r - badgeH - 4;
        const y = above >= AXIS_TOP + 4 ? above : a.y + a.r + 4;
        out.push(
          <g key={i} className={cls} data-actor={m.id} data-action={m.glyph} data-ok={m.ok} aria-label={`${m.id}: ${label}`}>
            <rect x={x} y={y} width={badgeW} height={badgeH} rx={badgeH / 2} />
            <text x={x + badgeW / 2} y={y + 13.5} textAnchor="middle">{label}</text>
          </g>,
        );
        break;
      }
      case "arrow": {
        const strokeWidth = farMode ? 1.5 : clamp(0.06 * C, 2, 4);
        if (m.ok) {
          const A = centre(m.from);
          const anchor = anchorOf(m.id, m.to);
          const dx = anchor.x - A.x;
          const dy = anchor.y - A.y;
          const len = Math.hypot(dx, dy);
          if (len === 0) break;
          const ux = dx / len;
          const uy = dy / len;
          // Far mode (cells below 24 px, no origin circle): from the origin cell's centre to 1 px before the
          // tile, so the line spans about C − r − 1 px instead of the few px the dot-mode offsets leave.
          const start = farMode ? 0 : 0.25 * C;
          const back = farMode ? anchor.r + 1 : anchor.r + 3;
          const x1 = A.x + start * ux;
          const y1 = A.y + start * uy;
          const x2 = anchor.x - back * ux;
          const y2 = anchor.y - back * uy;
          const ghostStyle = { "--dx": `${A.x - anchor.x}px`, "--dy": `${A.y - anchor.y}px` } as unknown as CSSProperties;
          out.push(
            <g key={i} data-actor={m.id}>
              {farMode ? null : <circle className="insp-mark-origin" cx={A.x} cy={A.y} r={D / 2} />}
              <line className="insp-mark-arrow" x1={x1} y1={y1} x2={x2} y2={y2} pathLength={1} strokeWidth={strokeWidth} markerEnd={`url(#${props.uid}-arrowhead)`} />
              {farMode ? null : <circle className="insp-mark-ghost" cx={anchor.x} cy={anchor.y} r={D / 2} style={ghostStyle} />}
            </g>,
          );
        } else {
          // Blocked: a short bar-ended stroke from the agent toward the cell it could not enter.
          const anchor = anchorOf(m.id, m.from);
          const B = centre(m.to);
          const dx = B.x - anchor.x;
          const dy = B.y - anchor.y;
          const len = Math.hypot(dx, dy);
          if (len === 0) break;
          const ux = dx / len;
          const uy = dy / len;
          const x1 = anchor.x + (anchor.r + 2) * ux;
          const y1 = anchor.y + (anchor.r + 2) * uy;
          const x2 = x1 + 0.35 * C * ux;
          const y2 = y1 + 0.35 * C * uy;
          const px = -uy * 0.15 * C;
          const py = ux * 0.15 * C;
          out.push(
            <g key={i} data-actor={m.id}>
              <line className="insp-mark-arrow is-failed" x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={strokeWidth} />
              <line className="insp-mark-arrow is-failed" x1={x2 - px} y1={y2 - py} x2={x2 + px} y2={y2 + py} strokeWidth={strokeWidth} />
            </g>,
          );
        }
        break;
      }
      case "ring": {
        const a = anchorOf(m.id || null, m.at);
        out.push(<circle key={i} className={`insp-mark-ring insp-tone-${m.tone}`} data-entity={m.id} data-tone={m.tone} cx={a.x} cy={a.y} r={a.r + Math.max(2.5, 0.3 * a.r)} />);
        break;
      }
      case "link": {
        const a = anchorOf(m.fromId, m.from);
        const b = anchorOf(m.toId, m.to);
        // A link to a cell (observe) stops at the cell's edge, not at its centre.
        const bR = m.toId === null && !farMode ? C / 2 - 4 : b.r + 2;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len === 0) break;
        const ux = dx / len;
        const uy = dy / len;
        out.push(
          <line
            key={i}
            className={`insp-mark-link insp-tone-${m.tone}${m.dashed ? " is-dashed" : ""}`}
            x1={a.x + (a.r + 2) * ux}
            y1={a.y + (a.r + 2) * uy}
            x2={b.x - bR * ux}
            y2={b.y - bR * uy}
          />,
        );
        break;
      }
      case "cell":
        out.push(<rect key={i} className="insp-mark-cell" x={cellLeft(m.at.x) + 2} y={cellTop(m.at.y) + 2} width={C - 4} height={C - 4} />);
        break;
      case "reach": {
        const span = (m.radiusCells + 0.5) * C;
        if (span > 2 * Math.max(props.plotW, props.plotH)) break;
        const c = centre(m.at);
        out.push(<polygon key={i} className="insp-mark-reach" points={`${c.x + span},${c.y} ${c.x},${c.y + span} ${c.x - span},${c.y} ${c.x},${c.y - span}`} />);
        break;
      }
      case "amount": {
        // Far mode: 11 px numbers on cells under 24 px would smear into a blob over the tiles; the rings
        // still show who was affected and the caption carries the totals.
        if (farMode) break;
        // Top-left of the dot by default (opposite the actor's own badge); on another entity that lies
        // to the right of the actor, top-right instead, so the number never sits on the actor's badge.
        const a = anchorOf(m.id, m.at);
        const right = actorAnchor !== null && m.id !== props.marks.actorId && a.x >= actorAnchor.x;
        out.push(
          <text key={i} className={`insp-mark-amount insp-tone-${m.tone}`} textAnchor={right ? "start" : "end"} x={right ? a.x + 0.4 * D : a.x - 0.4 * D} y={a.y - 0.5 * D - 2}>
            {m.text}
          </text>,
        );
        break;
      }
      default:
        break;
    }
  }
  return <>{out}</>;
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
  onLeave(): void;
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
  const listRef = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    if (!focusId) return;
    listRef.current?.querySelector<HTMLElement>("li.insp-tooltip-focus")?.scrollIntoView({ block: "nearest" });
  }, [focusId]);
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
      onPointerLeave={props.onLeave}
      onKeyDown={(e) => {
        // Keys typed here never pan the map; Escape closes the tooltip.
        e.stopPropagation();
        if (e.key === "Escape") props.onClose();
      }}
    >
      <div className="insp-tooltip-head">
        <span>
          <strong>{fmtPoint(point)}</strong> {terrain ?? (props.agentViewOf ? "unknown" : "outside region")} ·{" "}
          {props.agentViewOf ? `${occupants.length} known here` : `${occupants.length} ${occupants.length === 1 ? "occupant" : "occupants"}`}
        </span>
        <button type="button" className="insp-tooltip-close" aria-label="Close cell details" title="Close (Esc)" onClick={props.onClose}>
          ×
        </button>
      </div>
      {/* The hovered dot is never repeated above the list: its row is highlighted and marked
          "hovered" instead, so every entity appears exactly once. */}
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
      <DotGlyph kind={props.kind} cx={9} cy={9} r={props.ring ? 4.5 : 6} className="insp-dot-sample" />
      {props.dead ? <path d="M6,6 L12,12 M12,6 L6,12" className="insp-dot-cross" /> : null}
    </svg>
  );
}

/** A far-mode group tile (agent blue). */
function LegendTile() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true" className="insp-legend-dot">
      <rect x={0.5} y={0.5} width={13} height={13} rx={1.5} className="insp-tile insp-tile-agent" />
    </svg>
  );
}

/** An example of the acting agent's word badge. */
function LegendBadge() {
  return (
    <svg width={48} height={16} viewBox="0 0 48 16" aria-hidden="true" className="insp-legend-dot insp-mark-badge">
      <rect x={0} y={0} width={48} height={16} rx={8} />
      <text x={24} y={11.5} textAnchor="middle">Moved</text>
    </svg>
  );
}

/** A move: the dashed origin, the arrow, its head. */
function LegendArrow() {
  return (
    <svg width={18} height={10} viewBox="0 0 18 10" aria-hidden="true" className="insp-legend-dot">
      <circle cx={3} cy={5} r={2.5} className="insp-mark-origin" />
      <line x1={6.5} y1={5} x2={12.5} y2={5} className="insp-mark-arrow" strokeWidth={2} />
      <path d="M12,2 L17,5 L12,8 z" className="insp-mark-arrowhead" />
    </svg>
  );
}

/** Six rings in the order the text names them: hit (red), fed (orange), heard (blue), given (green), died (grey), queried (dashed). */
function LegendRings() {
  return (
    <svg width={70} height={12} viewBox="0 0 70 12" aria-hidden="true" className="insp-legend-dot">
      <circle cx={6} cy={6} r={4} className="insp-mark-ring insp-tone-bad" />
      <circle cx={18} cy={6} r={4} className="insp-mark-ring insp-tone-absorb" />
      <circle cx={30} cy={6} r={4} className="insp-mark-ring insp-tone-message" />
      <circle cx={42} cy={6} r={4} className="insp-mark-ring insp-tone-good" />
      <circle cx={54} cy={6} r={4} className="insp-mark-ring insp-tone-dead" />
      <circle cx={66} cy={6} r={4} className="insp-mark-ring insp-tone-query" />
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
const MARKS_STORAGE = "empyrean.map.marks.";
const KEY_STORAGE = "empyrean.map.key.";

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

/** "Action marks" chip: on unless the stored value is "0". */
function loadShowMarks(persistKey: string | undefined): boolean {
  if (!persistKey) return true;
  try {
    return window.localStorage.getItem(MARKS_STORAGE + persistKey) !== "0";
  } catch {
    return true;
  }
}

function saveShowMarks(persistKey: string | undefined, on: boolean): void {
  if (!persistKey) return;
  try {
    window.localStorage.setItem(MARKS_STORAGE + persistKey, on ? "1" : "0");
  } catch {
    // Storage blocked (private window): the chip still works for this page.
  }
}

/** The legend's "Key": collapsed unless the stored value is "1". */
function loadKeyOpen(persistKey: string | undefined): boolean {
  if (!persistKey) return false;
  try {
    return window.localStorage.getItem(KEY_STORAGE + persistKey) === "1";
  } catch {
    return false;
  }
}

function saveKeyOpen(persistKey: string | undefined, open: boolean): void {
  if (!persistKey) return;
  try {
    window.localStorage.setItem(KEY_STORAGE + persistKey, open ? "1" : "0");
  } catch {
    // Storage blocked (private window): the button still works for this page.
  }
}

/**
 * Legend (always shown under the map): one row of controls and a collapsible key.  The entity
 * kinds are toggle chips: ON (boxed in blue) draws that kind on the map, OFF (dimmed, no box)
 * hides its dots and counts; occupant lists and the cell tooltip stay complete.  "Action marks"
 * is a chip of the same kind for the viewed turn's marks.  "Key" opens the explanations
 * (packed cells, group tiles, rings, marks, terrain) under the controls; it is collapsed by
 * default so the map keeps its height, and the status line and tooltip explain on hover.
 * Chips have the same size in both states, so toggling never moves the map.
 */
function MapLegend(props: {
  hidden: ReadonlySet<DotKind>;
  onToggle(kind: DotKind): void;
  onShowAll(): void;
  onHideAll(): void;
  showMarks: boolean;
  onToggleMarks(): void;
  keyOpen: boolean;
  onToggleKey(): void;
  /** Drawn at the end of the controls row (the run page's "Map view" switch). */
  extra?: ReactNode;
}) {
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
      <button
        type="button"
        role="checkbox"
        aria-checked={props.showMarks}
        className={`insp-legend-chip${props.showMarks ? " is-on" : ""}`}
        title={props.showMarks ? "Hide the viewed turn's action marks on the map" : "Show the viewed turn's action marks on the map"}
        onClick={props.onToggleMarks}
      >
        Action marks
      </button>
      <button
        type="button"
        className={`insp-btn insp-btn-small insp-legend-keybtn${props.keyOpen ? " is-open" : ""}`}
        aria-expanded={props.keyOpen}
        title="What the dots, badges, rings and colours mean"
        onClick={props.onToggleKey}
      >
        Key <span aria-hidden="true">{props.keyOpen ? "▴" : "▾"}</span>
      </button>
      {props.extra}
      {props.keyOpen ? (
        <div className="insp-legend-key" role="group" aria-label="Map key">
          <span className="insp-legend-item">
            <span className="insp-legend-badge">14</span> packed: zoom in
          </span>
          <span className="insp-legend-item">
            <LegendTile /> group: bigger = more, blue = agent
          </span>
          <span className="insp-legend-item">
            <LegendDot kind="agent" ring="acting" /> acting · pulses while deciding
          </span>
          <span className="insp-legend-item">
            <LegendDot kind="agent" ring="selected" /> selected
          </span>
          <span className="insp-legend-item">
            <span className="insp-swatch insp-swatch-selected" /> selected cell
          </span>
          <span className="insp-legend-sep" />
          <span className="insp-legend-item">
            <LegendBadge /> the agent's action (red = failed)
          </span>
          <span className="insp-legend-item">
            <LegendArrow /> moved
          </span>
          <span className="insp-legend-item">
            <LegendRings /> hit · fed · heard · given · died · queried
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
      ) : null}
    </div>
  );
}
