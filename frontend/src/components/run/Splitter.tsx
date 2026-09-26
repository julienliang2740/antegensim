/**
 * A drag handle between two panels of the run page (pointer drag, arrow keys
 * in 16 px steps, Home/End for the limits, double-click for the default).
 * `orientation` is the bar's own direction: "vertical" resizes widths,
 * "horizontal" resizes heights.  `direction` -1 means dragging right/down makes
 * the panel smaller (the panel is after the handle).
 */

import { useRef } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

export interface SplitterProps {
  orientation: "vertical" | "horizontal";
  label: string;
  value: number;
  min: number;
  max: number;
  direction: 1 | -1;
  onChange(value: number): void;
  onReset?(): void;
  className?: string;
  disabled?: boolean;
}

const KEY_STEP = 16;

export function Splitter(props: SplitterProps) {
  const drag = useRef<{ start: number; value: number; pointerId: number } | null>(null);
  const clamp = (v: number) => Math.max(props.min, Math.min(props.max, v));
  const coord = (e: ReactPointerEvent) => (props.orientation === "vertical" ? e.clientX : e.clientY);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (props.disabled || e.button !== 0) return;
    e.preventDefault();
    drag.current = { start: coord(e), value: props.value, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add(props.orientation === "vertical" ? "is-resizing-x" : "is-resizing-y");
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    props.onChange(clamp(d.value + props.direction * (coord(e) - d.start)));
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("is-resizing-x", "is-resizing-y");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (props.disabled) return;
    const grow = props.orientation === "vertical" ? ["ArrowRight", "ArrowLeft"] : ["ArrowDown", "ArrowUp"];
    let next: number | null = null;
    if (e.key === grow[0]) next = props.value + props.direction * KEY_STEP;
    else if (e.key === grow[1]) next = props.value - props.direction * KEY_STEP;
    else if (e.key === "Home") next = props.min;
    else if (e.key === "End") next = props.max;
    if (next === null) return;
    e.preventDefault();
    props.onChange(clamp(next));
  };

  return (
    <div
      role="separator"
      aria-orientation={props.orientation}
      aria-label={props.label}
      aria-valuenow={Math.round(props.value)}
      aria-valuemin={Math.round(props.min)}
      aria-valuemax={Math.round(props.max)}
      aria-disabled={props.disabled || undefined}
      tabIndex={props.disabled ? -1 : 0}
      title={`${props.label}: drag, or use the arrow keys; double-click for the default size`}
      className={`splitter splitter-${props.orientation}${props.disabled ? " is-disabled" : ""}${props.className ? ` ${props.className}` : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={props.onReset}
      onKeyDown={onKeyDown}
    />
  );
}
