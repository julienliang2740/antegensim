/**
 * Agent inspector (spec U2; "Display and historical inspection": stats,
 * balances, model assignment, saved skills, current block/action, knowledge,
 * received messages and recent results/costs; omniscient inspection kept
 * separate from the agent-view overlay that shows only permitted information).
 */

import type { Agent, AgentKnowledgeView, EffectiveSettingsView, RulesConfig, TurnView } from "../../api/types";
import { ExpandableJson, KeyValueTable, Section } from "./common";
import { kv } from "./rows";
import type { KeyValueRow } from "./rows";
import { ContextSettingsEditor } from "./ContextSettingsEditor";
import { fmtNum, fmtPoint, fmtValue } from "./format";
import { BelievedSelfTable, KnowledgeRecordsTable, NotebookView, ReceivedMessages, RecentResults } from "./KnowledgeSections";
import { agentSettings } from "./logic";
import { ExecutionStateView, SkillList } from "./SkillsSection";

export interface AgentInspectorProps {
  agent: Agent;
  turn: TurnView | null;
  knowledge: AgentKnowledgeView | null;
  settings: EffectiveSettingsView | null;
  rules: RulesConfig | null;
  agentView: boolean;
  onOpenModelCall(callId: string): void;
  onOpenPacket(packetId: string): void;
}

const NOOP = () => {};

export function AgentInspector(props: AgentInspectorProps) {
  const { agent, turn, rules } = props;
  const knowledge = props.knowledge && props.knowledge.knowledge.agent_id === agent.id ? props.knowledge : null;
  const knowledgeMissing = <p className="insp-muted">Knowledge not loaded for {agent.id} yet.</p>;
  const recordCount = knowledge?.knowledge.records.length ?? 0;

  if (props.agentView) {
    return (
      <div className="insp-agentview">
        <div className="insp-banner insp-banner-agentview">
          Agent view: only what {agent.name} ({agent.id}) knows — its believed self, notebook, skills, received messages and own records.
          Authoritative stats, model settings and other entities are hidden.
        </div>
        <KeyValueTable rows={[["position (told each turn)", fmtPoint(agent.position)]]} />
        <Section title="Believed self">{knowledge ? <BelievedSelfTable believed={knowledge.believed_self} /> : knowledgeMissing}</Section>
        <Section title="Notebook">{knowledge ? <NotebookView knowledge={knowledge} /> : knowledgeMissing}</Section>
        <Section title={`Saved skills (${Object.keys(agent.skills).length})`}>
          <SkillList agent={agent} />
        </Section>
        <Section title="Skill execution state">
          <ExecutionStateView agent={agent} maxOpsPerTurn={(turn?.rules ?? rules)?.skills.max_ops_per_turn} />
        </Section>
        <Section title="Received messages and voice">{knowledge ? <ReceivedMessages knowledge={knowledge} /> : knowledgeMissing}</Section>
        <Section title="Recent action results">{knowledge ? <RecentResults knowledge={knowledge} /> : knowledgeMissing}</Section>
        <Section title={`Knowledge records (${recordCount})`}>{knowledge ? <KnowledgeRecordsTable knowledge={knowledge} /> : knowledgeMissing}</Section>
        <Section title="Decision packet (what the agent saw this turn)">
          <TurnLinks {...props} packetOnly />
        </Section>
      </div>
    );
  }

  const s = agent.stats;
  const upgrades = agent.upgrade_counts;
  const statRow = (label: string, value: string, attribute?: string): KeyValueRow => [
    label,
    <>
      {value}
      {attribute && upgrades[attribute] ? <span className="insp-badge">{upgrades[attribute]} upgrade(s)</span> : null}
    </>,
  ];
  const balances: KeyValueRow[] = [
    statRow("compute", fmtNum(s.compute)),
    statRow("essence / capacity", `${fmtNum(s.essence)} / ${fmtNum(s.essence_capacity)}`, "essence_capacity"),
    statRow("health / max", `${fmtNum(s.health)} / ${fmtNum(s.max_health)}`, "max_health"),
  ];
  const attributes: KeyValueRow[] = [
    statRow("attack", fmtNum(s.attack), "attack"),
    statRow("speed", fmtNum(s.speed), "speed"),
    statRow("vision_range", fmtNum(s.vision_range), "vision_range"),
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
  ];

  const summary = agentSettings(agent.id, turn, props.settings);
  const activeRules = turn?.rules ?? rules;
  const mind = summary && activeRules ? (activeRules.cognition.mind_multipliers[summary.modelKey] ?? activeRules.cognition.default_mind_multiplier) : null;

  return (
    <div>
      <Section title="Stats and balances">
        <div className="insp-columns">
          <KeyValueTable rows={balances} />
          <KeyValueTable rows={attributes} />
          <KeyValueTable rows={totals} />
        </div>
      </Section>

      <Section title="Current action and result">
        <LastActionView agent={agent} />
      </Section>

      <Section title="This turn's decision packet and model calls">
        <TurnLinks {...props} />
      </Section>

      <Section title="Model assignment and context settings">
        {summary ? (
          <>
            <KeyValueTable
              rows={[
                kv(
                  "model",
                  <>
                    <code>{summary.modelKey}</code> {summary.modelIsOverride ? <span className="insp-badge insp-badge-warn">agent override</span> : <span className="insp-badge">run default</span>}
                  </>,
                ),
                ["mind multiplier", mind === null ? "?" : fmtNum(mind)],
                ["settings source", summary.source],
              ]}
            />
            <ContextSettingsEditor
              readOnly
              label="Effective context settings (per-agent overrides marked)"
              value={summary.runContext}
              overrides={summary.overrides}
              onOverridesChange={NOOP}
              onChange={NOOP}
            />
          </>
        ) : (
          <p className="insp-muted">Settings not loaded.</p>
        )}
      </Section>

      <Section title={`Saved skills (${Object.keys(agent.skills).length} of ${s.skill_count_limit})`}>
        <SkillList agent={agent} />
      </Section>

      <Section title="Skill execution state">
        <ExecutionStateView agent={agent} maxOpsPerTurn={activeRules?.skills.max_ops_per_turn} />
      </Section>

      <Section title="Believed self vs actual">
        {knowledge ? <BelievedSelfTable believed={knowledge.believed_self} actual={s} /> : knowledgeMissing}
      </Section>

      <Section title="Received messages and voice">{knowledge ? <ReceivedMessages knowledge={knowledge} /> : knowledgeMissing}</Section>

      <Section title="Recent action results (with costs)">{knowledge ? <RecentResults knowledge={knowledge} /> : knowledgeMissing}</Section>

      <Section title="Notebook">{knowledge ? <NotebookView knowledge={knowledge} /> : knowledgeMissing}</Section>

      <Section title={`Knowledge records (${recordCount})`}>{knowledge ? <KnowledgeRecordsTable knowledge={knowledge} /> : knowledgeMissing}</Section>

      {agent.persona ? (
        <Section title="Persona (operator-configured)">
          <pre className="insp-pre">{agent.persona}</pre>
        </Section>
      ) : null}
    </div>
  );
}

function LastActionView(props: { agent: Agent }) {
  const { agent } = props;
  const result = agent.last_result;
  if (!agent.last_action && !result) return <p className="insp-muted">No action attempted yet.</p>;
  const rows: KeyValueRow[] = [];
  if (agent.last_action) rows.push(["last action", <><strong>{agent.last_action.name}</strong> <ExpandableJson value={agent.last_action.args} maxChars={120} /></>]);
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

/** Links to the viewed turn's decision packet and model call records for this agent. */
function TurnLinks(props: AgentInspectorProps & { packetOnly?: boolean }) {
  const { agent, turn } = props;
  if (!turn) return <p className="insp-muted">No turn loaded.</p>;
  const record = turn.turn;
  const acting = record.acting_agent_id === agent.id;
  const packetIds = acting
    ? Array.from(new Set([...(record.packet_id ? [record.packet_id] : []), ...turn.decision_packet_ids]))
    : [];
  const calls = turn.model_calls.filter((c) => c.agent_id === agent.id);
  return (
    <div>
      <div className="insp-hint">
        Turn <code>{record.turn_id}</code> · {record.kind === "agent_turn" ? `acting agent ${record.acting_agent_id ?? "?"}` : record.kind}
        {acting ? ` · decision source: ${record.decision_source}` : ""}
      </div>
      {!acting ? (
        <p className="insp-muted">
          Not {agent.id}'s turn. Use the history arrows to reach one of its turns to open its packet and model calls.
        </p>
      ) : null}
      {acting && record.action ? (
        <KeyValueTable
          rows={[
            kv(
              "action this turn",
              <>
                <strong>{record.action.name}</strong> {fmtValue(record.action.args, 80)}
                {record.action.via_skill ? <span className="insp-badge insp-badge-info">via skill {record.action.skill_name ?? ""}</span> : null}
              </>,
            ),
            kv(
              "result",
              record.action_result ? (
                <span className={record.action_result.ok ? "insp-good" : "insp-bad"}>
                  {record.action_result.ok ? "ok" : record.action_result.reason} · charge {fmtNum(record.action_result.cost_compute)} compute
                  {record.action_result.cost_essence ? `, ${fmtNum(record.action_result.cost_essence)} essence` : ""}
                </span>
              ) : (
                "none"
              ),
            ),
          ]}
        />
      ) : null}
      {packetIds.length > 0 ? (
        <div className="insp-links">
          {packetIds.map((id) => (
            <button key={id} type="button" className="insp-btn insp-btn-link" onClick={() => props.onOpenPacket(id)}>
              Open decision packet {id}
            </button>
          ))}
        </div>
      ) : acting ? (
        <p className="insp-muted">No decision packet in this turn (decision source {record.decision_source}).</p>
      ) : null}
      {!props.packetOnly && calls.length > 0 ? (
        <table className="insp-table">
          <thead>
            <tr>
              <th>model call</th>
              <th>model</th>
              <th>status</th>
              <th>tokens in / out</th>
              <th>charged compute</th>
              <th>latency</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.call_id}>
                <td>
                  <code>{c.call_id}</code>
                </td>
                <td>
                  {c.model_key}
                  <div className="insp-small">
                    {c.provider}/{c.model_id}
                    {c.response_model && c.response_model !== c.model_id ? ` (served ${c.response_model})` : ""}
                  </div>
                </td>
                <td className={c.error ? "insp-bad" : undefined}>
                  {c.status}
                  {c.result_status ? ` / ${c.result_status}` : ""}
                  {c.attempts > 1 ? ` · ${c.attempts} attempts` : ""}
                  {c.error ? <div className="insp-small">{c.error}</div> : null}
                </td>
                <td>
                  {c.input_tokens} / {c.output_tokens}
                </td>
                <td>
                  {fmtNum(c.charged_compute)}
                  {c.uncharged_compute > 0 ? <div className="insp-small insp-bad">uncharged {fmtNum(c.uncharged_compute)}</div> : null}
                </td>
                <td>{fmtNum(c.latency_ms)} ms</td>
                <td>
                  <button type="button" className="insp-btn insp-btn-link" onClick={() => props.onOpenModelCall(c.call_id)}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : !props.packetOnly && acting ? (
        <p className="insp-muted">No model calls for {agent.id} in this turn.</p>
      ) : null}
    </div>
  );
}
