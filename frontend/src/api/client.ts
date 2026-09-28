/**
 * Typed fetch wrappers for every backend route (see backend/empyrean/api.py).
 *
 * FROZEN after the architecture phase (rev 4 change: `request` is exported for
 * api/assistant.ts and api/story.ts, and listModels takes `includeAssistant`).  Base URL comes from VITE_API_BASE and
 * defaults to "" (same origin: the Vite dev server proxies /api to the backend,
 * see vite.config.ts).  Every function returns the parsed JSON body typed per
 * types.ts, or throws an ApiClientError carrying the HTTP status and the
 * backend's ApiError body (code, detail, problems).  The frontend never sees
 * credentials: GET /api/models only reports availability.
 *
 * Error handling contract for the UI:
 *   - `run_not_open` (409): call openRun(runId) and retry once (the backend restarted).
 *   - `invalid_setup` / `invalid_intervention` / `validation_error` (422): show
 *     `body.problems` next to the fields named by `path`.
 */

import type {
  AgentKnowledgeView,
  ApiError,
  ApiErrorCode,
  ApiProblem,
  AssumptionsView,
  CommandRequest,
  ContinuationRequest,
  DecisionPacketRecord,
  EffectiveSettingsView,
  Event,
  EventsResponse,
  HealthResponse,
  Intervention,
  MapState,
  ModelCallRecord,
  ModelInfo,
  PendingModelCallView,
  ReloadResponse,
  RulesConfig,
  RunCommand,
  RunArchiveFilter,
  RunCreateRequest,
  RunStatus,
  RunSummary,
  RunValidationResponse,
  StagedInterventionsResponse,
  TurnIndexEntry,
  TurnView,
  WorldPreviewRequest,
} from "./types";

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

/** Poll interval while a run is not paused (config.POLL_INTERVAL_MS). */
export const POLL_INTERVAL_MS = 700;
/** How far back the feed starts when a run is entered (config.INITIAL_FEED_WINDOW). */
export const INITIAL_FEED_WINDOW = 300;

export class ApiClientError extends Error {
  status: number;
  body: ApiError | null;

  constructor(status: number, message: string, body: ApiError | null) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.body = body;
  }

  get code(): ApiErrorCode | null {
    return this.body?.error ?? null;
  }

  get problems(): ApiProblem[] {
    return this.body?.problems ?? [];
  }
}

/** Keep proxy and gateway error pages out of UI messages while preserving short plain-text errors. */
export function httpFailureMessage(response: Response, text: string): string {
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  if (/text\/html/i.test(response.headers.get("content-type") ?? "") || /<(!doctype|html)\b/i.test(text)) {
    return `${status}: The connection to the server was interrupted. Try again.`;
  }
  const plain = text.replace(/\s+/g, " ").trim();
  return plain ? `${status}: ${plain.slice(0, 180)}${plain.length > 180 ? "…" : ""}` : `${status}: Request failed. Try again.`;
}

function locToPath(loc: unknown[]): string {
  // FastAPI loc ["body", "agents", 2, "position"] -> "agents[2].position"
  let path = "";
  for (const part of loc) {
    if (part === "body") continue;
    if (typeof part === "number") path += `[${part}]`;
    else path += path ? `.${String(part)}` : String(part);
  }
  return path;
}

/**
 * JSON request helper shared by every route wrapper (exported so api/assistant.ts and
 * api/story.ts reuse the same error handling).  `body` is JSON-encoded when given; a
 * non-2xx answer throws ApiClientError; 204 resolves to undefined.
 */
export async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method, headers: {}, signal };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    let parsed: ApiError | null = null;
    let text = "";
    try {
      text = await response.text();
      const json = JSON.parse(text) as Record<string, unknown>;
      if (typeof json.error === "string") {
        parsed = {
          error: json.error as ApiErrorCode,
          detail: (json.detail as string | null) ?? null,
          problems: Array.isArray(json.problems) ? (json.problems as ApiProblem[]) : [],
        };
      } else if (Array.isArray(json.detail)) {
        // Raw FastAPI validation body (only if the backend handler did not run)
        const problems = (json.detail as { loc?: unknown[]; msg?: string }[]).map((d) => ({
          path: locToPath(d.loc ?? []),
          message: d.msg ?? "invalid",
        }));
        parsed = { error: "validation_error", detail: problems.map((p) => `${p.path}: ${p.message}`).join("; "), problems };
      } else if (json.detail !== undefined) {
        parsed = { error: response.status === 404 ? "not_found" : "internal_error", detail: String(json.detail), problems: [] };
      }
    } catch {
      // non-JSON body; fall through with text
    }
    const message = parsed
      ? `${parsed.error}${parsed.detail ? `: ${parsed.detail}` : ""}`
      : httpFailureMessage(response, text);
    throw new ApiClientError(response.status, message, parsed);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Global
// ---------------------------------------------------------------------------

export function getHealth(): Promise<HealthResponse> {
  return request("GET", "/api/health");
}

/** Default RunCreateRequest with `agentCount` (6..64, default 8) prefilled agent cards. */
export function getDefaults(agentCount = 8): Promise<RunCreateRequest> {
  return request("GET", `/api/defaults?agent_count=${agentCount}`);
}

/** Configured model routes with availability; never contains secrets.  Assistant-only refs are left out unless `includeAssistant`. */
export function listModels(includeAssistant = false): Promise<ModelInfo[]> {
  return request("GET", includeAssistant ? "/api/models?include_assistant=1" : "/api/models");
}

/** The ASSUMPTIONS registry defaults (read-only). */
export function getAssumptions(): Promise<AssumptionsView> {
  return request("GET", "/api/assumptions");
}

/** Terrain a seed + world config would generate (no run created). */
export function previewWorld(body: WorldPreviewRequest): Promise<MapState> {
  return request("POST", "/api/world/preview", body);
}

// ---------------------------------------------------------------------------
// Runs / sessions
// ---------------------------------------------------------------------------

/** Saved runs, newest first.  `archived`: "0" active only (default), "1" the archive, "all". */
export function listRuns(archived: RunArchiveFilter = "0"): Promise<RunSummary[]> {
  const query = archived === "0" ? "" : `?archived=${archived}`;
  return request("GET", `/api/runs${query}`);
}

/** Hide a run from the default list (writes <run>/archive.json; idempotent). */
export function archiveRun(runId: string): Promise<RunSummary> {
  return request("POST", `/api/runs/${enc(runId)}/archive`);
}

/** Bring an archived run back to the default list (idempotent). */
export function unarchiveRun(runId: string): Promise<RunSummary> {
  return request("POST", `/api/runs/${enc(runId)}/unarchive`);
}

/** Remove the run folder permanently (204).  409 run_in_use while the run is open somewhere. */
export function deleteRun(runId: string): Promise<void> {
  return request("DELETE", `/api/runs/${enc(runId)}`);
}

/** Original saved creation setup for a new world; never opens or modifies the source run. */
export function getRunSetup(runId: string): Promise<RunCreateRequest> {
  return request("GET", `/api/runs/${enc(runId)}/setup`);
}

/** Every setup problem at once, nothing created (inline form feedback). */
export function validateRun(body: RunCreateRequest): Promise<RunValidationResponse> {
  return request("POST", "/api/runs/validate", body);
}

/** New session: validates (422 invalid_setup with problems), saves the initial checkpoint, opens paused. */
export function createRun(body: RunCreateRequest): Promise<RunSummary> {
  return request("POST", "/api/runs", body);
}

/** Resume session: recovers the run dir, loads the latest complete checkpoint into the runner, paused. */
export function openRun(runId: string): Promise<RunStatus> {
  return request("POST", `/api/runs/${enc(runId)}/open`);
}

/** Pause and stop the worker (call when leaving a run so a live-provider run cannot keep spending). */
export function closeRun(runId: string): Promise<RunStatus> {
  return request("POST", `/api/runs/${enc(runId)}/close`);
}

export function getRun(runId: string): Promise<RunSummary> {
  return request("GET", `/api/runs/${enc(runId)}`);
}

/** The assumptions recorded for this run at creation. */
export function getRunAssumptions(runId: string): Promise<AssumptionsView> {
  return request("GET", `/api/runs/${enc(runId)}/assumptions`);
}

export function getStatus(runId: string, signal?: AbortSignal): Promise<RunStatus> {
  return request("GET", `/api/runs/${enc(runId)}/status`, undefined, signal);
}

/** run_turn | play | pause | step_round.  409 illegal_command when not allowed for the current state. */
export function sendCommand(runId: string, command: RunCommand): Promise<RunStatus> {
  const body: CommandRequest = { command };
  return request("POST", `/api/runs/${enc(runId)}/commands`, body);
}

/** Live feed: events with seq > since (poll every ~700ms while not paused). */
export function getEvents(runId: string, since = 0, limit = 500, signal?: AbortSignal): Promise<EventsResponse> {
  return request("GET", `/api/runs/${enc(runId)}/events?since=${since}&limit=${limit}`, undefined, signal);
}

/** Live view of the last committed checkpoint (live=true). */
export function getLiveState(runId: string, signal?: AbortSignal): Promise<TurnView> {
  return request("GET", `/api/runs/${enc(runId)}/state`, undefined, signal);
}

/** The in-flight model call while waiting_model (404 not_found otherwise). */
export function getPendingModelCall(runId: string, signal?: AbortSignal): Promise<PendingModelCallView> {
  return request("GET", `/api/runs/${enc(runId)}/pending_model_call`, undefined, signal);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function listTurns(runId: string, fromRound?: number, toRound?: number): Promise<TurnIndexEntry[]> {
  const params = new URLSearchParams();
  if (fromRound !== undefined) params.set("from_round", String(fromRound));
  if (toRound !== undefined) params.set("to_round", String(toRound));
  const query = params.toString();
  return request("GET", `/api/runs/${enc(runId)}/turns${query ? `?${query}` : ""}`);
}

/** Full checkpoint view for a committed turn (live=false).  turnId "live" reads the runner. */
export function getTurn(runId: string, turnId: string): Promise<TurnView> {
  return request("GET", `/api/runs/${enc(runId)}/turns/${enc(turnId)}`);
}

export function getTurnEvents(runId: string, turnId: string): Promise<Event[]> {
  return request("GET", `/api/runs/${enc(runId)}/turns/${enc(turnId)}/events`);
}

export function getTurnKnowledge(runId: string, turnId: string, agentId: string): Promise<AgentKnowledgeView> {
  return request("GET", `/api/runs/${enc(runId)}/turns/${enc(turnId)}/agents/${enc(agentId)}/knowledge`);
}

export function getModelCall(runId: string, turnId: string, callId: string): Promise<ModelCallRecord> {
  return request("GET", `/api/runs/${enc(runId)}/turns/${enc(turnId)}/model_calls/${enc(callId)}`);
}

export function getDecisionPacket(runId: string, turnId: string, packetId: string): Promise<DecisionPacketRecord> {
  return request("GET", `/api/runs/${enc(runId)}/turns/${enc(turnId)}/decision_packets/${enc(packetId)}`);
}

/** Live knowledge of one agent (last committed checkpoint), with the believed self state. */
export function getLiveKnowledge(runId: string, agentId: string): Promise<AgentKnowledgeView> {
  return request("GET", `/api/runs/${enc(runId)}/agents/${enc(agentId)}/knowledge`);
}

// ---------------------------------------------------------------------------
// Settings, rules, god mode
// ---------------------------------------------------------------------------

export function getSettings(runId: string): Promise<EffectiveSettingsView> {
  return request("GET", `/api/runs/${enc(runId)}/settings`);
}

export function getRules(runId: string): Promise<RulesConfig> {
  return request("GET", `/api/runs/${enc(runId)}/rules`);
}

export function listInterventions(runId: string): Promise<StagedInterventionsResponse> {
  return request("GET", `/api/runs/${enc(runId)}/interventions`);
}

/** Stage a god-mode intervention (422 invalid_intervention with problems); applied at the next turn boundary. */
export function stageIntervention(runId: string, intervention: Intervention): Promise<StagedInterventionsResponse> {
  return request("POST", `/api/runs/${enc(runId)}/interventions`, intervention);
}

export function unstageIntervention(runId: string, interventionId: string): Promise<StagedInterventionsResponse> {
  return request("DELETE", `/api/runs/${enc(runId)}/interventions/${enc(interventionId)}`);
}

/** Literal god mode: validate working/ files and stage them as a 'file' intervention (paused/error/finished only). */
export function reloadWorking(runId: string): Promise<ReloadResponse> {
  return request("POST", `/api/runs/${enc(runId)}/working/reload`);
}

/** Editable continuation from a recorded turn; returns the new run (opened paused). */
export function createContinuation(runId: string, body: ContinuationRequest): Promise<RunSummary> {
  return request("POST", `/api/runs/${enc(runId)}/continuations`, body);
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

export interface EventPoller {
  stop(): void;
}

/**
 * Poll /events every `intervalMs` (default 700) and deliver new events and the
 * status to `onUpdate`.  Continues polling while paused (cheap) so status
 * changes from other clients are seen; callers may stop() when leaving a run.
 *
 * Epoch handling: when `status.feed_epoch` changes (the worker restarted) or
 * `latest_seq < since` (seqs were reissued), the cursor is reset to
 * max(0, latest_seq - INITIAL_FEED_WINDOW) and `onReset` is called so the UI can
 * drop uncommitted feed lines before the replacement events arrive.
 * Callers pass `initialSince` = max(0, status.latest_seq - INITIAL_FEED_WINDOW)
 * when entering a long run so the feed reaches "live" in one request.
 */
export function pollEvents(
  runId: string,
  onUpdate: (events: Event[], status: RunStatus) => void,
  onError?: (error: unknown) => void,
  intervalMs = POLL_INTERVAL_MS,
  initialSince = 0,
  onReset?: (status: RunStatus) => void,
): EventPoller {
  let since = initialSince;
  let epoch: string | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();

  const tick = async () => {
    if (stopped) return;
    try {
      const response = await getEvents(runId, since, 500, controller.signal);
      if (stopped) return;
      const status = response.status;
      const epochChanged = epoch !== null && status.feed_epoch !== epoch;
      const rewound = response.latest_seq < since;
      epoch = status.feed_epoch;
      if (epochChanged || rewound) {
        since = Math.max(0, response.latest_seq - INITIAL_FEED_WINDOW);
        if (onReset) onReset(status);
        onUpdate([], status);
      } else {
        if (response.events.length > 0) since = response.events[response.events.length - 1].seq;
        else if (response.latest_seq > since) since = response.latest_seq;
        onUpdate(response.events, status);
      }
    } catch (error) {
      if (!stopped && onError) onError(error);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();

  return {
    stop() {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    },
  };
}
