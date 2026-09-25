/**
 * Number text field that keeps partially typed text ("", "-", "0.") and only
 * reports parseable values.  With `optional`, an empty field reports null
 * (used for "no limit" settings such as max rounds or the real budget).
 */

import { useState } from "react";

export interface NumberFieldProps {
  value: number | null;
  onChange(value: number | null): void;
  integer?: boolean;
  optional?: boolean;
  id?: string;
  ariaLabel?: string;
  invalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

function parse(text: string, integer: boolean, optional: boolean): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return optional ? null : undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  if (integer && !Number.isInteger(n)) return undefined;
  return n;
}

export function NumberField(props: NumberFieldProps) {
  const integer = props.integer ?? false;
  const optional = props.optional ?? false;
  const shown = props.value === null ? "" : String(props.value);
  const [text, setText] = useState(shown);
  const [prev, setPrev] = useState(props.value);
  if (props.value !== prev) {
    setPrev(props.value);
    if (parse(text, integer, optional) !== props.value) setText(shown);
  }
  const bad = parse(text, integer, optional) === undefined;
  return (
    <input
      id={props.id}
      aria-label={props.ariaLabel}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      className={`num-field${bad || props.invalid ? " field-invalid" : ""}${props.className ? ` ${props.className}` : ""}`}
      value={text}
      disabled={props.disabled}
      placeholder={props.placeholder}
      title={bad ? (integer ? "enter a whole number" : "enter a number") : undefined}
      onChange={(e) => {
        setText(e.target.value);
        const n = parse(e.target.value, integer, optional);
        if (n !== undefined) props.onChange(n);
      }}
    />
  );
}
