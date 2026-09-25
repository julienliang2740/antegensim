/**
 * Live activity log styled like a terminal (spec U13 "see things real-time,
 * just pop up in terminals"; "Display and historical inspection": identify
 * round/turn, agent or operator, action, result and costs or errors;
 * distinguish pending activity such as a model call from completed effects;
 * INTERFACES section 7: the feed prints "[r{round} t{turn}] {actor} {summary}").
 *
 * Newest at the bottom; auto-scroll can be switched off to read older lines.
 * Lines of the viewed history turn are highlighted; lines above the last
 * saved turn are marked "in progress" while a turn runs, or "failed attempt"
 * when the run is idle (they belong to an attempt carried into the re-run).
 * A failed model call shows the provider's error, an invalid decision its
 * reason, and an operator edit what it changed.
 *
 * On narrow screens the page docks this log as a bottom drawer; "Hide log"
 * collapses it to its header line.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Event, RunStatus } from "../../api/types";
import { ROUTINE_KINDS, costText, feedTag, lineCategory, pendingStatus, resolvedCallIds, unsavedLineTag } from "../../state/feed";
import { eventNote } from "./eventNotes";

export interface ActivityLogProps {
  events: Event[];
  status: RunStatus | null;
  /** Highest event seq saved in a committed turn (lines above it belong to the turn in progress). */
  committedSeq: number | null;
  /** Turn shown in history mode (its lines are highlighted). */
  viewTurnId: string | null;
  /** Seqs of lines from a discarded attempt (not part of the saved history; struck through). */
  discardedSeqs?: ReadonlySet<number>;
  resets: number;
  pollError: string | null;
}

export function ActivityLog(props: ActivityLogProps) {
  const [follow, setFollow] = useState(true);
  const [hideRoutine, setHideRoutine] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const resolved = useMemo(() => resolvedCallIds(props.events), [props.events]);
  const shown = useMemo(() => (hideRoutine ? props.events.filter((e) => !ROUTINE_KINDS.includes(e.kind)) : props.events), [props.events, hideRoutine]);

  useEffect(() => {
    const el = scrollRef.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [shown, follow, collapsed]);

  const first = props.events[0]?.seq;
  const last = props.events[props.events.length - 1]?.seq;
  const unsavedTag = unsavedLineTag(props.status);

  return (
    <section className={`activity-log${collapsed ? " is-collapsed" : ""}`} aria-label="Live activity log">
      <div className="log-head">
        <strong>Live activity</strong>
        <span className="log-range">
          {props.events.length} lines{first !== undefined ? ` (seq ${first}–${last})` : ""}
          {props.resets > 0 ? ` · feed restarted ${props.resets}×` : ""}
        </span>
        <button type="button" className="btn btn-small log-collapse-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? "Show log" : "Hide log"}
        </button>
      </div>
      <div className="log-controls">
        <label>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Auto-scroll (follow newest)
        </label>
        <label>
          <input type="checkbox" checked={hideRoutine} onChange={(e) => setHideRoutine(e.target.checked)} /> Hide routine world events
        </label>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          Jump to newest
        </button>
      </div>
      <div className="log-legend">
        <span className="log-legend-item cat-pending">pending model call</span>
        <span className="log-legend-item cat-progress">not saved yet (turn in progress or failed attempt)</span>
        <span className="log-legend-item cat-operator">operator (god mode)</span>
        <span className="log-legend-item cat-error">failure / error</span>
      </div>
      {props.pollError ? <div className="log-warning">Feed problem: {props.pollError}</div> : null}
      <div className="log-scroll" ref={scrollRef} role="log" aria-live="off">
        {shown.length === 0 ? <div className="log-empty">No events yet.</div> : null}
        {shown.map((event) => (
          <LogLine
            key={event.seq}
            event={event}
            pending={event.pending ? pendingStatus(event, resolved, props.status) : null}
            unsavedTag={props.committedSeq !== null && event.seq > props.committedSeq ? unsavedTag : null}
            discarded={props.discardedSeqs?.has(event.seq) ?? false}
            highlighted={props.viewTurnId !== null && event.turn_id === props.viewTurnId}
          />
        ))}
      </div>
    </section>
  );
}

function LogLine(props: { event: Event; pending: ReturnType<typeof pendingStatus> | null; unsavedTag: string | null; discarded: boolean; highlighted: boolean }) {
  const { event } = props;
  const category = lineCategory(event);
  const cost = costText(event);
  const pendingNote =
    props.pending === "waiting"
      ? "WAITING FOR MODEL…"
      : props.pending === "answered"
        ? "answered (see next lines)"
        : props.pending === "failed"
          ? "failed (see next line)"
          : props.pending === "no_answer"
            ? "no answer recorded"
            : null;
  const note = eventNote(event);
  const classes = [
    "log-line",
    `cat-${category}`,
    props.pending === "waiting" ? "log-waiting" : "",
    props.unsavedTag ? "cat-progress" : "",
    props.discarded ? "cat-discarded" : "",
    props.highlighted ? "log-highlight" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} title={event.timestamp}>
      <div className="log-meta">
        <span className="log-seq">#{event.seq}</span>
        <span className="log-tag">{feedTag(event)}</span>
        <span className="log-actor">{event.actor}</span>
        <span className="log-kind">{event.kind}</span>
        {cost ? <span className="log-cost">cost {cost}</span> : null}
        {category === "operator" ? <span className="log-flag">OPERATOR</span> : null}
        {props.unsavedTag ? <span className="log-flag">{props.unsavedTag}</span> : null}
        {props.discarded ? <span className="log-flag">discarded attempt: not saved</span> : null}
        <span className="log-turn">{event.turn_id}</span>
      </div>
      <div className="log-summary">
        {event.summary}
        {pendingNote ? <span className="log-pending-note"> — {pendingNote}</span> : null}
      </div>
      {note ? <div className="log-detail">{note}</div> : null}
    </div>
  );
}
