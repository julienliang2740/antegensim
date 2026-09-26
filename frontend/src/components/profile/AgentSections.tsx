/**
 * The agent's sections of the entity profile card (spec U2 "agent stuff must
 * be very easy to see"; "Display and historical inspection": stats, balances,
 * model assignment, saved skills, current block/action, knowledge, received
 * messages, recent results and costs).  Every section reads the viewed turn:
 * the agent record of that turn, its knowledge view of that turn, and the
 * turns it acted in up to that turn.  With the agent view on, Overview shows
 * only what the agent believes about itself.
 *
 * DOCS: Decisions and Messages list committed turns newest first, 10 at a
 * time ("Show older"); each row can view its turn or open its decision
 * packet / model call in the record viewer.
 */

import { useState } from "react";
import type { Agent, AgentKnowledgeView, EffectiveSettingsView, RulesConfig, TurnIndexEntry, TurnView } from "../../api/types";
import { useTurnEvents } from "../../hooks/useTurnEvents";
import { PROFILE_PAGE, actingTurns, decisionFromEvents, excerpt, messageTurns, sentMessages, terrainAt } from "../../state/profile";
import type { RecordTarget } from "../../state/records";
import type { AgentNamer } from "../../state/statusText";
import { ExpandableJson, KeyValueTable, Section } from "../inspect/common";
import { ContextSettingsEditor } from "../inspect/ContextSettingsEditor";
import { fmtNum, fmtPoint, fmtValue } from "../inspect/format";
import { BelievedSelfTable, KnowledgeRecordsTable, NotebookView, ReceivedMessages, RecentResults } from "../inspect/KnowledgeSections";
import { agentSettings } from "../inspect/logic";
import { kv } from "../inspect/rows";
import type { KeyValueRow } from "../inspect/rows";
import { ExecutionStateView, SkillList } from "../inspect/SkillsSection";

const NOOP = () => {};

/** Knowledge of this agent, or null while it loads (or belongs to another agent). */
function ownKnowledge(agent: Agent, knowledge: AgentKnowledgeView | null): AgentKnowledgeView | null {
  return knowledge && knowledge.knowledge.agent_id === agent.id ? knowledge : null;
}

function KnowledgeMissing(props: { agent: Agent; error: string | null }) {
  return <p className={props.error ? "insp-bad" : "insp-muted"}>{props.error ? `Could not load the knowledge of ${props.agent.id}: ${props.error}` : `Loading the knowledge of ${props.agent.id}…`}</p>;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function AgentOverview(props: {
  agent: Agent;
  turn: TurnView;
  knowledge: AgentKnowledgeView | null;
  knowledgeError: string | null;
  settings: EffectiveSettingsView | null;
  rules: RulesConfig | null;
  agentView: boolean;
}) {
  const { agent, turn } = props;
  const knowledge = ownKnowledge(agent, props.knowledge);
  if (props.agentView) {
    return (
      <div>
        <div className="insp-banner insp-banner-agentview">
          Agent view: only what {agent.name} ({agent.id}) knows. Its Skills, Knowledge, Decisions and Messages are its own; authoritative stats, model settings and other
          entities are hidden here.
        </div>
        <KeyValueTable rows={[["position (told each turn)", fmtPoint(agent.position)]]} />
        <Section title="Believed self">{knowledge ? <BelievedSelfTable believed={knowledge.believed_self} /> : <KnowledgeMissing agent={agent} error={props.knowledgeError} />}</Section>
      </div>
    );
  }

  const s = agent.stats;
  const upgrades = agent.upgrade_counts;
  const upgradeTotal = Object.values(upgrades).reduce((sum, n) => sum + n, 0);
  const statRow = (label: string, value: string, attribute?: string): KeyValueRow => [
    label,
    <>
      {value}
      {attribute && upgrades[attribute] ? <span className="insp-badge">{upgrades[attribute]} upgrade(s)</span> : null}
    </>,
  ];
  const balances: KeyValueRow[] = [
    statRow("health / max", `${fmtNum(s.health)} / ${fmtNum(s.max_health)}`, "max_health"),
    statRow("compute", fmtNum(s.compute)),
    statRow("essence / capacity", `${fmtNum(s.essence)} / ${fmtNum(s.essence_capacity)}`, "essence_capacity"),
    statRow("attack", fmtNum(s.attack), "attack"),
    statRow("speed", fmtNum(s.speed), "speed"),
    statRow("vision_range", fmtNum(s.vision_range), "vision_range"),
  ];
  const attributes: KeyValueRow[] = [
    statRow("communication_range", fmtNum(s.communication_range), "communication_range"),
    statRow("compute_absorption", fmtNum(s.compute_absorption), "compute_absorption"),
    statRow("essence_absorption", fmtNum(s.essence_absorption), "essence_absorption"),
    statRow("skill_count_limit", fmtNum(s.skill_count_limit), "skill_count_limit"),
    statRow("skill_block_limit", fmtNum(s.skill_block_limit), "skill_block_limit"),
  ];
  const totals: KeyValueRow[] = [
    ["compute spent on actions", fmtNum(agent.total_compute_spent)],
    ["compute spent on cognition", fmtNum(agent.total_cognition_spent)],
    ["compute spent on interpreter", fmtNum(agent.total_interpreter_spent)],
    ["model calls answered", String(agent.model_call_count)],
    ["waiting turns remaining", String(agent.wait_turns_remaining)],
    kv(
      "upgrades bought",
      upgradeTotal === 0
        ? "none"
        : Object.entries(upgrades)
            .filter(([, n]) => n > 0)
            .map(([attribute, n]) => `${attribute} ×${n}`)
            .join(", "),
    ),
  ];

  const summary = agentSettings(agent.id, turn, props.settings);
  const activeRules = turn.rules ?? props.rules;
  const mind = summary && activeRules ? (activeRules.cognition.mind_multipliers[summary.modelKey] ?? activeRules.cognition.default_mind_multiplier) : null;
  const terrain = terrainAt(turn, agent.position);
  const identity: KeyValueRow[] = [
    ["name", agent.name],
    kv("id", <code>{agent.id}</code>),
    kv("alive", agent.alive ? "yes" : <span className="insp-bad">no, died in round {agent.died_round ?? "?"} ({agent.death_cause ?? "unknown cause"})</span>),
    ["position", `${fmtPoint(agent.position)}${terrain ? ` · ${terrain}` : ""}`],
    kv(
      "model",
      summary ? (
        <>
          <code>{summary.modelKey}</code> {summary.modelIsOverride ? <span className="insp-badge insp-badge-warn">agent override</span> : <span className="insp-badge">run default</span>}
        </>
      ) : (
        <span className="insp-muted">settings not loaded</span>
      ),
    ),
    ["mind multiplier", mind === null ? "?" : fmtNum(mind)],
    ["settings source", summary?.source ?? "?"],
  ];

  return (
    <div>
      <div className="profile-grid">
        <Section title="Identity">
          <KeyValueTable rows={identity} />
        </Section>
        <Section title="Totals">
          <KeyValueTable rows={totals} />
        </Section>
      </div>
      <Section title="Stats">
        <div className="insp-columns">
          <KeyValueTable rows={balances} />
          <KeyValueTable rows={attributes} />
        </div>
      </Section>
      <Section title="Last action and result">
        <LastActionView agent={agent} />
      </Section>
      {agent.persona ? (
        <Section title="Persona (operator-configured)">
          <pre className="insp-pre">{agent.persona}</pre>
        </Section>
      ) : null}
      <Section title="Context settings (per-agent overrides marked)" defaultOpen={false}>
        {summary ? (
          <ContextSettingsEditor readOnly label="Effective context settings" value={summary.runContext} overrides={summary.overrides} onOverridesChange={NOOP} onChange={NOOP} />
        ) : (
          <p className="insp-muted">Settings not loaded.</p>
        )}
      </Section>
    </div>
  );
}

function LastActionView(props: { agent: Agent }) {
  const { agent } = props;
  const result = agent.last_result;
  if (!agent.last_action && !result) return <p className="insp-muted">No action attempted yet.</p>;
  const rows: KeyValueRow[] = [];
  if (agent.last_action)
    rows.push([
      "last action",
      <>
        <strong>{agent.last_action.name}</strong> <ExpandableJson value={agent.last_action.args} maxChars={120} />
      </>,
    ]);
  if (result) {
    rows.push(kv("result", <span className={result.ok ? "insp-good" : "insp-bad"}>{result.ok ? "ok" : result.reason}</span>));
    rows.push(["charge (compute / essence)", `${fmtNum(result.cost_compute)} / ${fmtNum(result.cost_essence)}`]);
    rows.push(["round", String(result.round)]);
    // Cut at 200 characters inline, never without the "Show full JSON" control (no truncation).
    if (Object.keys(result.effects).length > 0) rows.push(["effects", <ExpandableJson key="effects" value={result.effects} maxChars={200} />]);
    if (Object.keys(result.data).length > 0) rows.push(["data", <ExpandableJson key="data" value={result.data} maxChars={200} />]);
  }
  return <KeyValueTable rows={rows} />;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

interface TurnListProps {
  runId: string;
  agent: Agent;
  turns: TurnIndexEntry[];
  /** The turn the page shows (live or history). */
  shownTurnId: string;
  name: AgentNamer;
  onViewTurn(turnId: string): void;
  onOpen(target: RecordTarget): void;
}

function Pager(props: { shown: number; total: number; what: string; onMore(): void }) {
  if (props.total === 0) return null;
  return (
    <div className="profile-pager">
      <span className="insp-muted">
        Showing {props.shown} of {props.total} {props.what}
      </span>
      {props.shown < props.total ? (
        <button type="button" className="btn btn-small" onClick={props.onMore}>
          Show {Math.min(PROFILE_PAGE, props.total - props.shown)} older
        </button>
      ) : null}
    </div>
  );
}

export function AgentDecisions(props: TurnListProps) {
  const { agent } = props;
  const acting = actingTurns(props.turns, agent.id, props.shownTurnId);
  const [limit, setLimit] = useState(PROFILE_PAGE);
  const page = acting.slice(0, limit);
  const loaded = useTurnEvents(
    props.runId,
    page.map((t) => t.turn_id),
  );

  return (
    <div>
      <p className="insp-hint">
        Turns in which {agent.name} ({agent.id}) acted, up to turn <code>{props.shownTurnId}</code>, newest first. Thought, action, result and cost come from each turn's saved
        events.
      </p>
      {acting.length === 0 ? <p className="insp-muted">No turn of {agent.id} up to the viewed turn.</p> : null}
      <ol className="profile-rows">
        {page.map((entry) => {
          const events = loaded.events.get(entry.turn_id) ?? null;
          const error = loaded.errors.get(entry.turn_id) ?? null;
          const d = events ? decisionFromEvents(agent.id, events) : null;
          const viewing = entry.turn_id === props.shownTurnId;
          const hasPacket = entry.decision_source === "model";
          return (
            <li key={entry.turn_id} className={`profile-row${viewing ? " profile-row-current" : ""}`} data-turn-id={entry.turn_id}>
              <div className="profile-row-head">
                <code>{entry.turn_id}</code>
                <span className="insp-muted">round {entry.round}</span>
                <span className="insp-badge">{entry.decision_source}</span>
                {entry.action_name ? (
                  <span className={entry.ok === false ? "insp-bad" : "insp-good"}>
                    <strong>{entry.action_name}</strong> {entry.ok === false ? "failed" : entry.ok ? "ok" : ""}
                  </span>
                ) : (
                  <span className="insp-muted">no action</span>
                )}
                {viewing ? <span className="insp-badge insp-badge-info">viewed turn</span> : null}
              </div>
              {d ? (
                <div className="profile-row-body">
                  {d.thought ? (
                    <details className="profile-thought">
                      <summary>“{excerpt(d.thought)}”</summary>
                      <pre className="insp-pre">{d.thought}</pre>
                    </details>
                  ) : null}
                  {d.action ? (
                    <div>
                      action <strong>{d.action.name}</strong> <span className="insp-small">{fmtValue(d.action.args, 100)}</span>
                      {d.viaSkill ? <span className="insp-badge insp-badge-info">via skill {d.skillName ?? ""}</span> : null}
                    </div>
                  ) : null}
                  {d.action ? (
                    <div>
                      result <span className={d.ok === false ? "insp-bad" : d.ok ? "insp-good" : undefined}>{d.ok === null ? "?" : d.ok ? "ok" : (d.reason ?? "failed")}</span> · cost{" "}
                      {fmtNum(d.costCompute)} compute{d.costEssence ? `, ${fmtNum(d.costEssence)} essence` : ""}
                      {d.thinkingCompute ? ` · thinking ${fmtNum(d.thinkingCompute)} compute` : ""}
                    </div>
                  ) : d.thinkingCompute ? (
                    <div>thinking {fmtNum(d.thinkingCompute)} compute</div>
                  ) : null}
                  {d.problem ? <div className="insp-bad">{d.problem}</div> : null}
                  {d.extras.length ? <div className="insp-small">{d.extras.join(" · ")}</div> : null}
                </div>
              ) : error ? (
                <div className="insp-bad">Could not load the events of this turn: {error}</div>
              ) : (
                <div className="insp-muted">Loading the turn's events…</div>
              )}
              <div className="profile-row-actions">
                <button type="button" className="btn btn-small" disabled={viewing} onClick={() => props.onViewTurn(entry.turn_id)}>
                  View turn
                </button>
                {hasPacket ? (
                  <button
                    type="button"
                    className="btn btn-small"
                    title={`Open decision packet pk_${entry.turn_id}`}
                    onClick={() => props.onOpen({ kind: "packet", turnId: entry.turn_id, packetId: `pk_${entry.turn_id}` })}
                  >
                    Packet
                  </button>
                ) : null}
                {(d?.callIds ?? []).map((callId, i, all) => (
                  <button key={callId} type="button" className="btn btn-small" title={`Open model call ${callId}`} onClick={() => props.onOpen({ kind: "call", turnId: entry.turn_id, callId })}>
                    Model call{all.length > 1 ? ` ${i + 1}` : ""}
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ol>
      <Pager shown={page.length} total={acting.length} what="turns" onMore={() => setLimit((n) => n + PROFILE_PAGE)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export function AgentSkills(props: { agent: Agent; turn: TurnView }) {
  const { agent } = props;
  return (
    <div>
      <Section title={`Saved skills (${Object.keys(agent.skills).length} of ${agent.stats.skill_count_limit})`}>
        <SkillList agent={agent} />
      </Section>
      <Section title="Skill execution state">
        <ExecutionStateView agent={agent} maxOpsPerTurn={props.turn.rules.skills.max_ops_per_turn} />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export function AgentKnowledge(props: { agent: Agent; knowledge: AgentKnowledgeView | null; knowledgeError: string | null; agentView: boolean }) {
  const { agent } = props;
  const knowledge = ownKnowledge(agent, props.knowledge);
  if (!knowledge) return <KnowledgeMissing agent={agent} error={props.knowledgeError} />;
  const records = knowledge.knowledge.records;
  const priorities = Object.entries(knowledge.knowledge.priorities).sort((a, b) => b[1] - a[1]);
  return (
    <div>
      <Section title={props.agentView ? "Believed self" : "Believed self vs actual"}>
        <BelievedSelfTable believed={knowledge.believed_self} actual={props.agentView ? null : agent.stats} />
      </Section>
      <Section title="Notebook">
        <NotebookView knowledge={knowledge} />
      </Section>
      <Section title={`Memory priorities (${priorities.length})`}>
        {priorities.length === 0 ? (
          <p className="insp-muted">No record is prioritised (the agent sets priorities in its decisions).</p>
        ) : (
          <table className="insp-table">
            <thead>
              <tr>
                <th>record</th>
                <th>priority</th>
                <th>text</th>
              </tr>
            </thead>
            <tbody>
              {priorities.map(([id, priority]) => {
                const r = records.find((x) => x.id === id);
                return (
                  <tr key={id}>
                    <td>
                      <code>{id}</code>
                    </td>
                    <td>{fmtNum(priority)}</td>
                    <td className="insp-small">{r ? excerpt(r.text, 140) : <span className="insp-muted">record no longer kept</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="Recent action results (as the agent recorded them)">
        <RecentResults knowledge={knowledge} />
      </Section>
      <Section title={`Knowledge records (${records.length})`}>
        <KnowledgeRecordsTable knowledge={knowledge} />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function AgentMessages(props: TurnListProps & { knowledge: AgentKnowledgeView | null; knowledgeError: string | null }) {
  const { agent } = props;
  const knowledge = ownKnowledge(agent, props.knowledge);
  const sent = messageTurns(actingTurns(props.turns, agent.id, props.shownTurnId));
  const [limit, setLimit] = useState(PROFILE_PAGE);
  const page = sent.slice(0, limit);
  const loaded = useTurnEvents(
    props.runId,
    page.map((t) => t.turn_id),
  );
  return (
    <div>
      <Section title={`Sent (${sent.length})`}>
        <p className="insp-hint">Send and broadcast actions of {agent.id} up to the viewed turn, newest first.</p>
        {sent.length === 0 ? <p className="insp-muted">{agent.id} has not sent a message up to the viewed turn.</p> : null}
        <ol className="profile-rows">
          {page.map((entry) => {
            const events = loaded.events.get(entry.turn_id) ?? null;
            const error = loaded.errors.get(entry.turn_id) ?? null;
            const messages = events ? sentMessages(agent.id, events) : [];
            return (
              <li key={entry.turn_id} className="profile-row">
                <div className="profile-row-head">
                  <code>{entry.turn_id}</code>
                  <span className="insp-muted">round {entry.round}</span>
                  <strong>{entry.action_name}</strong>
                </div>
                {events ? (
                  messages.map((m, i) => (
                    <div key={i} className="profile-row-body">
                      <div className="insp-message-text">“{m.message}”</div>
                      <div className="insp-small">
                        {m.kind === "send" ? `to ${props.name(m.recipient)}` : "broadcast"} ·{" "}
                        {m.ok === false ? (
                          <span className="insp-bad">not sent: {m.reason ?? "failed"}</span>
                        ) : m.delivered.length ? (
                          `reached ${m.delivered.map((id) => props.name(id)).join(", ")}`
                        ) : (
                          "reached nobody"
                        )}
                      </div>
                    </div>
                  ))
                ) : error ? (
                  <div className="insp-bad">Could not load the events of this turn: {error}</div>
                ) : (
                  <div className="insp-muted">Loading…</div>
                )}
                <div className="profile-row-actions">
                  <button type="button" className="btn btn-small" disabled={entry.turn_id === props.shownTurnId} onClick={() => props.onViewTurn(entry.turn_id)}>
                    View turn
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
        <Pager shown={page.length} total={sent.length} what="turns" onMore={() => setLimit((n) => n + PROFILE_PAGE)} />
      </Section>
      <Section title="Received messages and voice">
        {knowledge ? <ReceivedMessages knowledge={knowledge} /> : <KnowledgeMissing agent={agent} error={props.knowledgeError} />}
      </Section>
    </div>
  );
}
