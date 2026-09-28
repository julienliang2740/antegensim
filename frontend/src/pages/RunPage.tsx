/**
 * The run page (spec "Sessions and run controls" and "Display and historical
 * inspection"; INTERFACES sections 3, 7, 9, 10, 11).  The board is the hero.
 *
 * A compact top bar holds simulation controls and the view switch. The map
 * fills the workspace, with history/replay controls in a collapsible left sidebar.
 * Session details/agents, inspection tools and activity each open in a
 * dismissible utility panel over the board; opening one never resizes the map.
 * Panel content stays mounted so selections, edits and scroll state survive.
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
 * Narrow screens wrap the top bar and keep utility panels inside the viewport.
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
import { knownTerrainFromKnowledge } from "../state/agentFog";
import { Map3dLoader, MapViewSwitch, prefetchMap3d } from "../components/map3d";
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
import { MIN_LOG_W, MIN_RAIL_W, MIN_SIDE_W, useRunLayout } from "../hooks/useRunLayout";
import { useSavedReplay } from "../hooks/useSavedReplay";
import { useThrottledKey } from "../hooks/useThrottledKey";
import { clearContext, dockReserve, getDrawerState, publishContext, registerHandlers, subscribeDrawer } from "../state/assistantContext";
import type { RunHandlers, RunTabId } from "../state/assistantContext";
import { MAP_VIEW_STORAGE_KEY, parseMapViewMode } from "../state/map3dView";
import type { MapViewMode } from "../state/map3dView";
import { errorText, withReopen } from "../state/runSessions";
import { allModelsFake, controlAvailability, isIdle, stateWord } from "../state/statusText";
import { turnEffects } from "../state/turnEffects";

type Tab = RunTabId;

/** Minimum time between commit-driven reloads while the run is busy. */
const COMMIT_REFRESH_MS = 1000;

function readMapViewMode(): MapViewMode {
  try {
    return parseMapViewMode(window.localStorage.getItem(MAP_VIEW_STORAGE_KEY));
  } catch {
    return parseMapViewMode(null);
  }
}

function saveMapViewMode(mode: MapViewMode): void {
  try {
    window.localStorage.setItem(MAP_VIEW_STORAGE_KEY, mode);
  } catch {
    // Storage blocked (private window): the choice lives for this page only.
  }
}


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
  // Presentation only: one utility panel at a time, leaving the board at its full size.
  const [workspacePanel, setWorkspacePanel] = useState<"session" | "inspect" | "activity" | null>(null);
  const closeWorkspacePanel = () => {
    const trigger = document.getElementById(`workspace-toggle-${workspacePanel}`);
    setWorkspacePanel(null);
    trigger?.focus({ preventScroll: true });
  };
  const [logCollapsed, setLogCollapsed] = useState(false);
  const [replayPanelOpen, setReplayPanelOpen] = useState(() => window.innerWidth >= 900);
  const sideWideNow = wideSide || tab === "god" || tab === "rules";
  // "2D map" or "3D view" in the centre column (remembered per browser; the 3D chunk loads only when chosen).
  const [mapViewMode, setMapViewMode] = useState<MapViewMode>(readMapViewMode);
  useEffect(() => saveMapViewMode(mapViewMode), [mapViewMode]);
  // The docked assistant drawer takes room on the right (state/assistantContext.dockReserve).
  const drawer = useSyncExternalStore(subscribeDrawer, getDrawerState, getDrawerState);
  const [winW, setWinW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const replayPanelVisible = replayPanelOpen && (winW >= 900 || workspacePanel === null);
  const reserveW = dockReserve(drawer, winW, "run");
  // Utility panel sizes (desktop resize handles), remembered in localStorage.
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
  const playback = useSavedReplay({
    turns: index.turns,
    shownId: viewed?.turn.turn_id ?? null,
    latestSavedId: liveTurnId,
    loaded: viewTurnId !== null && history.dataKey === viewTurnId && !history.loading && !history.error,
    blocked: record !== null || profileId !== null,
    onView: setViewTurnId,
  });
  if (props.initialTurnId !== prevInitial) {
    setPrevInitial(props.initialTurnId);
    setViewTurnId(props.initialTurnId);
    playback.stop();
  }
  const navigateHistory = (id: string | null) => {
    playback.stop();
    setViewTurnId(id);
  };
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
  // The viewed turn's effects: the 2D map's action marks and the 3D view's animations come from this one list.
  const effects = useMemo(() => turnEffects(viewed), [viewed]);
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
  const knownTerrain = useMemo(() => knowledgeView ? knownTerrainFromKnowledge(knowledgeView) : {}, [knowledgeView]);
  // Agent view: the map and the occupant list draw only what the selected agent has observed
  // (its knowledge view of the viewed turn), never the omniscient entity list.
  const agentViewOverlay: AgentViewOverlay | null =
    agentView && selectedAgentId
      ? {
          agentId: selectedAgentId,
          agentName: agentNames.get(selectedAgentId) ?? selectedAgentId,
          believedPosition: knowledgeView?.believed_self.position ?? null,
          observed: knowledgeView?.observed_entities ?? [],
          knownTerrain,
        }
      : null;
  const displaySelectedPoint = agentViewOverlay ? agentViewOverlay.believedPosition : selectedPoint;

  const inRegion = (p: Point) => {
    const region = viewed?.map.region;
    return !!region && p.x >= region.min_x && p.x <= region.max_x && p.y >= region.min_y && p.y <= region.max_y;
  };

  // Bring the inspector into view after a selection made by the operator (map, occupant row, roster, find).
  const inspectorRef = useRef<HTMLDivElement | null>(null);
  const [revealTick, setRevealTick] = useState(0);
  // An operator selection shows the inspector (God mode keeps its tab: its forms use the selection; the Storybook follows the selection instead).
  const reveal = () => {
    setWorkspacePanel("inspect");
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
    setAgentView(entity?.kind === "agent");
    if (entity) setSelectedPoint(entity.position);
    reveal();
    if (open) openProfile(id);
  };
  const selectEntity = (id: string) => pickEntity(id, true);

  /** An occupant row, a map dot or a single-occupant map cell: the point is already selected; the card opens. */
  const selectOccupant = (id: string) => {
    setSelectedId(id);
    const entity = (viewed ? findEntity(viewed.entities, id) : undefined) ?? (live.data ? findEntity(live.data.entities, id) : undefined);
    setAgentView(entity?.kind === "agent");
    reveal();
    openProfile(id);
  };

  /** A map click or "Select point": a selection that is not at the new point is cleared, so the column shows that point. */
  const selectPoint = (p: Point) => {
    setWorkspacePanel("inspect");
    setSelectedPoint(p);
    setTab((current) => (current === "god" || current === "storybook" ? current : "inspect"));
    // A cell click clears the agent lens; a dot click selects its occupant immediately afterward.
    setSelectedId(null);
    setAgentView(false);
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
    playback.stop();
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
  const stopReplay = playback.stop;
  const latest = useRef({ findEntityById, findPoint, navigateHistory, stopReplay, openRecord, applyStatus, liveTurnId });
  useEffect(() => {
    latest.current = { findEntityById, findPoint, navigateHistory, stopReplay, openRecord, applyStatus, liveTurnId };
  });
  useEffect(() => {
    const bundle: RunHandlers = {
      selectEntity: (id) => latest.current.findEntityById(id),
      findPoint: (p) => latest.current.findPoint(p),
      viewTurn: (turnId) => latest.current.navigateHistory(turnId !== null && turnId === latest.current.liveTurnId ? null : turnId),
      setTab: (next) => { setWorkspacePanel("inspect"); setTab(next); },
      openRecord: (target) => latest.current.openRecord(target),
      setInFlight: (busy) => {
        if (busy) latest.current.stopReplay();
        setAssistantBusy(busy);
      },
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

  // The stable top-bar switch stays visible while either map view is loading.
  const viewSwitch = <MapViewSwitch value={mapViewMode} onChange={setMapViewMode} onPrefetch3d={prefetchMap3d} />;
  const allowed = controlAvailability(status, inFlight !== null || assistantBusy);
  const highlightAgentId = viewTurnId === null && status.active_turn_id ? status.acting_agent_id : viewed.turn.acting_agent_id;
  const pendingAgentId = viewTurnId === null && status.active_turn_id ? status.acting_agent_id : null;
  const selectedTerrain = displaySelectedPoint ? (agentViewOverlay ? agentViewOverlay.knownTerrain[pointKey(displaySelectedPoint)] ?? null : viewed.map.cells[pointKey(displaySelectedPoint)] ?? (inRegion(displaySelectedPoint) ? "land" : null)) : null;
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
  const layoutClass = ["run-layout", "board-workspace", sideWideNow ? "run-side-wide" : "", logCollapsed ? "run-log-collapsed" : "", viewTurnId !== null ? "run-history" : "", docked ? "run-assistant-docked" : ""]
    .filter(Boolean)
    .join(" ");

  const layoutStyle = layout.threeColumn
    ? ({ "--rail-w": `${layout.railW}px`, "--side-w": `${layout.sideW}px`, "--log-h": `${layout.logH}px`, "--log-w": `${layout.logW}px`, "--assistant-w": `${layout.reservedW}px` } as CSSProperties)
    : undefined;

  return (
    <div className={layoutClass} style={layoutStyle} data-panel={workspacePanel ?? "none"} data-replay={replayPanelVisible ? "open" : "closed"} onKeyDown={(event) => {
      if (event.key === "Escape" && workspacePanel && !profileId && !record && !event.defaultPrevented) closeWorkspacePanel();
    }}>
      <header className="workspace-topbar">
        <button type="button" className="btn workspace-back" aria-label="Back to sessions" title="Back to sessions" onClick={() => navigate({ name: "entry" })}>‹</button>
        <div className="workspace-identity">
          <h1 title={runName}>{runName}</h1>
          <button className="workspace-status btn-link" onClick={() => setWorkspacePanel("session")} title="Open session status and model details">
            <span className={`state-badge state-${status.state}`}>{stateWord(status.state)}</span> Live round {status.round}
          </button>
        </div>
        <RunControls running={!isIdle(status)} allowed={allowed} inFlight={inFlight} error={commandError} onCommand={(c) => void send(c)} onResetLayout={layout.reset} />
        {viewSwitch}
        <nav className="workspace-tools" aria-label="Workspace panels">
          <button id="replay-panel-toggle" type="button" className={`btn btn-small${replayPanelVisible ? " btn-primary" : ""}`} aria-expanded={replayPanelVisible} aria-controls="replay-panel" onClick={() => { setReplayPanelOpen(!replayPanelVisible); if (winW < 900) setWorkspacePanel(null); }}>Replay</button>
          {([
            ["session", "Session & agents"], ["inspect", `Inspector & tools${stagedSuffix}`], ["activity", "Activity log"],
          ] as const).map(([id, label]) => <button key={id} id={`workspace-toggle-${id}`} type="button" className={`btn btn-small${workspacePanel === id ? " btn-primary" : ""}`} aria-expanded={workspacePanel === id} aria-controls={`workspace-panel-${id}`} onClick={() => setWorkspacePanel((current) => current === id ? null : id)}>{label}</button>)}
        </nav>
      </header>
      <aside id="workspace-panel-session" className="run-rail" aria-label="Run">
        <div className="workspace-panel-head"><strong>Session & agents</strong><button type="button" className="btn btn-small" onClick={closeWorkspacePanel} aria-label="Close session panel">Close ×</button></div>
        <header className="rail-header">
          <h1 className="rail-title" title={runName}>
            {runName}
          </h1>
          <details className="rail-identifiers">
            <summary>Session details</summary>
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
          </details>
          <div className="rail-actions">
            <LauncherButton />
          </div>
          <button type="button" className="btn-link rail-story-link" title="Story Mode: turn this run into a story" onClick={() => navigate({ name: "story", runId, storyId: null })}>
            Make a story of this run
          </button>
        </header>
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
        <ErrorLine text={live.error} prefix="Live state:" />
        <AgentRoster agents={agents} selectedId={selectedId} actingId={highlightAgentId} onSelect={selectEntity} compact />
      </aside>

      <Splitter
        orientation="vertical"
        label="Resize session panel"
        className="splitter-rail"
        value={layout.railW}
        min={MIN_RAIL_W}
        max={layout.railMax}
        direction={-1}
        onChange={layout.setRailW}
        onReset={() => layout.resetPart("rail")}
      />

      <div className="workspace-stage">
        <aside id="replay-panel" className="replay-sidebar" aria-label="Replay and history">
          <div className="workspace-panel-head"><strong>Replay & history</strong><button type="button" className="btn btn-small" aria-label="Hide replay panel" title="Hide replay panel" onClick={() => { setReplayPanelOpen(false); document.getElementById("replay-panel-toggle")?.focus(); }}>‹</button></div>
        <div className="board-timeline">
          <Timeline
            turns={index.turns}
            liveTurnId={status.current_turn_id}
            viewTurnId={viewTurnId}
            loading={viewTurnId !== null && history.loading}
            loadError={viewTurnId !== null ? history.error : index.error}
            name={name}
            parent={viewed.parent}
            onView={navigateHistory}
            playing={playback.playing}
            suspended={playback.suspended}
            replayIntervalMs={playback.intervalMs}
            onReplay={playback.start}
            onStopReplay={playback.stop}
            onReplayOne={playback.replayOne}
            onReplayInterval={playback.setIntervalMs}
            onOpenParent={(parent) => navigate({ name: "run", runId: parent.run_id, turnId: parent.turn_id })}
          />
        </div>
          {mapViewMode === "3d" ? <div className="camera-quick-guide" aria-label="3D navigation guide">
            <strong>Move around the board</strong>
            <span>Click the board first, then:</span>
            <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>Move</span></div>
            <div><kbd>Space</kbd><span>Up</span><kbd>Shift</kbd><span>Down</span></div>
            <span>Drag to look · right-drag to pan<br />Mouse wheel to zoom</span>
          </div> : null}
        </aside>
      <main className="run-center" aria-label="World map">
        {/* The 2D map stays mounted (hidden) while the 3D view is shown, so its zoom and pan survive the switch. */}
        <div className="map-2d-host" hidden={mapViewMode === "3d"}>
          <MapView
            map={viewed.map}
            entities={entities}
            removed={removed}
            selectedPoint={displaySelectedPoint}
            selectedEntityId={selectedId}
            onSelectPoint={selectPoint}
            onSelectEntity={selectOccupant}
            highlightAgentId={highlightAgentId}
            rules={viewed.rules}
            fill
            persistKey="run"
            agentView={agentView}
            agentViewOverlay={agentViewOverlay}
            effects={effects}
            turnId={viewed.turn.turn_id}
            replayToken={playback.token}
            replayDurationMs={viewTurnId !== null ? Math.min(1400, playback.intervalMs * 0.7) : undefined}
            pendingAgentId={pendingAgentId}
          />
        </div>
        {mapViewMode === "3d" ? (
          <Map3dLoader
            map={viewed.map}
            entities={entities}
            removed={removed}
            selectedPoint={displaySelectedPoint}
            selectedEntityId={selectedId}
            onSelectPoint={selectPoint}
            onSelectEntity={selectOccupant}
            highlightAgentId={highlightAgentId}
            rules={viewed.rules}
            persistKey="run"
            agentView={agentView}
            agentViewOverlay={agentViewOverlay}
            effects={effects}
            turnId={viewed.turn.turn_id}
            replayToken={playback.token}
            replayDurationMs={viewTurnId !== null ? Math.min(1400, playback.intervalMs * 0.7) : undefined}
            live={viewTurnId === null}
            paused={record !== null}
            onBackTo2d={() => setMapViewMode("2d")}
          />
        ) : null}
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
      </div>

      <Splitter
        orientation="vertical"
        label="Resize inspector panel"
        className="splitter-side"
        value={layout.sideW}
        min={MIN_SIDE_W}
        max={layout.sideMax}
        direction={-1}
        onChange={layout.setSideW}
        onReset={() => layout.resetPart("side")}
      />

      <section id="workspace-panel-inspect" className="run-side" aria-label="Inspector and records">
        <div className="workspace-panel-head"><strong>Inspector & tools</strong><button type="button" className="btn btn-small" onClick={closeWorkspacePanel} aria-label="Close inspector panel">Close ×</button></div>
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
            title={tab === "god" || tab === "rules" ? "This tab always uses the wide panel" : "Widen this panel over the board"}
            onClick={() => setWideSide((w) => !w)}
          >
            {sideWideNow ? "⇥" : "⇤"}
          </button>
        </div>

        <div role="tabpanel" id="panel-inspect" aria-labelledby="tab-inspect" hidden={tab !== "inspect"} className="side-panel area-side">
          <FindBar onFindEntity={findEntityById} onFindPoint={findPoint} />
          <OccupantList
            point={displaySelectedPoint}
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
                <button type="button" className="btn btn-small" onClick={() => { setSelectedId(null); setAgentView(false); }}>
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
                onViewTurn={(turnId) => navigateHistory(turnId === status.current_turn_id ? null : turnId)}
              />
            ) : null}
            <InspectorPanel
              entity={selectedEntity}
              turn={viewed}
              rules={rules.data ?? viewed.rules}
              agentView={agentView}
              beliefPosition={agentViewOverlay?.believedPosition ?? null}
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
              onViewTurn={(turnId) => navigateHistory(turnId === status.current_turn_id ? null : turnId)}
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
        orientation="vertical"
        label="Resize the live activity log"
        className="splitter-log"
        value={layout.logW}
        min={MIN_LOG_W}
        max={layout.logWMax}
        direction={-1}
        disabled={logCollapsed}
        onChange={layout.setLogW}
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
          onViewTurn={(turnId) => navigateHistory(turnId === status.current_turn_id ? null : turnId)}
          onOpen={openRecord}
          onStage={onStage}
        />
      ) : null}

      <div id="workspace-panel-activity" className="run-log">
        <div className="workspace-panel-head"><strong>Activity log</strong><button type="button" className="btn btn-small" onClick={closeWorkspacePanel} aria-label="Close activity panel">Close ×</button></div>
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
 * the utility panel its tab content scrolls independently of the board.
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
