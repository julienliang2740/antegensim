/**
 * Shared pieces of the god-mode forms: the context every form receives,
 * entity/agent pickers, point fields and the submit bar.
 */

import type { ReactNode } from "react";
import type { Agent, Entity, ModelInfo, Point } from "../../../api/types";
import { NumberInput } from "../common";
import { KIND_ORDER, isDead, kindLabel } from "../format";
import type { GodModeContext } from "./context";

/** Entity picker grouped by kind; dead entities are labelled. */
export function EntitySelect(props: {
  entities: Entity[];
  value: string;
  onChange(id: string): void;
  id?: string;
  disabled?: boolean;
  kinds?: Entity["kind"][];
}) {
  const kinds = props.kinds ?? KIND_ORDER;
  return (
    <select id={props.id} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)}>
      {props.value === "" ? <option value="">(choose an entity)</option> : null}
      {kinds.map((kind) => {
        const members = props.entities.filter((e) => e.kind === kind);
        if (members.length === 0) return null;
        return (
          <optgroup key={kind} label={`${kindLabel(kind, 2)} (${members.length})`}>
            {members.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id}
                {e.kind === "agent" ? ` — ${e.name}` : e.kind === "plant" || e.kind === "seed" ? ` — ${e.species}` : ""} at ({e.position.x}, {e.position.y})
                {isDead(e) ? " [dead]" : ""}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

/** Agent picker (dead agents labelled). */
export function AgentSelect(props: { agents: Agent[]; value: string; onChange(id: string): void; id?: string; disabled?: boolean }) {
  return (
    <select id={props.id} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)}>
      {props.value === "" ? <option value="">(choose an agent)</option> : null}
      {props.agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.id} — {a.name}
          {a.alive ? "" : " [dead]"}
        </option>
      ))}
    </select>
  );
}

export function PointFields(props: { value: Point; onChange(p: Point): void; disabled?: boolean; idPrefix: string }) {
  return (
    <span className="insp-pointfields">
      <label>
        x{" "}
        <NumberInput
          id={`${props.idPrefix}-x`}
          integer
          className="insp-num-short"
          value={props.value.x}
          disabled={props.disabled}
          onChange={(x) => props.onChange({ ...props.value, x })}
        />
      </label>
      <label>
        y{" "}
        <NumberInput
          id={`${props.idPrefix}-y`}
          integer
          className="insp-num-short"
          value={props.value.y}
          disabled={props.disabled}
          onChange={(y) => props.onChange({ ...props.value, y })}
        />
      </label>
    </span>
  );
}

/** Model picker; unavailable models are disabled and say which credentials are missing. */
export function ModelSelect(props: {
  models: ModelInfo[];
  value: string;
  onChange(key: string): void;
  emptyLabel?: string;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <select id={props.id} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)}>
      {props.emptyLabel !== undefined ? <option value="">{props.emptyLabel}</option> : null}
      {props.models.map((m) => (
        <option key={m.key} value={m.key} disabled={!m.available}>
          {m.key} ({m.provider}/{m.model_id})
          {m.available ? "" : ` — unavailable: missing ${m.missing_credentials.join(", ") || "configuration"}`}
        </option>
      ))}
    </select>
  );
}

/** Explanation paragraph + form body + primary button with the "next turn boundary" reminder. */
export function FormShell(props: { what: ReactNode; children: ReactNode; submitLabel: string; onSubmit(): void; ctx: GodModeContext; extraButtons?: ReactNode }) {
  return (
    <form
      className="insp-godform"
      onSubmit={(e) => {
        e.preventDefault();
        if (!props.ctx.disabled && !props.ctx.busy) props.onSubmit();
      }}
    >
      <p className="insp-godform-what">{props.what}</p>
      <fieldset disabled={props.ctx.disabled} className="insp-fieldset">
        {props.children}
      </fieldset>
      <div className="insp-submitbar">
        <button type="submit" className="insp-btn insp-btn-primary" disabled={props.ctx.disabled || props.ctx.busy}>
          {props.ctx.busy ? "Staging…" : props.submitLabel}
        </button>
        {props.extraButtons}
        <span className="insp-hint">Staged edits apply at the next turn boundary. Nobody is charged.</span>
      </div>
    </form>
  );
}
