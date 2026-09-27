/**
 * Terrain geometry of the 3D board as plain typed arrays: one merged mesh for
 * every cell of the region (land flat, mountains raised blocks with darker
 * sides, water sunk), the grid line segments over land, the region outline
 * and the two origin lines.  components/map3d/geometry.ts wraps the arrays in
 * BufferGeometry / LineSegments; nothing here imports three.js.
 * Pure; tested by src/state/state.test.mjs.
 *
 * Coordinates follow map3dLayout: cell (x, y) covers scene x in [x - 0.5,
 * x + 0.5] and z in [-y - 0.5, -y + 0.5]; heights are relative to the layer's
 * tile top (y = 0), so the arrays are the same for every layer and the layer
 * group is translated to layerY(i).  Triangles wind counter-clockwise seen
 * from outside (three.js front faces).
 *
 * DOCS: one draw call per layer for the whole board; a 60 x 60 region is 7.2k
 * to 12k triangles depending on how many cells are mountains.
 */

import type { MapState, Point, Terrain } from "../api/types";

// DOCS: buildTerrainArrays(map, palette) -> positions/normals/colors/indices + faceCell (triangle -> cell index, x fastest); gridLineArrays and borderLineArrays give line-segment pairs.

/** Height of a land tile's top above the layer plane, scene units. */
export const LAND_Y = 0;
/** Height of a mountain block's top. */
export const MOUNTAIN_Y = 0.6;
/** Height of a water tile's top (negative: sunk). */
export const WATER_Y = -0.15;
/** Height of the grid lines over land (just above the tile so they are never z-fought). */
export const GRID_Y = 0.005;
/** Height of the region outline and the origin lines. */
export const BORDER_Y = 0.01;
/** Floats in one line segment (two points of three floats). */
export const SEGMENT_FLOATS = 6;
/** The first BORDER_SEGMENTS segments of borderLineArrays are the outline; the rest are origin lines. */
export const BORDER_SEGMENTS = 4;

/** Linear 0..1 RGB. */
export type Rgb = [number, number, number];

/** Top colours per terrain kind plus the colour of a mountain's four sides (0..1 floats). */
export interface TerrainPalette {
  land: Rgb;
  mountain: Rgb;
  mountainSide: Rgb;
  water: Rgb;
}

/**
 * The merged board: `positions`, `normals` and `colors` have 3 floats per
 * vertex, `indices` 3 per triangle, and `faceCell[triangle]` is the cell
 * index (y - min_y) * cols + (x - min_x) of the cell the triangle belongs to.
 * Per cell: land 2 triangles, water 2, mountain 10 (top + four sides).
 */
export interface TerrainArrays {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  faceCell: Int32Array;
}

/** Number of cell columns (max_x - min_x + 1) of the region, at least 0. */
export function regionCols(map: MapState): number {
  return Math.max(0, map.region.max_x - map.region.min_x + 1);
}

/** Number of cell rows (max_y - min_y + 1) of the region, at least 0. */
export function regionRows(map: MapState): number {
  return Math.max(0, map.region.max_y - map.region.min_y + 1);
}

/** The terrain of a cell; a cell missing from `map.cells` counts as land. */
export function terrainAt(map: MapState, p: Point): Terrain {
  return map.cells[`${p.x},${p.y}`] ?? "land";
}

/** Cell index in region order (x fastest): (y - min_y) * cols + (x - min_x). */
export function cellIndex(map: MapState, p: Point): number {
  return (p.y - map.region.min_y) * regionCols(map) + (p.x - map.region.min_x);
}

/** The cell of a region-order index (inverse of cellIndex); out-of-range indices extrapolate. */
export function cellOfIndex(map: MapState, index: number): Point {
  const cols = Math.max(1, regionCols(map));
  return { x: map.region.min_x + (index % cols), y: map.region.min_y + Math.floor(index / cols) };
}

/** Triangles a cell of this terrain contributes: 2 for land and water, 10 for a mountain. */
export function trianglesFor(terrain: Terrain): number {
  return terrain === "mountain" ? 10 : 2;
}

/** Top height of a terrain kind: LAND_Y, MOUNTAIN_Y or WATER_Y. */
export function terrainTop(terrain: Terrain): number {
  return terrain === "mountain" ? MOUNTAIN_Y : terrain === "water" ? WATER_Y : LAND_Y;
}

/** Every cell of the region in region order (y rows from min_y, x fastest). */
function* regionCells(map: MapState): Generator<Point> {
  for (let y = map.region.min_y; y <= map.region.max_y; y++) {
    for (let x = map.region.min_x; x <= map.region.max_x; x++) yield { x, y };
  }
}

class MeshWriter {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  faceCell: number[] = [];
  private vertexCount = 0;

  /** Add a quad a, b, c, d (counter-clockwise seen from `normal`'s side) as two triangles of one cell. */
  quad(a: Vec, b: Vec, c: Vec, d: Vec, normal: Vec, colour: Rgb, cell: number): void {
    const base = this.vertexCount;
    for (const v of [a, b, c, d]) {
      this.positions.push(v[0], v[1], v[2]);
      this.normals.push(normal[0], normal[1], normal[2]);
      this.colors.push(colour[0], colour[1], colour[2]);
    }
    this.vertexCount += 4;
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.faceCell.push(cell, cell);
  }
}

type Vec = [number, number, number];

/**
 * Build the merged board.  Each cell gets a top quad at its terrain's height
 * (colour `palette.land` / `mountain` / `water`); a mountain also gets four side
 * quads from MOUNTAIN_Y down to 0 in `palette.mountainSide` with outward normals.
 * Cells are visited in region order, so faceCell is monotone and cellOfFace can
 * invert it by walking the region.  An empty region gives empty arrays.
 */
export function buildTerrainArrays(map: MapState, palette: TerrainPalette): TerrainArrays {
  const w = new MeshWriter();
  for (const p of regionCells(map)) {
    const terrain = terrainAt(map, p);
    const cell = cellIndex(map, p);
    const x0 = p.x - 0.5;
    const x1 = p.x + 0.5;
    const z0 = -p.y - 0.5; // north edge
    const z1 = -p.y + 0.5; // south edge
    const top = terrainTop(terrain);
    const colour = terrain === "mountain" ? palette.mountain : terrain === "water" ? palette.water : palette.land;
    // Top, seen from above (+y): (x0,z0) -> (x0,z1) -> (x1,z1) -> (x1,z0) is counter-clockwise.
    w.quad([x0, top, z0], [x0, top, z1], [x1, top, z1], [x1, top, z0], [0, 1, 0], colour, cell);
    if (terrain === "mountain") {
      const side = palette.mountainSide;
      // East (+x): seen from +x, +z is to the left and +y up.
      w.quad([x1, 0, z1], [x1, 0, z0], [x1, top, z0], [x1, top, z1], [1, 0, 0], side, cell);
      // West (-x): seen from -x, +z is to the right.
      w.quad([x0, 0, z0], [x0, 0, z1], [x0, top, z1], [x0, top, z0], [-1, 0, 0], side, cell);
      // South (+z): seen from +z, +x is to the right.
      w.quad([x0, 0, z1], [x1, 0, z1], [x1, top, z1], [x0, top, z1], [0, 0, 1], side, cell);
      // North (-z): seen from -z, +x is to the left.
      w.quad([x1, 0, z0], [x0, 0, z0], [x0, top, z0], [x1, top, z0], [0, 0, -1], side, cell);
    }
  }
  return {
    positions: new Float32Array(w.positions),
    normals: new Float32Array(w.normals),
    colors: new Float32Array(w.colors),
    indices: new Uint32Array(w.indices),
    faceCell: new Int32Array(w.faceCell),
  };
}

/**
 * The cell a triangle of the terrain mesh belongs to (the `faceIndex` of a
 * three.js raycast hit).  With `arrays` given, reads its faceCell table;
 * otherwise walks the region counting 2 or 10 triangles per cell.  Returns
 * null for an index outside the mesh.
 */
export function cellOfFace(map: MapState, faceIndex: number, arrays?: TerrainArrays): Point | null {
  if (!Number.isInteger(faceIndex) || faceIndex < 0) return null;
  if (arrays) {
    if (faceIndex >= arrays.faceCell.length) return null;
    return cellOfIndex(map, arrays.faceCell[faceIndex]);
  }
  let remaining = faceIndex;
  for (const p of regionCells(map)) {
    const n = trianglesFor(terrainAt(map, p));
    if (remaining < n) return p;
    remaining -= n;
  }
  return null;
}

/**
 * Line segments for the grid over land: the four edges of every land cell at
 * GRID_Y, as consecutive point pairs (x, y, z, x, y, z), 4 segments (24 floats)
 * per land cell.  Shared edges are emitted twice (once per cell); the cost is
 * negligible and keeps the array a pure function of the cells.
 */
export function gridLineArrays(map: MapState): Float32Array {
  const out: number[] = [];
  for (const p of regionCells(map)) {
    if (terrainAt(map, p) !== "land") continue;
    const x0 = p.x - 0.5;
    const x1 = p.x + 0.5;
    const z0 = -p.y - 0.5;
    const z1 = -p.y + 0.5;
    out.push(x0, GRID_Y, z0, x1, GRID_Y, z0);
    out.push(x1, GRID_Y, z0, x1, GRID_Y, z1);
    out.push(x1, GRID_Y, z1, x0, GRID_Y, z1);
    out.push(x0, GRID_Y, z1, x0, GRID_Y, z0);
  }
  return new Float32Array(out);
}

/**
 * Line segments at BORDER_Y: first the region outline (BORDER_SEGMENTS = 4
 * segments, 24 floats, around the outer cell edges), then the origin lines
 * through the cell centres of the x = 0 column (when min_x <= 0 <= max_x) and
 * of the y = 0 row (when min_y <= 0 <= max_y), spanning the region like the
 * 2D map's.  Slice at BORDER_SEGMENTS * SEGMENT_FLOATS to colour them apart.
 */
export function borderLineArrays(map: MapState): Float32Array {
  const r = map.region;
  const x0 = r.min_x - 0.5;
  const x1 = r.max_x + 0.5;
  const zN = -r.max_y - 0.5;
  const zS = -r.min_y + 0.5;
  const out: number[] = [];
  out.push(x0, BORDER_Y, zN, x1, BORDER_Y, zN);
  out.push(x1, BORDER_Y, zN, x1, BORDER_Y, zS);
  out.push(x1, BORDER_Y, zS, x0, BORDER_Y, zS);
  out.push(x0, BORDER_Y, zS, x0, BORDER_Y, zN);
  if (r.min_x <= 0 && 0 <= r.max_x) out.push(0, BORDER_Y, zN, 0, BORDER_Y, zS);
  if (r.min_y <= 0 && 0 <= r.max_y) out.push(x0, BORDER_Y, 0, x1, BORDER_Y, 0);
  return new Float32Array(out);
}

/** Count of the origin lines borderLineArrays adds (0, 1 or 2). */
export function originLineCount(map: MapState): number {
  const r = map.region;
  return (r.min_x <= 0 && 0 <= r.max_x ? 1 : 0) + (r.min_y <= 0 && 0 <= r.max_y ? 1 : 0);
}

/** Total triangles of the board mesh (2 per land or water cell, 10 per mountain). */
export function terrainTriangleCount(map: MapState): number {
  let n = 0;
  for (const p of regionCells(map)) n += trianglesFor(terrainAt(map, p));
  return n;
}
