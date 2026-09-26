/**
 * History navigation (spec U6; "Display and historical inspection": left and
 * right round navigation, turn selection, live/history indicator and an
 * obvious return to live view).  Viewing history never changes the run.
 *
 * Laid out for the run page's left rail: mode badge and sentence, Return to
 * live, round arrows, turn arrows and the turn selector, stacked.
 *
 * On a continuation's first turn the previous arrow leads into the parent
 * run at the copied turn (INTERFACES sections 9 and 11: "previous" resolves
 * through TurnView.parent).
 */

import type { ParentRef, TurnIndexEntry } from "../../api/types";
import type { AgentNamer } from "../../state/statusText";
import { firstRound, lastRound, lastTurnOfRound, neighborTurnId, turnOptionLabel, turnsOfRound } from "../../state/timeline";

export interface TimelineProps {
  turns: TurnIndexEntry[];
  /** The latest committed turn (status.current_turn_id). */
  liveTurnId: string;
  /** Turn shown in history mode; null in live mode. */
  viewTurnId: string | null;
  loading: boolean;
  loadError: string | null;
  name: AgentNamer;
  /** Parent run of the viewed turn (first turn of a continuation). */
  parent: ParentRef | null;
  onView(turnId: string | null): void;
  onOpenParent(parent: ParentRef): void;
}

export function Timeline(props: TimelineProps) {
  const { turns, liveTurnId, viewTurnId, name } = props;
  const live = viewTurnId === null;
  const shownId = viewTurnId ?? liveTurnId;
  const shownEntry = turns.find((t) => t.turn_id === shownId) ?? null;
  const round = shownEntry ? shownEntry.round : turns.length > 0 ? lastRound(turns) : 0;
  const inRound = turnsOfRound(turns, round);
  const agentTurns = inRound.filter((t) => t.kind === "agent_turn");
  const otherTurns = inRound.filter((t) => t.kind !== "agent_turn");
  const knownShown = inRound.some((t) => t.turn_id === shownId);

  // Reaching the latest committed turn by navigation switches back to live view.
  const go = (turnId: string | null) => props.onView(turnId === null || turnId === liveTurnId ? null : turnId);
  const previousTurn = neighborTurnId(turns, shownId, -1);
  const nextTurn = neighborTurnId(turns, shownId, +1);
  const minRound = firstRound(turns);
  const maxRound = lastRound(turns);
  const previousRound = round > minRound ? lastTurnOfRound(turns, round - 1) : null;
  const nextRound = round < maxRound ? lastTurnOfRound(turns, round + 1) : null;

  return (
    <section className={`timeline ${live ? "timeline-live" : "timeline-history"}`} aria-label="History timeline">
      <div className="timeline-mode">
        <span className={`mode-badge ${live ? "mode-live" : "mode-history"}`}>{live ? "LIVE" : "HISTORY"}</span>
        <span className="timeline-mode-text">
          {live ? (
            <>
              Following the latest saved turn <code>{liveTurnId}</code>.
            </>
          ) : (
            <>
              Viewing history: turn <code>{viewTurnId}</code> (round {round}). The run itself is unchanged and the live log keeps running.
            </>
          )}
          {props.loading ? <span className="hint"> Fetching the turn…</span> : null}
        </span>
      </div>
      <button type="button" className="btn btn-primary timeline-return" disabled={live} onClick={() => props.onView(null)}>
        Return to live
      </button>
      <div className="timeline-nav">
        <span className="timeline-group" title={`Recorded rounds ${minRound}–${maxRound}`}>
          Round <span className="timeline-round">{round}</span>
        </span>
        <div className="timeline-pair">
          <button type="button" className="btn btn-small" disabled={previousRound === null} onClick={() => previousRound && go(previousRound)}>
            ◀ Previous round
          </button>
          <button type="button" className="btn btn-small" disabled={nextRound === null} onClick={() => nextRound && go(nextRound)}>
            Next round ▶
          </button>
        </div>
      </div>
      <div className="timeline-nav">
        <span className="timeline-group">Turn</span>
        <div className="timeline-pair">
          {previousTurn === null && props.parent ? (
            <button
              type="button"
              className="btn btn-small"
              title={`Open the parent run ${props.parent.run_id} at turn ${props.parent.turn_id}`}
              onClick={() => props.parent && props.onOpenParent(props.parent)}
            >
              ‹ Parent run
            </button>
          ) : (
            <button type="button" className="btn btn-small" disabled={previousTurn === null} onClick={() => previousTurn && go(previousTurn)}>
              ‹ Previous turn
            </button>
          )}
          <button type="button" className="btn btn-small" disabled={nextTurn === null} onClick={() => nextTurn && go(nextTurn)}>
            Next turn ›
          </button>
        </div>
      </div>
      <label className="turn-select">
        <span>Turn in round {round}</span>
        <select value={shownId} onChange={(e) => go(e.target.value)} title={shownId}>
          {!knownShown ? <option value={shownId}>{shownId}</option> : null}
          {otherTurns
            .filter((t) => t.kind === "init")
            .map((t) => (
              <option key={t.turn_id} value={t.turn_id}>
                {turnOptionLabel(t, name)}
              </option>
            ))}
          {agentTurns.length > 0 ? (
            <optgroup label={`Agent turns of round ${round} (${agentTurns.length})`}>
              {agentTurns.map((t) => (
                <option key={t.turn_id} value={t.turn_id}>
                  {turnOptionLabel(t, name)}
                  {t.turn_id === liveTurnId ? " (latest)" : ""}
                </option>
              ))}
            </optgroup>
          ) : null}
          {otherTurns.some((t) => t.kind === "round_end") ? (
            <optgroup label="Round end">
              {otherTurns
                .filter((t) => t.kind === "round_end")
                .map((t) => (
                  <option key={t.turn_id} value={t.turn_id}>
                    {turnOptionLabel(t, name)}
                    {t.turn_id === liveTurnId ? " (latest)" : ""}
                  </option>
                ))}
            </optgroup>
          ) : null}
        </select>
      </label>
      {props.parent ? (
        <div className="timeline-parent">
          ← Earlier history is in the parent run <code>{props.parent.run_id}</code> at turn <code>{props.parent.turn_id}</code>.{" "}
          <button type="button" className="btn btn-small" onClick={() => props.parent && props.onOpenParent(props.parent)}>
            Open parent run at that turn
          </button>
        </div>
      ) : null}
      {props.loadError ? (
        <div className="error-line" role="alert">
          Could not load the turn: {props.loadError}
        </div>
      ) : null}
    </section>
  );
}
