/**
 * God-mode forms that change reality: set_stat, place_entity, remove_entity
 * (spec U8 "changing stats, placing removing objects"; INTERFACES section 10).
 * Changing reality never informs an agent by itself.
 */

import { useState } from "react";
import type {
  AgentStats,
  ApiProblem,
  ContextOverrides,
  Entity,
  EntityInput,
  EntityKind,
  Intervention,
  Point,
} from "../../../api/types";
import { FormRow, NumberInput } from "../common";
import { ContextSettingsEditor } from "../ContextSettingsEditor";
import { entityOneLine, fmtNum, fmtValue } from "../format";
import { getPath } from "../logic";
import { capabilitiesOf } from "./context";
import { AgentSelect, EntitySelect, FormShell, ModelSelect, PointFields } from "./shared";
import type { GodModeContext } from "./context";

// ---------------------------------------------------------------------------
// set_stat
// ---------------------------------------------------------------------------

type ValueType = "number" | "integer" | "boolean" | "text" | "point" | "species";

interface StatField {
  path: string;
  type: ValueType;
  hint?: string;
}

const AGENT_STAT_FIELDS: StatField[] = [
  { path: "stats.compute", type: "number" },
  { path: "stats.essence", type: "number", hint: "at most essence_capacity" },
  { path: "stats.essence_capacity", type: "number" },
  { path: "stats.health", type: "number", hint: "health ≤ 0 on a living agent kills it (cause operator)" },
  { path: "stats.max_health", type: "number" },
  { path: "stats.attack", type: "number" },
  { path: "stats.attack_cap", type: "number", hint: "most damage per attack" },
  { path: "stats.speed", type: "integer" },
  { path: "stats.vision_range", type: "integer" },
  { path: "stats.communication_range", type: "integer" },
  { path: "stats.compute_absorption", type: "number", hint: "0..1" },
  { path: "stats.essence_absorption", type: "number", hint: "0..1" },
  { path: "stats.skill_count_limit", type: "integer" },
  { path: "stats.skill_block_limit", type: "integer" },
  { path: "position", type: "point", hint: "not on a mountain" },
  { path: "alive", type: "boolean" },
  { path: "name", type: "text" },
  { path: "persona", type: "text", hint: "optional identity text shown to the agent" },
  { path: "wait_turns_remaining", type: "integer" },
];

/** set_stat paths offered per entity kind (a custom dotted path is always possible). */
const FIELDS_BY_KIND: Record<EntityKind, StatField[]> = {
  agent: AGENT_STAT_FIELDS,
  plant: [
    { path: "energy", type: "number" },
    { path: "essence", type: "number", hint: "≤ 0 does not kill by itself; attacks do" },
    { path: "stage_index", type: "integer" },
    { path: "age_rounds", type: "integer" },
    { path: "size", type: "number" },
    { path: "species", type: "species" },
    { path: "rounds_since_fruit", type: "integer" },
    { path: "rounds_since_seed", type: "integer" },
    { path: "position", type: "point", hint: "land only" },
    { path: "alive", type: "boolean" },
  ],
  fruit: [
    { path: "available_compute", type: "number" },
    { path: "available_essence", type: "number" },
    { path: "position", type: "point" },
  ],
  seed: [
    { path: "germinates_round", type: "integer" },
    { path: "species", type: "species" },
    { path: "position", type: "point", hint: "land only" },
  ],
  residue: [
    { path: "available_compute", type: "number" },
    { path: "available_essence", type: "number" },
    { path: "position", type: "point" },
  ],
};

const CUSTOM = "__custom__";

type StatValue = number | boolean | string | Point;

function initialValue(entity: Entity | null, field: StatField | null): StatValue {
  if (!entity || !field) return 0;
  const current = getPath(entity, field.path);
  if (field.type === "point") return current && typeof current === "object" ? (current as Point) : { x: 0, y: 0 };
  if (field.type === "boolean") return current === true;
  if (field.type === "text" || field.type === "species") return typeof current === "string" ? current : "";
  return typeof current === "number" ? current : 0;
}

export function SetStatForm(props: { ctx: GodModeContext }) {
  const { ctx } = props;
  const firstAgent = ctx.agents[0]?.id ?? ctx.entities[0]?.id ?? "";
  const [entityId, setEntityId] = useState(firstAgent);
  const entity = ctx.entities.find((e) => e.id === entityId) ?? null;
  const fields = entity ? FIELDS_BY_KIND[entity.kind] : [];
  const [fieldPath, setFieldPath] = useState(fields[0]?.path ?? CUSTOM);
  const field = fields.find((f) => f.path === fieldPath) ?? null;
  const [value, setValue] = useState<StatValue>(() => initialValue(entity, field));
  const [customPath, setCustomPath] = useState("");
  const [customJson, setCustomJson] = useState("");

  const chooseEntity = (id: string) => {
    const next = ctx.entities.find((e) => e.id === id) ?? null;
    setEntityId(id);
    const nextFields = next ? FIELDS_BY_KIND[next.kind] : [];
    const keep = nextFields.find((f) => f.path === fieldPath);
    const nextField = keep ?? nextFields[0] ?? null;
    setFieldPath(nextField ? nextField.path : CUSTOM);
    setValue(initialValue(next, nextField));
  };
  const chooseField = (path: string) => {
    setFieldPath(path);
    setValue(initialValue(entity, fields.find((f) => f.path === path) ?? null));
  };

  const currentValue = entity ? getPath(entity, fieldPath === CUSTOM ? customPath : fieldPath) : undefined;

  const submit = () => {
    if (!entity) return ctx.reject([{ path: "entity_id", message: "choose an entity" }]);
    let path = fieldPath;
    let newValue: unknown = value;
    if (fieldPath === CUSTOM) {
      path = customPath.trim();
      if (!path) return ctx.reject([{ path: "field", message: "enter a dotted field path, e.g. stats.compute" }]);
      try {
        newValue = JSON.parse(customJson);
      } catch {
        return ctx.reject([{ path: "value", message: "the value must be JSON (numbers plain, strings in double quotes)" }]);
      }
    } else if (field?.type === "text" && typeof value === "string" && field.path === "name" && !value.trim()) {
      return ctx.reject([{ path: "value", message: "name must not be empty" }]);
    }
    void ctx.stage([{ type: "set_stat", entity_id: entity.id, field: path, value: newValue }]);
  };

  return (
    <FormShell
      ctx={ctx}
      submitLabel="Stage stat change"
      onSubmit={submit}
      what="Changes one field of one entity (dotted path). The new record is re-validated; integer stats stay integers; a living agent left at health ≤ 0 dies (cause operator). Agents are not told."
    >
      <FormRow label="Entity" htmlFor="gm-ss-entity">
        <EntitySelect id="gm-ss-entity" entities={ctx.entities} value={entityId} onChange={chooseEntity} />
        {entity ? <div className="insp-hint">{entityOneLine(entity, ctx.rules)}</div> : null}
      </FormRow>
      <FormRow label="Field" htmlFor="gm-ss-field" hint={field?.hint}>
        <select id="gm-ss-field" value={fieldPath} onChange={(e) => chooseField(e.target.value)}>
          {fields.map((f) => (
            <option key={f.path} value={f.path}>
              {f.path}
            </option>
          ))}
          <option value={CUSTOM}>custom dotted path…</option>
        </select>
      </FormRow>
      {fieldPath === CUSTOM ? (
        <>
          <FormRow label="Dotted path" htmlFor="gm-ss-path" hint="e.g. upgrade_counts.speed">
            <input id="gm-ss-path" type="text" value={customPath} onChange={(e) => setCustomPath(e.target.value)} />
          </FormRow>
          <FormRow label="New value (JSON)" htmlFor="gm-ss-json">
            <input id="gm-ss-json" type="text" value={customJson} onChange={(e) => setCustomJson(e.target.value)} placeholder='e.g. 3 or "text" or {"x":1,"y":2}' />
          </FormRow>
        </>
      ) : (
        <FormRow label="New value" htmlFor="gm-ss-value">
          <StatValueInput field={field} value={value} onChange={setValue} speciesNames={Object.keys(ctx.rules.plant_species)} />
        </FormRow>
      )}
      <FormRow
        label="Current value"
        hint={typeof currentValue === "number" && fmtNum(currentValue) !== String(currentValue) ? `stored exactly as ${String(currentValue)}` : undefined}
      >
        <code>{typeof currentValue === "number" ? fmtNum(currentValue) : fmtValue(currentValue, 100)}</code>
      </FormRow>
    </FormShell>
  );
}

function StatValueInput(props: { field: StatField | null; value: StatValue; onChange(v: StatValue): void; speciesNames: string[] }) {
  const { field, value, onChange } = props;
  if (!field) return null;
  switch (field.type) {
    case "number":
    case "integer":
      return <NumberInput id="gm-ss-value" className="insp-num-wide" integer={field.type === "integer"} value={typeof value === "number" ? value : 0} onChange={onChange} />;
    case "boolean":
      return (
        <label>
          <input id="gm-ss-value" type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {value === true ? "true" : "false"}
        </label>
      );
    case "text":
      return <input id="gm-ss-value" type="text" className="insp-wide" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
    case "species":
      return (
        <select id="gm-ss-value" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}>
          {props.speciesNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      );
    case "point": {
      const p = typeof value === "object" && value !== null ? (value as Point) : { x: 0, y: 0 };
      return <PointFields idPrefix="gm-ss-value" value={p} onChange={onChange} />;
    }
  }
}

// ---------------------------------------------------------------------------
// place_entity
// ---------------------------------------------------------------------------

const STAT_KEYS: (keyof AgentStats)[] = [
  "compute",
  "essence",
  "essence_capacity",
  "health",
  "max_health",
  "attack",
  "attack_cap",
  "speed",
  "vision_range",
  "communication_range",
  "compute_absorption",
  "essence_absorption",
  "skill_count_limit",
  "skill_block_limit",
];

const INTEGER_STAT_KEYS = new Set<string>(["speed", "vision_range", "communication_range", "skill_count_limit", "skill_block_limit"]);

export function PlaceEntityForm(props: { ctx: GodModeContext }) {
  const { ctx } = props;
  const speciesNames = Object.keys(ctx.rules.plant_species);
  const [kind, setKind] = useState<EntityKind>("agent");
  const [point, setPoint] = useState<Point>(ctx.defaultPoint ?? { x: 0, y: 0 });
  // agent
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [useDefaultStats, setUseDefaultStats] = useState(true);
  const [templateId, setTemplateId] = useState(ctx.agents[0]?.id ?? "");
  const [stats, setStats] = useState<AgentStats | null>(ctx.agents[0] ? { ...ctx.agents[0].stats } : null);
  const [persona, setPersona] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [overrideContext, setOverrideContext] = useState(false);
  const [overrides, setOverrides] = useState<ContextOverrides | null>(null);
  // plant / seed
  const [species, setSpecies] = useState(speciesNames[0] ?? "");
  const [stageIndex, setStageIndex] = useState(0);
  const [germinatesRound, setGerminatesRound] = useState(0);
  // fruit / residue
  const [compute, setCompute] = useState(ctx.rules.plant_species[speciesNames[0] ?? ""]?.fruit_energy ?? 0);
  const [essence, setEssence] = useState(0);
  const [plantId, setPlantId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [sourceKind, setSourceKind] = useState<"agent" | "plant">("agent");

  const chooseTemplate = (id: string) => {
    setTemplateId(id);
    const template = ctx.agents.find((a) => a.id === id);
    if (template) setStats({ ...template.stats });
  };

  const submit = () => {
    let entity: EntityInput;
    const problems: ApiProblem[] = [];
    switch (kind) {
      case "agent":
        if (!name.trim()) problems.push({ path: "entity.name", message: "an agent needs a name" });
        if (agentId && !/^[A-Za-z0-9]{1,16}$/.test(agentId)) problems.push({ path: "entity.id", message: "id: 1-16 letters or digits (or leave empty)" });
        entity = {
          kind: "agent",
          id: agentId.trim(),
          name: name.trim(),
          position: point,
          persona,
          ...(useDefaultStats || !stats ? {} : { stats }),
        };
        break;
      case "plant":
        entity = { kind: "plant", id: "", position: point, species, stage_index: stageIndex };
        break;
      case "seed":
        entity = { kind: "seed", id: "", position: point, species, germinates_round: germinatesRound };
        break;
      case "fruit":
        entity = { kind: "fruit", id: "", position: point, available_compute: compute, available_essence: essence, plant_id: plantId || null };
        break;
      case "residue":
        if (!sourceId.trim()) problems.push({ path: "entity.source_id", message: "a residue needs a source id (who or what it came from)" });
        entity = {
          kind: "residue",
          id: "",
          position: point,
          source_id: sourceId.trim(),
          source_kind: sourceKind,
          available_compute: compute,
          available_essence: essence,
        };
        break;
    }
    if (problems.length > 0) return ctx.reject(problems);
    const intervention: Intervention = {
      type: "place_entity",
      entity,
      model_key: kind === "agent" && modelKey ? modelKey : null,
      context_overrides: kind === "agent" && overrideContext ? overrides : null,
    };
    void ctx.stage([intervention]);
  };

  const agentModel = modelKey || ctx.settings.default_model_key;

  return (
    <FormShell
      ctx={ctx}
      submitLabel={`Stage placement of a new ${kind}`}
      onSubmit={submit}
      what="Adds an entity (the backend assigns the id when empty). Plants and seeds need land; agents cannot stand on mountains. A placed agent gets a knowledge store with a run-start record and joins the next round's initiative. Nobody is told about the new entity."
    >
      <FormRow label="Kind" htmlFor="gm-pe-kind">
        <select id="gm-pe-kind" value={kind} onChange={(e) => setKind(e.target.value as EntityKind)}>
          <option value="agent">agent</option>
          <option value="plant">plant</option>
          <option value="fruit">fruit</option>
          <option value="seed">seed</option>
          <option value="residue">residue</option>
        </select>
      </FormRow>
      <FormRow label="Position" hint={ctx.defaultPoint ? `selected map point is (${ctx.defaultPoint.x}, ${ctx.defaultPoint.y})` : undefined}>
        <PointFields idPrefix="gm-pe-pos" value={point} onChange={setPoint} />
        {ctx.defaultPoint ? (
          <button type="button" className="insp-btn insp-btn-small" onClick={() => ctx.defaultPoint && setPoint(ctx.defaultPoint)}>
            use selected point
          </button>
        ) : null}
      </FormRow>

      {kind === "agent" ? (
        <>
          <FormRow label="Name (required)" htmlFor="gm-pe-name">
            <input id="gm-pe-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </FormRow>
          <FormRow label="Id (optional)" htmlFor="gm-pe-id" hint="empty = next free aNN id">
            <input id="gm-pe-id" type="text" value={agentId} onChange={(e) => setAgentId(e.target.value)} />
          </FormRow>
          <FormRow label="Starting stats">
            <label>
              <input type="checkbox" checked={useDefaultStats} onChange={(e) => setUseDefaultStats(e.target.checked)} /> use the backend defaults
            </label>
            {!useDefaultStats && stats ? (
              <div className="insp-stats-grid">
                <label>
                  copy from <AgentSelect agents={ctx.agents} value={templateId} onChange={chooseTemplate} />
                </label>
                {STAT_KEYS.map((key) => (
                  <label key={key} className="insp-stat-cell">
                    <span className="insp-fieldname">{key}</span>
                    <NumberInput integer={INTEGER_STAT_KEYS.has(key)} value={stats[key]} onChange={(n) => setStats({ ...stats, [key]: n })} />
                  </label>
                ))}
              </div>
            ) : null}
          </FormRow>
          <FormRow label="Persona (optional)" htmlFor="gm-pe-persona">
            <input id="gm-pe-persona" type="text" className="insp-wide" value={persona} onChange={(e) => setPersona(e.target.value)} />
          </FormRow>
          <FormRow label="Model" htmlFor="gm-pe-model">
            <ModelSelect id="gm-pe-model" models={ctx.models} value={modelKey} onChange={setModelKey} emptyLabel={`run default (${ctx.settings.default_model_key})`} />
          </FormRow>
          <FormRow label="Context settings">
            <label>
              <input
                type="checkbox"
                checked={overrideContext}
                onChange={(e) => {
                  setOverrideContext(e.target.checked);
                  if (!e.target.checked) setOverrides(null);
                }}
              />{" "}
              override the run defaults for this agent
            </label>
            {overrideContext ? (
              <ContextSettingsEditor
                value={ctx.settings.context}
                onChange={() => {}}
                overrides={overrides}
                onOverridesChange={setOverrides}
                capabilities={capabilitiesOf(ctx, agentModel)}
              />
            ) : null}
          </FormRow>
        </>
      ) : null}

      {kind === "plant" || kind === "seed" ? (
        <FormRow label="Species" htmlFor="gm-pe-species">
          <select id="gm-pe-species" value={species} onChange={(e) => setSpecies(e.target.value)}>
            {speciesNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </FormRow>
      ) : null}
      {kind === "plant" ? (
        <FormRow label="Stage index" htmlFor="gm-pe-stage" hint={ctx.rules.plant_species[species]?.stages.map((s, i) => `${i} = ${s.name}`).join(", ")}>
          <NumberInput id="gm-pe-stage" integer value={stageIndex} onChange={setStageIndex} />
        </FormRow>
      ) : null}
      {kind === "seed" ? (
        <FormRow label="Germinates round" htmlFor="gm-pe-germ">
          <NumberInput id="gm-pe-germ" integer value={germinatesRound} onChange={setGerminatesRound} />
        </FormRow>
      ) : null}
      {kind === "fruit" || kind === "residue" ? (
        <>
          <FormRow label="available_compute" htmlFor="gm-pe-compute">
            <NumberInput id="gm-pe-compute" value={compute} onChange={setCompute} />
          </FormRow>
          <FormRow label="available_essence" htmlFor="gm-pe-essence" hint={kind === "fruit" ? "fruit holds no essence by design" : undefined}>
            <NumberInput id="gm-pe-essence" value={essence} onChange={setEssence} />
          </FormRow>
        </>
      ) : null}
      {kind === "fruit" ? (
        <FormRow label="From plant (optional)" htmlFor="gm-pe-plant">
          <EntitySelect id="gm-pe-plant" entities={[...ctx.entities.filter((e) => e.kind === "plant")]} kinds={["plant"]} value={plantId} onChange={setPlantId} />
          {plantId ? (
            <button type="button" className="insp-btn insp-btn-small" onClick={() => setPlantId("")}>
              none
            </button>
          ) : null}
        </FormRow>
      ) : null}
      {kind === "residue" ? (
        <>
          <FormRow label="Source id" htmlFor="gm-pe-src">
            <input id="gm-pe-src" type="text" value={sourceId} onChange={(e) => setSourceId(e.target.value)} placeholder="e.g. a05 or p0003" />
          </FormRow>
          <FormRow label="Source kind" htmlFor="gm-pe-srckind">
            <select id="gm-pe-srckind" value={sourceKind} onChange={(e) => setSourceKind(e.target.value === "plant" ? "plant" : "agent")}>
              <option value="agent">agent</option>
              <option value="plant">plant</option>
            </select>
          </FormRow>
        </>
      ) : null}
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// remove_entity
// ---------------------------------------------------------------------------

export function RemoveEntityForm(props: { ctx: GodModeContext }) {
  const { ctx } = props;
  const [entityId, setEntityId] = useState("");
  const entity = ctx.entities.find((e) => e.id === entityId) ?? null;
  return (
    <FormShell
      ctx={ctx}
      submitLabel={entity ? `Stage removal of ${entity.id}` : "Stage removal"}
      onSubmit={() => (entity ? void ctx.stage([{ type: "remove_entity", entity_id: entity.id }]) : ctx.reject([{ path: "entity_id", message: "choose an entity" }]))}
      what="Removes an entity from the world (recorded as removed, reason operator). A removed agent's knowledge is kept and its scheduled turn is skipped. Nobody is told."
    >
      <FormRow label="Entity" htmlFor="gm-re-entity">
        <EntitySelect id="gm-re-entity" entities={ctx.entities} value={entityId} onChange={setEntityId} />
        {entity ? <div className="insp-hint">{entityOneLine(entity, ctx.rules)}</div> : null}
      </FormRow>
    </FormShell>
  );
}
