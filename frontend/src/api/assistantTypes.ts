/**
 * Assistant API types: a TypeScript mirror of backend/empyrean/assistant/models.py
 * (chat, briefs, conversations, jobs, per-run settings, ledger, capabilities).
 *
 * Conventions follow api/types.ts: snake_case fields exactly as Pydantic names
 * them, `X | null` for Optional, string-literal unions instead of enums.
 * Storybook and Story Mode shapes live in api/storyTypes.ts (WP6).
 *
 * DOCS: every shape here is data the backend owns; the drawer never derives
 * authority from model prose.  Brief.action is the TYPED action (validated
 * server-side) the card's "What will happen" section is rendered from.
 */

import type { ApiProblem, Intervention, ModelUsage, RunCommand, RunStatus, RunSummary, TranscriptionResult } from "./types";

export type Profile = "chat" | "narrator" | "author" | "summarizer";

// ---------------------------------------------------------------------------
// References and chat steps
// ---------------------------------------------------------------------------

export type RefKind = "turn" | "entity" | "point" | "run" | "doc" | "control";

/** A linkable reference in an answer: turn id, entity id, "x,y" point, run id, doc section ("SYSTEM.md#economy") or control label. */
export interface AnswerRef {
  kind: RefKind;
  id: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Brief actions (typed, validated server-side)
// ---------------------------------------------------------------------------

export type BriefActionType = "create_run" | "run_command" | "stage_interventions" | "create_continuation" | "open_run" | "update_assistant_settings";

/** The Intervention union minus apply_working_files; ids and origin are set by the executor. */
export type AssistantIntervention = Exclude<Intervention, { type: "apply_working_files" }>;

export interface CreateRunAction {
  type: "create_run";
  name: string;
  agent_count: number;
  /** Partial RunCreateRequest deep-merged onto the defaults (dicts merge, everything else replaces). */
  overlay: Record<string, unknown>;
}

export interface RunCommandAction {
  type: "run_command";
  run_id: string;
  command: RunCommand;
  /** 1-50, only with step_round: approval runs a backend sequencer job. */
  rounds: number | null;
}

export interface StageInterventionsAction {
  type: "stage_interventions";
  run_id: string;
  interventions: AssistantIntervention[];
}

export interface CreateContinuationAction {
  type: "create_continuation";
  run_id: string;
  from_turn_id: string;
  name: string | null;
}

/** UI-only: the drawer navigates; nothing executes server-side. */
export interface OpenRunAction {
  type: "open_run";
  run_id: string;
}

export interface UpdateAssistantSettingsAction {
  type: "update_assistant_settings";
  run_id: string;
  storybook_auto: boolean | null;
  chat_budget_usd: number | null;
  storybook_budget_usd: number | null;
}

export type BriefAction = CreateRunAction | RunCommandAction | StageInterventionsAction | CreateContinuationAction | OpenRunAction | UpdateAssistantSettingsAction;

// ---------------------------------------------------------------------------
// Brief lifecycle (stored)
// ---------------------------------------------------------------------------

export type BriefStatus = "pending" | "executing" | "executed" | "failed" | "rejected" | "superseded" | "invalid";

/** A non-default field of a create_run request (computed by the backend). */
export interface SetupDiffEntry {
  path: string;
  default: unknown;
  value: unknown;
}

export interface BriefValidation {
  ok: boolean;
  problems: ApiProblem[];
  /** Budget clear, paid model, spend so far, ... */
  warnings: string[];
  setup_diff: SetupDiffEntry[];
  validated_against_turn_id: string | null;
  validated_at: string | null;
}

/** What an approved brief did (stored on the brief; returned by approve, idempotent). */
export interface BriefEffect {
  run_id: string | null;
  run_summary: RunSummary | null;
  status: RunStatus | null;
  staged_ids: string[];
  rounds_done: number | null;
  rounds_requested: number | null;
  message: string;
  executed_at: string | null;
}

export interface Brief {
  brief_id: string;
  conversation_id: string;
  /** The assistant message carrying the card. */
  message_id: string;
  /** The user's message text ("Proposed in reply to"). */
  in_reply_to: string;
  created_at: string;
  updated_at: string;
  status: BriefStatus;
  title: string;
  summary: string;
  steps: string[];
  warnings: string[];
  /** Typed BriefAction (normalised); null when invalid. */
  action: BriefAction | null;
  /** The model's envelope as emitted ({type, args}). */
  action_raw: Record<string, unknown>;
  validation: BriefValidation;
  effect: BriefEffect | null;
  error: string | null;
  superseded_by: string | null;
  reject_reason: string;
}

export interface BriefApproveRequest {
  validated_against_turn_id: string | null;
}

export interface BriefRejectRequest {
  reason: string;
}

export interface BriefResponse {
  brief: Brief;
}

// ---------------------------------------------------------------------------
// Conversations, messages, jobs
// ---------------------------------------------------------------------------

/** What the user is looking at (built from state/assistantContext.ts). */
export interface ContextChip {
  page: string;
  run_id: string | null;
  run_name: string | null;
  shown_turn_id: string | null;
  live_turn_id: string | null;
  tab: string | null;
  selected_entity_id: string | null;
  selected_entity_kind: string | null;
  /** "x,y" */
  selected_point: string | null;
  run_state: string | null;
  last_error: string | null;
  story_id: string | null;
}

export type MessageRole = "user" | "assistant";
export type MessageStatus = "pending" | "running" | "done" | "error" | "cancelled" | "interrupted";

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  truncated: boolean;
  error: string | null;
}

/** One model call of a chat message. */
export interface StepRecord {
  index: number;
  /** answer | tool | ask | brief | repair */
  kind: string;
  model_key: string;
  /** pending | ok | error | cancelled */
  status: string;
  started_at: string;
  finished_at: string | null;
  elapsed_ms: number;
  cost_usd: number;
  cache_read_tokens: number;
  tool_calls: ToolCallRecord[];
  error: string | null;
  error_code: string | null;
}

export type ModelErrorCode = "budget_exceeded" | "rate_limited" | "schema_mismatch" | "cancelled" | "timeout" | "not_logged_in" | "cli_missing";

export interface Message {
  message_id: string;
  role: MessageRole;
  text: string;
  created_at: string;
  updated_at: string;
  status: MessageStatus;
  /** User messages: the chip sent along. */
  context: ContextChip | null;
  /** Assistant messages: one record per model call. */
  steps: StepRecord[];
  refs: AnswerRef[];
  /** "turns r00003_t02_a05", "docs SYSTEM.md#economy" */
  sources: string[];
  as_of_turn_id: string | null;
  brief_id: string | null;
  ask_options: string[];
  job_id: string | null;
  /** Live progress line while running ("Reading round 12"). */
  progress: string | null;
  cost_usd: number;
  error: string | null;
  error_code: string | null;
  /** Answered from docs search because no model was available. */
  offline: boolean;
}

export interface ProfileSpend {
  calls: number;
  cost_usd: number;
}

export interface LedgerAggregate {
  calls: number;
  ok_calls: number;
  failed_calls: number;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  cost_usd: number;
  estimated_cost_usd: number;
  by_profile: Record<string, ProfileSpend>;
}

export interface ConversationMeta {
  conversation_id: string;
  /** Mutable: rebound after create_run / open_run (null = global scope). */
  run_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
  summary: string;
  summary_through_message_id: string | null;
  message_count: number;
  usage: LedgerAggregate;
  active_job_id: string | null;
  last_brief_id: string | null;
}

export type JobKind = "chat" | "story" | "storybook" | "speech" | "sequencer";
export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";

export interface JobView {
  job_id: string;
  kind: JobKind;
  status: JobStatus;
  conversation_id: string | null;
  run_id: string | null;
  story_id: string | null;
  queue_position: number;
  queued_behind: string | null;
  step: number;
  max_steps: number;
  elapsed_s: number;
  cost_usd: number;
  progress: string;
  cancel_requested: boolean;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  error_code: string | null;
}

export interface ConversationView {
  meta: ConversationMeta;
  messages: Message[];
  briefs: Brief[];
  job: JobView | null;
}

export interface ConversationCreateRequest {
  run_id: string | null;
  title?: string | null;
}

export interface ConversationPatchRequest {
  title?: string | null;
  run_id?: string | null;
  rebind_to_global?: boolean;
}

export interface MessageCreateRequest {
  text: string;
  context?: ContextChip | null;
  include_context?: boolean;
  /** "Ask for changes" on a brief (it gets superseded). */
  in_reply_to_brief_id?: string | null;
}

/** 202 body of POST .../messages. */
export interface MessageAccepted {
  job_id: string;
  /** The pending assistant message. */
  message_id: string;
  user_message_id: string;
  conversation_id: string;
  queue_position: number;
}

// ---------------------------------------------------------------------------
// Per-run settings and budgets
// ---------------------------------------------------------------------------

export interface AssistantRunSettings {
  storybook_auto: boolean;
  auto_since_turn_id: string | null;
  storybook_budget_usd: number;
  chat_budget_usd: number;
  updated_at: string;
}

export interface AssistantRunSettingsUpdate {
  storybook_auto?: boolean | null;
  storybook_budget_usd?: number | null;
  chat_budget_usd?: number | null;
}

export interface BudgetView {
  /** run id | "global" | "story:<id>" | "message" */
  scope: string;
  /** chat | storybook | story | message | global */
  kind: string;
  limit_usd: number;
  spent_usd: number;
  remaining_usd: number;
  exhausted: boolean;
}

export interface SpendView {
  chat: BudgetView;
  storybook: BudgetView | null;
  overall: BudgetView;
  by_profile: Record<string, ProfileSpend>;
}

export interface AssistantRunSettingsView {
  run_id: string;
  /** False: no settings.json yet (existing run; auto is off). */
  exists: boolean;
  settings: AssistantRunSettings;
  spend: SpendView;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface ProfileCapability {
  profile: string;
  model_key: string;
  available: boolean;
  fake: boolean;
  reason: string | null;
}

export interface SpeechCapability {
  status: "ready" | "loading" | "unavailable" | "disabled";
  model: string;
  reason: string | null;
  max_seconds: number;
  max_bytes: number;
  language_default: string;
}

export interface AssistantCapabilities {
  /** At least the chat profile can be called. */
  available: boolean;
  auto_live_allowed: boolean;
  models: ProfileCapability[];
  speech: SpeechCapability;
  budgets: SpendView;
  max_steps: number;
  message_timeout_seconds: number;
  version: string;
}

export type { TranscriptionResult, ModelUsage };
