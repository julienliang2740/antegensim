/**
 * Pure helpers behind the assistant drawer (no React; unit-tested in state.test.mjs):
 * the deterministic "What will happen" lines of a brief card, the approve
 * button label, the fixed error table (ModelResult status / error_code and
 * API error codes -> plain text + action), context-built suggestions, the
 * context chip sent with each message, and small formatters.
 *
 * DOCS: a brief card's primary section is NEVER model text.  describeAction()
 * renders it from the typed action (describeIntervention lines for staged
 * edits, fixed sentences for run commands, continuations, open_run and
 * settings); the backend adds the setup diff, warnings and validation
 * problems.  The model's title/summary/steps sit below as "Assistant's
 * description".  errorGuidance() is the single mapping from failure codes to
 * what the user reads and what the button offers.
 */

import type { ApiErrorCode, Intervention, RunCommand, RunStatus } from "../api/types";
import type { BriefAction, BriefEffect, ContextChip, SetupDiffEntry } from "../api/assistantTypes";
import { describeIntervention } from "../components/inspect/logic";
import type { AssistantContext } from "./assistantContext";
import { formatElapsed } from "./working";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "$0.03", "$1.20", "<$0.01" for tiny non-zero amounts, "$0.00" for zero. */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "$?";
  if (value === 0) return "$0.00";
  if (value > 0 && value < 0.005) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/** "18 s", "1 min 05 s" (shared with the working indicator, state/working.ts). */
export { formatElapsed };

/** The job progress line: "step 2/4 · 18 s · $0.03". */
export function progressLine(step: number, maxSteps: number, elapsedS: number, costUsd: number): string {
  const stepText = maxSteps > 0 ? `step ${Math.max(step, 1)}/${maxSteps}` : `step ${Math.max(step, 1)}`;
  return `${stepText} · ${formatElapsed(elapsedS)} · ${formatUsd(costUsd)}`;
}

/**
 * The part of the backend's progress text worth showing under the ticking
 * progress line: the step note after "step k/N · N s · $x" ("reading the
 * run"), "Queued…" for the queued placeholder, else null.  The backend writes
 * that text once per step, so its elapsed seconds and cost are stale while a
 * step runs; the drawer computes those itself (progressLine) and never prints
 * the backend's numbers.
 */
export function progressNote(progress: string | null | undefined): string | null {
  const text = (progress ?? "").trim();
  if (!text) return null;
  if (/^queued\b/i.test(text)) return "Queued…";
  const parts = text.split(" · ");
  if (!/^step \d+(\/\d+)?$/.test(parts[0])) return text;
  const note = parts.slice(3).join(" · ").trim();
  return note || null;
}

/**
 * The run status an approved brief returned, when it belongs to `runId` (the
 * run on screen, whose page applies it at once so counts such as the staged
 * edits never wait for the next status poll); else null.
 */
export function effectStatusFor(effect: BriefEffect | null | undefined, runId: string | null | undefined): RunStatus | null {
  const status = effect?.status ?? null;
  if (!status || !runId) return null;
  return status.run_id === runId ? status : null;
}

/** A short readable value for diff entries ("no limit" for null, JSON otherwise). */
export function fmtDiffValue(value: unknown, max = 60): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Context chip and scope
// ---------------------------------------------------------------------------

/** The run a conversation of this page belongs to: the run on the run and Story Mode pages, else null (global scope). */
export function scopeRunId(ctx: AssistantContext): string | null {
  return (ctx.page === "run" || ctx.page === "story") && ctx.runId ? ctx.runId : null;
}

/** The ContextChip sent with a message (snake_case mirror of the context store). */
export function chipFromContext(ctx: AssistantContext): ContextChip {
  return {
    page: ctx.page,
    run_id: ctx.runId,
    run_name: ctx.runName,
    shown_turn_id: ctx.shownTurnId,
    live_turn_id: ctx.liveTurnId,
    tab: ctx.tab,
    selected_entity_id: ctx.selectedEntityId,
    selected_entity_kind: ctx.selectedEntityKind,
    selected_point: ctx.selectedPoint ? `${ctx.selectedPoint.x},${ctx.selectedPoint.y}` : null,
    run_state: ctx.runState,
    last_error: ctx.lastError,
    story_id: ctx.storyId,
  };
}

// ---------------------------------------------------------------------------
// Briefs: deterministic "What will happen"
// ---------------------------------------------------------------------------

export const COMMAND_LABELS: Record<RunCommand, string> = {
  run_turn: "Advance 1 turn",
  play: "Start simulation",
  pause: "Pause simulation",
  step_round: "Finish round",
};

export interface DescribeOptions {
  /** Names of runs the drawer knows (run id -> name). */
  runNames?: Record<string, string>;
  /** The run shown in this tab and its state (for run_command sentences). */
  onScreenRunId?: string | null;
  runState?: string | null;
}

function runLabel(runId: string, options: DescribeOptions): string {
  const name = options.runNames?.[runId];
  return name ? `"${name}" (${runId})` : runId;
}

/**
 * The lines of the card's primary section, rendered from the typed action.
 * Null (an action that failed validation) yields one line saying so; the
 * problems are shown by the card from validation.problems.
 */
export function describeAction(action: BriefAction | null, options: DescribeOptions = {}): string[] {
  if (!action) return ["This proposal could not be validated, so nothing can be executed from it."];
  switch (action.type) {
    case "create_run": {
      const overlay = action.overlay as { default_model_key?: unknown };
      const model = typeof overlay.default_model_key === "string" ? ` with model ${overlay.default_model_key}` : "";
      return [`Creates a paused run "${action.name}" with ${action.agent_count} agents${model}.`, "Nothing is spent until you play it."];
    }
    case "run_command": {
      const label = COMMAND_LABELS[action.command] ?? action.command;
      const times = action.rounds ? ` ×${action.rounds}` : "";
      const state = options.onScreenRunId === action.run_id && options.runState ? ` (state ${options.runState})` : "";
      const lines = [`Sends ${label}${times} to run ${runLabel(action.run_id, options)}${state}.`];
      if (action.rounds) lines.push(`A backend job steps ${action.rounds} rounds one at a time and stops early if you pause or the run errors.`);
      if (action.command === "play") lines.push("Start simulation keeps running turns until you pause, the run finishes or its budget is reached.");
      return lines;
    }
    case "stage_interventions": {
      const n = action.interventions.length;
      const lines = [`Stages ${n} god-mode edit${n === 1 ? "" : "s"} on run ${runLabel(action.run_id, options)} (origin: assistant). They apply when the next turn starts.`];
      for (const iv of action.interventions) lines.push(`• ${describeIntervention(iv as Intervention)}`);
      return lines;
    }
    case "create_continuation":
      return [`Creates a new run${action.name ? ` "${action.name}"` : ""} that continues ${runLabel(action.run_id, options)} from turn ${action.from_turn_id} (opens paused).`];
    case "open_run":
      return [`Opens run ${runLabel(action.run_id, options)} in this tab. Nothing executes.`];
    case "update_assistant_settings": {
      const parts: string[] = [];
      if (action.storybook_auto !== null) parts.push(`automatic storybook ${action.storybook_auto ? "on" : "off"}`);
      if (action.chat_budget_usd !== null) parts.push(`chat budget ${formatUsd(action.chat_budget_usd)}`);
      if (action.storybook_budget_usd !== null) parts.push(`storybook budget ${formatUsd(action.storybook_budget_usd)}`);
      return [`Changes the assistant settings of run ${runLabel(action.run_id, options)}: ${parts.join(", ") || "(nothing)"}.`];
    }
  }
}

/** "path: default -> value" lines of the backend-computed setup diff. */
export function describeSetupDiff(diff: readonly SetupDiffEntry[]): string[] {
  return diff.map((entry) => `${entry.path}: ${fmtDiffValue(entry.default)} → ${fmtDiffValue(entry.value)}`);
}

/** The primary button's name, by effect. */
export function approveLabel(action: BriefAction | null): string {
  if (!action) return "Approve";
  switch (action.type) {
    case "create_run":
      return "Approve: create run";
    case "run_command": {
      if (action.rounds) return `Approve: step ${action.rounds} round${action.rounds === 1 ? "" : "s"}`;
      return `Approve: ${COMMAND_LABELS[action.command]?.toLowerCase() ?? action.command}`;
    }
    case "stage_interventions":
      return `Approve: stage ${action.interventions.length} edit${action.interventions.length === 1 ? "" : "s"}`;
    case "create_continuation":
      return "Approve: create continuation";
    case "open_run":
      return "Open run";
    case "update_assistant_settings":
      return "Approve: change settings";
  }
}

/** The run an action needs on screen before it may be approved (run commands only), else null. */
export function requiresOnScreenRun(action: BriefAction | null): string | null {
  return action && action.type === "run_command" ? action.run_id : null;
}

/** The composer text for "Ask for changes": the brief quoted, ready for the user's instruction. */
export function quoteBrief(title: string): string {
  return `> ${title}\nChange this: `;
}

// ---------------------------------------------------------------------------
// Error table
// ---------------------------------------------------------------------------

export type ErrorAction = "retry" | "login" | "raise_limit" | "shorter" | "install" | "docs" | "none";

export interface ErrorGuidance {
  text: string;
  action: ErrorAction;
  /** The button's label for `action` (empty for "none"). */
  actionLabel: string;
}

const ACTION_LABELS: Record<ErrorAction, string> = {
  retry: "Retry",
  login: "How to log in",
  raise_limit: "Raise limit",
  shorter: "Retry",
  install: "How to install",
  docs: "Open 'How the world works'",
  none: "",
};

/**
 * Plain text and an action for a failed assistant call: `errorCode` is
 * ModelResult.error_code (or an ApiErrorCode when the request itself
 * failed), `status` the ModelResult status when known, `detail` the redacted
 * backend message (appended when short).
 */
export function errorGuidance(status: string | null | undefined, errorCode: string | null | undefined, detail?: string | null): ErrorGuidance {
  const code = (errorCode ?? "") as string;
  const pick = (text: string, action: ErrorAction): ErrorGuidance => ({ text, action, actionLabel: ACTION_LABELS[action] });
  const apiCode = code as ApiErrorCode;
  switch (code) {
    case "budget_exceeded":
      return pick("The model call hit the assistant's per-call cost cap before it finished.", "shorter");
    case "rate_limited":
      return pick("The model provider is rate-limiting requests right now. Wait a moment, then retry.", "retry");
    case "schema_mismatch":
      return pick("The model's reply did not fit the expected format, and one repair attempt did not help.", "retry");
    case "cancelled":
      return pick("Stopped at your request.", "retry");
    case "timeout":
      return pick("The model took too long (the per-message limit is 90 s). A shorter or narrower question usually answers faster.", "shorter");
    case "not_logged_in":
      return pick("The Claude CLI on the backend machine is not logged in. Run `claude` once in a terminal there and sign in.", "login");
    case "cli_missing":
      return pick("The Claude CLI is not installed on the backend machine, so no live model can answer.", "install");
    default:
      break;
  }
  switch (apiCode) {
    case "assistant_unavailable":
      return pick("The assistant is not configured in this backend (tests and headless runs start without it). The rules are still in 'How the world works'.", "docs");
    case "assistant_budget_exhausted":
      return pick(`A spend limit was reached${detail ? `: ${detail}` : ""}. Raise the limit from the spend indicator, or continue without the assistant.`, "raise_limit");
    case "conversation_busy":
      return pick("The assistant is still answering the previous message in this conversation.", "none");
    case "assistant_busy":
      return pick("The assistant is busy with another job; try again in a moment.", "retry");
    case "brief_not_pending":
      return pick("This proposal was already approved, rejected or replaced.", "none");
    case "payload_too_large":
      return pick("The request was too large (the audio cap is 10 MB).", "none");
    case "run_not_open":
      return pick("The run is not open in the backend. Open the run page, then retry.", "retry");
    default:
      break;
  }
  switch (status) {
    case "malformed":
    case "truncated":
      return pick("The model's reply could not be used (malformed or cut short).", "retry");
    case "refusal":
      return pick("The model declined to answer this.", "none");
    case "invalid_config":
      return pick(`The assistant's model is misconfigured${detail ? `: ${detail}` : ""}.`, "docs");
    case "interrupted":
      return pick("The backend restarted while this was running.", "retry");
    default:
      break;
  }
  return pick(detail ? `Something went wrong: ${detail}` : "Something went wrong.", "retry");
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export interface SuggestionOptions {
  /** Capabilities.available (false: the offline docs search still answers). */
  available?: boolean;
  /** The selected entity's display name, when known. */
  selectedName?: string | null;
}

/** Suggested questions for an empty conversation, built from what the user is looking at. */
export function buildSuggestions(ctx: AssistantContext, options: SuggestionOptions = {}): string[] {
  const out: string[] = [];
  const push = (text: string) => {
    if (!out.includes(text)) out.push(text);
  };
  switch (ctx.page) {
    case "run": {
      if (ctx.lastError || ctx.runState === "error") push("Why did the run stop?");
      if (ctx.selectedEntityId) push(`What is ${options.selectedName ?? ctx.selectedEntityId} up to?`);
      push("What is going on right now?");
      if (ctx.shownTurnId && ctx.liveTurnId && ctx.shownTurnId !== ctx.liveTurnId) push(`Summarize turn ${ctx.shownTurnId}`);
      else push("Summarize the last round");
      if (ctx.tab === "god") push("Give every living agent 20 more health");
      if (ctx.tab === "storybook") push("Write the storybook entries this run is missing");
      if (ctx.tab === "rules") push("Explain these rules in plain words");
      if (ctx.runState === "paused" || ctx.runState === "finished") push("Step 3 rounds");
      push("What is interesting in this run so far?");
      break;
    }
    case "new":
      push("Set up a fight arena with 8 agents");
      push("What do the agent stats mean?");
      push("Which model should I pick?");
      break;
    case "resume":
      push("Which of my runs is the most interesting?");
      push("Open the run with the most kills");
      break;
    case "story":
      push("How does Story Mode work?");
      push("Which point of view works best for a short run?");
      break;
    case "instructions":
      push("Explain skills in simple terms");
      push("How do agents die?");
      break;
    case "entry":
    default:
      push("What is Empyrean and how do I start?");
      push("Set up a fight arena");
      push("Explain the controls");
      break;
  }
  if (options.available === false) return out.filter((s) => !/^(Set up|Step|Open|Give|Write)/.test(s));
  return out.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Offline fallback: the "How the world works" sections, searchable client-side
// ---------------------------------------------------------------------------

export interface DocSectionHit {
  id: string;
  title: string;
  score: number;
}

/** The InstructionsPage sections (ids match pages/InstructionsPage.tsx SECTIONS) with search keywords. */
export const DOC_SECTIONS: { id: string; title: string; keywords: string[] }[] = [
  { id: "overview", title: "The game in brief", keywords: ["start", "begin", "overview", "what", "empyrean", "game", "how", "loop", "new", "first"] },
  { id: "world", title: "The Empyrean", keywords: ["world", "terrain", "region", "map", "mountain", "water", "land", "cell", "grid", "seed"] },
  { id: "agents", title: "Agents", keywords: ["agent", "agents", "stats", "stat", "persona", "speed", "vision", "name", "card", "cards"] },
  { id: "resources", title: "Compute, essence and health", keywords: ["compute", "essence", "health", "resource", "resources", "upkeep", "starve", "starvation", "cost", "price", "prices", "economy", "budget"] },
  { id: "plants", title: "Plants", keywords: ["plant", "plants", "fruit", "seed", "seeds", "species", "grow", "growth", "stage"] },
  { id: "actions", title: "The eleven actions", keywords: ["action", "actions", "move", "observe", "query", "send", "broadcast", "absorb", "transfer", "recover", "wait", "message"] },
  { id: "skills", title: "Saved skills", keywords: ["skill", "skills", "program", "loop", "instruction", "block", "run_skill"] },
  { id: "upgrades", title: "Upgrades", keywords: ["upgrade", "upgrades", "improve", "attribute"] },
  { id: "conflict", title: "Attack, death, residue and absorption", keywords: ["attack", "fight", "kill", "killed", "death", "die", "died", "dead", "residue", "combat", "damage", "conflict"] },
  { id: "rounds", title: "Rounds and initiative", keywords: ["round", "rounds", "turn", "turns", "initiative", "order", "step"] },
  { id: "knowledge", title: "What agents know", keywords: ["know", "knowledge", "memory", "memories", "notebook", "packet", "context", "observation", "records", "believe"] },
  { id: "operator", title: "What you can do as the operator", keywords: ["operator", "control", "controls", "god", "mode", "intervention", "voice", "play", "pause", "stage", "edit", "continuation", "resume", "run"] },
  { id: "numbers", title: "Where the numbers come from", keywords: ["number", "numbers", "default", "defaults", "assumption", "assumptions", "config", "value"] },
];

/** Keyword-overlap search over DOC_SECTIONS (the drawer's answer when no model is available). */
export function searchDocSections(query: string, limit = 3): DocSectionHit[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return [];
  const hits: DocSectionHit[] = [];
  for (const section of DOC_SECTIONS) {
    let score = 0;
    for (const word of words) {
      if (section.keywords.includes(word)) score += 2;
      else if (section.keywords.some((k) => k.startsWith(word) || word.startsWith(k))) score += 1;
    }
    if (score > 0) hits.push({ id: section.id, title: section.title, score });
  }
  hits.sort((a, b) => b.score - a.score || DOC_SECTIONS.findIndex((s) => s.id === a.id) - DOC_SECTIONS.findIndex((s) => s.id === b.id));
  return hits.slice(0, limit);
}

/** Instructions-page section for a doc ref ("SYSTEM.md#economy" -> "resources"); null when no section fits. */
export function docSectionFor(ref: string): string | null {
  const slug = (ref.split("#")[1] ?? ref).toLowerCase();
  const table: [RegExp, string][] = [
    [/overview|brief|start|loop/, "overview"],
    [/world|terrain|region|map/, "world"],
    [/agent|stat|persona/, "agents"],
    [/econom|compute|essence|health|resource|upkeep|price/, "resources"],
    [/plant|fruit|seed|species/, "plants"],
    [/action|move|observe|absorb|transfer|message/, "actions"],
    [/skill/, "skills"],
    [/upgrade/, "upgrades"],
    [/attack|death|residue|combat|conflict|kill/, "conflict"],
    [/round|initiative|turn/, "rounds"],
    [/knowledge|memory|notebook|packet|context/, "knowledge"],
    [/operator|control|god|intervention|voice/, "operator"],
    [/number|default|assumption/, "numbers"],
  ];
  for (const [pattern, id] of table) if (pattern.test(slug)) return id;
  return null;
}
