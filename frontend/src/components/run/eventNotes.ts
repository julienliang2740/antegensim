/**
 * Second line of a feed entry (live log and turn record): the cause of a
 * failure (INTERFACES section 7 `model_call_failed.details.error`,
 * `decision_invalid.details.reason`) or what an operator edit changed
 * (`intervention.details.intervention` / `changes`).
 */

import type { Event, FieldChange, Intervention } from "../../api/types";
import { describeIntervention } from "../inspect";
import { describeChange } from "../../state/changes";
import { eventDetailNote } from "../../state/feed";

/** The note under an event's summary, or null when the summary says it all. */
export function eventNote(event: Event): string | null {
  return event.kind === "intervention" ? interventionNote(event) : eventDetailNote(event);
}

/**
 * "set a02.stats.health = 0 · world.agents.a02.stats.health: 100 → 0 (+7 more changes)".
 */
function interventionNote(event: Event): string | null {
  const iv = event.details.intervention as Intervention | undefined;
  const changes = Array.isArray(event.details.changes) ? (event.details.changes as FieldChange[]) : [];
  if (!iv || typeof iv !== "object" || typeof iv.type !== "string") return null;
  const parts = [describeIntervention(iv)];
  if (event.details.ok === false && typeof event.details.error === "string") parts.push(`not applied: ${event.details.error}`);
  if (changes.length > 0) parts.push(`${describeChange(changes[0])}${changes.length > 1 ? ` (+${changes.length - 1} more change${changes.length === 2 ? "" : "s"})` : ""}`);
  return parts.join(" · ");
}
