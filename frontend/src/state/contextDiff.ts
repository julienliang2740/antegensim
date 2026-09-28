/**
 * The difference between two ContextSettings, as the partial object an
 * update_context_settings intervention with scope "run" merges (INTERFACES
 * section 10: non-null fields are merged into the run defaults).
 */

import type { ContextOverrides, ContextSettings } from "../api/types";

/** Fields of `next` that differ from `base` (a run-scope update merges only these). */
export function changedContextFields(base: ContextSettings, next: ContextSettings): ContextOverrides {
  const diff: ContextOverrides = {};
  const keys: (keyof ContextSettings)[] = [
    "input_token_cap",
    "generation_allowance",
    "recent_history_length",
    "notebook_max_tokens",
    "retrieved_memory_limit",
    "new_event_digest_limit",
    "weights",
    "include_skill_source",
    "persona_tip",
  ];
  for (const key of keys) {
    if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) (diff as Record<string, unknown>)[key] = next[key];
  }
  return diff;
}
