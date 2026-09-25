/**
 * GodModePanel: UI god mode (spec U7, U8, U9, U16; "God mode and direct file
 * editing"; INTERFACES section 10).  One form per UI intervention type, the
 * staged-edits list (applied at the next turn boundary, discardable),
 * "Reload working/ files" (literal god mode) and "Create continuation from
 * viewed turn" (editing history).  See GodModePanelProps.
 */

import "../../inspect.css";
import { useMemo, useState } from "react";
import type { ApiProblem, FieldChange, Intervention } from "../../api/types";
import { describeChange } from "../../state/changes";
import { ProblemList } from "./common";
import { describeIntervention, interventionSeq, problemsFromError, stagedIntervention } from "./logic";
import type { StagedItem } from "./logic";
import type { GodModePanelProps } from "./props";
import { PlaceEntityForm, RemoveEntityForm, SetStatForm } from "./godmode/EntityForms";
import { EditKnowledgeForm, VoiceForm } from "./godmode/MindForms";
import { ContextSettingsForm, ModelAssignmentForm, PlantRulesForm, PricesForm, RunSettingsForm } from "./godmode/SettingsForms";
import type { GodModeContext } from "./godmode/context";

type FormType =
  | "set_stat"
  | "place_entity"
  | "remove_entity"
  | "edit_knowledge"
  | "voice"
  | "update_context_settings"
  | "update_plant_rules"
  | "update_prices"
  | "update_model_assignment"
  | "update_run_settings";

const FORMS: { type: FormType; label: string }[] = [
  { type: "set_stat", label: "Set stat" },
  { type: "place_entity", label: "Place entity" },
  { type: "remove_entity", label: "Remove entity" },
  { type: "edit_knowledge", label: "Edit knowledge" },
  { type: "voice", label: "Voice" },
  { type: "update_context_settings", label: "Context settings" },
  { type: "update_plant_rules", label: "Plant rules" },
  { type: "update_prices", label: "Prices" },
  { type: "update_model_assignment", label: "Model assignment" },
  { type: "update_run_settings", label: "Run settings" },
];

interface Feedback {
  problems: ApiProblem[];
  ok: string | null;
}

const NO_FEEDBACK: Feedback = { problems: [], ok: null };

export function GodModePanel(props: GodModePanelProps) {
  const [formType, setFormType] = useState<FormType>("set_stat");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(NO_FEEDBACK);
  const [note, setNote] = useState("");

  const stage = async (interventions: Intervention[]): Promise<boolean> => {
    setBusy(true);
    setFeedback(NO_FEEDBACK);
    const done: string[] = [];
    try {
      for (const iv of interventions) {
        const withNote: Intervention = note.trim() ? { ...iv, origin: "ui", note: note.trim() } : { ...iv, origin: "ui" };
        try {
          await props.onStage(withNote);
          done.push(describeIntervention(iv));
        } catch (error) {
          const prefix = interventions.length > 1 ? `${describeIntervention(iv)} — ` : "";
          setFeedback({
            problems: problemsFromError(error).map((p) => ({ path: p.path, message: `${prefix}${p.message}` })),
            ok: done.length ? `Staged before the failure: ${done.join("; ")}` : null,
          });
          return false;
        }
      }
      setFeedback({ problems: [], ok: `Staged: ${done.join("; ")}` });
      return true;
    } finally {
      setBusy(false);
    }
  };

  const ctx: GodModeContext = {
    agents: props.agents,
    entities: props.entities,
    rules: props.rules,
    settings: props.settings,
    effective: props.effective,
    models: props.models,
    disabled: props.disabled,
    busy,
    defaultPoint: props.defaultPoint ?? null,
    stage,
    reject: (problems) => setFeedback({ problems, ok: null }),
  };

  const chooseForm = (type: FormType) => {
    setFormType(type);
    setFeedback(NO_FEEDBACK);
  };

  return (
    <div className="insp insp-godmode">
      <div className="insp-panel-title">God mode</div>
      <p className="insp-hint">
        Edits are staged, then applied at the next turn boundary (before the next turn starts) and recorded with before/after values. Nobody is charged.
      </p>
      {props.disabled ? (
        <div className="insp-banner insp-banner-warn">Staging is disabled{props.disabledReason ? `: ${props.disabledReason}` : "."}</div>
      ) : null}

      <StagedList staged={props.staged} disabled={props.disabled} onDiscard={props.onDiscard} />

      <div className="insp-tabs" role="tablist" aria-label="Intervention type">
        {FORMS.map((f) => (
          <button
            key={f.type}
            type="button"
            role="tab"
            aria-selected={formType === f.type}
            className={`insp-tab${formType === f.type ? " insp-tab-active" : ""}`}
            onClick={() => chooseForm(f.type)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="insp-tabpanel" role="tabpanel">
        <div className="insp-form-title">
          {FORMS.find((f) => f.type === formType)?.label} <code>{formType}</code>
        </div>
        <div className="insp-formrow">
          <label htmlFor="gm-note">Note (optional)</label>
          <div className="insp-formrow-control">
            <input id="gm-note" type="text" className="insp-wide" value={note} disabled={props.disabled} onChange={(e) => setNote(e.target.value)} placeholder="why; stored with the edit" />
          </div>
        </div>
        {formType === "set_stat" ? <SetStatForm ctx={ctx} /> : null}
        {formType === "place_entity" ? <PlaceEntityForm ctx={ctx} /> : null}
        {formType === "remove_entity" ? <RemoveEntityForm ctx={ctx} /> : null}
        {formType === "edit_knowledge" ? <EditKnowledgeForm ctx={ctx} /> : null}
        {formType === "voice" ? <VoiceForm ctx={ctx} /> : null}
        {formType === "update_context_settings" ? <ContextSettingsForm ctx={ctx} /> : null}
        {formType === "update_plant_rules" ? <PlantRulesForm ctx={ctx} /> : null}
        {formType === "update_prices" ? <PricesForm ctx={ctx} /> : null}
        {formType === "update_model_assignment" ? <ModelAssignmentForm ctx={ctx} /> : null}
        {formType === "update_run_settings" ? <RunSettingsForm ctx={ctx} /> : null}
        <ProblemList problems={feedback.problems} title="Not staged — fix these:" />
        {feedback.ok ? <div className="insp-ok">{feedback.ok}</div> : null}
      </div>

      <FileAndHistoryActions {...props} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staged edits
// ---------------------------------------------------------------------------

function StagedList(props: { staged: GodModePanelProps["staged"]; disabled: boolean; onDiscard: GodModePanelProps["onDiscard"] }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ApiProblem[]>([]);
  const items = useMemo(() => props.staged.map((item: StagedItem) => ({ item, iv: stagedIntervention(item) })), [props.staged]);

  const discard = async (id: string, seq: number) => {
    setPending(id);
    setError([]);
    try {
      await props.onDiscard(seq, id);
    } catch (e) {
      setError(problemsFromError(e));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="insp-staged">
      <div className="insp-subtitle">
        Staged edits ({items.length}) — applied at the next turn boundary, in this order
      </div>
      {items.length === 0 ? <p className="insp-muted">Nothing staged.</p> : null}
      <ol>
        {items.map(({ item, iv }, i) => {
          const id = iv.id ?? null;
          const seq = interventionSeq(id);
          const record = "intervention" in item ? item : null;
          return (
            <li key={id ?? i} className="insp-staged-item">
              <div className="insp-staged-line">
                <code>{id ?? "(no id)"}</code> <span className="insp-badge">{iv.type}</span>
                <span className="insp-badge">{iv.origin === "file" ? "file edit" : "UI"}</span> {describeIntervention(iv)}
              </div>
              {iv.note ? <div className="insp-hint">note: {iv.note}</div> : null}
              {iv.type === "apply_working_files" && iv.changes.length > 0 ? <ChangeList changes={iv.changes} /> : null}
              {record ? (
                <div className={record.ok ? "insp-small" : "insp-small insp-bad"}>
                  {record.ok ? "applied" : `failed: ${record.error ?? "?"}`} at {record.effective_turn_id} · {record.changes.length} change(s)
                </div>
              ) : null}
              <button
                type="button"
                className="insp-btn insp-btn-small insp-btn-danger"
                disabled={props.disabled || id === null || seq === null || pending !== null}
                onClick={() => id !== null && seq !== null && void discard(id, seq)}
              >
                {pending === id ? "Discarding…" : "Discard"}
              </button>
            </li>
          );
        })}
      </ol>
      <ProblemList problems={error} title="Discard failed:" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Literal god mode and continuation
// ---------------------------------------------------------------------------

/** "path: before → after" per changed field, the first few inline and the rest on demand. */
function ChangeList(props: { changes: FieldChange[]; shown?: number }) {
  const [all, setAll] = useState(false);
  const limit = props.shown ?? 8;
  const list = all ? props.changes : props.changes.slice(0, limit);
  return (
    <ul className="insp-change-list">
      {list.map((c, i) => (
        <li key={`${c.path}-${i}`}>
          <code>{describeChange(c, 60)}</code>
        </li>
      ))}
      {props.changes.length > list.length ? (
        <li>
          <button type="button" className="insp-btn insp-btn-small" onClick={() => setAll(true)}>
            Show all {props.changes.length} changes
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function FileAndHistoryActions(props: GodModePanelProps) {
  const [busy, setBusy] = useState<"reload" | "continue" | null>(null);
  const [problems, setProblems] = useState<ApiProblem[]>([]);
  const [ok, setOk] = useState<string | null>(null);
  const [changes, setChanges] = useState<FieldChange[]>([]);

  const run = async (which: "reload" | "continue", action: () => Promise<FieldChange[] | void>, success: string) => {
    setBusy(which);
    setProblems([]);
    setOk(null);
    setChanges([]);
    try {
      const result = await action();
      setOk(success);
      if (Array.isArray(result)) setChanges(result);
    } catch (e) {
      setProblems(problemsFromError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="insp-file-actions">
      <div className="insp-subtitle">Files and history</div>
      <div className="insp-action-row">
        <button
          type="button"
          className="insp-btn"
          disabled={props.disabled || busy !== null}
          onClick={() => void run("reload", props.onReloadWorking, "working/ files validated and staged as one file edit.")}
        >
          {busy === "reload" ? "Reloading…" : "Reload working/ files"}
        </button>
        <span className="insp-hint">
          While paused, edit the JSON files in the run's <code>working/</code> folder, then reload: they are validated and staged as one file edit. Invalid files are
          reported and nothing changes. Staged edits apply in staging order, and the file edit is applied as a field-by-field diff onto the state at that moment, so
          UI edits staged before or after it (voice, placements, stat changes, settings) all survive. A field changed both here and in a file keeps the value of the
          edit staged later. If a file change can no longer be applied (its entity was removed by an earlier edit) or the result would be invalid, the whole file edit
          is recorded as failed with the reason and nothing of it applies; the other edits still do.
        </span>
      </div>
      {props.workingDir ? <WorkingDirLine path={props.workingDir} /> : null}
      <div className="insp-action-row">
        <button type="button" className="insp-btn" disabled={busy !== null} onClick={() => void run("continue", props.onCreateContinuation, "Continuation created.")}>
          {busy === "continue" ? "Creating…" : `Create continuation from ${props.viewedTurnId ? `turn ${props.viewedTurnId}` : "viewed turn"}`}
        </button>
        <span className="insp-hint">Starts a new run from the viewed checkpoint (opened paused). This run and its later turns stay untouched.</span>
      </div>
      <ProblemList problems={problems} title="Failed:" />
      {ok ? <div className="insp-ok">{ok}</div> : null}
      {changes.length > 0 ? (
        <div className="insp-small">
          {changes.length} field{changes.length === 1 ? "" : "s"} will change when the file edit is applied:
          <ChangeList changes={changes} />
        </div>
      ) : null}
    </div>
  );
}

/** The working/ folder path with a copy button (literal god mode: the operator edits files there). */
function WorkingDirLine(props: { path: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.path);
      setCopied("Copied.");
    } catch {
      setCopied("Copy is blocked by the browser; select the path and copy it by hand.");
    }
  };
  return (
    <div className="insp-working-dir">
      <span>
        Folder: <code className="insp-path">{props.path}</code>
      </span>
      <button type="button" className="insp-btn insp-btn-small" onClick={() => void copy()}>
        Copy path
      </button>
      {copied ? <span className="insp-hint">{copied}</span> : null}
      <div className="insp-hint">
        {props.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(props.path)
          ? "An absolute path on the machine that runs the backend (open it in your editor)."
          : "Relative to the worlds root (the repository's worlds/ folder, or EMPYREAN_WORLDS_DIR when the backend was started with it)."}{" "}
        Reload error messages name files from the run folder (for example <code>working/entities/agents/a04.json</code>).
      </div>
    </div>
  );
}
