/**
 * The shared "a model is working" indicator: an animated spinner (a static
 * dotted ring under prefers-reduced-motion), a label, an elapsed-seconds
 * counter ticking client-side from `startedAt` (a job's started_at or a
 * message's created_at; without one it counts from when this indicator first
 * showed `workKey`), an optional note and cost, and an optional Cancel button.
 * `WorkingSpinner` is the glyph alone, for buttons ("Writing the brief…",
 * "Thinking…", "Transcribing…").
 *
 * DOCS: used by the Story Mode banner, interview, reader and composer, the
 * assistant drawer's message in progress and Send button, the Storybook tab's
 * status line and Dictate.  The wrapper is role="status" aria-live="polite"
 * aria-busy="true" (announce={false} drops the live region for a second copy of
 * the same work); the ticking counter is aria-hidden so screen readers hear the
 * label once, not every second.  Class prefix: working-*.
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { elapsedSince, formatElapsed, trackStart } from "../../state/working";
import type { WorkStart } from "../../state/working";
import "../../working.css";

/** The spinner glyph alone (decorative). */
export function WorkingSpinner(props: { className?: string }) {
  return <span className={`working-spinner${props.className ? ` ${props.className}` : ""}`} aria-hidden="true" />;
}

export interface WorkingProps {
  label: string;
  /** ISO timestamp or epoch ms the work started; null/absent: count from when the indicator first showed `workKey`. */
  startedAt?: string | number | null;
  /** Identifies the piece of work; a new key restarts a locally tracked counter. */
  workKey?: string;
  /** Show the elapsed counter (default true). */
  showElapsed?: boolean;
  note?: ReactNode;
  /** Spent so far (shown as "$0.03"). */
  costUsd?: number | null;
  onCancel?(): void;
  cancelLabel?: string;
  cancelDisabled?: boolean;
  /** "banner": the prominent page strip; "inline": inside a message or a chapter; "compact": one line in a status row. */
  variant?: "banner" | "inline" | "compact";
  /** false: a second copy of work another indicator on the page already announces (no live region; still aria-busy). */
  announce?: boolean;
  className?: string;
}

function usd(value: number): string {
  if (value > 0 && value < 0.005) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

export function Working(props: WorkingProps) {
  const key = props.workKey ?? props.label;
  const showElapsed = props.showElapsed ?? true;
  const [clock, setClock] = useState<{ now: number; start: WorkStart }>(() => {
    const now = Date.now();
    return { now, start: { key, startMs: now } };
  });

  useEffect(() => {
    if (!showElapsed) return;
    const tick = () =>
      setClock((c) => {
        const now = Date.now();
        return { now, start: trackStart(c.start, key, null, now) };
      });
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [key, showElapsed]);

  const server = elapsedSince(props.startedAt ?? null, clock.now);
  const local = clock.start.key === key ? Math.max(0, Math.floor((clock.now - clock.start.startMs) / 1000)) : 0;
  const elapsed = server ?? local;
  const variant = props.variant ?? "inline";
  const live = props.announce ?? true;

  return (
    <div
      className={`working working-${variant}${props.className ? ` ${props.className}` : ""}`}
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
      aria-busy="true"
    >
      <WorkingSpinner />
      <div className="working-body">
        <div className="working-line">
          <span className="working-label">{props.label}</span>
          {showElapsed ? (
            <span className="working-elapsed" aria-hidden="true">
              {formatElapsed(elapsed)}
            </span>
          ) : null}
          {props.costUsd ? <span className="working-cost">{usd(props.costUsd)}</span> : null}
        </div>
        {props.note ? <div className="working-note">{props.note}</div> : null}
      </div>
      {props.onCancel ? (
        <button type="button" className="btn btn-small working-cancel" disabled={props.cancelDisabled} onClick={props.onCancel}>
          {props.cancelLabel ?? "Cancel"}
        </button>
      ) : null}
    </div>
  );
}
