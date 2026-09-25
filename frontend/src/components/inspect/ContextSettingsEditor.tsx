/**
 * ContextSettingsEditor: the operator controls for context limits and memory
 * selection (spec U16 and "Budget delivery and inspection": input-token cap,
 * generation allowance, recent-history length, notebook size,
 * retrieved-memory limit and retrieval weights), with inline validation
 * against the selected model's capabilities.  See ContextSettingsEditorProps.
 */

import "../../inspect.css";
import type { ContextOverrides, RetrievalWeights } from "../../api/types";
import { NumberInput } from "./common";
import { CONTEXT_NUMBER_FIELDS, WEIGHT_FIELDS, validateContextSettings } from "./contextLimits";
import type { ContextNumberField } from "./contextLimits";
import { fmtNum } from "./format";
import { applyOverrides, overridesEmpty } from "./logic";
import type { ContextSettingsEditorProps } from "./props";

type OverrideKey = keyof ContextOverrides;

export function ContextSettingsEditor(props: ContextSettingsEditorProps) {
  const overrideMode = props.onOverridesChange !== undefined;
  const readOnly = props.readOnly ?? false;
  const overrides: ContextOverrides = props.overrides ?? {};
  const effective = overrideMode ? applyOverrides(props.value, overrides) : props.value;
  const problems = validateContextSettings(effective, props.capabilities);

  const isOverridden = (key: OverrideKey) => overrides[key] !== null && overrides[key] !== undefined;

  const setOverride = (key: OverrideKey, next: unknown) => {
    const merged: ContextOverrides = { ...overrides, [key]: next };
    props.onOverridesChange?.(overridesEmpty(merged) ? null : merged);
  };

  const setNumber = (field: ContextNumberField, n: number) => {
    if (overrideMode) setOverride(field, n);
    else props.onChange({ ...props.value, [field]: n });
  };

  const setWeights = (weights: RetrievalWeights) => {
    if (overrideMode) setOverride("weights", weights);
    else props.onChange({ ...props.value, weights });
  };

  const setIncludeSource = (flag: boolean) => {
    if (overrideMode) setOverride("include_skill_source", flag);
    else props.onChange({ ...props.value, include_skill_source: flag });
  };

  const overrideCell = (key: OverrideKey, baseValue: unknown) => {
    if (!overrideMode) return null;
    const checked = isOverridden(key);
    return (
      <td className="insp-ctx-override">
        {readOnly ? (
          <span className={checked ? "insp-badge insp-badge-warn" : "insp-muted"}>{checked ? "override" : "run default"}</span>
        ) : (
          <label>
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setOverride(key, e.target.checked ? baseValue : null)}
            />{" "}
            override
          </label>
        )}
      </td>
    );
  };

  const baseCell = (text: string) => (overrideMode ? <td className="insp-muted">{text}</td> : null);
  const editable = (key: OverrideKey) => !readOnly && (!overrideMode || isOverridden(key));

  const caps = props.capabilities;
  const total = effective.input_token_cap + effective.generation_allowance;

  return (
    <div className="insp insp-ctx">
      {props.label ? <div className="insp-ctx-label">{props.label}</div> : null}
      <table className="insp-table insp-ctx-table">
        <thead>
          <tr>
            <th>Setting</th>
            <th>{overrideMode ? "Effective value" : "Value"}</th>
            {overrideMode ? <th>Override?</th> : null}
            {overrideMode ? <th>Run default</th> : null}
          </tr>
        </thead>
        <tbody>
          {CONTEXT_NUMBER_FIELDS.map((spec) => {
            const key = spec.field;
            const error = problems[key];
            return (
              <tr key={key} className={error ? "insp-row-error" : undefined}>
                <th scope="row">
                  {spec.label}
                  <div className="insp-fieldname">{key}</div>
                  <div className="insp-hint">{spec.hint}</div>
                </th>
                <td>
                  {editable(key) ? (
                    <NumberInput
                      ariaLabel={spec.label}
                      integer
                      value={effective[key]}
                      invalid={!!error}
                      onChange={(n) => setNumber(key, n)}
                    />
                  ) : (
                    <span className={overrideMode && !isOverridden(key) ? "insp-muted" : undefined}>{fmtNum(effective[key])}</span>
                  )}
                  {error ? <div className="insp-error-text">{error}</div> : null}
                </td>
                {overrideCell(key, props.value[key])}
                {baseCell(fmtNum(props.value[key]))}
              </tr>
            );
          })}
          {WEIGHT_FIELDS.map((w, i) => {
            const error = problems[`weights.${w}`] ?? (i === 0 ? problems["weights"] : undefined);
            return (
              <tr key={w} className={error ? "insp-row-error" : undefined}>
                <th scope="row">
                  Retrieval weight: {w}
                  <div className="insp-fieldname">weights.{w}</div>
                </th>
                <td>
                  {editable("weights") ? (
                    <NumberInput
                      ariaLabel={`Retrieval weight ${w}`}
                      value={effective.weights[w]}
                      invalid={!!error}
                      onChange={(n) => setWeights({ ...effective.weights, [w]: n })}
                    />
                  ) : (
                    <span className={overrideMode && !isOverridden("weights") ? "insp-muted" : undefined}>{fmtNum(effective.weights[w])}</span>
                  )}
                  {error ? <div className="insp-error-text">{error}</div> : null}
                </td>
                {i === 0 ? overrideCell("weights", props.value.weights) : null}
                {i > 0 && overrideMode ? <td className="insp-muted insp-small">(with relevance)</td> : null}
                {baseCell(fmtNum(props.value.weights[w]))}
              </tr>
            );
          })}
          <tr>
            <th scope="row">
              Include full skill source
              <div className="insp-fieldname">include_skill_source</div>
            </th>
            <td>
              {editable("include_skill_source") ? (
                <label>
                  <input type="checkbox" checked={effective.include_skill_source} onChange={(e) => setIncludeSource(e.target.checked)} />{" "}
                  {effective.include_skill_source ? "yes, every skill's code" : "no, catalogue only"}
                </label>
              ) : (
                <span>{effective.include_skill_source ? "yes" : "no"}</span>
              )}
            </td>
            {overrideCell("include_skill_source", props.value.include_skill_source)}
            {baseCell(props.value.include_skill_source ? "yes" : "no")}
          </tr>
        </tbody>
      </table>
      {readOnly && !caps ? null : (
      <div className={`insp-ctx-caps${problems[""] ? " insp-error-text" : ""}`}>
        {caps ? (
          <>
            Model limits: context window {fmtNum(caps.context_window)} tokens, max output {fmtNum(caps.max_output_tokens)} tokens.
            Input cap + generation = {fmtNum(total)} {total <= caps.context_window ? "(fits)" : "(does NOT fit)"}.
          </>
        ) : (
          <>Model capabilities unknown: the context-window check runs on the backend.</>
        )}
        {problems[""] ? <div>{problems[""]}</div> : null}
      </div>
      )}
      {overrideMode && !readOnly ? (
        <div className="insp-hint">
          Unchecked fields use the run default. Clearing every override removes the agent's override entirely.
        </div>
      ) : null}
    </div>
  );
}
