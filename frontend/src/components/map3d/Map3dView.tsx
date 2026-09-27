/**
 * The 3D view of the world: toolbar (frame, top view, focus, layers, replay,
 * animations, controls), the WebGL viewport with its HTML label layer, two
 * fixed-height status lines, the legend and the cell tooltip and help card.
 * It owns a Scene3d (components/map3d/scene.ts) created in an effect and
 * disposed in its cleanup, pushes its props into the scene (layers, marks,
 * chips, the viewed turn's timeline), wires the controls
 * (components/map3d/controls.ts) and keeps the camera pose per run.  Pure
 * decisions come from src/state/map3d*.ts; this file is the glue.
 *
 * The component never fetches: RunPage passes the viewed turn's map,
 * entities, effects and selection, exactly as it does for the 2D map.
 */

// DOCS: div.map3d.insp with data-ready, data-webgl, data-renderer, data-draw-calls, data-triangles, data-frame-ms, data-camera, data-turn, data-entities, data-agents, data-layer, data-lod, data-animating.

import "../../map3d.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Point, RemovedEntity } from "../../api/types";
import { pointKey } from "../../api/types";
import type { BindingAction, CameraState } from "../../state/map3dCamera";
import { GLIDE_MS, cameraKey, focusCell, frameRegion, glide, layerElevator, step, topView } from "../../state/map3dCamera";
import { cellToScene, layerY, nextLayer } from "../../state/map3dLayout";
import { readPalette } from "../../state/map3dPalette";
import { TIMELINE_MAX_MS } from "../../state/map3dTimeline";
import { findActing } from "../../state/mapIndicators";
import { fmtPoint } from "../inspect/format";
import { entityMarkers, groupRemovedByPoint, markersAtPoint, overlayMarkers } from "../inspect/logic";
import type { MapMarker } from "../inspect/logic";
import type { DotKind } from "../inspect/mapDots";
import { attachControls } from "./controls";
import type { Controls } from "./controls";
import { HELP_SEEN_KEY, Map3dHelp } from "./Map3dHelp";
import type { LayerInput, Map3dProps } from "./props";
import { Scene3d } from "./scene";
import type { FrameStats, Hit } from "./scene";
import { Tooltip3d } from "./Tooltip3d";

/** Camera poses remembered while the page lives, keyed by persistKey and region. */
const poseStore = new Map<string, CameraState>();

const HIDDEN_KINDS_STORAGE = "empyrean.map.hiddenKinds.";
const TOOLTIP_SWITCH_MS = 220;
/** Live play: a turn interval below this skips the animation (snap). */
const SKIP_BELOW_MS = 250;
/** The idle hover line; "? help" leads so a narrow column cuts the tail, never the pointer to the full list. */
const KEY_HELP = "? help · W A S D fly · Space/Shift up/down · drag look · right-drag pan · wheel zoom · click select";
const EMPTY_REMOVED: RemovedEntity[] = [];

const KIND_CHIPS: { kind: DotKind; label: string }[] = [
  { kind: "agent", label: "living agent" },
  { kind: "dead", label: "dead agent / plant" },
  { kind: "plant", label: "plant" },
  { kind: "fruit", label: "fruit" },
  { kind: "seed", label: "seed" },
  { kind: "residue", label: "residue" },
];

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the preference lives for this page only.
  }
}

function loadHiddenKinds(persistKey: string | undefined): ReadonlySet<DotKind> {
  if (!persistKey) return new Set();
  try {
    const raw = safeGet(HIDDEN_KINDS_STORAGE + persistKey);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    const known = new Set<string>(KIND_CHIPS.map((k) => k.kind));
    return new Set(Array.isArray(list) ? (list.filter((k) => typeof k === "string" && known.has(k)) as DotKind[]) : []);
  } catch {
    return new Set();
  }
}

/** False while the profile card or the record viewer holds focus (a board press must not take it from them). */
function mayFocusViewport(): boolean {
  return !(document.activeElement instanceof HTMLElement && document.activeElement.closest(".profile-card, .record-viewer") !== null);
}

/** The entity of the overlay label at a client point, as a hit (hovering a label hovers its entity). */
function labelHitAt(labelsRoot: HTMLElement, clientX: number, clientY: number): Hit | null {
  const el = document.elementFromPoint(clientX, clientY);
  const label = el instanceof Element ? el.closest<HTMLElement>(".map3d-label") : null;
  if (!label || !labelsRoot.contains(label)) return null;
  const id = label.dataset.entityId;
  const cell = label.dataset.cell?.split(",").map((v) => parseInt(v, 10));
  if (!id || !cell || cell.length !== 2 || cell.some((v) => !Number.isFinite(v))) return null;
  return { kind: "entity", id, cell: { x: cell[0], y: cell[1] } };
}

function sameHit(a: Hit | null, b: Hit | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.cell.x !== b.cell.x || a.cell.y !== b.cell.y) return false;
  return a.kind === "entity" && b.kind === "entity" ? a.id === b.id : true;
}

/** "a01 Aster" for agents, the marker's title otherwise. */
function displayName(marker: MapMarker, layer: LayerInput): string {
  if (marker.kind !== "agent") return marker.title;
  const e = layer.entities.get(marker.id);
  const name = e && e.kind === "agent" ? e.name : marker.title.replace(/\s*\(.*\)$/, "");
  return `${marker.id} ${name}`;
}

function LegendIcon(props: { kind: DotKind }) {
  switch (props.kind) {
    case "agent":
      return (
        <svg className="map3d-legend-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path className="fill-agent" d="M5 15 L6 8 H10 L11 15 Z" />
          <circle className="fill-agent" cx="8" cy="5" r="3" />
        </svg>
      );
    case "dead":
      return (
        <svg className="map3d-legend-icon" viewBox="0 0 16 16" aria-hidden="true">
          <rect className="fill-dead" x="1" y="9" width="10" height="4" rx="1" />
          <circle className="fill-dead" cx="13" cy="11" r="2.4" />
        </svg>
      );
    case "plant":
      return (
        <svg className="map3d-legend-icon" viewBox="0 0 16 16" aria-hidden="true">
          <rect className="fill-plant" x="7" y="9" width="2" height="6" />
          <path className="fill-plant" d="M8 1 L14 9 H2 Z" />
        </svg>
      );
    case "fruit":
      return (
        <svg className="map3d-legend-icon" viewBox="0 0 16 16" aria-hidden="true">
          <circle className="fill-fruit" cx="8" cy="9" r="5" />
        </svg>
      );
    case "seed":
      return (
        <svg className="map3d-legend-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path className="fill-seed" d="M3 3 H13 L8 14 Z" />
        </svg>
      );
    case "residue":
    default:
      return (
        <svg className="map3d-legend-icon" viewBox="0 0 16 16" aria-hidden="true">
          <ellipse className="fill-residue" cx="8" cy="10" rx="7" ry="3.5" />
        </svg>
      );
  }
}

export function Map3dView(props: Map3dProps) {
  const { map, entities, selectedPoint, selectedEntityId, onSelectPoint, onSelectEntity, effects, turnId, live, paused } = props;
  const overlay = props.agentViewOverlay ?? null;
  const highlightAgentId = props.highlightAgentId ?? null;
  const removed = props.removed ?? EMPTY_REMOVED;

  // ------------------------------------------------------------------ layers
  const entityMap = useMemo(() => new Map(entities.map((e) => [e.id, e] as const)), [entities]);
  const baseMarkers = useMemo(() => (overlay ? overlayMarkers(overlay) : entityMarkers(entities, props.rules)), [overlay, entities, props.rules]);
  const layers: LayerInput[] = useMemo(
    () => props.layers ?? [{ id: "world", label: "World", map, markers: baseMarkers, entities: entityMap }],
    [props.layers, map, baseMarkers, entityMap],
  );
  const [activeState, setActive] = useState(() => Math.max(0, layers.length - 1));
  const active = Math.min(activeState, Math.max(0, layers.length - 1));
  const activeLayer = layers[active];
  const region = activeLayer.map.region;
  const markerById = useMemo(() => new Map(activeLayer.markers.map((m) => [m.id, m] as const)), [activeLayer]);
  const removedByPoint = useMemo(() => groupRemovedByPoint(active === layers.length - 1 && !props.layers ? removed : []), [removed, active, layers.length, props.layers]);
  const visibleEffects = useMemo(() => (overlay ? effects.filter((e) => e.actor === overlay.agentId) : effects), [effects, overlay]);
  const agentCount = useMemo(() => activeLayer.markers.filter((m) => m.kind === "agent").length, [activeLayer]);

  // ------------------------------------------------------------------ view state
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<DotKind>>(() => loadHiddenKinds(props.persistKey));
  useEffect(() => {
    if (props.persistKey) safeSet(HIDDEN_KINDS_STORAGE + props.persistKey, JSON.stringify([...hiddenKinds]));
  }, [props.persistKey, hiddenKinds]);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [animations, setAnimations] = useState(true);
  const [helpOpen, setHelpOpen] = useState(() => safeGet(HELP_SEEN_KEY) !== "1");
  useEffect(() => {
    if (helpOpen) safeSet(HELP_SEEN_KEY, "1");
  }, [helpOpen]);
  const [hover, setHover] = useState<Hit | null>(null);
  const [tip, setTip] = useState<{ cell: Point; focusId: string | null } | null>(null);
  const [focused, setFocused] = useState(false);
  const [lost, setLost] = useState(false);
  const [sceneKey, setSceneKey] = useState(0);
  const [sceneReady, setSceneReady] = useState(0);
  const [replayTick, setReplayTick] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const labelsRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<Scene3d | null>(null);
  const controlsRef = useRef<Controls | null>(null);
  const cameraRef = useRef<CameraState>({ x: 0, y: 12, z: 12, yaw: 0, pitch: -0.87 });
  const glideRef = useRef<{ from: CameraState; to: CameraState; t0: number } | null>(null);
  const hoverRef = useRef<Hit | null>(null);
  const hoverRaf = useRef(0);
  const pointerPos = useRef<[number, number] | null>(null);
  const tipTimer = useRef<number | null>(null);
  const suppressKey = useRef<string | null>(null);
  const tooltipPlace = useRef<(() => void) | null>(null);
  const lastTurnChange = useRef<number | null>(null);
  const lastTurnId = useRef<string | null>(null);
  const tipRef = useRef(tip);
  tipRef.current = tip;
  const helpRef = useRef(helpOpen);
  helpRef.current = helpOpen;

  // The latest props and state for the scene hooks and controls (created once per scene).
  const latest = useRef({ active, layers, region, paused, onSelectPoint, onSelectEntity, animations, reducedMotion, visibleEffects, live, selectedPoint });
  latest.current = { active, layers, region, paused, onSelectPoint, onSelectEntity, animations, reducedMotion, visibleEffects, live, selectedPoint };

  const poseKey = `${props.persistKey ?? "map3d"}:${region.min_x},${region.max_x},${region.min_y},${region.max_y}`;

  const cancelTipTimer = () => {
    if (tipTimer.current !== null) window.clearTimeout(tipTimer.current);
    tipTimer.current = null;
  };
  const closeTip = useCallback(() => {
    if (tipTimer.current !== null) window.clearTimeout(tipTimer.current);
    tipTimer.current = null;
    setTip(null);
  }, []);

  const applyCamera = useCallback((next: CameraState) => {
    cameraRef.current = next;
    sceneRef.current?.setCamera(next);
  }, []);

  const glideTo = useCallback(
    (target: CameraState) => {
      if (latest.current.reducedMotion) {
        glideRef.current = null;
        applyCamera(target);
        return;
      }
      glideRef.current = { from: cameraRef.current, to: target, t0: performance.now() };
      sceneRef.current?.invalidate();
    },
    [applyCamera],
  );

  const aspect = () => {
    const box = viewportRef.current?.getBoundingClientRect();
    return box && box.height > 0 ? box.width / box.height : 1;
  };

  const changeLayer = useCallback(
    (delta: number) => {
      const from = latest.current.active;
      const to = nextLayer(from, delta, latest.current.layers.length);
      if (to === from) return;
      setActive(to);
      glideTo(layerElevator(cameraRef.current, from, to));
    },
    [glideTo],
  );

  const runCommand = useCallback(
    (action: BindingAction): boolean => {
      const scene = sceneRef.current;
      switch (action) {
        case "layerUp":
          changeLayer(1);
          return true;
        case "layerDown":
          changeLayer(-1);
          return true;
        case "frame":
          glideTo(frameRegion(latest.current.region, latest.current.active, aspect()));
          return true;
        case "top":
          glideTo(topView(latest.current.region, latest.current.active));
          return true;
        case "focus": {
          const p = latest.current.selectedPoint;
          if (!p) return false;
          glideTo(focusCell(cameraRef.current, p, latest.current.active));
          return true;
        }
        case "replay":
          setReplayTick((n) => n + 1);
          return true;
        case "help":
          setHelpOpen((open) => !open);
          return true;
        case "escape": {
          if (helpRef.current) {
            setHelpOpen(false);
            return true;
          }
          if (tipRef.current) {
            closeTip();
            return true;
          }
          const controls = controlsRef.current;
          if (controls?.dragging() || hoverRef.current) {
            controls?.cancelDrag();
            hoverRef.current = null;
            setHover(null);
            scene?.invalidate();
            return true;
          }
          return false;
        }
        default:
          return false;
      }
    },
    [changeLayer, glideTo, closeTip],
  );

  // ------------------------------------------------------------------ the scene (created in an effect, disposed in its cleanup)
  useEffect(() => {
    const root = rootRef.current;
    const viewport = viewportRef.current;
    const labelsRoot = labelsRef.current;
    if (!root || !viewport || !labelsRoot) return;
    const canvas = document.createElement("canvas");
    canvas.className = "map3d-canvas";
    viewport.insertBefore(canvas, labelsRoot);
    root.setAttribute("data-ready", "0");
    const palette = readPalette((name) => getComputedStyle(root).getPropertyValue(name));
    if (palette.missing.length > 0) console.warn("3D view: missing colour tokens", palette.missing.join(", "));

    const updateHover = () => {
      hoverRaf.current = 0;
      const scene = sceneRef.current;
      const pos = pointerPos.current;
      if (!scene || !pos) return;
      let hit: Hit | null = null;
      if (!controlsRef.current?.dragging()) {
        const box = canvas.getBoundingClientRect();
        hit = labelHitAt(labelsRoot, box.left + pos[0], box.top + pos[1]) ?? scene.hitTest(pos[0], pos[1]);
      }
      if (sameHit(hit, hoverRef.current)) return;
      hoverRef.current = hit;
      setHover(hit);
    };

    let scene: Scene3d;
    try {
      scene = new Scene3d(canvas, labelsRoot, palette, {
        beforeFrame: (now, dt) => {
          let cam = cameraRef.current;
          let more = false;
          const g = glideRef.current;
          if (g) {
            const t = (now - g.t0) / GLIDE_MS;
            cam = glide(g.from, g.to, t);
            if (t >= 1) glideRef.current = null;
            else more = true;
          } else {
            const held = controlsRef.current?.held;
            if (held && held.size > 0) {
              cam = step(cam, held, dt, layerY(latest.current.active));
              more = true;
            }
          }
          if (cam !== cameraRef.current) {
            cameraRef.current = cam;
            scene.setCamera(cam);
          }
          return more;
        },
        onFrame: (stats: FrameStats) => {
          root.setAttribute("data-ready", "1");
          root.setAttribute("data-draw-calls", String(stats.drawCalls));
          root.setAttribute("data-triangles", String(stats.triangles));
          root.setAttribute("data-frame-ms", stats.frameMs.toFixed(1));
          root.setAttribute("data-camera", cameraKey(stats.camera));
          root.setAttribute("data-lod", stats.lod);
          root.setAttribute("data-animating", stats.animating ? "1" : "0");
          root.setAttribute("data-labels", String(stats.labels));
          tooltipPlace.current?.();
          if (pointerPos.current && !hoverRaf.current && (stats.animating || glideRef.current || (controlsRef.current?.held.size ?? 0) > 0)) {
            hoverRaf.current = requestAnimationFrame(updateHover);
          }
        },
        onPick: (id, cell) => {
          closeTip();
          // The viewport (not the label, which may leave the overlay) becomes the profile card's opener, so the keys work again after the card closes.
          if (mayFocusViewport() && document.activeElement !== viewport) viewport.focus({ preventScroll: true });
          suppressKey.current = pointKey(cell);
          latest.current.onSelectPoint(cell);
          latest.current.onSelectEntity(id);
        },
        onLod: () => undefined,
      });
    } catch (error) {
      console.error("3D view: could not create the renderer", error);
      canvas.remove();
      setLost(true);
      return;
    }
    sceneRef.current = scene;
    root.setAttribute("data-renderer", scene.rendererName);
    root.setAttribute("data-software", scene.software ? "1" : "0");
    const box = viewport.getBoundingClientRect();
    scene.setSize(box.width, box.height);
    const pose = poseStore.get(poseKey) ?? frameRegion(latest.current.region, latest.current.active, box.height > 0 ? box.width / box.height : 1);
    cameraRef.current = pose;
    scene.setCamera(pose);

    const controls = attachControls(viewport, canvas, {
      camera: () => cameraRef.current,
      setCamera: (next) => {
        glideRef.current = null;
        cameraRef.current = next;
        scene.setCamera(next);
      },
      layerY: () => layerY(latest.current.active),
      boardPoint: (px, py) => scene.boardPoint(px, py),
      onHover: (px, py) => {
        pointerPos.current = [px, py];
        if (!hoverRaf.current) hoverRaf.current = requestAnimationFrame(updateHover);
      },
      onLeave: () => {
        pointerPos.current = null;
        if (hoverRef.current) {
          hoverRef.current = null;
          setHover(null);
        }
      },
      onClick: (px, py) => {
        const hit = scene.hitTest(px, py);
        if (!hit) return;
        closeTip();
        suppressKey.current = pointKey(hit.cell);
        latest.current.onSelectPoint(hit.cell);
        if (hit.kind === "entity") latest.current.onSelectEntity(hit.id);
        else {
          const here = markersAtPoint(latest.current.layers[latest.current.active].markers, hit.cell);
          if (here.length === 1) latest.current.onSelectEntity(here[0].id);
        }
      },
      onCommand: (action) => runCommand(action),
      onHeldChange: () => scene.invalidate(),
      onDragChange: (dragging) => {
        viewport.classList.toggle("is-dragging", dragging);
        if (dragging && hoverRef.current) {
          hoverRef.current = null;
          setHover(null);
        }
      },
      canFocus: mayFocusViewport,
      onPointerDown: () => setHelpOpen(false),
    });
    controlsRef.current = controls;

    const observer = new ResizeObserver(() => {
      const b = viewport.getBoundingClientRect();
      if (b.width > 0 && b.height > 0) scene.setSize(b.width, b.height);
    });
    observer.observe(viewport);
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => scene.setPalette(readPalette((name) => getComputedStyle(root).getPropertyValue(name)));
    dark.addEventListener("change", onTheme);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => setReducedMotion(motion.matches);
    motion.addEventListener("change", onMotion);
    const onLost = (event: Event) => {
      event.preventDefault();
      setLost(true);
    };
    canvas.addEventListener("webglcontextlost", onLost);
    const onVisibility = () => scene.setPaused(latest.current.paused || document.visibilityState !== "visible");
    document.addEventListener("visibilitychange", onVisibility);
    setSceneReady((n) => n + 1);

    return () => {
      poseStore.set(poseKey, cameraRef.current);
      observer.disconnect();
      dark.removeEventListener("change", onTheme);
      motion.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      if (hoverRaf.current) cancelAnimationFrame(hoverRaf.current);
      hoverRaf.current = 0;
      controls.dispose();
      controlsRef.current = null;
      scene.dispose();
      sceneRef.current = null;
      canvas.remove();
      root.setAttribute("data-ready", "0");
    };
    // The scene is created once per mount (and again after Retry); everything else reaches it through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneKey]);

  // ------------------------------------------------------------------ props -> scene
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setLayers(layers, latest.current.active, { priorityIds: [highlightAgentId, selectedEntityId], hiddenKinds, ghost: overlay !== null, selfId: overlay?.agentId ?? null });
  }, [layers, hiddenKinds, highlightAgentId, selectedEntityId, overlay, sceneReady]);

  useEffect(() => {
    sceneRef.current?.setActiveLayer(active);
  }, [active, sceneReady]);

  useEffect(() => {
    sceneRef.current?.setChips(visibleEffects);
  }, [visibleEffects, sceneReady]);

  useEffect(() => {
    sceneRef.current?.setMarks({
      selectedPoint,
      selectedEntityId,
      highlightAgentId,
      hoverEntityId: hover?.kind === "entity" ? hover.id : null,
      hoverCell: hover?.cell ?? null,
    });
  }, [selectedPoint, selectedEntityId, highlightAgentId, hover, sceneReady]);

  useEffect(() => {
    sceneRef.current?.setPaused(paused || document.visibilityState !== "visible");
  }, [paused, sceneReady]);

  // The viewed turn's animations: once per turn change (squeezed while live turns arrive fast) and on Replay.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const now = performance.now();
    let factor = 1;
    let skip = false;
    if (lastTurnId.current !== turnId) {
      const previous = lastTurnChange.current;
      lastTurnId.current = turnId;
      lastTurnChange.current = now;
      if (latest.current.live && previous !== null) {
        const interval = now - previous;
        if (interval < SKIP_BELOW_MS) skip = true;
        else if (interval < TIMELINE_MAX_MS) factor = (0.6 * interval) / TIMELINE_MAX_MS;
      }
    }
    if (skip) scene.snapTimeline();
    else scene.playTimeline(latest.current.visibleEffects, latest.current.reducedMotion || !latest.current.animations, factor);
  }, [turnId, replayTick, sceneReady]);

  // A selection made elsewhere (Find, Go to, roster, assistant) that is off screen glides the camera to it.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !selectedPoint) return;
    const p = scene.project(cellToScene(selectedPoint, active));
    if (!p.visible) glideTo(focusCell(cameraRef.current, selectedPoint, active));
  }, [selectedPoint, active, glideTo]);

  // Selection changes close the tooltip.
  useEffect(() => {
    closeTip();
  }, [selectedPoint, selectedEntityId, closeTip]);

  // ------------------------------------------------------------------ tooltip
  useEffect(() => {
    if (!hover) return;
    const key = pointKey(hover.cell);
    if (suppressKey.current && suppressKey.current !== key) suppressKey.current = null;
    if (suppressKey.current === key) return;
    const occupants = markersAtPoint(activeLayer.markers, hover.cell);
    const gone = removedByPoint.get(key) ?? [];
    if (occupants.length === 0 && gone.length === 0) return;
    const focusId = hover.kind === "entity" ? hover.id : null;
    if (tip && tip.cell.x === hover.cell.x && tip.cell.y === hover.cell.y) {
      if (tip.focusId !== focusId) setTip({ cell: tip.cell, focusId });
      return;
    }
    cancelTipTimer();
    tipTimer.current = window.setTimeout(() => {
      tipTimer.current = null;
      setTip({ cell: hover.cell, focusId });
    }, TOOLTIP_SWITCH_MS);
    return cancelTipTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, activeLayer, removedByPoint]);

  useEffect(() => {
    if (!tip) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".map3d-tooltip")) return;
      closeTip();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [tip, closeTip]);

  // ------------------------------------------------------------------ derived text
  const terrainOf = (p: Point) => activeLayer.map.cells[pointKey(p)] ?? (p.x >= region.min_x && p.x <= region.max_x && p.y >= region.min_y && p.y <= region.max_y ? "land" : null);
  const hoverMarker = hover?.kind === "entity" ? (markerById.get(hover.id) ?? null) : null;
  const hoverOccupants = hover ? markersAtPoint(activeLayer.markers, hover.cell) : [];
  const selectedMarker = selectedEntityId ? (markerById.get(selectedEntityId) ?? null) : null;
  const acting = findActing(effects);
  const turnText = acting ? `Turn ${turnId}: ${acting.actor} ${acting.label}` : effects.length > 0 ? `Turn ${turnId}: ${effects.length} world event${effects.length === 1 ? "" : "s"}` : `Turn ${turnId}: no action`;
  const layerText = `Layer ${active + 1} of ${layers.length}`;
  const hiddenNames = KIND_CHIPS.filter((k) => hiddenKinds.has(k.kind)).map((k) => k.label);
  const tipOccupants = tip ? markersAtPoint(activeLayer.markers, tip.cell) : [];
  const tipRemoved = tip ? (removedByPoint.get(pointKey(tip.cell)) ?? []) : [];
  const motionOff = reducedMotion || !animations;

  const toggleKind = (kind: DotKind) =>
    setHiddenKinds((old) => {
      const next = new Set(old);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const focusViewport = () => viewportRef.current?.focus({ preventScroll: true });

  return (
    <div
      ref={rootRef}
      className="map3d insp"
      data-webgl="2"
      data-turn={turnId}
      data-entities={activeLayer.markers.length}
      data-agents={agentCount}
      data-layer={`${active + 1}/${layers.length}`}
      data-motion={motionOff ? "off" : "on"}
    >
      <div className="map3d-toolbar" role="toolbar" aria-label="3D map navigation">
        <button type="button" className="insp-btn insp-btn-small" title="Frame the whole region (F)" onClick={() => runCommand("frame")}>
          Frame region
        </button>
        <button type="button" className="insp-btn insp-btn-small" title="Look straight down at the region (T)" onClick={() => runCommand("top")}>
          Top view
        </button>
        <button type="button" className="insp-btn insp-btn-small" title="Fly to the selected cell (Home)" disabled={!selectedPoint} onClick={() => runCommand("focus")}>
          Focus selection
        </button>
        <span className="insp-btn-group" aria-label="Layers">
          <button type="button" className="insp-btn insp-btn-small" title="Activate the layer below (PageDown)" disabled={active <= 0} onClick={() => changeLayer(-1)}>
            Layer down
          </button>
          <button type="button" className="insp-btn insp-btn-small" title="Activate the layer above (PageUp)" disabled={active >= layers.length - 1} onClick={() => changeLayer(1)}>
            Layer up
          </button>
        </span>
        <span className="map3d-layer-chip" title="The active layer: opaque, pickable and labelled">
          {layerText} · {activeLayer.label}
        </span>
        <button type="button" className="insp-btn insp-btn-small" title="Replay the viewed turn's animations (R)" onClick={() => runCommand("replay")}>
          Replay turn
        </button>
        <label className="insp-small" title={reducedMotion ? "Off: this system asks for reduced motion" : "Animate the viewed turn's actions (moves, attacks, messages, growth)"}>
          <input type="checkbox" checked={animations && !reducedMotion} disabled={reducedMotion} onChange={(e) => setAnimations(e.target.checked)} /> Animations
        </label>
        <button type="button" className="insp-btn insp-btn-small" aria-pressed={helpOpen} title="Show the key and pointer bindings (? or H)" onClick={() => setHelpOpen((o) => !o)}>
          Controls
        </button>
      </div>
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
        ref={viewportRef}
        className="map3d-viewport"
        tabIndex={0}
        aria-label="3D world map. Drag to look around, W A S D to fly, Space and Shift to go up and down, wheel to zoom, click to select."
        onFocus={(e) => {
          if (e.target === e.currentTarget) setFocused(true);
        }}
        onBlur={(e) => {
          if (e.target === e.currentTarget) setFocused(false);
        }}
      >
        <div ref={labelsRef} className="map3d-labels" />
        {!focused && !lost ? <div className="map3d-focus-hint">Click the board to control it with the keyboard</div> : null}
        {lost ? (
          <div className="map3d-lost" role="alert">
            <p>The 3D view lost its graphics context.</p>
            <button
              type="button"
              className="insp-btn"
              onClick={() => {
                setLost(false);
                setSceneKey((k) => k + 1);
              }}
            >
              Retry
            </button>
          </div>
        ) : null}
        {helpOpen ? (
          <Map3dHelp
            onClose={() => {
              setHelpOpen(false);
              focusViewport();
            }}
          />
        ) : null}
      </div>
      <div className="map3d-status">
        <div className="map3d-status-line map3d-status-hover" data-turn-id={turnId}>
          {hover && hoverMarker ? (
            <>
              <strong>{displayName(hoverMarker, activeLayer)}</strong> at {fmtPoint(hover.cell)}: click to select it
            </>
          ) : hover ? (
            <>
              Cell {fmtPoint(hover.cell)} {terrainOf(hover.cell) ?? "outside region"} · {hoverOccupants.length} {overlay ? "known here" : hoverOccupants.length === 1 ? "occupant" : "occupants"}
            </>
          ) : (
            KEY_HELP
          )}
        </div>
        <div className="map3d-status-line map3d-status-row">
          Selected: {selectedPoint ? `${fmtPoint(selectedPoint)} ${terrainOf(selectedPoint) ?? "outside region"}` : "none"}
          {selectedMarker ? ` · ${displayName(selectedMarker, activeLayer)}` : ""} · {turnText} · {layerText}
          {hiddenNames.length > 0 ? ` · Not drawn: ${hiddenNames.join(", ")}` : ""}
        </div>
      </div>
      <div className="insp-legend" aria-label="3D map legend">
        <span className="insp-legend-title">Show</span>
        {KIND_CHIPS.map((k) => {
          const on = !hiddenKinds.has(k.kind);
          return (
            <button
              key={k.kind}
              type="button"
              role="checkbox"
              aria-checked={on}
              className={`insp-legend-chip${on ? " is-on" : ""}`}
              title={on ? `Hide ${k.label} figures on the board` : `Show ${k.label} figures on the board`}
              onClick={() => toggleKind(k.kind)}
            >
              <LegendIcon kind={k.kind} /> {k.label}
            </button>
          );
        })}
        <button type="button" className="insp-btn insp-btn-small" onClick={() => setHiddenKinds(new Set())} disabled={hiddenKinds.size === 0}>
          Select all
        </button>
        <button type="button" className="insp-btn insp-btn-small" onClick={() => setHiddenKinds(new Set(KIND_CHIPS.map((k) => k.kind)))} disabled={hiddenKinds.size === KIND_CHIPS.length}>
          Unselect all
        </button>
        {props.legendExtra}
        <span className="insp-legend-sep" />
        <span className="insp-legend-item">
          <svg className="map3d-legend-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle className="ring-acting" cx="8" cy="8" r="6" />
          </svg>
          acting agent (dashed ring: the agent whose turn is running)
        </span>
        <span className="insp-legend-item">
          <svg className="map3d-legend-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle className="ring-selected" cx="8" cy="8" r="6" />
          </svg>
          selected entity (ring)
        </span>
        <span className="insp-legend-item">
          <svg className="map3d-legend-icon" viewBox="0 0 16 16" aria-hidden="true">
            <rect className="cell-frame-outer" x="3" y="3" width="10" height="10" />
            <rect className="cell-frame" x="3" y="3" width="10" height="10" />
          </svg>
          selected cell
        </span>
        <span className="insp-legend-item">
          <span className="map3d-badge">7</span> occupants in the cell (from 5)
        </span>
        <span className="insp-legend-sep" />
        <span className="insp-legend-item">
          <span className="insp-swatch insp-swatch-land" /> land
        </span>
        <span className="insp-legend-item">
          <span className="insp-swatch insp-swatch-mountain" /> mountain (raised, impassable)
        </span>
        <span className="insp-legend-item">
          <span className="insp-swatch insp-swatch-water" /> water (sunk, no plants)
        </span>
        <span className="insp-legend-item">
          <span className="insp-swatch insp-swatch-outside" /> outside region
        </span>
      </div>
      {tip ? (
        <Tooltip3d
          cell={tip.cell}
          terrain={terrainOf(tip.cell)}
          occupants={tipOccupants}
          removed={tipRemoved}
          focusId={tip.focusId}
          agentViewOf={overlay ? `${overlay.agentName} (${overlay.agentId})` : null}
          register={(fn) => {
            tooltipPlace.current = fn;
          }}
          getAnchor={() => {
            const scene = sceneRef.current;
            const viewport = viewportRef.current;
            if (!scene || !viewport) return null;
            const p = scene.project(cellToScene(tip.cell, active));
            if (!p.visible) return null;
            const box = viewport.getBoundingClientRect();
            return { left: box.left + p.x - 20, top: box.top + p.y - 20, size: 40 };
          }}
          onEnter={cancelTipTimer}
          onClose={closeTip}
          onPick={(id) => {
            closeTip();
            suppressKey.current = pointKey(tip.cell);
            onSelectPoint(tip.cell);
            onSelectEntity(id);
          }}
        />
      ) : null}
    </div>
  );
}

export default Map3dView;
