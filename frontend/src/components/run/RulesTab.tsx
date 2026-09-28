/**
 * Read-only "Rules & settings" tab: every rule number of the run, the
 * effective context settings and model of each agent (run defaults and
 * per-agent overrides marked), and the configurable assumptions recorded
 * with the run (spec "Budget delivery and inspection": show the effective
 * settings; docs/ASSUMPTIONS.md).  Changes are made in God mode.
 */

import type { ReactNode } from "react";
import type { AssumptionEntry, ContextLimits, ContextOverrides, ContextSettings, RulesConfig, RunSettings } from "../../api/types";
import { PlantRulesEditor, applyOverrides } from "../inspect";

export interface RulesTabProps {
  rules: RulesConfig;
  settings: RunSettings;
  /** Effective context per agent (live GET /settings); computed from `settings` when null. */
  effectiveContext: Record<string, ContextSettings> | null;
  effectiveModel: Record<string, string> | null;
  limits: ContextLimits | null;
  agentIds: string[];
  name(agentId: string): string;
  assumptions: AssumptionEntry[] | null;
  assumptionsError: string | null;
  /** "live settings" or "as of turn r00003_end". */
  source: string;
}

function show(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function FlatTable(props: { title: string; values: object; note?: ReactNode }) {
  return (
    <div className="rules-block">
      <h4>{props.title}</h4>
      {props.note ? <p className="hint">{props.note}</p> : null}
      <table className="data-table compact">
        <tbody>
          {Object.entries(props.values).map(([key, value]) => (
            <tr key={key}>
              <th scope="row">
                <code>{key}</code>
              </th>
              <td>{show(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Context columns shown per agent: the settings a card can override (the tip text is run-level only). */
const CONTEXT_COLUMNS: [keyof ContextSettings & keyof ContextOverrides, string][] = [
  ["input_token_cap", "input cap"],
  ["generation_allowance", "generation"],
  ["recent_history_length", "recent history"],
  ["notebook_max_tokens", "notebook"],
  ["retrieved_memory_limit", "retrieved"],
  ["new_event_digest_limit", "digest"],
  ["weights", "weights (rel/rec/imp)"],
  ["include_skill_source", "skill source"],
  ["persona_tip", "persona tip"],
];

function contextCell(settings: ContextSettings, key: keyof ContextSettings): string {
  const value = settings[key];
  if (key === "weights") return `${settings.weights.relevance} / ${settings.weights.recency} / ${settings.weights.importance}`;
  return show(value);
}

export function RulesTab(props: RulesTabProps) {
  const { rules, settings } = props;
  const discount = rules.skills.action_discount;
  const { mind_multipliers, ...cognition } = rules.cognition;
  const { increments, hard_caps, ...upgradeBase } = rules.upgrades;
  const attributes = Array.from(new Set([...Object.keys(increments), ...Object.keys(hard_caps)]));

  return (
    <div className="rules-tab">
      <p className="hint">
        Read-only view ({props.source}). Change rules and settings in God mode; changes apply at the next turn boundary and are recorded with before/after
        values.
      </p>

      <h3 className="section-heading">Effective context settings and models per agent</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>agent</th>
            <th>model</th>
            {CONTEXT_COLUMNS.map(([, label]) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="row-default">
            <th scope="row">run defaults</th>
            <td>
              <code>{settings.default_model_key}</code>
            </td>
            {CONTEXT_COLUMNS.map(([key]) => (
              <td key={key}>{contextCell(settings.context, key)}</td>
            ))}
          </tr>
          {props.agentIds.map((id) => {
            const overrides = settings.context_overrides[id] ?? null;
            const effective = props.effectiveContext?.[id] ?? applyOverrides(settings.context, overrides);
            const model = props.effectiveModel?.[id] ?? settings.model_overrides[id] ?? settings.default_model_key;
            return (
              <tr key={id}>
                <th scope="row">{props.name(id)}</th>
                <td className={settings.model_overrides[id] ? "cell-override" : undefined}>
                  <code>{model}</code>
                  {settings.model_overrides[id] ? " (override)" : ""}
                </td>
                {CONTEXT_COLUMNS.map(([key]) => {
                  const overridden = overrides !== null && overrides[key] !== null && overrides[key] !== undefined;
                  return (
                    <td key={key} className={overridden ? "cell-override" : undefined}>
                      {contextCell(effective, key)}
                      {overridden ? " *" : ""}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint">
        * = per-agent override (highlighted). Limits: minimum packet input {props.limits?.min_packet_input_tokens ?? "?"} tokens, minimum generation{" "}
        {props.limits?.min_generation_tokens ?? "?"} tokens.
      </p>

      <div className="rules-grid">
        <FlatTable
          title="Run settings"
          values={{
            max_rounds: settings.max_rounds ?? "no limit",
            play_delay_seconds: settings.play_delay_seconds,
            real_budget_usd: settings.real_budget_usd ?? "no limit",
          }}
        />
        <div className="rules-block">
          <h4>Action prices (compute)</h4>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>action</th>
                <th>direct</th>
                <th>in a skill (× {show(discount)})</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(rules.prices).map(([action, price]) => (
                <tr key={action}>
                  <th scope="row">
                    <code>{action}</code>
                  </th>
                  <td>{show(price)}</td>
                  <td>{show(price * discount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <FlatTable title="Cognition" values={cognition} note="Charged per decision from reported (or estimated) token usage." />
        <FlatTable title="Mind multipliers (per model key)" values={Object.keys(mind_multipliers).length ? mind_multipliers : { "(none recorded)": "" }} />
        <FlatTable title="Upkeep" values={rules.upkeep} />
        <FlatTable title="Recovery" values={rules.recovery} />
        <FlatTable title="Accounting" values={rules.accounting} />
        <FlatTable title="Messages" values={rules.messages} />
        <FlatTable title="Death and residue" values={rules.death} />
        <FlatTable title="Ranges" values={rules.ranges} />
        <FlatTable title="Skills" values={rules.skills} />
        <FlatTable title="Upgrade prices" values={upgradeBase} />
        <div className="rules-block">
          <h4>Upgrade increments and caps</h4>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>attribute</th>
                <th>increment</th>
                <th>hard cap</th>
              </tr>
            </thead>
            <tbody>
              {attributes.map((a) => (
                <tr key={a}>
                  <th scope="row">
                    <code>{a}</code>
                  </th>
                  <td>{show(increments[a])}</td>
                  <td>{show(hard_caps[a])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h3 className="section-heading">Plant species rules</h3>
      <PlantRulesEditor species={Object.values(rules.plant_species)} onChange={() => {}} readOnly />

      <h3 className="section-heading">Configurable assumptions recorded with this run</h3>
      {props.assumptionsError ? <p className="error-line">Could not load assumptions: {props.assumptionsError}</p> : null}
      {props.assumptions ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>id</th>
              <th>rule key</th>
              <th>default</th>
              <th>source</th>
              <th>rationale</th>
            </tr>
          </thead>
          <tbody>
            {props.assumptions.map((a) => (
              <tr key={a.id}>
                <th scope="row">
                  <code>{a.id}</code>
                </th>
                <td>
                  <code>{a.key}</code>
                </td>
                <td>{show(a.default)}</td>
                <td>{a.citation}</td>
                <td>{a.rationale}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="hint">Fetching assumptions…</p>
      )}
    </div>
  );
}
