/**
 * God mode tab (spec U7, U8, U9, U16; "God mode and direct file editing";
 * INTERFACES section 10).  Two quick forms for the most common operator
 * actions — a voice from nowhere and the run-default context settings —
 * followed by the complete GodModePanel (every intervention type, staged
 * list, working/ reload and continuation from the viewed turn).
 *
 * Every edit targets the LIVE run and is applied at its next turn boundary,
 * even while an older turn is being viewed.
 */

import { useState } from "react";
import type { Agent, ApiProblem, ContextSettings, EffectiveSettingsView, FieldChange, Intervention, ModelInfo, Point, TurnView, VoiceRecipients } from "../../api/types";
import { ContextSettingsEditor, GodModePanel, flattenEntities, problemsFromError, validateContextSettings } from "../inspect";
import { NumberField } from "../common/NumberField";
import { ProblemSummary } from "../common/Problems";
import { changedContextFields } from "../../state/contextDiff";

export interface GodModeTabProps {
  live: TurnView;
  effective: EffectiveSettingsView | null;
  models: ModelInfo[];
  staged: Intervention[];
  viewTurnId: string | null;
  selectedPoint: Point | null;
  selectedAgentId: string | null;
  /** "worlds/<world_id>/runs/<run_id>/working/" (shown next to the reload button). */
  workingDir: string;
  onStage(intervention: Intervention): Promise<void>;
  onDiscard(seq: number, id: string): Promise<void>;
  onReloadWorking(): Promise<FieldChange[] | void>;
  onCreateContinuation(): Promise<void>;
}

export function GodModeTab(props: GodModeTabProps) {
  const { live } = props;
  const agents = Object.values(live.entities.agents);
  const continuationTurn = props.viewTurnId ?? live.turn.turn_id;
  return (
    <div className="god-tab">
      {props.viewTurnId ? (
        <div className="banner banner-warn">
          You are viewing history (turn <code>{props.viewTurnId}</code>). God-mode edits change the <strong>live</strong> run at its next turn boundary, not the
          viewed turn. To change the past, use "Create continuation from turn {props.viewTurnId}" at the bottom: it starts a new run from that checkpoint.
        </div>
      ) : null}
      <div className="quick-row">
        <QuickVoice agents={agents} selectedAgentId={props.selectedAgentId} selectedPoint={props.selectedPoint} onStage={props.onStage} />
        <QuickRunContext current={live.settings.context} modelKey={live.settings.default_model_key} models={props.models} onStage={props.onStage} />
      </div>
      <h3 className="section-heading">All god-mode edits</h3>
      <GodModePanel
        agents={agents}
        entities={flattenEntities(live.entities)}
        rules={live.rules}
        settings={live.settings}
        effective={props.effective}
        models={props.models}
        staged={props.staged}
        disabled={false}
        defaultPoint={props.selectedPoint}
        viewedTurnId={continuationTurn}
        workingDir={props.workingDir}
        onStage={props.onStage}
        onDiscard={props.onDiscard}
        onReloadWorking={props.onReloadWorking}
        onCreateContinuation={props.onCreateContinuation}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voice from nowhere (spec U7)
// ---------------------------------------------------------------------------

type VoiceMode = VoiceRecipients["mode"];

function QuickVoice(props: { agents: Agent[]; selectedAgentId: string | null; selectedPoint: Point | null; onStage(i: Intervention): Promise<void> }) {
  const living = props.agents.filter((a) => a.alive);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<VoiceMode>("broadcast_all");
  const [chosen, setChosen] = useState<string[]>(props.selectedAgentId ? [props.selectedAgentId] : []);
  const [point, setPoint] = useState<Point>(props.selectedPoint ?? { x: 0, y: 0 });
  const [problems, setProblems] = useState<ApiProblem[]>([]);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const recipients = (): VoiceRecipients =>
    mode === "agents" ? { mode: "agents", agent_ids: chosen } : mode === "at_point" ? { mode: "at_point", point } : { mode: "broadcast_all" };

  const send = async () => {
    setOk(null);
    if (!text.trim()) return setProblems([{ path: "text", message: "type what the agents should hear" }]);
    if (mode === "agents" && chosen.length === 0) return setProblems([{ path: "recipients.agent_ids", message: "choose at least one agent" }]);
    setBusy(true);
    setProblems([]);
    try {
      await props.onStage({ type: "voice", recipients: recipients(), text, origin: "ui" });
      setOk(
        `Staged: the voice reaches ${mode === "broadcast_all" ? "all living agents" : mode === "agents" ? chosen.join(", ") : `living agents at (${point.x}, ${point.y})`} at the next turn boundary.`,
      );
      setText("");
    } catch (error) {
      setProblems(problemsFromError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="quick-box">
      <div className="panel-title">Voice from nowhere</div>
      <p className="hint">
        The recipients get an <code>operator_voice</code> knowledge record from an unknown source. It is world information, not an instruction. Staged;
        delivered at the next turn boundary.
      </p>
      <label className="block-label" htmlFor="qv-text">
        Voice text — what the agents hear
      </label>
      <textarea id="qv-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. A storm is coming from the west." />
      <fieldset className="radio-set">
        <legend>Recipients</legend>
        <label>
          <input type="radio" name="qv-mode" checked={mode === "broadcast_all"} onChange={() => setMode("broadcast_all")} /> All living agents (broadcast)
        </label>
        <label>
          <input type="radio" name="qv-mode" checked={mode === "agents"} onChange={() => setMode("agents")} /> Chosen agents
        </label>
        <label>
          <input type="radio" name="qv-mode" checked={mode === "at_point"} onChange={() => setMode("at_point")} /> Living agents at a point
        </label>
      </fieldset>
      {mode === "agents" ? (
        <div className="check-grid">
          {living.map((a) => (
            <label key={a.id}>
              <input
                type="checkbox"
                checked={chosen.includes(a.id)}
                onChange={(e) => setChosen((c) => (e.target.checked ? [...c, a.id] : c.filter((id) => id !== a.id)))}
              />{" "}
              {a.id} {a.name}
            </label>
          ))}
        </div>
      ) : null}
      {mode === "at_point" ? (
        <div className="inline-fields">
          <label>
            x <NumberField integer value={point.x} onChange={(x) => setPoint((p) => ({ ...p, x: x ?? 0 }))} className="num-short" />
          </label>
          <label>
            y <NumberField integer value={point.y} onChange={(y) => setPoint((p) => ({ ...p, y: y ?? 0 }))} className="num-short" />
          </label>
        </div>
      ) : null}
      <div className="action-row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void send()}>
          {busy ? "Sending…" : "Send voice"}
        </button>
      </div>
      <ProblemSummary problems={problems} title="Not sent — fix these:" />
      {ok ? <div className="ok-line">{ok}</div> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Run-default context settings (spec U16)
// ---------------------------------------------------------------------------

function QuickRunContext(props: { current: ContextSettings; modelKey: string; models: ModelInfo[]; onStage(i: Intervention): Promise<void> }) {
  const [draft, setDraft] = useState<ContextSettings>(props.current);
  const [base, setBase] = useState<ContextSettings>(props.current);
  const [problems, setProblems] = useState<ApiProblem[]>([]);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const capabilities = props.models.find((m) => m.key === props.modelKey)?.capabilities ?? null;

  // After a commit that changed the run defaults, an untouched draft follows them.
  if (JSON.stringify(props.current) !== JSON.stringify(base)) {
    const untouched = JSON.stringify(draft) === JSON.stringify(base);
    setBase(props.current);
    if (untouched) setDraft(props.current);
  }

  const diff = changedContextFields(props.current, draft);
  const changed = Object.keys(diff).length > 0;

  const stage = async () => {
    setOk(null);
    const local = validateContextSettings(draft, capabilities);
    if (Object.keys(local).length > 0) {
      setProblems(Object.entries(local).map(([path, message]) => ({ path: path ? `settings.${path}` : "settings", message })));
      return;
    }
    setBusy(true);
    setProblems([]);
    try {
      await props.onStage({ type: "update_context_settings", scope: "run", settings: diff, origin: "ui" });
      setOk(`Staged: run defaults ${Object.keys(diff).join(", ")} change at the next turn boundary (agents with an override keep it).`);
    } catch (error) {
      setProblems(problemsFromError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="quick-box">
      <div className="panel-title">Run-default context settings</div>
      <p className="hint">
        Changes the defaults used by every agent without an override (checked against the run's default model <code>{props.modelKey}</code>). Per-agent
        overrides: "Context settings" in the full list below.
      </p>
      <div className="action-row">
        <button type="button" className="btn btn-primary" disabled={busy || !changed} onClick={() => void stage()}>
          {busy ? "Staging…" : "Stage run-default context change"}
        </button>
        <button type="button" className="btn" disabled={!changed} onClick={() => setDraft(props.current)}>
          Reset draft
        </button>
        {!changed ? <span className="hint">Edit a value to enable staging.</span> : <span className="hint">Changed: {Object.keys(diff).join(", ")}</span>}
      </div>
      <ProblemSummary problems={problems} title="Not staged — fix these:" />
      {ok ? <div className="ok-line">{ok}</div> : null}
      <ContextSettingsEditor value={draft} onChange={setDraft} capabilities={capabilities} label="Run defaults (draft)" />
    </section>
  );
}
