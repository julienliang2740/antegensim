/**
 * Realistic fixture data for the inspection harness (no backend needed).
 *
 * A 21x21 region (-10..10) with mountain and water clusters, 8 agents (four
 * living agents plus one dead agent stacked on (0,0) with 3 plants, 2 fruit and
 * a residue), knowledge records of every kind, a saved skill with a resumable
 * execution state, staged interventions, a live TurnView and an older
 * historical TurnView (for before-birth / after-death indicators).  Shapes are
 * exactly src/api/types.ts; numbers follow the schema defaults.
 */

import type {
  Agent,
  AgentKnowledge,
  AgentKnowledgeView,
  AgentStats,
  ContextSettings,
  EffectiveSettingsView,
  EntitiesView,
  EntityKind,
  Event,
  Fruit,
  Instruction,
  Intervention,
  KnowledgeKind,
  KnowledgeRecord,
  MapState,
  ModelInfo,
  ObservedEntity,
  Plant,
  Point,
  Provenance,
  Residue,
  RulesConfig,
  RunSettings,
  Seed,
  SkillDefinition,
  Terrain,
  TurnView,
} from "../api/types";

// ---------------------------------------------------------------------------
// Rules (schema defaults, INTERFACES / schemas.RulesConfig)
// ---------------------------------------------------------------------------

export const RULES: RulesConfig = {
  prices: { move: 5, observe: 1, query: 1, send: 3, broadcast: 7, absorb: 3, transfer: 1, wait: 0 },
  upgrades: {
    standard_base_compute: 25,
    standard_base_essence: 2,
    standard_growth: 2,
    attack_base_compute: 100,
    attack_base_essence: 10,
    attack_growth: 4,
    increments: {
      essence_capacity: 20,
      max_health: 20,
      vision_range: 1,
      communication_range: 1,
      speed: 1,
      compute_absorption: 0.05,
      essence_absorption: 0.05,
      skill_count_limit: 1,
      skill_block_limit: 20,
      attack: 0.25,
    },
    hard_caps: { compute_absorption: 1, essence_absorption: 1 },
  },
  skills: {
    action_discount: 0.8,
    interpreter_cost_per_op: 0.01,
    max_ops_per_turn: 100,
    allow_recursion: false,
    max_call_depth: 16,
    max_repeat_count: 10000,
    max_source_chars: 4000,
    interrupt_on: [],
  },
  accounting: { eps: 1e-9, failure_fee_cap: 1 },
  upkeep: { compute_per_round: 1, starvation_health_loss: 5 },
  recovery: { health_per_compute: 1 },
  cognition: {
    input_rate: 0.0002,
    generation_rate: 0.001,
    default_mind_multiplier: 1,
    mind_multipliers: { "fake-heuristic": 1, "fake-scripted": 1, "anthropic-haiku": 1.5 },
    usage_estimate_safety_factor: 1,
    charge_failed_calls: true,
  },
  messages: { max_message_tokens: 256, chars_per_token: 4 },
  death: { essence_residue_fraction: 0.4, compute_residue_fraction: 0.5, residue_decay_per_round: 0 },
  ranges: {
    absorb_requires_same_point: true,
    transfer_requires_same_point: true,
    attack_requires_same_point: true,
    observe_uses_vision_range: true,
    query_uses_vision_range: true,
    outside_region_is_blocked: true,
  },
  plant_species: {
    fruit_tree: {
      name: "fruit_tree",
      description: "Default deterministic fruit/seed plant. Sprout -> sapling -> mature; mature plants keep fruiting.",
      stages: [
        { name: "sprout", min_age_rounds: 0, size: 1, energy_inflow_per_round: 2, essence_inflow_per_round: 0.2, max_energy: 60, max_essence: 10, fruit_interval_rounds: 0, seed_interval_rounds: 0 },
        { name: "sapling", min_age_rounds: 5, size: 2, energy_inflow_per_round: 6, essence_inflow_per_round: 0.5, max_energy: 120, max_essence: 25, fruit_interval_rounds: 8, seed_interval_rounds: 0 },
        { name: "mature", min_age_rounds: 15, size: 3, energy_inflow_per_round: 12, essence_inflow_per_round: 1, max_energy: 180, max_essence: 60, fruit_interval_rounds: 5, seed_interval_rounds: 20 },
      ],
      initial_essence: 5,
      max_fruit: 3,
      fruit_energy: 60,
      fruit_decay_rounds: 0,
      seed_germination_delay_rounds: 10,
      seed_dispersal_radius: 1,
      max_seeds_alive: 2,
      essence_residue_fraction: 0.5,
      energy_residue_fraction: 0,
    },
    berry_bush: {
      name: "berry_bush",
      description: "Small fast bush (example second species).",
      stages: [
        { name: "shoot", min_age_rounds: 0, size: 0.5, energy_inflow_per_round: 3, essence_inflow_per_round: 0.1, max_energy: 40, max_essence: 5, fruit_interval_rounds: 0, seed_interval_rounds: 0 },
        { name: "bush", min_age_rounds: 3, size: 1, energy_inflow_per_round: 5, essence_inflow_per_round: 0.3, max_energy: 80, max_essence: 12, fruit_interval_rounds: 3, seed_interval_rounds: 12 },
      ],
      initial_essence: 2,
      max_fruit: 2,
      fruit_energy: 25,
      fruit_decay_rounds: 6,
      seed_germination_delay_rounds: 6,
      seed_dispersal_radius: 2,
      max_seeds_alive: 2,
      essence_residue_fraction: 0.5,
      energy_residue_fraction: 0,
    },
  },
};

// ---------------------------------------------------------------------------
// Map: region -10..10 with mountain and water clusters; origin kept clear
// ---------------------------------------------------------------------------

const REGION = { min_x: -10, max_x: 10, min_y: -10, max_y: 10 };

function terrainFor(x: number, y: number): Terrain {
  const d = (cx: number, cy: number) => Math.abs(x - cx) + Math.abs(y - cy);
  if (Math.abs(x) + Math.abs(y) <= 2) return "land";
  if (d(-6, 6) <= 2 || d(7, 8) <= 1 || (y === -1 && x >= 4 && x <= 7) || d(-3, -7) <= 1) return "mountain";
  if (d(6, 3) <= 1 || (x === -8 && y <= -2) || (x === -9 && y <= -5) || d(2, -7) <= 1 || (y === 9 && x <= -2 && x >= -5)) return "water";
  return "land";
}

function buildCells(): Record<string, Terrain> {
  const cells: Record<string, Terrain> = {};
  for (let x = REGION.min_x; x <= REGION.max_x; x++) {
    for (let y = REGION.min_y; y <= REGION.max_y; y++) cells[`${x},${y}`] = terrainFor(x, y);
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const BASE_STATS: AgentStats = {
  compute: 200,
  essence: 20,
  essence_capacity: 100,
  health: 100,
  max_health: 100,
  attack: 1,
  speed: 1,
  vision_range: 0,
  communication_range: 0,
  compute_absorption: 0.2,
  essence_absorption: 0.1,
  skill_count_limit: 5,
  skill_block_limit: 100,
};

function agent(id: string, name: string, position: Point, stats: Partial<AgentStats>, extra: Partial<Agent> = {}): Agent {
  return {
    kind: "agent",
    id,
    name,
    position,
    stats: { ...BASE_STATS, ...stats },
    upgrade_counts: {},
    persona: "",
    alive: true,
    created_round: 0,
    died_round: null,
    death_cause: null,
    skills: {},
    skill_execution: null,
    wait_turns_remaining: 0,
    last_action: null,
    last_result: null,
    total_compute_spent: 0,
    total_cognition_spent: 0,
    total_interpreter_spent: 0,
    model_call_count: 0,
    ...extra,
  };
}

const FORAGE_SOURCE = [
  "SET observation = observe(here)",
  "IF observation.ok == false",
  "    RETURN observation.reason",
  "END",
  "FOR_EACH entity IN observation.data.entities",
  '    IF entity.kind == "fruit"',
  "        SET fruit_details = query(entity.id)",
  "        IF fruit_details.ok == true",
  "            IF fruit_details.data.available_compute > 0",
  '                SET absorption_result = absorb(entity.id, "compute")',
  "                IF absorption_result.ok == true",
  "                    RETURN absorption_result",
  "                END",
  "            END",
  "        END",
  "    END",
  "END",
  'RETURN "no_food_absorbed"',
].join("\n");

function ins(op: Instruction["op"], line: number, extra: Partial<Instruction> = {}): Instruction {
  return { op, var: null, expr: null, args: [], target: null, loop_kind: null, skill: null, line, ...extra };
}

/** Compiled layout of FORAGE_SOURCE (INTERFACES 4.2 layouts); expressions omitted in the fixture. */
const FORAGE_COMPILED: Instruction[] = [
  ins("set", 1, { var: "observation" }),
  ins("jump_if_false", 2, { target: 3 }),
  ins("return", 3),
  ins("loop_start", 5, { loop_kind: "for_each", var: "entity", target: 13 }),
  ins("jump_if_false", 6, { target: 12 }),
  ins("set", 7, { var: "fruit_details" }),
  ins("jump_if_false", 8, { target: 12 }),
  ins("jump_if_false", 9, { target: 12 }),
  ins("set", 10, { var: "absorption_result" }),
  ins("jump_if_false", 11, { target: 11 }),
  ins("return", 12),
  ins("jump", 11, { target: 12 }),
  ins("loop_next", 17, { target: 3 }),
  ins("return", 18),
];

const FORAGE: SkillDefinition = {
  name: "forage",
  params: [],
  source: FORAGE_SOURCE,
  blocks: [],
  compiled: FORAGE_COMPILED,
  block_count: 48,
  saved_round: 2,
  calls: [],
};

const WALK_UP: SkillDefinition = {
  name: "walk_up",
  params: ["steps"],
  source: ['REPEAT steps', '    SET movement_result = move("up")', "    IF movement_result.ok == false", "        RETURN movement_result.reason", "    END", "END", 'RETURN "completed"'].join("\n"),
  blocks: [],
  compiled: [
    ins("loop_start", 1, { loop_kind: "repeat", target: 5 }),
    ins("set", 2, { var: "movement_result" }),
    ins("jump_if_false", 3, { target: 4 }),
    ins("return", 4),
    ins("loop_next", 6, { target: 0 }),
    ins("return", 7),
  ],
  block_count: 14,
  saved_round: 1,
  calls: [],
};

const OBSERVED_ENTITIES = [
  { id: "a01", kind: "agent", position: { x: 0, y: 0 } },
  { id: "a02", kind: "agent", position: { x: 0, y: 0 } },
  { id: "p0001", kind: "plant", position: { x: 0, y: 0 } },
  { id: "f0001", kind: "fruit", position: { x: 0, y: 0 } },
  { id: "f0002", kind: "fruit", position: { x: 0, y: 0 } },
];

function buildAgents(): Record<string, Agent> {
  const origin = { x: 0, y: 0 };
  const agents: Agent[] = [
    agent("a01", "Aster", origin, { compute: 142.52, essence: 23.4, health: 80, vision_range: 1 }, {
      skills: { forage: FORAGE, walk_up: WALK_UP },
      skill_execution: {
        root_skill: "forage",
        arguments: [],
        frames: [
          {
            skill: "forage",
            pc: 6,
            vars: {
              observation: { ok: true, reason: "ok", cost_compute: 0.8, cost_essence: 0, round: 3, data: { point: origin, entities: OBSERVED_ENTITIES, has_more: false }, effects: {} },
              entity: OBSERVED_ENTITIES[3],
              fruit_details: { ok: true, reason: "ok", cost_compute: 0.8, cost_essence: 0, round: 3, data: { id: "f0001", available_compute: 60 }, effects: {} },
            },
            loops: [{ kind: "for_each", start_pc: 3, end_pc: 13, var: "entity", remaining: 0, items: OBSERVED_ENTITIES, index: 3 }],
            return_into: null,
          },
        ],
        status: "running",
        pending_action: null,
        pending_result_var: null,
        ops_this_turn: 7,
        total_ops: 19,
        total_interpreter_cost: 0.19,
        started_round: 3,
        last_error: null,
        return_value: null,
        actions_executed: 2,
      },
      upgrade_counts: { vision_range: 1 },
      last_action: { name: "query", args: { entity: "f0001" } },
      last_result: { ok: true, reason: "ok", cost_compute: 0.8, cost_essence: 0, round: 3, data: { id: "f0001", kind: "fruit", available_compute: 60, available_essence: 0 }, effects: {} },
      total_compute_spent: 38.6,
      total_cognition_spent: 2.31,
      total_interpreter_spent: 0.19,
      model_call_count: 5,
      persona: "",
    }),
    agent("a02", "Boreas", origin, { compute: 188, health: 100, attack: 1.25 }, {
      upgrade_counts: { attack: 1 },
      last_action: { name: "attack", args: { target: "a01", compute_budget: 5 } },
      last_result: { ok: true, reason: "ok", cost_compute: 5, cost_essence: 0, round: 2, data: {}, effects: { damage: 5, target: "a01", target_health_after: 80, killed: false } },
      model_call_count: 4,
      total_cognition_spent: 1.9,
    }),
    agent("a03", "Cyrene", origin, { compute: 176.3, essence: 18 }, { model_call_count: 4, wait_turns_remaining: 1 }),
    agent("a04", "Damaris", origin, { compute: 12.4, health: 35 }, { model_call_count: 3 }),
    agent("a05", "Eos", origin, { compute: 0, essence: 0, health: 0 }, { alive: false, died_round: 2, death_cause: "starvation", model_call_count: 2 }),
    agent("a06", "Ferrin", { x: 3, y: 2 }, { compute: 197, vision_range: 2 }, { upgrade_counts: { vision_range: 2 }, model_call_count: 3 }),
    agent("a07", "Galene", { x: -4, y: -3 }, { compute: 160 }, { model_call_count: 3 }),
    agent("a08", "Halcyon", { x: 6, y: -5 }, { compute: 200 }, { created_round: 3, persona: "Placed by the operator in round 3." }),
  ];
  return Object.fromEntries(agents.map((a) => [a.id, a]));
}

// ---------------------------------------------------------------------------
// Plants, fruit, seeds, residue
// ---------------------------------------------------------------------------

function plant(id: string, position: Point, species: string, stage: number, age: number, extra: Partial<Plant> = {}): Plant {
  return {
    kind: "plant",
    id,
    position,
    species,
    stage_index: stage,
    age_rounds: age,
    size: RULES.plant_species[species].stages[stage].size,
    energy: 96.5,
    essence: 41.2,
    alive: true,
    created_round: 0,
    died_round: null,
    death_cause: null,
    fruit_ids: [],
    seed_ids: [],
    rounds_since_fruit: 2,
    rounds_since_seed: 3,
    total_fruit_produced: 1,
    total_seeds_produced: 0,
    total_source_energy: 36,
    total_source_essence: 3,
    ...extra,
  };
}

function fruit(id: string, position: Point, plantId: string, compute: number, created: number): Fruit {
  return { kind: "fruit", id, position, plant_id: plantId, available_compute: compute, available_essence: 0, created_round: created };
}

function buildEntities(): EntitiesView {
  const origin = { x: 0, y: 0 };
  const plants: Plant[] = [
    plant("p0001", origin, "fruit_tree", 2, 18, { fruit_ids: ["f0001", "f0002"], total_fruit_produced: 3 }),
    plant("p0002", origin, "fruit_tree", 1, 7, { energy: 44, essence: 12.5 }),
    plant("p0003", origin, "berry_bush", 1, 4, { energy: 30, essence: 4.1, size: 1 }),
    plant("p0004", { x: 2, y: 4 }, "fruit_tree", 2, 16, { fruit_ids: ["f0003"], seed_ids: ["s0001"], total_seeds_produced: 1 }),
    plant("p0005", { x: -5, y: 1 }, "fruit_tree", 2, 15),
    plant("p0006", { x: 4, y: -6 }, "fruit_tree", 0, 2, { energy: 4, essence: 5.4 }),
    plant("p0007", { x: -2, y: 5 }, "berry_bush", 0, 1, { alive: false, died_round: 3, death_cause: "attack", essence: 0 }),
    plant("p0008", { x: 8, y: 2 }, "fruit_tree", 2, 20),
  ];
  const fruits: Fruit[] = [fruit("f0001", origin, "p0001", 60, 1), fruit("f0002", origin, "p0001", 60, 2), fruit("f0003", { x: 2, y: 4 }, "p0004", 60, 3)];
  const seeds: Seed[] = [{ kind: "seed", id: "s0001", position: { x: 1, y: 4 }, species: "fruit_tree", plant_id: "p0004", created_round: 2, germinates_round: 12 }];
  const residues: Residue[] = [
    { kind: "residue", id: "res0001", position: origin, source_id: "a05", source_kind: "agent", available_compute: 0, available_essence: 7.2, created_round: 2 },
    { kind: "residue", id: "res0002", position: { x: -2, y: 5 }, source_id: "p0007", source_kind: "plant", available_compute: 0, available_essence: 1.1, created_round: 3 },
  ];
  return {
    agents: buildAgents(),
    plants: Object.fromEntries(plants.map((p) => [p.id, p])),
    fruits: Object.fromEntries(fruits.map((f) => [f.id, f])),
    seeds: Object.fromEntries(seeds.map((s) => [s.id, s])),
    residues: Object.fromEntries(residues.map((r) => [r.id, r])),
    removed: {
      f0004: { id: "f0004", kind: "fruit", position: origin, round: 2, reason: "consumed" },
      f0005: { id: "f0005", kind: "fruit", position: { x: 2, y: 4 }, round: 1, reason: "consumed" },
    },
  };
}

function occupantsOf(view: EntitiesView): Record<string, string[]> {
  const occupants: Record<string, string[]> = {};
  const all = [...Object.values(view.agents), ...Object.values(view.plants), ...Object.values(view.fruits), ...Object.values(view.seeds), ...Object.values(view.residues)];
  for (const e of all) {
    const key = `${e.position.x},${e.position.y}`;
    (occupants[key] ??= []).push(e.id);
  }
  return occupants;
}

// ---------------------------------------------------------------------------
// Settings and models
// ---------------------------------------------------------------------------

export const CONTEXT: ContextSettings = {
  input_token_cap: 6000,
  generation_allowance: 1000,
  recent_history_length: 5,
  notebook_max_tokens: 400,
  retrieved_memory_limit: 5,
  new_event_digest_limit: 10,
  weights: { relevance: 1, recency: 1, importance: 1 },
  include_skill_source: false,
};

export const SETTINGS: RunSettings = {
  context: CONTEXT,
  context_overrides: { a03: { input_token_cap: 4000, retrieved_memory_limit: 8 } },
  default_model_key: "fake-heuristic",
  model_overrides: { a02: "fake-scripted" },
  max_rounds: 50,
  play_delay_seconds: 0.2,
  real_budget_usd: null,
  fake_scripts: {},
  fake_options: {},
};

const CAPS_FAKE = { supports_json_schema: true, supports_json_mode: true, supports_system_prompt: true, context_window: 128000, max_output_tokens: 4096, reports_usage: true };

export const MODELS: ModelInfo[] = [
  { key: "fake-heuristic", provider: "fake", model_id: "fake-heuristic", available: true, missing_credentials: [], capabilities: CAPS_FAKE, mind_multiplier: 1, assistant_only: false, description: "Deterministic heuristic agent (no provider)." },
  { key: "fake-scripted", provider: "fake", model_id: "fake-scripted", available: true, missing_credentials: [], capabilities: CAPS_FAKE, mind_multiplier: 1, assistant_only: false, description: "Replays AgentCard.fake_script." },
  { key: "fake-malformed", provider: "fake", model_id: "fake-malformed", available: true, missing_credentials: [], capabilities: CAPS_FAKE, mind_multiplier: 1, assistant_only: false, description: "Cycles invalid JSON / unknown action / valid." },
  {
    key: "anthropic-haiku",
    provider: "anthropic",
    model_id: "claude-haiku",
    available: false,
    missing_credentials: ["ANTHROPIC_API_KEY"],
    capabilities: { ...CAPS_FAKE, context_window: 200000, max_output_tokens: 8192 },
    mind_multiplier: 1.5,
    assistant_only: false,
    description: "",
  },
  {
    key: "small-context",
    provider: "openai",
    model_id: "tiny-model",
    available: true,
    missing_credentials: [],
    capabilities: { ...CAPS_FAKE, context_window: 4096, max_output_tokens: 512 },
    mind_multiplier: 0.5,
    assistant_only: false,
    description: "Small context window (shows validation).",
  },
];

function effectiveView(settings: RunSettings, agentIds: string[]): EffectiveSettingsView {
  const effective_context: Record<string, ContextSettings> = {};
  const effective_model_key: Record<string, string> = {};
  for (const id of agentIds) {
    const o = settings.context_overrides[id] ?? {};
    effective_context[id] = {
      input_token_cap: o.input_token_cap ?? settings.context.input_token_cap,
      generation_allowance: o.generation_allowance ?? settings.context.generation_allowance,
      recent_history_length: o.recent_history_length ?? settings.context.recent_history_length,
      notebook_max_tokens: o.notebook_max_tokens ?? settings.context.notebook_max_tokens,
      retrieved_memory_limit: o.retrieved_memory_limit ?? settings.context.retrieved_memory_limit,
      new_event_digest_limit: o.new_event_digest_limit ?? settings.context.new_event_digest_limit,
      weights: o.weights ?? settings.context.weights,
      include_skill_source: o.include_skill_source ?? settings.context.include_skill_source,
    };
    effective_model_key[id] = settings.model_overrides[id] ?? settings.default_model_key;
  }
  return { settings, effective_context, effective_model_key };
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

function rec(
  agentId: string,
  seq: number,
  round: number,
  kind: KnowledgeKind,
  provenance: Partial<Provenance> & { source: string },
  text: string,
  content: Record<string, unknown>,
  read: boolean,
  importance = 0.3,
): KnowledgeRecord {
  return {
    id: `${agentId}-k${String(seq).padStart(6, "0")}`,
    agent_id: agentId,
    round,
    seq,
    kind,
    provenance: { action: null, sender_visible: null, turn_id: null, ...provenance },
    text,
    content,
    tags: [],
    importance,
    read,
    created_at: `2026-09-25T10:${String(10 + seq).padStart(2, "0")}:00+00:00`,
  };
}

function a01Knowledge(): AgentKnowledge {
  const origin = { x: 0, y: 0 };
  const records: KnowledgeRecord[] = [
    rec("a01", 1, 0, "system", { source: "world", turn_id: "r00000_init" }, "Run start: you are Aster (a01) at (0, 0) with compute 200, essence 20/100, health 100/100.", { text: "Run start", self: BASE_STATS }, true, 0.6),
    rec("a01", 2, 1, "observation", { source: "own_action", action: "observe", turn_id: "r00001_t03_a01" }, "observe (0, 0) -> ok: land, 9 entities (cost 1)", {
      action: { name: "observe", args: { point: origin, page: 0 } },
      result: { ok: true, reason: "ok", cost_compute: 1, cost_essence: 0, round: 1, data: { point: origin, terrain: "land", entities: OBSERVED_ENTITIES, observed_round: 1 }, effects: {} },
      via_skill: false,
      thought: "Look around first.",
    }, true),
    rec("a01", 3, 1, "message", { source: "agent:a02", sender_visible: true, turn_id: "r00001_t05_a02" }, 'a02 says: "Share the fruit at (0, 0)?"', { text: "Share the fruit at (0, 0)?", sender: "a02", sender_visible: true, broadcast: false }, true, 0.5),
    rec("a01", 4, 1, "system", { source: "world", turn_id: "r00002_t01_a01" }, "Your last decision cost 0.46 compute.", { text: "cognition", cognition_charged: 0.46 }, true, 0.1),
    rec("a01", 5, 2, "query", { source: "own_action", action: "query", turn_id: "r00002_t01_a01" }, "query self -> ok (cost 1)", {
      action: { name: "query", args: { entity: "self" } },
      result: { ok: true, reason: "ok", cost_compute: 1, cost_essence: 0, round: 2, data: { compute: 151.6, essence: 20, health: 100 }, effects: {} },
      via_skill: false,
      thought: "Check my balance before saving a skill.",
    }, true),
    rec("a01", 6, 2, "action_result", { source: "own_action", action: "absorb", turn_id: "r00002_t01_a01" }, "absorb f0004 compute -> ok: gained 12 (cost 3)", {
      action: { name: "absorb", args: { source: "f0004", resource: "compute" } },
      result: { ok: true, reason: "ok", cost_compute: 3, cost_essence: 0, round: 2, data: {}, effects: { processed: 60, gained: 12, lost: 48, source: "f0004", resource: "compute" } },
      via_skill: false,
      thought: "Eat the fruit before Boreas does.",
    }, true, 0.5),
    rec("a01", 7, 2, "damage", { source: "agent:a02", sender_visible: true, turn_id: "r00002_t04_a02" }, "You were attacked by a02: -5 health (health 80).", { amount: 5, attacker: "a02", health_after: 80, cause: "attack" }, true, 0.9),
    rec("a01", 8, 2, "operator_voice", { source: "unknown", turn_id: "r00003_t01_a03" }, '[voice, source unknown] "The river rises in the east."', { text: "The river rises in the east." }, false, 0.7),
    rec("a01", 9, 3, "message", { source: "unknown", sender_visible: false, turn_id: "r00003_t01_a03" }, 'unknown sender broadcasts: "Anyone near (3, 2)? Fruit here."', { text: "Anyone near (3, 2)? Fruit here.", sender: null, sender_visible: false, broadcast: true }, false, 0.5),
    rec("a01", 10, 3, "action_result", { source: "own_action", action: "move", turn_id: "r00003_t02_a01" }, "move up -> blocked (fee 1)", {
      action: { name: "move", args: { direction: "up" } },
      result: { ok: false, reason: "blocked", cost_compute: 1, cost_essence: 0, round: 3, data: {}, effects: {} },
      via_skill: false,
      thought: "Try to leave the crowd.",
    }, true, 0.4),
    rec("a01", 11, 3, "observation", { source: "own_action", action: "observe", turn_id: "r00003_t02_a01" }, "observe (0, 0) via skill forage -> ok: 11 entities (cost 0.8)", {
      action: { name: "observe", args: { point: origin, page: 0 } },
      result: { ok: true, reason: "ok", cost_compute: 0.8, cost_essence: 0, round: 3, data: { point: origin, terrain: "land", entities: OBSERVED_ENTITIES, observed_round: 3 }, effects: {} },
      via_skill: true,
      thought: null,
    }, true),
    rec("a01", 12, 3, "query", { source: "own_action", action: "query", turn_id: "r00003_t02_a01" }, "query f0001 via skill forage -> ok: 60 compute available (cost 0.8)", {
      action: { name: "query", args: { entity: "f0001" } },
      result: { ok: true, reason: "ok", cost_compute: 0.8, cost_essence: 0, round: 3, data: { id: "f0001", available_compute: 60 }, effects: {} },
      via_skill: true,
      thought: null,
    }, true),
    rec("a01", 13, 3, "system", { source: "world", turn_id: "r00003_t02_a01" }, "Your last decision cost 0.52 compute.", { text: "cognition", cognition_charged: 0.52 }, false, 0.1),
  ];
  return {
    agent_id: "a01",
    records,
    notebook: "Plan: forage at (0,0) with skill forage; avoid Boreas (a02) — attacked me in round 2.\nOpen question: who broadcast about (3,2)?",
    notebook_version: 3,
    notebook_truncated: false,
    next_seq: 14,
    priorities: { "a01-k000007": 0.8 },
  };
}

function simpleKnowledge(a: Agent): AgentKnowledge {
  return {
    agent_id: a.id,
    records: [
      rec(a.id, 1, a.created_round, "system", { source: "world" }, `Run start: you are ${a.name} (${a.id}) at (${a.position.x}, ${a.position.y}).`, { text: "Run start", self: a.stats }, true, 0.6),
    ],
    notebook: "",
    notebook_version: 0,
    notebook_truncated: false,
    next_seq: 2,
    priorities: {},
  };
}

export function knowledgeFor(agentId: string, turnId: string, entities: EntitiesView): AgentKnowledgeView | null {
  const a = entities.agents[agentId];
  if (!a) return null;
  const knowledge = agentId === "a01" ? a01Knowledge() : simpleKnowledge(a);
  const unread = knowledge.records.filter((r) => !r.read).length;
  const believed =
    agentId === "a01"
      ? {
          known_round: 3,
          source: "derived" as const,
          compute: 146.08,
          essence: 20,
          essence_capacity: 100,
          health: 80,
          max_health: 100,
          attack: 1,
          speed: 1,
          vision_range: 1,
          communication_range: 0,
          compute_absorption: 0.2,
          essence_absorption: 0.1,
          skill_count_limit: 5,
          skill_block_limit: 100,
        }
      : { known_round: a.created_round, source: "derived" as const, ...BASE_STATS };
  return { turn_id: turnId, knowledge, unread_count: unread, believed_self: believed, observed_entities: observedFromRecords(knowledge) };
}

/** The backend's context.observed_entities rule on fixture records: newest sighting per id from successful observe/query records. */
function observedFromRecords(knowledge: AgentKnowledge): ObservedEntity[] {
  const newest = new Map<string, { key: number; entity: ObservedEntity }>();
  const offer = (entity: ObservedEntity, seq: number) => {
    const key = entity.observed_round * 1_000_000 + seq;
    const current = newest.get(entity.id);
    if (!current || key > current.key) newest.set(entity.id, { key, entity });
  };
  for (const r of knowledge.records) {
    if (r.provenance.source !== "own_action") continue;
    const result = (r.content as { result?: { ok?: boolean; data?: Record<string, unknown> } }).result;
    if (!result?.ok || !result.data) continue;
    const data = result.data;
    if (r.kind === "observation") {
      const round = typeof data.observed_round === "number" ? data.observed_round : r.round;
      for (const item of (data.entities as { id: string; kind: EntityKind; position?: Point }[] | undefined) ?? []) {
        if (item.id === knowledge.agent_id) continue;
        offer({ id: item.id, kind: item.kind, position: item.position ?? (data.point as Point), observed_round: round, source: "observation", alive: null, record_id: r.id }, r.seq);
      }
    } else if (r.kind === "query" && typeof data.id === "string" && data.id !== knowledge.agent_id && data.position) {
      offer(
        { id: data.id, kind: data.kind as EntityKind, position: data.position as Point, observed_round: typeof data.round === "number" ? data.round : r.round, source: "query", alive: typeof data.alive === "boolean" ? data.alive : null, record_id: r.id },
        r.seq,
      );
    }
  }
  return [...newest.values()].map((v) => v.entity).sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Turn views
// ---------------------------------------------------------------------------

function event(seq: number, kind: Event["kind"], summary: string, costs = 0): Event {
  return {
    seq,
    turn_id: "r00003_t02_a01",
    round: 3,
    turn: 2,
    actor: "a01",
    kind,
    summary,
    details: {},
    costs: { compute: costs, essence: 0 },
    pending: false,
    timestamp: "2026-09-25T10:24:00+00:00",
  };
}

export function liveTurn(): TurnView {
  const entities = buildEntities();
  return {
    live: true,
    turn: {
      schema_version: "0.1.0",
      turn_id: "r00003_t02_a01",
      kind: "agent_turn",
      round: 3,
      turn_index: 2,
      acting_agent_id: "a01",
      previous_turn_id: "r00003_t01_a03",
      scheduler: { round: 3, order: ["a03", "a01", "a06", "a02", "a04", "a07", "a08"], next_index: 2, round_complete: false },
      decision_source: "model",
      packet_id: "pk_r00003_t02_a01",
      model_call_ids: ["mc_r00003_t02_a01_01"],
      action: { name: "query", args: { entity: "f0001" }, via_skill: true, skill_name: "forage" },
      action_result: { ok: true, reason: "ok", cost_compute: 0.8, cost_essence: 0, round: 3, data: { id: "f0001", available_compute: 60 }, effects: {} },
      interventions: [],
      event_seq_start: 131,
      event_seq_end: 137,
      code_revision: "a11e51b",
      saved_at: "2026-09-25T10:24:01+00:00",
    },
    map: { region: REGION, cells: buildCells(), occupants: occupantsOf(entities) } satisfies MapState,
    entities,
    rules: RULES,
    settings: SETTINGS,
    events: [
      event(131, "turn_started", "Aster (a01) begins turn 2 of round 3"),
      event(132, "model_call_completed", "a01 got a decision from fake-heuristic (in 2140 / out 96 tokens)", 0.52),
      event(133, "decision", 'a01 decides: run_skill forage — "Forage here"'),
      event(134, "skill_started", "a01 starts skill forage"),
      event(135, "action", "a01 query f0001 (via skill forage) -> ok (cost 0.8)", 0.8),
    ],
    model_calls: [
      {
        call_id: "mc_r00003_t02_a01_01",
        agent_id: "a01",
        model_key: "fake-heuristic",
        provider: "fake",
        model_id: "fake-heuristic",
        response_model: null,
        status: "completed",
        result_status: "ok",
        input_tokens: 2140,
        output_tokens: 96,
        latency_ms: 1.4,
        attempts: 1,
        charged_compute: 0.524,
        uncharged_compute: 0,
        packet_id: "pk_r00003_t02_a01",
        error: null,
        provider_cost_usd: 0,
        reasoning_tokens: 0,
      },
    ],
    decision_packet_ids: ["pk_r00003_t02_a01"],
    parent: null,
  };
}

/** Round 1 end: a05 still alive, f0002 and a08 not created yet, p0007 alive. */
export function historyTurn(): TurnView {
  const live = liveTurn();
  const entities = structuredClone(live.entities);
  entities.agents.a05 = { ...entities.agents.a05, alive: true, died_round: null, death_cause: null, stats: { ...entities.agents.a05.stats, compute: 31, health: 12, essence: 18 } };
  delete entities.agents.a08;
  delete entities.fruits.f0002;
  delete entities.fruits.f0003;
  delete entities.residues.res0001;
  delete entities.residues.res0002;
  delete entities.seeds.s0001;
  entities.plants.p0007 = { ...entities.plants.p0007, alive: true, died_round: null, death_cause: null, essence: 5.2 };
  entities.fruits.f0004 = { kind: "fruit", id: "f0004", position: { x: 0, y: 0 }, plant_id: "p0001", available_compute: 60, available_essence: 0, created_round: 0 };
  entities.removed = { f0005: entities.removed.f0005 };
  entities.agents.a01 = { ...entities.agents.a01, skills: {}, skill_execution: null, stats: { ...entities.agents.a01.stats, compute: 176.2, health: 100 } };
  return {
    ...live,
    live: false,
    turn: {
      ...live.turn,
      turn_id: "r00001_end",
      kind: "round_end",
      round: 1,
      turn_index: null,
      acting_agent_id: null,
      previous_turn_id: "r00001_t08_a07",
      decision_source: "none",
      packet_id: null,
      model_call_ids: [],
      action: null,
      action_result: null,
      event_seq_start: 40,
      event_seq_end: 52,
    },
    map: { ...live.map, occupants: occupantsOf(entities) },
    entities,
    events: [],
    model_calls: [],
    decision_packet_ids: [],
  };
}

export function effectiveSettings(): EffectiveSettingsView {
  return effectiveView(SETTINGS, Object.keys(buildAgents()));
}

export const INITIAL_STAGED: Intervention[] = [
  { type: "voice", id: "iv_0004", origin: "ui", note: "test the voice", recipients: { mode: "broadcast_all" }, text: "A storm is coming from the west." },
  { type: "set_stat", id: "iv_0005", origin: "ui", entity_id: "a02", field: "stats.compute", value: 250 },
  { type: "update_context_settings", id: "iv_0006", origin: "ui", scope: "a03", settings: { input_token_cap: 3500, retrieved_memory_limit: 8 } },
];
