/**
 * Small building blocks shared by the inspection components: a number input
 * that tolerates partial typing, collapsible sections, key/value tables,
 * problem lists and kind tags.  Plain elements styled by src/inspect.css.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import type { ApiProblem, EntityKind } from "../../api/types";
import type { KeyValueRow } from "./rows";
import { DEAD_MARK, KIND_LETTER, fmtJson, fmtValue, kindLabel } from "./format";

// ---------------------------------------------------------------------------
// NumberInput
// ---------------------------------------------------------------------------

export interface NumberInputProps {
  value: number;
  onChange(value: number): void;
  integer?: boolean;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  readOnly?: boolean;
  id?: string;
  ariaLabel?: string;
  /** Marks the input red (an outside validation problem). */
  invalid?: boolean;
  className?: string;
}

/**
 * Text for a number input: integers as-is, otherwise the shortest form without
 * floating-point noise (199.79560000000004 -> "199.7956").  Only the shown text
 * changes; the value is kept exactly until the operator types.
 */
export function numberText(value: number): string {
  if (!Number.isFinite(value) || Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(12)));
}

function parseNumber(text: string, integer: boolean): number | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === ".") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  if (integer && !Number.isInteger(n)) return null;
  return n;
}

/**
 * Controlled number field that keeps the typed text while it is incomplete
 * ("", "-", "0.") and only reports parseable values.  Unparseable text is
 * shown with a red border and never sent upward.
 */
export function NumberInput(props: NumberInputProps) {
  const integer = props.integer ?? false;
  const [text, setText] = useState(numberText(props.value));
  const [prevValue, setPrevValue] = useState(props.value);
  if (props.value !== prevValue) {
    setPrevValue(props.value);
    if (parseNumber(text, integer) !== props.value) setText(numberText(props.value));
  }
  const parsed = parseNumber(text, integer);
  const bad = parsed === null;
  return (
    <input
      id={props.id}
      aria-label={props.ariaLabel}
      className={`insp-num${bad || props.invalid ? " insp-invalid" : ""}${props.className ? ` ${props.className}` : ""}`}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      value={text}
      disabled={props.disabled}
      readOnly={props.readOnly}
      title={bad ? (integer ? "enter a whole number" : "enter a number") : undefined}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        const n = parseNumber(next, integer);
        if (n !== null) props.onChange(n);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function Section(props: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; extra?: ReactNode; className?: string }) {
  return (
    <details className={`insp-section${props.className ? ` ${props.className}` : ""}`} open={props.defaultOpen ?? true}>
      <summary>
        <span className="insp-section-title">{props.title}</span>
        {props.extra ? <span className="insp-section-extra">{props.extra}</span> : null}
      </summary>
      <div className="insp-section-body">{props.children}</div>
    </details>
  );
}


/** Two-column table of labelled values. */
export function KeyValueTable(props: { rows: KeyValueRow[]; className?: string }) {
  return (
    <table className={`insp-kv${props.className ? ` ${props.className}` : ""}`}>
      <tbody>
        {props.rows.map(([label, value, title], i) => (
          <tr key={i}>
            <th scope="row">{label}</th>
            <td title={title}>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A JSON value on one line, cut at `maxChars`, with a control that shows the
 * whole pretty-printed JSON: nothing is truncated without a way to see it all.
 */
export function ExpandableJson(props: { value: unknown; maxChars?: number }) {
  const [open, setOpen] = useState(false);
  const max = props.maxChars ?? 200;
  const oneLine = fmtValue(props.value, Number.MAX_SAFE_INTEGER);
  if (oneLine.length <= max) return <code className="insp-json-inline">{oneLine}</code>;
  return (
    <div className="insp-expandable">
      {open ? <pre className="insp-pre insp-json-full">{fmtJson(props.value)}</pre> : <code className="insp-json-inline">{fmtValue(props.value, max)}</code>}
      <button type="button" className="insp-btn insp-btn-small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide full JSON" : `Show full JSON (${oneLine.length} chars)`}
      </button>
    </div>
  );
}

/** Validation problems (from the backend or local checks), path first. */
export function ProblemList(props: { problems: ApiProblem[]; title?: string }) {
  if (props.problems.length === 0) return null;
  return (
    <div className="insp-problems" role="alert">
      <strong>{props.title ?? "Problems"}</strong>
      <ul>
        {props.problems.map((p, i) => (
          <li key={i}>
            {p.path ? <code>{p.path}</code> : null}
            {p.path ? ": " : null}
            {p.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Coloured letter tag for an entity kind (same colours as the map badges). */
export function KindTag(props: { kind: EntityKind; dead?: boolean }) {
  return (
    <span className={`insp-kind insp-kind-${props.kind}${props.dead ? " insp-kind-dead" : ""}`} title={props.dead ? `dead ${kindLabel(props.kind)}` : kindLabel(props.kind)}>
      {props.dead ? DEAD_MARK : KIND_LETTER[props.kind]}
    </span>
  );
}

/** Labelled form row: label on the left, control, optional hint and error. */
export function FormRow(props: { label: ReactNode; htmlFor?: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className={`insp-formrow${props.error ? " insp-formrow-error" : ""}`}>
      <label htmlFor={props.htmlFor}>{props.label}</label>
      <div className="insp-formrow-control">
        {props.children}
        {props.hint ? <div className="insp-hint">{props.hint}</div> : null}
        {props.error ? <div className="insp-error-text">{props.error}</div> : null}
      </div>
    </div>
  );
}
