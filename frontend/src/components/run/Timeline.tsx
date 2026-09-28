/**
 * History navigation (spec U6; "Display and historical inspection": left and
 * right round navigation, turn selection, live/history indicator and an
 * obvious return to live view).  Viewing history never changes the run.
 *
 * Placed to the left of the board: round/turn navigation and local saved-turn replay.
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
  playing: boolean;
  suspended: boolean;
  replayIntervalMs: number;
  onReplay(): void;
  onStopReplay(): void;
  onReplayOne(): void;
  onReplayInterval(ms: number): void;
  onView(turnId: string | null): void;
  onOpenParent(parent: ParentRef): void;
}

export function Timeline(props: TimelineProps) {
  const { turns, liveTurnId, viewTurnId, name } = props;
  const live = viewTurnId === null;
  const shownId = viewTurnId ?? liveTurnId;
  const shownEntry = turns.find((t) => t.turn_id === shownId) ?? null;
  const round = shownEntry ? shownEntry.round : turns.length > 0 ? lastRound(turns) : 0;
  const rounds = [...new Set(turns.map((turn) => turn.round))];
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
          <span title={shownId}>Round {round} · {shownEntry?.kind === "round_end" ? "round end" : shownEntry?.turn_index ? `turn ${shownEntry.turn_index}` : "initial state"}</span>
          <span className="hint timeline-fetch" aria-hidden={!props.loading}>{props.loading ? "Fetching the turn…" : "\u00a0"}</span>
        </span>
      </div>
      <button type="button" className="btn btn-primary timeline-return" disabled={live} onClick={() => props.onView(null)}>
        Return to live
      </button>
      <div className="timeline-nav">
        <span className="timeline-group" title={`Recorded rounds ${minRound}–${maxRound}`}>
          <label>Round <select aria-label="Jump to round" value={round} onChange={(event) => {
            const first = turns.find((turn) => turn.round === Number(event.target.value));
            if (first) go(first.turn_id);
          }}>{rounds.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        </span>
        <div className="timeline-pair">
          <button type="button" className="btn btn-small" disabled={previousRound === null} onClick={() => previousRound && go(previousRound)} aria-label="◀ Previous round" title="◀ Previous round">
            ◀
          </button>
          <button type="button" className="btn btn-small" disabled={nextRound === null} onClick={() => nextRound && go(nextRound)} aria-label="Next round ▶" title="Next round ▶">
            ▶
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
            <button type="button" className="btn btn-small" disabled={previousTurn === null} onClick={() => previousTurn && go(previousTurn)} aria-label="‹ Previous turn" title="‹ Previous turn">
              ‹
            </button>
          )}
          <button type="button" className="btn btn-small" disabled={nextTurn === null} onClick={() => nextTurn && go(nextTurn)} aria-label="Next turn ›" title="Next turn ›">
            ›
          </button>
        </div>
      </div>
      <label className="turn-select">
        <span className="turn-select-label">Turn in round {round}</span>
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
      <div className="saved-replay" role="group" aria-label="Saved turn playback">
        <span className="rail-label">Saved replay</span>
        <button type="button" className="btn btn-primary" disabled={!props.playing && (props.loading || !shownEntry)} onClick={props.playing ? props.onStopReplay : props.onReplay}>
          {props.playing ? "Stop playback" : shownId === liveTurnId ? "Play from beginning" : "Play from this turn"}
        </button>
        <button type="button" className="btn" disabled={props.loading || !shownEntry} onClick={props.onReplayOne} title="Replay only this turn's visual effects; the simulation does not advance.">Replay this turn's animation</button>
        <label>Speed <select aria-label="Replay speed" value={props.replayIntervalMs} onChange={(event) => props.onReplayInterval(Number(event.target.value))}>
          <option value={4400}>0.5×</option><option value={2200}>1×</option><option value={1100}>2×</option><option value={550}>4×</option>
        </select></label>
        <span className="saved-replay-note" role="status">{props.playing ? props.loadError ? "Playback paused: turn could not load. Stop playback or choose another turn." : props.suspended ? "Waiting for the turn or inspector…" : `Playing through the latest saved turn (round ${maxRound}).` : shownId === liveTurnId ? "At the latest turn. Playback starts at the beginning and plays through all saved rounds." : `Plays from here through the latest saved round (${maxRound}).`}</span>
      </div>
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
