/**
 * "Dictate" API (rev 4, amended D9; OWNER: WP4).
 *
 * - `transcribeAudio(blob, opts)`: POST /api/assistant/transcribe with the RAW recorded blob as
 *   the body (no multipart; Content-Type is the blob's type, e.g. "audio/webm;codecs=opus").
 *   Errors throw the shared `ApiClientError` from api/client.ts with the backend's ApiError body:
 *   413 payload_too_large, 409 assistant_busy, 503 assistant_unavailable, 422 validation_error.
 *   A 200 always carries a TranscriptionResult; `status: "error"` means this clip failed.
 * - `fetchSpeechCapability()`: GET /api/assistant/capabilities and return its `speech` part
 *   (a 503 from a backend without the assistant maps to status "unavailable").
 * - A tiny shared store (`subscribeSpeech` / `getSpeechSnapshot` / `refreshSpeechCapability` /
 *   `setSpeechCapability`) so every Dictate button shares one capability and one poll: while the
 *   model is "loading" it re-polls every SPEECH_POLL_MS as long as a button is mounted.  The
 *   drawer may push the capability it already fetched with `setSpeechCapability`.
 */
// DOCS: Dictate uploads the raw MediaRecorder blob; capability status ready|loading|unavailable|disabled
// gates the button; 10 MB / 60 s caps come from capabilities.speech (max_bytes, max_seconds).

import { API_BASE, ApiClientError, request } from "./client";
import type { ApiError, ApiErrorCode, ApiProblem, TranscriptionResult } from "./types";

/** capabilities.speech (backend assistant/models.py SpeechCapability). */
export interface SpeechCapability {
  status: "ready" | "loading" | "unavailable" | "disabled";
  model: string;
  reason: string | null;
  max_seconds: number;
  max_bytes: number;
  language_default: string;
}

/** Re-poll interval while the speech model is loading. */
export const SPEECH_POLL_MS = 3000;

export const DEFAULT_SPEECH_LIMITS = { max_seconds: 60, max_bytes: 10_000_000, language_default: "en" } as const;

export interface TranscribeOptions {
  /** 2-3 letter code, "auto" to detect; default "en" on the server. */
  language?: string;
  /** The run on screen: its agent names prime Whisper's vocabulary. */
  runId?: string | null;
  /** Overrides the server-built prompt (rarely needed). */
  initialPrompt?: string;
  signal?: AbortSignal;
}

async function errorFromResponse(response: Response): Promise<ApiClientError> {
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
    }
  } catch {
    // non-JSON body (proxy error page): keep the text
  }
  const message = parsed
    ? `${parsed.error}${parsed.detail ? `: ${parsed.detail}` : ""}`
    : `${response.status} ${response.statusText} ${text}`.trim();
  return new ApiClientError(response.status, message, parsed);
}

/** POST /api/assistant/transcribe with the raw audio blob as the body. */
export async function transcribeAudio(audio: Blob, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
  const params = new URLSearchParams();
  if (opts.language) params.set("language", opts.language);
  if (opts.runId) params.set("run_id", opts.runId);
  if (opts.initialPrompt) params.set("initial_prompt", opts.initialPrompt);
  const query = params.toString();
  const response = await fetch(`${API_BASE}/api/assistant/transcribe${query ? `?${query}` : ""}`, {
    method: "POST",
    headers: { "Content-Type": audio.type || "audio/webm" },
    body: audio,
    signal: opts.signal,
  });
  if (!response.ok) throw await errorFromResponse(response);
  return (await response.json()) as TranscriptionResult;
}

/** GET /api/assistant/capabilities -> `.speech`.  Never throws for a backend without the assistant. */
export async function fetchSpeechCapability(signal?: AbortSignal): Promise<SpeechCapability> {
  try {
    const caps = await request<{ speech: SpeechCapability }>("GET", "/api/assistant/capabilities", undefined, signal);
    return caps.speech;
  } catch (err) {
    if (err instanceof ApiClientError) {
      return {
        status: "unavailable",
        model: "",
        reason: err.code === "assistant_unavailable" ? "the assistant is not running in this backend" : err.message,
        ...DEFAULT_SPEECH_LIMITS,
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shared capability store (one fetch and one poll for every mounted Dictate button)
// ---------------------------------------------------------------------------

let snapshot: SpeechCapability | null = null;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function schedulePoll(): void {
  if (pollTimer !== null || listeners.size === 0) return;
  if (snapshot?.status !== "loading") return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void refreshSpeechCapability();
  }, SPEECH_POLL_MS);
}

/** Current capability; null until the first fetch answers. */
export function getSpeechSnapshot(): SpeechCapability | null {
  return snapshot;
}

/** Replace the shared capability (the drawer pushes the one it already fetched). */
export function setSpeechCapability(next: SpeechCapability): void {
  const same =
    snapshot !== null &&
    snapshot.status === next.status &&
    snapshot.model === next.model &&
    snapshot.reason === next.reason &&
    snapshot.max_seconds === next.max_seconds &&
    snapshot.max_bytes === next.max_bytes &&
    snapshot.language_default === next.language_default;
  if (!same) {
    snapshot = next;
    emit();
  }
  schedulePoll();
}

/** Fetch the capability once (concurrent callers share the request). */
export function refreshSpeechCapability(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetchSpeechCapability()
    .then((cap) => setSpeechCapability(cap))
    .catch(() => {
      // network down: report unavailable, retry on the next subscribe
      setSpeechCapability({ status: "unavailable", model: "", reason: "the backend is not reachable", ...DEFAULT_SPEECH_LIMITS });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** useSyncExternalStore subscribe: the first subscriber triggers a fetch; polling stops with the last. */
export function subscribeSpeech(listener: () => void): () => void {
  listeners.add(listener);
  if (snapshot === null || snapshot.status === "loading" || snapshot.status === "unavailable") {
    void refreshSpeechCapability();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Pure helpers used by components/assistant/DictateButton.tsx
// ---------------------------------------------------------------------------

/** MediaRecorder types in preference order (webm/opus first; Safari records audio/mp4). */
export const RECORDING_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"] as const;

/** First recording type this browser supports; undefined lets the browser pick. */
export function pickRecordingMime(isTypeSupported: ((type: string) => boolean) | undefined): string | undefined {
  if (!isTypeSupported) return undefined;
  return RECORDING_MIME_CANDIDATES.find((type) => {
    try {
      return isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

/**
 * Rough wall-clock seconds the server needs for a clip (CPU int8; measured on this host:
 * large-v3-turbo ~4-7 s for an 11 s clip, medium ~6 s, small ~3 s), never below 2.
 */
export function estimateTranscribeSeconds(audioSeconds: number, model: string): number {
  const name = model.toLowerCase();
  const factor = name.includes("small") || name.includes("base") || name.includes("tiny") ? 0.3 : name.includes("medium") ? 0.55 : 0.6;
  return Math.max(2, Math.ceil(1.5 + factor * Math.max(0, audioSeconds)));
}

/** Environment facts the Dictate button gates on (injected so the rule stays pure). */
export interface DictateEnvironment {
  secureContext: boolean;
  canRecord: boolean;
}

/**
 * Why Dictate cannot start right now, or null when it can.  Order: the caller's own reason,
 * insecure page, no recorder, then the speech capability (checking / loading / unavailable / disabled).
 */
export function dictateBlockedReason(env: DictateEnvironment, cap: SpeechCapability | null, callerReason?: string | null): string | null {
  if (callerReason) return callerReason;
  if (!env.secureContext) {
    return "Dictate needs a secure page: open via localhost (for example http://localhost:5173) or HTTPS. The browser only allows the microphone there.";
  }
  if (!env.canRecord) return "This browser cannot record audio here (no microphone access or MediaRecorder).";
  if (cap === null) return "Checking whether speech is available…";
  switch (cap.status) {
    case "ready":
      return null;
    case "loading":
      return "Speech model loading: Dictate will be ready in a few seconds.";
    case "disabled":
      return `Speech unavailable: Dictate is turned off on the server${cap.reason ? ` (${cap.reason})` : ""}.`;
    default:
      return `Speech unavailable${cap.reason ? `: ${cap.reason}` : ""}.`;
  }
}

/** "0:07" style clock for the recording timer. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** User-facing text for a failed transcription (ApiClientError codes, TranscriptionResult errors). */
export function dictateErrorText(err: unknown): string {
  if (err instanceof ApiClientError) {
    const detail = err.body?.detail ? ` (${err.body.detail})` : "";
    switch (err.code) {
      case "assistant_busy":
        return "Speech is busy with other clips; try again in a few seconds.";
      case "payload_too_large":
        return "The recording is too large; record a shorter clip.";
      case "assistant_unavailable":
        return `Speech unavailable${detail}.`;
      case "validation_error":
        return `The server rejected the recording${detail}.`;
      default:
        return `Transcription failed: ${err.message}`;
    }
  }
  if (err instanceof Error) return `Transcription failed: ${err.message}`;
  return "Transcription failed.";
}
