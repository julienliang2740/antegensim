/**
 * Model choice for run setup: every configured model is listed, only
 * available ones are selectable, and unavailable ones name the missing
 * credentials or settings (spec "Model calls and validation": expose
 * unsupported configurations clearly; never silently substitute a model).
 */

import type { ModelInfo } from "../../api/types";

function modelOptionText(m: ModelInfo): string {
  const base = `${m.key} (${m.provider}/${m.model_id})`;
  return m.available ? base : `${base} — unavailable: missing ${m.missing_credentials.join(", ") || "configuration"}`;
}

export function ModelSelect(props: {
  id: string;
  models: ModelInfo[];
  value: string;
  onChange(key: string): void;
  /** Label of the empty option ("use run default"); omitted = no empty option. */
  emptyLabel?: string;
  invalid?: boolean;
}) {
  const known = props.models.some((m) => m.key === props.value);
  return (
    <select id={props.id} className={props.invalid ? "field-invalid" : undefined} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      {props.emptyLabel !== undefined ? <option value="">{props.emptyLabel}</option> : null}
      {!known && props.value ? <option value={props.value}>{props.value} (not in the model registry)</option> : null}
      {props.models.map((m) => (
        <option key={m.key} value={m.key} disabled={!m.available}>
          {modelOptionText(m)}
        </option>
      ))}
    </select>
  );
}

/** A short list of unavailable models and what they miss. */
export function UnavailableModels(props: { models: ModelInfo[] }) {
  const missing = props.models.filter((m) => !m.available);
  if (missing.length === 0) return null;
  return (
    <div className="hint">
      Unavailable models (set the named variables in the backend's <code>.env</code> and restart it):{" "}
      {missing.map((m, i) => (
        <span key={m.key}>
          {i > 0 ? "; " : ""}
          <code>{m.key}</code> needs {m.missing_credentials.join(", ") || "configuration"}
        </span>
      ))}
      .
    </div>
  );
}
