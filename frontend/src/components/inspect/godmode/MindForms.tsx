/**
 * God-mode forms that change what agents know: edit_knowledge and voice
 * (spec U7 "agents to basically hear a voice coming from nowhere"; spec "God
 * mode and direct file editing": knowledge edits are distinct from changing
 * reality; operator messages are world events from an unseen source, not
 * elevated instructions).
 */

import { useState } from "react";
import type { KnowledgeKind, KnowledgeRecordInput, Point, VoiceRecipients } from "../../../api/types";
import { FormRow, NumberInput } from "../common";
import { AgentSelect, FormShell, PointFields } from "./shared";
import type { GodModeContext } from "./context";

const KNOWLEDGE_KINDS: KnowledgeKind[] = ["system", "observation", "query", "action_result", "message", "operator_voice", "damage"];

type KnowledgeOperation = "add_record" | "remove_record" | "replace_notebook";

export function EditKnowledgeForm(props: { ctx: GodModeContext }) {
  const { ctx } = props;
  const [agentId, setAgentId] = useState(ctx.agents[0]?.id ?? "");
  const [operation, setOperation] = useState<KnowledgeOperation>("add_record");
  const [kind, setKind] = useState<KnowledgeKind>("system");
  const [text, setText] = useState("");
  const [importance, setImportance] = useState(0.5);
  const [recordId, setRecordId] = useState("");
  const [notebook, setNotebook] = useState("");

  const submit = () => {
    if (!agentId) return ctx.reject([{ path: "agent_id", message: "choose an agent" }]);
    if (operation === "add_record") {
      if (!text.trim()) return ctx.reject([{ path: "record.text", message: "the record needs text" }]);
      if (importance < 0 || importance > 1) return ctx.reject([{ path: "record.importance", message: "importance is between 0 and 1" }]);
      // id / seq / round are placeholders required by schemas.KnowledgeRecord; the backend
      // (context.apply_knowledge_intervention) assigns the real values and forces provenance "operator".
      const record: KnowledgeRecordInput = {
        id: "",
        agent_id: agentId,
        round: 0,
        seq: 0,
        kind,
        provenance: { source: "operator", action: null, sender_visible: null, turn_id: null },
        text: text.trim(),
        content: { text: text.trim() },
        tags: [],
        importance,
        read: false,
      };
      return void ctx.stage([{ type: "edit_knowledge", agent_id: agentId, operation, record }]);
    }
    if (operation === "remove_record") {
      if (!recordId.trim()) return ctx.reject([{ path: "record_id", message: "enter the record id, e.g. a01-k000012" }]);
      return void ctx.stage([{ type: "edit_knowledge", agent_id: agentId, operation, record_id: recordId.trim() }]);
    }
    return void ctx.stage([{ type: "edit_knowledge", agent_id: agentId, operation, notebook }]);
  };

  return (
    <FormShell
      ctx={ctx}
      submitLabel="Stage knowledge edit"
      onSubmit={submit}
      what="Changes what one agent believes (its records or its notebook), not reality. Added records carry provenance 'operator'."
    >
      <FormRow label="Agent" htmlFor="gm-ek-agent">
        <AgentSelect id="gm-ek-agent" agents={ctx.agents} value={agentId} onChange={setAgentId} />
      </FormRow>
      <FormRow label="Operation">
        <div className="insp-radios">
          {(["add_record", "remove_record", "replace_notebook"] as KnowledgeOperation[]).map((op) => (
            <label key={op}>
              <input type="radio" name="gm-ek-op" checked={operation === op} onChange={() => setOperation(op)} /> {op}
            </label>
          ))}
        </div>
      </FormRow>
      {operation === "add_record" ? (
        <>
          <FormRow label="Record kind" htmlFor="gm-ek-kind">
            <select id="gm-ek-kind" value={kind} onChange={(e) => setKind(e.target.value as KnowledgeKind)}>
              {KNOWLEDGE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </FormRow>
          <FormRow label="Text" htmlFor="gm-ek-text">
            <textarea id="gm-ek-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          </FormRow>
          <FormRow label="Importance (0..1)" htmlFor="gm-ek-imp">
            <NumberInput id="gm-ek-imp" value={importance} onChange={setImportance} />
          </FormRow>
        </>
      ) : null}
      {operation === "remove_record" ? (
        <FormRow label="Record id" htmlFor="gm-ek-rid" hint="shown in the agent inspector's knowledge table">
          <input id="gm-ek-rid" type="text" value={recordId} onChange={(e) => setRecordId(e.target.value)} placeholder="a01-k000012" />
        </FormRow>
      ) : null}
      {operation === "replace_notebook" ? (
        <FormRow label="New notebook" htmlFor="gm-ek-nb" hint="replaces the whole notebook; the packet still shows at most notebook size tokens">
          <textarea id="gm-ek-nb" rows={5} value={notebook} onChange={(e) => setNotebook(e.target.value)} />
        </FormRow>
      ) : null}
    </FormShell>
  );
}

type VoiceMode = VoiceRecipients["mode"];

export function VoiceForm(props: { ctx: GodModeContext }) {
  const { ctx } = props;
  const living = ctx.agents.filter((a) => a.alive);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<VoiceMode>("agents");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [point, setPoint] = useState<Point>(ctx.defaultPoint ?? { x: 0, y: 0 });

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = () => {
    if (!text.trim()) return ctx.reject([{ path: "text", message: "the voice needs text" }]);
    let recipients: VoiceRecipients;
    if (mode === "agents") {
      if (selected.size === 0) return ctx.reject([{ path: "recipients.agent_ids", message: "select at least one agent" }]);
      recipients = { mode: "agents", agent_ids: [...selected].sort() };
    } else if (mode === "broadcast_all") {
      recipients = { mode: "broadcast_all" };
    } else {
      recipients = { mode: "at_point", point };
    }
    void ctx.stage([{ type: "voice", recipients, text }]);
  };

  return (
    <FormShell
      ctx={ctx}
      submitLabel="Stage voice"
      onSubmit={submit}
      what="The recipients hear a voice from nowhere: an operator_voice record with source unknown. It is world data for the agent, not an instruction with authority."
    >
      <FormRow label="Text" htmlFor="gm-v-text">
        <textarea id="gm-v-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="What the agents hear" />
      </FormRow>
      <FormRow label="Recipients">
        <div className="insp-radios">
          <label>
            <input type="radio" name="gm-v-mode" checked={mode === "agents"} onChange={() => setMode("agents")} /> selected agents
          </label>
          <label>
            <input type="radio" name="gm-v-mode" checked={mode === "broadcast_all"} onChange={() => setMode("broadcast_all")} /> all living agents ({living.length})
          </label>
          <label>
            <input type="radio" name="gm-v-mode" checked={mode === "at_point"} onChange={() => setMode("at_point")} /> living agents at a point
          </label>
        </div>
        {mode === "agents" ? (
          <div className="insp-checklist">
            {ctx.agents.map((a) => (
              <label key={a.id} className={a.alive ? undefined : "insp-dead"}>
                <input type="checkbox" disabled={!a.alive} checked={selected.has(a.id)} onChange={() => toggle(a.id)} /> {a.id} {a.name}
                {a.alive ? "" : " (dead)"}
              </label>
            ))}
            <span>
              <button type="button" className="insp-btn insp-btn-small" onClick={() => setSelected(new Set(living.map((a) => a.id)))}>
                all living
              </button>
              <button type="button" className="insp-btn insp-btn-small" onClick={() => setSelected(new Set())}>
                clear
              </button>
            </span>
          </div>
        ) : null}
        {mode === "at_point" ? (
          <div>
            <PointFields idPrefix="gm-v-point" value={point} onChange={setPoint} />
            <span className="insp-hint">
              {" "}
              {living.filter((a) => a.position.x === point.x && a.position.y === point.y).length} living agent(s) there now
            </span>
          </div>
        ) : null}
      </FormRow>
    </FormShell>
  );
}
