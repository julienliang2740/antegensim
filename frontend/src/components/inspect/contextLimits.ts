/**
 * Inline validation for context/memory settings (spec "Budget delivery and
 * inspection"; INTERFACES section 4.3 `validate_settings`).
 *
 * The backend is authoritative (`context.validate_settings` runs at run
 * creation, staging and apply).  These mirrors only give early feedback:
 * the static bounds come from schemas.ContextSettings (Field ge/le) and the
 * minimums from config.MIN_PACKET_INPUT_TOKENS / MIN_GENERATION_TOKENS, which
 * the API does not serve yet (reported as TODO(schema)).  Keep them in sync.
 */

import type { ContextSettings, ModelCapabilities } from "../../api/types";

/** Mirror of config.MIN_PACKET_INPUT_TOKENS (smallest valid decision packet). */
export const MIN_PACKET_INPUT_TOKENS = 1200;
/** Mirror of config.MIN_GENERATION_TOKENS. */
export const MIN_GENERATION_TOKENS = 200;

export type ContextNumberField =
  | "input_token_cap"
  | "generation_allowance"
  | "recent_history_length"
  | "notebook_max_tokens"
  | "retrieved_memory_limit"
  | "new_event_digest_limit";

export interface ContextFieldSpec {
  field: ContextNumberField;
  /** The spec's name for the control ("Operator controls" list). */
  label: string;
  hint: string;
  min: number;
  max: number | null;
}

/** Field order and labels follow the spec's operator-controls list. Bounds mirror schemas.ContextSettings. */
export const CONTEXT_NUMBER_FIELDS: ContextFieldSpec[] = [
  { field: "input_token_cap", label: "Input token cap", hint: "max input tokens per decision packet", min: 1, max: null },
  { field: "generation_allowance", label: "Generation allowance", hint: "max output tokens per decision", min: 1, max: null },
  { field: "recent_history_length", label: "Recent history length", hint: "own recent decisions shown", min: 0, max: 50 },
  { field: "notebook_max_tokens", label: "Notebook size", hint: "max notebook tokens", min: 0, max: 4000 },
  { field: "retrieved_memory_limit", label: "Retrieved memory limit", hint: "older records retrieved by rank", min: 0, max: 50 },
  { field: "new_event_digest_limit", label: "New-event digest limit", hint: "unread records summarised", min: 1, max: 50 },
];

export type WeightField = "relevance" | "recency" | "importance";
export const WEIGHT_FIELDS: WeightField[] = ["relevance", "recency", "importance"];

/** Problems keyed by field path ("input_token_cap", "weights.recency", "" for whole-object rules). */
export type ContextProblems = Record<string, string>;

/**
 * Check a candidate ContextSettings.  Rules: integers within the schema
 * bounds; input_token_cap >= MIN_PACKET_INPUT_TOKENS; MIN_GENERATION_TOKENS <=
 * generation_allowance <= capabilities.max_output_tokens; input_token_cap +
 * generation_allowance <= capabilities.context_window; weights finite, >= 0
 * and not all zero.
 */
export function validateContextSettings(value: ContextSettings, capabilities: ModelCapabilities | null | undefined): ContextProblems {
  const problems: ContextProblems = {};
  for (const spec of CONTEXT_NUMBER_FIELDS) {
    const v = value[spec.field];
    if (!Number.isFinite(v) || !Number.isInteger(v)) problems[spec.field] = "must be a whole number";
    else if (v < spec.min) problems[spec.field] = `must be at least ${spec.min}`;
    else if (spec.max !== null && v > spec.max) problems[spec.field] = `must be at most ${spec.max}`;
  }
  if (!problems.input_token_cap && value.input_token_cap < MIN_PACKET_INPUT_TOKENS) {
    problems.input_token_cap = `must be at least ${MIN_PACKET_INPUT_TOKENS} (smallest valid packet)`;
  }
  if (!problems.generation_allowance) {
    if (value.generation_allowance < MIN_GENERATION_TOKENS) {
      problems.generation_allowance = `must be at least ${MIN_GENERATION_TOKENS}`;
    } else if (capabilities && value.generation_allowance > capabilities.max_output_tokens) {
      problems.generation_allowance = `exceeds the model's max output (${capabilities.max_output_tokens} tokens)`;
    }
  }
  if (capabilities && !problems.input_token_cap && !problems.generation_allowance) {
    const total = value.input_token_cap + value.generation_allowance;
    if (total > capabilities.context_window) {
      problems[""] = `input token cap + generation allowance = ${total}, above the model's context window (${capabilities.context_window})`;
    }
  }
  let allZero = true;
  for (const w of WEIGHT_FIELDS) {
    const v = value.weights[w];
    if (!Number.isFinite(v)) problems[`weights.${w}`] = "must be a number";
    else if (v < 0) problems[`weights.${w}`] = "must be 0 or more";
    if (v > 0) allZero = false;
  }
  if (allZero && !WEIGHT_FIELDS.some((w) => problems[`weights.${w}`])) problems["weights"] = "at least one retrieval weight must be above 0";
  return problems;
}
