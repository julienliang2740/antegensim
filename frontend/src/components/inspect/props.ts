/**
 * Props of the inspection components (map, occupant list, inspector, god mode,
 * plant-rule and context-settings editors).
 *
 * Contract with the app shell: these components never fetch.  The shell loads
 * data with src/api/client.ts, passes it in, and performs the callbacks.  All
 * types come from src/api/types.ts.  Requirements covered: spec U1 (point and
 * occupants), U2 (agent inspection), U3 (plant rules), U7 (voice), U8 (god
 * mode edits), U14 (clarity), U16 (context settings); spec sections "Display
 * and historical inspection" and "God mode and direct file editing";
 * INTERFACES.md sections 9 and 10.
 */

import type { Agent, ContextOverrides, ContextSettings, EffectiveSettingsView, Entity, FieldChange, Intervention, InterventionRecord, MapState, ModelCapabilities, ModelInfo, ObservedEntity, PlantSpeciesRule, Point, RemovedEntity, RulesConfig, RunSettings, Terrain, TurnView } from "../../api/types";
import type { ReactNode } from "react";
import type { TurnEffect } from "../../state/turnEffects";

/**
 * Agent view (spec "An optional agent-view overlay shows only permitted
 * information"): what one agent has observed, drawn on the map and listed at a
 * point INSTEAD of the omniscient entity list.  Built by the shell from the
 * agent's AgentKnowledgeView of the viewed turn.
 */
export interface AgentViewOverlay {
  agentId: string;
  agentName: string;
  /** Where the agent believes it is (BelievedSelf.position); null when its records disclose nothing yet. */
  believedPosition: Point | null;
  /** AgentKnowledgeView.observed_entities: each entity at the position the agent last saw it, with that round. */
  observed: ObservedEntity[];
}

/**
 * SVG grid of `map.region` with terrain, axes, one colour-coded dot per
 * occupant (one dot size per zoom level; a packed cell shows every dot tighter
 * plus a total-count badge; below 24 px cells a kind-coloured group tile whose
 * size grows with the count), pan (drag, arrow buttons, keyboard arrows), zoom
 * buttons, "Go to (x, y)" and a hover tooltip listing every occupant (the
 * hovered dot's row highlighted).  With `effects` and `turnId` the map draws
 * the viewed turn's action marks (state/mapIndicators.ts): a badge on the
 * acting agent, its move arrow, rings on the entities the turn touched, and
 * the caption in the status line.  Positions come from `entities`
 * (entity.position), so pass every entity of the viewed turn, dead included
 * (`flattenEntities(turn.entities)`).
 */
export interface MapViewProps {
  map: MapState;
  /** Every entity of the viewed turn, dead agents/plants included. */
  entities: Entity[];
  /** `Object.values(turn.entities.removed)`; listed in the tooltip, optional markers on the map. */
  removed?: RemovedEntity[];
  selectedPoint: Point | null;
  selectedEntityId: string | null;
  /** Called on a click (not a drag) inside the region and by "Go to". */
  onSelectPoint(p: Point): void;
  /** Called after onSelectPoint when a dot is clicked, or the clicked cell holds exactly one entity (one click opens it). */
  onSelectEntity(id: string): void;
  /** Ring drawn around this agent's dot (for example the acting agent). */
  highlightAgentId?: string | null;
  /** Optional: gives plant stage names in the tooltip (turn.rules). */
  rules?: RulesConfig | null;
  /** Height of the map viewport in px (default 520); the width follows the container. Ignored with `fill`. */
  heightPx?: number;
  /** Fill the container's height (the container must give the map a definite height); small regions open zoomed to fit. */
  fill?: boolean;
  /** Remember the legend's entity-kind toggles in localStorage under this key (not remembered when absent). */
  persistKey?: string;
  /** True while the inspector's agent view is on (with no overlay the map says it is still omniscient). */
  agentView?: boolean;
  /** Agent view: draw only this agent's sightings (at their last observed positions) and the agent at its believed position. */
  agentViewOverlay?: AgentViewOverlay | null;
  /** The viewed turn's effects (state/turnEffects.ts::turnEffects(viewed)), drawn as action marks (state/mapIndicators.ts). */
  effects?: readonly TurnEffect[];
  /** The viewed turn's id: keys the marks layer so its entrance animation plays once per turn change, and names the turn in the status line. */
  turnId?: string | null;
  /** Replay the same saved turn without changing its data. */
  replayToken?: number;
  /** Visual duration only; no relation to simulation timing. */
  replayDurationMs?: number;
  /** Live only: the agent whose turn is in progress (its dashed ring pulses); null when nothing is pending. */
  pendingAgentId?: string | null;
  /**
   * Rendered at the end of the legend's controls row (after **Key**).  The run page puts the "Map
   * view" switch here (and in the 3D view's legend), so the switch costs the board no row of its own.
   */
  legendExtra?: ReactNode;
}

/** Scrollable list of every entity at a point, grouped by kind, each row clickable. */
export interface OccupantListProps {
  point: Point | null;
  /** Entities at `point` (dead included), e.g. `entitiesAtPoint(entities, point)`. */
  occupants: Entity[];
  selectedEntityId: string | null;
  onSelectEntity(id: string): void;
  /** Optional: plant stage names (turn.rules). */
  rules?: RulesConfig | null;
  /** Terrain of the point, shown in the header when given (map.cells[pointKey(point)]). */
  terrain?: Terrain | null;
  /** True while the inspector's agent view is on (with no overlay the list says it is still omniscient). */
  agentView?: boolean;
  /** Agent view: list only this agent's sightings at `point` (and itself at its believed position) instead of `occupants`. */
  agentViewOverlay?: AgentViewOverlay | null;
}

/**
 * Compact summary of the selected entity in the Inspector tab, with the
 * Profile button that opens the full entity profile card.
 *
 * `entity` is the selection as last known (it may come from another turn:
 * the shell keeps selection while browsing history).  When `turn` is given the
 * panel shows the turn's own record of that id and a banner for before-birth,
 * after-death, removal or absence.
 */
export interface InspectorPanelProps {
  entity: Entity | null;
  turn: TurnView | null;
  /** Plant stage names in the summary line when no turn is loaded (turn.rules wins). */
  rules: RulesConfig | null;
  agentView: boolean;
  onToggleAgentView(): void;
  /** "Profile": open the entity profile card (components/profile) for `entity`. */
  onOpenProfile(): void;
}

/**
 * God-mode forms for every UI Intervention type (INTERFACES section 10), the
 * staged-edits list, "Reload working/ files" and "Create continuation".
 *
 * `onStage` must reject with the ApiClientError from stageIntervention (or any
 * `{problems: ApiProblem[]}` object); the problems are shown next to the form.
 * `staged` accepts the plain list from GET /interventions
 * (StagedInterventionsResponse.staged) or InterventionRecord objects.
 * `onDiscard(seq, id)`: seq is the number in the id "iv_0003" -> 3; `id` is
 * the full intervention id for client.unstageIntervention(runId, id).
 * `disabled` disables staging, discarding and reloading (the continuation
 * button stays enabled because it works from any recorded turn).
 */
export interface GodModePanelProps {
  agents: Agent[];
  /** Every entity of the live state (targets of set_stat / remove_entity). */
  entities: Entity[];
  rules: RulesConfig;
  settings: RunSettings;
  effective: EffectiveSettingsView | null;
  models: ModelInfo[];
  staged: ReadonlyArray<Intervention | InterventionRecord>;
  disabled: boolean;
  onStage(i: Intervention): Promise<void>;
  onDiscard(seq: number, id: string): Promise<void>;
  /** Resolves with the reload's before/after changes (shown under the success message) or nothing. */
  onReloadWorking(): Promise<FieldChange[] | void>;
  onCreateContinuation(): Promise<void>;
  /** Optional: prefills point fields (place entity, voice at point) with the selected map point. */
  defaultPoint?: Point | null;
  /** Optional: turn id the continuation button refers to (shown on the button). */
  viewedTurnId?: string | null;
  /** Optional: short reason shown when `disabled` is true. */
  disabledReason?: string | null;
  /**
   * Optional: where the run's working/ folder is, shown (with a copy button)
   * next to "Reload working/ files", e.g. "worlds/<world_id>/runs/<run_id>/working/".
   */
  workingDir?: string | null;
}

/**
 * Table editor for every field of every plant species and stage, with add /
 * remove species and stages.  Controlled: every edit calls onChange with a new
 * array.  `readOnly` renders the same tables without inputs.
 */
export interface PlantRulesEditorProps {
  species: PlantSpeciesRule[];
  onChange(s: PlantSpeciesRule[]): void;
  readOnly?: boolean;
  /**
   * Optional: edit the given species' values only — no Add / Duplicate /
   * Remove species and a read-only name (god mode replaces one species rule
   * and cannot rename, add or delete species, INTERFACES section 10).
   */
  fixedSpecies?: boolean;
  /** Optional: highlight one stage row (the inspected plant's current stage). */
  highlight?: { species: string; stageIndex: number } | null;
}

/**
 * Editor for ContextSettings with the spec's names and inline validation
 * against `capabilities` (context window, max output tokens).
 *
 * Plain mode (no onOverridesChange): edits `value` and calls onChange.
 * Override mode (onOverridesChange given): `value` is the run default; each
 * field has an "override" checkbox; edits call onOverridesChange with the new
 * overrides (null fields = use run default; null when nothing is overridden);
 * onChange is not called.
 */
export interface ContextSettingsEditorProps {
  value: ContextSettings;
  onChange(v: ContextSettings): void;
  overrides?: ContextOverrides | null;
  onOverridesChange?(o: ContextOverrides | null): void;
  capabilities?: ModelCapabilities | null;
  readOnly?: boolean;
  label?: string;
}
