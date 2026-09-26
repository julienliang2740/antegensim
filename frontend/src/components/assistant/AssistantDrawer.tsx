/**
 * The assistant drawer (amended D5/D6/D11): rendered once by App.tsx as a
 * sibling after the page, so it survives route changes and RunPage remounts
 * with its conversation intact.
 *
 * - Placement: a fixed right panel (width 360-720 px, resizable, remembered
 *   under localStorage "empyrean.assistant.v1" with the Dock/Float choice).  On
 *   the run page at >= 1280 px and docked, the run page reserves the same
 *   width (state/assistantContext.dockReserve) so nothing is covered; otherwise
 *   the panel floats over the page with no backdrop.  The launcher is the
 *   bottom-right pill on .page routes (hidden while open) and the rail-header
 *   button on the run page; Alt+A toggles from anywhere.
 * - Conversations: per scope (this run, or Home); the last one per scope is
 *   remembered; a page change never switches conversation while the drawer is
 *   open (after an approved create_run/open_run the backend rebinds the same
 *   conversation to the new run and the drawer follows with "Now about").
 * - Chat: POST message -> 202 job -> poll GET conversation every 700 ms while
 *   the job runs; progress "step k/4 · Ns · $x" with Cancel; answers carry refs
 *   that act through the run page's registered handlers; brief cards approve
 *   server-side and apply the returned RunStatus at once.
 * - Errors: one fixed table (state/assistantBrief.errorGuidance).  When the
 *   model is offline the backend answers from docs search ("Docs search (AI
 *   offline)"); when the assistant service is absent (503, or 404 from an
 *   older backend) the composer is disabled with a link to the docs page.
 * - Accessibility: role=complementary, final answers announced through an
 *   aria-live=polite region, focus to the composer on open and back to the
 *   launcher on close, Ctrl/Cmd+Enter sends, Escape (handled on the panel with
 *   stopPropagation, only when no recording is active) closes.
 *
 * DOCS: control labels "Assistant", "Dock"/"Float", "Send", "Dictate", "Approve:
 * <effect>", "Ask for changes", "Cancel", "Open in setup form instead".
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { approveBrief, cancelJob, createConversation, deleteConversation, getAssistantCapabilities, getConversation, listConversations, patchConversation, postMessage, rejectBrief } from "../../api/assistant";
import type { AssistantCapabilities, Brief, ConversationMeta, ConversationView, JobView, Message } from "../../api/assistantTypes";
import { setSpeechCapability } from "../../api/assistantSpeech";
import { ApiClientError } from "../../api/client";
import type { Route } from "../../hooks/useHashRoute";
import { navigate } from "../../hooks/useHashRoute";
import { buildSuggestions, chipFromContext, docSectionFor, effectStatusFor, errorGuidance, quoteBrief, requiresOnScreenRun, scopeRunId, searchDocSections } from "../../state/assistantBrief";
import type { DocSectionHit, ErrorAction, ErrorGuidance } from "../../state/assistantBrief";
import {
  DRAWER_MAX_W,
  DRAWER_MIN_W,
  clampDrawerWidth,
  contextChipText,
  dockReserve,
  getDrawerState,
  getHandlers,
  getSnapshot,
  publishContext,
  setDrawerState,
  subscribe,
  subscribeAsk,
  subscribeDrawer,
  takeLastAsk,
} from "../../state/assistantContext";
import type { AssistantStatus } from "../../state/assistantContext";
import { errorText } from "../../state/runSessions";
import { SETUP_DRAFT_KEY } from "../../state/setupForm";
import type { SetupDraft } from "../../state/setupForm";
import type { RefAction } from "./AnswerBlocks";
import { Composer } from "./Composer";
import { ConversationPicker } from "./ConversationPicker";
import { LauncherPill } from "./Launcher";
import { MessageList } from "./MessageList";
import { SpendIndicator } from "./SpendPopover";
import "../../assistant.css";

export interface AssistantDrawerProps {
  /** The current hash route (App.tsx passes useHashRoute()). */
  route: Route;
}

const PREFS_KEY = "empyrean.assistant.v1";
const POLL_MS = 700;
const GLOBAL_KEY = "global";

interface Prefs {
  docked: boolean;
  width: number;
  lastConversation: Record<string, string>;
  language: string;
}

const DEFAULT_PREFS: Prefs = { docked: true, width: 400, lastConversation: {}, language: "en" };

function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      docked: typeof parsed.docked === "boolean" ? parsed.docked : true,
      width: clampDrawerWidth(typeof parsed.width === "number" ? parsed.width : DEFAULT_PREFS.width),
      lastConversation: parsed.lastConversation && typeof parsed.lastConversation === "object" ? parsed.lastConversation : {},
      language: typeof parsed.language === "string" ? parsed.language : "en",
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage blocked: the preferences live for this page only.
  }
}

/** The API error code of a failure, treating a 404 from an older backend without assistant routes as "assistant_unavailable". */
function apiCode(error: unknown): string | null {
  if (!(error instanceof ApiClientError)) return null;
  if (error.status === 404 && error.code === "not_found") return "assistant_unavailable";
  if (error.status === 503) return "assistant_unavailable";
  return error.code;
}

function guidanceFor(error: unknown): ErrorGuidance {
  if (error instanceof ApiClientError) return errorGuidance(null, apiCode(error), error.body?.detail ?? error.message);
  return errorGuidance(null, null, error instanceof Error ? error.message : String(error));
}

function jobActive(view: ConversationView | null): boolean {
  if (!view) return false;
  if (view.job && (view.job.status === "queued" || view.job.status === "running")) return true;
  return view.messages.some((m) => m.role === "assistant" && (m.status === "pending" || m.status === "running"));
}

function statusFromCapabilities(cap: AssistantCapabilities): AssistantStatus {
  if (!cap.available) return "offline";
  const chat = cap.models.find((m) => m.profile === "chat");
  return chat?.fake ? "fake" : "ready";
}

function byUpdated(a: ConversationMeta, b: ConversationMeta): number {
  return b.updated_at.localeCompare(a.updated_at);
}

function lastDoneAnswer(view: ConversationView | null): string {
  if (!view) return "";
  for (let i = view.messages.length - 1; i >= 0; i--) {
    const m = view.messages[i];
    if (m.role !== "assistant") continue;
    if (m.status === "done") return m.brief_id ? `Proposal ready: ${view.briefs.find((b) => b.brief_id === m.brief_id)?.title ?? ""}` : m.text.slice(0, 400);
    if (m.status === "error") return "The assistant could not answer.";
    return "";
  }
  return "";
}

function flashControl(id: string): boolean {
  const el = document.querySelector<HTMLElement>(`[data-control="${CSS.escape(id)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.classList.add("assistant-flash");
  window.setTimeout(() => el.classList.remove("assistant-flash"), 1600);
  return true;
}

export function AssistantDrawer(props: AssistantDrawerProps) {
  const ctx = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const drawer = useSyncExternalStore(subscribeDrawer, getDrawerState, getDrawerState);
  const scope = scopeRunId(ctx);
  const scopeKey = scope ?? GLOBAL_KEY;

  const prefsRef = useRef<Prefs | null>(null);
  const [language, setLanguage] = useState(() => loadPrefs().language);
  const [capabilities, setCapabilities] = useState<AssistantCapabilities | null>(null);
  const [capError, setCapError] = useState<ErrorGuidance | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [loadedView, setView] = useState<ConversationView | null>(null);
  // Only the selected conversation's transcript (derived instead of clearing the state from an effect).
  const view = convId && loadedView?.meta.conversation_id === convId ? loadedView : null;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pollNonce, setPollNonce] = useState(0);
  const [composer, setComposer] = useState("");
  const [includeContext, setIncludeContext] = useState(true);
  const [replyTo, setReplyTo] = useState<{ id: string; title: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<ErrorGuidance | null>(null);
  /** Client-side docs search shown when the assistant service itself is absent ("Docs search (AI offline)"). */
  const [localHits, setLocalHits] = useState<{ query: string; hits: DocSectionHit[] } | null>(null);
  const [busyBriefId, setBusyBriefId] = useState<string | null>(null);
  const [briefErrors, setBriefErrors] = useState<Record<string, string>>({});
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rebound, setRebound] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [innerWidth, setInnerWidth] = useState(() => window.innerWidth);
  const [spendOpenRequest, setSpendOpenRequest] = useState(0);
  /** The last auto-send ask request (numbered); sent once, as soon as no other send is in flight. */
  const [pendingSend, setPendingSend] = useState<{ seq: number; text: string } | null>(null);
  const sentSeq = useRef(0);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const activeRef = useRef(false);

  // ------------------------------------------------------------------ preferences
  useEffect(() => {
    const prefs = loadPrefs();
    prefsRef.current = prefs;
    setDrawerState({ docked: prefs.docked, width: prefs.width });
  }, []);
  useEffect(() => {
    const prefs = prefsRef.current;
    if (!prefs) return;
    if (prefs.docked === drawer.docked && prefs.width === drawer.width) return;
    prefsRef.current = { ...prefs, docked: drawer.docked, width: drawer.width };
    savePrefs(prefsRef.current);
  }, [drawer.docked, drawer.width]);
  const remember = useCallback((key: string, id: string | null) => {
    const prefs = prefsRef.current ?? loadPrefs();
    const last = { ...prefs.lastConversation };
    if (id) last[key] = id;
    else delete last[key];
    prefsRef.current = { ...prefs, lastConversation: last };
    savePrefs(prefsRef.current);
  }, []);

  // ------------------------------------------------------------------ window, clock, shortcut
  useEffect(() => {
    const onResize = () => setInnerWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "a" || event.key === "A")) {
        event.preventDefault();
        setDrawerState({ open: !getDrawerState().open });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const active = jobActive(view);
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active]);

  // ------------------------------------------------------------------ pages without their own context publisher
  // The run page, entry and new-session pages publish their own context; the rest is derived from the route
  // (a Story Mode page that publishes a richer context is left alone).
  useEffect(() => {
    const route = props.route;
    const snap = getSnapshot();
    if (route.name === "resume" || route.name === "instructions") publishContext({ page: route.name });
    else if (route.name === "story" && (snap.page !== "story" || snap.runId !== route.runId || snap.storyId !== route.storyId)) {
      publishContext({ page: "story", runId: route.runId, storyId: route.storyId });
    }
  }, [props.route]);

  // ------------------------------------------------------------------ capabilities (status dot, budgets, speech)
  const applyCapabilities = useCallback((cap: AssistantCapabilities) => {
    setCapabilities(cap);
    setCapError(null);
    setDrawerState({ status: statusFromCapabilities(cap) });
    setSpeechCapability(cap.speech);
  }, []);
  const applyCapabilitiesError = useCallback((error: unknown) => {
    setCapabilities(null);
    const code = apiCode(error);
    setCapError(guidanceFor(error));
    setDrawerState({ status: code === "assistant_unavailable" ? "unavailable" : "unknown" });
  }, []);
  const refreshCapabilities = useCallback(
    (runId: string | null): Promise<void> => getAssistantCapabilities(runId).then(applyCapabilities, applyCapabilitiesError),
    [applyCapabilities, applyCapabilitiesError],
  );
  useEffect(() => {
    // Refetched on a scope change and on every open; a reply for an older scope is dropped.
    let cancelled = false;
    getAssistantCapabilities(scope).then(
      (cap) => !cancelled && applyCapabilities(cap),
      (error: unknown) => !cancelled && applyCapabilitiesError(error),
    );
    return () => {
      cancelled = true;
    };
  }, [scope, applyCapabilities, applyCapabilitiesError, drawer.open]);

  // ------------------------------------------------------------------ conversations of the scope
  /** The scope's conversations, newest first; [] on failure (with the load error shown unless the service is absent). */
  const refreshList = useCallback(
    (runId: string | null): Promise<ConversationMeta[]> =>
      listConversations(runId).then(
        (list) => {
          const sorted = list.slice().sort(byUpdated);
          setConversations(sorted);
          setLoadError(null);
          return sorted;
        },
        (error: unknown) => {
          setConversations([]);
          if (apiCode(error) !== "assistant_unavailable") setLoadError(errorText(error));
          return [];
        },
      ),
    [],
  );
  useEffect(() => {
    if (!drawer.open) {
      wasOpen.current = false;
      return;
    }
    const fresh = !wasOpen.current;
    wasOpen.current = true;
    let cancelled = false;
    void refreshList(scope).then((list) => {
      if (cancelled) return;
      // A fresh open (or an empty drawer) picks the scope's remembered or newest conversation; a page change while open never switches.
      setConvId((current) => {
        if (current && !fresh) return current;
        const remembered = prefsRef.current?.lastConversation[scopeKey];
        if (remembered && list.some((c) => c.conversation_id === remembered)) return remembered;
        return list[0]?.conversation_id ?? null;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [drawer.open, scope, scopeKey, refreshList]);

  // ------------------------------------------------------------------ transcript polling
  useEffect(() => {
    if (!drawer.open || !convId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const next = await getConversation(convId);
        if (cancelled) return;
        setView(next);
        setLoadError(null);
        const nowActive = jobActive(next);
        if (activeRef.current && !nowActive) {
          // A job just finished: spend and titles may have changed.
          void refreshCapabilities(scopeRunId(getSnapshot()));
          void refreshList(scopeRunId(getSnapshot()));
          setCancelling(false);
        }
        activeRef.current = nowActive;
        if (nowActive) timer = setTimeout(() => void tick(), POLL_MS);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiClientError && error.status === 404 && error.code === "not_found" && convId) {
          // The conversation is gone (deleted elsewhere): forget it.
          remember(scopeKey, null);
          setConvId(null);
          return;
        }
        setLoadError(errorText(error));
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [drawer.open, convId, pollNonce, refreshCapabilities, refreshList, remember, scopeKey]);
  const bumpPoll = useCallback(() => setPollNonce((n) => n + 1), []);

  // ------------------------------------------------------------------ focus, ask requests, Escape
  const prevOpenRef = useRef(false);
  useEffect(() => {
    const wasOpenBefore = prevOpenRef.current;
    prevOpenRef.current = drawer.open;
    if (drawer.open) {
      const frame = requestAnimationFrame(() => textareaRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    if (wasOpenBefore) {
      // Closed: give focus back to the launcher that opened it.
      const launcher = document.querySelector<HTMLElement>('[data-control="assistant-launcher"]');
      launcher?.focus({ preventScroll: true });
    }
    return undefined;
  }, [drawer.open]);
  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);
  useEffect(() => {
    const handle = (request: { text: string; autoSend: boolean }) => {
      setDrawerState({ open: true });
      setComposer(request.text);
      setReplyTo(null);
      setSendError(null);
      if (request.autoSend) setPendingSend((prev) => ({ seq: (prev?.seq ?? 0) + 1, text: request.text }));
      focusComposer();
    };
    const pending = takeLastAsk();
    if (pending) handle(pending);
    return subscribeAsk(handle);
  }, [focusComposer]);

  const close = useCallback(() => setDrawerState({ open: false }), []);
  const onPanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || recording) return;
    event.stopPropagation();
    event.preventDefault();
    close();
  };

  // ------------------------------------------------------------------ sending
  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      setSending(true);
      setSendError(null);
      setLocalHits(null);
      setNotice(null);
      try {
        let id = convId;
        if (!id) {
          const meta = await createConversation({ run_id: scope });
          id = meta.conversation_id;
          setConvId(id);
          remember(scopeKey, id);
          setConversations((list) => [meta, ...list]);
        }
        const currentCtx = getSnapshot();
        await postMessage(id, {
          text: trimmed,
          context: includeContext ? chipFromContext(currentCtx) : null,
          include_context: includeContext,
          in_reply_to_brief_id: replyTo?.id ?? null,
        });
        setComposer("");
        setReplyTo(null);
        activeRef.current = true;
        bumpPoll();
      } catch (error) {
        setSendError(guidanceFor(error));
        if (apiCode(error) === "assistant_unavailable") setLocalHits({ query: trimmed, hits: searchDocSections(trimmed, 3) });
      } finally {
        setSending(false);
      }
    },
    [convId, scope, scopeKey, includeContext, replyTo, sending, remember, bumpPoll],
  );
  useEffect(() => {
    if (pendingSend === null || sending || pendingSend.seq <= sentSeq.current) return;
    sentSeq.current = pendingSend.seq;
    void send(pendingSend.text);
  }, [pendingSend, sending, send]);

  const onCancelJob = async (job: JobView) => {
    if (!convId) return;
    setCancelling(true);
    try {
      await cancelJob(convId, job.job_id);
    } catch (error) {
      setNotice(`Could not cancel: ${errorText(error)}`);
    }
  };

  // ------------------------------------------------------------------ conversations
  const selectConversation = (id: string) => {
    setConvId(id);
    setView(null);
    setReplyTo(null);
    setRebound(null);
    remember(scopeKey, id);
  };
  const newConversation = () => {
    setConvId(null);
    setView(null);
    setReplyTo(null);
    setRebound(null);
    remember(scopeKey, null);
    focusComposer();
  };
  const renameConversation = async (id: string, title: string) => {
    const meta = await patchConversation(id, { title });
    setConversations((list) => list.map((c) => (c.conversation_id === id ? meta : c)));
    setView((v) => (v && v.meta.conversation_id === id ? { ...v, meta } : v));
  };
  const removeConversation = async (id: string) => {
    await deleteConversation(id);
    setConversations((list) => list.filter((c) => c.conversation_id !== id));
    if (convId === id) {
      setConvId(null);
      setView(null);
      remember(scopeKey, null);
    }
  };

  // ------------------------------------------------------------------ briefs
  const setBriefError = (id: string, text: string | null) =>
    setBriefErrors((errors) => {
      const next = { ...errors };
      if (text) next[id] = text;
      else delete next[id];
      return next;
    });

  const approve = async (brief: Brief) => {
    const action = brief.action;
    if (!convId || !action) return;
    const needsRun = requiresOnScreenRun(action);
    const handlers = needsRun ? getHandlers(needsRun) : null;
    if (needsRun && !handlers) {
      navigate({ name: "run", runId: needsRun, turnId: null });
      return;
    }
    setBusyBriefId(brief.brief_id);
    setBriefError(brief.brief_id, null);
    handlers?.showError(null);
    handlers?.setInFlight(true);
    try {
      if (action.type === "open_run") {
        remember(action.run_id, convId);
        setRebound(action.run_id);
        navigate({ name: "run", runId: action.run_id, turnId: null });
      }
      const result = await approveBrief(convId, brief.brief_id, { validated_against_turn_id: brief.validation.validated_against_turn_id });
      const done = result.brief;
      // Any effect that carries a status for a run whose page is mounted (run commands, staged edits, ...) is applied at once,
      // so the run page's state and its staged-edit counts never wait for the next status poll.
      const shown = getSnapshot();
      const status = effectStatusFor(done.effect, needsRun ?? (shown.page === "run" ? shown.runId : null));
      const statusHandlers = status ? (handlers ?? getHandlers(status.run_id)) : null;
      if (status && statusHandlers) statusHandlers.applyStatus(status);
      if (done.status === "executed" && done.effect?.run_id && (action.type === "create_run" || action.type === "create_continuation")) {
        remember(done.effect.run_id, convId);
        setRebound(done.effect.run_summary?.name ?? done.effect.run_id);
        navigate({ name: "run", runId: done.effect.run_id, turnId: null });
      }
      if (done.status === "pending" && done.validation.problems.length > 0) setBriefError(brief.brief_id, "Re-checked at approval against the current state: problems were found (see above). Ask for changes.");
      if (done.status === "failed" && done.error) handlers?.showError(done.error);
      bumpPoll();
    } catch (error) {
      const text = guidanceFor(error).text;
      setBriefError(brief.brief_id, text);
      handlers?.showError(text);
      bumpPoll();
    } finally {
      handlers?.setInFlight(false);
      setBusyBriefId(null);
    }
  };
  const reject = async (brief: Brief, reason = "") => {
    if (!convId) return;
    setBusyBriefId(brief.brief_id);
    setBriefError(brief.brief_id, null);
    try {
      await rejectBrief(convId, brief.brief_id, { reason });
      if (replyTo?.id === brief.brief_id) setReplyTo(null);
      bumpPoll();
    } catch (error) {
      setBriefError(brief.brief_id, guidanceFor(error).text);
    } finally {
      setBusyBriefId(null);
    }
  };
  const askChanges = (brief: Brief) => {
    setReplyTo({ id: brief.brief_id, title: brief.title });
    setComposer(quoteBrief(brief.title));
    focusComposer();
  };
  const openInSetup = (brief: Brief) => {
    if (brief.action?.type !== "create_run") return;
    const draft: SetupDraft = {
      agent_count: brief.action.agent_count,
      partial: { name: brief.action.name, ...brief.action.overlay },
      source: brief.title,
    };
    try {
      window.sessionStorage.setItem(SETUP_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      setNotice("Could not hand the setup to the form (session storage is blocked).");
      return;
    }
    void reject(brief, "opened in the setup form instead");
    navigate({ name: "new" });
  };

  // ------------------------------------------------------------------ refs and links
  const onAction = (action: RefAction) => {
    const runId = ctx.runId;
    const handlers = getHandlers(runId);
    setNotice(null);
    switch (action.kind) {
      case "turn":
        if (handlers) handlers.viewTurn(action.turnId === ctx.liveTurnId ? null : action.turnId);
        else if (runId) navigate({ name: "run", runId, turnId: action.turnId });
        else setNotice("Open a run to view its turns.");
        return;
      case "call":
        if (handlers) handlers.openRecord({ kind: "call", turnId: action.turnId, callId: action.callId });
        else if (runId) navigate({ name: "run", runId, turnId: action.turnId });
        else setNotice("Open the run to view this model call.");
        return;
      case "entity":
        if (handlers) setNotice(handlers.selectEntity(action.entityId));
        else setNotice(`Open the run to select ${action.entityId}.`);
        return;
      case "point":
        if (handlers) setNotice(handlers.findPoint({ x: action.x, y: action.y }));
        else setNotice("Open the run to find points on its map.");
        return;
      case "run":
        navigate({ name: "run", runId: action.runId, turnId: null });
        return;
      case "doc":
        navigate({ name: "instructions", section: docSectionFor(action.ref) });
        return;
      case "control":
        if (!flashControl(action.id)) setNotice(`No control named "${action.id}" is on this page.`);
        return;
    }
  };
  const onErrorAction = (action: ErrorAction, _message: Message) => {
    if (action === "docs" || action === "login" || action === "install") navigate({ name: "instructions", section: action === "docs" ? null : "operator" });
    else if (action === "raise_limit") setSpendOpenRequest((n) => n + 1);
  };
  const openGodMode = (runId: string) => {
    const handlers = getHandlers(runId);
    if (handlers) handlers.setTab("god");
    else navigate({ name: "run", runId, turnId: null });
  };

  // ------------------------------------------------------------------ resizing
  const reserve = dockReserve(drawer, innerWidth, ctx.page);
  const docked = reserve > 0;
  const effectiveWidth = docked ? reserve : Math.min(drawer.width, innerWidth);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onResizeDown = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: event.clientX, startW: drawer.width };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-x");
  };
  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setDrawerState({ width: clampDrawerWidth(drag.startW + (drag.startX - event.clientX), innerWidth) });
  };
  const onResizeUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.classList.remove("is-resizing-x");
  };
  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") setDrawerState({ width: drawer.width + 20 });
    else if (event.key === "ArrowRight") setDrawerState({ width: drawer.width - 20 });
    else return;
    event.preventDefault();
  };

  // ------------------------------------------------------------------ derived
  const unavailable = capError !== null && capError.action === "docs" && capabilities === null;
  const offline = capabilities !== null && !capabilities.available;
  const runNames = useMemo(() => {
    const names: Record<string, string> = {};
    if (ctx.runId && ctx.runName) names[ctx.runId] = ctx.runName;
    for (const brief of view?.briefs ?? []) if (brief.effect?.run_id && brief.effect.run_summary?.name) names[brief.effect.run_id] = brief.effect.run_summary.name;
    return names;
  }, [ctx.runId, ctx.runName, view?.briefs]);
  const suggestions = useMemo(
    () => (!view || view.messages.length === 0 ? buildSuggestions(ctx, { available: capabilities?.available ?? true, selectedName: ctx.selectedEntityId }) : []),
    [ctx, view, capabilities?.available],
  );
  const scopeLabel = scope ? `This run: ${ctx.runName ?? scope}` : contextChipText(ctx);
  const convRunId = view?.meta.run_id ?? null;
  const convElsewhere = view !== null && convRunId !== scope;
  const announce = lastDoneAnswer(view);
  const currentTitle = view?.meta.title ?? conversations.find((c) => c.conversation_id === convId)?.title ?? null;
  const spend = capabilities?.budgets ?? null;

  return (
    <>
      {props.route.name !== "run" ? <LauncherPill /> : null}
      <div className="assistant-sr-only" aria-live="polite" aria-atomic="true">
        {drawer.open ? announce : ""}
      </div>
      {drawer.open ? (
        <aside
          ref={asideRef}
          className={`assistant-drawer${docked ? " assistant-drawer-docked" : " assistant-drawer-floating"}`}
          role="complementary"
          aria-label="Assistant"
          style={{ width: `${effectiveWidth}px` }}
          onKeyDown={onPanelKeyDown}
        >
          <div
            className="assistant-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the assistant"
            aria-valuemin={DRAWER_MIN_W}
            aria-valuemax={DRAWER_MAX_W}
            aria-valuenow={drawer.width}
            tabIndex={0}
            title="Drag to resize (360-720 px)"
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            onKeyDown={onResizeKey}
          />
          <header className="assistant-head">
            <div className="assistant-head-row">
              <strong className="assistant-title">
                <span aria-hidden="true">✦</span> Assistant
              </strong>
              <span className="assistant-scope-chip" title="The scope of this drawer: conversations belong to this run, or to Home">
                {scopeLabel}
              </span>
              <span className="assistant-head-spacer" />
              <SpendIndicator spend={spend} runId={scope} runName={ctx.runName} openRequest={spendOpenRequest} onChanged={() => void refreshCapabilities(scope)} />
              {ctx.page === "run" ? (
                <button
                  type="button"
                  className="btn btn-small"
                  aria-pressed={drawer.docked}
                  title={drawer.docked ? "Docked: the run page makes room for the drawer (from 1280 px wide). Click to float over the page." : "Floating over the page. Click to dock (the run page makes room from 1280 px wide)."}
                  onClick={() => setDrawerState({ docked: !drawer.docked })}
                >
                  {drawer.docked ? "Float" : "Dock"}
                </button>
              ) : null}
              <button type="button" className="btn btn-small assistant-close" aria-label="Close the assistant (Escape)" title="Close (Escape)" onClick={close}>
                ×
              </button>
            </div>
            <ConversationPicker
              conversations={conversations}
              currentId={convId}
              currentTitle={currentTitle}
              busy={active || sending}
              onSelect={selectConversation}
              onNew={newConversation}
              onRename={renameConversation}
              onDelete={removeConversation}
            />
            {rebound ? <div className="assistant-banner assistant-banner-info">Now about: {runNames[rebound] ?? rebound}. This conversation followed you into the new run.</div> : null}
            {!rebound && convElsewhere ? <div className="hint assistant-scope-note">This conversation is about {convRunId ? `run ${runNames[convRunId] ?? convRunId}` : "Home"}; the page shows {scope ? `run ${ctx.runName ?? scope}` : "Home"}.</div> : null}
            {unavailable && capError ? (
              <div className="assistant-banner assistant-banner-warn" role="status">
                {capError.text}{" "}
                <button type="button" className="btn-link" onClick={() => navigate({ name: "instructions", section: null })}>
                  {capError.actionLabel}
                </button>
              </div>
            ) : offline ? (
              <div className="assistant-banner assistant-banner-warn" role="status">
                AI model offline{capabilities?.models.find((m) => m.profile === "chat")?.reason ? `: ${capabilities.models.find((m) => m.profile === "chat")?.reason}` : ""}. Questions are answered from the docs (search) until a model is available.
              </div>
            ) : null}
            {ctx.page === "story" ? <div className="hint assistant-scope-note">Story Mode help. The story author has its own composer on the page; this drawer explains and analyses.</div> : null}
          </header>

          <MessageList
            view={view}
            now={now}
            onScreenRunId={ctx.page === "run" ? ctx.runId : null}
            describe={{ runNames, onScreenRunId: ctx.page === "run" ? ctx.runId : null, runState: ctx.runState }}
            busyBriefId={busyBriefId}
            briefErrors={briefErrors}
            replyToBriefId={replyTo?.id ?? null}
            cancelling={cancelling}
            onCancelJob={(job) => void onCancelJob(job)}
            onRetry={(text) => void send(text)}
            onErrorAction={onErrorAction}
            onOption={(text) => void send(text)}
            onAction={onAction}
            onApprove={(brief) => void approve(brief)}
            onAskChanges={askChanges}
            onCancelBrief={(brief) => void reject(brief)}
            onOpenInSetup={openInSetup}
            onOpenRun={(runId) => navigate({ name: "run", runId, turnId: null })}
            onOpenGodMode={openGodMode}
          />

          <footer className="assistant-foot">
            {loadError ? <div className="error-inline">Could not load the conversation: {loadError}</div> : null}
            {notice ? (
              <div className="assistant-notice" role="status">
                {notice}
              </div>
            ) : null}
            {localHits ? (
              <div className="assistant-msg assistant-msg-assistant assistant-msg-offline assistant-local-hits">
                <div className="assistant-offline-label">Docs search (AI offline)</div>
                {localHits.hits.length === 0 ? (
                  <p className="hint">Nothing in "How the world works" matches "{localHits.query}". Open the page and browse its contents.</p>
                ) : (
                  <>
                    <p className="hint">Sections of "How the world works" that match "{localHits.query}":</p>
                    <div className="assistant-refs">
                      {localHits.hits.map((hit) => (
                        <button key={hit.id} type="button" className="assistant-ref assistant-ref-doc" onClick={() => navigate({ name: "instructions", section: hit.id })}>
                          <span className="assistant-ref-kind">docs</span> {hit.title}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : null}
            {sendError ? (
              <div className="assistant-error" role="alert">
                {sendError.text}
                {sendError.action === "docs" ? (
                  <button type="button" className="btn btn-small" onClick={() => navigate({ name: "instructions", section: null })}>
                    {sendError.actionLabel}
                  </button>
                ) : sendError.action === "raise_limit" ? (
                  <button type="button" className="btn btn-small" onClick={() => setSpendOpenRequest((n) => n + 1)}>
                    {sendError.actionLabel}
                  </button>
                ) : null}
              </div>
            ) : null}
            <Composer
              text={composer}
              onText={setComposer}
              onSend={() => void send(composer)}
              busy={sending || active}
              disabled={false}
              disabledReason={unavailable ? "The assistant is not available in this backend; questions are matched against the docs" : null}
              includeContext={includeContext}
              onIncludeContext={setIncludeContext}
              contextLabel={contextChipText(ctx)}
              replyTo={replyTo}
              onClearReplyTo={() => setReplyTo(null)}
              suggestions={suggestions}
              onSuggestion={(text) => {
                setComposer(text);
                focusComposer();
              }}
              runId={ctx.runId}
              language={language}
              onRecordingChange={setRecording}
              textareaRef={textareaRef}
            />
            <div className="assistant-foot-row hint">
              <span>AI answers can be wrong: the Turn record has the facts.</span>
              <label className="assistant-lang">
                Dictation language{" "}
                <select
                  value={language}
                  aria-label="Dictation language"
                  onChange={(e) => {
                    setLanguage(e.target.value);
                    const prefs = prefsRef.current ?? loadPrefs();
                    prefsRef.current = { ...prefs, language: e.target.value };
                    savePrefs(prefsRef.current);
                  }}
                >
                  <option value="en">English</option>
                  <option value="auto">Detect</option>
                  <option value="de">Deutsch</option>
                  <option value="fr">Français</option>
                  <option value="es">Español</option>
                  <option value="zh">中文</option>
                </select>
              </label>
            </div>
          </footer>
        </aside>
      ) : null}
    </>
  );
}
