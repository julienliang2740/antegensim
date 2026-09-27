/**
 * Geometries of the 3D board: the figure shapes (a pawn for agents, a cone
 * on a trunk for plants, a sphere for fruit, an inverted cone for seeds, a
 * puddle for residue, a disc for health, a box for the far-LOD columns), the
 * rings and frames, and the wrappers that turn the pure typed arrays of
 * state/map3dTerrain.ts into BufferGeometry for the board, its grid and its
 * border.  Every figure stands on y = 0 (the tile top) and is at most 60
 * triangles; they are built once per scene and shared by every layer.
 *
 * Colours handed to three.js are sRGB (the CSS token values); `linear()`
 * converts them to the renderer's working colour space.
 */

// DOCS: figure geometries are 10-60 triangles each; the board is one merged BufferGeometry per layer (map3dTerrain arrays).

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  PlaneGeometry,
  RingGeometry,
  SRGBColorSpace,
  SphereGeometry,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { MapState } from "../../api/types";
import type { Rgb, TerrainArrays, TerrainPalette } from "../../state/map3dTerrain";
import { BORDER_SEGMENTS, SEGMENT_FLOATS, borderLineArrays, buildTerrainArrays, gridLineArrays } from "../../state/map3dTerrain";

/** The instanced figure meshes, one per key. */
export type FigureMeshKey = "disc" | "agent" | "plant" | "fruit" | "seed" | "residue";

export const FIGURE_MESH_KEYS: readonly FigureMeshKey[] = ["disc", "agent", "plant", "fruit", "seed", "residue"];

/** Height above the tile top at which a figure's label hangs, per mesh (upright, scale 1). */
export const LABEL_HEIGHT: Record<FigureMeshKey, number> = { disc: 0.1, agent: 0.62, plant: 0.72, fruit: 0.24, seed: 0.24, residue: 0.14 };

/** How high a lying (dead) figure's pivot is lifted so it rests on the tile. */
export const DEAD_LIFT: Record<FigureMeshKey, number> = { disc: 0, agent: 0.14, plant: 0.1, fruit: 0, seed: 0, residue: 0 };

export interface FigureGeometries {
  figures: Record<FigureMeshKey, BufferGeometry>;
  /** BoxGeometry(0.7, 1, 0.7) standing on y = 0; scaled in y to the column height. */
  column: BufferGeometry;
  /** Flat ring (0.26 to 0.32) at y 0.02, for the selected and hovered figures. */
  ring: BufferGeometry;
  /** The same ring as 12 short arcs (a dashed look), for the acting agent and the agent-view self. */
  dashedRing: BufferGeometry;
  /** Translucent quad under the hovered cell (1 x 1 at y 0.016). */
  hoverQuad: BufferGeometry;
  /** Two squares (1.0 and 1.06) as line segments with vertex colours (inner yellow, outer black). */
  cellFrame: BufferGeometry;
  /** Unit ring (0.9 to 1) for the pooled ripple and pulse effects, scaled by the radius. */
  fxRing: BufferGeometry;
  /** Unit quad at y 0.03 for the observe effect. */
  fxQuad: BufferGeometry;
}

/** sRGB 0..1 triple to a three.js Color in the working (linear) colour space. */
export function linear(rgb: Rgb): Color {
  return new Color().setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);
}

function merged(parts: BufferGeometry[]): BufferGeometry {
  const flat = parts.map((p) => {
    const g = p.index ? p.toNonIndexed() : p;
    g.deleteAttribute("uv");
    if (g !== p) p.dispose();
    return g;
  });
  const out = mergeGeometries(flat, false);
  for (const g of flat) g.dispose();
  if (!out) throw new Error("mergeGeometries failed");
  out.computeBoundingSphere();
  return out;
}

function plain(g: BufferGeometry): BufferGeometry {
  g.deleteAttribute("uv");
  g.computeBoundingSphere();
  return g;
}

/** Build every shared geometry once (dispose with disposeFigureGeometries). */
export function buildFigureGeometries(): FigureGeometries {
  const agent = merged([new CylinderGeometry(0.12, 0.16, 0.34, 6).translate(0, 0.19, 0), new SphereGeometry(0.11, 6, 4).translate(0, 0.46, 0)]);
  const plant = merged([new CylinderGeometry(0.04, 0.06, 0.28, 5).translate(0, 0.14, 0), new IcosahedronGeometry(0.24, 0).translate(0, 0.44, 0)]);
  const fruit = plain(new SphereGeometry(0.08, 6, 4).translate(0, 0.09, 0));
  const seed = plain(new ConeGeometry(0.06, 0.14, 5).rotateX(Math.PI).translate(0, 0.09, 0));
  const residue = plain(new CylinderGeometry(0.15, 0.17, 0.035, 6).translate(0, 0.024, 0));
  const disc = plain(new CircleGeometry(0.21, 10).rotateX(-Math.PI / 2).translate(0, 0.012, 0));
  const column = plain(new BoxGeometry(0.7, 1, 0.7).translate(0, 0.5, 0));
  const ring = plain(new RingGeometry(0.26, 0.32, 24).rotateX(-Math.PI / 2).translate(0, 0.02, 0));
  const arcs: BufferGeometry[] = [];
  for (let i = 0; i < 12; i++) arcs.push(new RingGeometry(0.26, 0.32, 3, 1, (i * Math.PI) / 6, Math.PI / 12));
  const dashedRing = merged(arcs).rotateX(-Math.PI / 2).translate(0, 0.02, 0);
  const hoverQuad = plain(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0.016, 0));
  const fxRing = plain(new RingGeometry(0.9, 1, 32).rotateX(-Math.PI / 2));
  const fxQuad = plain(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0.03, 0));
  return { figures: { disc, agent, plant, fruit, seed, residue }, column, ring, dashedRing, hoverQuad, cellFrame: buildCellFrame(), fxRing, fxQuad };
}

/** Two concentric squares at y 0.02 as line segments; the colours are set by recolourCellFrame. */
function buildCellFrame(): BufferGeometry {
  const positions: number[] = [];
  for (const half of [0.5, 0.53]) {
    const y = half === 0.5 ? 0.022 : 0.02;
    const corners = [
      [-half, y, -half],
      [half, y, -half],
      [half, y, half],
      [-half, y, half],
    ];
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new Float32BufferAttribute(new Array(positions.length).fill(1), 3));
  g.computeBoundingSphere();
  return g;
}

/** Colour the cell frame: the inner square `inner`, the outer square `outer` (sRGB). */
export function recolourCellFrame(g: BufferGeometry, inner: Rgb, outer: Rgb): void {
  const attr = g.getAttribute("color") as BufferAttribute;
  const a = linear(inner);
  const b = linear(outer);
  for (let i = 0; i < 8; i++) attr.setXYZ(i, a.r, a.g, a.b);
  for (let i = 8; i < 16; i++) attr.setXYZ(i, b.r, b.g, b.b);
  attr.needsUpdate = true;
}

export function disposeFigureGeometries(g: FigureGeometries): void {
  for (const key of FIGURE_MESH_KEYS) g.figures[key].dispose();
  g.column.dispose();
  g.ring.dispose();
  g.dashedRing.dispose();
  g.hoverQuad.dispose();
  g.cellFrame.dispose();
  g.fxRing.dispose();
  g.fxQuad.dispose();
}

/** The merged board of a layer (positions, normals, linear vertex colours, indices) plus its arrays for picking. */
export function buildTerrainGeometry(map: MapState, palette: TerrainPalette): { geometry: BufferGeometry; arrays: TerrainArrays } {
  const lin: TerrainPalette = { land: toLinear(palette.land), mountain: toLinear(palette.mountain), mountainSide: toLinear(palette.mountainSide), water: toLinear(palette.water) };
  const arrays = buildTerrainArrays(map, lin);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(arrays.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(arrays.normals, 3));
  geometry.setAttribute("color", new BufferAttribute(arrays.colors, 3));
  geometry.setIndex(new BufferAttribute(arrays.indices, 1));
  geometry.computeBoundingSphere();
  return { geometry, arrays };
}

function toLinear(rgb: Rgb): Rgb {
  const c = linear(rgb);
  return [c.r, c.g, c.b];
}

/** Line segments over the land cells' edges (LineSegments geometry). */
export function buildGridGeometry(map: MapState): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(gridLineArrays(map), 3));
  g.computeBoundingSphere();
  return g;
}

/** The region outline (colour `border`) and the origin lines (colour `origin`) as one LineSegments geometry with vertex colours. */
export function buildBorderGeometry(map: MapState, border: Rgb, origin: Rgb): BufferGeometry {
  const positions = borderLineArrays(map);
  const colors = new Float32Array(positions.length);
  const b = linear(border);
  const o = linear(origin);
  const outlineFloats = BORDER_SEGMENTS * SEGMENT_FLOATS;
  for (let i = 0; i < positions.length; i += 3) {
    const c = i < outlineFloats ? b : o;
    colors[i] = c.r;
    colors[i + 1] = c.g;
    colors[i + 2] = c.b;
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(positions, 3));
  g.setAttribute("color", new BufferAttribute(colors, 3));
  g.computeBoundingSphere();
  return g;
}
