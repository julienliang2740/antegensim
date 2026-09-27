/** Simulation commands retain their existing availability and API mapping.
 * Start/Pause share one stable button; single-turn and round controls stay separate.
 * Saved-turn playback lives beneath the board and never sends these commands.
 */

import type { RunCommand } from "../../api/types";
import type { ControlAvailability } from "../../state/statusText";

export interface RunControlsProps {
  allowed: ControlAvailability;
  running: boolean;
  inFlight: RunCommand | null;
  error: string | null;
  onCommand(command: RunCommand): void;
  /** Put the panel sizes (splitters) back to their defaults; the button is in the help popover. */
  onResetLayout?(): void;
}

export function RunControls(props: RunControlsProps) {
  const { allowed, inFlight } = props;
  const button = (command: RunCommand, label: string, hint: string, enabled: boolean, primary = false) => (
    <button
      type="button"
      className={`btn${primary ? " btn-primary" : ""}${inFlight === command ? " btn-busy" : ""}`}
      aria-label={label}
      title={hint}
      disabled={!enabled}
      onClick={() => props.onCommand(command)}
    >
      <span>{label}</span><small>{hint}</small>
    </button>
  );
  return (
    <section className="run-controls" aria-label="Run controls">
      <div className="run-controls-head">
        <span className="rail-label">Advance simulation</span>
        <details className="controls-help">
          <summary title="What do the run buttons do?" aria-label="Help: what the run buttons do">
            ?
          </summary>
          <div className="controls-help-body">
            <strong>Advance 1 turn</strong> runs one agent action (or the round-end update), then stops.
            <strong> Finish round</strong> runs the remaining agents and the world update, then stops.
            <strong> Start simulation</strong> keeps creating new turns until you press <strong>Pause simulation</strong>.
            An active turn finishes and is saved before pausing. To watch saved turns, use Replay from here beneath the board.
            {props.onResetLayout ? (
              <div className="controls-help-layout">
                <strong>Layout:</strong> open a workspace panel, then drag its edge (or focus the resize handle and use the arrow keys) to resize it; double-click a resize handle for its default size.{" "}
                <button type="button" className="btn btn-small" onClick={props.onResetLayout}>
                  Reset layout
                </button>
              </div>
            ) : null}
          </div>
        </details>
        <span className="run-controls-sending hint" aria-live="polite">
          {inFlight ? `Sending ${inFlight.replace("_", " ")}…` : ""}
        </span>
      </div>
      <div className="run-controls-grid">
        {props.running
          ? button("pause", "Pause simulation", "Stop after the active turn", allowed.pause, true)
          : button("play", "Start simulation", "Keep generating new turns", allowed.play, true)}
        {button("run_turn", "Advance 1 turn", "One action, then stop", allowed.runTurn)}
        {button("step_round", "Finish round", "Rest of round, then stop", allowed.stepRound)}
      </div>
      {props.error ? (
        <div className="error-line" role="alert">
          Command refused: {props.error}
        </div>
      ) : null}
    </section>
  );
}
