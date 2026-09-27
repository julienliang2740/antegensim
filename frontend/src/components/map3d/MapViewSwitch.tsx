/**
 * The view switch: a radiogroup labelled "Map view" with the radios "2D map"
 * and "3D view".  The run page passes it to both views as `legendExtra`, so it
 * sits at the end of the legend's controls row (like a map app's view toggle
 * in a corner) and costs the board no row of its own; only the shown view's
 * copy is visible (the 2D map stays mounted and hidden under the 3D view).  Pointing at "3D view" prefetches the 3D chunk so
 * the switch feels instant (keyboard focus does not: a user tabbing across the
 * page never pays the three.js download); the choice itself is the run page's
 * state (remembered under state/map3dView.ts::MAP_VIEW_STORAGE_KEY).
 *
 * Keyboard (ARIA radiogroup): the checked radio is the one tab stop; arrows,
 * Home and End move and select.  A switch made from one copy hands the focus
 * to the checked radio of the copy that becomes visible (the other view's
 * legend), so the keyboard user never loses the focus to a hidden element.
 */

// DOCS: div.map-view-switch[role=radiogroup][aria-label="Map view"] with button[role=radio][aria-checked] "2D map" and "3D view", rendered at the end of the shown view's legend controls row.

import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { requestSwitchFocus, takeSwitchFocus } from "../../state/map3dView";
import type { MapViewMode } from "../../state/map3dView";

export interface MapViewSwitchProps {
  value: MapViewMode;
  onChange(mode: MapViewMode): void;
  /** Called when the pointer enters the "3D view" radio (prefetch the chunk). */
  onPrefetch3d?(): void;
}

const OPTIONS: { mode: MapViewMode; label: string; title: string }[] = [
  { mode: "2d", label: "2D map", title: "The SVG map: dots, zoom and pan" },
  { mode: "3d", label: "3D view", title: "The 3D board: fly with W A S D, drag to look around" },
];

export function MapViewSwitch(props: MapViewSwitchProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  // After a switch the newly shown copy (the other view's toolbar, mounted or unhidden) takes the focus.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || root.getClientRects().length === 0 || !takeSwitchFocus(props.value)) return;
    const index = OPTIONS.findIndex((o) => o.mode === props.value);
    radios.current[index]?.focus({ preventScroll: true });
  }, [props.value]);

  const choose = (mode: MapViewMode, hadFocus: boolean) => {
    if (mode === props.value) return;
    requestSwitchFocus(hadFocus ? mode : null);
    props.onChange(mode);
  };

  // ARIA radiogroup keys: arrows move to the other option and select it; Home and End pick the first and last.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = Math.max(0, OPTIONS.findIndex((o) => o.mode === props.value));
    const last = OPTIONS.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? at === last
          ? 0
          : at + 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? at === 0
            ? last
            : at - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    if (next < 0) return;
    e.preventDefault();
    e.stopPropagation();
    radios.current[next]?.focus();
    choose(OPTIONS[next].mode, true);
  };

  return (
    <div ref={rootRef} className="map-view-switch" role="radiogroup" aria-label="Map view" onKeyDown={onKeyDown}>
      <span className="map-view-switch-label">Map view</span>
      {OPTIONS.map((o, i) => (
        <button
          key={o.mode}
          ref={(el) => {
            radios.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={props.value === o.mode}
          tabIndex={props.value === o.mode ? 0 : -1}
          className={`map-view-radio${props.value === o.mode ? " is-checked" : ""}`}
          title={o.title}
          onClick={(e) => choose(o.mode, document.activeElement === e.currentTarget)}
          onPointerEnter={o.mode === "3d" ? props.onPrefetch3d : undefined}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
