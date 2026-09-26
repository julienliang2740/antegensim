/**
 * DictateButton (rev 4, amended D9; OWNER: WP4): speech to text for a composer.
 *
 * Press "Dictate" to record, press again (or Enter/Space on the focused button) to stop; the
 * clip is sent raw to POST /api/assistant/transcribe and the text is handed to `onText`, which
 * inserts it into the composer.  It NEVER sends the message.  Recording stops by itself at the
 * capability's max_seconds (60 s) with a visible countdown; Escape cancels a recording (window
 * capture listener with stopPropagation, so the drawer, RecordViewer and MapView do not also
 * react).  The button is enabled only on a secure page (localhost / HTTPS) with
 * navigator.mediaDevices + MediaRecorder and speech status "ready"; otherwise it stays focusable
 * with aria-disabled and its tooltip says why ("open via localhost", "speech model loading",
 * "speech unavailable").  Effects clean up (tracks stopped, timers cleared, upload aborted) on
 * unmount and are StrictMode-safe (a session counter makes late callbacks no-ops).
 */
// DOCS: control label "Dictate" (mic icon); press to start / press to stop; 60 s cap with
// countdown; "Transcribing… (about N s)"; Escape cancels a recording; text is inserted, never sent.

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import {
  dictateBlockedReason,
  dictateErrorText,
  estimateTranscribeSeconds,
  formatClock,
  getSpeechSnapshot,
  pickRecordingMime,
  refreshSpeechCapability,
  subscribeSpeech,
  transcribeAudio,
  DEFAULT_SPEECH_LIMITS,
} from "../../api/assistantSpeech";
import { ApiClientError } from "../../api/client";
import { WorkingSpinner } from "../common/Working";
import "./dictate.css";

export interface DictateButtonProps {
  /** Receives the transcript (trimmed, non-empty); insert it into the composer. */
  onText(text: string): void;
  /** Blocks starting a recording with this tooltip (e.g. "Wait for the reply"); never stops one. */
  disabledReason?: string | null;
  /** The run on screen: its agent names prime Whisper's vocabulary. */
  runId?: string | null;
  /** Language code for Whisper ("en" default from capabilities; "auto" detects). */
  language?: string;
  /** Distinguishes two composers on one page, e.g. "Dictate to the story author". */
  ariaLabel?: string;
  /** Told when a recording starts/ends so a parent can route Escape (true while recording). */
  onRecordingChange?(active: boolean): void;
  className?: string;
}

type Phase = "idle" | "starting" | "recording" | "transcribing";

function environment() {
  const secureContext = typeof window !== "undefined" && window.isSecureContext === true;
  const canRecord =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined";
  return { secureContext, canRecord };
}

function micErrorText(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone blocked: allow microphone access for this site in the browser, then press Dictate again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found.";
  if (name === "NotReadableError") return "The microphone is in use by another application.";
  return `Could not start recording${err instanceof Error ? `: ${err.message}` : "."}`;
}

function MicIcon() {
  return (
    <svg className="dictate-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2.5M5.5 15h5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function DictateButton(props: DictateButtonProps) {
  const { onText, disabledReason, runId, language, ariaLabel, onRecordingChange, className } = props;
  const cap = useSyncExternalStore(subscribeSpeech, getSpeechSnapshot, getSpeechSnapshot);
  const env = environment();
  const blocked = dictateBlockedReason(env, cap, disabledReason);
  const maxSeconds = cap?.max_seconds ?? DEFAULT_SPEECH_LIMITS.max_seconds;
  const maxBytes = cap?.max_bytes ?? DEFAULT_SPEECH_LIMITS.max_bytes;

  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [estimate, setEstimate] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  // True when `message` is the blocked reason shown after a click; it disappears once unblocked.
  const [messageIsBlock, setMessageIsBlock] = useState(false);
  const [announce, setAnnounce] = useState("");
  const reasonId = useId();

  const sessionRef = useRef(0);
  const mountedRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef(0);
  // Latest props for callbacks that outlive a render (recorder.onstop, fetch).
  const latest = useRef({ onText, runId, language, maxSeconds, maxBytes, model: cap?.model ?? "" });
  useEffect(() => {
    latest.current = { onText, runId, language, maxSeconds, maxBytes, model: cap?.model ?? "" };
  });

  const clearTimers = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const releaseMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  /** Drop everything in flight: late callbacks of this session become no-ops. */
  const teardown = useCallback(() => {
    sessionRef.current += 1;
    clearTimers();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // already stopped
      }
    }
    releaseMic();
    abortRef.current?.abort();
    abortRef.current = null;
  }, [clearTimers, releaseMic]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardown();
    };
  }, [teardown]);

  const recordingActive = phase === "starting" || phase === "recording";
  useEffect(() => {
    onRecordingChange?.(recordingActive);
  }, [recordingActive, onRecordingChange]);

  const upload = useCallback(async (blob: Blob, seconds: number, session: number) => {
    const { maxBytes: capBytes, model, runId: rid, language: lang } = latest.current;
    if (blob.size === 0) {
      setPhase("idle");
      setMessage("Nothing was recorded; check the microphone and try again.");
      return;
    }
    if (blob.size > capBytes) {
      setPhase("idle");
      setMessage("The recording is too large; record a shorter clip.");
      return;
    }
    const eta = estimateTranscribeSeconds(seconds, model);
    setEstimate(eta);
    setPhase("transcribing");
    setAnnounce(`Transcribing, about ${eta} seconds.`);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await transcribeAudio(blob, { language: lang, runId: rid ?? null, signal: controller.signal });
      if (session !== sessionRef.current || !mountedRef.current) return;
      const text = result.text.trim();
      if (result.status === "ok" && text) {
        latest.current.onText(text);
        setMessage(null);
        setAnnounce("Dictated text inserted. Review it, then send.");
      } else if (result.status === "ok") {
        setMessage("No speech was recognised; try again a little closer to the microphone.");
        setAnnounce("No speech was recognised.");
      } else {
        const text2 = `Could not transcribe${result.error ? `: ${result.error}` : "."}`;
        setMessage(text2);
        setAnnounce(text2);
      }
    } catch (err) {
      if (session !== sessionRef.current || !mountedRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      const text = dictateErrorText(err);
      setMessage(text);
      setAnnounce(text);
      if (err instanceof ApiClientError && err.code === "assistant_unavailable") void refreshSpeechCapability();
    } finally {
      if (session === sessionRef.current && mountedRef.current) {
        abortRef.current = null;
        setPhase("idle");
      }
    }
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    clearTimers();
    if (recorder && recorder.state !== "inactive") {
      recorder.stop(); // onstop uploads
    }
  }, [clearTimers]);

  const start = useCallback(async () => {
    setMessage(null);
    teardown();
    const session = sessionRef.current;
    setPhase("starting");
    setElapsed(0);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      if (session !== sessionRef.current || !mountedRef.current) return;
      setPhase("idle");
      const text = micErrorText(err);
      setMessage(text);
      setAnnounce(text);
      return;
    }
    if (session !== sessionRef.current || !mountedRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    streamRef.current = stream;
    const mime = pickRecordingMime(typeof MediaRecorder.isTypeSupported === "function" ? (t) => MediaRecorder.isTypeSupported(t) : undefined);
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    } catch (err) {
      releaseMic();
      setPhase("idle");
      setMessage(micErrorText(err));
      return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      // Tracks off as soon as the recording ends (the browser's mic indicator goes away).
      if (streamRef.current === stream) releaseMic();
      else stream.getTracks().forEach((track) => track.stop());
      if (session !== sessionRef.current || !mountedRef.current) return; // cancelled
      recorderRef.current = null;
      const seconds = (performance.now() - startedAtRef.current) / 1000;
      const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
      void upload(blob, seconds, session);
    };
    try {
      recorder.start(1000);
    } catch (err) {
      releaseMic();
      setPhase("idle");
      setMessage(micErrorText(err));
      return;
    }
    recorderRef.current = recorder;
    startedAtRef.current = performance.now();
    setPhase("recording");
    setAnnounce("Recording. Press Dictate again to stop, Escape to cancel.");
    tickRef.current = setInterval(() => {
      const secs = (performance.now() - startedAtRef.current) / 1000;
      setElapsed(secs);
      if (secs >= latest.current.maxSeconds) {
        setAnnounce(`Stopped at the ${latest.current.maxSeconds} second limit.`);
        stop();
      }
    }, 250);
  }, [releaseMic, stop, teardown, upload]);

  const cancel = useCallback(() => {
    teardown();
    setPhase("idle");
    setElapsed(0);
    setMessage(null);
    setAnnounce("Dictation cancelled.");
  }, [teardown]);

  // Escape cancels a recording before anything else sees the key (drawer close, RecordViewer,
  // MapView all listen later); only while a recording is starting or running.
  useEffect(() => {
    if (!recordingActive) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingActive, cancel]);

  const onClick = () => {
    if (phase === "recording") {
      stop();
      return;
    }
    if (phase !== "idle") return; // starting / transcribing: ignore extra presses
    if (blocked) {
      setMessage(blocked);
      setMessageIsBlock(true);
      return;
    }
    setMessageIsBlock(false);
    void start();
  };

  const remaining = Math.max(0, Math.ceil(maxSeconds - elapsed));
  let content: ReactNode;
  let title: string;
  if (phase === "recording") {
    content = (
      <>
        <span className="dictate-dot" aria-hidden="true" />
        <span>Stop</span>
        <span className="dictate-clock">{formatClock(elapsed)}</span>
        <span className={remaining <= 10 ? "dictate-left dictate-left-low" : "dictate-left"}>({remaining} s left)</span>
      </>
    );
    title = `Recording: press to stop and transcribe (stops by itself after ${maxSeconds} s). Escape cancels.`;
  } else if (phase === "starting") {
    content = (
      <>
        <MicIcon />
        <span>Starting…</span>
      </>
    );
    title = "Waiting for the microphone. Escape cancels.";
  } else if (phase === "transcribing") {
    content = (
      <>
        <WorkingSpinner />
        <span>Transcribing… (about {estimate} s)</span>
      </>
    );
    title = "Turning your recording into text; it will be inserted into the message box, not sent.";
  } else {
    content = (
      <>
        <MicIcon />
        <span>Dictate</span>
      </>
    );
    title =
      blocked ??
      `Dictate: press to record (up to ${maxSeconds} s), press again to stop. The text is inserted into the message box; you send it yourself.` +
        (cap?.reason ? ` Note: ${cap.reason}.` : "");
  }

  const isBlocked = phase === "idle" && blocked !== null;
  // A blocked reason shown after a click follows the live reason (and vanishes once ready).
  const shownMessage = messageIsBlock ? (isBlocked ? blocked : null) : message;
  const busy = phase === "starting" || phase === "transcribing";
  const classes = ["btn", "btn-small", "dictate-btn"];
  if (phase === "recording") classes.push("dictate-recording");
  if (className) classes.push(className);

  return (
    <span className="dictate">
      <button
        type="button"
        className={classes.join(" ")}
        onClick={onClick}
        aria-pressed={phase === "recording"}
        aria-disabled={isBlocked || busy ? true : undefined}
        aria-busy={busy || undefined}
        aria-label={phase === "idle" ? ariaLabel ?? "Dictate" : undefined}
        aria-describedby={isBlocked || shownMessage ? reasonId : undefined}
        title={title}
        data-control="dictate"
        data-phase={phase}
      >
        {content}
      </button>
      {shownMessage ? (
        <span id={reasonId} className="dictate-message">
          {shownMessage}
        </span>
      ) : isBlocked ? (
        <span id={reasonId} className="dictate-sr-only">
          {blocked}
        </span>
      ) : null}
      <span className="dictate-sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </span>
  );
}

export default DictateButton;
