/**
 * TypeScript mirrors of the Storybook and Story Mode API shapes
 * (backend/empyrean/assistant/models.py, rev 4; OWNER WP6).
 *
 * DOCS: self-contained on purpose: the Storybook tab and the Story Mode page
 * depend only on this file and api/story.ts, not on the drawer's
 * api/assistantTypes.ts, so the few shared shapes (BudgetView, SpendView,
 * JobView, Message, AssistantRunSettings) are mirrored here too.  Keep the
 * field names identical to models.py; stored records are LooseModel on the
 * backend, so optional fields may be absent on old files (typed `?`).
 */

import type { ModelUsage } from "./types";

// ---------------------------------------------------------------- budgets, jobs, settings

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

export interface ProfileSpend {
  calls: number;
  cost_usd: number;
}

export interface SpendView {
  chat: BudgetView;
  storybook: BudgetView | null;
  overall: BudgetView;
  by_profile: Record<string, ProfileSpend>;
}

export interface AssistantRunSettings {
  storybook_auto: boolean;
  auto_since_turn_id: string | null;
  storybook_budget_usd: number;
  chat_budget_usd: number;
  updated_at: string;
}

export interface AssistantRunSettingsUpdate {
  storybook_auto?: boolean;
  storybook_budget_usd?: number;
  chat_budget_usd?: number;
}

export interface AssistantRunSettingsView {
  run_id: string;
  /** False: no settings.json yet (an existing run; auto is off). */
  exists: boolean;
  settings: AssistantRunSettings;
  spend: SpendView;
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
  /** 'Queued behind "The Arena" (ch 40/285)' */
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

export type MessageRole = "user" | "assistant";
export type MessageStatus = "pending" | "running" | "done" | "error" | "cancelled" | "interrupted";

/** One interview message (the subset of models.Message Story Mode shows). */
export interface StoryMessage {
  message_id: string;
  role: MessageRole;
  text: string;
  created_at: string;
  updated_at?: string;
  status: MessageStatus;
  ask_options?: string[];
  progress?: string | null;
  cost_usd?: number;
  error?: string | null;
  error_code?: string | null;
  offline?: boolean;
}

// ---------------------------------------------------------------- storybook

export type StorybookEntryKind = "opening" | "turn" | "round_end";
export type StorybookAutoState = "on" | "off" | "paused_budget" | "paused_error";

export interface StorybookEntry {
  /** "opening" for the opening entry. */
  turn_id: string;
  kind: StorybookEntryKind;
  round: number;
  text: string;
  model_key: string;
  response_model?: string | null;
  usage?: ModelUsage;
  cost_usd: number;
  created_at: string;
  digest_sha?: string;
  batch_id?: string | null;
  regenerated?: number;
  /** Entity ids the entry mentions (drives "Following <name>"). */
  entities?: string[];
}

export interface StorybookEstimate {
  entries: number;
  calls: number;
  cost_usd: number;
  seconds: number;
  model_key: string;
}

export interface StorybookStatus {
  run_id: string;
  auto: boolean;
  auto_state: StorybookAutoState;
  auto_since_turn_id: string | null;
  /** Queued for the job (eligible, not yet written). */
  pending_count: number;
  in_flight: boolean;
  /** Committed turns without an entry that auto will not cover ("Write missing"). */
  missing_count: number;
  estimate: StorybookEstimate;
  spend: BudgetView;
  /** Visible pause notice. */
  notice: string | null;
  last_error: string | null;
  entry_count: number;
  has_opening: boolean;
}

export interface StorybookView {
  status: StorybookStatus;
  opening: StorybookEntry | null;
  /** Commit order. */
  entries: StorybookEntry[];
}

export interface StorybookGenerateRequest {
  /** null = every missing entry (+ the opening). */
  turn_ids?: string[] | null;
  include_opening?: boolean;
}

export interface StorybookGenerateResponse {
  job_id: string | null;
  queued: number;
  status: StorybookStatus;
}

// ---------------------------------------------------------------- story mode

export type StoryStatus = "interviewing" | "brief_pending" | "generating" | "paused" | "complete" | "cancelled" | "error" | "interrupted";
export type ChapterUnit = "turn" | "round";
export type StoryPovValue = "chronicler" | "follow";
export type BriefStatus = "pending" | "executing" | "executed" | "failed" | "rejected" | "superseded" | "invalid";
export type ChapterKind = "chapter" | "interlude" | "opening" | "epilogue";

export interface StoryQuickPicks {
  genre: string;
  tone: string;
  /** 1..5 */
  vividness: number;
  pov: StoryPovValue;
  follow_agent_id: string | null;
  /** null = the first turn. */
  from_turn_id: string | null;
  /** null = the last committed turn. */
  to_turn_id: string | null;
  unit: ChapterUnit;
  language: string;
}

export interface CastMember {
  agent_id: string;
  name: string;
  persona: string;
  alive: boolean;
  model_key: string | null;
  kills: number;
  died_turn_id: string | null;
}

/** Deterministic step 0 of the interview (no model call). */
export interface StoryRunCard {
  run_id: string;
  name: string;
  world_id: string;
  cast: CastMember[];
  rounds: number;
  turns: number;
  deaths: number;
  kills: number;
  highlights: string[];
  first_turn_id: string;
  last_turn_id: string;
  /** {world_id, run_id, turn_id} for continuations. */
  parent: Record<string, unknown> | null;
  suggested: StoryQuickPicks;
}

export interface CastMapping {
  agent_id: string;
  story_name: string;
  role: string;
}

export interface ChapterPlanEntry {
  number: number;
  kind: ChapterKind;
  turn_ids: string[];
  title: string;
}

export interface StoryEstimate {
  unit: ChapterUnit;
  chapters: number;
  cost_usd: number;
  seconds: number;
}

export interface StoryBrief {
  brief_id: string;
  status: BriefStatus;
  created_at: string;
  title: string;
  premise: string;
  style_guide: string;
  cast_map: CastMapping[];
  faithful: string[];
  embellished: string[];
  picks: StoryQuickPicks;
  /** For the chosen unit. */
  chapter_plan: ChapterPlanEntry[];
  estimate_turn: StoryEstimate | null;
  estimate_round: StoryEstimate | null;
  job_budget_usd: number;
  in_reply_to: string;
}

export interface StoryChapter {
  number: number;
  kind: ChapterKind;
  title: string;
  text: string;
  turn_ids: string[];
  status: "pending" | "running" | "done" | "error";
  model_key: string;
  response_model?: string | null;
  usage?: ModelUsage;
  cost_usd: number;
  created_at: string;
  error: string | null;
}

export interface StorySession {
  story_id: string;
  run_id: string;
  created_at: string;
  updated_at: string;
  status: StoryStatus;
  title: string;
  picks: StoryQuickPicks;
  /** The interview. */
  messages: StoryMessage[];
  brief: StoryBrief | null;
  superseded_briefs: StoryBrief[];
  unit: ChapterUnit;
  chapters_total: number;
  chapters_done: number;
  /** Chapters are generated 3 ahead of this. */
  reader_position: number;
  generate_all: boolean;
  /** Pinned end for a story over a running run. */
  end_turn_id: string | null;
  cast_sheet: string;
  story_so_far: string;
  job_budget_usd: number;
  spent_usd: number;
  job_id: string | null;
  error: string | null;
}

export type StoryListFilter = "all" | "unfinished" | "finished";

export interface StorySessionSummary {
  story_id: string;
  run_id: string;
  run_name: string; // the run's display name (filled by the cross-run listing; "" per run)
  title: string;
  status: StoryStatus;
  unit: ChapterUnit;
  chapters_done: number;
  chapters_total: number;
  spent_usd: number;
  created_at: string;
  updated_at: string;
}

export interface StoryView {
  session: StorySession;
  /** Done chapters, in order. */
  chapters: StoryChapter[];
  job: JobView | null;
  run_card: StoryRunCard | null;
}

export interface StoryCreateRequest {
  picks?: StoryQuickPicks | null;
  /** Free text of step 0; "" = just the picks. */
  text?: string;
}

export interface StoryMessageRequest {
  text: string;
  /** Changed chips. */
  picks?: StoryQuickPicks | null;
}

export interface StoryApproveRequest {
  brief_id: string;
  unit: ChapterUnit;
  generate_all: boolean;
  job_budget_usd?: number | null;
}

export interface StoryRejectRequest {
  reason: string;
}

export interface StoryContinueRequest {
  /** null = the last committed turn. */
  to_turn_id: string | null;
  /** true = "Generate all": write every remaining chapter instead of 3 ahead of the reader (default false). */
  generate_all?: boolean;
}

export interface StoryExport {
  title: string;
  markdown: string;
}
