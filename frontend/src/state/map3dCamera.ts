/**
 * The 3D view's free camera as pure arithmetic: the pose type, key-driven
 * flight (W A S D, Space and Shift, arrows, Q and E), mouse look, pan, wheel
 * dolly, the framing poses (frame region, top view, focus a cell, layer
 * elevator), glides between poses, the key binding table and the data-camera
 * string QA reads.  components/map3d/controls.ts turns DOM events into calls of
 * these functions; nothing here touches the DOM or three.js.
 * Tested by src/state/state.test.mjs.
 *
 * Conventions: positions are scene units (1 = one cell; see map3dLayout).
 * yaw and pitch are radians.  yaw 0 looks north (scene -z); positive yaw turns
 * right (yaw pi/2 looks east, +x); yaw is kept in (-pi, pi].  pitch 0 is level,
 * negative looks down, clamped to +-89 degrees so upper layers can be looked at
 * and there is never a roll.  The eye is clamped to [layerY + FLOOR_ABOVE_LAYER,
 * layerY + CEILING] of the active layer whenever a function moves it.
 * The look direction is [cos(pitch) sin(yaw), sin(pitch), -cos(pitch) cos(yaw)].
 *
 * DOCS: keys act on physical event.code (KeyW is the same key on AZERTY); speed
 * scales with height above the active layer (6 units/s on the board, 60 at 90
 * units up); there are no Ctrl or Alt chords.
 */

import type { Point, Region } from "../api/types";
import type { Vec3 } from "./map3dLayout";
import { LAYER_GAP, cellToScene, layerY } from "./map3dLayout";
import { easeInOut } from "./map3dTimeline";

// DOCS: step(state, heldCodes, dtMs, layerY) flies; applyLook/applyPan/applyWheel handle drags and the wheel; frameRegion/topView/focusCell/layerElevator are the framing poses; glide(a, b, t) tweens between two poses.

/** The camera pose: eye position in scene units, yaw and pitch in radians (no roll). */
export interface CameraState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** Lowest eye height above the active layer's tile top, in scene units. */
export const FLOOR_ABOVE_LAYER = 0.6;
/** Highest eye height above the active layer's tile top, in scene units. */
export const CEILING = 200;
/** Longest frame interval `step` integrates (a tab that was hidden never makes the camera jump). */
export const DT_CAP_MS = 50;
/** Mouse look: degrees of yaw or pitch per pixel dragged. */
export const LOOK_DEG_PER_PX = 0.25;
/** Keyboard look (Q, E, ArrowLeft, ArrowRight): degrees of yaw per second. */
export const KEY_YAW_DEG_PER_S = 60;
/** Keyboard look (ArrowUp, ArrowDown): degrees of pitch per second. */
export const KEY_PITCH_DEG_PER_S = 60;
/** Wheel dolly: fraction of the distance to the target covered per notch (100 px of deltaY). */
export const DOLLY_FRACTION = 0.12;
/** The wheel never brings the eye closer to its target than this, in scene units. */
export const MIN_DOLLY_DISTANCE = 0.6;
/** Without a board hit under the cursor the wheel dollies toward the point this far ahead. */
export const WHEEL_AHEAD = 20;
/** Pan (right or middle drag): scene units per pixel per unit of distance to the board. */
export const PAN_UNITS_PER_PX = 0.0015;
/** Pitch limit in degrees (either way). */
export const PITCH_LIMIT_DEG = 89;
/** Vertical field of view of the PerspectiveCamera, degrees. */
export const FOV_DEG = 50;
/** Near and far clipping planes of the PerspectiveCamera, scene units. */
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 600;
/** Duration of a glide (focus, frame, top view, layer elevator), ms. */
export const GLIDE_MS = 300;
/** frameRegion: the pitch it looks down at and the margin around the board. */
export const FRAME_PITCH_DEG = -50;
export const FRAME_MARGIN = 1.15;
/** topView: pitch (just short of straight down, so yaw stays meaningful) and height per board size. */
export const TOP_VIEW_PITCH_DEG = -89;
export const TOP_VIEW_HEIGHT_FACTOR = 1.2;
/** focusCell places the cell centre this far ahead of the eye, scene units. */
export const FOCUS_AHEAD = 6;
/** Flight speed: units per second at height 0, per unit of height, and the cap. */
export const SPEED_MIN = 6;
export const SPEED_PER_UNIT = 0.6;
export const SPEED_MAX = 60;

const DEG = Math.PI / 180;
const PITCH_LIMIT = PITCH_LIMIT_DEG * DEG;

/** Degrees to radians. */
export function degToRad(degrees: number): number {
  return degrees * DEG;
}

/** Radians to degrees. */
export function radToDeg(radians: number): number {
  return radians / DEG;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Wrap an angle into (-pi, pi]. */
export function wrapYaw(yaw: number): number {
  let a = yaw % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  else if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

/** Clamp a pitch to [-PITCH_LIMIT_DEG, +PITCH_LIMIT_DEG] degrees (in radians). */
export function clampPitch(pitch: number): number {
  return clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
}

/** Clamp an eye height to [layerY + FLOOR_ABOVE_LAYER, layerY + CEILING]. */
export function clampHeight(y: number, layerYValue: number): number {
  return clamp(y, layerYValue + FLOOR_ABOVE_LAYER, layerYValue + CEILING);
}

/** Flight speed at height `h` above the active layer: clamp(6 + 0.6 * h, 6, 60) scene units per second. */
export function speedForHeight(h: number): number {
  return clamp(SPEED_MIN + SPEED_PER_UNIT * h, SPEED_MIN, SPEED_MAX);
}

/** Horizontal unit vector the camera faces, as [dx, dz] = [sin(yaw), -cos(yaw)] (yaw 0 -> [0, -1], north). */
export function forward(yaw: number): [number, number] {
  return [Math.sin(yaw), -Math.cos(yaw)];
}

/** Horizontal unit vector to the camera's right: [cos(yaw), sin(yaw)] as [dx, dz] (yaw 0 -> +x, east). */
export function rightOf(yaw: number): [number, number] {
  return [Math.cos(yaw), Math.sin(yaw)];
}

/** Unit look direction of a pose: [cos(pitch) sin(yaw), sin(pitch), -cos(pitch) cos(yaw)]. */
export function lookDirection(state: CameraState): Vec3 {
  const cp = Math.cos(state.pitch);
  return [cp * Math.sin(state.yaw), Math.sin(state.pitch), -cp * Math.cos(state.yaw)];
}

/** Unit "up" vector of the camera's screen (perpendicular to the look direction, no roll). */
export function upVector(state: CameraState): Vec3 {
  const sp = Math.sin(state.pitch);
  return [-sp * Math.sin(state.yaw), Math.cos(state.pitch), sp * Math.cos(state.yaw)];
}

/**
 * The yaw and pitch that look from `eye` at `target` (the inverse of lookDirection).
 * A target at the eye gives yaw 0, pitch 0.
 */
export function lookAt(eye: Vec3, target: Vec3): { yaw: number; pitch: number } {
  const dx = target[0] - eye[0];
  const dy = target[1] - eye[1];
  const dz = target[2] - eye[2];
  const horizontal = Math.hypot(dx, dz);
  if (horizontal === 0 && dy === 0) return { yaw: 0, pitch: 0 };
  return { yaw: wrapYaw(Math.atan2(dx, -dz)), pitch: clampPitch(Math.atan2(dy, horizontal)) };
}

/** Euclidean distance from the eye to a scene point. */
export function distanceTo(state: CameraState, target: Vec3): number {
  return Math.hypot(target[0] - state.x, target[1] - state.y, target[2] - state.z);
}

/**
 * Where the look ray meets the plane y = layerYValue (the active layer's tile
 * top), or null when the camera looks level or up, or is below the plane and
 * looks down.  The view uses it for the LOD distance and as the wheel target
 * when nothing is under the cursor.
 */
export function boardHit(state: CameraState, layerYValue: number): Vec3 | null {
  const dir = lookDirection(state);
  if (dir[1] >= -1e-9) return null;
  const t = (layerYValue - state.y) / dir[1];
  if (t <= 0) return null;
  return [state.x + dir[0] * t, layerYValue, state.z + dir[2] * t];
}

/**
 * Distance that drives the LOD: from the eye to its look-at point on the active
 * board, or the eye's height above the board when the ray misses it (looking at
 * the horizon or the sky).
 */
export function lodDistance(state: CameraState, layerYValue: number): number {
  const hit = boardHit(state, layerYValue);
  return hit ? distanceTo(state, hit) : Math.max(0, state.y - layerYValue);
}

/** Centre of a region in world cells (fractional for even spans). */
export function regionCentre(region: Region): Point {
  return { x: (region.min_x + region.max_x) / 2, y: (region.min_y + region.max_y) / 2 };
}

/** What a key does; `hold` actions run every frame while the key is down, the others fire once on keydown. */
export type BindingAction =
  | "forward"
  | "back"
  | "strafeLeft"
  | "strafeRight"
  | "up"
  | "down"
  | "yawLeft"
  | "yawRight"
  | "pitchUp"
  | "pitchDown"
  | "layerUp"
  | "layerDown"
  | "frame"
  | "top"
  | "focus"
  | "replay"
  | "help"
  | "escape";

export interface Binding {
  action: BindingAction;
  /** True for movement and look keys (held), false for one-shot commands. */
  hold: boolean;
}

const HOLD: Record<string, BindingAction> = {
  KeyW: "forward",
  KeyS: "back",
  KeyA: "strafeLeft",
  KeyD: "strafeRight",
  Space: "up",
  ShiftLeft: "down",
  ShiftRight: "down",
  ArrowLeft: "yawLeft",
  ArrowRight: "yawRight",
  KeyQ: "yawLeft",
  KeyE: "yawRight",
  ArrowUp: "pitchUp",
  ArrowDown: "pitchDown",
};

const PRESS: Record<string, BindingAction> = {
  PageUp: "layerUp",
  PageDown: "layerDown",
  KeyF: "frame",
  KeyT: "top",
  Home: "focus",
  KeyR: "replay",
  KeyH: "help",
  Escape: "escape",
};

/**
 * The binding of a key event: `code` is the physical key (event.code), `key`
 * the produced character (event.key), used only for "?" (help), whose physical
 * key differs per layout.  Unknown keys give null.  Modifier chords are not
 * bindings: the caller ignores events with ctrlKey, altKey or metaKey.
 */
export function bindingFor(code: string, key = ""): Binding | null {
  const hold = HOLD[code];
  if (hold) return { action: hold, hold: true };
  const press = PRESS[code];
  if (press) return { action: press, hold: false };
  if (key === "?") return { action: "help", hold: false };
  return null;
}

/**
 * Advance the camera by one frame of held keys.  `keys` holds event.code values
 * (KeyW KeyS forward/back along forward(yaw), horizontal only; KeyA KeyD strafe;
 * Space up; ShiftLeft/ShiftRight down; ArrowLeft/ArrowRight and KeyQ/KeyE yaw
 * 60 deg/s; ArrowUp/ArrowDown pitch 60 deg/s).  `dtMs` is capped at DT_CAP_MS
 * (50) so a long frame never teleports; a negative dt counts as 0.  Movement
 * speed is speedForHeight(y - layerYValue) units/s; diagonal movement (W + D) is
 * normalised so it is no faster than straight.  The eye's y is clamped to
 * [layerYValue + FLOOR_ABOVE_LAYER, layerYValue + CEILING] even when no key
 * moved it.  Unknown codes are ignored.  Returns a new state.
 */
export function step(state: CameraState, keys: ReadonlySet<string>, dtMs: number, layerYValue: number): CameraState {
  const dt = clamp(dtMs, 0, DT_CAP_MS) / 1000;
  let fwd = 0;
  let side = 0;
  let vert = 0;
  let yawDir = 0;
  let pitchDir = 0;
  for (const code of keys) {
    const action = HOLD[code];
    switch (action) {
      case "forward":
        fwd += 1;
        break;
      case "back":
        fwd -= 1;
        break;
      case "strafeRight":
        side += 1;
        break;
      case "strafeLeft":
        side -= 1;
        break;
      case "up":
        vert += 1;
        break;
      case "down":
        vert -= 1;
        break;
      case "yawRight":
        yawDir += 1;
        break;
      case "yawLeft":
        yawDir -= 1;
        break;
      case "pitchUp":
        pitchDir += 1;
        break;
      case "pitchDown":
        pitchDir -= 1;
        break;
      default:
        break;
    }
  }
  const yaw = wrapYaw(state.yaw + Math.sign(yawDir) * KEY_YAW_DEG_PER_S * DEG * dt);
  const pitch = clampPitch(state.pitch + Math.sign(pitchDir) * KEY_PITCH_DEG_PER_S * DEG * dt);
  const speed = speedForHeight(state.y - layerYValue);
  const [fx, fz] = forward(yaw);
  const [rx, rz] = rightOf(yaw);
  let mx = fx * Math.sign(fwd) + rx * Math.sign(side);
  let mz = fz * Math.sign(fwd) + rz * Math.sign(side);
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  const move = speed * dt;
  return {
    x: state.x + mx * move,
    y: clampHeight(state.y + Math.sign(vert) * move, layerYValue),
    z: state.z + mz * move,
    yaw,
    pitch,
  };
}

/**
 * Mouse look for a drag of (dxPx, dyPx) pixels: yaw += dx * 0.25 deg (drag
 * right turns right), pitch -= dy * 0.25 deg (drag down looks down), pitch
 * clamped to +-89 deg, yaw wrapped to (-pi, pi].  The position is unchanged.
 */
export function applyLook(state: CameraState, dxPx: number, dyPx: number): CameraState {
  return {
    ...state,
    yaw: wrapYaw(state.yaw + dxPx * LOOK_DEG_PER_PX * DEG),
    pitch: clampPitch(state.pitch - dyPx * LOOK_DEG_PER_PX * DEG),
  };
}

/**
 * Pan (right or middle drag): translate the eye parallel to the screen so the
 * board follows the pointer, by px * distance * PAN_UNITS_PER_PX where
 * `distance` is the eye's distance to the board point under the cursor (or to
 * boardHit).  Dragging right moves the eye left, dragging down moves it up.
 * The eye's y is clamped to the floor and ceiling of `layerYValue` (default 0).
 */
export function applyPan(state: CameraState, dxPx: number, dyPx: number, distance: number, layerYValue = 0): CameraState {
  const k = Math.max(0, distance) * PAN_UNITS_PER_PX;
  const [rx, rz] = rightOf(state.yaw);
  const up = upVector(state);
  return {
    ...state,
    x: state.x - rx * dxPx * k + up[0] * dyPx * k,
    y: clampHeight(state.y + up[1] * dyPx * k, layerYValue),
    z: state.z - rz * dxPx * k + up[2] * dyPx * k,
  };
}

/**
 * Wheel dolly along the ray from the eye to `target` (the board point under the
 * cursor; null uses the point WHEEL_AHEAD units ahead).  `deltaY` is in pixels,
 * 100 per notch; a negative deltaY (wheel up, pinch out) moves toward the
 * target by DOLLY_FRACTION (12 %) of the distance per notch, positive moves away
 * by the same amount.  The eye never gets closer than MIN_DOLLY_DISTANCE (0.6)
 * to the target and its y is clamped to the floor and ceiling of `layerYValue`
 * (default 0).  yaw and pitch are unchanged.
 */
export function applyWheel(state: CameraState, deltaY: number, target: Vec3 | null, layerYValue = 0): CameraState {
  const dir = lookDirection(state);
  const aim: Vec3 = target ?? [state.x + dir[0] * WHEEL_AHEAD, state.y + dir[1] * WHEEL_AHEAD, state.z + dir[2] * WHEEL_AHEAD];
  const dx = aim[0] - state.x;
  const dy = aim[1] - state.y;
  const dz = aim[2] - state.z;
  const distance = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(deltaY) || deltaY === 0 || distance < 1e-9) return { ...state, y: clampHeight(state.y, layerYValue) };
  let move = distance * DOLLY_FRACTION * (-deltaY / 100);
  if (move > 0) move = Math.min(move, Math.max(0, distance - MIN_DOLLY_DISTANCE));
  const f = move / distance;
  return {
    ...state,
    x: state.x + dx * f,
    y: clampHeight(state.y + dy * f, layerYValue),
    z: state.z + dz * f,
  };
}

/**
 * The pose that shows the whole region of `layer`: yaw 0 (looking north),
 * pitch FRAME_PITCH_DEG (-50 deg), eye south of the board centre at distance
 * d = FRAME_MARGIN * 0.5 * max(cols / aspect, rows) / tan(FOV / 2), where
 * `aspect` is the viewport width / height (a non-positive aspect counts as 1):
 * eye = centre + d * (0, sin 50 deg, cos 50 deg).  cols / aspect makes a wide
 * board fit horizontally in a wide viewport; for aspect 1 it equals the
 * max(cols, rows) framing.
 */
export function frameRegion(region: Region, layer: number, aspect: number): CameraState {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const cols = region.max_x - region.min_x + 1;
  const rows = region.max_y - region.min_y + 1;
  const centre = cellToScene(regionCentre(region), layer);
  const d = (FRAME_MARGIN * 0.5 * Math.max(cols / a, rows)) / Math.tan((FOV_DEG / 2) * DEG);
  const tilt = -FRAME_PITCH_DEG * DEG;
  return {
    x: centre[0],
    y: centre[1] + d * Math.sin(tilt),
    z: centre[2] + d * Math.cos(tilt),
    yaw: 0,
    pitch: FRAME_PITCH_DEG * DEG,
  };
}

/**
 * The pose that looks straight down at the region of `layer` from height
 * TOP_VIEW_HEIGHT_FACTOR * max(cols, rows) above it (pitch -89 deg, yaw 0, north
 * up on the screen).  The eye is nudged south by h * tan(1 deg) so the look ray
 * meets the board exactly at its centre.
 */
export function topView(region: Region, layer: number): CameraState {
  const cols = region.max_x - region.min_x + 1;
  const rows = region.max_y - region.min_y + 1;
  const centre = cellToScene(regionCentre(region), layer);
  const h = TOP_VIEW_HEIGHT_FACTOR * Math.max(cols, rows);
  const pitch = TOP_VIEW_PITCH_DEG * DEG;
  return { x: centre[0], y: centre[1] + h, z: centre[2] + h * Math.tan(Math.PI / 2 + pitch), yaw: 0, pitch };
}

/**
 * Keep yaw and pitch and move the eye so the centre of `cell` on `layer` is
 * FOCUS_AHEAD (6) units ahead along the look direction.  The eye's y is then
 * clamped to the floor of the layer, so with a level pitch the cell ends up
 * slightly below the centre of the screen.
 */
export function focusCell(state: CameraState, cell: Point, layer: number): CameraState {
  const target = cellToScene(cell, layer);
  const dir = lookDirection(state);
  return {
    ...state,
    x: target[0] - dir[0] * FOCUS_AHEAD,
    y: clampHeight(target[1] - dir[1] * FOCUS_AHEAD, layerY(layer)),
    z: target[2] - dir[2] * FOCUS_AHEAD,
  };
}

/** The pose after switching the active layer from index `from` to `to`: y += (to - from) * LAYER_GAP, all else kept. */
export function layerElevator(state: CameraState, from: number, to: number): CameraState {
  return { ...state, y: state.y + (to - from) * LAYER_GAP };
}

/**
 * The pose `t` of the way from `a` to `b` (t in [0, 1], clamped) with easeInOut
 * timing; yaw travels the short arc.  Used for GLIDE_MS glides (focus, frame,
 * top view, elevator): t = elapsed / GLIDE_MS.  glide(a, b, 1) equals b.
 */
export function glide(a: CameraState, b: CameraState, t: number): CameraState {
  const e = easeInOut(clamp(t, 0, 1));
  const dyaw = wrapYaw(b.yaw - a.yaw);
  return {
    x: a.x + (b.x - a.x) * e,
    y: a.y + (b.y - a.y) * e,
    z: a.z + (b.z - a.z) * e,
    yaw: e >= 1 ? b.yaw : wrapYaw(a.yaw + dyaw * e),
    pitch: a.pitch + (b.pitch - a.pitch) * e,
  };
}

function round2(v: number): number {
  return Number(v.toFixed(2)) || 0;
}

/**
 * The pose as JSON with two decimals, e.g. {"x":0,"y":24.13,"z":31.55,"yaw":0,"pitch":-0.87}
 * (yaw and pitch in radians), for the QA root's data-camera attribute; -0 is written as 0.
 */
export function cameraKey(state: CameraState): string {
  return JSON.stringify({ x: round2(state.x), y: round2(state.y), z: round2(state.z), yaw: round2(state.yaw), pitch: round2(state.pitch) });
}
