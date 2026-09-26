/**
 * The run page (spec "Sessions and run controls" and "Display and historical
 * inspection"; INTERFACES sections 3, 7, 9, 10, 11).  The board is the hero.
 *
 * Three columns from 1200 px wide, filling the window (each column scrolls on
 * its own):
 * - LEFT rail: run name, the run controls (first, so status changes never
 *   move them), the status facts with the model-call slot and Recover, the
 *   history timeline (round/turn arrows, turn selector, LIVE/HISTORY, Return
 *   to live) and a compact agent roster.
 * - CENTRE: the map at the full height of the window, its toolbar above and
 *   the legend always visible below it.  Decision packets and model calls
 *   open over the map (Close / Escape returns to it).
 * - RIGHT: tabs (Inspector, Turn record, God mode, Rules & settings,
 *   Storybook) and the live activity log docked at the bottom (collapsible).
 *   God mode and the rules widen this column; "Wider panel" does it for any
 *   tab (the toggle sits in the panel header under the one-line tabs row).
 *
 * Entity profile card: clicking an entity (map dot, map tooltip row,
 * occupant row, roster row, "Other entities" chip, an assistant entity link,
 * or the Inspector's Profile button) selects it and opens its profile card
 * (components/profile) over the page; the board stays visible behind it.
 * The card is hidden while a record is open over the map and comes back when
 * the record closes; closing it returns focus to what opened it.
 *
 * Assistant (rev 4): the page publishes what the user is looking at to
 * state/assistantContext.ts on every render and registers its handlers keyed
 * by run id (select entity, find point, view turn, set tab, open record,
 * in-flight guard, apply status, show error) so the drawer's links and
 * approved run commands act through the page's own logic.  When the drawer
 * is docked (>= 1280 px) the layout reserves its width on the right.
 * Below 1200 px the rail and the map share the top row and the tabs follow
 * below; below 900 px everything stacks with the map first.  On narrow
 * screens the log is a drawer at the bottom of the window.
 *
 * Data flow: useRunFeed holds the run open and polls status + events;
 * everything that only changes at a commit (live checkpoint, settings, rules,
 * staged edits, turn index) reloads when status.current_turn_id changes;
 * historical checkpoints, knowledge, packets and model calls load on demand.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import {
  createContinuation,
  getAssumptions,
  getLiveKnowledge,
  getLiveState,
  getRules,
  getRun,
  getRunAssumptions,
  getSettings,
  getStatus,
  getTurnKnowledge,
  listInterventions,
  listModels,
  reloadWorking,
  sendCommand,
  stageIntervention,
  unstageIntervention,
} from "../api/client";
import type { Agent, AgentKnowledgeView, ApiProblem, Entity, FieldChange, Intervention, Point, RunCommand, TurnView } from "../api/types";
import { findEntity, pointKey } from "../api/types";
import { InspectorPanel, MapView, OccupantList, entitiesAtPoint, flattenEntities, removedList } from "../components/inspect";
import type { AgentViewOverlay } from "../components/inspect";
import { LauncherButton } from "../components/assistant/Launcher";
import { ActivityLog } from "../components/run/ActivityLog";
import { AgentShortcuts } from "../components/run/AgentShortcuts";
import { AgentRoster, EntityIndex } from "../components/run/EntityLists";
import { EntityProfileCard } from "../components/profile/EntityProfileCard";
import { FindBar } from "../components/run/FindBar";
import { GodModeTab } from "../components/run/GodModeTab";
import { RecordViewer } from "../components/run/RecordViewer";
import type { RecordTarget } from "../state/records";
import { discardedAttemptSeqs, latestFailedTurn } from "../state/feed";
import { RulesTab } from "../components/run/RulesTab";
import { RunControls } from "../components/run/RunControls";
import { Splitter } from "../components/run/Splitter";
import { StatusBar } from "../components/run/StatusBar";
import { StorybookTab } from "../components/run/StorybookTab";
import { Timeline } from "../components/run/Timeline";
import { TurnRecordTab } from "../components/run/TurnRecordTab";
import { ErrorLine } from "../components/common/Problems";
import { PageHeader } from "../components/common/PageHeader";
import { useFetched } from "../hooks/useFetched";
import { navigate } from "../hooks/useHashRoute";
import { useHistoryView, useTurnIndex } from "../hooks/useRunData";
import { useRunFeed } from "../hooks/useRunFeed";
import { MIN_LOG_H, MIN_RAIL_W, MIN_SIDE_W, useRunLayout } from "../hooks/useRunLayout";
import { useThrottledKey } from "../hooks/useThrottledKey";
import { clearContext, dockReserve, getDrawerState, publishContext, registerHandlers, subscribeDrawer } from "../state/assistantContext";
import type { RunHandlers, RunTabId } from "../state/assistantContext";
import { errorText, withReopen } from "../state/runSessions";
import { allModelsFake, controlAvailability, isIdle } from "../state/statusText";

type Tab = RunTabId;

/** Minimum time between commit-driven reloads while the run is busy. */
const COMMIT_REFRESH_MS = 1000;


/** Error carrying backend-style problems, understood by the inspect components (problemsFromError). */
class ProblemsError extends Error {
  problems: ApiProblem[];
  constructor(problems: ApiProblem[]) {
    super(problems.map((p) => (p.path ? `${p.path}: ${p.message}` : p.message)).join("; "));
    this.problems = problems;
  }
}

/** "working/entities/agents/a02.json: line 4: ..." -> path + message. */
function splitFileProblem(text: string): ApiProblem {
  const index = text.indexOf(": ");
  if (index > 0 && /[/.]/.test(text.slice(0, index))) return { path: text.slice(0, index), message: text.slice(index + 2) };
  return { path: "", message: text };
}

export function RunPage(props: { runId: string; initialTurnId: string | null }) {
  const { runId } = props;
  const feed = useRunFeed(runId);
  const { status } = feed;
  const liveTurnId = status?.current_turn_id ?? null;
  // Commit-driven data reloads when the saved turn changes: at once when idle, at most once a second while running.
  const commitKey = useThrottledKey(feed.opened && liveTurnId ? liveTurnId : null, COMMIT_REFRESH_MS, isIdle(status));

  // ------------------------------------------------------------------ data
  const summary = useFetched(runId, () => getRun(runId));
  const models = useFetched("models", () => listModels());
  const live = useFetched<TurnView>(commitKey, () => withReopen(runId, () => getLiveState(runId)));
  const settings = useFetched(commitKey, () => withReopen(runId, () => getSettings(runId)));
  const rules = useFetched(commitKey, () => withReopen(runId, () => getRules(runId)));
  const stagedKey = commitKey === null ? null : `${commitKey}#${status?.staged_intervention_count ?? 0}`;
  const staged = useFetched(stagedKey, () => withReopen(runId, () => listInterventions(runId)));
  const assumptions = useFetched(runId, () => getRunAssumptions(runId).catch(() => getAssumptions()));
  const index = useTurnIndex(runId, commitKey);

  // ------------------------------------------------------------------ view state
  const [viewTurnId, setViewTurnId] = useState<string | null>(props.initialTurnId);
  const [tab, setTab] = useState<Tab>("inspect");
  const [selectedPoint, setSelectedPoint] = useState<Point | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentView, setAgentView] = useState(false);
  // The entity whose profile card is open (local to the page, never in the URL).
  const [profileId, setProfileId] = useState<string | null>(null);
  // "Wider panel": the right column takes more room from the map (God mode and the rules always do).
  const [wideSide, setWideSide] = useState(false);
  const [logCollapsed, setLogCollapsed] = useState(false);
  const sideWideNow = wideSide || tab === "god" || tab === "rules";
  // The docked assistant drawer takes room on the right (state/assistantContext.dockReserve).
  const drawer = useSyncExternalStore(subscribeDrawer, getDrawerState, getDrawerState);
  const [winW, setWinW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const reserveW = dockReserve(drawer, winW, "run");
  // Splitter sizes (three-column layout only), remembered in localStorage.
  const layout = useRunLayout(sideWideNow, reserveW);
  // Lines of a discarded attempt of a saved turn (INTERFACES section 8): known once the saved turn's event range arrives.
  const [discardedSeqs, setDiscardedSeqs] = useState<ReadonlySet<number>>(() => new Set());
  const [record, setRecord] = useState<RecordTarget | null>(null);
  const [inFlight, setInFlight] = useState<RunCommand | null>(null);
  // True while the assistant drawer executes an approved run command for this run (same guard as inFlight).
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [prevInitial, setPrevInitial] = useState(props.initialTurnId);
  if (props.initialTurnId !== prevInitial) {
    setPrevInitial(props.initialTurnId);
    setViewTurnId(props.initialTurnId);
  }

  const history = useHistoryView(runId, viewTurnId);
  const liveTurnRecord = live.data?.turn ?? null;
  useEffect(() => {
    if (!liveTurnRecord) return;
    setDiscardedSeqs((previous) => {
      const found = discardedAttemptSeqs(feed.events, liveTurnRecord).filter((seq) => !previous.has(seq));
      if (found.length === 0) return previous;
      return new Set([...previous, ...found]);
    });
  }, [liveTurnRecord, feed.events]);
  const viewed: TurnView | null = viewTurnId === null ? live.data : ((history.dataKey === viewTurnId ? history.data : null) ?? history.data ?? live.data);
  // "Before" values for the turn record: the previous saved turn, loaded only while that tab is shown
  // (a continuation's first turn has its previous turn in the parent run: not loaded).
  const previousTurnId = tab === "turn" && viewed && !viewed.parent ? viewed.turn.previous_turn_id : null;
  const previous = useHistoryView(runId, previousTurnId);
  const previousView = previousTurnId !== null && previous.dataKey === previousTurnId ? previous.data : null;
  const previousNote =
    viewed?.parent && viewed.turn.previous_turn_id
      ? `the previous turn is in the parent run ${viewed.parent.run_id}`
      : previousTurnId === null
        ? null
        : previous.error
          ? `could not load the previous turn ${previousTurnId}: ${previous.error}`
          : `loading the previous turn ${previousTurnId}…`;

  useEffect(() => {
    document.title = `${summary.data?.name ?? runId} · Empyrean`;
  }, [summary.data, runId]);

  // Clock for "waiting for model: N s" (shown whenever a call is pending, also in "Pause requested").
  const waiting = !!status?.pending_model_call;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [waiting]);

  // ------------------------------------------------------------------ names and selection
  const agentNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const view of [live.data, viewed]) for (const a of Object.values(view?.entities.agents ?? {})) names.set(a.id, a.name);
    return names;
  }, [live.data, viewed]);
  const name = useCallback(
    (id: string | null | undefined) => {
      if (!id) return "none";
      const known = agentNames.get(id);
      return known ? `${id} ${known}` : id;
    },
    [agentNames],
  );

  const entities = useMemo(() => (viewed ? flattenEntities(viewed.entities) : []), [viewed]);
  const removed = useMemo(() => (viewed ? removedList(viewed.entities) : []), [viewed]);
  const occupants = useMemo(() => entitiesAtPoint(entities, selectedPoint), [entities, selectedPoint]);
  const agents = useMemo(() => entities.filter((e): e is Agent => e.kind === "agent"), [entities]);
  const others = useMemo(() => entities.filter((e) => e.kind !== "agent"), [entities]);

  // Keep the selection across history: the viewed turn's record, else live, else the last one seen.
  const foundEntity: Entity | null =
    selectedId === null
      ? null
      : ((viewed ? findEntity(viewed.entities, selectedId) : undefined) ?? (live.data ? findEntity(live.data.entities, selectedId) : undefined) ?? null);
  const [lastSeen, setLastSeen] = useState<Entity | null>(null);
  if (foundEntity !== null && foundEntity !== lastSeen) setLastSeen(foundEntity);
  const selectedEntity: Entity | null = foundEntity ?? (lastSeen !== null && lastSeen.id === selectedId ? lastSeen : null);

  const selectedAgentId = selectedEntity?.kind === "agent" ? selectedEntity.id : null;
  const knowledgeKey =
    selectedAgentId === null ? null : viewTurnId !== null ? `turn:${viewTurnId}:${selectedAgentId}` : commitKey ? `live:${commitKey}:${selectedAgentId}` : null;
  const knowledge = useFetched<AgentKnowledgeView>(knowledgeKey, () =>
    viewTurnId !== null ? getTurnKnowledge(runId, viewTurnId, selectedAgentId ?? "") : withReopen(runId, () => getLiveKnowledge(runId, selectedAgentId ?? "")),
  );
  const knowledgeView = knowledge.dataKey === knowledgeKey ? knowledge.data : null;
  // Agent view: the map and the occupant list draw only what the selected agent has observed
  // (its knowledge view of the viewed turn), never the omniscient entity list.
  const agentViewOverlay: AgentViewOverlay | null =
    agentView && selectedAgentId && knowledgeView && knowledgeView.knowledge.agent_id === selectedAgentId
      ? {
          agentId: selectedAgentId,
          agentName: agentNames.get(selectedAgentId) ?? selectedAgentId,
          believedPosition: knowledgeView.believed_self.position ?? null,
          observed: knowledgeView.observed_entities ?? [],
        }
      : null;

  const inRegion = (p: Point) => {
    const region = viewed?.map.region;
    return !!region && p.x >= region.min_x && p.x <= region.max_x && p.y >= region.min_y && p.y <= region.max_y;
  };

  // Bring the inspector into view after a selection made by the operator (map, occupant row, roster, find).
  const inspectorRef = useRef<HTMLDivElement | null>(null);
  const [revealTick, setRevealTick] = useState(0);
  // An operator selection shows the inspector (God mode keeps its tab: its forms use the selection; the Storybook follows the selection instead).
  const reveal = () => {
    setTab((current) => (current === "god" || current === "storybook" ? current : "inspect"));
    setRevealTick((n) => n + 1);
  };
  useEffect(() => {
    if (revealTick === 0) return;
    const frame = requestAnimationFrame(() => revealInspector(inspectorRef.current));
    return () => cancelAnimationFrame(frame);
  }, [revealTick]);

  // The profile card: opening it remembers the control that had focus (not one inside the card), closing it returns focus there.
  const profileOpener = useRef<HTMLElement | null>(null);
  const openProfile = (id: string) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest(".profile-card")) profileOpener.current = active;
    setProfileId(id);
  };
  const closeProfile = (restoreFocus = true) => {
    setProfileId(null);
    const opener = profileOpener.current;
    profileOpener.current = null;
    if (restoreFocus) requestAnimationFrame(() => opener?.isConnected && opener.focus({ preventScroll: true }));
  };

  /** Select an entity and its point; `open` also opens its profile card. */
  const pickEntity = (id: string, open: boolean) => {
    const entity = (viewed ? findEntity(viewed.entities, id) : undefined) ?? (live.data ? findEntity(live.data.entities, id) : undefined);
    setSelectedId(id);
    if (entity) setSelectedPoint(entity.position);
    reveal();
    if (open) openProfile(id);
  };
  const selectEntity = (id: string) => pickEntity(id, true);

  /** An occupant row, a map dot or a single-occupant map cell: the point is already selected; the card opens. */
  const selectOccupant = (id: string) => {
    setSelectedId(id);
    reveal();
    openProfile(id);
  };

  /** A map click or "Select point": a selection that is not at the new point is cleared, so the column shows that point. */
  const selectPoint = (p: Point) => {
    setSelectedPoint(p);
    setTab((current) => (current === "god" || current === "storybook" ? current : "inspect"));
    if (selectedEntity && (selectedEntity.position.x !== p.x || selectedEntity.position.y !== p.y)) setSelectedId(null);
  };

  const findEntityById = (id: string): string | null => {
    const entity = (viewed ? findEntity(viewed.entities, id) : undefined) ?? (live.data ? findEntity(live.data.entities, id) : undefined);
    if (entity) {
      selectEntity(entity.id);
      return null;
    }
    const gone = viewed?.entities.removed[id];
    if (gone) {
      setSelectedPoint(gone.position);
      return `${id} left the world in round ${gone.round} (${gone.reason}); its last point is selected.`;
    }
    return `No entity "${id}" in the viewed turn or the live state.`;
  };

  const findPoint = (p: Point): string | null => {
    if (!inRegion(p)) {
      const r = viewed?.map.region;
      return r ? `(${p.x}, ${p.y}) is outside the region (x ${r.min_x}..${r.max_x}, y ${r.min_y}..${r.max_y}).` : "No map loaded yet.";
    }
    selectPoint(p);
    const here = entitiesAtPoint(entities, p);
    if (here.length === 1) pickEntity(here[0].id, false);
    return null;
  };

  // ------------------------------------------------------------------ commands and edits
  const send = async (command: RunCommand) => {
    if (inFlight) return;
    setInFlight(command);
    setCommandError(null);
    try {
      feed.applyStatus(await withReopen(runId, () => sendCommand(runId, command)));
    } catch (error) {
      setCommandError(errorText(error));
    } finally {
      setInFlight(null);
    }
  };

  const setStaged = staged.set;
  const applyStatus = feed.applyStatus;
  // The status bar's "staged edits" count comes from the poller; refresh it at once so it never lags the tab count.
  const refreshStatus = useCallback(() => {
    getStatus(runId)
      .then(applyStatus)
      .catch(() => undefined);
  }, [runId, applyStatus]);
  const onStage = useCallback(
    async (intervention: Intervention) => {
      setStaged(await withReopen(runId, () => stageIntervention(runId, intervention)));
      refreshStatus();
    },
    [runId, setStaged, refreshStatus],
  );
  const onDiscard = useCallback(
    async (_seq: number, id: string) => {
      setStaged(await withReopen(runId, () => unstageIntervention(runId, id)));
      refreshStatus();
    },
    [runId, setStaged, refreshStatus],
  );
  const reloadStaged = staged.reload;
  const onReloadWorking = useCallback(async (): Promise<FieldChange[]> => {
    const result = await withReopen(runId, () => reloadWorking(runId));
    if (!result.ok) throw new ProblemsError(result.errors.map(splitFileProblem));
    reloadStaged();
    refreshStatus();
    if (!result.staged && result.changes.length === 0) {
      throw new ProblemsError([{ path: "working/", message: "the files match the current checkpoint, so nothing was staged" }]);
    }
    return result.changes;
  }, [runId, reloadStaged, refreshStatus]);
  const onCreateContinuation = useCallback(async () => {
    const from = viewTurnId ?? liveTurnId;
    if (!from) throw new ProblemsError([{ path: "", message: "no turn loaded yet" }]);
    const created = await createContinuation(runId, { from_turn_id: from });
    navigate({ name: "run", runId: created.run_id, turnId: null });
  }, [runId, viewTurnId, liveTurnId]);

  // The record viewer opens above the tabs; closing it returns focus and scroll to the button that opened it.
  const recordTrigger = useRef<HTMLElement | null>(null);
  const openRecord = useCallback((target: RecordTarget) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest(".record-viewer")) recordTrigger.current = active;
    setRecord(target);
  }, []);
  const closeRecord = useCallback(() => {
    setRecord(null);
    const trigger = recordTrigger.current;
    recordTrigger.current = null;
    requestAnimationFrame(() => {
      if (trigger && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
        trigger.scrollIntoView({ block: "center" });
      }
    });
  }, []);

  // ------------------------------------------------------------------ assistant: context and handlers
  // Handlers are registered once per run id and always call the latest closures.
  // (State setters are stable and used directly; only the closures that change per render go through the ref.)
  const latest = useRef({ findEntityById, findPoint, openRecord, applyStatus, liveTurnId });
  useEffect(() => {
    latest.current = { findEntityById, findPoint, openRecord, applyStatus, liveTurnId };
  });
  useEffect(() => {
    const bundle: RunHandlers = {
      selectEntity: (id) => latest.current.findEntityById(id),
      findPoint: (p) => latest.current.findPoint(p),
      viewTurn: (turnId) => setViewTurnId(turnId !== null && turnId === latest.current.liveTurnId ? null : turnId),
      setTab: (next) => setTab(next),
      openRecord: (target) => latest.current.openRecord(target),
      setInFlight: (busy) => setAssistantBusy(busy),
      applyStatus: (next) => latest.current.applyStatus(next),
      showError: (message) => setCommandError(message),
    };
    return registerHandlers(runId, bundle);
  }, [runId]);
  // What the user is looking at (publishContext notifies only on change, so publishing every render is cheap).
  useEffect(() => {
    publishContext({
      page: "run",
      runId,
      runName: summary.data?.name ?? null,
      liveTurnId,
      shownTurnId: viewed?.turn.turn_id ?? null,
      tab,
      selectedPoint,
      selectedEntityId: selectedId,
      selectedEntityKind: selectedEntity?.kind ?? null,
      runState: status?.state ?? null,
      lastError: commandError ?? status?.last_error ?? feed.openError ?? null,
    });
  }, [runId, summary.data?.name, liveTurnId, viewed?.turn.turn_id, tab, selectedPoint, selectedId, selectedEntity?.kind, status?.state, status?.last_error, commandError, feed.openError]);
  useEffect(() => () => clearContext(runId), [runId]);

  // ------------------------------------------------------------------ render
  if (feed.openError) {
    return (
      <div className="page">
        <PageHeader title={`Run ${runId}`} />
        <ErrorLine text={feed.openError} prefix="Could not open this run:" />
      </div>
    );
  }
  if (!status || !viewed) {
    return (
      <div className="page">
        <PageHeader title={`Run ${runId}`} />
        <p className="hint">Connecting to the run: the backend recovers its folder and reads the latest saved checkpoint…</p>
        <ErrorLine text={live.error} prefix="Could not read the live state:" />
      </div>
    );
  }

  const allowed = controlAvailability(status, inFlight !== null || assistantBusy);
  const highlightAgentId = viewTurnId === null && status.active_turn_id ? status.acting_agent_id : viewed.turn.acting_agent_id;
  const selectedTerrain = selectedPoint ? (viewed.map.cells[pointKey(selectedPoint)] ?? (inRegion(selectedPoint) ? "land" : null)) : null;
  const committedSeq = live.data && live.data.turn.turn_id === status.current_turn_id ? live.data.turn.event_seq_end : null;
  const stagedList = staged.data?.staged ?? [];
  const runName = summary.data?.name ?? runId;
  const parentRun = summary.data?.parent ?? null;
  const workingDir = summary.data?.run_dir ? `${summary.data.run_dir.replace(/[\\/]+$/, "")}/working/` : `worlds/${status.world_id}/runs/${runId}/working/`;
  const failedTurn = status.last_error ? latestFailedTurn(feed.events, committedSeq) : null;
  const allFake = allModelsFake(live.data?.settings ?? null, models.data);

  // Tab labels: `short` replaces `long` when the tabs row is narrow (App.css container queries on .tabs-row:
  // "md" below 420 px, "sm" below 385 px), so all five tabs stay on one line without scrolling; the accessible
  // name (`label`) is always the full one.
  const stagedSuffix = stagedList.length ? ` (${stagedList.length})` : "";
  const tabs: { id: Tab; label: string; long: string; short?: string; shortAt?: "md" | "sm"; suffix?: string; title: string }[] = [
    { id: "inspect", label: "Inspector", long: "Inspector", title: "Occupants of the selected cell and the selected entity" },
    { id: "turn", label: "Turn record", long: "Turn record", short: "Turn", shortAt: "sm", title: `What happened in turn ${viewed.turn.turn_id}` },
    { id: "god", label: `God mode${stagedSuffix}`, long: "God mode", short: "God", shortAt: "sm", suffix: stagedSuffix, title: `God mode${stagedList.length ? `: ${stagedList.length} staged edit(s)` : ""}` },
    { id: "rules", label: "Rules", long: "Rules", title: "Rules & settings (read-only)" },
    { id: "storybook", label: "Storybook", long: "Storybook", short: "Story", shortAt: "md", title: "The story so far, written by the assistant as turns are saved" },
  ];
  const activeTab = tabs.find((t) => t.id === tab) ?? tabs[0];
  const docked = layout.threeColumn && layout.reservedW > 0;
  const layoutClass = ["run-layout", sideWideNow ? "run-side-wide" : "", logCollapsed ? "run-log-collapsed" : "", viewTurnId !== null ? "run-history" : "", docked ? "run-assistant-docked" : ""]
    .filter(Boolean)
    .join(" ");

  const layoutStyle = layout.threeColumn
    ? ({ "--rail-w": `${layout.railW}px`, "--side-w": `${layout.sideW}px`, "--log-h": `${layout.logH}px`, "--assistant-w": `${layout.reservedW}px` } as CSSProperties)
    : undefined;

  return (
    <div className={layoutClass} style={layoutStyle}>
      <aside className="run-rail" aria-label="Run">
        <header className="rail-header">
          <h1 className="rail-title" title={runName}>
            {runName}
          </h1>
          <div className="rail-ids">
            run <code>{runId}</code>
            <br />
            world <code>{status.world_id}</code>
            {parentRun ? (
              <>
                <br />
                continuation of <code>{parentRun.run_id}</code> from turn <code>{parentRun.turn_id}</code>
              </>
            ) : null}
          </div>
          <div className="rail-actions">
            <button type="button" className="btn btn-small rail-back" onClick={() => navigate({ name: "entry" })}>
              Back to sessions
            </button>
            <LauncherButton />
          </div>
          <button type="button" className="btn-link rail-story-link" title="Story Mode: turn this run into a story" onClick={() => navigate({ name: "story", runId, storyId: null })}>
            Make a story of this run
          </button>
        </header>
        <RunControls allowed={allowed} inFlight={inFlight} error={commandError} onCommand={(c) => void send(c)} onResetLayout={layout.reset} />
        <StatusBar
          status={status}
          name={name}
          realBudgetUsd={live.data?.settings.real_budget_usd ?? null}
          now={now}
          recoverEnabled={allowed.recover}
          failedTurn={failedTurn}
          allFake={allFake}
          onRecover={() => void send("pause")}
          onViewPending={() => openRecord({ kind: "pending" })}
        />
        <Timeline
          turns={index.turns}
          liveTurnId={status.current_turn_id}
          viewTurnId={viewTurnId}
          loading={viewTurnId !== null && history.loading}
          loadError={viewTurnId !== null ? history.error : index.error}
          name={name}
          parent={viewed.parent}
          onView={setViewTurnId}
          onOpenParent={(parent) => navigate({ name: "run", runId: parent.run_id, turnId: parent.turn_id })}
        />
        <ErrorLine text={live.error} prefix="Live state:" />
        <AgentRoster agents={agents} selectedId={selectedId} actingId={highlightAgentId} onSelect={selectEntity} compact />
      </aside>

      <Splitter
        orientation="vertical"
        label="Resize the left panel"
        className="splitter-rail"
        value={layout.railW}
        min={MIN_RAIL_W}
        max={layout.railMax}
        direction={1}
        onChange={layout.setRailW}
        onReset={() => layout.resetPart("rail")}
      />

      <main className="run-center" aria-label="World map">
        {viewTurnId !== null ? (
          <div className="map-history-strip" role="status">
            <span className="mode-badge mode-history">HISTORY</span>
            <span>
              The map shows turn <code>{viewTurnId}</code> (round {viewed.turn.round}), not the live state.
            </span>
            <button type="button" className="btn btn-small" onClick={() => setViewTurnId(null)}>
              Back to live
            </button>
          </div>
        ) : null}
        <MapView
          map={viewed.map}
          entities={entities}
          removed={removed}
          selectedPoint={selectedPoint}
          selectedEntityId={selectedId}
          onSelectPoint={selectPoint}
          onSelectEntity={selectOccupant}
          highlightAgentId={highlightAgentId}
          rules={viewed.rules}
          fill
          persistKey="run"
          agentView={agentView}
          agentViewOverlay={agentViewOverlay}
        />
        {record ? (
          <div className="record-overlay">
            <RecordViewer
              runId={runId}
              target={record}
              viewedTurn={viewed}
              pendingCallId={status.pending_model_call?.call_id ?? null}
              savedTurnId={status.current_turn_id}
              runState={status.state}
              onOpen={openRecord}
              onClose={closeRecord}
            />
          </div>
        ) : null}
      </main>

      <Splitter
        orientation="vertical"
        label="Resize the right panel"
        className="splitter-side"
        value={layout.sideW}
        min={MIN_SIDE_W}
        max={layout.sideMax}
        direction={-1}
        onChange={layout.setSideW}
        onReset={() => layout.resetPart("side")}
      />

      <section className="run-side" aria-label="Inspector and records">
        <div className="tabs-row">
          <div className="tabs" role="tablist" aria-label="Run views">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`panel-${t.id}`}
                aria-label={t.label}
                title={t.title}
                className={`tab${tab === t.id ? " tab-active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.short ? (
                  <>
                    <span className={`tab-label-long tab-long-${t.shortAt}`}>{t.long}</span>
                    <span className={`tab-label-short tab-short-${t.shortAt}`}>{t.short}</span>
                  </>
                ) : (
                  t.long
                )}
                {t.suffix ?? null}
              </button>
            ))}
          </div>
        </div>
        <div className="side-panel-head">
          <span className="side-panel-title" title={activeTab.title}>
            {activeTab.title}
          </span>
          <button
            type="button"
            className="btn btn-small inspector-width-toggle"
            aria-pressed={sideWideNow}
            aria-label="Wider panel"
            disabled={tab === "god" || tab === "rules"}
            title={tab === "god" || tab === "rules" ? "This tab always uses the wide panel" : "Give this panel more room (the map gets narrower)"}
            onClick={() => setWideSide((w) => !w)}
          >
            {sideWideNow ? "⇥" : "⇤"}
          </button>
        </div>

        <div role="tabpanel" id="panel-inspect" aria-labelledby="tab-inspect" hidden={tab !== "inspect"} className="side-panel area-side">
          <FindBar onFindEntity={findEntityById} onFindPoint={findPoint} />
          <OccupantList
            point={selectedPoint}
            occupants={occupants}
            selectedEntityId={selectedId}
            onSelectEntity={selectOccupant}
            rules={viewed.rules}
            terrain={selectedTerrain}
            agentView={agentView}
            agentViewOverlay={agentViewOverlay}
          />
          <div className="area-inspector" ref={inspectorRef}>
            {selectedEntity ? (
              <div className="inspector-nav">
                <button type="button" className="btn btn-small" onClick={() => setSelectedId(null)}>
                  Clear selection
                </button>
                <span className="hint">
                  Inspecting <code>{selectedEntity.id}</code>
                </span>
              </div>
            ) : null}
            {selectedAgentId ? (
              <AgentShortcuts
                agentId={selectedAgentId}
                agentLabel={name(selectedAgentId)}
                turns={index.turns}
                shownTurnId={viewed.turn.turn_id}
                onOpen={openRecord}
                onViewTurn={(turnId) => setViewTurnId(turnId === status.current_turn_id ? null : turnId)}
              />
            ) : null}
            <InspectorPanel
              entity={selectedEntity}
              turn={viewed}
              rules={rules.data ?? viewed.rules}
              agentView={agentView}
              onToggleAgentView={() => setAgentView((v) => !v)}
              onOpenProfile={() => selectedEntity && openProfile(selectedEntity.id)}
            />
          </div>
          <EntityIndex entities={others} selectedId={selectedId} onSelect={selectEntity} />
        </div>

        <div role="tabpanel" id="panel-turn" aria-labelledby="tab-turn" hidden={tab !== "turn"} className="side-panel">
          {/* Mounted only while shown: its event lines would otherwise duplicate the live log's text in the page. */}
          {tab === "turn" ? <TurnRecordTab view={viewed} previous={previousView} previousNote={previousNote} name={name} onOpen={openRecord} /> : null}
        </div>

        <div role="tabpanel" id="panel-god" aria-labelledby="tab-god" hidden={tab !== "god"} className="side-panel">
          {live.data ? (
            <GodModeTab
              live={live.data}
              effective={settings.data}
              models={models.data ?? []}
              staged={stagedList}
              viewTurnId={viewTurnId}
              selectedPoint={selectedPoint}
              selectedAgentId={selectedAgentId}
              workingDir={workingDir}
              onStage={onStage}
              onDiscard={onDiscard}
              onReloadWorking={onReloadWorking}
              onCreateContinuation={onCreateContinuation}
            />
          ) : (
            <p className="hint">Waiting for the live state…</p>
          )}
          <ErrorLine text={staged.error} prefix="Staged edits:" />
        </div>

        <div role="tabpanel" id="panel-rules" aria-labelledby="tab-rules" hidden={tab !== "rules"} className="side-panel">
          {tab === "rules" ? (
            <RulesTab
              rules={viewTurnId === null ? (rules.data ?? viewed.rules) : viewed.rules}
              settings={viewTurnId === null ? (settings.data?.settings ?? viewed.settings) : viewed.settings}
              effectiveContext={viewTurnId === null ? (settings.data?.effective_context ?? null) : null}
              effectiveModel={viewTurnId === null ? (settings.data?.effective_model_key ?? null) : null}
              limits={settings.data?.limits ?? null}
              agentIds={Object.keys(viewed.entities.agents)}
              name={name}
              assumptions={assumptions.data?.entries ?? null}
              assumptionsError={assumptions.error}
              source={viewTurnId === null ? "live settings" : `as of turn ${viewTurnId}`}
            />
          ) : null}
        </div>

        <div role="tabpanel" id="panel-storybook" aria-labelledby="tab-storybook" hidden={tab !== "storybook"} className="side-panel">
          {/* Mounted only while shown (it polls the storybook while open). */}
          {tab === "storybook" ? (
            <StorybookTab
              runId={runId}
              viewedTurnId={viewTurnId}
              liveTurnId={status.current_turn_id}
              selectedEntityId={selectedId}
              name={name}
              onViewTurn={(turnId) => setViewTurnId(turnId === status.current_turn_id ? null : turnId)}
              onInspect={(entityId) => {
                selectEntity(entityId);
                setTab("inspect");
              }}
              onOpenStory={() => navigate({ name: "story", runId, storyId: null })}
            />
          ) : null}
        </div>
      </section>

      <Splitter
        orientation="horizontal"
        label="Resize the live activity log"
        className="splitter-log"
        value={layout.logH}
        min={MIN_LOG_H}
        max={layout.logMax}
        direction={-1}
        disabled={logCollapsed}
        onChange={layout.setLogH}
        onReset={() => layout.resetPart("log")}
      />

      {profileId !== null && selectedEntity !== null && selectedEntity.id === profileId ? (
        <EntityProfileCard
          key={profileId}
          runId={runId}
          entity={selectedEntity}
          turn={viewed}
          turns={index.turns}
          knowledge={knowledgeView}
          knowledgeError={knowledge.error}
          settings={settings.data}
          liveRules={rules.data ?? live.data?.rules ?? null}
          agentView={agentView}
          onToggleAgentView={() => setAgentView((v) => !v)}
          name={name}
          hidden={record !== null}
          rightInset={reserveW}
          onClose={() => closeProfile()}
          onOpenInInspector={() => {
            closeProfile(false);
            reveal();
            requestAnimationFrame(() => inspectorRef.current?.querySelector<HTMLElement>(".insp-inspector button")?.focus({ preventScroll: true }));
          }}
          onSelectEntity={selectEntity}
          onViewTurn={(turnId) => setViewTurnId(turnId === status.current_turn_id ? null : turnId)}
          onOpen={openRecord}
          onStage={onStage}
        />
      ) : null}

      <div className="run-log">
        <ActivityLog
          events={feed.events}
          status={status}
          committedSeq={committedSeq}
          viewTurnId={viewTurnId}
          discardedSeqs={discardedSeqs}
          resets={feed.resets}
          pollError={feed.pollError}
          collapsed={logCollapsed}
          onToggleCollapsed={() => setLogCollapsed((c) => !c)}
        />
      </div>
    </div>
  );
}

/**
 * Scroll the inspector into view if its top is not comfortably visible.  In
 * the three-column layout the right column's tab panel scrolls on its own;
 * in the stacked layout the page does.
 */
function revealInspector(block: HTMLElement | null): void {
  if (!block) return;
  const panel = block.closest<HTMLElement>('[role="tabpanel"]');
  const ownScroll = panel !== null && getComputedStyle(panel).overflowY === "auto" && panel.scrollHeight > panel.clientHeight;
  const area = ownScroll && panel ? panel.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const top = block.getBoundingClientRect().top;
  // "Visible" = the inspector starts in the upper part of its scroll area, so its first facts can be read.
  const visible = top >= area.top && top <= area.top + (area.bottom - area.top) * 0.62;
  if (!visible) block.scrollIntoView({ block: "start" });
}
