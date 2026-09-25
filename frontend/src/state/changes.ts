/**
 * Readable before/after text for operator edits (spec "God mode and direct
 * file editing": each intervention is recorded with before/after values;
 * "Display and historical inspection": show what changed).  A FieldChange
 * (INTERFACES section 10) can carry a whole knowledge record as its value;
 * these helpers say the one useful fact ("added operator_voice record
 * a02-k000006: ...") and leave the raw JSON to a collapsible block.
 */

import type { FieldChange } from "../api/types";

/** Longest value text shown inline before it is cut (the raw JSON stays available). */
export const INLINE_VALUE_CHARS = 80;

const RECORD_PATH = /^knowledge\.([^.]+)\.records\[([^\]]+)\]$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One-line JSON of a value, cut to `maxChars`; "(absent)" for undefined. */
export function compactValue(value: unknown, maxChars = INLINE_VALUE_CHARS): string {
  if (value === undefined) return "(absent)";
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** True when a value is too long to read inline (show it collapsed instead). */
export function isBulky(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  try {
    return (JSON.stringify(value) ?? "").length > INLINE_VALUE_CHARS;
  } catch {
    return false;
  }
}

/**
 * A knowledge-record change as one sentence, or null for any other path:
 * "added operator_voice record a02-k000006 for a02: "Look north"".
 */
export function describeRecordChange(change: FieldChange): string | null {
  const match = RECORD_PATH.exec(change.path);
  if (!match) return null;
  const [, agentId, recordId] = match;
  const added = change.before === null || change.before === undefined;
  const record = added ? change.after : change.before;
  if (!isObject(record)) return null;
  const kind = typeof record.kind === "string" ? record.kind : "knowledge";
  const text = typeof record.text === "string" ? `: ${JSON.stringify(record.text.length > 160 ? `${record.text.slice(0, 159)}…` : record.text)}` : "";
  return added ? `added ${kind} record ${recordId} for ${agentId}${text}` : `removed ${kind} record ${recordId} from ${agentId}${text}`;
}

/** "path: before → after" (or the record sentence) for a feed line. */
export function describeChange(change: FieldChange, maxChars = 40): string {
  return describeRecordChange(change) ?? `${change.path}: ${compactValue(change.before, maxChars)} → ${compactValue(change.after, maxChars)}`;
}
