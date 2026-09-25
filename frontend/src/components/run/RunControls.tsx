/**
 * Run turn / Play / Pause / Step round (spec U12 and "Sessions and run
 * controls").  Buttons are disabled per state and while a command request is
 * in flight, so commands never overlap (the backend also rejects overlaps
 * with 409).
 *
 * The page puts this row above the status bar, and everything that can
 * appear here later (the "Sending…" note, the help) takes no vertical room
 * next to the buttons, so the buttons stay where they are while the run plays
 * (the operator must be able to hit Pause).
 */

import type { RunCommand } from "../../api/types";
import type { ControlAvailability } from "../../state/statusText";

export interface RunControlsProps {
  allowed: ControlAvailability;
  inFlight: RunCommand | null;
  error: string | null;
  onCommand(command: RunCommand): void;
}

export function RunControls(props: RunControlsProps) {
  const { allowed, inFlight } = props;
  const button = (command: RunCommand, label: string, enabled: boolean, primary = false) => (
    <button
      type="button"
      className={`btn${primary ? " btn-primary" : ""}${inFlight === command ? " btn-busy" : ""}`}
      disabled={!enabled}
      onClick={() => props.onCommand(command)}
    >
      {label}
    </button>
  );
  return (
    <section className="run-controls" aria-label="Run controls">
      <div className="run-controls-row">
        {button("run_turn", "Run turn", allowed.runTurn, true)}
        {button("play", "Play", allowed.play)}
        {button("pause", "Pause", allowed.pause)}
        {button("step_round", "Step round", allowed.stepRound)}
        <details className="controls-help">
          <summary title="What do the run buttons do?" aria-label="Help: what the run buttons do">
            ?
          </summary>
          <div className="controls-help-body">
            <strong>Run turn</strong> = exactly one agent turn (or the round-end step), then pause. <strong>Step round</strong> = the rest of the current
            round, then pause. <strong>Play</strong> = keep going until paused. <strong>Pause</strong> stops before the next turn; an active turn finishes and
            is saved.
          </div>
        </details>
        <span className="run-controls-sending hint" aria-live="polite">
          {inFlight ? `Sending ${inFlight.replace("_", " ")}…` : ""}
        </span>
      </div>
      {props.error ? (
        <div className="error-line" role="alert">
          Command refused: {props.error}
        </div>
      ) : null}
    </section>
  );
}
