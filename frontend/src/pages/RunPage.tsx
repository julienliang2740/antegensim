/**
 * The run page (spec "Sessions and run controls" and "Display and historical
 * inspection"; INTERFACES sections 3, 7, 9, 10, 11).
 *
 * Top: run controls (first, so status changes never move them), the status
 * bar and the history timeline.  Left: tabs for the map with occupants and
 * inspector, the viewed turn's record, god mode and the read-only
 * rules/settings.  Right: the live activity log, which keeps running while an
 * older turn is viewed (a bottom drawer on narrow screens).
 *
 * Map tab (spec U1/U2 "selection opens a detailed inspector"): the map and the
 * always-visible roster / entity index on the left; on the right a column
 * that stays in view (sticky, scrolling on its own) with the occupants of the
 * selected point and the inspector.  When the tab is too narrow for two
 * columns the inspector follows the map and a selection scrolls it into view.
 *
 * Data flow: useRunFeed holds the run open and polls status + events;
 * everything that only changes at a commit (live checkpoint, settings, rules,
 * staged edits, turn index) reloads when status.current_turn_id changes;
 * historical checkpoints, knowledge, packets and model calls load on demand.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ActivityLog } from "../components/run/ActivityLog";
import { AgentShortcuts } from "../components/run/AgentShortcuts";
import { AgentRoster, EntityIndex } from "../components/run/EntityLists";
import { FindBar } from "../components/run/FindBar";
import { GodModeTab } from "../components/run/GodModeTab";
import { RecordViewer } from "../components/run/RecordViewer";
import type { RecordTarget } from "../state/records";
import { discardedAttemptSeqs, latestFailedTurn } from "../state/feed";
import { RulesTab } from "../components/run/RulesTab";
import { RunControls } from "../components/run/RunControls";
import { SpeciesRulePanel } from "../components/run/SpeciesRulePanel";
import { StatusBar } from "../components/run/StatusBar";
import { Timeline } from "../components/run/Timeline";
import { TurnRecordTab } from "../components/run/TurnRecordTab";
import { ErrorLine } from "../components/common/Problems";
import { PageHeader } from "../components/common/PageHeader";
import { useFetched } from "../hooks/useFetched";
import { navigate } from "../hooks/useHashRoute";
import { useHistoryView, useTurnIndex } from "../hooks/useRunData";
import { useRunFeed } from "../hooks/useRunFeed";
import { useThrottledKey } from "../hooks/useThrottledKey";
import { errorText, withReopen } from "../state/runSessions";
import { allModelsFake, controlAvailability, isIdle } from "../state/statusText";

type Tab = "map" | "turn" | "god" | "rules";

/** Minimum time between commit-driven reloads while the run is busy. */
const COMMIT_REFRESH_MS = 1000;

/** Window width from which the map tab opens with the wide inspector column (usability review: no sideways scrolling at 1440 px). */
const WIDE_INSPECTOR_MIN_WIDTH = 1360;

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
  const [tab, setTab] = useState<Tab>("map");
  const [selectedPoint, setSelectedPoint] = useState<Point | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentView, setAgentView] = useState(false);
  const [wideInspector, setWideInspector] = useState(() => typeof window !== "undefined" && window.innerWidth >= WIDE_INSPECTOR_MIN_WIDTH);
  // Lines of a discarded attempt of a saved turn (INTERFACES section 8): known once the saved turn's event range arrives.
  const [discardedSeqs, setDiscardedSeqs] = useState<ReadonlySet<number>>(() => new Set());
  const [record, setRecord] = useState<RecordTarget | null>(null);
  const [inFlight, setInFlight] = useState<RunCommand | null>(null);
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
  const shownTurnId = viewTurnId ?? liveTurnId ?? "";

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
  const reveal = () => setRevealTick((n) => n + 1);
  useEffect(() => {
    if (revealTick === 0) return;
    const frame = requestAnimationFrame(() => revealInspector(inspectorRef.current));
    return () => cancelAnimationFrame(frame);
  }, [revealTick]);

  const selectEntity = (id: string) => {
    const entity = (viewed ? findEntity(viewed.entities, id) : undefined) ?? (live.data ? findEntity(live.data.entities, id) : undefined);
    setSelectedId(id);
    if (entity) setSelectedPoint(entity.position);
    reveal();
  };

  /** An occupant row or a single-occupant map cell: the point is already selected. */
  const selectOccupant = (id: string) => {
    setSelectedId(id);
    reveal();
  };

  /** A map click or "Select point": a selection that is not at the new point is cleared, so the column shows that point. */
  const selectPoint = (p: Point) => {
    setSelectedPoint(p);
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
    if (here.length === 1) selectOccupant(here[0].id);
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

  const allowed = controlAvailability(status, inFlight !== null);
  const highlightAgentId = viewTurnId === null && status.active_turn_id ? status.acting_agent_id : viewed.turn.acting_agent_id;
  const selectedTerrain = selectedPoint ? (viewed.map.cells[pointKey(selectedPoint)] ?? (inRegion(selectedPoint) ? "land" : null)) : null;
  const committedSeq = live.data && live.data.turn.turn_id === status.current_turn_id ? live.data.turn.event_seq_end : null;
  const stagedList = staged.data?.staged ?? [];
  const runName = summary.data?.name ?? runId;
  const parentRun = summary.data?.parent ?? null;
  const workingDir = summary.data?.run_dir ? `${summary.data.run_dir.replace(/[\\/]+$/, "")}/working/` : `worlds/${status.world_id}/runs/${runId}/working/`;
  const failedTurn = status.last_error ? latestFailedTurn(feed.events, committedSeq) : null;
  const allFake = allModelsFake(live.data?.settings ?? null, models.data);

  const tabs: { id: Tab; label: string }[] = [
    { id: "map", label: "Map & inspector" },
    { id: "turn", label: `Turn record (${shownTurnId})` },
    { id: "god", label: `God mode${stagedList.length ? ` (${stagedList.length} staged)` : ""}` },
    { id: "rules", label: "Rules & settings" },
  ];

  return (
    <div className="page run-page">
      <div className="run-main">
        <div className="run-left">
          <PageHeader
            title={runName}
            subtitle={
              <>
                run <code>{runId}</code> · world <code>{status.world_id}</code>
                {parentRun ? (
                  <>
                    {" "}
                    · continuation of <code>{parentRun.run_id}</code> from turn <code>{parentRun.turn_id}</code>
                  </>
                ) : null}
              </>
            }
          />
          <RunControls allowed={allowed} inFlight={inFlight} error={commandError} onCommand={(c) => void send(c)} />
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
          {record ? (
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
          ) : null}
          <div className="tabs" role="tablist" aria-label="Run views">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`panel-${t.id}`}
                className={`tab${tab === t.id ? " tab-active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div role="tabpanel" id="panel-map" aria-labelledby="tab-map" hidden={tab !== "map"} className={`map-tab${wideInspector ? " map-tab-wide-side" : ""}`}>
            <div className="area-find">
              <FindBar onFindEntity={findEntityById} onFindPoint={findPoint} />
            </div>
            <div className="area-map">
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
                heightPx={480}
                agentView={agentView}
                agentViewOverlay={agentViewOverlay}
              />
            </div>
            <div className="area-side">
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
                    <button type="button" className="btn btn-small inspector-width-toggle" aria-pressed={wideInspector} onClick={() => setWideInspector((w) => !w)}>
                      {wideInspector ? "Narrower inspector" : "Wider inspector"}
                    </button>
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
                  knowledge={knowledgeView}
                  settings={settings.data}
                  rules={rules.data ?? viewed.rules}
                  onOpenModelCall={(callId) => openRecord({ kind: "call", turnId: viewed.turn.turn_id, callId })}
                  onOpenPacket={(packetId) => openRecord({ kind: "packet", turnId: viewed.turn.turn_id, packetId })}
                  agentView={agentView}
                  onToggleAgentView={() => setAgentView((v) => !v)}
                />
                {knowledge.error && selectedAgentId ? <ErrorLine text={knowledge.error} prefix="Knowledge:" /> : null}
                {selectedEntity?.kind === "plant" && live.data ? (
                  <SpeciesRulePanel
                    key={selectedEntity.species}
                    species={selectedEntity.species}
                    liveRule={(rules.data ?? live.data.rules).plant_species[selectedEntity.species] ?? null}
                    stageIndex={selectedEntity.stage_index}
                    onStage={onStage}
                  />
                ) : null}
              </div>
            </div>
            <div className="area-lists">
              <AgentRoster agents={agents} selectedId={selectedId} actingId={highlightAgentId} onSelect={selectEntity} />
              <EntityIndex entities={others} selectedId={selectedId} onSelect={selectEntity} />
            </div>
          </div>

          <div role="tabpanel" id="panel-turn" aria-labelledby="tab-turn" hidden={tab !== "turn"}>
            {/* Mounted only while shown: its event lines would otherwise duplicate the live log's text in the page. */}
            {tab === "turn" ? <TurnRecordTab view={viewed} name={name} onOpen={openRecord} /> : null}
          </div>

          <div role="tabpanel" id="panel-god" aria-labelledby="tab-god" hidden={tab !== "god"}>
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

          <div role="tabpanel" id="panel-rules" aria-labelledby="tab-rules" hidden={tab !== "rules"}>
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
        </div>

        <aside className="run-right">
          <ActivityLog
            events={feed.events}
            status={status}
            committedSeq={committedSeq}
            viewTurnId={viewTurnId}
            discardedSeqs={discardedSeqs}
            resets={feed.resets}
            pollError={feed.pollError}
          />
        </aside>
      </div>
    </div>
  );
}

/**
 * Scroll the inspector into view if its top is not comfortably visible.  In
 * the two-column map tab the side column scrolls on its own: it is reset to
 * its top (occupants, then the inspector) and, when needed, the page aligns
 * the column (and the map beside it) with the top of the window.  In the
 * one-column layout the page scrolls to the inspector itself.
 */
function revealInspector(block: HTMLElement | null): void {
  if (!block) return;
  const column = block.closest<HTMLElement>(".area-side");
  const ownScroll = column !== null && getComputedStyle(column).overflowY === "auto" && column.scrollHeight > column.clientHeight;
  if (column && ownScroll) column.scrollTop = 0;
  const top = block.getBoundingClientRect().top;
  // "Visible" = the inspector starts in the upper part of the window, so its first facts can be read.
  const visible = top >= 0 && top <= window.innerHeight * 0.62;
  if (visible) return;
  if (column && getComputedStyle(column).overflowY === "auto") column.scrollIntoView({ block: "start" });
  else block.scrollIntoView({ block: "start" });
}
