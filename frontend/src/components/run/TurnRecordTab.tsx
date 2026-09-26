/**
 * The viewed turn's record told as a story (spec U5 "all actions and state
 * per turn"; "Display and historical inspection": expose changes alongside
 * their action/model records).  Read top to bottom:
 *
 *   headline  "Round 5, turn 3: Galene (a07) absorbed compute from fruit f0004 → ok, gained 12 compute, cost 3 compute"
 *   What the agent thought   (the model's own thought, or why there was none)
 *   What it was told         (decision packet and model calls)
 *   What it decided          (the action with labelled arguments; direct or via a skill)
 *   What happened            (ok / failure reason, effects, costs, returned data)
 *   State change             (compute / health / essence before → after)
 *   Edits applied at this boundary (one line per changed field)
 *   Events                   (collapsed)
 *   Turn facts               (collapsed: order, previous turn, seq range)
 *
 * A round-end turn tells plant growth, upkeep, starvation and deaths instead,
 * with every agent's balances before and after.  "Before" values come from
 * the previous turn's checkpoint (passed in by the page, loaded on demand).
 */

import type { ReactNode } from "react";
import type { Agent, TurnView } from "../../api/types";
import { describeIntervention, fmtNum } from "../inspect";
import { costText, feedTag, lineCategory } from "../../state/feed";
import type { AgentNamer } from "../../state/statusText";
import { JsonBlock } from "../common/Problems";
import type { RecordTarget } from "../../state/records";
import { eventNote } from "./eventNotes";
import {
  actionPhrase,
  agentStatRows,
  argRows,
  chargeText,
  changeLines,
  decisionInfo,
  decisionProblem,
  effectLines,
  headlineEffect,
  interpreterCost,
  noActionPhrase,
  otherAgentsTouched,
  roundEndSummary,
  thinkingCost,
} from "./turnStory";
import type { StatRow } from "./turnStory";

export interface TurnRecordTabProps {
  view: TurnView;
  /** Checkpoint of the previous turn (for "before" values); null while loading or unavailable. */
  previous: TurnView | null;
  /** Why `previous` is missing ("loading…", "in the parent run", an error); null when it is there or there is no previous turn. */
  previousNote: string | null;
  name: AgentNamer;
  onOpen(target: RecordTarget): void;
}

const SOURCE_TEXT: Record<string, string> = {
  model: "decided by its model this turn",
  skill: "a step of a saved skill (no model call)",
  wait: "still waiting from an earlier wait action",
  skipped_unaffordable: "skipped: could not afford to think",
  skipped_dead: "skipped: dead",
  skipped_removed: "skipped: removed",
  none: "no decision (world step)",
};

export function TurnRecordTab(props: TurnRecordTabProps) {
  const { view } = props;
  const t = view.turn;
  return (
    <div className="turn-tab turn-story">
      {t.kind === "agent_turn" ? <AgentTurnStory {...props} /> : t.kind === "round_end" ? <RoundEndStory {...props} /> : <InitStory {...props} />}
      <EditsSection view={view} />
      <EventsSection view={view} />
      <TurnFacts view={view} name={props.name} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent turn
// ---------------------------------------------------------------------------

function AgentTurnStory(props: TurnRecordTabProps) {
  const { view, name } = props;
  const t = view.turn;
  const actor = t.acting_agent_id;
  const actorName = actor ? name(actor) : "an agent";
  const decision = decisionInfo(view.events);
  const problem = decisionProblem(view.events);
  const result = t.action_result;
  const thinking = thinkingCost(view.events);
  const interpreter = interpreterCost(view.events);
  const packetIds = Array.from(new Set([...(t.packet_id ? [t.packet_id] : []), ...view.decision_packet_ids]));

  const what = t.action ? actionPhrase(t.action, view, name) : noActionPhrase(t, view.events);
  const outcome = result ? (result.ok ? "ok" : `failed: ${result.reason}`) : null;
  const effect = result ? headlineEffect(result, view, name) : null;
  const headlineTail = [outcome ? `→ ${outcome}` : null, effect, result ? chargeText(result) : null].filter(Boolean).join(", ");

  return (
    <>
      <header className="story-headline">
        <div className="story-kicker">
          Round {t.round}, turn {t.turn_index ?? "?"} · <code>{t.turn_id}</code> · {view.live ? "latest saved turn (live)" : "history"}
        </div>
        <h3 className={result ? (result.ok ? "story-ok" : "story-bad") : "story-none"}>
          {actorName} {what}
          {headlineTail ? <span className="story-outcome"> {headlineTail}</span> : null}
        </h3>
        <div className="hint">{SOURCE_TEXT[t.decision_source] ?? t.decision_source}</div>
      </header>

      <StorySection title="What the agent thought">
        {decision?.thought ? (
          <blockquote className="story-thought">{decision.thought}</blockquote>
        ) : t.decision_source === "model" ? (
          <p className="hint">The model gave no usable reply, so there is no thought to show.</p>
        ) : (
          <p className="hint">No model was asked this turn ({SOURCE_TEXT[t.decision_source] ?? t.decision_source}).</p>
        )}
        {problem ? (
          <p className="story-problem">
            <strong>Problem:</strong> {problem}
          </p>
        ) : null}
      </StorySection>

      <StorySection title="What it was told">
        {packetIds.length === 0 && view.model_calls.length === 0 ? <p className="hint">No decision packet or model call in this turn.</p> : null}
        <div className="record-links">
          {packetIds.map((id) => (
            <button
              key={id}
              type="button"
              className="btn btn-small"
              onClick={() =>
                props.onOpen({
                  kind: "packet",
                  turnId: t.turn_id,
                  packetId: id,
                })
              }
            >
              Open decision packet {id}
            </button>
          ))}
        </div>
        {view.model_calls.map((c) => (
          <div key={c.call_id} className="story-call">
            <button
              type="button"
              className="btn btn-small"
              onClick={() =>
                props.onOpen({
                  kind: "call",
                  turnId: t.turn_id,
                  callId: c.call_id,
                })
              }
            >
              Open model call {c.call_id}
            </button>{" "}
            <span className="hint">
              {c.model_key} · {c.status}
              {c.result_status ? ` / ${c.result_status}` : ""} · {c.input_tokens.toLocaleString()} in / {c.output_tokens.toLocaleString()} out tokens
              {c.reasoning_tokens > 0 ? ` (${c.reasoning_tokens} reasoning)` : ""} · {(c.latency_ms / 1000).toFixed(1)} s
              {typeof c.provider_cost_usd === "number" ? ` · $${c.provider_cost_usd.toFixed(4)}` : ""}
            </span>
          </div>
        ))}
      </StorySection>

      <StorySection title="What it decided">
        {t.action ? (
          <>
            <p>
              <strong className="story-action">{t.action.name}</strong>{" "}
              <span className="hint">
                {t.action.via_skill ? `via skill ${t.action.skill_name ?? "?"} (no model call for this step)` : "direct decision (not via a skill)"}
              </span>
            </p>
            {Object.keys(t.action.args).length > 0 ? (
              <table className="facts story-args">
                <tbody>
                  {argRows(t.action, view, name).map((row) => (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      <td>{row.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        ) : (
          <p className="hint">No action.</p>
        )}
        {decision && (decision.notebookUpdated || decision.savedSkills.length || decision.deletedSkills.length || decision.memoryPriorities) ? (
          <ul className="story-list">
            {decision.notebookUpdated ? <li>Rewrote its notebook.</li> : null}
            {decision.savedSkills.length ? <li>Saved skill(s): {decision.savedSkills.join(", ")}.</li> : null}
            {decision.deletedSkills.length ? <li>Deleted skill(s): {decision.deletedSkills.join(", ")}.</li> : null}
            {decision.memoryPriorities ? <li>Marked {decision.memoryPriorities} memory record(s) as important.</li> : null}
          </ul>
        ) : null}
      </StorySection>

      <StorySection title="What happened">
        {result ? (
          <>
            <p className={result.ok ? "text-good" : "text-bad"}>
              <strong>{result.ok ? "Succeeded." : `Failed: ${result.reason}.`}</strong>
            </p>
            {effectLines(result, view, name).length > 0 ? (
              <ul className="story-list">
                {effectLines(result, view, name).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="hint">Nothing happened in the world this turn.</p>
        )}
        <p>
          <strong>Costs:</strong> {result ? `action ${chargeText(result).replace(/^cost /, "")}` : "no action charge"}
          {thinking > 0 ? ` · thinking (model call) ${fmtNum(thinking)} compute` : ""}
          {interpreter > 0 ? ` · skill interpreter ${fmtNum(interpreter)} compute` : ""}
        </p>
        {result && Object.keys(result.data).length > 0 ? (
          <details className="packet-section">
            <summary>What the world told the agent (result data)</summary>
            <JsonBlock value={result.data} maxHeight={260} />
          </details>
        ) : null}
      </StorySection>

      <StorySection title="State change">
        {actor ? <AgentChange id={actor} label={actorName} props={props} /> : null}
        {otherAgentsTouched(result, actor).map((id) => (
          <AgentChange key={id} id={id} label={name(id)} props={props} />
        ))}
        {view.turn.interventions.length > 0 ? (
          <p className="hint">“Before” is the previous saved turn, so it also includes the edits applied at this boundary.</p>
        ) : null}
      </StorySection>
    </>
  );
}

function AgentChange(props: { id: string; label: string; props: TurnRecordTabProps }) {
  const { view, previous, previousNote } = props.props;
  const after = view.entities.agents[props.id] ?? null;
  const before = previous?.entities.agents[props.id] ?? null;
  if (!previous) {
    return (
      <p className="hint">
        {props.label}: {previousNote ?? "no earlier turn to compare with"}.
      </p>
    );
  }
  return <StatTable title={props.label} rows={agentStatRows(before, after)} />;
}

function StatTable(props: { title: string; rows: StatRow[] }) {
  return (
    <table className="data-table compact story-stats">
      <thead>
        <tr>
          <th>{props.title}</th>
          <th>before</th>
          <th>after</th>
          <th>change</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((r) => (
          <tr key={r.label} className={r.changed ? "story-changed" : undefined}>
            <th scope="row">{r.label}</th>
            <td>{r.before}</td>
            <td>{r.after}</td>
            <td>{r.delta ?? (r.changed ? "changed" : "—")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Round end and initial state
// ---------------------------------------------------------------------------

function RoundEndStory(props: TurnRecordTabProps) {
  const { view, previous, previousNote, name } = props;
  const t = view.turn;
  const s = roundEndSummary(view.events);
  const unpaid = s.upkeep.filter((u) => u.paid + 1e-9 < u.owed);
  const agents = Object.values(view.entities.agents);
  const headline = [
    s.growth.length ? "plants grew" : "no plant growth",
    s.upkeep.length ? `${s.upkeep.length} agent(s) paid upkeep${unpaid.length ? ` (${unpaid.length} could not pay in full)` : ""}` : null,
    s.deaths.length ? `${s.deaths.length} death(s)` : "no deaths",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <>
      <header className="story-headline">
        <div className="story-kicker">
          Round {t.round} end · <code>{t.turn_id}</code> · {view.live ? "latest saved turn (live)" : "history"}
        </div>
        <h3 className={s.deaths.length ? "story-bad" : "story-none"}>
          End of round {t.round}: {headline}
        </h3>
        {s.ended ? <div className="hint">{s.ended}</div> : null}
      </header>

      <StorySection title="Plants">
        {s.growth.length === 0 && s.spawns.length === 0 ? <p className="hint">No plant growth, fruit or seeds this round end.</p> : null}
        <ul className="story-list">
          {s.growth.map((line, i) => (
            <li key={`g${i}`}>{line}</li>
          ))}
          {s.spawns.map((line, i) => (
            <li key={`s${i}`}>{line}</li>
          ))}
        </ul>
      </StorySection>

      <StorySection title="Upkeep">
        {s.upkeep.length === 0 ? (
          <p className="hint">No upkeep charged.</p>
        ) : (
          <table className="data-table compact">
            <thead>
              <tr>
                <th>agent</th>
                <th>paid</th>
                <th>owed</th>
              </tr>
            </thead>
            <tbody>
              {s.upkeep.map((u) => (
                <tr key={u.agentId} className={u.paid + 1e-9 < u.owed ? "story-shortfall" : undefined}>
                  <td>{name(u.agentId)}</td>
                  <td>{fmtNum(u.paid)}</td>
                  <td>
                    {fmtNum(u.owed)}
                    {u.paid + 1e-9 < u.owed ? " — could not pay in full" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </StorySection>

      <StorySection title="Starvation and deaths">
        {s.starvation.length === 0 && s.deaths.length === 0 ? <p className="hint">Nobody starved or died.</p> : null}
        <ul className="story-list">
          {s.starvation.map((line, i) => (
            <li key={`st${i}`}>{line}</li>
          ))}
          {s.deaths.map((line, i) => (
            <li key={`d${i}`} className="text-bad">
              {line}
            </li>
          ))}
        </ul>
        {s.other.length > 0 ? (
          <ul className="story-list hint">
            {s.other.map((line, i) => (
              <li key={`o${i}`}>{line}</li>
            ))}
          </ul>
        ) : null}
      </StorySection>

      <StorySection title="Agents before and after the round end">
        {!previous ? (
          <p className="hint">{previousNote ?? "No earlier turn to compare with"}.</p>
        ) : (
          <AgentsChangeTable agents={agents} previous={previous} name={name} />
        )}
      </StorySection>
    </>
  );
}

function AgentsChangeTable(props: { agents: Agent[]; previous: TurnView; name: AgentNamer }) {
  // Agents that were already dead before this round end and did not change are left out.
  const shown = props.agents.filter((a) => {
    const b = props.previous.entities.agents[a.id];
    return a.alive || !b || b.alive || b.stats.compute !== a.stats.compute || b.stats.health !== a.stats.health || b.stats.essence !== a.stats.essence;
  });
  const hidden = props.agents.length - shown.length;
  const cell = (b: number | undefined, a: number) => {
    const d = b === undefined ? 0 : a - b;
    return (
      <td className={Math.abs(d) > 1e-9 ? "story-changed" : undefined}>
        {b === undefined ? "—" : fmtNum(b)} → {fmtNum(a)}
        {Math.abs(d) > 1e-9 ? (
          <span className="story-delta">
            {" "}
            ({d > 0 ? "+" : "−"}
            {fmtNum(Math.abs(d))})
          </span>
        ) : null}
      </td>
    );
  };
  return (
    <>
      <table className="data-table compact story-stats">
        <thead>
          <tr>
            <th>agent</th>
            <th>compute</th>
            <th>health</th>
            <th>essence</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((a) => {
            const b = props.previous.entities.agents[a.id];
            return (
              <tr key={a.id} className={a.alive ? undefined : "story-dead"}>
                <th scope="row">
                  {props.name(a.id)}
                  {a.alive ? "" : " (dead)"}
                </th>
                {cell(b?.stats.compute, a.stats.compute)}
                {cell(b?.stats.health, a.stats.health)}
                {cell(b?.stats.essence, a.stats.essence)}
              </tr>
            );
          })}
        </tbody>
      </table>
      {hidden > 0 ? <p className="hint">{hidden} agent(s) already dead before this round end are not listed.</p> : null}
    </>
  );
}

function InitStory(props: TurnRecordTabProps) {
  const t = props.view.turn;
  return (
    <header className="story-headline">
      <div className="story-kicker">
        <code>{t.turn_id}</code> · {props.view.live ? "latest saved turn (live)" : "history"}
      </div>
      <h3 className="story-none">Initial state of the run (round {t.round}): nothing has happened yet.</h3>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Shared sections
// ---------------------------------------------------------------------------

function StorySection(props: { title: string; children: ReactNode }) {
  return (
    <section className="story-section">
      <h4>{props.title}</h4>
      {props.children}
    </section>
  );
}

/** Operator edits applied at this turn's boundary: one line per intervention, then only the changed fields. */
function EditsSection(props: { view: TurnView }) {
  const records = props.view.turn.interventions;
  return (
    <StorySection title={`Edits applied at this boundary (${records.length})`}>
      {records.length === 0 ? <p className="hint">None: no operator edit took effect before this turn.</p> : null}
      {records.map((record, i) => {
        const lines = record.changes.flatMap(changeLines);
        const shown = lines.slice(0, 4);
        const rest = lines.slice(4);
        return (
          <div key={i} className={`intervention-record ${record.ok ? "" : "is-failed"}`}>
            <div>
              <code>{record.intervention.id ?? "?"}</code> {describeIntervention(record.intervention)} ·{" "}
              <span className="hint">{record.intervention.origin === "file" ? "file edit" : "UI"}</span> ·{" "}
              {record.ok ? <span className="text-good">applied</span> : <span className="text-bad">not applied: {record.error ?? "?"}</span>}
              {record.intervention.note ? <span className="hint"> · note: {record.intervention.note}</span> : null}
            </div>
            {shown.length > 0 ? (
              <ul className="story-changes">
                {shown.map((line, j) => (
                  <li key={j}>
                    <code>{line.path}</code>: {line.text}
                  </li>
                ))}
              </ul>
            ) : null}
            {rest.length > 0 ? (
              <details className="raw-value">
                <summary>{rest.length} more changed field(s)</summary>
                <ul className="story-changes">
                  {rest.map((line, j) => (
                    <li key={j}>
                      <code>{line.path}</code>: {line.text}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {record.changes.length > 0 ? (
              <details className="raw-value">
                <summary>raw before / after JSON</summary>
                <JsonBlock value={record.changes} maxHeight={240} />
              </details>
            ) : null}
          </div>
        );
      })}
    </StorySection>
  );
}

function EventsSection(props: { view: TurnView }) {
  const { view } = props;
  return (
    <details className="story-section story-events">
      <summary>
        <strong>Events recorded in this turn ({view.events.length})</strong> <span className="hint">the same lines as the live log</span>
      </summary>
      <div className="log-scroll log-static">
        {view.events.map((e) => (
          <div key={e.seq} className={`log-line cat-${lineCategory(e)}`}>
            <div className="log-meta">
              <span className="log-seq">#{e.seq}</span>
              <span className="log-tag">{feedTag(e)}</span>
              <span className="log-actor">{e.actor}</span>
              <span className="log-kind">{e.kind}</span>
              {costText(e) ? <span className="log-cost">cost {costText(e)}</span> : null}
            </div>
            <div className="log-summary">{e.summary}</div>
            {eventNote(e) ? <div className="log-detail">{eventNote(e)}</div> : null}
          </div>
        ))}
      </div>
    </details>
  );
}

function TurnFacts(props: { view: TurnView; name: AgentNamer }) {
  const { view } = props;
  const t = view.turn;
  return (
    <details className="story-section">
      <summary>
        <strong>Turn facts</strong> <span className="hint">order, previous turn, event range</span>
      </summary>
      <table className="facts">
        <tbody>
          <tr>
            <th scope="row">turn</th>
            <td>
              <code>{t.turn_id}</code> · kind {t.kind} · round {t.round}
              {t.turn_index !== null ? ` · turn ${t.turn_index}` : ""}
            </td>
          </tr>
          <tr>
            <th scope="row">acting agent</th>
            <td>{t.acting_agent_id ? props.name(t.acting_agent_id) : "none"}</td>
          </tr>
          <tr>
            <th scope="row">decision source</th>
            <td>{t.decision_source}</td>
          </tr>
          <tr>
            <th scope="row">initiative order</th>
            <td>
              {t.scheduler.order.map((id) => props.name(id)).join(" → ") || "none"} (next index {t.scheduler.next_index}
              {t.scheduler.round_complete ? ", round complete" : ""})
            </td>
          </tr>
          <tr>
            <th scope="row">previous turn</th>
            <td>
              <code>{t.previous_turn_id ?? "none"}</code>
              {view.parent ? ` (in parent run ${view.parent.run_id})` : ""}
            </td>
          </tr>
          <tr>
            <th scope="row">events</th>
            <td>
              seq {t.event_seq_start}–{t.event_seq_end} · saved {t.saved_at} · code {t.code_revision}
            </td>
          </tr>
        </tbody>
      </table>
    </details>
  );
}
