/**
 * Fetch wrappers for the Storybook and Story Mode routes
 * (backend/empyrean/assistant/routes_storybook.py, routes_story.py and the
 * per-run settings route in routes.py).  OWNER: WP6.
 *
 * DOCS: every function reuses client.ts `request` (same ApiClientError
 * contract).  None of these routes opens a run: the storybook and stories of
 * a closed run can be read, and the only calls that spend money are
 * generateStorybook / regenerateStorybookEntry (narrator), createStory /
 * sendStoryMessage (author brief), approveStory / generateAllChapters /
 * continueStory (chapter job; the last two share the continue route) and getStoryChapter (moves the reader, which
 * lets the job write up to 3 chapters ahead).
 */

import { request } from "./client";
import type {
  AssistantRunSettingsUpdate,
  AssistantRunSettingsView,
  StorybookGenerateRequest,
  StorybookGenerateResponse,
  StorybookView,
  StoryApproveRequest,
  StoryChapter,
  StoryContinueRequest,
  StoryCreateRequest,
  StoryExport,
  StoryMessageRequest,
  StoryListFilter,
  StorySessionSummary,
  StoryView,
} from "./storyTypes";

const enc = encodeURIComponent;
const runBase = (runId: string) => `/api/runs/${enc(runId)}/assistant`;
const storyBase = (runId: string, storyId: string) => `${runBase(runId)}/stories/${enc(storyId)}`;

// ---------------------------------------------------------------- per-run assistant settings

/** GET /api/runs/{run_id}/assistant/settings: storybook auto flag, budgets and spend. */
export function getRunAssistantSettings(runId: string): Promise<AssistantRunSettingsView> {
  return request("GET", `${runBase(runId)}/settings`);
}

/** PUT /api/runs/{run_id}/assistant/settings: switch storybook auto on/off or raise a budget (direct control, no brief). */
export function updateRunAssistantSettings(runId: string, body: AssistantRunSettingsUpdate): Promise<AssistantRunSettingsView> {
  return request("PUT", `${runBase(runId)}/settings`, body);
}

// ---------------------------------------------------------------- storybook

/** GET .../storybook: read-only (never enqueues); status carries pending/missing counts and the Write-missing estimate. */
export function getStorybook(runId: string, lastN?: number, signal?: AbortSignal): Promise<StorybookView> {
  return request("GET", `${runBase(runId)}/storybook${lastN ? `?last_n=${lastN}` : ""}`, undefined, signal);
}

/** POST .../storybook/generate: "Write missing" (all missing entries + the opening unless turn_ids is given).  Spends. */
export function generateStorybook(runId: string, body: StorybookGenerateRequest = {}): Promise<StorybookGenerateResponse> {
  return request("POST", `${runBase(runId)}/storybook/generate`, body);
}

/** POST .../storybook/entries/{turn_id}/regenerate ("opening" for the opening entry).  Spends. */
export function regenerateStorybookEntry(runId: string, turnId: string): Promise<StorybookGenerateResponse> {
  return request("POST", `${runBase(runId)}/storybook/entries/${enc(turnId)}/regenerate`);
}

// ---------------------------------------------------------------- story mode

/** GET /api/assistant/stories?status=: every run's stories, most recently updated first (never opens a run). */
export function listAllStories(status: StoryListFilter = "all", signal?: AbortSignal): Promise<StorySessionSummary[]> {
  return request("GET", `/api/assistant/stories?status=${status}`, undefined, signal);
}

export function listStories(runId: string): Promise<StorySessionSummary[]> {
  return request("GET", `${runBase(runId)}/stories`);
}

/** POST .../stories: a new session with the deterministic run card (step 0). */
export function createStory(runId: string, body: StoryCreateRequest = {}): Promise<StoryView> {
  return request("POST", `${runBase(runId)}/stories`, body);
}

export function getStory(runId: string, storyId: string, signal?: AbortSignal): Promise<StoryView> {
  return request("GET", storyBase(runId, storyId), undefined, signal);
}

/** Step-0 submission or "Change" follow-up: the author writes a (new) brief; an older pending brief is superseded. */
export function sendStoryMessage(runId: string, storyId: string, body: StoryMessageRequest): Promise<StoryView> {
  return request("POST", `${storyBase(runId, storyId)}/messages`, body);
}

/** Accept the brief: starts the chapter job (lazy, 3 ahead of the reader, unless generate_all). */
export function approveStory(runId: string, storyId: string, body: StoryApproveRequest): Promise<StoryView> {
  return request("POST", `${storyBase(runId, storyId)}/approve`, body);
}

/** Cancel the brief (the session stays, nothing is generated). */
export function rejectStory(runId: string, storyId: string, reason = ""): Promise<StoryView> {
  return request("POST", `${storyBase(runId, storyId)}/reject`, { reason });
}

/** Stop the chapter job after the current chapter. */
export function cancelStory(runId: string, storyId: string): Promise<StoryView> {
  return request("POST", `${storyBase(runId, storyId)}/cancel`);
}

/**
 * "Generate all": write every remaining chapter instead of 3 ahead of the reader.
 * Same route as "Continue story" (POST .../stories/{story_id}/continue) with
 * {to_turn_id: null, generate_all: true}: the job keeps its end turn and stops
 * waiting for the reader.
 */
export function generateAllChapters(runId: string, storyId: string): Promise<StoryView> {
  return request("POST", `${storyBase(runId, storyId)}/continue`, { to_turn_id: null, generate_all: true } satisfies StoryContinueRequest);
}

/** "Continue story": extend a story pinned to an end turn over turns committed since. */
export function continueStory(runId: string, storyId: string, body: StoryContinueRequest = { to_turn_id: null }): Promise<StoryView> {
  return request("POST", `${storyBase(runId, storyId)}/continue`, body);
}

/** One chapter; markRead moves the reader position (the job then writes up to 3 chapters ahead). */
export function getStoryChapter(runId: string, storyId: string, number: number, markRead = true): Promise<StoryChapter> {
  return request("GET", `${storyBase(runId, storyId)}/chapters/${number}?mark_read=${markRead ? "true" : "false"}`);
}

/** The whole story as Markdown (done chapters only). */
export function exportStory(runId: string, storyId: string): Promise<StoryExport> {
  return request("GET", `${storyBase(runId, storyId)}/export`);
}
