/**
 * CPU canvas renderer for the 3D board. Camera, entity packing, terrain,
 * playback and overlay placement reuse the existing pure map3d modules.
 * Frames are drawn only after a change or while controls or a turn run.
 */
// DOCS: Canvas 2D draws projected terrain and entities without a graphics API; picking and labels use the same camera projection.

import type { Agent, Entity, MapState, Plant, Point, Terrain } from "../../api/types";
import { pointKey } from "../../api/types";
import type { CameraState } from "../../state/map3dCamera";
import { CAMERA_NEAR, FOV_DEG, FRAME_SCREEN_Y, lodDistance, lookDirection, rightOf, upVector } from "../../state/map3dCamera";
import { chipText, glyphFor } from "../../state/map3dGlyphs";
import type { LodMode, Vec3 } from "../../state/map3dLayout";
import { INACTIVE_LAYER_OPACITY, cellToScene, columnHeight, countBadge, figureKind, layerY, lodMode, orderForSlots, packCell, slotScenePosition } from "../../state/map3dLayout";
import type { Palette, Rgb } from "../../state/map3dPalette";
import { dominantKind, ghostTint, healthColour, kindColour, mix, plantColour, rgbToCss } from "../../state/map3dPalette";
import type { ClipColour, FxState, Timeline, TimelineContext } from "../../state/map3dTimeline";
import { CHIP_HEIGHT, buildTimeline, chipPlacements, sampleTimeline, scaleTimeline } from "../../state/map3dTimeline";
import { terrainAt, terrainTop } from "../../state/map3dTerrain";
import type { TurnEffect } from "../../state/turnEffects";
import type { MapMarker } from "../inspect/logic";
import { groupMarkersByPoint } from "../inspect/logic";
import type { DotKind } from "../inspect/mapDots";
import { dotKind, dotLabel } from "../inspect/mapDots";
import type { LabelItem } from "./labels";
import { CHIP_NUDGES, LabelLayer } from "./labels";

export interface SceneLayer {
  id: string;
  label: string;
  map: MapState;
  markers: readonly MapMarker[];
  entities: ReadonlyMap<string, Entity>;
}
export interface LayerOptions {
  priorityIds: readonly (string | null | undefined)[];
  hiddenKinds: ReadonlySet<DotKind>;
  ghost: boolean;
  selfId: string | null;
  knownTerrain: Readonly<Record<string, Terrain | null>> | null;
}
export interface Marks {
  selectedPoint: Point | null;
  selectedEntityId: string | null;
  highlightAgentId: string | null;
  hoverEntityId: string | null;
  hoverCell: Point | null;
}
export type Hit = { kind: "entity"; id: string; cell: Point } | { kind: "cell"; cell: Point };
export interface FrameStats {
  drawCalls: number;
  triangles: number;
  frameMs: number;
  lod: LodMode;
  animating: boolean;
  labels: number;
  camera: CameraState;
}
export interface SceneHooks {
  beforeFrame(nowMs: number, dtMs: number): boolean;
  onFrame(stats: FrameStats): void;
  onPick(id: string, cell: Point): void;
  onLod(lod: LodMode): void;
}

type Screen = { x: number; y: number; depth: number; visible: boolean };
type Draw = { depth: number; paint: () => void };
type Pick = { x: number; y: number; radius: number; depth: number; id: string; cell: Point };
interface Figure {
  id: string;
  marker: MapMarker;
  layer: number;
  base: Vec3;
  current: Vec3;
  scale: number;
  drawScale: number;
  lying: boolean;
  colour: Rgb;
  tint: ClipColour | null;
  tilt: number;
  cell: Point;
  health: Rgb | null;
}
interface LayerRuntime {
  input: SceneLayer;
  index: number;
  byCell: Map<string, MapMarker[]>;
  figures: Figure[];
}

const FRAME_SPACING_MS = 30;
const LABEL_HEIGHT: Record<MapMarker["kind"], number> = { agent: 0.62, plant: 0.72, fruit: 0.24, seed: 0.24, residue: 0.14 };
const LABEL_NAME_DISTANCE = 30;
const LABEL_FAR = 60;
const OUTLINE = 0.24;
const near = (a: number, b: number) => Math.abs(a - b) < 0.001;
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const alpha = (colour: Rgb, opacity: number) => `rgba(${Math.round(colour[0] * 255)},${Math.round(colour[1] * 255)},${Math.round(colour[2] * 255)},${Math.max(0, Math.min(1, opacity))})`;

/** The board renderer and the view's unchanged scene interface. */
export class Scene3d {
  readonly rendererName = "Canvas 2D (CPU)";
  readonly software = true;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly labels: LabelLayer;
  private readonly hooks: SceneHooks;
  private palette: Palette;
  private layers: LayerRuntime[] = [];
  private active = 0;
  private options: LayerOptions = { priorityIds: [], hiddenKinds: new Set(), ghost: false, selfId: null, knownTerrain: null };
  private marks: Marks = { selectedPoint: null, selectedEntityId: null, highlightAgentId: null, hoverEntityId: null, hoverCell: null };
  private cameraState: CameraState = { x: 0, y: 10, z: 10, yaw: 0, pitch: -0.8 };
  private lod: LodMode = "figures";
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private dirty = false;
  private paused = false;
  private disposed = false;
  private inFrame = false;
  private rafId = 0;
  private lastFrameClock = 0;
  private lastFrameStart = 0;
  private lastMore = false;
  private timeline: Timeline | null = null;
  private timelineStart = 0;
  private timelineRunning = false;
  private fx: FxState[] = [];
  private chips: { effect: TurnEffect; id: string | null; position: Vec3 }[] = [];
  private chipEffects: readonly TurnEffect[] = [];
  private floats: LabelItem[] = [];
  private ticks: LabelItem[] = [];
  private picks: Pick[] = [];
  private lastStats: FrameStats;

  constructor(canvas: HTMLCanvasElement, labelsRoot: HTMLElement, palette: Palette, hooks: SceneHooks) {
    this.canvas = canvas;
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!context) throw new Error("Canvas 2D is unavailable");
    this.ctx = context;
    this.palette = palette;
    this.hooks = hooks;
    this.labels = new LabelLayer(labelsRoot, hooks.onPick);
    this.lastStats = { drawCalls: 0, triangles: 0, frameMs: 0, lod: "figures", animating: false, labels: 0, camera: this.cameraState };
  }

  /** Resize the CPU backing store to the CSS viewport, capped at native resolution. */
  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.pixelRatio = Math.min(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(this.width * this.pixelRatio));
    this.canvas.height = Math.max(1, Math.round(this.height * this.pixelRatio));
    this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    this.invalidate();
  }

  /** Re-read the same CSS palette used by the 2D map. */
  setPalette(palette: Palette): void {
    this.palette = palette;
    this.rebuildFigures();
    this.invalidate();
  }
  getCamera(): CameraState { return this.cameraState; }
  setCamera(state: CameraState): void {
    this.cameraState = state;
    const next = lodMode(lodDistance(state, layerY(this.active)), this.lod);
    if (next !== this.lod) { this.lod = next; this.hooks.onLod(next); }
    this.invalidate();
  }
  get currentLod(): LodMode { return this.lod; }
  get stats(): FrameStats { return this.lastStats; }
  get animating(): boolean { return this.timelineRunning; }

  /** Replace every visible board layer and repack its entities. */
  setLayers(layers: readonly SceneLayer[], active: number, options: LayerOptions): void {
    this.snapTimeline();
    this.options = options;
    this.active = Math.min(Math.max(0, active), Math.max(0, layers.length - 1));
    this.layers = layers.map((input, index) => ({ input, index, byCell: new Map(), figures: [] }));
    this.rebuildFigures();
    this.buildTicks();
    this.refreshChips();
    this.invalidate();
  }
  setActiveLayer(active: number): void {
    const next = Math.min(Math.max(0, active), Math.max(0, this.layers.length - 1));
    if (next === this.active) return;
    this.active = next;
    this.buildTicks();
    this.refreshChips();
    const lod = lodMode(lodDistance(this.cameraState, layerY(this.active)), this.lod);
    if (lod !== this.lod) { this.lod = lod; this.hooks.onLod(lod); }
    this.invalidate();
  }
  get activeLayer(): number { return this.active; }
  markersAt(cell: Point): MapMarker[] { return this.layers[this.active]?.byCell.get(pointKey(cell)) ?? []; }

  private rebuildFigures(): void {
    for (const rt of this.layers) {
      const visible = rt.input.markers.filter((m) => !this.options.hiddenKinds.has(dotKind(m)));
      const grouped = groupMarkersByPoint(visible);
      rt.byCell = new Map();
      rt.figures = [];
      for (const [key, list] of grouped) {
        const ordered = orderForSlots(list, this.options.priorityIds);
        rt.byCell.set(key, ordered);
        const slots = packCell(ordered.length);
        for (let i = 0; i < ordered.length; i++) {
          const marker = ordered[i];
          const entity = rt.input.entities.get(marker.id);
          const position = slotScenePosition(marker.position, slots[i], rt.index);
          const kindScale = marker.kind === "plant" && entity?.kind === "plant" ? Math.min(1.6, Math.max(0.7, 0.4 + 0.3 * ((entity as Plant).size || 1))) * (marker.dead ? 0.6 : 1) : 1;
          let colour = marker.dead ? this.palette.dead : marker.kind === "plant" ? plantColour(entity?.kind === "plant" ? entity.species : "", false, this.palette) : kindColour(marker.kind, this.palette);
          if (this.options.ghost) colour = ghostTint(colour, this.palette);
          const stats = entity?.kind === "agent" ? (entity as Agent).stats : null;
          rt.figures.push({ id: marker.id, marker, layer: rt.index, base: position, current: position, scale: slots[i].scale * kindScale, drawScale: 1, lying: marker.dead, colour, tint: null, tilt: 0, cell: marker.position, health: stats && !marker.dead && !this.options.ghost ? healthColour(stats.max_health > 0 ? stats.health / stats.max_health : 0, this.palette) : null });
        }
      }
    }
  }
  private findFigure(id: string | null, layer = this.active): Figure | undefined { return id ? this.layers[layer]?.figures.find((f) => f.id === id) : undefined; }
  private buildTicks(): void {
    this.ticks = [];
    const rt = this.layers[this.active];
    if (!rt) return;
    const r = rt.input.map.region;
    const span = Math.max(r.max_x - r.min_x, r.max_y - r.min_y) + 1;
    const step = span <= 20 ? 1 : 5;
    for (let x = r.min_x; x <= r.max_x; x++) if (x % step === 0 || x === r.min_x || x === r.max_x) this.ticks.push({ key: `tick:x:${x}`, kind: "tick", position: [x, layerY(this.active), -r.min_y + 0.9], text: String(x), anchor: "center", priority: 0, className: x === 0 ? "map3d-tick-zero" : undefined });
    for (let y = r.min_y; y <= r.max_y; y++) if (y % step === 0 || y === r.min_y || y === r.max_y) this.ticks.push({ key: `tick:y:${y}`, kind: "tick", position: [r.min_x - 0.9, layerY(this.active), -y], text: String(y), anchor: "center", priority: 0, className: y === 0 ? "map3d-tick-zero" : undefined });
  }
  setMarks(marks: Marks): void { this.marks = marks; this.invalidate(); }

  /** Context shared with the unchanged turn timeline builder. */
  timelineContext(reducedMotion: boolean): TimelineContext {
    const rt = this.layers[this.active];
    return {
      slotOf: (id) => this.findFigure(id)?.base ?? null,
      cellCentre: (p) => cellToScene(p, this.active),
      commRange: (id) => { const e = rt?.input.entities.get(id); return e?.kind === "agent" ? e.stats.communication_range : null; },
      reducedMotion,
    };
  }
  setChips(effects: readonly TurnEffect[]): void { this.chipEffects = effects; this.refreshChips(); this.invalidate(); }
  private refreshChips(): void { this.chips = chipPlacements(this.chipEffects, this.timelineContext(true)).map((c) => ({ effect: c.effect, id: c.id, position: c.position })); }
  playTimeline(effects: readonly TurnEffect[], reducedMotion: boolean, factor = 1): void {
    this.snapTimeline();
    let tl = buildTimeline(effects, this.timelineContext(reducedMotion));
    if (factor !== 1) tl = scaleTimeline(tl, factor);
    this.timeline = tl;
    this.timelineStart = performance.now();
    this.timelineRunning = tl.duration > 0 && tl.clips.length > 0;
    if (!this.timelineRunning) this.timeline = null;
    this.invalidate();
  }
  snapTimeline(): void {
    if (!this.timelineRunning && this.fx.length === 0) return;
    this.timelineRunning = false;
    this.timeline = null;
    this.fx = [];
    this.floats = [];
    for (const rt of this.layers) for (const fig of rt.figures) { fig.current = fig.base; fig.drawScale = 1; fig.tint = null; fig.tilt = 0; }
    this.invalidate();
  }
  private sample(now: number): void {
    if (!this.timeline || !this.timelineRunning) return;
    const sampled = sampleTimeline(this.timeline, now - this.timelineStart);
    for (const rt of this.layers) for (const fig of rt.figures) { fig.current = fig.base; fig.drawScale = 1; fig.tint = null; fig.tilt = 0; }
    for (const [id, e] of sampled.entities) {
      const fig = this.findFigure(id);
      if (!fig) continue;
      fig.current = add(fig.base, e.offset);
      fig.drawScale = e.scale;
      fig.tint = e.tint;
      fig.tilt = e.tilt;
    }
    this.fx = sampled.fx.filter((fx) => fx.kind !== "float");
    this.floats = sampled.fx.filter((fx) => fx.kind === "float").map((fx) => ({ key: `float:${fx.id ?? ""}:${fx.text ?? ""}:${fx.effectKind}`, kind: "float", position: fx.position, text: fx.text ?? "", className: fx.colour ? `map3d-float-${fx.colour}` : undefined, opacity: fx.opacity, anchor: "center", priority: 5 }));
    if (sampled.done) this.snapTimeline();
  }

  /** Perspective projection, using the same yaw and pitch as flight controls. */
  private projectDepth(p: Vec3): Screen {
    const c = this.cameraState;
    const rel: Vec3 = [p[0] - c.x, p[1] - c.y, p[2] - c.z];
    const forward = lookDirection(c);
    const [rx, rz] = rightOf(c.yaw);
    const up = upVector(c);
    const depth = dot(rel, forward);
    if (depth <= CAMERA_NEAR) return { x: 0, y: 0, depth, visible: false };
    const focal = (this.height / 2) / Math.tan((FOV_DEG * Math.PI) / 360);
    const x = this.width / 2 + (rel[0] * rx + rel[2] * rz) * focal / depth;
    const y = this.height * FRAME_SCREEN_Y - dot(rel, up) * focal / depth;
    return { x, y, depth, visible: x >= 0 && x <= this.width && y >= 0 && y <= this.height };
  }
  project(p: Vec3): { x: number; y: number; visible: boolean } { const q = this.projectDepth(p); return { x: q.x, y: q.y, visible: q.visible }; }
  entityPosition(id: string): Vec3 | null { return this.findFigure(id)?.current ?? null; }

  /** Intersect the pointer ray with the active board's plane for drag and wheel controls. */
  boardPoint(px: number, py: number): Vec3 | null {
    const c = this.cameraState;
    const forward = lookDirection(c);
    const up = upVector(c);
    const [rx, rz] = rightOf(c.yaw);
    const focal = (this.height / 2) / Math.tan((FOV_DEG * Math.PI) / 360);
    const dx = (px - this.width / 2) / focal;
    const dy = (this.height * FRAME_SCREEN_Y - py) / focal;
    const ray: Vec3 = [forward[0] + rx * dx + up[0] * dy, forward[1] + up[1] * dy, forward[2] + rz * dx + up[2] * dy];
    if (near(ray[1], 0)) return null;
    const t = (layerY(this.active) - c.y) / ray[1];
    return t > 0 ? [c.x + ray[0] * t, layerY(this.active), c.z + ray[2] * t] : null;
  }
  hitTest(px: number, py: number): Hit | null {
    const rt = this.layers[this.active];
    if (!rt) return null;
    let nearest: Pick | null = null;
    for (const pick of this.picks) {
      if (Math.hypot(px - pick.x, py - pick.y) <= pick.radius && (!nearest || pick.depth < nearest.depth)) nearest = pick;
    }
    if (nearest) return this.lod === "columns" ? { kind: "cell", cell: nearest.cell } : { kind: "entity", id: nearest.id, cell: nearest.cell };
    const point = this.boardPoint(px, py);
    if (!point) return null;
    const cell = { x: Math.round(point[0]), y: Math.round(-point[2]) };
    const r = rt.input.map.region;
    return cell.x >= r.min_x && cell.x <= r.max_x && cell.y >= r.min_y && cell.y <= r.max_y ? { kind: "cell", cell } : null;
  }

  private path(points: readonly Screen[]): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
  }
  /** Clip terrain polygons against the camera's near plane before projection. */
  private projectPolygon(points: readonly Vec3[]): Screen[] {
    const c = this.cameraState;
    const forward = lookDirection(c);
    const depth = (p: Vec3) => dot([p[0] - c.x, p[1] - c.y, p[2] - c.z], forward);
    const threshold = CAMERA_NEAR + 0.02;
    const clipped: Vec3[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const da = depth(a), db = depth(b);
      if (da >= threshold) clipped.push(a);
      if ((da < threshold && db > threshold) || (da > threshold && db < threshold)) clipped.push(lerp(a, b, (threshold - da) / (db - da)));
    }
    return clipped.map((p) => this.projectDepth(p));
  }
  private strokePoly(points: readonly Screen[], colour: string, width: number): void { this.path(points); this.ctx.strokeStyle = colour; this.ctx.lineWidth = width; this.ctx.stroke(); }
  private ellipse(x: number, y: number, rx: number, ry: number, colour: string): void {
    this.ctx.beginPath(); this.ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2); this.ctx.fillStyle = colour; this.ctx.fill();
  }
  private line(a: Screen, b: Screen, colour: string, width: number): void {
    const ctx = this.ctx; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.stroke();
  }
  private roleColour(role: ClipColour | null): Rgb {
    switch (role) { case "bad": return this.palette.bad; case "good": return this.palette.good; case "warn": case "resource": return this.palette.warn; default: return this.palette.accent; }
  }
  /** Quiet, deterministic surface marks that do not use images or idle animation. */
  private terrainDetail(terrain: "land" | "mountain" | "water", cell: Point, corners: readonly Vec3[], opacity: number): void {
    const ctx = this.ctx;
    const pal = this.palette;
    const [x, y, z] = [cell.x, corners[0][1], -cell.y];
    const screenWidth = Math.hypot(this.projectDepth(corners[1]).x - this.projectDepth(corners[0]).x, this.projectDepth(corners[1]).y - this.projectDepth(corners[0]).y);
    if (terrain === "mountain") {
      if (screenWidth < 4) return;
      const off = ((cell.x * 17 + cell.y * 29) % 7) / 35 - 0.08;
      const peak: Vec3 = [x + off, y + 0.3, z - off * 0.5];
      const peakScreen = this.projectDepth(peak);
      if (peakScreen.depth <= CAMERA_NEAR) return;
      const shades = [mix(pal.mountain, pal.fg, 0.12), mix(pal.mountain, pal.bg, 0.13), mix(pal.mountain, pal.bg, 0.24), mix(pal.mountain, pal.fg, 0.04)];
      for (let i = 0; i < 4; i++) {
        const a = this.projectDepth(corners[i]);
        const b = this.projectDepth(corners[(i + 1) % 4]);
        if (a.depth <= CAMERA_NEAR || b.depth <= CAMERA_NEAR) continue;
        this.path([a, b, peakScreen]);
        ctx.fillStyle = alpha(shades[i], opacity);
        ctx.fill();
      }
      return;
    }
    if (screenWidth < 12) return;
    const hash = Math.abs((cell.x * 73856093) ^ (cell.y * 19349663));
    if (terrain === "land") {
      if (hash % 5 !== 0) return;
      const at: Vec3 = [x - 0.15 + (hash % 3) * 0.11, y + 0.009, z + 0.05];
      const a = this.projectDepth(at);
      const b = this.projectDepth([at[0] - 0.07, at[1], at[2] - 0.12]);
      const c = this.projectDepth([at[0] + 0.06, at[1], at[2] - 0.1]);
      if (a.depth <= CAMERA_NEAR || b.depth <= CAMERA_NEAR || c.depth <= CAMERA_NEAR) return;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y);
      ctx.strokeStyle = alpha(pal.plant, opacity * 0.22); ctx.lineWidth = 0.85; ctx.stroke();
      return;
    }
    // Two short, still surface strokes make water read as water at close zoom.
    for (let i = 0; i < 2; i++) {
      const row = i === 0 ? -0.15 : 0.16;
      const from = this.projectDepth([x - 0.28 + (hash % 4) * 0.025, y + 0.012, z + row]);
      const mid = this.projectDepth([x, y + 0.012, z + row - 0.035]);
      const to = this.projectDepth([x + 0.27, y + 0.012, z + row]);
      if (from.depth <= CAMERA_NEAR || mid.depth <= CAMERA_NEAR || to.depth <= CAMERA_NEAR) continue;
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(mid.x, mid.y, to.x, to.y);
      ctx.strokeStyle = alpha(mix(pal.waterLine, pal.fg, 0.16), opacity * 0.54); ctx.lineWidth = 1.1; ctx.stroke();
    }
  }
  private tile(rt: LayerRuntime, cell: Point, commands: Draw[]): void {
    const y = layerY(rt.index);
    const fogged = this.options.knownTerrain !== null && !this.options.knownTerrain[pointKey(cell)];
    // Unobserved terrain is flat and dark, so its true mountain or water shape cannot show through.
    const terrain = fogged ? "land" : terrainAt(rt.input.map, cell);
    const top = y + terrainTop(terrain);
    const x = cell.x, z = -cell.y;
    const corners: Vec3[] = [[x - 0.5, top, z - 0.5], [x + 0.5, top, z - 0.5], [x + 0.5, top, z + 0.5], [x - 0.5, top, z + 0.5]];
    const poly = this.projectPolygon(corners);
    if (poly.length < 3) return;
    if (poly.every((p) => p.x < -20) || poly.every((p) => p.x > this.width + 20) || poly.every((p) => p.y < -20) || poly.every((p) => p.y > this.height + 20)) return;
    const opacity = rt.index === this.active ? 1 : INACTIVE_LAYER_OPACITY;
    const pal = this.palette;
    const base = fogged ? ([0.065, 0.094, 0.153] as Rgb) : terrain === "mountain" ? pal.mountain : terrain === "water" ? pal.water : pal.land;
    const centerDepth = this.projectDepth([x, top, z]).depth;
    commands.push({ depth: centerDepth, paint: () => {
      const ctx = this.ctx;
      if (terrain === "mountain" && poly.length === 4 && corners.every((corner) => this.projectDepth(corner).depth > CAMERA_NEAR)) {
        const bottom = corners.map((p) => this.projectDepth([p[0], y, p[2]]));
        for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0]]) {
          const side = [poly[a], poly[b], bottom[b], bottom[a]];
          this.path(side); ctx.fillStyle = alpha(mix(base, pal.bg, 0.23), opacity); ctx.fill();
          this.strokePoly(side, alpha(pal.mountainLine, opacity * 0.52), 0.6);
        }
      }
      this.path(poly);
      ctx.fillStyle = alpha(base, opacity);
      ctx.fill();
      // A quiet grid makes exact tile positions legible without a bright mesh.
      const edge = terrain === "water" ? pal.waterLine : pal.grid;
      this.strokePoly(poly, alpha(edge, opacity * (terrain === "water" ? 0.5 : Math.max(0.26, pal.gridAlpha))), 0.7);
      if (poly.length === 4 && !fogged) this.terrainDetail(terrain, cell, corners, opacity);
      if (rt.index !== this.active) return;
      if (this.marks.hoverCell && pointKey(this.marks.hoverCell) === pointKey(cell)) { this.path(poly); ctx.fillStyle = alpha(pal.accent, 0.16); ctx.fill(); }
      if (this.marks.selectedPoint && pointKey(this.marks.selectedPoint) === pointKey(cell)) { this.strokePoly(poly, rgbToCss(pal.selOuter), 3); this.strokePoly(poly, rgbToCss(pal.selInner), 1.3); }
    } });
  }
  private drawFigure(fig: Figure, opacity: number): void {
    const ctx = this.ctx;
    const p = this.projectDepth(fig.current);
    const top = this.projectDepth([fig.current[0], fig.current[1] + 0.55 * fig.scale * fig.drawScale, fig.current[2]]);
    if (p.depth <= CAMERA_NEAR || top.depth <= CAMERA_NEAR) return;
    const h = Math.max(3, Math.min(33, Math.abs(top.y - p.y)));
    const size = Math.max(3, Math.min(26, h * 0.82));
    const colour = fig.tint ? mix(fig.colour, this.roleColour(fig.tint), 0.7) : fig.colour;
    const fill = alpha(colour, opacity);
    const edge = alpha(this.palette.bg, opacity * OUTLINE);
    const footY = p.y;
    const x = p.x;
    ctx.save();
    ctx.translate(x, footY);
    ctx.rotate(fig.tilt * 0.32);
    this.ellipse(0, 1.5, size * 0.8, Math.max(1, size * 0.28), alpha(this.palette.outside, opacity * 0.3));
    if (fig.health) this.ellipse(0, 0.5, size * 0.82, Math.max(1.3, size * 0.35), alpha(fig.health, opacity * 0.78));
    ctx.strokeStyle = edge;
    ctx.lineWidth = Math.max(0.6, size * 0.08);
    if (fig.lying) {
      ctx.beginPath(); ctx.roundRect(-size * 0.82, -size * 0.24, size * 1.64, size * 0.4, size * 0.18); ctx.fillStyle = fill; ctx.fill(); ctx.stroke();
      this.ellipse(size * 0.68, -size * 0.06, size * 0.22, size * 0.19, fill);
    } else if (fig.marker.kind === "agent") {
      ctx.beginPath(); ctx.moveTo(-size * 0.64, -size * 0.32); ctx.lineTo(-size * 0.42, -size * 1.34); ctx.quadraticCurveTo(0, -size * 1.72, size * 0.42, -size * 1.34); ctx.lineTo(size * 0.64, -size * 0.32); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.stroke();
      this.ellipse(0, -size * 1.72, size * 0.42, size * 0.42, fill);
    } else if (fig.marker.kind === "plant") {
      ctx.beginPath(); ctx.moveTo(0, -size * 0.16); ctx.lineTo(0, -size * 1.05); ctx.strokeStyle = fill; ctx.lineWidth = Math.max(1.5, size * 0.22); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -size * 2.1); ctx.quadraticCurveTo(size * 1.45, -size * 1.2, 0, -size * 0.85); ctx.quadraticCurveTo(-size * 1.45, -size * 1.2, 0, -size * 2.1); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = edge; ctx.lineWidth = 0.7; ctx.stroke();
    } else if (fig.marker.kind === "fruit") {
      this.ellipse(0, -size * 0.65, size * 0.72, size * 0.7, fill);
      ctx.beginPath(); ctx.moveTo(0, -size * 1.3); ctx.lineTo(size * 0.35, -size * 1.5); ctx.strokeStyle = alpha(this.palette.plant, opacity); ctx.lineWidth = 1.4; ctx.stroke();
    } else if (fig.marker.kind === "seed") {
      ctx.beginPath(); ctx.moveTo(0, -size * 1.1); ctx.lineTo(size * 0.55, -size * 0.24); ctx.lineTo(0, 0); ctx.lineTo(-size * 0.55, -size * 0.24); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.stroke();
    } else {
      this.ellipse(0, -size * 0.14, size * 0.8, Math.max(1.5, size * 0.35), fill);
    }
    ctx.restore();
  }
  private ring(position: Vec3, radius: number, colour: Rgb, opacity: number, width = 1.7, dashed = false): void {
    const ctx = this.ctx;
    const count = 40;
    let drawn = 0;
    ctx.beginPath();
    for (let i = 0; i <= count; i++) {
      const a = i * Math.PI * 2 / count;
      const p = this.projectDepth([position[0] + Math.cos(a) * radius, position[1] + 0.025, position[2] + Math.sin(a) * radius]);
      if (p.depth <= CAMERA_NEAR) continue;
      if (drawn++ === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    if (drawn < 3) return;
    ctx.strokeStyle = alpha(colour, opacity);
    ctx.lineWidth = width;
    ctx.setLineDash(dashed ? [4, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  private paintMarks(): void {
    const m = this.marks;
    const mark = (id: string | null, colour: Rgb, radius: number, dashed = false) => {
      const f = this.findFigure(id);
      if (f) this.ring(f.current, Math.max(0.33, f.scale * radius), colour, 0.94, 1.7, dashed);
    };
    mark(m.highlightAgentId, this.palette.highlight, 0.48, true);
    mark(m.selectedEntityId, this.palette.entitySel, 0.55);
    if (m.hoverEntityId !== m.selectedEntityId) mark(m.hoverEntityId, this.palette.fg, 0.53);
    mark(this.options.selfId, this.palette.accent, 0.66, true);
  }
  private paintArrow(a: Screen, b: Screen, progress: number, colour: Rgb, opacity: number, width: number): void {
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 3) return;
    const t = Math.max(0, Math.min(1, progress));
    const u = Math.max(0, t - Math.min(0.24, 17 / length));
    const head = { x: a.x + dx * t, y: a.y + dy * t };
    const tail = { x: a.x + dx * u, y: a.y + dy * u };
    this.line(a, b, alpha(colour, opacity * 0.24), Math.max(1, width * 0.65));
    this.line({ ...tail, depth: a.depth, visible: true }, { ...head, depth: a.depth, visible: true }, alpha(colour, opacity), width);
    const ux = dx / length, uy = dy / length;
    const back = Math.max(5, Math.min(9, width * 2.4));
    const ctx = this.ctx;
    ctx.beginPath(); ctx.moveTo(head.x, head.y);
    ctx.lineTo(head.x - ux * back - uy * back * 0.5, head.y - uy * back + ux * back * 0.5);
    ctx.lineTo(head.x - ux * back + uy * back * 0.5, head.y - uy * back - ux * back * 0.5);
    ctx.closePath(); ctx.fillStyle = alpha(colour, opacity); ctx.fill();
  }
  /** A short target burst reinforces the actor's lunge during an attack. */
  private paintImpacts(): void {
    if (!this.timelineRunning) return;
    const ctx = this.ctx;
    for (const fig of this.layers[this.active]?.figures ?? []) {
      if (fig.tint !== "bad") continue;
      const target = this.projectDepth([fig.current[0], fig.current[1] + 0.43 * fig.scale, fig.current[2]]);
      if (!target.visible) continue;
      const r = Math.max(13, Math.min(24, 0.34 * this.height / target.depth));
      const colour = alpha(this.palette.bad, 0.8);
      ctx.save(); ctx.translate(target.x, target.y);
      ctx.beginPath(); ctx.arc(0, 0, r * 0.72, 0, Math.PI * 2);
      ctx.strokeStyle = alpha(this.palette.bad, 0.5); ctx.lineWidth = 1.7; ctx.stroke();
      for (let i = 0; i < 6; i++) {
        const angle = Math.PI * (i / 3 + 0.125);
        ctx.beginPath(); ctx.moveTo(Math.cos(angle) * r * 0.83, Math.sin(angle) * r * 0.83);
        ctx.lineTo(Math.cos(angle) * r * 1.12, Math.sin(angle) * r * 1.12);
        ctx.strokeStyle = colour; ctx.lineWidth = 1.9; ctx.stroke();
      }
      ctx.restore();
    }
  }
  private paintFx(): void {
    for (const fx of this.fx) {
      const colour = this.roleColour(fx.colour);
      if (fx.kind === "ripple" || fx.kind === "pulse" || fx.kind === "puff") {
        this.ring(fx.position, Math.max(0.05, fx.radius), colour, fx.opacity, fx.kind === "pulse" ? 2.3 : 1.6);
      } else if (fx.kind === "beam" || fx.kind === "trail") {
        const a = this.projectDepth(add(fx.from, [0, fx.kind === "beam" ? 0.3 : 0.05, 0]));
        const b = this.projectDepth(add(fx.to, [0, fx.kind === "beam" ? 0.3 : 0.05, 0]));
        if (a.depth > CAMERA_NEAR && b.depth > CAMERA_NEAR) {
          this.paintArrow(a, b, fx.progress, colour, fx.opacity, fx.kind === "beam" ? 2.6 : 2.2);
        }
      } else if (fx.kind === "particles") {
        const a = this.projectDepth(add(fx.from, [0, 0.24, 0]));
        const b = this.projectDepth(add(fx.to, [0, 0.24, 0]));
        if (a.depth > CAMERA_NEAR && b.depth > CAMERA_NEAR) this.paintArrow(a, b, fx.progress, colour, fx.opacity * 0.7, 1.5);
        for (let k = 0; k < 6; k++) {
          const t = Math.min(1, Math.max(0, fx.progress - k * 0.055));
          const p = this.projectDepth([fx.from[0] + (fx.to[0] - fx.from[0]) * t, fx.from[1] + (fx.to[1] - fx.from[1]) * t + 0.22 + Math.sin(Math.PI * t) * 0.18, fx.from[2] + (fx.to[2] - fx.from[2]) * t]);
          if (p.visible) this.ellipse(p.x, p.y, Math.max(1.4, 3.2 - k * 0.3), Math.max(1.4, 3.2 - k * 0.3), alpha(colour, fx.opacity * (1 - k * 0.1)));
        }
      } else if (fx.kind === "quad") {
        const p = this.projectDepth(fx.position);
        if (p.visible) this.ellipse(p.x, p.y, 11, 5, alpha(colour, fx.opacity * 0.42));
      }
    }
  }
  private paintColumn(rt: LayerRuntime, list: MapMarker[], opacity: number): void {
    const cell = list[0].position;
    const base = cellToScene(cell, rt.index);
    const bottom = this.projectDepth(base);
    const top = this.projectDepth([base[0], base[1] + columnHeight(list.length), base[2]]);
    if (bottom.depth <= CAMERA_NEAR || top.depth <= CAMERA_NEAR) return;
    const radius = Math.max(2.5, Math.min(12, 0.23 * (this.height / 2) / Math.tan((FOV_DEG * Math.PI) / 360) / bottom.depth));
    let rgb = kindColour(dominantKind(list) ?? "residue", this.palette);
    if (this.options.ghost) rgb = ghostTint(rgb, this.palette);
    const ctx = this.ctx;
    const height = Math.max(radius, bottom.y - top.y);
    ctx.save();
    ctx.beginPath(); ctx.roundRect(bottom.x - radius, top.y, radius * 2, height, radius * 0.5); ctx.clip();
    const counts = new Map<ReturnType<typeof figureKind>, number>();
    for (const marker of list) { const kind = figureKind(marker); counts.set(kind, (counts.get(kind) ?? 0) + 1); }
    let used = 0;
    for (const [kind, count] of counts) {
      const segment = height * count / list.length;
      ctx.fillStyle = alpha(this.options.ghost ? ghostTint(kindColour(kind, this.palette), this.palette) : kindColour(kind, this.palette), opacity);
      ctx.fillRect(bottom.x - radius, bottom.y - used - segment, radius * 2, segment + 0.5);
      used += segment;
    }
    ctx.restore();
    this.ellipse(bottom.x, top.y, radius, radius * 0.45, alpha(mix(rgb, this.palette.fg, 0.16), opacity));
    if (rt.index === this.active) this.picks.push({ x: bottom.x, y: (bottom.y + top.y) / 2, radius: Math.max(radius + 4, Math.abs(bottom.y - top.y) / 2), depth: bottom.depth, id: list[0].id, cell });
  }
  private paintBoard(): number {
    const ctx = this.ctx;
    ctx.fillStyle = rgbToCss(this.palette.outside);
    ctx.fillRect(0, 0, this.width, this.height);
    this.picks = [];
    const commands: Draw[] = [];
    for (const rt of this.layers) {
      const r = rt.input.map.region;
      for (let y = r.min_y; y <= r.max_y; y++) for (let x = r.min_x; x <= r.max_x; x++) this.tile(rt, { x, y }, commands);
      const opacity = rt.index === this.active ? 1 : INACTIVE_LAYER_OPACITY;
      if (this.lod === "columns") {
        for (const list of rt.byCell.values()) {
          const depth = this.projectDepth(cellToScene(list[0].position, rt.index)).depth;
          if (depth > CAMERA_NEAR) commands.push({ depth: depth - 0.015, paint: () => this.paintColumn(rt, list, opacity) });
        }
      } else {
        for (const fig of rt.figures) {
          const projected = this.projectDepth(fig.current);
          if (projected.depth <= CAMERA_NEAR || projected.x < -40 || projected.x > this.width + 40 || projected.y < -50 || projected.y > this.height + 40) continue;
          commands.push({ depth: projected.depth - 0.015, paint: () => {
            this.drawFigure(fig, opacity);
            if (rt.index === this.active) {
              const size = Math.max(5, Math.min(25, 0.32 * (this.height / 2) / Math.tan((FOV_DEG * Math.PI) / 360) * fig.scale / projected.depth));
              this.picks.push({ x: projected.x, y: projected.y - size * 0.7, radius: Math.max(5, size * 1.4), depth: projected.depth, id: fig.id, cell: fig.cell });
            }
          } });
        }
      }
    }
    commands.sort((a, b) => b.depth - a.depth);
    for (const command of commands) command.paint();
    this.paintMarks();
    this.paintFx();
    this.paintImpacts();
    return commands.length;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused && this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    else if (!paused) this.invalidate();
  }
  invalidate(): void { this.dirty = true; this.schedule(); }
  private schedule(): void {
    if (this.inFrame || this.paused || this.disposed || this.rafId) return;
    this.rafId = requestAnimationFrame(this.frame);
  }
  private readonly frame = (now: number): void => {
    this.rafId = 0;
    if (this.paused || this.disposed) return;
    if (this.lastFrameClock > 0 && performance.now() - this.lastFrameClock < FRAME_SPACING_MS) { this.schedule(); return; }
    this.inFrame = true;
    try {
      const start = performance.now();
      const dt = this.lastFrameStart ? now - this.lastFrameStart : 16;
      this.lastFrameStart = now;
      this.lastFrameClock = start;
      this.lastMore = this.hooks.beforeFrame(now, dt);
      this.sample(start);
      this.dirty = false;
      const calls = this.paintBoard();
      const shown = this.labels.sync(this.labelItems(), (p) => this.projectDepth(p), this.width, this.height);
      this.labels.setCompass(this.cameraState.yaw);
      this.lastStats = { drawCalls: calls, triangles: 0, frameMs: performance.now() - start, lod: this.lod, animating: this.timelineRunning, labels: shown, camera: this.cameraState };
      this.hooks.onFrame(this.lastStats);
    } finally { this.inFrame = false; }
    if (this.lastMore || this.timelineRunning || this.dirty) this.schedule();
  };

  private labelItems(): LabelItem[] {
    const items: LabelItem[] = [];
    const rt = this.layers[this.active];
    if (!rt) return items;
    const cam = this.cameraState;
    const m = this.marks;
    const columns = this.lod === "columns";
    const chipFigures = new Set<string>();
    for (const chip of this.chips) if (chip.id) chipFigures.add(chip.id);
    const labelled = new Set<string>();
    if (!columns) for (const fig of rt.figures) {
      const marker = fig.marker;
      const focus = fig.id === m.hoverEntityId || fig.id === m.selectedEntityId;
      const living = marker.kind === "agent" && !marker.dead;
      if (!living && !focus) continue;
      const d = Math.hypot(fig.current[0] - cam.x, fig.current[1] - cam.y, fig.current[2] - cam.z);
      if (!focus && d > LABEL_FAR) continue;
      labelled.add(fig.id);
      let content: string;
      let shortText: string | undefined;
      if (marker.kind === "agent") {
        const e = rt.input.entities.get(fig.id);
        const name = e?.kind === "agent" ? e.name : marker.title.replace(/\s*\(.*\)$/, "");
        content = d > LABEL_NAME_DISTANCE && !focus ? fig.id : `${fig.id} ${name}`;
        if (content !== fig.id) shortText = fig.id;
      } else content = dotLabel(marker);
      items.push({ key: `label:${fig.id}`, kind: "label", position: [fig.current[0], fig.current[1] + LABEL_HEIGHT[fig.marker.kind] * fig.scale, fig.current[2]], text: content, shortText, pinned: focus, title: `${marker.title} · ${marker.line}`, attrs: { entityId: fig.id, cell: pointKey(fig.cell) }, className: focus ? "map3d-label-focus" : undefined, anchor: "bottom", priority: focus ? 3 : chipFigures.has(fig.id) ? 4.5 : 2, entityId: fig.id, cell: fig.cell });
    }
    const y = layerY(this.active);
    for (const [key, list] of rt.byCell) {
      const n = list.length;
      const badge = columns ? n >= 2 ? String(n) : null : countBadge(n);
      if (!badge) continue;
      const c = cellToScene(list[0].position, 0);
      items.push({ key: `badge:${key}`, kind: "badge", position: [c[0], y + (columns ? columnHeight(n) + 0.15 : 0.8), c[2]], text: badge, title: `${n} occupants at (${list[0].position.x}, ${list[0].position.y})`, attrs: { cell: key }, anchor: "center", priority: 5.5 });
    }
    this.chips.forEach((chip, i) => {
      const e = chip.effect;
      const fig = this.findFigure(chip.id);
      const anchor = fig ? [fig.current[0], fig.current[1] + CHIP_HEIGHT, fig.current[2]] : chip.position;
      const glyph = glyphFor(e.kind, e.ok);
      items.push({ key: `chip:${i}:${e.kind}:${e.actor}`, kind: "chip", position: [anchor[0], anchor[1], anchor[2]], text: chipText(e), title: `${e.actor} ${e.label}`, className: `map3d-chip-${e.kind}${e.ok ? "" : " map3d-chip-failed"}`, attrs: { effectKind: e.kind, actor: e.actor, glyph: glyph.label }, glyph: glyph.path, anchor: "bottom", priority: 4, nudges: chip.id && labelled.has(chip.id) ? CHIP_NUDGES : 0 });
    });
    for (const f of this.floats) items.push(f);
    for (const t of this.ticks) items.push(t);
    return items;
  }
  /** Release the canvas and label pool. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.layers = [];
    this.picks = [];
    this.labels.clear();
  }
}
