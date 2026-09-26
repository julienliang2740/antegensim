/**
 * Typed fetch wrappers for the assistant routes (backend/empyrean/assistant/routes.py),
 * reusing client.ts's `request` so errors arrive as ApiClientError with the
 * backend's ApiError body (assistant_unavailable 503, conversation_busy 409,
 * brief_not_pending 409, assistant_budget_exhausted 409, ...).
 *
 * DOCS: chat is asynchronous: postMessage answers 202 with a job id and the
 * drawer polls getConversation every 700 ms while the job runs; approveBrief
 * executes the typed action server-side and returns the stored effect
 * (idempotent on a retry).  Audio upload lives in api/assistantSpeech.ts (WP4).
 */

import { request } from "./client";
import type {
  AssistantCapabilities,
  AssistantRunSettingsUpdate,
  AssistantRunSettingsView,
  BriefApproveRequest,
  BriefRejectRequest,
  BriefResponse,
  ConversationCreateRequest,
  ConversationMeta,
  ConversationPatchRequest,
  ConversationView,
  JobView,
  MessageAccepted,
  MessageCreateRequest,
} from "./assistantTypes";

const enc = encodeURIComponent;
const BASE = "/api/assistant";

/** Which models and speech are available, plus the budgets of the scope (`runId` or global). */
export function getAssistantCapabilities(runId?: string | null, signal?: AbortSignal): Promise<AssistantCapabilities> {
  return request("GET", `${BASE}/capabilities${runId ? `?run_id=${enc(runId)}` : ""}`, undefined, signal);
}

/** Conversations of a scope (run id, or the global scope with null); `all` lists every scope. */
export function listConversations(runId: string | null, all = false): Promise<ConversationMeta[]> {
  const params = new URLSearchParams();
  if (runId) params.set("run_id", runId);
  if (all) params.set("all", "true");
  const query = params.toString();
  return request("GET", `${BASE}/conversations${query ? `?${query}` : ""}`);
}

export function createConversation(body: ConversationCreateRequest): Promise<ConversationMeta> {
  return request("POST", `${BASE}/conversations`, body);
}

/** The transcript with briefs and the running job (poll while `job` is queued/running). */
export function getConversation(convId: string, signal?: AbortSignal): Promise<ConversationView> {
  return request("GET", `${BASE}/conversations/${enc(convId)}`, undefined, signal);
}

/** Rename or rebind a conversation. */
export function patchConversation(convId: string, body: ConversationPatchRequest): Promise<ConversationMeta> {
  return request("PATCH", `${BASE}/conversations/${enc(convId)}`, body);
}

/** 409 conversation_busy while a job runs. */
export function deleteConversation(convId: string): Promise<void> {
  return request("DELETE", `${BASE}/conversations/${enc(convId)}`).then(() => undefined);
}

/** 202: the engine answers on its executor; poll getConversation. 409 conversation_busy when a job is pending. */
export function postMessage(convId: string, body: MessageCreateRequest): Promise<MessageAccepted> {
  return request("POST", `${BASE}/conversations/${enc(convId)}/messages`, body);
}

/** Asks the engine to stop after the current step. */
export function cancelJob(convId: string, jobId: string): Promise<JobView> {
  return request("POST", `${BASE}/conversations/${enc(convId)}/jobs/${enc(jobId)}/cancel`);
}

/** Executes the brief's typed action server-side (CAS pending->executing, revalidation); 409 brief_not_pending. */
export function approveBrief(convId: string, briefId: string, body: BriefApproveRequest): Promise<BriefResponse> {
  return request("POST", `${BASE}/conversations/${enc(convId)}/briefs/${enc(briefId)}/approve`, body);
}

export function rejectBrief(convId: string, briefId: string, body: BriefRejectRequest): Promise<BriefResponse> {
  return request("POST", `${BASE}/conversations/${enc(convId)}/briefs/${enc(briefId)}/reject`, body);
}

/** Per-run assistant settings (storybook auto, budgets) with the run's spend. */
export function getAssistantSettings(runId: string): Promise<AssistantRunSettingsView> {
  return request("GET", `/api/runs/${enc(runId)}/assistant/settings`);
}

/** Raise or lower the run's limits directly (no brief needed). */
export function putAssistantSettings(runId: string, body: AssistantRunSettingsUpdate): Promise<AssistantRunSettingsView> {
  return request("PUT", `/api/runs/${enc(runId)}/assistant/settings`, body);
}
