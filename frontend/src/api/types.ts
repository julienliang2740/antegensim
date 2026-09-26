/**
 * TypeScript mirror of backend/empyrean/schemas.py.
 *
 * FROZEN after the architecture phase.  Field names and JSON shapes match the
 * Pydantic models exactly (model_dump(mode="json"); no aliases exist).  Optional
 * Python fields (Optional[X] = None) are `X | null`; fields with defaults are
 * still present in responses, so they are not marked optional here except where
 * the request side may omit them.
 *
 * No enums (tsconfig erasableSyntaxOnly): use the string-literal unions and the
 * exported const arrays.
 */

// ---------------------------------------------------------------------------
// Basic value types
// ---------------------------------------------------------------------------

export type Terrain = "land" | "mountain" | "water";
export type Direction = "up" | "down" | "left" | "right";
export type Resource = "compute" | "essence";
export type EntityKind = "agent" | "plant" | "fruit" | "seed" | "residue";
export type KnowledgeKind = "observation" | "query" | "action_result" | "message" | "operator_voice" | "damage" | "system";

/** Agent ids that cards may not use (collide with query "self", scope "run", turn id "live", ...). */
export const RESERVED_AGENT_IDS = ["self", "here", "run", "live", "world", "system", "operator"] as const;
/** Stats that stay integers after upgrades and operator edits. */
export const INTEGER_STATS = ["speed", "vision_range", "communication_range", "skill_count_limit", "skill_block_limit"] as const;

export type UpgradeAttribute =
  | "essence_capacity"
  | "max_health"
  | "vision_range"
  | "communication_range"
  | "speed"
  | "compute_absorption"
  | "essence_absorption"
  | "skill_count_limit"
  | "skill_block_limit"
  | "attack";

export const UPGRADE_ATTRIBUTES: UpgradeAttribute[] = [
  "essence_capacity",
  "max_health",
  "vision_range",
  "communication_range",
  "speed",
  "compute_absorption",
  "essence_absorption",
  "skill_count_limit",
  "skill_block_limit",
  "attack",
];

export type FailureReason =
  | "ok"
  | "blocked"
  | "out_of_range"
  | "insufficient_compute"
  | "insufficient_essence"
  | "target_gone"
  | "at_limit"
  | "empty_source"
  | "invalid_argument"
  | "dead"
  | "invalid_action"
  | "skill_error";

export interface Point {
  x: number;
  y: number;
}

/** Map/occupancy key: "x,y" */
export function pointKey(p: Point): string {
  return `${p.x},${p.y}`;
}

export function parsePointKey(key: string): Point {
  const [x, y] = key.split(",").map((s) => parseInt(s, 10));
  return { x, y };
}

export interface Region {
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
}

// Turn ids: "r00000_init" | "r{round:05d}_t{turn:02d}_{agent_id}" | "r{round:05d}_end"
export const INIT_TURN_ID = "r00000_init";

export function parseTurnId(turnId: string): { round: number; turn: number | null; agentId: string | null; kind: TurnKind } {
  const parts = turnId.split("_");
  const round = parseInt(parts[0].slice(1), 10);
  if (parts[1] === "init") return { round, turn: null, agentId: null, kind: "init" };
  if (parts[1] === "end") return { round, turn: null, agentId: null, kind: "round_end" };
  return { round, turn: parseInt(parts[1].slice(1), 10), agentId: parts.slice(2).join("_"), kind: "agent_turn" };
}

// ---------------------------------------------------------------------------
// Rules / configuration
// ---------------------------------------------------------------------------

export interface Prices {
  move: number;
  observe: number;
  query: number;
  send: number;
  broadcast: number;
  absorb: number;
  transfer: number;
  wait: number;
}

export interface UpgradeSchedule {
  standard_base_compute: number;
  standard_base_essence: number;
  standard_growth: number;
  attack_base_compute: number;
  attack_base_essence: number;
  attack_growth: number;
  increments: Record<string, number>; // integer stats need integer increments
  hard_caps: Record<string, number>;
}

export interface SkillRules {
  action_discount: number;
  interpreter_cost_per_op: number;
  max_ops_per_turn: number;
  allow_recursion: boolean;
  max_call_depth: number;
  max_repeat_count: number;
  max_source_chars: number;
  max_string_chars?: number; // longest string a skill may build with "+" (always served; optional for older fixtures)
  interrupt_on: KnowledgeKind[];
}

/** Applies to every action mode (direct and skill). */
export interface AccountingRules {
  eps: number;
  failure_fee_cap: number;
}

export interface UpkeepRules {
  compute_per_round: number;
  starvation_health_loss: number;
}

export interface RecoveryRules {
  health_per_compute: number;
}

export interface CognitionRates {
  input_rate: number;
  generation_rate: number;
  default_mind_multiplier: number;
  mind_multipliers: Record<string, number>; // model key -> multiplier snapshot
  usage_estimate_safety_factor: number;
  charge_failed_calls: boolean;
}

export interface MessageRules {
  max_message_tokens: number;
  chars_per_token: number;
}

export interface DeathRules {
  essence_residue_fraction: number;
  compute_residue_fraction: number;
  residue_decay_per_round: number;
}

export interface RangeRules {
  absorb_requires_same_point: boolean;
  transfer_requires_same_point: boolean;
  attack_requires_same_point: boolean;
  observe_uses_vision_range: boolean;
  query_uses_vision_range: boolean;
  outside_region_is_blocked: boolean;
}

export interface PlantStageRule {
  name: string;
  min_age_rounds: number;
  size: number;
  energy_inflow_per_round: number;
  essence_inflow_per_round: number;
  max_energy: number;
  max_essence: number;
  fruit_interval_rounds: number;
  seed_interval_rounds: number;
}

export interface PlantSpeciesRule {
  name: string;
  description: string;
  stages: PlantStageRule[];
  initial_essence: number;
  max_fruit: number;
  fruit_energy: number;
  fruit_decay_rounds: number;
  seed_germination_delay_rounds: number;
  seed_dispersal_radius: number;
  max_seeds_alive: number;
  essence_residue_fraction: number;
  energy_residue_fraction: number;
}

export interface TerrainGenConfig {
  mountain_clusters: number;
  mountain_cluster_size: number;
  water_clusters: number;
  water_cluster_size: number;
  keep_origin_clear_radius: number;
}

export interface WorldConfig {
  region: Region;
  terrain: TerrainGenConfig;
  initial_plants: Record<string, number>;
  initial_plant_stage: number;
  /** A-WORLD-7: the first initial plants of each species go to the agents' start cells (default true). */
  plants_at_agent_starts: boolean;
  /** A-PLANT-13: ripe fruit on each initial plant at round 0, capped by the species max_fruit (default 1). */
  initial_plant_fruit: number;
  max_entities_per_observation_page: number;
}

/** Every gameplay number.  The ASSUMPTIONS registry is served separately (AssumptionsView). */
export interface RulesConfig {
  prices: Prices;
  upgrades: UpgradeSchedule;
  skills: SkillRules;
  accounting: AccountingRules;
  upkeep: UpkeepRules;
  recovery: RecoveryRules;
  cognition: CognitionRates;
  messages: MessageRules;
  death: DeathRules;
  ranges: RangeRules;
  plant_species: Record<string, PlantSpeciesRule>;
}

export interface AssumptionEntry {
  id: string;
  key: string;
  default: unknown;
  citation: string;
  rationale: string;
}

export interface AssumptionsView {
  entries: AssumptionEntry[];
}

// ---------------------------------------------------------------------------
// Context / memory settings
// ---------------------------------------------------------------------------

export interface RetrievalWeights {
  relevance: number;
  recency: number;
  importance: number;
}

export interface ContextSettings {
  input_token_cap: number;
  generation_allowance: number;
  recent_history_length: number;
  notebook_max_tokens: number;
  retrieved_memory_limit: number;
  new_event_digest_limit: number;
  weights: RetrievalWeights;
  include_skill_source: boolean;
}

/**
 * Per-agent overrides: null/absent = use run default.  An update_context_settings
 * with an agent scope REPLACES the stored override with this object minus nulls
 * (all-null deletes it); with scope "run" the non-null fields are merged.
 */
export interface ContextOverrides {
  input_token_cap?: number | null;
  generation_allowance?: number | null;
  recent_history_length?: number | null;
  notebook_max_tokens?: number | null;
  retrieved_memory_limit?: number | null;
  new_event_digest_limit?: number | null;
  weights?: RetrievalWeights | null;
  include_skill_source?: boolean | null;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type Provider = "fake" | "anthropic" | "openai" | "fireworks" | "bedrock" | "foundry" | "claude_cli";

export interface ModelCapabilities {
  supports_json_schema: boolean;
  supports_json_mode: boolean;
  supports_system_prompt: boolean;
  context_window: number;
  max_output_tokens: number;
  reports_usage: boolean;
}

/** Registry entry as stored in ModelCallRecord.ref_snapshot: env var NAMES only, never values. */
export interface ModelRef {
  key: string;
  provider: Provider;
  model_id: string;
  credential_env: string[];
  endpoint: string | null;
  region: string | null;
  deployment: string | null;
  api_version: string | null;
  capabilities: ModelCapabilities;
  mind_multiplier: number;
  options: Record<string, unknown>;
  description: string;
}

export interface ModelInfo {
  key: string;
  provider: Provider;
  model_id: string;
  available: boolean;
  missing_credentials: string[];
  capabilities: ModelCapabilities;
  mind_multiplier: number;
  description: string;
  /** Reserved for the assistant (ref.options.assistant_only): hidden from GET /api/models unless ?include_assistant=1 and refused as an agent model. */
  assistant_only: boolean;
}

export type ModelRole = "system" | "user" | "assistant";

export interface ModelMessage {
  role: ModelRole;
  content: string;
}

export interface ModelRequest {
  request_id: string;
  model_key: string;
  messages: ModelMessage[];
  response_schema: Record<string, unknown> | null;
  max_output_tokens: number;
  temperature: number | null;
  timeout_seconds: number; // per attempt
  max_retries: number;
  purpose: "decision" | "summarize" | "test";
  metadata: Record<string, unknown>; // fake adapter only; never sent to a provider
}

export interface ModelUsage {
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  reasoning_tokens: number; // informational only
  billed_input_tokens: number;
  source: "provider" | "estimate";
}

/** ok/malformed/refusal/truncated = the provider answered; timeout/error/invalid_config = infrastructure. */
export type ModelResultStatus = "ok" | "malformed" | "refusal" | "truncated" | "timeout" | "error" | "invalid_config";
export const AGENT_OUTPUT_STATUSES: ModelResultStatus[] = ["ok", "malformed", "refusal", "truncated"];
export const INFRA_STATUSES: ModelResultStatus[] = ["timeout", "error", "invalid_config"];

export interface ModelResult {
  request_id: string;
  ok: boolean;
  status: ModelResultStatus;
  text: string | null;
  parsed: Record<string, unknown> | null;
  usage: ModelUsage;
  provider: string;
  model_id: string;
  response_model: string | null; // the model the provider reports having served
  provider_cost_usd: number | null;
  latency_ms: number;
  attempts: number;
  attempt_errors: string[];
  error: string | null;
  stop_reason: string | null;
}

export interface ModelCallRecord {
  call_id: string;
  turn_id: string;
  round: number;
  turn: number | null;
  agent_id: string;
  purpose: string;
  model_key: string;
  provider: string;
  model_id: string;
  ref_snapshot: ModelRef | null;
  status: "pending" | "completed" | "failed";
  started_at: string;
  finished_at: string | null;
  request: ModelRequest;
  result: ModelResult | null;
  packet_id: string | null;
  reservation_compute: number;
  charged_compute: number;
  uncharged_compute: number;
  mind_multiplier: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Actions and results
// ---------------------------------------------------------------------------

export interface MoveAction { name: "move"; args: { direction: Direction } }
export interface ObserveAction { name: "observe"; args: { point: Point; page?: number } }
export interface QueryAction { name: "query"; args: { entity: string } }
export interface SendAction { name: "send"; args: { recipient: string; message: string } }
export interface BroadcastAction { name: "broadcast"; args: { message: string } }
export interface AbsorbAction { name: "absorb"; args: { source: string; resource: Resource } }
export interface TransferAction { name: "transfer"; args: { recipient: string; resource: Resource; amount: number } }
export interface RecoverAction { name: "recover"; args: { compute_budget: number } }
export interface AttackAction { name: "attack"; args: { target: string; compute_budget: number } }
export interface UpgradeAction { name: "upgrade"; args: { attribute: UpgradeAttribute } }
export interface WaitAction { name: "wait"; args: { rounds: number } }
export interface RunSkillAction { name: "run_skill"; args: { skill: string; arguments: unknown[] } }

export type WorldAction =
  | MoveAction
  | ObserveAction
  | QueryAction
  | SendAction
  | BroadcastAction
  | AbsorbAction
  | TransferAction
  | RecoverAction
  | AttackAction
  | UpgradeAction
  | WaitAction;

export type Action = WorldAction | RunSkillAction;

export const WORLD_ACTION_NAMES = [
  "move", "observe", "query", "send", "broadcast", "absorb", "transfer", "recover", "attack", "upgrade", "wait",
] as const;

/** cost_* are the CHARGE (fee or price), never a transferred amount (see effects.transferred). */
export interface ActionResult {
  ok: boolean;
  reason: string; // FailureReason
  cost_compute: number;
  cost_essence: number;
  round: number;
  data: Record<string, unknown>;
  effects: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export type BinaryOp = "+" | "-" | "*" | "/" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "AND" | "OR";
export type UnaryOp = "NOT" | "-";

export type Expr =
  | { type: "literal"; value: number | string | boolean | null }
  | { type: "var"; name: string }
  | { type: "field"; obj: Expr; name: string }
  | { type: "coord"; x: Expr; y: Expr }
  | { type: "binary"; op: BinaryOp; left: Expr; right: Expr }
  | { type: "unary"; op: UnaryOp; operand: Expr }
  | { type: "action"; action: (typeof WORLD_ACTION_NAMES)[number]; args: Expr[] };

export type Block =
  | { type: "set"; var: string; expr: Expr; line: number }
  | { type: "expr"; expr: Expr; line: number }
  | { type: "if"; cond: Expr; then: Block[]; else_body: Block[]; line: number }
  | { type: "repeat"; count: Expr; body: Block[]; line: number }
  | { type: "for_each"; var: string; list: Expr; body: Block[]; line: number }
  | { type: "call"; skill: string; args: Expr[]; into: string | null; line: number }
  | { type: "return"; expr: Expr | null; line: number }
  | { type: "stop"; line: number };

export interface Instruction {
  op: "set" | "eval" | "jump" | "jump_if_false" | "loop_start" | "loop_next" | "call" | "return" | "stop";
  var: string | null;
  expr: Expr | null;
  args: Expr[];
  target: number | null;
  loop_kind: "repeat" | "for_each" | null;
  skill: string | null;
  line: number;
}

export interface SkillSaveRequest {
  name: string;
  params: string[];
  source: string;
}

export interface SkillDefinition {
  name: string;
  params: string[];
  source: string;
  blocks: Block[];
  compiled: Instruction[];
  block_count: number;
  saved_round: number;
  calls: string[];
}

export interface LoopState {
  kind: "repeat" | "for_each";
  start_pc: number;
  end_pc: number;
  var: string | null;
  remaining: number;
  items: unknown[];
  index: number;
}

export interface SkillFrame {
  skill: string;
  pc: number;
  vars: Record<string, unknown>;
  loops: LoopState[];
  return_into: string | null;
}

export type SkillStatus = "running" | "awaiting_action_result" | "finished" | "stopped" | "error";

/**
 * last_error with status running: "op_budget_exhausted"; stopped: "interrupted" |
 * "skill_modified" | "replaced" | "stopped" | "operator"; error: the runtime message.
 */
export interface SkillExecutionState {
  root_skill: string;
  arguments: unknown[];
  frames: SkillFrame[];
  status: SkillStatus;
  pending_action: WorldAction | null;
  pending_result_var: string | null;
  ops_this_turn: number;
  total_ops: number;
  total_interpreter_cost: number;
  started_round: number;
  last_error: string | null;
  return_value: unknown;
  actions_executed: number;
}

// ---------------------------------------------------------------------------
// Decision (LLM output)
// ---------------------------------------------------------------------------

export interface MemoryPriority {
  record_id: string;
  priority: number; // 0..1
}

export interface Decision {
  thought?: string;
  notebook_update?: string | null;
  save_skills?: SkillSaveRequest[];
  delete_skills?: string[];
  memory_priorities?: MemoryPriority[]; // max 5
  action: Action;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface AgentStats {
  compute: number;
  essence: number;
  essence_capacity: number;
  health: number;
  max_health: number;
  attack: number;
  speed: number;
  vision_range: number;
  communication_range: number;
  compute_absorption: number;
  essence_absorption: number;
  skill_count_limit: number;
  skill_block_limit: number;
}

/** Model assignment and context overrides live in RunSettings, not here. Dead agents stay (alive=false). */
export interface Agent {
  kind: "agent";
  id: string;
  name: string;
  position: Point;
  stats: AgentStats;
  upgrade_counts: Record<string, number>;
  persona: string;
  alive: boolean;
  created_round: number;
  died_round: number | null;
  death_cause: string | null;
  skills: Record<string, SkillDefinition>;
  skill_execution: SkillExecutionState | null;
  wait_turns_remaining: number;
  last_action: { name: string; args: Record<string, unknown> } | null;
  last_result: ActionResult | null;
  total_compute_spent: number;
  total_cognition_spent: number;
  total_interpreter_spent: number;
  model_call_count: number;
}

export interface Plant {
  kind: "plant";
  id: string;
  position: Point;
  species: string;
  stage_index: number;
  age_rounds: number;
  size: number;
  energy: number;
  essence: number;
  alive: boolean;
  created_round: number;
  died_round: number | null;
  death_cause: string | null;
  fruit_ids: string[];
  seed_ids: string[];
  rounds_since_fruit: number;
  rounds_since_seed: number;
  total_fruit_produced: number;
  total_seeds_produced: number;
  total_source_energy: number;
  total_source_essence: number;
}

export interface Fruit {
  kind: "fruit";
  id: string;
  position: Point;
  plant_id: string | null;
  available_compute: number;
  available_essence: number;
  created_round: number;
}

export interface Seed {
  kind: "seed";
  id: string;
  position: Point;
  species: string;
  plant_id: string | null;
  created_round: number;
  germinates_round: number;
}

export interface Residue {
  kind: "residue";
  id: string;
  position: Point;
  source_id: string;
  source_kind: "agent" | "plant";
  available_compute: number;
  available_essence: number;
  created_round: number;
}

export type Entity = Agent | Plant | Fruit | Seed | Residue;

/** Why an entity left the world dicts (consumed / decayed / germinated / operator / cleanup). */
export interface RemovedEntity {
  id: string;
  kind: EntityKind;
  position: Point;
  round: number;
  reason: string;
}

/** Input shapes for place_entity: the backend fills every other field and assigns an empty id.
 *  An agent's stats may be partial too (schemas.AgentStats has a default for every field). */
export type AgentInput = Partial<Omit<Agent, "stats">> & {
  kind: "agent";
  name: string;
  position: Point;
  stats?: Partial<AgentStats>;
};
export type PlantInput = Partial<Plant> & { kind: "plant"; species: string; position: Point };
export type FruitInput = Partial<Fruit> & { kind: "fruit"; position: Point };
export type SeedInput = Partial<Seed> & { kind: "seed"; species: string; position: Point };
export type ResidueInput = Partial<Residue> & { kind: "residue"; source_id: string; source_kind: "agent" | "plant"; position: Point };
export type EntityInput = AgentInput | PlantInput | FruitInput | SeedInput | ResidueInput;

// ---------------------------------------------------------------------------
// Map and world
// ---------------------------------------------------------------------------

export interface MapState {
  region: Region;
  cells: Record<string, Terrain>; // "x,y" -> terrain
  occupants: Record<string, string[]>; // "x,y" -> every entity id there, dead ones included
}

export interface EntitiesView {
  agents: Record<string, Agent>;
  plants: Record<string, Plant>;
  fruits: Record<string, Fruit>;
  seeds: Record<string, Seed>;
  residues: Record<string, Residue>;
  removed: Record<string, RemovedEntity>;
}

/** Look up any entity in an EntitiesView by id. */
export function findEntity(entities: EntitiesView, id: string): Entity | undefined {
  return entities.agents[id] ?? entities.plants[id] ?? entities.fruits[id] ?? entities.seeds[id] ?? entities.residues[id];
}

// ---------------------------------------------------------------------------
// Knowledge and packets
// ---------------------------------------------------------------------------

export interface Provenance {
  source: string; // "own_action" | "world" | "operator" | "agent:<id>" | "unknown"
  action: string | null;
  sender_visible: boolean | null;
  turn_id: string | null;
}

export interface KnowledgeRecord {
  id: string;
  agent_id: string;
  round: number;
  seq: number;
  kind: KnowledgeKind;
  provenance: Provenance;
  text: string;
  content: Record<string, unknown>;
  tags: string[];
  importance: number;
  read: boolean;
  created_at: string;
}

/** Input shape for edit_knowledge add_record (schemas.KnowledgeRecordInput): only kind and text
 *  are required; content/tags/importance/read are optional; any other key (id, seq, round,
 *  agent_id, provenance copied from an existing record) is ignored by the backend, which
 *  assigns them and forces provenance source "operator". */
export type KnowledgeRecordInput = Partial<KnowledgeRecord> & { kind: KnowledgeKind; text: string };

export interface AgentKnowledge {
  agent_id: string;
  records: KnowledgeRecord[];
  notebook: string;
  notebook_version: number;
  notebook_truncated: boolean;
  next_seq: number;
  priorities: Record<string, number>;
}

export interface SituationEntity {
  id: string;
  kind: EntityKind;
  position: Point;
  available_compute: number | null;
  available_essence: number | null;
  alive: boolean | null;
  queried_round: number | null; // round of the query those values come from
}

/** What the agent may believe about itself, derived from its knowledge only (may be stale). */
/** UI agent view: an entity the agent has seen, derived only from its own successful observe/query records. Never the authoritative position. */
export interface ObservedEntity {
  id: string;
  kind: EntityKind;
  position: Point; // where the agent last saw it
  observed_round: number; // round of the newest record that showed it
  source: "observation" | "query";
  alive: boolean | null; // only a query says so
  record_id: string; // the knowledge record the sighting comes from
}
export interface BelievedSelf {
  known_round: number | null;
  source: "query" | "derived" | null;
  position?: Point | null; // where the agent believes it is (run start, move effects, query(self)); always served
  compute: number | null;
  essence: number | null;
  essence_capacity: number | null;
  health: number | null;
  max_health: number | null;
  attack: number | null;
  speed: number | null;
  vision_range: number | null;
  communication_range: number | null;
  compute_absorption: number | null;
  essence_absorption: number | null;
  skill_count_limit: number | null;
  skill_block_limit: number | null;
}

export interface Situation {
  agent_id: string;
  name: string;
  round: number;
  turn_id: string;
  position: Point;
  terrain: Terrain | null;
  self_state: BelievedSelf;
  visible_entities: SituationEntity[];
  observed_round: number | null;
  last_action: Record<string, unknown> | null;
  last_result: ActionResult | null;
  unread_counts: Record<string, number>;
  unread_messages: number;
  unread_message_texts: string[];
  skills: string[];
  skill_running: boolean;
  skill_last_error: string | null;
  upgrade_quotes: Record<string, unknown>;
  quote_mode: "direct" | "skill" | null;
  quote_round: number | null;
  prices: Record<string, number>;
  known_agent_ids: string[];
}

export type PacketSectionName = "stable_rules" | "skills" | "notebook" | "recent_history" | "retrieved_memories" | "situation" | "decision_request";

export interface PacketSection {
  name: PacketSectionName;
  text: string;
  token_estimate: number;
  record_ids: string[];
}

export type OmissionReason = "budget" | "duplicate" | "low_rank" | "unread_overflow";

export interface OmittedRecord {
  record_id: string;
  reason: OmissionReason;
  score: number | null;
}

export interface DecisionPacketRecord {
  packet_id: string;
  turn_id: string;
  round: number;
  agent_id: string;
  effective_settings: ContextSettings;
  sections: PacketSection[];
  messages: ModelMessage[];
  situation: Situation;
  selected_record_ids: string[];
  digest_record_ids: string[];
  omitted: OmittedRecord[];
  omitted_counts: Record<string, number>;
  notebook_version: number;
  input_token_estimate: number;
  overhead_tokens: number;
  generation_allowance: number;
  reservation_compute: number;
  affordable: boolean;
  unaffordable_reason: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventKind =
  | "run_created"
  | "round_started"
  | "turn_started"
  | "model_call_pending"
  | "model_call_completed"
  | "model_call_failed"
  | "cognition_charged"
  | "resource_skip"
  | "decision"
  | "decision_invalid"
  | "skill_saved"
  | "skill_rejected"
  | "skill_deleted"
  | "skill_started"
  | "skill_step"
  | "skill_finished"
  | "skill_error"
  | "action"
  | "message_delivered"
  | "damage"
  | "death"
  | "residue_created"
  | "plant_growth"
  | "fruit_spawned"
  | "fruit_removed"
  | "seed_spawned"
  | "germination"
  | "upkeep"
  | "starvation"
  | "round_ended"
  | "intervention"
  | "operator_voice"
  | "run_finished"
  | "error";

export interface EventCosts {
  compute: number;
  essence: number;
}

/** Immutable. `pending` is true only on model_call_pending and never flipped (resolve it by call_id). */
export interface Event {
  seq: number;
  turn_id: string;
  round: number;
  turn: number | null;
  actor: string; // agent id | "operator" | "world" | "system"
  kind: EventKind;
  summary: string;
  details: Record<string, unknown>;
  costs: EventCosts;
  pending: boolean;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Interventions (god mode)
// ---------------------------------------------------------------------------

/** Who staged an intervention: the god-mode UI, a working-file reload, or an approved assistant brief. */
export type InterventionOrigin = "ui" | "file" | "assistant";

interface InterventionBase {
  id?: string | null;
  origin?: InterventionOrigin;
  note?: string;
  created_at?: string | null;
}

export interface SetStatIntervention extends InterventionBase {
  type: "set_stat";
  entity_id: string;
  field: string; // dotted path, e.g. "stats.compute", "position", "alive", "species"
  value: unknown;
}

export interface PlaceEntityIntervention extends InterventionBase {
  type: "place_entity";
  entity: EntityInput | Entity;
  model_key?: string | null; // agents only
  context_overrides?: ContextOverrides | null; // agents only
}

export interface RemoveEntityIntervention extends InterventionBase {
  type: "remove_entity";
  entity_id: string;
}

export interface EditKnowledgeIntervention extends InterventionBase {
  type: "edit_knowledge";
  agent_id: string;
  operation: "add_record" | "remove_record" | "replace_notebook";
  record?: KnowledgeRecordInput | KnowledgeRecord | null;
  record_id?: string | null;
  notebook?: string | null;
}

export type VoiceRecipients =
  | { mode: "agents"; agent_ids: string[] }
  | { mode: "broadcast_all" }
  | { mode: "at_point"; point: Point };

export interface VoiceIntervention extends InterventionBase {
  type: "voice";
  recipients: VoiceRecipients;
  text: string;
}

export interface UpdateContextSettingsIntervention extends InterventionBase {
  type: "update_context_settings";
  scope: string; // "run" (merge) or agent id (replace; all-null deletes the override)
  settings: ContextOverrides;
}

export interface UpdatePlantRulesIntervention extends InterventionBase {
  type: "update_plant_rules";
  species: string;
  rule: PlantSpeciesRule; // rule.name must equal species
}

export interface UpdatePricesIntervention extends InterventionBase {
  type: "update_prices";
  prices: Prices;
}

export interface UpdateModelAssignmentIntervention extends InterventionBase {
  type: "update_model_assignment";
  scope: string; // "run" or agent id
  model_key: string | null;
}

export interface UpdateRunSettingsIntervention extends InterventionBase {
  type: "update_run_settings";
  max_rounds?: number | null;
  clear_max_rounds?: boolean;
  real_budget_usd?: number | null;
  clear_real_budget?: boolean;
  play_delay_seconds?: number | null;
}

export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

/** Created by POST working/reload only (never built by the UI). */
export interface ApplyWorkingFilesIntervention extends InterventionBase {
  type: "apply_working_files";
  base_turn_id: string;
  snapshot_ref: string;
  changes: FieldChange[];
}

export type Intervention =
  | SetStatIntervention
  | PlaceEntityIntervention
  | RemoveEntityIntervention
  | EditKnowledgeIntervention
  | VoiceIntervention
  | UpdateContextSettingsIntervention
  | UpdatePlantRulesIntervention
  | UpdatePricesIntervention
  | UpdateModelAssignmentIntervention
  | UpdateRunSettingsIntervention
  | ApplyWorkingFilesIntervention;

export interface InterventionRecord {
  intervention: Intervention;
  effective_turn_id: string;
  applied_round: number;
  ok: boolean;
  error: string | null;
  changes: FieldChange[];
}

// ---------------------------------------------------------------------------
// Runs, settings, scheduler, turns
// ---------------------------------------------------------------------------

/** settings.json: THE source of truth for model assignment and context overrides. */
export interface RunSettings {
  context: ContextSettings;
  context_overrides: Record<string, ContextOverrides>;
  default_model_key: string;
  model_overrides: Record<string, string>;
  max_rounds: number | null;
  play_delay_seconds: number;
  real_budget_usd: number | null;
  fake_scripts: Record<string, Record<string, unknown>[]>;
  fake_options: Record<string, Record<string, unknown>>;
}

export interface SchedulerState {
  round: number;
  order: string[];
  next_index: number;
  round_complete: boolean;
}

export type TurnKind = "init" | "agent_turn" | "round_end";
export type DecisionSource = "model" | "skill" | "wait" | "skipped_unaffordable" | "skipped_dead" | "skipped_removed" | "none";

export interface TurnRecord {
  schema_version: string;
  turn_id: string;
  kind: TurnKind;
  round: number;
  turn_index: number | null;
  acting_agent_id: string | null;
  previous_turn_id: string | null;
  scheduler: SchedulerState;
  decision_source: DecisionSource;
  packet_id: string | null;
  model_call_ids: string[];
  action: { name: string; args: Record<string, unknown>; via_skill: boolean; skill_name: string | null } | null;
  action_result: ActionResult | null;
  interventions: InterventionRecord[];
  event_seq_start: number;
  event_seq_end: number;
  code_revision: string;
  saved_at: string;
}

export interface ParentRef {
  world_id: string;
  run_id: string;
  turn_id: string;
}

/** Real provider usage for the whole run, separate from world compute. */
export interface RealUsageLedger {
  calls: number;
  interrupted_calls: number;
  input_tokens: number;
  output_tokens: number;
  provider_cost_usd: number;
}

export interface TurnIndexEntry {
  turn_id: string;
  kind: TurnKind;
  round: number;
  turn_index: number | null;
  acting_agent_id: string | null;
  action_name: string | null;
  ok: boolean | null;
  decision_source: DecisionSource;
  intervention_count: number;
  event_count: number;
  saved_at: string;
}

// ---------------------------------------------------------------------------
// Run creation and API views
// ---------------------------------------------------------------------------

export interface AgentCard {
  id?: string | null; // ^[A-Za-z0-9]{1,16}$, not reserved; null -> lowest unused aNN
  name: string;
  model_key?: string | null;
  position: Point;
  stats: AgentStats;
  persona: string;
  notebook: string;
  initial_skills: SkillSaveRequest[];
  context_overrides?: ContextOverrides | null;
  fake_script?: Record<string, unknown>[] | null;
  fake_options?: Record<string, unknown> | null;
}

export interface RunCreateRequest {
  name: string;
  world_id?: string | null;
  seed: number;
  world: WorldConfig;
  rules: RulesConfig;
  context: ContextSettings;
  default_model_key: string;
  max_rounds?: number | null;
  play_delay_seconds?: number;
  real_budget_usd?: number | null;
  agents: AgentCard[]; // 6..12
}

export interface ApiProblem {
  path: string; // "agents[2].position", "context.generation_allowance", "" = whole request
  message: string;
}

export interface RunValidationResponse {
  ok: boolean;
  problems: ApiProblem[];
}

export interface WorldPreviewRequest {
  seed: number;
  world: WorldConfig;
}

export type RunState = "paused" | "running" | "pause_requested" | "turn_active" | "waiting_model" | "error" | "finished";
export type RunCommand = "run_turn" | "play" | "pause" | "step_round";
export type NextStep = "agent_turn" | "round_end" | "new_round";

export interface PendingModelCall {
  call_id: string;
  agent_id: string;
  model_key: string;
  started_at: string;
}

/**
 * round/turn_index/acting_agent_id describe the in-progress turn while state is
 * turn_active/waiting_model/pause_requested and the last committed turn otherwise.
 * last_error persists until the next successful commit.  feed_epoch changes when a
 * worker (re)starts: reset the events cursor and drop uncommitted feed lines.
 */
export interface RunStatus {
  run_id: string;
  world_id: string;
  state: RunState;
  round: number;
  turn_index: number | null;
  acting_agent_id: string | null;
  next_agent_id: string | null;
  next_step: NextStep;
  current_turn_id: string;
  active_turn_id: string | null;
  active_command: RunCommand | null;
  last_error: string | null;
  pending_model_call: PendingModelCall | null;
  staged_intervention_count: number;
  latest_seq: number;
  feed_epoch: string;
  living_agent_count: number;
  finished_reason: string | null;
  play_loop: boolean;
  real_usage: RealUsageLedger;
  /** When next_step is "new_round": the initiative the next round would get from the saved world as it is (a prediction; staged edits can change it). */
  next_round_order: string[] | null;
}

export interface RunSummary {
  world_id: string;
  run_id: string;
  name: string;
  current_turn_id: string;
  last_round: number;
  last_turn_index: number | null;
  saved_at: string;
  agent_count: number;
  living_agent_count: number;
  status: RunState;
  parent: ParentRef | null;
  default_model_key: string;
  /** Absolute run folder on the backend machine (edit <run_dir>/working/ in literal god mode); null when unknown. */
  run_dir: string | null;
  /** The run folder holds archive.json: hidden from GET /api/runs unless ?archived=1|all. */
  archived: boolean;
  /** When the run was archived (ISO); null while active. */
  archived_at: string | null;
}

/** GET /api/runs?archived=: "0" active runs only (default), "1" archived only, "all". */
export type RunArchiveFilter = "0" | "1" | "all";

export interface CommandRequest {
  command: RunCommand;
}

export interface ModelCallSummary {
  call_id: string;
  agent_id: string;
  model_key: string;
  provider: string;
  model_id: string;
  response_model: string | null;
  status: string;
  result_status: string | null;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  attempts: number;
  charged_compute: number;
  uncharged_compute: number;
  packet_id: string | null;
  error: string | null;
  /** As reported by the provider (result.provider_cost_usd); null when not reported. */
  provider_cost_usd: number | null;
  /** Informational: thinking tokens inside output_tokens (usage.reasoning_tokens). */
  reasoning_tokens: number;
}

/** `parent`: when turn.previous_turn_id is not in this run, show "<- parent run @ turn". */
export interface TurnView {
  live: boolean;
  turn: TurnRecord;
  map: MapState;
  entities: EntitiesView;
  rules: RulesConfig;
  settings: RunSettings;
  events: Event[];
  model_calls: ModelCallSummary[];
  decision_packet_ids: string[];
  parent: ParentRef | null;
}

export interface PendingModelCallView {
  record: ModelCallRecord;
  packet: DecisionPacketRecord | null;
}

export interface EventsResponse {
  events: Event[];
  latest_seq: number;
  status: RunStatus;
}

export interface StagedInterventionsResponse {
  staged: Intervention[];
}

export interface ReloadResponse {
  ok: boolean;
  errors: string[];
  changes: FieldChange[];
  staged: Intervention | null;
}

export interface ContinuationRequest {
  from_turn_id: string;
  name?: string | null;
}

/** Context bounds that live in backend config (not in ContextSettings), served so inline
 *  validation cannot drift from context.validate_settings. */
export interface ContextLimits {
  min_packet_input_tokens: number; // <= input_token_cap
  min_generation_tokens: number; // <= generation_allowance
}

export interface EffectiveSettingsView {
  settings: RunSettings;
  effective_context: Record<string, ContextSettings>;
  effective_model_key: Record<string, string>;
  limits?: ContextLimits | null; // filled by the runner from config
}

export interface AgentKnowledgeView {
  turn_id: string;
  knowledge: AgentKnowledge;
  unread_count: number;
  believed_self: BelievedSelf;
  /** Fix pass: entities the agent has observed or queried, at the position it last saw them (context.observed_entities); the UI agent view filters the map and occupant list with it. */
  observed_entities: ObservedEntity[];
}

export type ApiErrorCode =
  | "run_not_open"
  | "illegal_command"
  | "invalid_intervention"
  | "invalid_setup"
  | "validation_error"
  | "unknown_model"
  | "not_found"
  | "internal_error"
  /** 503: the assistant service is not configured in this backend (tests, headless runs). */
  | "assistant_unavailable"
  /** 409: the assistant cannot take this job now (a job of the same kind is already running). */
  | "assistant_busy"
  /** 409: the brief was already approved, rejected, superseded or is executing. */
  | "brief_not_pending"
  /** 409: an assistant budget (message, chat, storybook, story or global) would be exceeded. */
  | "assistant_budget_exhausted"
  /** 409: the conversation already has a pending job. */
  | "conversation_busy"
  /** 413: the request body is too large (for example dictated audio over the cap). */
  | "payload_too_large"
  /** 409: DELETE of a run that is open, held by another process, or has a story/storybook job. */
  | "run_in_use";

export interface ApiError {
  error: ApiErrorCode;
  detail: string | null;
  problems: ApiProblem[];
}

/** POST /api/assistant/transcribe result (schemas.TranscriptionResult; local Whisper through model.transcribe). */
export interface TranscriptionResult {
  status: "ok" | "error" | "unavailable";
  text: string;
  language: string | null;
  duration_s: number | null;
  model: string;
  error: string | null;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
}
