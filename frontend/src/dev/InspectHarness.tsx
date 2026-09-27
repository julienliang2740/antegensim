/**
 * Standalone harness for the inspection components (open the dev server with
 * `?harness=1`).  Renders MapView, OccupantList, InspectorPanel and
 * GodModePanel over fixture data with no backend, simulating the shell's
 * wiring: selection, history navigation (live vs an older turn), agent view,
 * and staging with backend-style validation problems.
 *
 * URL parameters (for screenshots): `point=x,y` preselects a point,
 * `entity=<id>` an entity, `turn=history` opens the older turn,
 * `agentView=1` turns the agent view on, `view=3d` renders the 3D view
 * (components/map3d) instead of the SVG map and `layers=2` stacks the older
 * fixture turn as a translucent layer below the shown one.
 */

import "./harness.css";
import { useMemo, useState } from "react";
import type { ApiProblem, Entity, Intervention, Point, TurnView } from "../api/types";
import { findEntity, parsePointKey, pointKey } from "../api/types";
import { GodModePanel, InspectorPanel, MapView, OccupantList, entitiesAtPoint, entityMarkers, flattenEntities, removedList } from "../components/inspect";
import type { AgentViewOverlay } from "../components/inspect";
import Map3dView from "../components/map3d/Map3dView";
import type { LayerInput } from "../components/map3d";
import { turnEffects } from "../state/turnEffects";
import { INITIAL_STAGED, MODELS, effectiveSettings, historyTurn, knowledgeFor, liveTurn } from "./fixtures";

/** Error shaped like client.ts ApiClientError (status + problems). */
class FakeApiError extends Error {
  status = 422;
  problems: ApiProblem[];
  constructor(problems: ApiProblem[]) {
    super(`invalid_intervention: ${problems.map((p) => p.message).join("; ")}`);
    this.problems = problems;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fixture turn as one board of the 3D view's stack. */
function layerOf(view: TurnView, label: string): LayerInput {
  const entities = flattenEntities(view.entities);
  return { id: view.turn.turn_id, label, map: view.map, markers: entityMarkers(entities, view.rules), entities: new Map(entities.map((e) => [e.id, e])) };
}

/** A few of the backend's staging checks, so the harness shows problem lists. */
function fakeValidate(iv: Intervention, turn: TurnView): ApiProblem[] {
  const terrainAt = (p: Point) => turn.map.cells[pointKey(p)] ?? null;
  if (iv.type === "place_entity") {
    const t = terrainAt(iv.entity.position);
    if (t === null) return [{ path: "entity.position", message: `(${iv.entity.position.x}, ${iv.entity.position.y}) is outside the region` }];
    if (iv.entity.kind === "agent" && t === "mountain") return [{ path: "entity.position", message: "agents cannot be placed on a mountain" }];
    if ((iv.entity.kind === "plant" || iv.entity.kind === "seed") && t !== "land") return [{ path: "entity.position", message: `plants and seeds need land, this cell is ${t}` }];
  }
  if (iv.type === "set_stat" && iv.field === "stats.health") {
    const target = turn.entities.agents[iv.entity_id];
    if (target && typeof iv.value === "number" && iv.value > target.stats.max_health) {
      return [{ path: "value", message: `health ${iv.value} is above max_health ${target.stats.max_health}` }];
    }
  }
  if (iv.type === "edit_knowledge" && iv.operation === "remove_record" && iv.record_id && !iv.record_id.startsWith(`${iv.agent_id}-k`)) {
    return [{ path: "record_id", message: `unknown record ${iv.record_id} for agent ${iv.agent_id}` }];
  }
  return [];
}

export function InspectHarness() {
  const params = new URLSearchParams(location.search);
  const live = useMemo(() => liveTurn(), []);
  const history = useMemo(() => historyTurn(), []);
  const effective = useMemo(() => effectiveSettings(), []);

  const [viewHistory, setViewHistory] = useState(params.get("turn") === "history");
  const [selectedPoint, setSelectedPoint] = useState<Point | null>(params.get("point") ? parsePointKey(params.get("point") ?? "0,0") : null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(params.get("entity"));
  const [agentView, setAgentView] = useState(params.get("agentView") === "1");
  const [staged, setStaged] = useState<Intervention[]>(INITIAL_STAGED);
  const [nextSeq, setNextSeq] = useState(7);
  const [godDisabled, setGodDisabled] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const view3d = params.get("view") === "3d";
  const twoLayers = params.get("layers") === "2";
  const turn = viewHistory ? history : live;
  const entities = useMemo(() => flattenEntities(turn.entities), [turn]);
  const effects = useMemo(() => turnEffects(turn), [turn]);
  const layers = useMemo(() => (twoLayers ? [layerOf(history, "Round 1 end"), layerOf(turn, turn.live ? "Live" : "Viewed turn")] : undefined), [twoLayers, history, turn]);
  const removed = useMemo(() => removedList(turn.entities), [turn]);
  const liveEntities = useMemo(() => flattenEntities(live.entities), [live]);
  const occupants = useMemo(() => entitiesAtPoint(entities, selectedPoint), [entities, selectedPoint]);

  // Keep the selection across history: prefer the viewed turn's record, else the live one.
  const selectedEntity: Entity | null = selectedEntityId
    ? (findEntity(turn.entities, selectedEntityId) ?? findEntity(live.entities, selectedEntityId) ?? null)
    : null;
  const knowledge = selectedEntity?.kind === "agent" ? knowledgeFor(selectedEntity.id, turn.turn.turn_id, turn.entities) : null;
  const agentViewOverlay: AgentViewOverlay | null =
    agentView && selectedEntity?.kind === "agent" && knowledge
      ? { agentId: selectedEntity.id, agentName: selectedEntity.name, believedPosition: knowledge.believed_self.position ?? null, observed: knowledge.observed_entities }
      : null;

  const note = (line: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 8));

  const onStage = async (iv: Intervention) => {
    await delay(150);
    const problems = fakeValidate(iv, live);
    if (problems.length > 0) throw new FakeApiError(problems);
    const id = `iv_${String(nextSeq).padStart(4, "0")}`;
    setNextSeq((n) => n + 1);
    setStaged((s) => [...s, { ...iv, id }]);
    note(`onStage(${iv.type}) -> ${id}`);
  };

  return (
    <div className="harness-page">
      <header className="harness-header">
        <strong>Inspect harness</strong> — fixture data, no backend.
        <label>
          <input type="checkbox" checked={viewHistory} onChange={(e) => setViewHistory(e.target.checked)} /> view history turn r00001_end (instead of live
          r00003_t02_a01)
        </label>
        <label>
          <input type="checkbox" checked={godDisabled} onChange={(e) => setGodDisabled(e.target.checked)} /> disable god mode
        </label>
        <span className="harness-log">{log[0] ?? "callbacks appear here"}</span>
      </header>

      <section className="harness-row harness-row-map" id="harness-map">
        <div className="harness-map" style={view3d ? { height: 600 } : undefined}>
          {view3d ? (
            <Map3dView
              map={turn.map}
              entities={entities}
              removed={removed}
              selectedPoint={selectedPoint}
              selectedEntityId={selectedEntityId}
              onSelectPoint={(p) => {
                setSelectedPoint(p);
                note(`onSelectPoint(${p.x}, ${p.y})`);
              }}
              onSelectEntity={(id) => {
                setSelectedEntityId(id);
                note(`onSelectEntity(${id})`);
              }}
              highlightAgentId={turn.turn.acting_agent_id}
              rules={turn.rules}
              agentView={agentView}
              agentViewOverlay={agentViewOverlay}
              effects={effects}
              turnId={turn.turn.turn_id}
              live={!viewHistory}
              paused={false}
              layers={layers}
              onBackTo2d={() => note("onBackTo2d()")}
            />
          ) : (
            <MapView
              map={turn.map}
              entities={entities}
              removed={removed}
              selectedPoint={selectedPoint}
              selectedEntityId={selectedEntityId}
              onSelectPoint={(p) => {
                setSelectedPoint(p);
                note(`onSelectPoint(${p.x}, ${p.y})`);
              }}
              onSelectEntity={(id) => {
                setSelectedEntityId(id);
                note(`onSelectEntity(${id})`);
              }}
              highlightAgentId={turn.turn.acting_agent_id}
              rules={turn.rules}
              agentView={agentView}
              agentViewOverlay={agentViewOverlay}
            />
          )}
        </div>
        <div className="harness-occupants">
          <OccupantList
            point={selectedPoint}
            occupants={occupants}
            selectedEntityId={selectedEntityId}
            onSelectEntity={(id) => {
              setSelectedEntityId(id);
              note(`onSelectEntity(${id})`);
            }}
            rules={turn.rules}
            terrain={selectedPoint ? (turn.map.cells[pointKey(selectedPoint)] ?? null) : null}
            agentView={agentView}
            agentViewOverlay={agentViewOverlay}
          />
        </div>
      </section>

      <section className="harness-row" id="harness-panels">
        <div className="harness-inspector" id="harness-inspector">
          <InspectorPanel
            entity={selectedEntity}
            turn={turn}
            rules={turn.rules}
            agentView={agentView}
            onToggleAgentView={() => setAgentView((v) => !v)}
            onOpenProfile={() => note(`onOpenProfile(${selectedEntity?.id ?? ""})`)}
          />
        </div>
        <div className="harness-godmode" id="harness-godmode">
          <GodModePanel
            agents={Object.values(live.entities.agents)}
            entities={liveEntities}
            rules={live.rules}
            settings={live.settings}
            effective={effective}
            models={MODELS}
            staged={staged}
            disabled={godDisabled}
            disabledReason={godDisabled ? "viewing history (harness toggle)" : null}
            defaultPoint={selectedPoint}
            viewedTurnId={turn.turn.turn_id}
            onStage={onStage}
            onDiscard={async (seq, id) => {
              await delay(100);
              setStaged((s) => s.filter((iv) => iv.id !== id));
              note(`onDiscard(${seq}, ${id})`);
            }}
            onReloadWorking={async () => {
              await delay(150);
              throw new FakeApiError([{ path: "working/entities/agents/a02.json", message: "line 4: invalid JSON (expected ',' or '}')" }]);
            }}
            onCreateContinuation={async () => {
              await delay(150);
              note(`onCreateContinuation(from ${turn.turn.turn_id})`);
            }}
          />
        </div>
      </section>
    </div>
  );
}
