/**
 * God-mode forms for rules and settings: update_context_settings (spec U16),
 * update_plant_rules (spec U3), update_prices, update_model_assignment and
 * update_run_settings (INTERFACES section 10).  Each form edits a local draft
 * of the current values and stages the difference.
 */

import { useState } from "react";
import type { ContextOverrides, ContextSettings, Intervention, PlantSpeciesRule, Prices, UpdateRunSettingsIntervention } from "../../../api/types";
import { FormRow, NumberInput } from "../common";
import { ContextSettingsEditor } from "../ContextSettingsEditor";
import { validateContextSettings } from "../contextLimits";
import { fmtNum } from "../format";
import { applyOverrides } from "../logic";
import { PlantRulesEditor } from "../PlantRulesEditor";
import { capabilitiesOf, effectiveModelKey } from "./context";
import { FormShell, ModelSelect } from "./shared";
import type { GodModeContext } from "./context";

// ---------------------------------------------------------------------------
// update_context_settings
// ---------------------------------------------------------------------------

const ALL_NULL_OVERRIDES: ContextOverrides = {
  input_token_cap: null,
  generation_allowance: null,
  recent_history_length: null,
  notebook_max_tokens: null,
  retrieved_memory_limit: null,
  new_event_digest_limit: null,
  weights: null,
  include_skill_source: null,
};

/** Fields of `next` that differ from `base` (for a readable run-scope merge). */
function changedFields(base: ContextSettings, next: ContextSettings): ContextOverrides {
  const diff: ContextOverrides = {};
  if (next.input_token_cap !== base.input_token_cap) diff.input_token_cap = next.input_token_cap;
  if (next.generation_allowance !== base.generation_allowance) diff.generation_allowance = next.generation_allowance;
  if (next.recent_history_length !== base.recent_history_length) diff.recent_history_length = next.recent_history_length;
  if (next.notebook_max_tokens !== base.notebook_max_tokens) diff.notebook_max_tokens = next.notebook_max_tokens;
  if (next.retrieved_memory_limit !== base.retrieved_memory_limit) diff.retrieved_memory_limit = next.retrieved_memory_limit;
  if (next.new_event_digest_limit !== base.new_event_digest_limit) diff.new_event_digest_limit = next.new_event_digest_limit;
  if (JSON.stringify(next.weights) !== JSON.stringify(base.weights)) diff.weights = next.weights;
  if (next.include_skill_source !== base.include_skill_source) diff.include_skill_source = next.include_skill_source;
  return diff;
}

export function ContextSettingsForm(props: { ctx: GodModeContext }) {
  const { ctx } = props;
  const [scope, setScope] = useState("run");
  const [runDraft, setRunDraft] = useState<ContextSettings>(ctx.settings.context);
  const [agentDrafts, setAgentDrafts] = useState<Record<string, ContextOverrides | null>>({});

  const agentDraft = scope === "run" ? null : scope in agentDrafts ? agentDrafts[scope] : (ctx.settings.context_overrides[scope] ?? null);
  const modelKey = scope === "run" ? ctx.settings.default_model_key : effectiveModelKey(ctx, scope);
  const capabilities = capabilitiesOf(ctx, modelKey);

  const submit = () => {
    if (scope === "run") {
      const problems = validateContextSettings(runDraft, capabilities);
      if (Object.keys(problems).length > 0) {
        return ctx.reject(Object.entries(problems).map(([path, message]) => ({ path: path || "settings", message })));
      }
      const diff = changedFields(ctx.settings.context, runDraft);
      if (Object.keys(diff).length === 0) return ctx.reject([{ path: "settings", message: "nothing changed from the current run defaults" }]);
      return void ctx.stage([{ type: "update_context_settings", scope: "run", settings: diff }]);
    }
    const effectiveSettings = applyOverrides(ctx.settings.context, agentDraft);
    const problems = validateContextSettings(effectiveSettings, capabilities);
    if (Object.keys(problems).length > 0) {
      return ctx.reject(Object.entries(problems).map(([path, message]) => ({ path: path || "settings", message })));
    }
    // Agent scope REPLACES the stored override: send every field (null = use run default).
    void ctx.stage([{ type: "update_context_settings", scope, settings: { ...ALL_NULL_OVERRIDES, ...(agentDraft ?? {}) } }]);
  };

  return (
    <FormShell
      ctx={ctx}
      submitLabel={scope === "run" ? "Stage run-default change" : `Stage override for ${scope}`}
      onSubmit={submit}
      what="Run scope: the changed fields are merged into the run defaults (every agent without an override). Agent scope: the agent's override is replaced by exactly the checked fields (none checked = remove the override). Validated against the model; applied before the next model request."
      extraButtons={
        <button
          type="button"
          className="insp-btn"
          onClick={() => {
            if (scope === "run") setRunDraft(ctx.settings.context);
            else setAgentDrafts((d) => ({ ...d, [scope]: ctx.settings.context_overrides[scope] ?? null }));
          }}
        >
          Reset draft
        </button>
      }
    >
      <FormRow label="Scope" htmlFor="gm-cs-scope">
        <select id="gm-cs-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="run">run defaults (all agents without an override)</option>
          {ctx.agents.map((a) => (
            <option key={a.id} value={a.id}>
              agent {a.id} — {a.name}
              {ctx.settings.context_overrides[a.id] ? " (has override)" : ""}
            </option>
          ))}
        </select>
        <div className="insp-hint">
          Validated against model <code>{modelKey}</code>
          {capabilities ? ` (context window ${fmtNum(capabilities.context_window)}, max output ${fmtNum(capabilities.max_output_tokens)})` : " (capabilities unknown)"}
          {scope === "run" ? "; agents on other models are checked by the backend." : "."}
        </div>
      </FormRow>
      {scope === "run" ? (
        <ContextSettingsEditor label="Run default context settings (draft)" value={runDraft} onChange={setRunDraft} capabilities={capabilities} />
      ) : (
        <ContextSettingsEditor
          label={`Override for agent ${scope} (draft)`}
          value={ctx.settings.context}
          onChange={() => {}}
          overrides={agentDraft}
          onOverridesChange={(o) => setAgentDrafts((d) => ({ ...d, [scope]: o }))}
          capabilities={capabilities}
        />
      )}
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// update_plant_rules
// ---------------------------------------------------------------------------

interface PlantRuleDiff {
  changed: PlantSpeciesRule[];
  added: PlantSpeciesRule[];
  removed: string[];
}

function diffPlantRules(current: Record<string, PlantSpeciesRule>, draft: PlantSpeciesRule[]): PlantRuleDiff {
  const draftNames = new Set(draft.map((s) => s.name));
  const diff: PlantRuleDiff = { changed: [], added: [], removed: Object.keys(current).filter((n) => !draftNames.has(n)) };
  for (const rule of draft) {
    const before = current[rule.name];
    if (!before) diff.added.push(rule);
    else if (JSON.stringify(before) !== JSON.stringify(rule)) diff.changed.push(rule);
  }
  return diff;
}

export function PlantRulesForm(props: { ctx: GodModeContext }) {
  const { ctx } = props;
  const [draft, setDraft] = useState<PlantSpeciesRule[]>(() => structuredClone(Object.values(ctx.rules.plant_species)));
  const diff = diffPlantRules(ctx.rules.plant_species, draft);
  const toStage = [...diff.changed, ...diff.added];

  const submit = () => {
    if (diff.removed.length > 0) {
      return ctx.reject(
        diff.removed.map((name) => ({
          path: `plant_species.${name}`,
          message: "removing or renaming a species cannot be staged (update_plant_rules only replaces or adds a species); undo the removal or edit working/rules.json",
        })),
      );
    }
    if (toStage.length === 0) return ctx.reject([{ path: "plant_species", message: "no species changed" }]);
    const interventions: Intervention[] = toStage.map((rule) => ({ type: "update_plant_rules", species: rule.name, rule }));
    void ctx.stage(interventions);
  };

  return (
    <FormShell
      ctx={ctx}
      submitLabel={`Stage ${toStage.length} species change${toStage.length === 1 ? "" : "s"}`}
      onSubmit={submit}
      what="Species rules govern every plant of that species (this is not an edit of one plant: use Set stat for that). Each changed or added species is staged as one update_plant_rules; plants beyond a shortened stage list are clamped to the last stage."
      extraButtons={
        <button type="button" className="insp-btn" onClick={() => setDraft(structuredClone(Object.values(ctx.rules.plant_species)))}>
          Reset draft
        </button>
      }
    >
      <div className="insp-hint">
        Draft vs current rules: {diff.changed.length} changed ({diff.changed.map((r) => r.name).join(", ") || "none"}), {diff.added.length} added (
        {diff.added.map((r) => r.name).join(", ") || "none"}), {diff.removed.length} removed ({diff.removed.join(", ") || "none"}).
      </div>
      <PlantRulesEditor species={draft} onChange={setDraft} />
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// update_prices
// ---------------------------------------------------------------------------

const PRICE_FIELDS: { field: keyof Prices; hint: string }[] = [
  { field: "move", hint: "one step" },
  { field: "observe", hint: "one point" },
  { field: "query", hint: "one entity" },
  { field: "send", hint: "one message to a visible agent" },
  { field: "broadcast", hint: "message to everyone in range" },
  { field: "absorb", hint: "fruit / residue" },
  { field: "transfer", hint: "fee only; the amount is extra" },
  { field: "wait", hint: "per wait action" },
];

export function PricesForm(props: { ctx: GodModeContext }) {
  const { ctx } = props;
  const [draft, setDraft] = useState<Prices>(ctx.rules.prices);
  const discount = ctx.rules.skills.action_discount;
  const submit = () => {
    const negative = PRICE_FIELDS.filter((p) => draft[p.field] < 0);
    if (negative.length > 0) return ctx.reject(negative.map((p) => ({ path: `prices.${p.field}`, message: "must be 0 or more" })));
    if (JSON.stringify(draft) === JSON.stringify(ctx.rules.prices)) return ctx.reject([{ path: "prices", message: "no price changed" }]);
    void ctx.stage([{ type: "update_prices", prices: draft }]);
  };
  return (
    <FormShell
      ctx={ctx}
      submitLabel="Stage price table"
      onSubmit={submit}
      what={`Replaces the normal direct-action compute prices. Inside a saved skill actions cost ${fmtNum(discount)} × these (skills.action_discount). recover and attack are paid from their own budget argument.`}
      extraButtons={
        <button type="button" className="insp-btn" onClick={() => setDraft(ctx.rules.prices)}>
          Reset draft
        </button>
      }
    >
      <table className="insp-table">
        <thead>
          <tr>
            <th>action</th>
            <th>current</th>
            <th>new price</th>
            <th>in a skill</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {PRICE_FIELDS.map(({ field, hint }) => (
            <tr key={field} className={draft[field] !== ctx.rules.prices[field] ? "insp-row-changed" : undefined}>
              <th scope="row" className="insp-fieldname-cell">{field}</th>
              <td>{fmtNum(ctx.rules.prices[field])}</td>
              <td>
                <NumberInput ariaLabel={`price ${field}`} value={draft[field]} onChange={(n) => setDraft({ ...draft, [field]: n })} />
              </td>
              <td>{fmtNum(draft[field] * discount)}</td>
              <td className="insp-hint">{hint}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// update_model_assignment
// ---------------------------------------------------------------------------

export function ModelAssignmentForm(props: { ctx: GodModeContext }) {
  const { ctx } = props;
  const [scope, setScope] = useState("run");
  const current = scope === "run" ? ctx.settings.default_model_key : (ctx.settings.model_overrides[scope] ?? "");
  const [choice, setChoice] = useState<Record<string, string>>({});
  const selected = choice[scope] ?? current;
  const info = ctx.models.find((m) => m.key === (selected || ctx.settings.default_model_key)) ?? null;

  // Agents whose effective context must fit the new model (backend rejects the whole edit otherwise).
  const affected = scope === "run" ? ctx.agents.filter((a) => ctx.settings.model_overrides[a.id] === undefined) : ctx.agents.filter((a) => a.id === scope);
  const newKey = selected || ctx.settings.default_model_key;
  const misfits = info
    ? affected.filter((a) => {
        const effective = ctx.effective?.effective_context[a.id] ?? applyOverrides(ctx.settings.context, ctx.settings.context_overrides[a.id]);
        return Object.keys(validateContextSettings(effective, info.capabilities)).length > 0;
      })
    : [];
  const mind = ctx.rules.cognition.mind_multipliers[newKey] ?? info?.mind_multiplier ?? ctx.rules.cognition.default_mind_multiplier;

  const submit = () => {
    if (scope === "run" && !selected) return ctx.reject([{ path: "model_key", message: "the run default needs a model" }]);
    if (selected === current) return ctx.reject([{ path: "model_key", message: "this is already the assignment" }]);
    void ctx.stage([{ type: "update_model_assignment", scope, model_key: selected || null }]);
  };

  return (
    <FormShell
      ctx={ctx}
      submitLabel="Stage model assignment"
      onSubmit={submit}
      what="Sets the run's default model or one agent's model. The key must exist and be available; its mind multiplier is snapshotted into the rules; every affected agent's context settings are re-validated (the whole edit is rejected on failure)."
    >
      <FormRow label="Scope" htmlFor="gm-ma-scope">
        <select id="gm-ma-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="run">run default (now {ctx.settings.default_model_key})</option>
          {ctx.agents.map((a) => (
            <option key={a.id} value={a.id}>
              agent {a.id} — {a.name} (now {effectiveModelKey(ctx, a.id)}
              {ctx.settings.model_overrides[a.id] ? ", override" : ""})
            </option>
          ))}
        </select>
      </FormRow>
      <FormRow label="Model" htmlFor="gm-ma-model">
        <ModelSelect
          id="gm-ma-model"
          models={ctx.models}
          value={selected}
          onChange={(key) => setChoice((c) => ({ ...c, [scope]: key }))}
          emptyLabel={scope === "run" ? undefined : `clear override (use run default ${ctx.settings.default_model_key})`}
        />
      </FormRow>
      {info ? (
        <FormRow label="Selected model">
          <div className="insp-small">
            {info.provider}/{info.model_id} · context window {fmtNum(info.capabilities.context_window)} · max output {fmtNum(info.capabilities.max_output_tokens)} · mind
            multiplier {fmtNum(mind)}
            {info.description ? ` · ${info.description}` : ""}
          </div>
        </FormRow>
      ) : null}
      {misfits.length > 0 ? (
        <div className="insp-banner insp-banner-warn">
          The effective context settings of {misfits.map((a) => a.id).join(", ")} do not fit this model; the backend will reject the edit. Change their
          context settings first.
        </div>
      ) : null}
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// update_run_settings
// ---------------------------------------------------------------------------

export function RunSettingsForm(props: { ctx: GodModeContext }) {
  const { ctx } = props;
  const s = ctx.settings;
  const [limitRounds, setLimitRounds] = useState(s.max_rounds !== null);
  const [maxRounds, setMaxRounds] = useState(s.max_rounds ?? 100);
  const [limitBudget, setLimitBudget] = useState(s.real_budget_usd !== null);
  const [budget, setBudget] = useState(s.real_budget_usd ?? 5);
  const [delay, setDelay] = useState(s.play_delay_seconds);

  const submit = () => {
    const iv: UpdateRunSettingsIntervention = { type: "update_run_settings" };
    let changed = false;
    if (!limitRounds && s.max_rounds !== null) {
      iv.clear_max_rounds = true;
      changed = true;
    } else if (limitRounds && maxRounds !== s.max_rounds) {
      if (maxRounds < 1) return ctx.reject([{ path: "max_rounds", message: "must be at least 1" }]);
      iv.max_rounds = maxRounds;
      changed = true;
    }
    if (!limitBudget && s.real_budget_usd !== null) {
      iv.clear_real_budget = true;
      changed = true;
    } else if (limitBudget && budget !== s.real_budget_usd) {
      if (budget < 0) return ctx.reject([{ path: "real_budget_usd", message: "must be 0 or more" }]);
      iv.real_budget_usd = budget;
      changed = true;
    }
    if (delay !== s.play_delay_seconds) {
      if (delay < 0 || delay > 60) return ctx.reject([{ path: "play_delay_seconds", message: "must be between 0 and 60" }]);
      iv.play_delay_seconds = delay;
      changed = true;
    }
    if (!changed) return ctx.reject([{ path: "", message: "nothing changed" }]);
    void ctx.stage([iv]);
  };

  return (
    <FormShell
      ctx={ctx}
      submitLabel="Stage run settings"
      onSubmit={submit}
      what="Run limits: the maximum number of rounds, the real provider budget in USD (the run stops with an error when reached) and the delay between turns while playing."
    >
      <FormRow label="max_rounds" hint={`now ${s.max_rounds ?? "no limit"}`}>
        <label>
          <input type="checkbox" checked={limitRounds} onChange={(e) => setLimitRounds(e.target.checked)} /> limit
        </label>{" "}
        {limitRounds ? <NumberInput integer ariaLabel="max rounds" value={maxRounds} onChange={setMaxRounds} /> : <span className="insp-muted">no limit</span>}
      </FormRow>
      <FormRow label="real_budget_usd" hint={`now ${s.real_budget_usd ?? "no limit"}`}>
        <label>
          <input type="checkbox" checked={limitBudget} onChange={(e) => setLimitBudget(e.target.checked)} /> limit
        </label>{" "}
        {limitBudget ? <NumberInput ariaLabel="real budget usd" value={budget} onChange={setBudget} /> : <span className="insp-muted">no limit</span>}
      </FormRow>
      <FormRow label="play_delay_seconds" hint={`now ${s.play_delay_seconds}`}>
        <NumberInput ariaLabel="play delay seconds" value={delay} onChange={setDelay} />
      </FormRow>
    </FormShell>
  );
}
