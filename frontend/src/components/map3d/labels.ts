/**
 * The HTML overlay of the 3D view: a pool of absolutely positioned elements
 * inside div.map3d-labels (agent name labels, count badges, action chips,
 * floating numbers, axis ticks and the compass) projected with the camera on
 * every rendered frame.  HTML rather than sprites so the text is crisp under a
 * software renderer, takes the CSS tokens and dark mode, and can be read and
 * clicked by Playwright.  Labels, badges and chips never cover each other: each
 * frame they are measured (once per text, cached) and placed greedily by
 * state/map3dLayout.ts::placeOverlay (the hovered or selected entity's label
 * first and always, then chips (one over a labelled figure stacks above that
 * label), then agent labels nearest first falling back to the id, then count
 * badges); what finds no room
 * is left out until the camera moves.  At most LABEL_CAP labels, badges, chips
 * and floats per frame; floats, ticks and the compass take no room.
 */

// DOCS: button.map3d-label[data-entity-id][data-cell] per living agent with room on screen (a crowded label shows its id only, then drops out; the hovered/selected one always shows), span.map3d-badge (count >= 5), div.map3d-chip.map3d-chip-<kind>, span.map3d-float, span.map3d-tick, div.map3d-compass; a label click picks via onPick, pointer presses on labels also reach the viewport's controls.

import { Camera, Vector3 } from "three";
import type { Point } from "../../api/types";
import type { OverlayEntry, ScreenBox, Vec3 } from "../../state/map3dLayout";
import { OVERLAY_GAP, placeOverlay } from "../../state/map3dLayout";

export type LabelKind = "label" | "badge" | "chip" | "float" | "tick";

/** Most labels, badges, chips and floats drawn in one frame. */
export const LABEL_CAP = 40;

export interface LabelItem {
  /** Stable identity across frames (an element is reused while its key persists). */
  key: string;
  kind: LabelKind;
  /** Scene position of the anchor; the scene may mutate it between frames (a sliding figure). */
  position: Vec3;
  text: string;
  /** Shown instead of `text` when the full text has no room (an agent label's id). */
  shortText?: string;
  /** Always shown, placed before everything else (the hovered or selected entity's label). */
  pinned?: boolean;
  /** A chip over a labelled figure: positions stacked above its anchor it may take when crowded (default 0). */
  nudges?: number;
  /** Extra class names (a chip's kind and failed classes, a float's colour role). */
  className?: string;
  title?: string;
  /** data-* attributes without the "data-" prefix. */
  attrs?: Record<string, string>;
  /** SVG path (24 x 24 viewBox) drawn before the text of a chip. */
  glyph?: string;
  /** 0..1 (floats fade out); default 1. */
  opacity?: number;
  /** "bottom": the element sits above the anchor; "center": centred on it. */
  anchor: "bottom" | "center";
  /** Higher priority survives the cap; ties broken by distance (nearest first). */
  priority: number;
  /** For clickable labels: the entity and its cell (onPick). */
  entityId?: string;
  cell?: Point;
}

interface Slot {
  el: HTMLElement;
  kind: LabelKind;
  text: string;
  title: string;
  className: string;
  opacity: number;
  attrs: string;
}

const CAPPED: ReadonlySet<LabelKind> = new Set<LabelKind>(["label", "badge", "chip", "float"]);
const SVG_NS = "http://www.w3.org/2000/svg";
/** A chip over a labelled figure tries at most this many positions stacked above its anchor. */
export const CHIP_NUDGES = 2;
/** Measured sizes kept at most (the cache is cleared beyond this). */
const SIZE_CACHE_MAX = 1000;

interface Size {
  width: number;
  height: number;
  /** The element's CSS margin-top (labels and chips sit a few px above their anchor). */
  marginTop: number;
}

interface Projected {
  item: LabelItem;
  x: number;
  y: number;
  depth: number;
}

/** One way to show an item: its text and a vertical nudge in px (negative = up). */
interface Option {
  text: string;
  dy: number;
}

function makeElement(item: LabelItem, onPick: (id: string, cell: Point) => void): HTMLElement {
  switch (item.kind) {
    case "label": {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "map3d-label";
      // A mouse press leaves focus where the controls put it (the viewport), so the keys keep working;
      // Tab still reaches the label and Enter or Space still picks it.
      el.addEventListener("mousedown", (event) => event.preventDefault());
      el.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = el.dataset.entityId;
        const cell = el.dataset.cell;
        if (!id || !cell) return;
        const [x, y] = cell.split(",").map((s) => parseInt(s, 10));
        onPick(id, { x, y });
      });
      return el;
    }
    case "badge": {
      const el = document.createElement("span");
      el.className = "map3d-badge";
      return el;
    }
    case "chip": {
      const el = document.createElement("div");
      el.className = "map3d-chip";
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "map3d-chip-glyph");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", item.glyph ?? "");
      svg.appendChild(path);
      const text = document.createElement("span");
      text.className = "map3d-chip-text";
      el.appendChild(svg);
      el.appendChild(text);
      return el;
    }
    case "float": {
      const el = document.createElement("span");
      el.className = "map3d-float";
      return el;
    }
    case "tick":
    default: {
      const el = document.createElement("span");
      el.className = "map3d-tick";
      return el;
    }
  }
}

function baseClass(kind: LabelKind): string {
  switch (kind) {
    case "label":
      return "map3d-label";
    case "badge":
      return "map3d-badge";
    case "chip":
      return "map3d-chip";
    case "float":
      return "map3d-float";
    default:
      return "map3d-tick";
  }
}

function classOf(item: LabelItem): string {
  return item.className ? `${baseClass(item.kind)} ${item.className}` : baseClass(item.kind);
}

function sizeKey(item: LabelItem, text: string): string {
  return `${classOf(item)}\n${text}`;
}

/** An invisible, inert copy of an item's element with `text`, for measuring. */
function makeProbe(item: LabelItem, text: string): HTMLElement {
  let el: HTMLElement;
  if (item.kind === "chip") {
    el = document.createElement("div");
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "map3d-chip-glyph");
    svg.setAttribute("viewBox", "0 0 24 24");
    const span = document.createElement("span");
    span.className = "map3d-chip-text";
    span.textContent = text;
    el.appendChild(svg);
    el.appendChild(span);
  } else {
    el = document.createElement(item.kind === "label" ? "button" : "span");
    el.textContent = text;
  }
  el.className = classOf(item);
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;
  el.style.visibility = "hidden";
  return el;
}

/** The pool.  Create one per view; `clear()` on dispose. */
export class LabelLayer {
  private readonly root: HTMLElement;
  private readonly onPick: (id: string, cell: Point) => void;
  private readonly slots = new Map<string, Slot>();
  private readonly compass: HTMLElement;
  private readonly v = new Vector3();
  /** Measured element sizes by class and text. */
  private readonly sizes = new Map<string, Size>();
  private compassYaw = Number.NaN;

  constructor(root: HTMLElement, onPick: (id: string, cell: Point) => void) {
    this.root = root;
    this.onPick = onPick;
    this.compass = document.createElement("div");
    this.compass.className = "map3d-compass";
    this.compass.title = "Compass: red = +x (east), green = +y (north)";
    this.compass.innerHTML =
      '<svg viewBox="-20 -20 40 40" aria-hidden="true"><line class="map3d-compass-y" x1="0" y1="0" x2="0" y2="-15"/><line class="map3d-compass-x" x1="0" y1="0" x2="15" y2="0"/><circle cx="0" cy="0" r="2.2"/><text class="map3d-compass-ylabel" x="0" y="-16">+y</text><text class="map3d-compass-xlabel" x="16" y="1">+x</text></svg>';
    this.root.appendChild(this.compass);
  }

  /** Rotate the compass so its +y arrow points where world north appears on screen (yaw in radians). */
  setCompass(yaw: number): void {
    if (yaw === this.compassYaw) return;
    this.compassYaw = yaw;
    this.compass.style.setProperty("--map3d-compass-rotation", `${-yaw}rad`);
  }

  /**
   * Show `items` for this frame: project every anchor with `camera` (viewport
   * `width` x `height` px), drop what is behind the camera or outside the
   * viewport, place the capped kinds without overlaps (placeOverlay, at most
   * LABEL_CAP), reuse elements by key and remove the rest.  Returns the number
   * of elements shown.
   */
  sync(items: readonly LabelItem[], camera: Camera, width: number, height: number): number {
    const projected: Projected[] = [];
    const inv = camera.matrixWorldInverse;
    const proj = camera.projectionMatrix;
    const v = this.v;
    for (const item of items) {
      v.set(item.position[0], item.position[1], item.position[2]).applyMatrix4(inv);
      const depth = -v.z;
      if (depth <= 0.05) continue;
      v.applyMatrix4(proj);
      if (v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2) continue;
      projected.push({ item, x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height, depth });
    }
    const capped = projected.filter((p) => CAPPED.has(p.item.kind));
    this.measure(capped);
    const options = new Map<string, Option[]>();
    const entries: OverlayEntry[] = [];
    for (const p of capped) {
      const item = p.item;
      if (item.kind === "float") {
        options.set(item.key, [{ text: item.text, dy: 0 }]);
        entries.push({ key: item.key, free: true, priority: item.priority, depth: p.depth, boxes: [{ left: p.x, top: p.y, right: p.x, bottom: p.y }] });
        continue;
      }
      const list = this.optionsFor(item);
      options.set(item.key, list);
      entries.push({ key: item.key, pinned: item.pinned, priority: item.priority, depth: p.depth, boxes: list.map((o) => this.boxOf(p, o)) });
    }
    const chosen = new Map<string, Option>();
    for (const placement of placeOverlay(entries, LABEL_CAP)) {
      const option = options.get(placement.key)?.[placement.box];
      if (option) chosen.set(placement.key, option);
    }
    const live = new Set<string>();
    for (const p of projected) {
      const item = p.item;
      const option: Option | undefined = CAPPED.has(item.kind) ? chosen.get(item.key) : { text: item.text, dy: 0 };
      if (!option) continue;
      live.add(item.key);
      let slot = this.slots.get(item.key);
      if (!slot || slot.kind !== item.kind) {
        if (slot) slot.el.remove();
        const el = makeElement(item, this.onPick);
        slot = { el, kind: item.kind, text: "", title: "", className: "", opacity: 1, attrs: "" };
        this.slots.set(item.key, slot);
        this.root.appendChild(el);
      }
      const el = slot.el;
      if (slot.text !== option.text) {
        slot.text = option.text;
        if (item.kind === "chip") {
          const span = el.querySelector(".map3d-chip-text");
          if (span) span.textContent = option.text;
        } else el.textContent = option.text;
      }
      const title = item.title ?? "";
      if (slot.title !== title) {
        slot.title = title;
        if (title) el.title = title;
        else el.removeAttribute("title");
      }
      const className = classOf(item);
      if (slot.className !== className) {
        slot.className = className;
        el.className = className;
      }
      const attrs = item.attrs ? JSON.stringify(item.attrs) : "";
      if (slot.attrs !== attrs) {
        slot.attrs = attrs;
        for (const name of Object.keys(el.dataset)) delete el.dataset[name];
        if (item.attrs) for (const [k, val] of Object.entries(item.attrs)) el.dataset[k] = val;
      }
      const opacity = item.opacity ?? 1;
      if (slot.opacity !== opacity) {
        slot.opacity = opacity;
        el.style.opacity = opacity >= 1 ? "" : String(opacity);
      }
      const shift = item.anchor === "bottom" ? "translate(-50%, -100%)" : "translate(-50%, -50%)";
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${(p.y + option.dy).toFixed(1)}px) ${shift}`;
    }
    for (const [key, slot] of this.slots) {
      if (!live.has(key)) {
        slot.el.remove();
        this.slots.delete(key);
      }
    }
    return live.size;
  }

  /** The ways an item may be shown, in order of preference. */
  private optionsFor(item: LabelItem): Option[] {
    const list: Option[] = [{ text: item.text, dy: 0 }];
    if (item.kind === "label" && item.shortText && item.shortText !== item.text) list.push({ text: item.shortText, dy: 0 });
    const nudges = item.kind === "chip" ? Math.min(CHIP_NUDGES, Math.max(0, item.nudges ?? 0)) : 0;
    if (nudges > 0) {
      const size = this.sizes.get(sizeKey(item, item.text));
      const step = (size ? size.height : 18) + OVERLAY_GAP;
      for (let i = 1; i <= nudges; i++) list.push({ text: item.text, dy: -step * i });
    }
    return list;
  }

  /** The screen box of `option` for a projected item (the element's CSS size and margin, its anchor). */
  private boxOf(p: Projected, option: Option): ScreenBox {
    const size = this.sizes.get(sizeKey(p.item, option.text)) ?? { width: 0, height: 0, marginTop: 0 };
    const y = p.y + option.dy + size.marginTop;
    const top = p.item.anchor === "bottom" ? y - size.height : y - size.height / 2;
    return { left: p.x - size.width / 2, top, right: p.x + size.width / 2, bottom: top + size.height };
  }

  /**
   * Measure every text the placement may use that has no cached size: probe
   * elements are built with the real classes, read in one layout pass and
   * removed, so a size always matches the CSS.
   */
  private measure(list: readonly Projected[]): void {
    if (this.sizes.size > SIZE_CACHE_MAX) this.sizes.clear();
    const probes: { key: string; el: HTMLElement }[] = [];
    const seen = new Set<string>();
    for (const p of list) {
      const item = p.item;
      if (item.kind === "float") continue;
      for (const option of this.optionsFor(item)) {
        const key = sizeKey(item, option.text);
        if (seen.has(key) || this.sizes.has(key)) continue;
        seen.add(key);
        const el = makeProbe(item, option.text);
        this.root.appendChild(el);
        probes.push({ key, el });
      }
    }
    for (const probe of probes) {
      const box = probe.el.getBoundingClientRect();
      const marginTop = parseFloat(getComputedStyle(probe.el).marginTop) || 0;
      // A detached or hidden root lays nothing out: do not cache zeros.
      if (box.width > 0 || box.height > 0) this.sizes.set(probe.key, { width: box.width, height: box.height, marginTop });
    }
    for (const probe of probes) probe.el.remove();
  }

  /** Remove every element (the compass included). */
  clear(): void {
    for (const slot of this.slots.values()) slot.el.remove();
    this.slots.clear();
    this.compass.remove();
  }
}
