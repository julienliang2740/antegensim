/**
 * Pure data helpers for the inspection components (no React, no fetch).
 *
 * Exported through index.ts so the shell can reuse them (for example
 * `flattenEntities(turn.entities)` to build MapView's `entities` prop).
 */

import type {
  ApiProblem,
  ContextOverrides,
  ContextSettings,
  EffectiveSettingsView,
  Entity,
  EntitiesView,
  EntityKind,
  Intervention,
  InterventionRecord,
  ObservedEntity,
  Point,
  RemovedEntity,
  RulesConfig,
  RunSettings,
  TurnView,
} from "../../api/types";
import { findEntity, pointKey } from "../../api/types";
import { compareEntities, entityOneLine, entityTitle, fmtPoint, fmtValue, isDead } from "./format";
import type { AgentViewOverlay } from "./props";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Every entity of an EntitiesView (dead agents and plants included), sorted by kind then id. */
export function flattenEntities(view: EntitiesView): Entity[] {
  const all: Entity[] = [
    ...Object.values(view.agents),
    ...Object.values(view.plants),
    ...Object.values(view.fruits),
    ...Object.values(view.seeds),
    ...Object.values(view.residues),
  ];
  return all.sort(compareEntities);
}

/** The removed-entity records of an EntitiesView as a list. */
export function removedList(view: EntitiesView): RemovedEntity[] {
  return Object.values(view.removed);
}

/** Group entities by their "x,y" key, each group sorted (living agents first). */
export function groupByPoint(entities: readonly Entity[]): Map<string, Entity[]> {
  const groups = new Map<string, Entity[]>();
  for (const entity of entities) {
    const key = pointKey(entity.position);
    const list = groups.get(key);
    if (list) list.push(entity);
    else groups.set(key, [entity]);
  }
  for (const list of groups.values()) list.sort(compareEntities);
  return groups;
}

/** Group removed-entity records by "x,y". */
export function groupRemovedByPoint(removed: readonly RemovedEntity[]): Map<string, RemovedEntity[]> {
  const groups = new Map<string, RemovedEntity[]>();
  for (const r of removed) {
    const key = pointKey(r.position);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  return groups;
}

/** Entities standing on `point` (dead included), sorted for display. */
export function entitiesAtPoint(entities: readonly Entity[], point: { x: number; y: number } | null): Entity[] {
  if (!point) return [];
  return entities.filter((e) => e.position.x === point.x && e.position.y === point.y).sort(compareEntities);
}

// ---------------------------------------------------------------------------
// Presence in the viewed turn (spec "Display and historical inspection":
// preserve entity selection across history, indicate before-birth/after-death)
// ---------------------------------------------------------------------------

export type PresenceStatus = "no_turn" | "present" | "dead" | "removed" | "before_birth" | "absent";

export interface Presence {
  status: PresenceStatus;
  /** The entity as recorded in the viewed turn (null when it is not there). */
  inTurn: Entity | null;
  /** Short banner label ("Before birth", "After death", ...); empty when present and alive. */
  label: string;
  /** One sentence for the banner; empty when present and alive. */
  message: string;
}

/**
 * Where the selected entity stands in the viewed turn.  `entity` may come from
 * another turn (the shell keeps the selection while navigating history).
 * Order of checks: present (alive / dead) -> removed record -> created later -> absent.
 */
export function presenceInTurn(entity: Entity, turn: TurnView | null): Presence {
  if (!turn) return { status: "no_turn", inTurn: entity, label: "", message: "" };
  const round = turn.turn.round;
  const inTurn = findEntity(turn.entities, entity.id) ?? null;
  if (inTurn) {
    if ((inTurn.kind === "agent" || inTurn.kind === "plant") && !inTurn.alive) {
      const cause = inTurn.death_cause ? ` (cause: ${inTurn.death_cause})` : "";
      return {
        status: "dead",
        inTurn,
        label: "After death",
        message: `Died in round ${inTurn.died_round ?? "?"}${cause}. The record is kept at ${fmtPoint(inTurn.position)}.`,
      };
    }
    return { status: "present", inTurn, label: "", message: "" };
  }
  const removed = turn.entities.removed[entity.id];
  if (removed) {
    return {
      status: "removed",
      inTurn: null,
      label: "After removal",
      message: `Left the world in round ${removed.round} (reason: ${removed.reason}) at ${fmtPoint(removed.position)}. Showing the last known data.`,
    };
  }
  if (round < entity.created_round) {
    return {
      status: "before_birth",
      inTurn: null,
      label: "Before birth",
      message: `Created in round ${entity.created_round}; the viewed turn is round ${round}. Showing data from a later turn.`,
    };
  }
  if (round === entity.created_round) {
    return {
      status: "before_birth",
      inTurn: null,
      label: "Before birth",
      message: `Created later in round ${entity.created_round} than the viewed turn. Showing data from a later turn.`,
    };
  }
  return {
    status: "absent",
    inTurn: null,
    label: "Absent",
    message: `Not present in the viewed turn (${turn.turn.turn_id}). Showing the last known data.`,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** ContextOverrides.apply_to: non-null override fields replace the base. */
export function applyOverrides(base: ContextSettings, overrides: ContextOverrides | null | undefined): ContextSettings {
  if (!overrides) return base;
  return {
    input_token_cap: overrides.input_token_cap ?? base.input_token_cap,
    generation_allowance: overrides.generation_allowance ?? base.generation_allowance,
    recent_history_length: overrides.recent_history_length ?? base.recent_history_length,
    notebook_max_tokens: overrides.notebook_max_tokens ?? base.notebook_max_tokens,
    retrieved_memory_limit: overrides.retrieved_memory_limit ?? base.retrieved_memory_limit,
    new_event_digest_limit: overrides.new_event_digest_limit ?? base.new_event_digest_limit,
    weights: overrides.weights ?? base.weights,
    include_skill_source: overrides.include_skill_source ?? base.include_skill_source,
  };
}

/** True when an overrides object has no non-null field (an all-null override deletes it). */
export function overridesEmpty(overrides: ContextOverrides | null | undefined): boolean {
  if (!overrides) return true;
  return Object.values(overrides).every((v) => v === null || v === undefined);
}

export interface AgentSettingsSummary {
  modelKey: string;
  modelIsOverride: boolean;
  /** Effective context settings of the agent. */
  context: ContextSettings;
  /** The run-wide default context settings. */
  runContext: ContextSettings;
  overrides: ContextOverrides | null;
  /** Where the numbers come from, e.g. "live settings" or "settings as of turn r00002_end". */
  source: string;
}

/**
 * Model assignment and effective context of one agent.  RunSettings is the
 * source of truth (INTERFACES section 10).  For a historical turn the turn's
 * own settings snapshot is used so history shows the settings in effect then;
 * otherwise the live EffectiveSettingsView wins.
 */
export function agentSettings(
  agentId: string,
  turn: TurnView | null,
  live: EffectiveSettingsView | null,
): AgentSettingsSummary | null {
  const useTurn = turn !== null && (!turn.live || live === null);
  const settings: RunSettings | null = useTurn ? turn.settings : (live?.settings ?? null);
  if (!settings) return null;
  const override = settings.model_overrides[agentId];
  const overrides = settings.context_overrides[agentId] ?? null;
  let modelKey = override ?? settings.default_model_key;
  let context = applyOverrides(settings.context, overrides);
  if (!useTurn && live) {
    modelKey = live.effective_model_key[agentId] ?? modelKey;
    context = live.effective_context[agentId] ?? context;
  }
  return {
    modelKey,
    modelIsOverride: override !== undefined,
    context,
    runContext: settings.context,
    overrides,
    source: useTurn ? `settings as of turn ${turn.turn.turn_id}` : "live settings",
  };
}

// ---------------------------------------------------------------------------
// Dotted paths (set_stat)
// ---------------------------------------------------------------------------

/** Read a dotted path ("stats.compute") from a JSON-like object; undefined when missing. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Interventions
// ---------------------------------------------------------------------------

/** A staged item may arrive as a plain Intervention (GET /interventions) or a record. */
export type StagedItem = Intervention | InterventionRecord;

export function stagedIntervention(item: StagedItem): Intervention {
  return "intervention" in item ? item.intervention : item;
}

/** "iv_0003" -> 3; null when the id is missing or not in the iv_{seq} form. */
export function interventionSeq(id: string | null | undefined): number | null {
  if (!id) return null;
  const match = /^iv_(\d+)$/.exec(id);
  return match ? parseInt(match[1], 10) : null;
}

/** One readable line describing what an intervention will do. */
export function describeIntervention(iv: Intervention): string {
  switch (iv.type) {
    case "set_stat":
      return `set ${iv.entity_id}.${iv.field} = ${fmtValue(iv.value, 60)}`;
    case "place_entity": {
      const e = iv.entity;
      const label = e.kind === "agent" ? `agent "${e.name}"` : e.kind === "plant" || e.kind === "seed" ? `${e.kind} ${e.species}` : e.kind;
      return `place ${label} at ${fmtPoint(e.position)}${iv.model_key ? ` (model ${iv.model_key})` : ""}`;
    }
    case "remove_entity":
      return `remove ${iv.entity_id}`;
    case "edit_knowledge":
      if (iv.operation === "add_record") return `add ${iv.record?.kind ?? "?"} record to ${iv.agent_id}: ${fmtValue(iv.record?.text ?? "", 60)}`;
      if (iv.operation === "remove_record") return `remove record ${iv.record_id ?? "?"} from ${iv.agent_id}`;
      return `replace ${iv.agent_id}'s notebook (${(iv.notebook ?? "").length} chars)`;
    case "voice": {
      const r = iv.recipients;
      const to = r.mode === "agents" ? r.agent_ids.join(", ") || "(nobody)" : r.mode === "broadcast_all" ? "all living agents" : `living agents at ${fmtPoint(r.point)}`;
      return `voice to ${to}: ${fmtValue(iv.text, 60)}`;
    }
    case "update_context_settings": {
      const fields = Object.entries(iv.settings)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}=${fmtValue(v, 40)}`);
      const scope = iv.scope === "run" ? "run defaults" : `agent ${iv.scope}`;
      return `context settings for ${scope}: ${fields.length ? fields.join(", ") : "clear override (use run defaults)"}`;
    }
    case "update_plant_rules":
      return `replace species rule "${iv.species}" (${iv.rule.stages.length} stages)`;
    case "update_prices":
      return `replace prices: ${Object.entries(iv.prices)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`;
    case "update_model_assignment":
      return `model for ${iv.scope === "run" ? "run default" : `agent ${iv.scope}`}: ${iv.model_key ?? "(clear override, use run default)"}`;
    case "update_run_settings": {
      const parts: string[] = [];
      if (iv.clear_max_rounds) parts.push("max_rounds = no limit");
      else if (iv.max_rounds !== null && iv.max_rounds !== undefined) parts.push(`max_rounds = ${iv.max_rounds}`);
      if (iv.clear_real_budget) parts.push("real_budget_usd = no limit");
      else if (iv.real_budget_usd !== null && iv.real_budget_usd !== undefined) parts.push(`real_budget_usd = ${iv.real_budget_usd}`);
      if (iv.play_delay_seconds !== null && iv.play_delay_seconds !== undefined) parts.push(`play_delay_seconds = ${iv.play_delay_seconds}`);
      return `run settings: ${parts.join(", ") || "(no change)"}`;
    }
    case "apply_working_files":
      return `apply working/ files (base turn ${iv.base_turn_id}, ${iv.changes.length} changes)`;
  }
}

/**
 * Validation problems from a rejected onStage promise.  Accepts an
 * ApiClientError (client.ts: `.problems` getter / `.body.problems`) or any
 * object shaped like `{problems: ApiProblem[]}`; falls back to the message.
 */
export function problemsFromError(error: unknown): ApiProblem[] {
  if (error && typeof error === "object") {
    const withProblems = error as { problems?: unknown; body?: { problems?: unknown } | null; message?: unknown };
    const list = Array.isArray(withProblems.problems)
      ? withProblems.problems
      : Array.isArray(withProblems.body?.problems)
        ? withProblems.body.problems
        : [];
    const problems = list.filter(isProblem);
    if (problems.length > 0) return problems;
    if (typeof withProblems.message === "string" && withProblems.message) return [{ path: "", message: withProblems.message }];
  }
  return [{ path: "", message: String(error) }];
}

function isProblem(value: unknown): value is ApiProblem {
  return !!value && typeof value === "object" && typeof (value as ApiProblem).message === "string";
}

// ---------------------------------------------------------------------------
// Defensive readers for free-form JSON (KnowledgeRecord.content, ActionResult.data)
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}


// ---------------------------------------------------------------------------
// Map markers: what the map and the occupant list draw.  Omniscient view: the
// real entities.  Agent view: the agent's sightings at their last observed
// positions plus the agent itself at its believed position (spec "agent-view
// overlay shows only permitted information").
// ---------------------------------------------------------------------------

export interface MapMarker {
  id: string;
  kind: EntityKind;
  /** Dead agent/plant (omniscient), or "dead when queried" (agent view). */
  dead: boolean;
  /** True position (omniscient) or the position as last seen (agent view). */
  position: Point;
  /** "Aster (a01)", "p0003 fruit_tree", "f0012". */
  title: string;
  /** Quick stats (omniscient) or when/how it was seen (agent view). */
  line: string;
  /** Agent view: the viewing agent itself. */
  self?: boolean;
  /** Agent view: round of the sighting (for sorting and the tooltip). */
  observedRound?: number;
}

export function entityMarkers(entities: readonly Entity[], rules?: RulesConfig | null): MapMarker[] {
  return entities.map((e) => ({ id: e.id, kind: e.kind, dead: isDead(e), position: e.position, title: entityTitle(e), line: entityOneLine(e, rules) }));
}

/** "observed in round 3" / "queried in round 4 · alive then" — always a belief, never the true state. */
export function sightingLine(o: ObservedEntity): string {
  const how = o.source === "observation" ? "observed" : "queried";
  const life = o.alive === null ? "" : o.alive ? " · alive then" : " · dead then";
  return `${how} in round ${o.observed_round}${life} · at the position it was last seen`;
}

export function overlayMarkers(overlay: AgentViewOverlay): MapMarker[] {
  const markers: MapMarker[] = overlay.observed
    .filter((o) => o.id !== overlay.agentId)
    .map((o) => ({ id: o.id, kind: o.kind, dead: o.alive === false, position: o.position, title: `${o.id} ${o.kind}`, line: sightingLine(o), observedRound: o.observed_round }));
  if (overlay.believedPosition) {
    markers.push({
      id: overlay.agentId,
      kind: "agent",
      dead: false,
      position: overlay.believedPosition,
      title: `${overlay.agentName} (${overlay.agentId})`,
      line: "the viewing agent, at the position it believes it is at",
      self: true,
    });
  }
  return markers;
}

export function groupMarkersByPoint(markers: readonly MapMarker[]): Map<string, MapMarker[]> {
  const map = new Map<string, MapMarker[]>();
  for (const m of markers) {
    const key = pointKey(m.position);
    const list = map.get(key);
    if (list) list.push(m);
    else map.set(key, [m]);
  }
  return map;
}

export function markersAtPoint(markers: readonly MapMarker[], point: Point | null): MapMarker[] {
  if (!point) return [];
  return markers.filter((m) => m.position.x === point.x && m.position.y === point.y);
}
