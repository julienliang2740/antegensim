/**
 * The story brief (amended D8; OWNER: WP6): title, premise, style guide, cast
 * map, chapter plan, per-turn AND per-round estimates side by side (click one
 * to choose the chapter unit), what stays faithful vs what is embellished, the
 * job budget, and Accept (named by effect) / Change / Cancel.  Accept starts
 * the chapter job lazily (3 chapters ahead of the reader); "Generate all"
 * lives in the reader.  "Proposed in reply to" quotes the message that asked
 * for it.
 */

import { useId, useState } from "react";
import type { ChapterUnit, StoryBrief, StorySession } from "../../api/storyTypes";
import { briefEstimates, formatDuration, formatSpent, formatUsd, planSummary, turnLabel, type RangeCounts } from "../../state/storyMode";

export interface BriefCardProps {
  brief: StoryBrief;
  session: StorySession;
  /** Local counts for a fallback estimate when the backend gave none. */
  counts: RangeCounts | null;
  busy: boolean;
  /** True while the Change composer is open below the card. */
  changing: boolean;
  onAccept(unit: ChapterUnit, jobBudgetUsd: number): void;
  onChange(): void;
  onCancel(): void;
}

export function BriefCard(props: BriefCardProps) {
  const { brief, session, busy } = props;
  const id = useId();
  const [unit, setUnit] = useState<ChapterUnit>(brief.picks.unit === "round" ? "round" : "turn");
  const [budget, setBudget] = useState<string>(String(brief.job_budget_usd));
  const estimates = briefEstimates(brief, props.counts);
  const chosen = estimates[unit];
  const budgetValue = Number(budget);
  const budgetOk = Number.isFinite(budgetValue) && budgetValue >= 0;
  const inReplyTo = session.messages.find((m) => m.message_id === brief.in_reply_to);
  const plan = brief.chapter_plan;
  const acceptLabel = chosen ? `Accept: write ${chosen.chapters} ${chosen.chapters === 1 ? "chapter" : "chapters"} per ${unit}, 3 at a time as you read` : `Accept: write chapters per ${unit}`;

  return (
    <section className="storymode-card storymode-brief" aria-labelledby={`${id}-title`}>
      <div className="storymode-card-head">
        <div>
          <span className="storymode-kicker">Story brief · waiting for your decision</span>
          <h2 id={`${id}-title`}>{brief.title.trim() || "Untitled story"}</h2>
        </div>
        <span className="hint">
          {brief.picks.genre} · {brief.picks.tone} · vividness {brief.picks.vividness} · {brief.picks.pov === "follow" && brief.picks.follow_agent_id ? `following ${brief.picks.follow_agent_id}` : "chronicler"}
        </span>
      </div>
      {inReplyTo ? (
        <p className="hint">
          Proposed in reply to: <q>{inReplyTo.text.trim().slice(0, 240) || "(your choices)"}</q>
        </p>
      ) : null}

      <p className="storymode-brief-premise">{brief.premise}</p>

      <div className="storymode-brief-cols">
        <div>
          <div className="storymode-brief-list-title">Stays faithful</div>
          {brief.faithful.length ? (
            <ul className="storymode-brief-list">
              {brief.faithful.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="hint">Every recorded event, death and message.</p>
          )}
        </div>
        <div>
          <div className="storymode-brief-list-title">Embellished</div>
          {brief.embellished.length ? (
            <ul className="storymode-brief-list">
              {brief.embellished.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="hint">Dialogue, scenery and inner voices.</p>
          )}
        </div>
      </div>

      <h3>Chapters and cost</h3>
      <div className="storymode-estimates" role="radiogroup" aria-label="Chapter unit">
        {(["turn", "round"] as ChapterUnit[]).map((option) => {
          const estimate = estimates[option];
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={unit === option}
              className={`storymode-estimate${unit === option ? " is-chosen" : ""}`}
              disabled={busy}
              onClick={() => setUnit(option)}
            >
              <span className="storymode-estimate-title">One chapter per {option}</span>
              {estimate ? (
                <>
                  <span className="storymode-estimate-big">{estimate.chapters} {estimate.chapters === 1 ? "chapter" : "chapters"}</span>
                  <span>
                    {formatUsd(estimate.costUsd)} · {formatDuration(estimate.seconds)} for the whole story
                  </span>
                </>
              ) : (
                <span className="hint">no estimate</span>
              )}
              <span className="hint">{option === "turn" ? "Quiet turns become short interludes." : "Fewer, longer chapters."}</span>
            </button>
          );
        })}
      </div>
      {plan.length > 0 ? (
        <details className="storymode-plan">
          <summary>
            Chapter plan for the {brief.picks.unit === "round" ? "per-round" : "per-turn"} unit: {planSummary(plan)}
          </summary>
          <ol>
            {plan.slice(0, 40).map((entry) => (
              <li key={entry.number}>
                {entry.title || (entry.kind === "interlude" ? "Interlude" : entry.kind === "chapter" ? "Chapter" : entry.kind)}
                {entry.turn_ids.length ? <span className="hint"> · {entry.turn_ids.length === 1 ? turnLabel(entry.turn_ids[0]) : `${entry.turn_ids.length} turns`}</span> : null}
              </li>
            ))}
            {plan.length > 40 ? <li className="hint">… and {plan.length - 40} more</li> : null}
          </ol>
        </details>
      ) : null}

      <details>
        <summary>Style guide and cast</summary>
        <p>{brief.style_guide}</p>
        {brief.cast_map.length ? (
          <table className="data-table compact storymode-cast-map">
            <thead>
              <tr>
                <th>Agent</th>
                <th>In the story</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {brief.cast_map.map((m) => (
                <tr key={m.agent_id}>
                  <td>
                    <code>{m.agent_id}</code>
                  </td>
                  <td>{m.story_name}</td>
                  <td>{m.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </details>

      <div className="storymode-brief-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !budgetOk} onClick={() => props.onAccept(unit, budgetValue)} title="Starts the chapter job; chapters are written three ahead of where you read">
          {acceptLabel}
        </button>
        <button type="button" className="btn" disabled={busy || props.changing} onClick={props.onChange} title="Tell the author what to change; this brief is superseded by the new one">
          Change
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={props.onCancel} title="Reject the brief; nothing is generated">
          Cancel
        </button>
        <label className="field field-short" title="The job stops (paused, resumable by raising it) when chapter spend reaches this amount">
          <span>Job budget (USD)</span>
          <input type="number" min={0} step={0.5} value={budget} disabled={busy} onChange={(e) => setBudget(e.target.value)} />
        </label>
        {session.spent_usd > 0 ? <span className="hint">spent so far {formatSpent(session.spent_usd)}</span> : null}
      </div>
    </section>
  );
}
