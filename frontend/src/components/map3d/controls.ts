/**
 * DOM events of the 3D viewport turned into camera calls (state/map3dCamera.ts):
 * left drag looks around (0.25 deg/px, a press-release under 4 px is a click),
 * right or middle drag pans, the wheel dollies toward the point under the
 * cursor, one-finger touch looks, two fingers pan and pinch, and the keys of
 * the binding table fly, turn and fire commands while the viewport has focus.
 * Pointer and wheel listeners sit on the viewport and accept events from the
 * board: the canvas and the label overlay, so a press, drag or wheel over an
 * agent label acts like one over the board (a click on a label is left to the
 * label, which picks its entity); the help card and the lost-context card keep
 * their own events.  The held-key set is exposed for the frame loop (step) and
 * cleared on blur, on a hidden tab and on pointercancel so a key never sticks.
 * No Ctrl or Alt chords; modifier chords are left to the browser.
 */

// DOCS: keys act only while the viewport itself has focus (a press on the board or a label focuses it); wheel and drags work over labels too; Escape is consumed only when the view had something to close.

import type { Vec3 } from "../../state/map3dLayout";
import type { BindingAction, CameraState } from "../../state/map3dCamera";
import { applyLook, applyPan, applyWheel, bindingFor } from "../../state/map3dCamera";

/** Pixels a press may move and still count as a click. */
export const CLICK_SLOP_PX = 4;
/** Distance assumed for a pan when nothing is under the cursor. */
const PAN_FALLBACK_DISTANCE = 20;
/** Keys whose browser default (scrolling) is prevented while held in the viewport. */
const PREVENT_DEFAULT_CODES = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home"]);

export interface ControlHandlers {
  camera(): CameraState;
  setCamera(next: CameraState): void;
  /** Scene y of the active layer's tile top (the floor the camera is clamped to). */
  layerY(): number;
  /** The board point under a viewport pixel, or null (for the wheel target and the pan distance). */
  boardPoint(px: number, py: number): Vec3 | null;
  /** The pointer moved over the board (canvas or a label) without dragging (px, py in canvas pixels). */
  onHover(px: number, py: number): void;
  /** The pointer left the board (no drag in progress). */
  onLeave(): void;
  /** A left click (press and release under CLICK_SLOP_PX) on the canvas; a click on a label is the label's own. */
  onClick(px: number, py: number): void;
  /** A one-shot command key; return true when it was consumed (then the event is stopped). */
  onCommand(action: BindingAction): boolean;
  /** The held-key set changed (start or stop the frame loop). */
  onHeldChange(): void;
  /** A drag started or ended (cursor, status). */
  onDragChange(dragging: boolean): void;
  /** True when a pointerdown may move focus to the viewport (false while the profile card or record viewer holds it). */
  canFocus(): boolean;
  /** Any pointerdown on the board (closes the help card). */
  onPointerDown(): void;
}

export interface Controls {
  /** event.code values currently held (read by the frame loop's step). */
  readonly held: Set<string>;
  /** True while a drag (look or pan) is in progress. */
  dragging(): boolean;
  /** Abandon a drag in progress (Escape). */
  cancelDrag(): void;
  dispose(): void;
}

interface Pointer {
  x: number;
  y: number;
  startX: number;
  startY: number;
  button: number;
  type: string;
  /** The press started on an agent label (its click picks; the canvas is captured only once a drag starts). */
  onLabel: boolean;
  captured: boolean;
}

/** True for a target inside an overlay label (the only overlay elements that take pointer events). */
function isLabel(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".map3d-label") !== null;
}

/** Wire the viewport (keys, focus, pointer, wheel) and its canvas to the handlers; call dispose on unmount. */
export function attachControls(viewport: HTMLElement, canvas: HTMLCanvasElement, h: ControlHandlers): Controls {
  const held = new Set<string>();
  const pointers = new Map<number, Pointer>();
  let dragging = false;
  let dragMode: "look" | "pan" = "look";
  let panDistance = PAN_FALLBACK_DISTANCE;
  let pinchDistance = 0;
  let pinchCentre: [number, number] = [0, 0];

  const local = (event: PointerEvent | WheelEvent): [number, number] => {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };

  /** The canvas or a label: not the help card, the lost-context card or anything else inside the viewport. */
  const onBoard = (target: EventTarget | null): boolean => target === canvas || (isLabel(target) && viewport.contains(target as Node));

  const capture = (pointerId: number, p: Pointer) => {
    if (p.captured) return;
    p.captured = true;
    try {
      canvas.setPointerCapture(pointerId);
    } catch {
      // Capture is best effort (a synthetic event may have no pointer).
    }
  };

  const setDragging = (next: boolean) => {
    if (dragging === next) return;
    dragging = next;
    h.onDragChange(next);
  };

  const clearHeld = () => {
    if (held.size === 0) return;
    held.clear();
    h.onHeldChange();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!onBoard(event.target)) return;
    h.onPointerDown();
    if (h.canFocus() && document.activeElement !== viewport) viewport.focus({ preventScroll: true });
    if (pointers.size >= 2) return;
    const [x, y] = local(event);
    const p: Pointer = { x, y, startX: x, startY: y, button: event.button, type: event.pointerType, onLabel: isLabel(event.target), captured: false };
    pointers.set(event.pointerId, p);
    // A press on a label is captured only when it turns into a drag, so a plain click still reaches the label.
    if (!p.onLabel) capture(event.pointerId, p);
    if (pointers.size === 2) {
      for (const [id, q] of pointers) capture(id, q);
      const [a, b] = [...pointers.values()];
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      pinchCentre = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      const hit = h.boardPoint(pinchCentre[0], pinchCentre[1]);
      panDistance = hit ? distance(h.camera(), hit) : PAN_FALLBACK_DISTANCE;
      setDragging(true);
    } else if (event.button === 1 || event.button === 2) {
      const hit = h.boardPoint(x, y);
      panDistance = hit ? distance(h.camera(), hit) : PAN_FALLBACK_DISTANCE;
      dragMode = "pan";
      if (event.button === 1) event.preventDefault();
    } else {
      dragMode = "look";
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    const [x, y] = local(event);
    const p = pointers.get(event.pointerId);
    if (!p) {
      if (pointers.size === 0) {
        if (onBoard(event.target)) h.onHover(x, y);
        else h.onLeave();
      }
      return;
    }
    const dx = x - p.x;
    const dy = y - p.y;
    p.x = x;
    p.y = y;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const centre: [number, number] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      let cam = h.camera();
      cam = applyPan(cam, centre[0] - pinchCentre[0], centre[1] - pinchCentre[1], panDistance, h.layerY());
      if (pinchDistance > 0 && dist > 0) {
        const target = h.boardPoint(centre[0], centre[1]);
        cam = applyWheel(cam, (1 - dist / pinchDistance) * 600, target, h.layerY());
      }
      pinchDistance = dist;
      pinchCentre = centre;
      h.setCamera(cam);
      return;
    }
    if (!dragging) {
      if (Math.hypot(x - p.startX, y - p.startY) < CLICK_SLOP_PX) return;
      capture(event.pointerId, p);
      setDragging(true);
    }
    const cam = h.camera();
    if (dragMode === "pan") h.setCamera(applyPan(cam, dx, dy, panDistance, h.layerY()));
    else h.setCamera(applyLook(cam, dx, dy));
  };

  const endPointer = (event: PointerEvent, cancelled: boolean) => {
    const p = pointers.get(event.pointerId);
    if (!p) return;
    pointers.delete(event.pointerId);
    if (p.captured) {
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        // Already released.
      }
    }
    if (pointers.size > 0) return;
    const wasDragging = dragging;
    setDragging(false);
    if (cancelled) {
      clearHeld();
      return;
    }
    // A click that started on a label is the label's (its click event picks the labelled entity).
    if (!wasDragging && p.button === 0 && !p.onLabel) {
      const [x, y] = local(event);
      h.onClick(x, y);
    }
  };

  const onPointerUp = (event: PointerEvent) => endPointer(event, false);
  const onPointerCancel = (event: PointerEvent) => endPointer(event, true);
  const onPointerLeave = () => {
    if (pointers.size === 0) h.onLeave();
  };
  const onContextMenu = (event: Event) => {
    if (onBoard(event.target)) event.preventDefault();
  };

  const onWheel = (event: WheelEvent) => {
    // The help card scrolls; everything else on the board zooms.
    if (!onBoard(event.target)) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    const [x, y] = local(event);
    const target = h.boardPoint(x, y);
    h.setCamera(applyWheel(h.camera(), event.deltaY * scale * (event.ctrlKey ? 3 : 1), target, h.layerY()));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== viewport) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const binding = bindingFor(event.code, event.key);
    if (!binding) return;
    if (binding.hold) {
      if (PREVENT_DEFAULT_CODES.has(event.code)) event.preventDefault();
      if (!held.has(event.code)) {
        held.add(event.code);
        h.onHeldChange();
      }
      return;
    }
    if (PREVENT_DEFAULT_CODES.has(event.code)) event.preventDefault();
    if (h.onCommand(binding.action)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (held.delete(event.code)) h.onHeldChange();
  };

  const onBlur = () => clearHeld();
  const onVisibility = () => {
    if (document.visibilityState !== "visible") clearHeld();
  };

  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", onPointerUp);
  viewport.addEventListener("pointercancel", onPointerCancel);
  viewport.addEventListener("pointerleave", onPointerLeave);
  viewport.addEventListener("contextmenu", onContextMenu);
  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("keydown", onKeyDown);
  viewport.addEventListener("keyup", onKeyUp);
  viewport.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  return {
    held,
    dragging: () => dragging,
    cancelDrag: () => {
      for (const [id, p] of [...pointers]) {
        pointers.delete(id);
        if (!p.captured) continue;
        try {
          canvas.releasePointerCapture(id);
        } catch {
          // Already released.
        }
      }
      setDragging(false);
    },
    dispose: () => {
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("pointermove", onPointerMove);
      viewport.removeEventListener("pointerup", onPointerUp);
      viewport.removeEventListener("pointercancel", onPointerCancel);
      viewport.removeEventListener("pointerleave", onPointerLeave);
      viewport.removeEventListener("contextmenu", onContextMenu);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("keydown", onKeyDown);
      viewport.removeEventListener("keyup", onKeyUp);
      viewport.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      held.clear();
      pointers.clear();
    },
  };
}

function distance(cam: CameraState, p: Vec3): number {
  return Math.hypot(p[0] - cam.x, p[1] - cam.y, p[2] - cam.z);
}
