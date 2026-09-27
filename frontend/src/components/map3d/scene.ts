/**
 * The 3D board's scene: the WebGL renderer, lights, one group per layer
 * (merged terrain, grid, border, six instanced figure meshes, far-LOD
 * columns), the rings and cell marks, the pooled transient effects, the
 * raycaster, the demand-driven frame loop, the level of detail and the
 * per-frame statistics the QA root reads.  Everything that is not three.js
 * arithmetic comes from the pure modules under src/state/ (map3dLayout,
 * map3dCamera, map3dTimeline, map3dTerrain, map3dPalette, map3dGlyphs):
 * this class only applies their results to GPU objects.
 *
 * Rendering is on demand: invalidate() schedules one frame; a frame reschedules
 * itself only while a key is held, a glide or a timeline runs (the view says so
 * through hooks.beforeFrame).  Paused (the record overlay, a hidden tab): no
 * frames at all.  dispose() frees every geometry, material and the GL context.
 */

// DOCS: draw calls per layer: terrain 1, grid 1, border 1, figures <= 6 (or columns 1 in the far LOD), rings <= 4, cell marks 2, effects <= 5; the outside plane 1.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  Group,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Object3D } from "three";
import type { Agent, Entity, MapState, Plant, Point } from "../../api/types";
import { pointKey } from "../../api/types";
import type { CameraState } from "../../state/map3dCamera";
import { CAMERA_FAR, CAMERA_NEAR, FOV_DEG, lodDistance } from "../../state/map3dCamera";
import { chipText, glyphFor } from "../../state/map3dGlyphs";
import type { LodMode, Vec3 } from "../../state/map3dLayout";
import { COUNT_BADGE_MIN, INACTIVE_LAYER_OPACITY, cellToScene, columnHeight, countBadge, layerY, lodMode, orderForSlots, packCell, slotScenePosition } from "../../state/map3dLayout";
import type { Palette, Rgb } from "../../state/map3dPalette";
import { dominantKind, ghostTint, healthColour, kindColour, plantColour, terrainPalette } from "../../state/map3dPalette";
import type { ClipColour, FxState, Timeline, TimelineContext } from "../../state/map3dTimeline";
import { CHIP_HEIGHT, PARTICLE_COUNT, buildTimeline, chipPlacements, sampleTimeline, scaleTimeline } from "../../state/map3dTimeline";
import type { TerrainArrays } from "../../state/map3dTerrain";
import { cellOfFace } from "../../state/map3dTerrain";
import type { TurnEffect } from "../../state/turnEffects";
import type { MapMarker } from "../inspect/logic";
import { groupMarkersByPoint } from "../inspect/logic";
import type { DotKind } from "../inspect/mapDots";
import { dotKind, dotLabel } from "../inspect/mapDots";
import type { FigureGeometries, FigureMeshKey } from "./geometry";
import { DEAD_LIFT, FIGURE_MESH_KEYS, LABEL_HEIGHT, buildBorderGeometry, buildFigureGeometries, buildGridGeometry, buildTerrainGeometry, disposeFigureGeometries, linear, recolourCellFrame } from "./geometry";
import type { LabelItem } from "./labels";
import { CHIP_NUDGES, LabelLayer } from "./labels";

/** One board of the stack, as the view hands it over. */
export interface SceneLayer {
  id: string;
  label: string;
  map: MapState;
  markers: readonly MapMarker[];
  entities: ReadonlyMap<string, Entity>;
}

export interface LayerOptions {
  /** Ids placed first in their cells (the acting and the selected entity). */
  priorityIds: readonly (string | null | undefined)[];
  /** Legend toggles: kinds not drawn. */
  hiddenKinds: ReadonlySet<DotKind>;
  /** Agent view: figures are remembered sightings, drawn ghosted and without health discs. */
  ghost: boolean;
  /** Agent view: the viewing agent (a dashed ring under it). */
  selfId: string | null;
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
  /** Runs before each frame; returns true when another frame is wanted (a key held, a glide running). */
  beforeFrame(nowMs: number, dtMs: number): boolean;
  onFrame(stats: FrameStats): void;
  /** A label was clicked. */
  onPick(id: string, cell: Point): void;
  /** The level of detail changed. */
  onLod(lod: LodMode): void;
}

/** Longest mean frame time (ms, last 10 frames) before the pixel ratio drops to 1. */
const SLOW_FRAME_MS = 45;
/** Beyond this camera distance the grid is hidden on a slow renderer. */
const GRID_FAR = 40;
/** Awake frames on a software renderer are spaced at least this far apart (at most every second vsync at 60 Hz). */
const SOFTWARE_FRAME_MS = 33;
/** Timing jitter tolerated when a vsync is checked against SOFTWARE_FRAME_MS. */
const FRAME_JITTER_MS = 1.5;
/** Labels show the agent's name within this distance and only its id beyond; hidden beyond LABEL_FAR. */
const LABEL_NAME_DISTANCE = 30;
const LABEL_FAR = 60;
/** Speed of the acting ring's rotation, radians per second (only while frames are drawn anyway). */
const ACTING_RING_SPEED = Math.PI / 6;

interface Figure {
  id: string;
  marker: MapMarker;
  layer: number;
  mesh: FigureMeshKey;
  index: number;
  /** Absolute scene position of the figure's foot (layer height included). */
  base: Vec3;
  /** base plus the running animation's offset (labels and chips follow it). */
  current: Vec3;
  scale: number;
  lying: boolean;
  colour: Color;
  discIndex: number;
  cell: Point;
}

interface LayerRuntime {
  input: SceneLayer;
  index: number;
  group: Group;
  terrain: Mesh;
  arrays: TerrainArrays;
  grid: LineSegments;
  border: LineSegments;
  terrainMat: MeshLambertMaterial;
  gridMat: LineBasicMaterial;
  borderMat: LineBasicMaterial;
  figureMat: MeshLambertMaterial;
  columnMat: MeshLambertMaterial;
  meshes: Record<FigureMeshKey, InstancedMesh>;
  ids: Record<FigureMeshKey, string[]>;
  columns: InstancedMesh;
  columnCells: Point[];
  /** Visible markers per "x,y" in slot order. */
  byCell: Map<string, MapMarker[]>;
}

interface FxPool {
  rings: Mesh[];
  ringMats: MeshBasicMaterial[];
  beams: LineSegments;
  beamMat: LineBasicMaterial;
  trails: LineSegments;
  trailMat: LineBasicMaterial;
  particles: Points;
  particleMat: PointsMaterial;
  quad: Mesh;
  quadMat: MeshBasicMaterial;
}

const BEAM_CAPACITY = 32;
const TRAIL_CAPACITY = 8;
const PARTICLE_STREAMS = 8;
const RING_POOL = 4;

const OUTSIDE_Y = -0.2;

function plantScale(entity: Entity | undefined): number {
  if (!entity || entity.kind !== "plant") return 1;
  const size = (entity as Plant).size;
  if (!Number.isFinite(size)) return 1;
  return Math.min(1.6, Math.max(0.7, 0.4 + 0.3 * size));
}

export class Scene3d {
  readonly renderer: WebGLRenderer;
  readonly rendererName: string;
  readonly software: boolean;
  readonly camera: PerspectiveCamera;
  private readonly scene = new Scene();
  private readonly hooks: SceneHooks;
  private readonly labels: LabelLayer;
  private readonly geometries: FigureGeometries;
  private palette: Palette;
  private layers: LayerRuntime[] = [];
  private figures = new Map<string, Figure>();
  private active = 0;
  private options: LayerOptions = { priorityIds: [], hiddenKinds: new Set(), ghost: false, selfId: null };
  private marks: Marks = { selectedPoint: null, selectedEntityId: null, highlightAgentId: null, hoverEntityId: null, hoverCell: null };
  private cameraState: CameraState = { x: 0, y: 10, z: 10, yaw: 0, pitch: -0.8 };
  private lod: LodMode = "figures";
  private readonly hemi: HemisphereLight;
  private readonly sun: DirectionalLight;
  private readonly outside: Mesh;
  private readonly outsideMat: MeshBasicMaterial;
  private readonly ringActing: Mesh;
  private readonly ringSelected: Mesh;
  private readonly ringHover: Mesh;
  private readonly ringSelf: Mesh;
  private readonly hoverQuad: Mesh;
  private readonly cellFrame: LineSegments;
  private readonly fx: FxPool;
  private chips: { effect: TurnEffect; id: string | null; position: Vec3 }[] = [];
  private ticks: LabelItem[] = [];
  private timeline: Timeline | null = null;
  private timelineStart = 0;
  private timelineRunning = false;
  private touched = new Set<string>();
  private floats: LabelItem[] = [];
  private width = 1;
  private height = 1;
  private dirty = false;
  private paused = false;
  private rafId = 0;
  /** True while frame() runs: schedule() calls from inside it only mark the frame dirty (frame() reschedules once at its end). */
  private inFrame = false;
  /** Whether the last frame's hooks asked for another frame (a key held, a glide running). */
  private lastMore = false;
  /** rAF timestamp of the last frame (for dt). */
  private lastFrameStart = 0;
  /** performance.now() when the last frame began (the software frame spacing; rAF timestamps can lag a vsync). */
  private lastFrameClock = 0;
  private frameTimes: number[] = [];
  private slow = false;
  private disposed = false;
  private readonly raycaster = new Raycaster();
  private readonly tmpM = new Matrix4();
  private readonly tmpV = new Vector3();
  private readonly tmpS = new Vector3();
  private readonly tmpQ = new Quaternion();
  private readonly tmpE = new Euler();
  private readonly tmpC = new Color();
  private lastStats: FrameStats;

  constructor(canvas: HTMLCanvasElement, labelsRoot: HTMLElement, palette: Palette, hooks: SceneHooks) {
    this.hooks = hooks;
    this.palette = palette;
    const probe = new WebGLRenderer({ canvas, antialias: false, powerPreference: "low-power", alpha: false });
    const gl = probe.getContext();
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    this.rendererName = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    this.software = /SwiftShader|llvmpipe|Software/i.test(this.rendererName);
    this.renderer = probe;
    this.renderer.setPixelRatio(this.software ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.info.autoReset = true;
    this.camera = new PerspectiveCamera(FOV_DEG, 1, CAMERA_NEAR, CAMERA_FAR);
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.camera);
    this.hemi = new HemisphereLight(0xffffff, 0x9a9a9a, 1.1);
    this.sun = new DirectionalLight(0xffffff, 0.8);
    this.sun.position.set(1, 2, 1);
    this.scene.add(this.hemi, this.sun);
    this.geometries = buildFigureGeometries();
    this.outsideMat = new MeshBasicMaterial({ color: linear(palette.outside) });
    this.outside = new Mesh(new PlaneGeometry(600, 600).rotateX(-Math.PI / 2), this.outsideMat);
    this.outside.position.y = OUTSIDE_Y;
    this.outside.renderOrder = -1;
    this.scene.add(this.outside);
    this.ringActing = new Mesh(this.geometries.dashedRing, new MeshBasicMaterial({ color: linear(palette.highlight), side: DoubleSide }));
    this.ringSelected = new Mesh(this.geometries.ring, new MeshBasicMaterial({ color: linear(palette.entitySel), side: DoubleSide }));
    this.ringHover = new Mesh(this.geometries.ring, new MeshBasicMaterial({ color: linear(palette.fg), side: DoubleSide }));
    this.ringSelf = new Mesh(this.geometries.dashedRing, new MeshBasicMaterial({ color: linear(palette.accent), side: DoubleSide }));
    this.hoverQuad = new Mesh(this.geometries.hoverQuad, new MeshBasicMaterial({ color: linear(palette.accent), transparent: true, opacity: 0.25, side: DoubleSide, depthWrite: false }));
    this.cellFrame = new LineSegments(this.geometries.cellFrame, new LineBasicMaterial({ vertexColors: true }));
    recolourCellFrame(this.geometries.cellFrame, palette.selInner, palette.selOuter);
    for (const o of [this.ringActing, this.ringSelected, this.ringHover, this.ringSelf, this.hoverQuad, this.cellFrame]) {
      o.visible = false;
      o.frustumCulled = false;
      this.scene.add(o);
    }
    this.fx = this.buildFxPool();
    this.labels = new LabelLayer(labelsRoot, (id, cell) => this.hooks.onPick(id, cell));
    this.renderer.setClearColor(linear(palette.bg), 1);
    this.lastStats = { drawCalls: 0, triangles: 0, frameMs: 0, lod: this.lod, animating: false, labels: 0, camera: this.cameraState };
  }

  // ------------------------------------------------------------------ pools

  private buildFxPool(): FxPool {
    const rings: Mesh[] = [];
    const ringMats: MeshBasicMaterial[] = [];
    for (let i = 0; i < RING_POOL; i++) {
      const mat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: DoubleSide, depthWrite: false });
      const mesh = new Mesh(this.geometries.fxRing, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      rings.push(mesh);
      ringMats.push(mat);
    }
    const dyn = (verts: number) => {
      const g = new BufferGeometry();
      const attr = new BufferAttribute(new Float32Array(verts * 3), 3);
      attr.setUsage(DynamicDrawUsage);
      g.setAttribute("position", attr);
      g.setDrawRange(0, 0);
      return g;
    };
    const beamMat = new LineBasicMaterial({ color: linear(this.palette.accent), transparent: true, opacity: 1, depthWrite: false });
    const beams = new LineSegments(dyn(BEAM_CAPACITY * 2), beamMat);
    const trailMat = new LineBasicMaterial({ color: linear(this.palette.fg), transparent: true, opacity: 1, depthWrite: false });
    const trails = new LineSegments(dyn(TRAIL_CAPACITY * 2), trailMat);
    const particleMat = new PointsMaterial({ color: linear(this.palette.warn), size: 0.09, sizeAttenuation: true, transparent: true, opacity: 1, depthWrite: false });
    const particles = new Points(dyn(PARTICLE_STREAMS * PARTICLE_COUNT), particleMat);
    const quadMat = new MeshBasicMaterial({ color: linear(this.palette.accent), transparent: true, opacity: 0.5, side: DoubleSide, depthWrite: false });
    const quad = new Mesh(this.geometries.fxQuad, quadMat);
    for (const o of [beams, trails, particles, quad]) {
      o.visible = false;
      o.frustumCulled = false;
      this.scene.add(o);
    }
    return { rings, ringMats, beams, beamMat, trails, trailMat, particles, particleMat, quad, quadMat };
  }

  // ------------------------------------------------------------------ size, palette, camera

  /** Resize the drawing buffer to the viewport's CSS size. */
  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  /** Re-read colours (a theme change): terrain, lines, figures, rings, lights and the clear colour. */
  setPalette(palette: Palette): void {
    this.palette = palette;
    this.renderer.setClearColor(linear(palette.bg), 1);
    this.outsideMat.color.copy(linear(palette.outside));
    (this.ringActing.material as MeshBasicMaterial).color.copy(linear(palette.highlight));
    (this.ringSelected.material as MeshBasicMaterial).color.copy(linear(palette.entitySel));
    (this.ringHover.material as MeshBasicMaterial).color.copy(linear(palette.fg));
    (this.ringSelf.material as MeshBasicMaterial).color.copy(linear(palette.accent));
    (this.hoverQuad.material as MeshBasicMaterial).color.copy(linear(palette.accent));
    recolourCellFrame(this.geometries.cellFrame, palette.selInner, palette.selOuter);
    this.fx.beamMat.color.copy(linear(palette.accent));
    this.fx.trailMat.color.copy(linear(palette.fg));
    this.fx.particleMat.color.copy(linear(palette.warn));
    this.fx.quadMat.color.copy(linear(palette.accent));
    if (this.layers.length > 0) this.setLayers(this.layers.map((l) => l.input), this.active, this.options);
    this.invalidate();
  }

  getCamera(): CameraState {
    return this.cameraState;
  }

  /** Move the camera to `state` (scene units, radians) and mark the frame dirty. */
  setCamera(state: CameraState): void {
    this.cameraState = state;
    this.camera.position.set(state.x, state.y, state.z);
    this.camera.rotation.set(state.pitch, -state.yaw, 0);
    this.camera.updateMatrixWorld();
    const lod = lodMode(lodDistance(state, layerY(this.active)), this.lod);
    if (lod !== this.lod) {
      this.lod = lod;
      this.applyLod();
      this.hooks.onLod(lod);
    }
    this.invalidate();
  }

  get currentLod(): LodMode {
    return this.lod;
  }

  get stats(): FrameStats {
    return this.lastStats;
  }

  get animating(): boolean {
    return this.timelineRunning;
  }

  // ------------------------------------------------------------------ layers

  /** Replace the boards: one group per layer, `active` drawn opaque and pickable. */
  setLayers(layers: readonly SceneLayer[], active: number, options: LayerOptions): void {
    this.snapTimeline();
    for (const rt of this.layers) this.disposeLayer(rt);
    this.layers = layers.map((input, index) => this.buildLayer(input, index));
    this.options = options;
    this.active = Math.min(Math.max(0, active), Math.max(0, layers.length - 1));
    this.figures = new Map();
    for (const rt of this.layers) this.rebuildFigures(rt);
    this.applyLayerOpacity();
    this.applyLod();
    this.buildTicks();
    this.applyMarks();
    this.refreshChips();
    this.invalidate();
  }

  /** Switch the active layer (opacity, picking, labels) without rebuilding the boards. */
  setActiveLayer(active: number): void {
    const next = Math.min(Math.max(0, active), Math.max(0, this.layers.length - 1));
    if (next === this.active) return;
    this.active = next;
    this.applyLayerOpacity();
    this.buildTicks();
    this.applyMarks();
    this.refreshChips();
    const lod = lodMode(lodDistance(this.cameraState, layerY(this.active)), this.lod);
    if (lod !== this.lod) {
      this.lod = lod;
      this.applyLod();
      this.hooks.onLod(lod);
    }
    this.invalidate();
  }

  get activeLayer(): number {
    return this.active;
  }

  /** The active layer's visible markers at a cell, in slot order (empty when the cell is empty). */
  markersAt(cell: Point): MapMarker[] {
    const rt = this.layers[this.active];
    return rt ? (rt.byCell.get(pointKey(cell)) ?? []) : [];
  }

  private buildLayer(input: SceneLayer, index: number): LayerRuntime {
    const group = new Group();
    group.position.y = layerY(index);
    const pal = this.palette;
    const { geometry, arrays } = buildTerrainGeometry(input.map, terrainPalette(pal));
    const terrainMat = new MeshLambertMaterial({ vertexColors: true });
    const terrain = new Mesh(geometry, terrainMat);
    terrain.frustumCulled = false;
    const gridMat = new LineBasicMaterial({ color: linear(pal.grid), transparent: true, opacity: pal.gridAlpha, depthWrite: false });
    const grid = new LineSegments(buildGridGeometry(input.map), gridMat);
    grid.frustumCulled = false;
    const originColour: Rgb = [pal.fg[0] * 0.18 + pal.bg[0] * 0.82, pal.fg[1] * 0.18 + pal.bg[1] * 0.82, pal.fg[2] * 0.18 + pal.bg[2] * 0.82];
    const borderMat = new LineBasicMaterial({ vertexColors: true });
    const border = new LineSegments(buildBorderGeometry(input.map, pal.border, originColour), borderMat);
    border.frustumCulled = false;
    const figureMat = new MeshLambertMaterial({ color: 0xffffff });
    const columnMat = new MeshLambertMaterial({ color: 0xffffff });
    const meshes = {} as Record<FigureMeshKey, InstancedMesh>;
    const ids = {} as Record<FigureMeshKey, string[]>;
    for (const key of FIGURE_MESH_KEYS) {
      meshes[key] = this.makeInstanced(this.geometries.figures[key], figureMat, 16);
      ids[key] = [];
      group.add(meshes[key]);
    }
    const columns = this.makeInstanced(this.geometries.column, columnMat, 16);
    columns.visible = false;
    group.add(terrain, grid, border, columns);
    this.scene.add(group);
    return { input, index, group, terrain, arrays, grid, border, terrainMat, gridMat, borderMat, figureMat, columnMat, meshes, ids, columns, columnCells: [], byCell: new Map() };
  }

  private makeInstanced(geometry: BufferGeometry, material: MeshLambertMaterial, capacity: number): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    return mesh;
  }

  private ensureCapacity(rt: LayerRuntime, key: FigureMeshKey | "columns", needed: number): InstancedMesh {
    const current = key === "columns" ? rt.columns : rt.meshes[key];
    if (current.instanceMatrix.count >= needed) return current;
    const capacity = Math.max(16, Math.ceil(needed * 1.5));
    const geometry = key === "columns" ? this.geometries.column : this.geometries.figures[key];
    const material = key === "columns" ? rt.columnMat : rt.figureMat;
    const next = this.makeInstanced(geometry, material, capacity);
    next.visible = current.visible;
    rt.group.remove(current);
    current.dispose();
    rt.group.add(next);
    if (key === "columns") rt.columns = next;
    else rt.meshes[key] = next;
    return next;
  }

  private disposeLayer(rt: LayerRuntime): void {
    this.scene.remove(rt.group);
    rt.terrain.geometry.dispose();
    rt.grid.geometry.dispose();
    rt.border.geometry.dispose();
    rt.terrainMat.dispose();
    rt.gridMat.dispose();
    rt.borderMat.dispose();
    rt.figureMat.dispose();
    rt.columnMat.dispose();
    for (const key of FIGURE_MESH_KEYS) rt.meshes[key].dispose();
    rt.columns.dispose();
  }

  private applyLayerOpacity(): void {
    for (const rt of this.layers) {
      const activeLayer = rt.index === this.active;
      const opacity = activeLayer ? 1 : INACTIVE_LAYER_OPACITY;
      for (const mat of [rt.terrainMat, rt.figureMat, rt.columnMat]) {
        mat.transparent = !activeLayer;
        mat.opacity = opacity;
        mat.depthWrite = activeLayer;
        mat.needsUpdate = true;
      }
      rt.gridMat.opacity = this.palette.gridAlpha * opacity;
      rt.borderMat.transparent = !activeLayer;
      rt.borderMat.opacity = opacity;
      rt.borderMat.needsUpdate = true;
    }
  }

  private applyLod(): void {
    const columns = this.lod === "columns";
    for (const rt of this.layers) {
      for (const key of FIGURE_MESH_KEYS) rt.meshes[key].visible = !columns;
      rt.columns.visible = columns;
    }
    this.invalidate();
  }

  /** Rebuild one layer's instances from its markers (called on layers, hidden kinds, priority ids and theme changes). */
  private rebuildFigures(rt: LayerRuntime): void {
    const { hiddenKinds, priorityIds, ghost } = this.options;
    const pal = this.palette;
    const visible = rt.input.markers.filter((m) => !hiddenKinds.has(dotKind(m)));
    const grouped = groupMarkersByPoint(visible);
    const counts: Record<FigureMeshKey, number> = { disc: 0, agent: 0, plant: 0, fruit: 0, seed: 0, residue: 0 };
    const ordered = new Map<string, MapMarker[]>();
    for (const [key, list] of grouped) {
      const sorted = orderForSlots(list, priorityIds);
      ordered.set(key, sorted);
      for (const m of sorted) {
        counts[m.kind] += 1;
        if (m.kind === "agent" && !m.dead && !ghost && rt.input.entities.get(m.id)?.kind === "agent") counts.disc += 1;
      }
    }
    for (const key of FIGURE_MESH_KEYS) {
      this.ensureCapacity(rt, key, counts[key]);
      rt.ids[key] = [];
    }
    this.ensureCapacity(rt, "columns", ordered.size);
    const next: Record<FigureMeshKey, number> = { disc: 0, agent: 0, plant: 0, fruit: 0, seed: 0, residue: 0 };
    const yOffset = layerY(rt.index);
    for (const [, list] of ordered) {
      const cell = list[0].position;
      const slots = packCell(list.length);
      list.forEach((m, i) => {
        const slot = slots[i];
        const local = slotScenePosition(cell, slot, 0);
        const entity = rt.input.entities.get(m.id);
        const key = m.kind;
        const kindScale = key === "plant" ? plantScale(entity) * (m.dead ? 0.6 : 1) : 1;
        let rgb: Rgb;
        if (m.dead) rgb = pal.dead;
        else if (key === "plant") rgb = plantColour(entity && entity.kind === "plant" ? entity.species : "", false, pal);
        else rgb = kindColour(key, pal);
        if (ghost) rgb = ghostTint(rgb, pal);
        const index = next[key]++;
        rt.ids[key][index] = m.id;
        const fig: Figure = {
          id: m.id,
          marker: m,
          layer: rt.index,
          mesh: key,
          index,
          base: [local[0], local[1] + yOffset, local[2]],
          current: [local[0], local[1] + yOffset, local[2]],
          scale: slot.scale * kindScale,
          lying: m.dead,
          colour: linear(rgb),
          discIndex: -1,
          cell,
        };
        if (m.kind === "agent" && !m.dead && !ghost && entity && entity.kind === "agent") {
          const stats = (entity as Agent).stats;
          fig.discIndex = next.disc++;
          rt.ids.disc[fig.discIndex] = m.id;
          this.composeDisc(rt, fig, [0, 0, 0], 1);
          rt.meshes.disc.setColorAt(fig.discIndex, linear(healthColour(stats.max_health > 0 ? stats.health / stats.max_health : 0, pal)));
        }
        this.composeFigure(rt, fig, [0, 0, 0], 1, 0);
        rt.meshes[key].setColorAt(index, fig.colour);
        this.figures.set(fig.id, fig);
      });
    }
    for (const key of FIGURE_MESH_KEYS) {
      const mesh = rt.meshes[key];
      mesh.count = next[key];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    rt.columnCells = [];
    let c = 0;
    for (const [, list] of ordered) {
      const cell = list[0].position;
      const centre = cellToScene(cell, 0);
      const kind = dominantKind(list) ?? "residue";
      let rgb = kindColour(kind, pal);
      if (ghost) rgb = ghostTint(rgb, pal);
      this.tmpM.compose(this.tmpV.set(centre[0], centre[1], centre[2]), this.tmpQ.identity(), this.tmpS.set(1, columnHeight(list.length), 1));
      rt.columns.setMatrixAt(c, this.tmpM);
      rt.columns.setColorAt(c, linear(rgb));
      rt.columnCells[c] = cell;
      c++;
    }
    rt.columns.count = c;
    rt.columns.instanceMatrix.needsUpdate = true;
    if (rt.columns.instanceColor) rt.columns.instanceColor.needsUpdate = true;
    rt.columns.computeBoundingSphere();
    rt.byCell = ordered;
  }

  private composeFigure(rt: LayerRuntime, fig: Figure, offset: Vec3, scaleMul: number, tilt: number): void {
    const rz = (fig.lying ? Math.PI / 2 : 0) + tilt;
    const lift = rz !== 0 ? DEAD_LIFT[fig.mesh] * Math.abs(Math.sin(rz)) * fig.scale : 0;
    const y = fig.base[1] - layerY(rt.index);
    this.tmpV.set(fig.base[0] + offset[0], y + offset[1] + lift, fig.base[2] + offset[2]);
    this.tmpQ.setFromEuler(this.tmpE.set(0, 0, rz));
    const s = Math.max(0.0001, fig.scale * scaleMul);
    this.tmpS.set(s, s, s);
    this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
    rt.meshes[fig.mesh].setMatrixAt(fig.index, this.tmpM);
    fig.current = [fig.base[0] + offset[0], fig.base[1] + offset[1], fig.base[2] + offset[2]];
  }

  private composeDisc(rt: LayerRuntime, fig: Figure, offset: Vec3, scaleMul: number): void {
    if (fig.discIndex < 0) return;
    const y = fig.base[1] - layerY(rt.index);
    this.tmpV.set(fig.base[0] + offset[0], y + offset[1], fig.base[2] + offset[2]);
    const s = Math.max(0.0001, fig.scale * scaleMul);
    this.tmpS.set(s, 1, s);
    this.tmpM.compose(this.tmpV, this.tmpQ.identity(), this.tmpS);
    rt.meshes.disc.setMatrixAt(fig.discIndex, this.tmpM);
  }

  private buildTicks(): void {
    const rt = this.layers[this.active];
    this.ticks = [];
    if (!rt) return;
    const r = rt.input.map.region;
    const y = layerY(this.active);
    const span = Math.max(r.max_x - r.min_x, r.max_y - r.min_y) + 1;
    const stepSize = span <= 20 ? 1 : 5;
    const southZ = 0 - r.min_y + 0.5 + 0.4;
    const westX = r.min_x - 0.5 - 0.4;
    for (let x = r.min_x; x <= r.max_x; x++) {
      if (x % stepSize !== 0 && x !== r.min_x && x !== r.max_x) continue;
      this.ticks.push({ key: `tick:x:${x}`, kind: "tick", position: [x, y, southZ], text: String(x), anchor: "center", priority: 0, className: x === 0 ? "map3d-tick-zero" : undefined });
    }
    for (let yy = r.min_y; yy <= r.max_y; yy++) {
      if (yy % stepSize !== 0 && yy !== r.min_y && yy !== r.max_y) continue;
      this.ticks.push({ key: `tick:y:${yy}`, kind: "tick", position: [westX, y, 0 - yy], text: String(yy), anchor: "center", priority: 0, className: yy === 0 ? "map3d-tick-zero" : undefined });
    }
  }

  // ------------------------------------------------------------------ marks

  setMarks(marks: Marks): void {
    this.marks = marks;
    this.applyMarks();
    this.invalidate();
  }

  private placeRing(ring: Mesh, id: string | null): void {
    const fig = id ? this.figures.get(id) : undefined;
    if (!fig || fig.layer !== this.active) {
      ring.visible = false;
      return;
    }
    ring.visible = true;
    ring.position.set(fig.current[0], fig.current[1], fig.current[2]);
    const s = Math.max(0.5, fig.scale);
    ring.scale.set(s, 1, s);
  }

  private applyMarks(): void {
    const m = this.marks;
    this.placeRing(this.ringActing, m.highlightAgentId);
    this.placeRing(this.ringSelected, m.selectedEntityId);
    this.placeRing(this.ringHover, m.hoverEntityId && m.hoverEntityId !== m.selectedEntityId ? m.hoverEntityId : null);
    this.placeRing(this.ringSelf, this.options.selfId);
    const y = layerY(this.active);
    if (m.hoverCell) {
      const c = cellToScene(m.hoverCell, this.active);
      this.hoverQuad.visible = true;
      this.hoverQuad.position.set(c[0], y, c[2]);
    } else this.hoverQuad.visible = false;
    if (m.selectedPoint) {
      const c = cellToScene(m.selectedPoint, this.active);
      this.cellFrame.visible = true;
      this.cellFrame.position.set(c[0], y, c[2]);
    } else this.cellFrame.visible = false;
  }

  // ------------------------------------------------------------------ chips and timeline

  /** The context the timeline and the chips are built with: slots of the active layer, in absolute scene units. */
  timelineContext(reducedMotion: boolean): TimelineContext {
    const active = this.active;
    const figures = this.figures;
    const rt = this.layers[active];
    return {
      slotOf: (id) => {
        const fig = figures.get(id);
        return fig && fig.layer === active ? [fig.base[0], fig.base[1], fig.base[2]] : null;
      },
      cellCentre: (p) => cellToScene(p, active),
      commRange: (id) => {
        const e = rt?.input.entities.get(id);
        return e && e.kind === "agent" ? e.stats.communication_range : null;
      },
      reducedMotion,
    };
  }

  private chipEffects: readonly TurnEffect[] = [];

  /** The viewed turn's chips (they stay while the turn is viewed). */
  setChips(effects: readonly TurnEffect[]): void {
    this.chipEffects = effects;
    this.refreshChips();
    this.invalidate();
  }

  private refreshChips(): void {
    this.chips = chipPlacements(this.chipEffects, this.timelineContext(true)).map((c) => ({ effect: c.effect, id: c.id, position: c.position }));
  }

  /**
   * Restart the viewed turn's animations from `effects`: the timeline is built
   * against the current slots, squeezed by `factor` (< 1 for fast live play),
   * and every duration is 0 with `reducedMotion` (the end state at once).
   */
  playTimeline(effects: readonly TurnEffect[], reducedMotion: boolean, factor = 1): void {
    this.snapTimeline();
    let tl = buildTimeline(effects, this.timelineContext(reducedMotion));
    if (factor < 1) tl = scaleTimeline(tl, factor);
    this.timeline = tl;
    this.timelineStart = performance.now();
    this.timelineRunning = tl.duration > 0 && tl.clips.length > 0;
    if (!this.timelineRunning) {
      this.timeline = null;
      this.hideFx();
    }
    this.invalidate();
  }

  /** Finish a running timeline at once (every figure back at its saved pose). */
  snapTimeline(): void {
    if (!this.timelineRunning && this.touched.size === 0) return;
    this.timelineRunning = false;
    this.timeline = null;
    this.restoreTouched(new Set());
    this.hideFx();
    this.floats = [];
    this.invalidate();
  }

  private restoreTouched(keep: ReadonlySet<string>): void {
    const meshesToFlag = new Set<InstancedMesh>();
    for (const id of this.touched) {
      if (keep.has(id)) continue;
      const fig = this.figures.get(id);
      if (!fig) continue;
      const rt = this.layers[fig.layer];
      if (!rt) continue;
      this.composeFigure(rt, fig, [0, 0, 0], 1, 0);
      this.composeDisc(rt, fig, [0, 0, 0], 1);
      rt.meshes[fig.mesh].setColorAt(fig.index, fig.colour);
      meshesToFlag.add(rt.meshes[fig.mesh]);
      if (fig.discIndex >= 0) meshesToFlag.add(rt.meshes.disc);
    }
    for (const mesh of meshesToFlag) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.touched = new Set(keep);
  }

  private roleColour(role: ClipColour | null): Color {
    const pal = this.palette;
    switch (role) {
      case "bad":
        return linear(pal.bad);
      case "good":
        return linear(pal.good);
      case "warn":
      case "resource":
        return linear(pal.warn);
      case "accent":
      default:
        return linear(pal.accent);
    }
  }

  private applyTimeline(now: number): void {
    const tl = this.timeline;
    if (!tl || !this.timelineRunning) return;
    const sample = sampleTimeline(tl, now - this.timelineStart);
    const keep = new Set(sample.entities.keys());
    this.restoreTouched(keep);
    const flagged = new Set<InstancedMesh>();
    for (const [id, e] of sample.entities) {
      const fig = this.figures.get(id);
      if (!fig) continue;
      const rt = this.layers[fig.layer];
      if (!rt) continue;
      this.composeFigure(rt, fig, e.offset, e.scale, e.tilt);
      this.composeDisc(rt, fig, e.offset, e.scale);
      const mesh = rt.meshes[fig.mesh];
      if (e.tint) mesh.setColorAt(fig.index, this.tmpC.copy(fig.colour).lerp(this.roleColour(e.tint), 0.7));
      else mesh.setColorAt(fig.index, fig.colour);
      flagged.add(mesh);
      if (fig.discIndex >= 0) flagged.add(rt.meshes.disc);
      this.touched.add(id);
    }
    for (const mesh of flagged) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.applyFx(sample.fx);
    if (sample.done) {
      this.timelineRunning = false;
      this.timeline = null;
      this.restoreTouched(new Set());
      this.hideFx();
      this.floats = [];
    }
    this.applyMarks();
  }

  private hideFx(): void {
    for (const r of this.fx.rings) r.visible = false;
    this.fx.beams.visible = false;
    this.fx.trails.visible = false;
    this.fx.particles.visible = false;
    this.fx.quad.visible = false;
  }

  private applyFx(list: readonly FxState[]): void {
    this.hideFx();
    this.floats = [];
    let ringIndex = 0;
    let beamCount = 0;
    let trailCount = 0;
    let particleCount = 0;
    const beamPos = this.fx.beams.geometry.getAttribute("position") as BufferAttribute;
    const trailPos = this.fx.trails.geometry.getAttribute("position") as BufferAttribute;
    const partPos = this.fx.particles.geometry.getAttribute("position") as BufferAttribute;
    let beamOpacity = 0;
    let trailOpacity = 0;
    let particleOpacity = 0;
    for (const fx of list) {
      switch (fx.kind) {
        case "ripple":
        case "pulse":
        case "puff": {
          if (ringIndex >= RING_POOL) break;
          const ring = this.fx.rings[ringIndex];
          const mat = this.fx.ringMats[ringIndex];
          ringIndex++;
          ring.visible = true;
          const y = fx.kind === "puff" ? fx.position[1] : fx.position[1] + 0.03;
          ring.position.set(fx.position[0], y, fx.position[2]);
          const r = Math.max(0.05, fx.radius);
          ring.scale.set(r, 1, r);
          mat.color.copy(this.roleColour(fx.colour));
          mat.opacity = Math.max(0, Math.min(1, fx.opacity));
          break;
        }
        case "beam": {
          if (beamCount >= BEAM_CAPACITY) break;
          const a = fx.from;
          const b = fx.to;
          beamPos.setXYZ(beamCount * 2, a[0], a[1] + 0.3, a[2]);
          beamPos.setXYZ(beamCount * 2 + 1, b[0], b[1] + 0.3, b[2]);
          beamCount++;
          beamOpacity = Math.max(beamOpacity, fx.opacity);
          break;
        }
        case "trail": {
          if (trailCount >= TRAIL_CAPACITY) break;
          const a = fx.from;
          const b = fx.to;
          trailPos.setXYZ(trailCount * 2, a[0], a[1] + 0.05, a[2]);
          trailPos.setXYZ(trailCount * 2 + 1, b[0], b[1] + 0.05, b[2]);
          trailCount++;
          trailOpacity = Math.max(trailOpacity, fx.opacity);
          break;
        }
        case "particles": {
          if (particleCount + PARTICLE_COUNT > PARTICLE_STREAMS * PARTICLE_COUNT) break;
          for (let k = 0; k < PARTICLE_COUNT; k++) {
            const t = Math.min(1, Math.max(0, fx.progress + (k / PARTICLE_COUNT - 0.5) * 0.35));
            const jitter = ((k * 7919) % 97) / 97 - 0.5;
            const jitter2 = ((k * 104729) % 89) / 89 - 0.5;
            partPos.setXYZ(
              particleCount + k,
              fx.from[0] + (fx.to[0] - fx.from[0]) * t + jitter * 0.2,
              fx.from[1] + (fx.to[1] - fx.from[1]) * t + 0.25 + Math.sin(Math.PI * t) * 0.3 + jitter2 * 0.1,
              fx.from[2] + (fx.to[2] - fx.from[2]) * t + jitter2 * 0.2,
            );
          }
          particleCount += PARTICLE_COUNT;
          particleOpacity = Math.max(particleOpacity, fx.opacity);
          this.fx.particleMat.color.copy(this.roleColour(fx.colour));
          break;
        }
        case "quad": {
          this.fx.quad.visible = true;
          this.fx.quad.position.set(fx.position[0], fx.position[1], fx.position[2]);
          this.fx.quadMat.opacity = fx.opacity;
          this.fx.quadMat.color.copy(this.roleColour(fx.colour));
          break;
        }
        case "float": {
          this.floats.push({
            key: `float:${fx.id ?? ""}:${fx.text ?? ""}:${fx.effectKind}`,
            kind: "float",
            position: fx.position,
            text: fx.text ?? "",
            className: fx.colour ? `map3d-float-${fx.colour}` : undefined,
            opacity: fx.opacity,
            anchor: "center",
            priority: 5,
          });
          break;
        }
        default:
          break;
      }
    }
    if (beamCount > 0) {
      this.fx.beams.visible = true;
      this.fx.beams.geometry.setDrawRange(0, beamCount * 2);
      beamPos.needsUpdate = true;
      this.fx.beamMat.opacity = beamOpacity;
    }
    if (trailCount > 0) {
      this.fx.trails.visible = true;
      this.fx.trails.geometry.setDrawRange(0, trailCount * 2);
      trailPos.needsUpdate = true;
      this.fx.trailMat.opacity = trailOpacity;
    }
    if (particleCount > 0) {
      this.fx.particles.visible = true;
      this.fx.particles.geometry.setDrawRange(0, particleCount);
      partPos.needsUpdate = true;
      this.fx.particleMat.opacity = particleOpacity;
    }
  }

  // ------------------------------------------------------------------ picking

  private ndc(px: number, py: number): Vector2 {
    return new Vector2((px / this.width) * 2 - 1, -(py / this.height) * 2 + 1);
  }

  /** What is under a viewport pixel on the active layer: a figure (its entity) or a tile (its cell), else null. */
  hitTest(px: number, py: number): Hit | null {
    const rt = this.layers[this.active];
    if (!rt) return null;
    this.raycaster.setFromCamera(this.ndc(px, py), this.camera);
    const objects: Object3D[] = [];
    if (this.lod === "columns") objects.push(rt.columns);
    else for (const key of FIGURE_MESH_KEYS) if (rt.meshes[key].count > 0) objects.push(rt.meshes[key]);
    objects.push(rt.terrain);
    const hits = this.raycaster.intersectObjects(objects, false);
    for (const hit of hits) {
      if (hit.object === rt.terrain) {
        const cell = hit.faceIndex !== undefined && hit.faceIndex !== null ? cellOfFace(rt.input.map, hit.faceIndex, rt.arrays) : null;
        return cell ? { kind: "cell", cell } : null;
      }
      if (hit.object === rt.columns) {
        const cell = hit.instanceId !== undefined ? rt.columnCells[hit.instanceId] : undefined;
        return cell ? { kind: "cell", cell } : null;
      }
      for (const key of FIGURE_MESH_KEYS) {
        if (hit.object !== rt.meshes[key] || hit.instanceId === undefined) continue;
        const id = rt.ids[key][hit.instanceId];
        const fig = id ? this.figures.get(id) : undefined;
        if (fig) return { kind: "entity", id: fig.id, cell: fig.cell };
      }
    }
    return null;
  }

  /** The point of the active board under a viewport pixel (terrain hit, else the layer plane), or null. */
  boardPoint(px: number, py: number): Vec3 | null {
    const rt = this.layers[this.active];
    this.raycaster.setFromCamera(this.ndc(px, py), this.camera);
    if (rt) {
      const hits = this.raycaster.intersectObject(rt.terrain, false);
      if (hits.length > 0) return [hits[0].point.x, hits[0].point.y, hits[0].point.z];
    }
    const plane = new Plane(new Vector3(0, 1, 0), -layerY(this.active));
    const target = new Vector3();
    const point = this.raycaster.ray.intersectPlane(plane, target);
    return point ? [point.x, point.y, point.z] : null;
  }

  /** Viewport pixel of a scene point and whether it is in front of the camera and inside the viewport. */
  project(p: Vec3): { x: number; y: number; visible: boolean } {
    const v = this.tmpV.set(p[0], p[1], p[2]).applyMatrix4(this.camera.matrixWorldInverse);
    if (v.z >= -0.05) return { x: 0, y: 0, visible: false };
    v.applyMatrix4(this.camera.projectionMatrix);
    const x = ((v.x + 1) / 2) * this.width;
    const y = ((1 - v.y) / 2) * this.height;
    return { x, y, visible: v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1 };
  }

  /** The figure's current (animated) scene position, or null. */
  entityPosition(id: string): Vec3 | null {
    const fig = this.figures.get(id);
    return fig && fig.layer === this.active ? fig.current : null;
  }

  // ------------------------------------------------------------------ frame loop

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) this.cancelScheduled();
    else this.invalidate();
  }

  /** Ask for one frame (coalesced; no-op while paused or disposed). */
  invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  private cancelScheduled(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private schedule(): void {
    if (this.inFrame || this.paused || this.disposed || this.rafId) return;
    this.rafId = requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    this.rafId = 0;
    if (this.paused || this.disposed) return;
    // Software renderer: a vsync that comes before SOFTWARE_FRAME_MS since the last frame began is skipped.  The
    // clock is performance.now(), not the rAF timestamp, which can lag the callback by a whole vsync.
    if (this.software && this.lastFrameClock > 0 && performance.now() - this.lastFrameClock < SOFTWARE_FRAME_MS - FRAME_JITTER_MS) {
      this.rafId = requestAnimationFrame(this.frame);
      return;
    }
    this.inFrame = true;
    try {
      this.drawFrame(now);
    } finally {
      this.inFrame = false;
    }
    if (this.lastMore || this.timelineRunning || this.dirty) this.schedule();
  };

  private drawFrame(now: number): void {
    const start = performance.now();
    const dt = this.lastFrameStart ? now - this.lastFrameStart : 16;
    this.lastFrameStart = now;
    this.lastFrameClock = start;
    const more = this.hooks.beforeFrame(now, dt);
    this.lastMore = more;
    this.applyTimeline(start);
    // Everything the hooks and the timeline changed is drawn by this frame.
    this.dirty = false;
    if (this.ringActing.visible) this.ringActing.rotation.y += ACTING_RING_SPEED * (Math.min(dt, 100) / 1000);
    if (this.ringSelf.visible) this.ringSelf.rotation.y -= ACTING_RING_SPEED * (Math.min(dt, 100) / 1000);
    const rt = this.layers[this.active];
    if (rt) rt.grid.visible = !(this.slow && lodDistance(this.cameraState, layerY(this.active)) > GRID_FAR);
    this.renderer.render(this.scene, this.camera);
    const shown = this.labels.sync(this.labelItems(), this.camera, this.width, this.height);
    this.labels.setCompass(this.cameraState.yaw);
    const end = performance.now();
    const frameMs = end - start;
    this.frameTimes.push(frameMs);
    if (this.frameTimes.length > 10) this.frameTimes.shift();
    if (!this.slow && this.frameTimes.length === 10 && this.frameTimes.reduce((a, b) => a + b, 0) / 10 > SLOW_FRAME_MS) {
      this.slow = true;
      this.renderer.setPixelRatio(1);
    }
    this.lastStats = {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      frameMs,
      lod: this.lod,
      animating: this.timelineRunning,
      labels: shown,
      camera: this.cameraState,
    };
    this.hooks.onFrame(this.lastStats);
  }

  private labelItems(): LabelItem[] {
    const items: LabelItem[] = [];
    const rt = this.layers[this.active];
    if (!rt) return items;
    const cam = this.cameraState;
    const m = this.marks;
    const columns = this.lod === "columns";
    // A figure that carries a chip keeps its label below the chip: its label places before the chips and its chip may stack above it.
    const chipFigures = new Set<string>();
    for (const chip of this.chips) if (chip.id) chipFigures.add(chip.id);
    const labelled = new Set<string>();
    if (!columns) {
      for (const fig of this.figures.values()) {
        if (fig.layer !== this.active) continue;
        const marker = fig.marker;
        const focus = fig.id === m.hoverEntityId || fig.id === m.selectedEntityId;
        const living = marker.kind === "agent" && !marker.dead;
        if (!living && !focus) continue;
        const d = Math.hypot(fig.current[0] - cam.x, fig.current[1] - cam.y, fig.current[2] - cam.z);
        if (!focus && d > LABEL_FAR) continue;
        labelled.add(fig.id);
        let text: string;
        let shortText: string | undefined;
        if (marker.kind === "agent") {
          const e = rt.input.entities.get(fig.id);
          const name = e && e.kind === "agent" ? e.name : marker.title.replace(/\s*\(.*\)$/, "");
          text = d > LABEL_NAME_DISTANCE && !focus ? fig.id : `${fig.id} ${name}`;
          if (text !== fig.id) shortText = fig.id;
        } else text = dotLabel(marker);
        items.push({
          key: `label:${fig.id}`,
          kind: "label",
          position: [fig.current[0], fig.current[1] + LABEL_HEIGHT[fig.mesh] * fig.scale, fig.current[2]],
          text,
          shortText,
          pinned: focus,
          title: `${marker.title} · ${marker.line}`,
          attrs: { entityId: fig.id, cell: pointKey(fig.cell) },
          className: focus ? "map3d-label-focus" : undefined,
          anchor: "bottom",
          priority: focus ? 3 : chipFigures.has(fig.id) ? 4.5 : 2,
          entityId: fig.id,
          cell: fig.cell,
        });
      }
    }
    const y = layerY(this.active);
    for (const [key, list] of rt.byCell) {
      const n = list.length;
      const badge = columns ? (n >= 2 ? String(n) : null) : countBadge(n);
      if (!badge) continue;
      const c = cellToScene(list[0].position, 0);
      items.push({
        key: `badge:${key}`,
        kind: "badge",
        position: [c[0], y + (columns ? columnHeight(n) + 0.15 : 0.8), c[2]],
        text: badge,
        title: `${n} occupants at (${list[0].position.x}, ${list[0].position.y})`,
        attrs: { cell: key },
        anchor: "center",
        priority: n >= COUNT_BADGE_MIN ? 1 : 0.5,
      });
    }
    this.chips.forEach((chip, i) => {
      const e = chip.effect;
      const fig = chip.id ? this.figures.get(chip.id) : undefined;
      const anchor = fig && fig.layer === this.active ? [fig.current[0], fig.current[1] + CHIP_HEIGHT, fig.current[2]] : chip.position;
      const glyph = glyphFor(e.kind, e.ok);
      items.push({
        key: `chip:${i}:${e.kind}:${e.actor}`,
        kind: "chip",
        position: [anchor[0], anchor[1], anchor[2]],
        text: chipText(e),
        title: `${e.actor} ${e.label}`,
        className: `map3d-chip-${e.kind}${e.ok ? "" : " map3d-chip-failed"}`,
        attrs: { effectKind: e.kind, actor: e.actor, glyph: glyph.label },
        glyph: glyph.path,
        anchor: "bottom",
        priority: 4,
        nudges: chip.id && labelled.has(chip.id) ? CHIP_NUDGES : 0,
      });
    });
    for (const f of this.floats) items.push(f);
    for (const t of this.ticks) items.push(t);
    return items;
  }

  // ------------------------------------------------------------------ dispose

  /** Free every GPU object and the context; the instance is unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelScheduled();
    for (const rt of this.layers) this.disposeLayer(rt);
    this.layers = [];
    this.figures.clear();
    this.labels.clear();
    for (const o of [this.ringActing, this.ringSelected, this.ringHover, this.ringSelf, this.hoverQuad, this.cellFrame, this.fx.quad]) (o.material as MeshBasicMaterial).dispose();
    for (const mat of this.fx.ringMats) mat.dispose();
    this.fx.beamMat.dispose();
    this.fx.trailMat.dispose();
    this.fx.particleMat.dispose();
    this.fx.beams.geometry.dispose();
    this.fx.trails.geometry.dispose();
    this.fx.particles.geometry.dispose();
    this.outside.geometry.dispose();
    this.outsideMat.dispose();
    disposeFigureGeometries(this.geometries);
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
