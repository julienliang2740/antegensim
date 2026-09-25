"""
Shared Pydantic v2 models for the Empyrean prototype.

This file is the heart of the contract between the engine/storage team, the
models/context/skills team, the frontend team, and QA.  It is FROZEN after the
architecture phase: implementers who need a change put a TODO in their report
instead of editing this file.

Conventions
-----------
* Every model is JSON-serialisable with ``model_dump(mode="json")`` and loads
  back with ``model_validate``.  Storage writes exactly these shapes.
* Floats are used for resource balances (the design keeps fractional compute).
* Coordinates are integer points.  On input a ``Point`` also accepts ``[x, y]``
  or ``"x,y"`` so LLM output and hand-edited files are forgiving.
* Ids are plain strings.  Agent ids look like ``a01``; plants ``p0001``; fruit
  ``f0001``; seeds ``s0001``; residue ``res0001``.  Turn ids follow the fixed
  pattern in ``TurnId`` below.
* No field uses an alias: the JSON key is always the Python attribute name, so
  ``model_dump(mode="json")`` (storage) and FastAPI responses are identical.
* LLM-facing input models (``Decision`` and the action ``*Args``) are strict:
  booleans are never accepted as numbers, strings are never coerced to numbers,
  and ``model.extract_json_object`` rejects NaN/Infinity before validation.
* The frontend mirror of these models lives in ``frontend/src/api/types.ts``.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Annotated, Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = "0.1.0"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class StrictModel(BaseModel):
    """Base for models that must reject unknown keys (LLM output, API input)."""

    model_config = ConfigDict(extra="forbid")


class LooseModel(BaseModel):
    """Base for stored records; unknown keys are ignored so old files still load."""

    model_config = ConfigDict(extra="ignore")


# ---------------------------------------------------------------------------
# Basic value types
# ---------------------------------------------------------------------------

Terrain = Literal["land", "mountain", "water"]
Direction = Literal["up", "down", "left", "right"]
Resource = Literal["compute", "essence"]
EntityKind = Literal["agent", "plant", "fruit", "seed", "residue"]
KnowledgeKind = Literal["observation", "query", "action_result", "message", "operator_voice", "damage", "system"]

# Identifiers an agent card may not use: they collide with the query target
# "self", the skill names "self"/"here", the intervention scope "run", the
# turn-id literal "live" and the event actors "world"/"system"/"operator".
RESERVED_AGENT_IDS: tuple[str, ...] = ("self", "here", "run", "live", "world", "system", "operator")

# Stats that must stay integers after upgrades and operator edits.
INTEGER_STATS: tuple[str, ...] = ("speed", "vision_range", "communication_range", "skill_count_limit", "skill_block_limit")

UpgradeAttribute = Literal[
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
]

UPGRADE_ATTRIBUTES: tuple[str, ...] = (
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
)

DIRECTION_VECTORS: dict[str, tuple[int, int]] = {
    "up": (0, 1),
    "down": (0, -1),
    "left": (-1, 0),
    "right": (1, 0),
}

# Every ActionResult.reason value the world engine may emit.  "ok" is success.
FailureReason = Literal[
    "ok",
    "blocked",  # move into mountain / outside region
    "out_of_range",  # target not within vision / communication / same-point rule
    "insufficient_compute",  # cannot afford the effective quoted price (no debit)
    "insufficient_essence",  # upgrade essence price unaffordable (no debit)
    "target_gone",  # entity id no longer exists / is dead
    "at_limit",  # upgrade at hard cap, essence capacity full, skill limits
    "empty_source",  # absorb: source has no eligible resource of that kind (< eps)
    "invalid_argument",  # uncomputable quote (step 2, no charge) or self-target / wrong entity kind /
    #                       over-long or empty message / page < 0 (step 4, attempt fee)
    "dead",  # actor is dead
    "invalid_action",  # decision failed format validation, or run_skill of an unknown skill (never executed)
    "skill_error",  # skill runtime error (division by zero, missing field, bad operand, missing CALL target).
    #                 Op-budget exhaustion is NOT an error: the skill yields and resumes (A-SKILL-2).
]


class Point(StrictModel):
    x: int
    y: int

    @model_validator(mode="before")
    @classmethod
    def _coerce(cls, value: Any) -> Any:
        if isinstance(value, (list, tuple)) and len(value) == 2:
            return {"x": value[0], "y": value[1]}
        if isinstance(value, str) and "," in value:
            xs, ys = value.split(",", 1)
            return {"x": int(xs.strip()), "y": int(ys.strip())}
        return value

    def key(self) -> str:
        """Map/occupancy dictionary key: ``"x,y"``."""
        return f"{self.x},{self.y}"

    def manhattan(self, other: "Point") -> int:
        return abs(self.x - other.x) + abs(self.y - other.y)

    def moved(self, direction: str) -> "Point":
        dx, dy = DIRECTION_VECTORS[direction]
        return Point(x=self.x + dx, y=self.y + dy)


class Region(StrictModel):
    min_x: int = -10
    max_x: int = 10
    min_y: int = -10
    max_y: int = 10

    def contains(self, p: Point) -> bool:
        return self.min_x <= p.x <= self.max_x and self.min_y <= p.y <= self.max_y


# ---------------------------------------------------------------------------
# Turn ids
# ---------------------------------------------------------------------------


class TurnId:
    """Fixed turn-id patterns.  Never build ids by hand elsewhere."""

    INIT = "r00000_init"

    @staticmethod
    def agent_turn(round_no: int, turn_index: int, agent_id: str) -> str:
        return f"r{round_no:05d}_t{turn_index:02d}_{agent_id}"

    @staticmethod
    def round_end(round_no: int) -> str:
        return f"r{round_no:05d}_end"

    @staticmethod
    def parse(turn_id: str) -> tuple[int, Optional[int], Optional[str]]:
        """Return (round, turn_index or None, agent_id or None).  Raises ValueError."""
        parts = turn_id.split("_", 2)
        if len(parts) < 2 or not parts[0].startswith("r"):
            raise ValueError(f"bad turn id: {turn_id}")
        round_no = int(parts[0][1:])
        if parts[1] in ("init", "end"):
            return round_no, None, None
        if len(parts) != 3 or not parts[1].startswith("t"):
            raise ValueError(f"bad turn id: {turn_id}")
        return round_no, int(parts[1][1:]), parts[2]


# ---------------------------------------------------------------------------
# Rules / configuration (all editable per run; defaults in config.py)
# ---------------------------------------------------------------------------


class Prices(StrictModel):
    """Normal direct-action compute prices.  recover/attack are nominal budgets."""

    move: float = 5
    observe: float = 1
    query: float = 1
    send: float = 3
    broadcast: float = 7
    absorb: float = 3
    transfer: float = 1
    wait: float = 0


class UpgradeSchedule(StrictModel):
    """Price ``base * growth**n`` (n = prior purchases of that attribute).  At a hard cap the
    quote still shows the formula price for display, ``next_value = current value`` and
    ``allowed = False``; the new value after a purchase is always ``min(cap, value + increment)``.
    Integer stats (``INTEGER_STATS``) need integer increments and are stored as ``int``."""

    standard_base_compute: float = 25
    standard_base_essence: float = 2
    standard_growth: float = 2  # price multiplies by this per prior purchase
    attack_base_compute: float = 100
    attack_base_essence: float = 10
    attack_growth: float = 4
    increments: dict[str, float] = Field(
        default_factory=lambda: {
            "essence_capacity": 20,
            "max_health": 20,
            "vision_range": 1,
            "communication_range": 1,
            "speed": 1,
            "compute_absorption": 0.05,
            "essence_absorption": 0.05,
            "skill_count_limit": 1,
            "skill_block_limit": 20,
            "attack": 0.25,
        }
    )
    hard_caps: dict[str, float] = Field(
        default_factory=lambda: {"compute_absorption": 1.0, "essence_absorption": 1.0}
    )

    @field_validator("increments")
    @classmethod
    def _integer_increments(cls, v: dict[str, float]) -> dict[str, float]:
        for name in INTEGER_STATS:
            inc = v.get(name)
            if inc is not None and float(inc) != int(inc):
                raise ValueError(f"increment for integer stat {name} must be an integer, got {inc}")
        return v


class SkillRules(StrictModel):
    action_discount: float = 0.8  # saved-skill multiplier on action compute (never on essence/amounts)
    interpreter_cost_per_op: float = 0.01
    max_ops_per_turn: int = 100
    allow_recursion: bool = False
    max_call_depth: int = 16  # CALL nesting limit (matters only when allow_recursion)
    max_repeat_count: int = 10000  # REPEAT count above this is a runtime error
    max_source_chars: int = 4000
    # Longest string a skill may build with "+" (a longer result is a runtime error).  The
    # parser's nesting depths (skills.MAX_BLOCK_NESTING / MAX_EXPR_NESTING) stay host
    # limits, not rules: they only protect the interpreter's stack.
    max_string_chars: int = 4096
    # Knowledge kinds whose arrival (an unread record) interrupts a running skill at its
    # next resume boundary; the agent then takes a model decision that turn (A-SKILL-9).
    interrupt_on: list[KnowledgeKind] = Field(default_factory=list)


class AccountingRules(StrictModel):
    """Fractional-accounting rules that apply to EVERY action mode (direct and skill)."""

    eps: float = 1e-9  # amounts below this are treated as 0 (empty sources, cleanup, caps)
    failure_fee_cap: float = 1.0  # attempt fee = min(cap, normal price) x (discount if via skill)


class UpkeepRules(StrictModel):
    compute_per_round: float = 1.0
    starvation_health_loss: float = 5.0


class RecoveryRules(StrictModel):
    health_per_compute: float = 1.0


class CognitionRates(StrictModel):
    input_rate: float = 0.0002  # 0 = input tokens are free (packet bounded by the cap only)
    generation_rate: float = 0.001
    default_mind_multiplier: float = 1.0
    # Snapshot of mind multipliers per model key, taken from the registry at run creation
    # (and extended when update_model_assignment introduces a new key).  Editing the
    # registry file never changes an existing run's economics.
    mind_multipliers: dict[str, float] = Field(default_factory=dict)
    # When usage.source == "estimate", charge the estimate multiplied by this factor.
    usage_estimate_safety_factor: float = 1.0
    # Whether an agent-output failure (malformed/refusal/truncated) still charges the
    # reported/estimated usage.  Infrastructure failures are never charged (A-COG-5).
    charge_failed_calls: bool = True

    def multiplier_for(self, model_key: str) -> float:
        return self.mind_multipliers.get(model_key, self.default_mind_multiplier)


class MessageRules(StrictModel):
    max_message_tokens: int = 256
    chars_per_token: int = 4  # world.py measures message length as ceil(len(text) / chars_per_token)


class DeathRules(StrictModel):
    essence_residue_fraction: float = 0.4
    compute_residue_fraction: float = 0.5
    residue_decay_per_round: float = 0.0  # fraction lost per round; 0 = persists


class RangeRules(StrictModel):
    """Manhattan-distance reach rules.  0 = same point only."""

    absorb_requires_same_point: bool = True
    transfer_requires_same_point: bool = True
    attack_requires_same_point: bool = True
    observe_uses_vision_range: bool = True
    query_uses_vision_range: bool = True
    outside_region_is_blocked: bool = True


class PlantStageRule(StrictModel):
    name: str
    min_age_rounds: int = 0  # plant enters this stage at this age
    size: float = 1.0  # descriptive growth size
    energy_inflow_per_round: float = 0.0
    essence_inflow_per_round: float = 0.0
    max_energy: float = 180.0  # stored energy cap in this stage; inflow above it is not admitted
    max_essence: float = 0.0  # living essence cap in this stage
    fruit_interval_rounds: int = 0  # 0 = no fruit in this stage
    seed_interval_rounds: int = 0  # 0 = no seeds in this stage


class PlantSpeciesRule(StrictModel):
    name: str
    description: str = ""
    stages: list[PlantStageRule]
    initial_essence: float = 5.0  # supplied by the source at germination / placement
    max_fruit: int = 3  # live fruit entities at once
    fruit_energy: float = 60.0  # compute available in one fruit
    fruit_decay_rounds: int = 0  # 0 = fruit never rots
    seed_germination_delay_rounds: int = 10
    seed_dispersal_radius: int = 1  # 0 = drop at the parent point
    max_seeds_alive: int = 2
    essence_residue_fraction: float = 0.5  # of living essence at death
    energy_residue_fraction: float = 0.0  # of stored energy at death

    @field_validator("stages")
    @classmethod
    def _stages_nonempty(cls, v: list[PlantStageRule]) -> list[PlantStageRule]:
        if not v:
            raise ValueError("a species needs at least one stage")
        return v


def default_fruit_tree() -> PlantSpeciesRule:
    """The one default species (A-PLANT-1..8).  Defined here so schema defaults and
    ``config.default_rules()`` can never drift."""
    return PlantSpeciesRule(
        name="fruit_tree",
        description="Default deterministic fruit/seed plant. Sprout -> sapling -> mature; mature plants keep fruiting.",
        stages=[
            PlantStageRule(
                name="sprout",
                min_age_rounds=0,
                size=1.0,
                energy_inflow_per_round=2.0,
                essence_inflow_per_round=0.2,
                max_energy=60.0,
                max_essence=10.0,
                fruit_interval_rounds=0,
                seed_interval_rounds=0,
            ),
            PlantStageRule(
                name="sapling",
                min_age_rounds=5,
                size=2.0,
                energy_inflow_per_round=6.0,
                essence_inflow_per_round=0.5,
                max_energy=120.0,
                max_essence=25.0,
                fruit_interval_rounds=8,
                seed_interval_rounds=0,
            ),
            PlantStageRule(
                name="mature",
                min_age_rounds=15,
                size=3.0,
                energy_inflow_per_round=12.0,
                essence_inflow_per_round=1.0,
                max_energy=180.0,
                max_essence=60.0,
                fruit_interval_rounds=5,
                seed_interval_rounds=20,
            ),
        ],
        initial_essence=5.0,
        max_fruit=3,
        fruit_energy=60.0,
        fruit_decay_rounds=0,
        seed_germination_delay_rounds=10,
        seed_dispersal_radius=1,
        max_seeds_alive=2,
        essence_residue_fraction=0.5,
        energy_residue_fraction=0.0,
    )


def default_plant_species() -> dict[str, PlantSpeciesRule]:
    tree = default_fruit_tree()
    return {tree.name: tree}


class TerrainGenConfig(StrictModel):
    mountain_clusters: int = 4
    mountain_cluster_size: int = 4
    water_clusters: int = 3
    water_cluster_size: int = 5
    keep_origin_clear_radius: int = 2  # land guaranteed within this Manhattan radius of (0,0)


class WorldConfig(StrictModel):
    region: Region = Field(default_factory=Region)
    terrain: TerrainGenConfig = Field(default_factory=TerrainGenConfig)
    initial_plants: dict[str, int] = Field(default_factory=lambda: {"fruit_tree": 12})
    initial_plant_stage: int = 2  # A-PLANT-7: initial plants are placed mature
    # A-WORLD-7: the first initial plants of each species go to the agents' start cells (one
    # per distinct cell, card order); the rest are uniform on land.  false = all uniform.
    plants_at_agent_starts: bool = True
    # A-PLANT-13: ripe fruit on each initial plant at round 0 (capped by the species max_fruit),
    # funded by the source.  0 = plants start with an empty store (first fruit at round 5).
    initial_plant_fruit: int = 1
    max_entities_per_observation_page: int = 40


class RulesConfig(StrictModel):
    """Every gameplay number.  Snapshotted in each checkpoint; editable in god mode.

    Schema defaults equal ``config.default_rules()`` (a test asserts it).  The
    ASSUMPTIONS registry is NOT part of the rules: it is written once per run to
    ``assumptions.json`` and served read-only (see ``AssumptionsView``)."""

    prices: Prices = Field(default_factory=Prices)
    upgrades: UpgradeSchedule = Field(default_factory=UpgradeSchedule)
    skills: SkillRules = Field(default_factory=SkillRules)
    accounting: AccountingRules = Field(default_factory=AccountingRules)
    upkeep: UpkeepRules = Field(default_factory=UpkeepRules)
    recovery: RecoveryRules = Field(default_factory=RecoveryRules)
    cognition: CognitionRates = Field(default_factory=CognitionRates)
    messages: MessageRules = Field(default_factory=MessageRules)
    death: DeathRules = Field(default_factory=DeathRules)
    ranges: RangeRules = Field(default_factory=RangeRules)
    plant_species: dict[str, PlantSpeciesRule] = Field(default_factory=default_plant_species)


# ---------------------------------------------------------------------------
# Context / memory settings
# ---------------------------------------------------------------------------


class RetrievalWeights(StrictModel):
    """Finite, >= 0, and not all zero (the last rule is checked by ``context.validate_settings``)."""

    relevance: float = Field(default=1.0, ge=0, allow_inf_nan=False)
    recency: float = Field(default=1.0, ge=0, allow_inf_nan=False)
    importance: float = Field(default=1.0, ge=0, allow_inf_nan=False)


class ContextSettings(StrictModel):
    """Static bounds live here (so API errors carry a field path); bounds that depend on
    config or on the model's capabilities are checked by ``context.validate_settings``:
    ``MIN_PACKET_INPUT_TOKENS <= input_token_cap``, ``MIN_GENERATION_TOKENS <=
    generation_allowance <= capabilities.max_output_tokens`` and ``input_token_cap +
    generation_allowance <= capabilities.context_window``."""

    input_token_cap: int = Field(default=6000, ge=1)
    generation_allowance: int = Field(default=1000, ge=1)
    recent_history_length: int = Field(default=5, ge=0, le=50)
    notebook_max_tokens: int = Field(default=400, ge=0, le=4000)
    retrieved_memory_limit: int = Field(default=5, ge=0, le=50)
    new_event_digest_limit: int = Field(default=10, ge=1, le=50)
    weights: RetrievalWeights = Field(default_factory=RetrievalWeights)
    include_skill_source: bool = False  # include full skill code of every skill in the packet


class ContextOverrides(StrictModel):
    """Per-agent overrides; None means 'use the run default'.

    Semantics (INTERFACES section 10): an ``update_context_settings`` with an agent scope
    REPLACES the stored override with this object minus its None fields; an all-None object
    deletes the override.  With scope ``run`` the non-None fields are merged into
    ``RunSettings.context``."""

    input_token_cap: Optional[int] = Field(default=None, ge=1)
    generation_allowance: Optional[int] = Field(default=None, ge=1)
    recent_history_length: Optional[int] = Field(default=None, ge=0, le=50)
    notebook_max_tokens: Optional[int] = Field(default=None, ge=0, le=4000)
    retrieved_memory_limit: Optional[int] = Field(default=None, ge=0, le=50)
    new_event_digest_limit: Optional[int] = Field(default=None, ge=1, le=50)
    weights: Optional[RetrievalWeights] = None
    include_skill_source: Optional[bool] = None

    def is_empty(self) -> bool:
        return not self.model_dump(exclude_none=True)

    def apply_to(self, base: ContextSettings) -> ContextSettings:
        data = base.model_dump()
        for key, value in self.model_dump(exclude_none=True).items():
            data[key] = value
        return ContextSettings.model_validate(data)


# ---------------------------------------------------------------------------
# Model registry and model.py boundary
# ---------------------------------------------------------------------------

Provider = Literal["fake", "anthropic", "openai", "fireworks", "bedrock", "foundry", "claude_cli"]


class ModelCapabilities(StrictModel):
    supports_json_schema: bool = False  # provider-native structured output
    supports_json_mode: bool = False  # "respond with JSON" mode without a schema
    supports_system_prompt: bool = True
    context_window: int = 128000
    max_output_tokens: int = 4096
    reports_usage: bool = True


class ModelRef(LooseModel):
    """One configured provider/model route.  Credentials are env-var NAMES only."""

    key: str  # registry key chosen by the operator, e.g. "anthropic-haiku"
    provider: Provider
    model_id: str  # provider-specific model identifier
    credential_env: list[str] = Field(default_factory=list)  # env var names that must exist
    endpoint: Optional[str] = None  # base URL (fireworks/foundry) or None
    region: Optional[str] = None  # bedrock
    deployment: Optional[str] = None  # foundry deployment name
    api_version: Optional[str] = None  # foundry
    capabilities: ModelCapabilities = Field(default_factory=ModelCapabilities)
    mind_multiplier: float = 1.0
    options: dict[str, Any] = Field(default_factory=dict)  # temperature etc.
    description: str = ""


class ModelInfo(StrictModel):
    """Public view for GET /api/models.  Never contains secret values."""

    key: str
    provider: Provider
    model_id: str
    available: bool
    missing_credentials: list[str] = Field(default_factory=list)
    capabilities: ModelCapabilities
    mind_multiplier: float = 1.0
    description: str = ""


ModelRole = Literal["system", "user", "assistant"]


class ModelMessage(StrictModel):
    role: ModelRole
    content: str


class ModelRequest(StrictModel):
    request_id: str
    model_key: str
    messages: list[ModelMessage]
    response_schema: Optional[dict[str, Any]] = None  # JSON schema for the reply (raw; adapters transform it)
    max_output_tokens: int = 1000
    temperature: Optional[float] = None  # overrides ref.options.temperature when set
    timeout_seconds: float = 60.0  # PER ATTEMPT; overall deadline = timeout x (max_retries + 1)
    max_retries: int = 2
    purpose: Literal["decision", "summarize", "test"] = "decision"
    # situation, fake_script, fake_script_index, fake_options, agent_id, turn_id, round.
    # Read by the fake adapter only; NEVER forwarded to a provider.
    metadata: dict[str, Any] = Field(default_factory=dict)


class ModelUsage(StrictModel):
    """Normalised usage.  Per-provider mapping (no double counting):

    * OpenAI-compatible (openai/fireworks/foundry): input = prompt_tokens - cached_tokens,
      cache_read = prompt_tokens_details.cached_tokens, output = completion_tokens
      (reasoning_tokens is informational only; it is already inside completion_tokens).
    * anthropic / claude_cli: input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
      output_tokens.
    * bedrock converse: inputTokens, cacheReadInputTokens, cacheWriteInputTokens, outputTokens.
    ``billed_input_tokens = input + cache_read + cache_creation``; ``output_tokens`` is counted once.
    For a retried call the usage is the SUM over all attempts that returned usage."""

    input_tokens: int = 0  # uncached prompt tokens
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    output_tokens: int = 0  # generated tokens (includes any reasoning the provider folds in)
    reasoning_tokens: int = 0  # informational only; never billed separately
    billed_input_tokens: int = 0  # input + cache_read + cache_creation
    source: Literal["provider", "estimate"] = "estimate"

    @model_validator(mode="after")
    def _fill_billed(self) -> "ModelUsage":
        if self.billed_input_tokens == 0:
            self.billed_input_tokens = self.input_tokens + self.cache_read_tokens + self.cache_creation_tokens
        return self


# Agent-output statuses (the provider answered): ok, malformed, refusal, truncated.
# Infrastructure statuses (no usable answer): timeout, error, invalid_config.
ModelResultStatus = Literal["ok", "malformed", "refusal", "truncated", "timeout", "error", "invalid_config"]
AGENT_OUTPUT_STATUSES: tuple[str, ...] = ("ok", "malformed", "refusal", "truncated")
INFRA_STATUSES: tuple[str, ...] = ("timeout", "error", "invalid_config")


class ModelResult(StrictModel):
    request_id: str
    ok: bool  # True only when status == "ok" and parsed is a dict
    status: ModelResultStatus
    text: Optional[str] = None  # provider-exposed text; for forced tool use, json.dumps(tool input)
    parsed: Optional[dict[str, Any]] = None  # decoded JSON object when decodable
    usage: ModelUsage = Field(default_factory=ModelUsage)
    provider: str
    model_id: str  # configured id from the registry
    response_model: Optional[str] = None  # the model the provider reports having served (may differ)
    provider_cost_usd: Optional[float] = None  # real expense when the provider reports it (claude_cli)
    latency_ms: float = 0.0  # total across attempts
    attempts: int = 1
    attempt_errors: list[str] = Field(default_factory=list)  # redacted, <= 500 chars each
    error: Optional[str] = None  # redacted, <= 500 chars
    stop_reason: Optional[str] = None


class ModelCallRecord(LooseModel):
    """Stored under turns/{turn_id}/model_calls/{call_id}.json.  Never contains secrets."""

    call_id: str
    turn_id: str
    round: int
    turn: Optional[int]
    agent_id: str
    purpose: str
    model_key: str
    provider: str
    model_id: str
    ref_snapshot: Optional[ModelRef] = None  # registry entry in effect (env var NAMES only, never values)
    status: Literal["pending", "completed", "failed"]
    started_at: str
    finished_at: Optional[str] = None
    request: ModelRequest
    result: Optional[ModelResult] = None
    packet_id: Optional[str] = None
    reservation_compute: float = 0.0
    charged_compute: float = 0.0
    uncharged_compute: float = 0.0  # measured cognition above the agent's balance (ledger gap)
    mind_multiplier: float = 1.0
    error: Optional[str] = None  # e.g. "interrupted (outcome uncertain)" for recovered pending calls


# ---------------------------------------------------------------------------
# Actions (as the LLM/skill submits them) and results
# ---------------------------------------------------------------------------


class ArgsModel(BaseModel):
    """Strict base for action arguments: unknown keys rejected, no bool->number or
    str->number coercion.  Used for LLM decisions and for skill-evaluated arguments alike
    (``skills.py`` validates with the same ``WorldAction`` TypeAdapter)."""

    model_config = ConfigDict(extra="forbid", strict=True)


class MoveArgs(ArgsModel):
    direction: Direction


class ObserveArgs(ArgsModel):
    point: Point
    page: int = Field(default=0, ge=0)


class QueryArgs(ArgsModel):
    entity: str  # "self", the caller's own id (also a self-query) or a visible entity id


class SendArgs(ArgsModel):
    recipient: str
    message: str


class BroadcastArgs(ArgsModel):
    message: str


class AbsorbArgs(ArgsModel):
    source: str  # fruit or residue entity id
    resource: Resource


class TransferArgs(ArgsModel):
    recipient: str
    resource: Resource
    amount: float

    @field_validator("amount")
    @classmethod
    def _finite_positive(cls, v: float) -> float:
        if not math.isfinite(v) or v <= 0:
            raise ValueError("amount must be finite and positive")
        return v


class RecoverArgs(ArgsModel):
    compute_budget: float

    @field_validator("compute_budget")
    @classmethod
    def _finite_positive(cls, v: float) -> float:
        if not math.isfinite(v) or v <= 0:
            raise ValueError("compute_budget must be finite and positive")
        return v


class AttackArgs(ArgsModel):
    target: str
    compute_budget: float

    @field_validator("compute_budget")
    @classmethod
    def _finite_positive(cls, v: float) -> float:
        if not math.isfinite(v) or v <= 0:
            raise ValueError("compute_budget must be finite and positive")
        return v


class UpgradeArgs(ArgsModel):
    attribute: UpgradeAttribute


class WaitArgs(ArgsModel):
    rounds: int = Field(ge=1)


class RunSkillArgs(ArgsModel):
    skill: str
    arguments: list[Any] = Field(default_factory=list)  # JSON values; arity must match the skill's params


class MoveAction(StrictModel):
    name: Literal["move"]
    args: MoveArgs


class ObserveAction(StrictModel):
    name: Literal["observe"]
    args: ObserveArgs


class QueryAction(StrictModel):
    name: Literal["query"]
    args: QueryArgs


class SendAction(StrictModel):
    name: Literal["send"]
    args: SendArgs


class BroadcastAction(StrictModel):
    name: Literal["broadcast"]
    args: BroadcastArgs


class AbsorbAction(StrictModel):
    name: Literal["absorb"]
    args: AbsorbArgs


class TransferAction(StrictModel):
    name: Literal["transfer"]
    args: TransferArgs


class RecoverAction(StrictModel):
    name: Literal["recover"]
    args: RecoverArgs


class AttackAction(StrictModel):
    name: Literal["attack"]
    args: AttackArgs


class UpgradeAction(StrictModel):
    name: Literal["upgrade"]
    args: UpgradeArgs


class WaitAction(StrictModel):
    name: Literal["wait"]
    args: WaitArgs


class RunSkillAction(StrictModel):
    name: Literal["run_skill"]
    args: RunSkillArgs


WorldAction = Annotated[
    Union[
        MoveAction,
        ObserveAction,
        QueryAction,
        SendAction,
        BroadcastAction,
        AbsorbAction,
        TransferAction,
        RecoverAction,
        AttackAction,
        UpgradeAction,
        WaitAction,
    ],
    Field(discriminator="name"),
]

Action = Annotated[
    Union[
        MoveAction,
        ObserveAction,
        QueryAction,
        SendAction,
        BroadcastAction,
        AbsorbAction,
        TransferAction,
        RecoverAction,
        AttackAction,
        UpgradeAction,
        WaitAction,
        RunSkillAction,
    ],
    Field(discriminator="name"),
]

WORLD_ACTION_NAMES: tuple[str, ...] = (
    "move",
    "observe",
    "query",
    "send",
    "broadcast",
    "absorb",
    "transfer",
    "recover",
    "attack",
    "upgrade",
    "wait",
)


class ActionRequest(StrictModel):
    """A world action together with its execution mode.  Built by the runner."""

    agent_id: str
    action: WorldAction
    via_skill: bool = False  # True -> saved-skill discount applies
    skill_name: Optional[str] = None


class ActionResult(StrictModel):
    """Exactly the record shape from the design doc; skills branch on ``ok``."""

    ok: bool
    reason: str  # a FailureReason value; "ok" on success
    cost_compute: float = 0.0
    cost_essence: float = 0.0
    round: int
    data: dict[str, Any] = Field(default_factory=dict)
    effects: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Skills: text notation -> block tree -> compiled instructions -> resumable state
# ---------------------------------------------------------------------------

BinaryOp = Literal["+", "-", "*", "/", "==", "!=", "<", "<=", ">", ">=", "AND", "OR"]
UnaryOp = Literal["NOT", "-"]


class LiteralExpr(StrictModel):
    type: Literal["literal"]
    value: Union[float, int, str, bool, None]


class VarExpr(StrictModel):
    type: Literal["var"]
    name: str  # includes the implicit names "self" and "here"


class FieldExpr(StrictModel):
    type: Literal["field"]
    obj: "Expr"
    name: str


class CoordExpr(StrictModel):
    type: Literal["coord"]
    x: "Expr"
    y: "Expr"


class BinaryExpr(StrictModel):
    type: Literal["binary"]
    op: BinaryOp
    left: "Expr"
    right: "Expr"


class UnaryExpr(StrictModel):
    type: Literal["unary"]
    op: UnaryOp
    operand: "Expr"


class ActionCallExpr(StrictModel):
    """A world action call.  Allowed only as a whole SET right-hand side or a bare statement."""

    type: Literal["action"]
    action: Literal[
        "move", "observe", "query", "send", "broadcast", "absorb", "transfer", "recover", "attack", "upgrade", "wait"
    ]
    args: list["Expr"]


Expr = Annotated[
    Union[LiteralExpr, VarExpr, FieldExpr, CoordExpr, BinaryExpr, UnaryExpr, ActionCallExpr],
    Field(discriminator="type"),
]


class SetBlock(StrictModel):
    type: Literal["set"]
    var: str
    expr: Expr
    line: int = 0


class ExprBlock(StrictModel):
    """A bare action call statement, e.g. ``move("up")``; the result is discarded."""

    type: Literal["expr"]
    expr: Expr
    line: int = 0


class IfBlock(StrictModel):
    type: Literal["if"]
    cond: Expr
    then: list["Block"]
    else_body: list["Block"] = Field(default_factory=list)  # no alias: same key in files and API
    line: int = 0


class RepeatBlock(StrictModel):
    type: Literal["repeat"]
    count: Expr
    body: list["Block"]
    line: int = 0


class ForEachBlock(StrictModel):
    type: Literal["for_each"]
    var: str
    list: Expr
    body: list["Block"]
    line: int = 0


class CallBlock(StrictModel):
    type: Literal["call"]
    skill: str
    args: list[Expr]
    into: Optional[str] = None
    line: int = 0


class ReturnBlock(StrictModel):
    type: Literal["return"]
    expr: Optional[Expr] = None
    line: int = 0


class StopBlock(StrictModel):
    type: Literal["stop"]
    line: int = 0


Block = Annotated[
    Union[SetBlock, ExprBlock, IfBlock, RepeatBlock, ForEachBlock, CallBlock, ReturnBlock, StopBlock],
    Field(discriminator="type"),
]

FieldExpr.model_rebuild()
CoordExpr.model_rebuild()
BinaryExpr.model_rebuild()
UnaryExpr.model_rebuild()
ActionCallExpr.model_rebuild()
IfBlock.model_rebuild()
RepeatBlock.model_rebuild()
ForEachBlock.model_rebuild()
CallBlock.model_rebuild()


class Instruction(StrictModel):
    """One compiled instruction.  ``pc`` addresses index the skill's ``compiled`` list.

    op            fields used
    ----------    ------------------------------------------------------------
    set           var, expr
    eval          expr                      (bare action statement)
    jump          target
    jump_if_false expr, target
    loop_start    loop_kind ("repeat"|"for_each"), expr (count or list), var, target (=pc after loop end)
    loop_next     target (=pc of loop_start)   ; advances the loop or exits to loop_start.target
    call          skill, args, var (into)
    return        expr (optional)
    stop
    """

    op: Literal["set", "eval", "jump", "jump_if_false", "loop_start", "loop_next", "call", "return", "stop"]
    var: Optional[str] = None
    expr: Optional[Expr] = None
    args: list[Expr] = Field(default_factory=list)
    target: Optional[int] = None
    loop_kind: Optional[Literal["repeat", "for_each"]] = None
    skill: Optional[str] = None
    line: int = 0


class SkillSaveRequest(StrictModel):
    """What the LLM submits in ``Decision.save_skills``.  Names may not be keywords, action
    names, ``self``/``here`` or ``true``/``false``/``null`` (checked by skills.validate_and_build)."""

    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]{0,39}$")
    params: list[str] = Field(default_factory=list)
    source: str


class SkillDefinition(LooseModel):
    name: str
    params: list[str]
    source: str
    blocks: list[Block]
    compiled: list[Instruction]
    block_count: int  # size as counted by the design rule
    saved_round: int
    calls: list[str] = Field(default_factory=list)  # names of skills referenced by CALL


class LoopState(StrictModel):
    kind: Literal["repeat", "for_each"]
    start_pc: int  # pc of the loop_start instruction
    end_pc: int  # pc after loop_next (exit target)
    var: Optional[str] = None
    remaining: int = 0  # repeat
    items: list[Any] = Field(default_factory=list)  # for_each snapshot
    index: int = 0  # for_each


class SkillFrame(StrictModel):
    skill: str
    pc: int = 0
    vars: dict[str, Any] = Field(default_factory=dict)
    loops: list[LoopState] = Field(default_factory=list)
    return_into: Optional[str] = None  # caller variable receiving RETURN value


SkillStatus = Literal["running", "awaiting_action_result", "finished", "stopped", "error"]


class SkillExecutionState(LooseModel):
    """JSON-serialisable interpreter state; stored on the agent between turns.

    ``last_error`` values with status "running": "op_budget_exhausted" (yielded, resumes next
    turn).  With status "stopped": "interrupted" (A-SKILL-9), "skill_modified" (a skill in the
    frame stack was saved/deleted), "replaced", "stopped" (STOP).  With status "error": the
    runtime error message with its line."""

    root_skill: str
    arguments: list[Any] = Field(default_factory=list)
    frames: list[SkillFrame] = Field(default_factory=list)
    status: SkillStatus = "running"
    pending_action: Optional[WorldAction] = None
    pending_result_var: Optional[str] = None  # var in top frame that receives the result
    ops_this_turn: int = 0
    total_ops: int = 0
    total_interpreter_cost: float = 0.0
    started_round: int = 0
    last_error: Optional[str] = None
    return_value: Any = None
    actions_executed: int = 0


# ---------------------------------------------------------------------------
# Decision (the exact JSON the LLM returns)
# ---------------------------------------------------------------------------


class MemoryPriority(ArgsModel):
    """Bounded agent-supplied attention hint (spec 'How selection works' step 3)."""

    record_id: str
    priority: float = Field(ge=0.0, le=1.0)


class Decision(BaseModel):
    """The exact JSON the LLM returns.  Strict: unknown keys, bool-as-number and
    string-as-number all fail the format gate.  ``thought`` may be omitted."""

    model_config = ConfigDict(extra="forbid", strict=True)

    thought: str = Field(default="", max_length=600)
    # Whole-notebook replacement.  The effective limit is settings.notebook_max_tokens
    # (context.apply_notebook_update truncates and reports it); this bound is only a safety net.
    notebook_update: Optional[str] = Field(default=None, max_length=20000)
    save_skills: list[SkillSaveRequest] = Field(default_factory=list)  # processed in list order
    delete_skills: list[str] = Field(default_factory=list)
    memory_priorities: list[MemoryPriority] = Field(default_factory=list, max_length=5)
    action: Action


def decision_json_schema() -> dict[str, Any]:
    """The raw JSON schema of ``Decision``.  ``model.py`` owns any per-provider transform
    (strict variants, anyOf, nullable) and reports its token overhead through
    ``model.request_overhead_tokens``."""
    return Decision.model_json_schema()


# ---------------------------------------------------------------------------
# Entities
# ---------------------------------------------------------------------------


class AgentStats(StrictModel):
    compute: float = 200
    essence: float = 20
    essence_capacity: float = 100
    health: float = 100
    max_health: float = 100
    attack: float = 1.0
    speed: int = 1
    vision_range: int = 0
    communication_range: int = 0
    compute_absorption: float = 0.20
    essence_absorption: float = 0.10
    skill_count_limit: int = 5
    skill_block_limit: int = 100


class Agent(LooseModel):
    """World record of an agent.  Model assignment and context overrides are NOT stored here:
    ``RunSettings`` (settings.json) is the single source of truth for both.

    Dead agents stay in ``world.agents`` with ``alive=False``, ``stats.health = 0``,
    ``stats.compute = stats.essence = 0`` and their last position, so the UI can show
    "after death"; gameplay (observe, targeting, initiative) ignores them."""

    kind: Literal["agent"] = "agent"
    id: str
    name: str
    position: Point
    stats: AgentStats = Field(default_factory=AgentStats)
    upgrade_counts: dict[str, int] = Field(default_factory=dict)  # attribute -> n purchases
    persona: str = ""  # optional operator-configured identity text; empty by default
    alive: bool = True
    created_round: int = 0
    died_round: Optional[int] = None
    death_cause: Optional[str] = None
    skills: dict[str, SkillDefinition] = Field(default_factory=dict)
    skill_execution: Optional[SkillExecutionState] = None
    wait_turns_remaining: int = 0
    last_action: Optional[dict[str, Any]] = None  # {"name":..., "args":...} of the last world action attempt
    last_result: Optional[ActionResult] = None  # includes synthetic invalid_action / skill_error results
    total_compute_spent: float = 0.0  # action charges only (fees, prices); never transferred amounts
    total_cognition_spent: float = 0.0
    total_interpreter_spent: float = 0.0
    # Incremented only when the provider returned a response (agent-output statuses);
    # also the fake-scripted script index.
    model_call_count: int = 0


class Plant(LooseModel):
    kind: Literal["plant"] = "plant"
    id: str
    position: Point
    species: str
    stage_index: int = 0
    age_rounds: int = 0
    size: float = 1.0
    energy: float = 0.0  # stored source energy that funds fruit
    essence: float = 0.0  # living essence = vitality
    alive: bool = True
    created_round: int = 0
    died_round: Optional[int] = None
    death_cause: Optional[str] = None
    fruit_ids: list[str] = Field(default_factory=list)
    seed_ids: list[str] = Field(default_factory=list)
    rounds_since_fruit: int = 0
    rounds_since_seed: int = 0
    total_fruit_produced: int = 0
    total_seeds_produced: int = 0
    total_source_energy: float = 0.0  # cumulative inflow, for accounting
    total_source_essence: float = 0.0


class Fruit(LooseModel):
    kind: Literal["fruit"] = "fruit"
    id: str
    position: Point
    plant_id: Optional[str] = None
    available_compute: float = 0.0
    available_essence: float = 0.0  # always 0 for fruit by design
    created_round: int = 0


class Seed(LooseModel):
    kind: Literal["seed"] = "seed"
    id: str
    position: Point
    species: str
    plant_id: Optional[str] = None
    created_round: int = 0
    germinates_round: int = 0


class Residue(LooseModel):
    kind: Literal["residue"] = "residue"
    id: str
    position: Point
    source_id: str
    source_kind: Literal["agent", "plant"]
    available_compute: float = 0.0
    available_essence: float = 0.0
    created_round: int = 0


Entity = Annotated[Union[Agent, Plant, Fruit, Seed, Residue], Field(discriminator="kind")]


class RemovedEntity(LooseModel):
    """Why an entity left the world dicts (consumed fruit/residue, operator removal, germinated
    seed).  Lets the inspector distinguish not-yet-born / removed / consumed."""

    id: str
    kind: EntityKind
    position: Point
    round: int
    reason: str  # "consumed" | "decayed" | "germinated" | "operator" | "cleanup"


# ---------------------------------------------------------------------------
# Map and world state
# ---------------------------------------------------------------------------


class MapState(LooseModel):
    region: Region
    cells: dict[str, Terrain]  # "x,y" -> terrain for every cell in region
    # "x,y" -> ids of EVERY entity still in the world dicts, dead agents/plants included
    # (the UI shows them flagged alive=false).  Gameplay uses world.entities_at(living_only=True).
    occupants: dict[str, list[str]] = Field(default_factory=dict)

    def terrain_at(self, p: Point) -> Optional[Terrain]:
        return self.cells.get(p.key())


class WorldState(LooseModel):
    """Authoritative world truth.  Owned by world.py."""

    round: int = 0
    map: MapState
    agents: dict[str, Agent] = Field(default_factory=dict)
    plants: dict[str, Plant] = Field(default_factory=dict)
    fruits: dict[str, Fruit] = Field(default_factory=dict)
    seeds: dict[str, Seed] = Field(default_factory=dict)
    residues: dict[str, Residue] = Field(default_factory=dict)
    removed: dict[str, RemovedEntity] = Field(default_factory=dict)  # id -> why it is gone
    rules: RulesConfig = Field(default_factory=RulesConfig)
    next_entity_seq: dict[str, int] = Field(default_factory=dict)  # kind -> next number
    # THE single run RNG (JSON-serialised random.Random state): terrain, plant placement,
    # initiative tie-breaks and seed dispersal all draw from it, in that fixed order.
    rng_state: str = ""
    # observe page size (A-ACT-4), copied from WorldConfig.max_entities_per_observation_page
    # by generate_world so the run keeps the value it was created with (WorldConfig itself
    # is not stored).  Editable in god mode like any other world field.
    observation_page_size: int = Field(default=40, ge=1)
    # Human-readable notes from generate_world (A-WORLD-6: a card moved off a mountain, a
    # species with no land cell).  Kept on the state so they survive copies and reloads.
    warnings: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Knowledge (what an agent has been told) and decision packets
# ---------------------------------------------------------------------------


class Provenance(StrictModel):
    source: str  # "own_action" | "world" | "operator" | "agent:<id>" | "unknown"
    action: Optional[str] = None  # action name that produced it, if any
    sender_visible: Optional[bool] = None  # messages: did the recipient see the sender?
    turn_id: Optional[str] = None


class KnowledgeRecord(LooseModel):
    id: str  # "{agent_id}-k{seq:06d}"
    agent_id: str
    round: int
    seq: int
    kind: KnowledgeKind
    provenance: Provenance
    text: str  # rendered for the packet, one paragraph
    content: dict[str, Any] = Field(default_factory=dict)  # structured payload (ActionResult, message, ...)
    tags: list[str] = Field(default_factory=list)  # entity ids, "x,y" points, action names, words
    importance: float = 0.0  # transparent rule-based score (0..1)
    read: bool = False  # set once included in a packet
    created_at: str = Field(default_factory=utc_now_iso)


class AgentKnowledge(LooseModel):
    agent_id: str
    records: list[KnowledgeRecord] = Field(default_factory=list)
    notebook: str = ""
    notebook_version: int = 0
    notebook_truncated: bool = False  # last update exceeded notebook_max_tokens (reported in the next packet)
    next_seq: int = 1
    # Agent-supplied attention hints (Decision.memory_priorities): record id -> 0..1.
    # At most 20 entries are kept (newest wins); rank_memories adds min(0.3, 0.3 * priority).
    priorities: dict[str, float] = Field(default_factory=dict)


class SituationEntity(StrictModel):
    id: str
    kind: EntityKind
    position: Point
    available_compute: Optional[float] = None  # from a query record, if any
    available_essence: Optional[float] = None
    alive: Optional[bool] = None
    queried_round: Optional[int] = None  # round of that query record (how stale the values are)


class ObservedEntity(StrictModel):
    """UI agent view: an entity the agent has seen, derived ONLY from its own successful
    observe / query records (``context.observed_entities``): the position it last saw the
    entity at and the round of that sighting.  Never the authoritative position."""

    id: str
    kind: EntityKind
    position: Point  # where the agent last saw it (observation point or the queried position)
    observed_round: int  # round of the newest record that showed it
    source: Literal["observation", "query"]  # kind of that newest record
    alive: Optional[bool] = None  # only a query says so; None = not disclosed
    record_id: str  # the knowledge record the sighting comes from


class BelievedSelf(StrictModel):
    """What the agent may believe about itself, derived ONLY from its knowledge (A-KNOW-6):
    the run-start system record (card values), the latest own query(self) record, and later
    disclosed deltas (own ActionResult cost_compute/cost_essence and effects such as healed /
    gained / transferred / purchased / moved.to; damage and starvation notices' health_after;
    transfer-received notices; the disclosed cognition charge of the previous own decision).
    Upkeep is NOT disclosed unless the agent starves, so balances may be stale."""

    known_round: Optional[int] = None  # round of the newest record the values are derived from
    source: Optional[Literal["query", "derived"]] = None  # "query" = a query(self) this round with no later deltas
    # Where the agent believes it is: run-start record, successful move effects.to or a
    # query(self).  Operator moves are not disclosed, so it may be stale.
    position: Optional[Point] = None
    compute: Optional[float] = None
    essence: Optional[float] = None
    essence_capacity: Optional[float] = None
    health: Optional[float] = None
    max_health: Optional[float] = None
    attack: Optional[float] = None
    speed: Optional[int] = None
    vision_range: Optional[int] = None
    communication_range: Optional[int] = None
    compute_absorption: Optional[float] = None
    essence_absorption: Optional[float] = None
    skill_count_limit: Optional[int] = None
    skill_block_limit: Optional[int] = None


class Situation(StrictModel):
    """Provider-independent structured summary attached as ModelRequest.metadata['situation'].

    Built by context.py from the agent's PERMITTED knowledge only.  It never contains
    authoritative balances or live terrain (spec: no silent query(self)); the runner uses
    real balances for reservation/billing only.  Real adapters ignore it; the fake adapter
    decides from it (and must cope with None self fields).
    """

    agent_id: str
    name: str
    round: int
    turn_id: str
    position: Point  # disclosed by the run-start record and move effects
    terrain: Optional[Terrain] = None  # from the latest observation of the current point; None = unknown
    self_state: BelievedSelf = Field(default_factory=BelievedSelf)
    visible_entities: list[SituationEntity] = Field(default_factory=list)  # from the latest observation of the current point
    observed_round: Optional[int] = None  # round of that observation; None if never observed here
    last_action: Optional[dict[str, Any]] = None
    last_result: Optional[ActionResult] = None
    unread_counts: dict[str, int] = Field(default_factory=dict)  # kind -> unread records
    unread_messages: int = 0
    unread_message_texts: list[str] = Field(default_factory=list)  # up to new_event_digest_limit
    skills: list[str] = Field(default_factory=list)
    skill_running: bool = False
    skill_last_error: Optional[str] = None  # error/rejection from the previous turn, if any
    upgrade_quotes: dict[str, Any] = Field(default_factory=dict)  # from the latest query(self), if any
    quote_mode: Optional[Literal["direct", "skill"]] = None  # mode of that query (skill quotes are discounted)
    quote_round: Optional[int] = None
    prices: dict[str, float] = Field(default_factory=dict)  # normal prices from rules (stable knowledge)
    known_agent_ids: list[str] = Field(default_factory=list)


PacketSectionName = Literal[
    "stable_rules", "skills", "notebook", "recent_history", "retrieved_memories", "situation", "decision_request"
]


class PacketSection(StrictModel):
    name: PacketSectionName
    text: str
    token_estimate: int
    record_ids: list[str] = Field(default_factory=list)


OmissionReason = Literal["budget", "duplicate", "low_rank", "unread_overflow"]


class OmittedRecord(StrictModel):
    record_id: str
    reason: OmissionReason
    score: Optional[float] = None  # rank score when the record was a ranked candidate


class DecisionPacketRecord(LooseModel):
    """Stored under turns/{turn_id}/decision_packets/{packet_id}.json.  Pure output of
    context.build_packet: building a packet never mutates knowledge."""

    packet_id: str
    turn_id: str
    round: int
    agent_id: str
    effective_settings: ContextSettings
    sections: list[PacketSection]
    messages: list[ModelMessage]  # the exact messages handed to model.py
    situation: Situation
    selected_record_ids: list[str] = Field(default_factory=list)  # every record rendered anywhere
    digest_record_ids: list[str] = Field(default_factory=list)  # unread records shown (body or digest line)
    # Individual omissions are listed only for: unread records not shown, recent-window records
    # cut, and the top 2 x retrieved_memory_limit ranked candidates.  Everything else is counted.
    omitted: list[OmittedRecord] = Field(default_factory=list)
    omitted_counts: dict[str, int] = Field(default_factory=dict)  # reason -> count (all omissions)
    notebook_version: int = 0
    input_token_estimate: int = 0  # messages + overhead_tokens
    overhead_tokens: int = 0  # provider-side schema/tool overhead reported by model.request_overhead_tokens
    generation_allowance: int = 0
    reservation_compute: float = 0.0
    affordable: bool = True
    unaffordable_reason: Optional[str] = None
    created_at: str = Field(default_factory=utc_now_iso)


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

EventKind = Literal[
    "run_created",
    "round_started",
    "turn_started",
    "model_call_pending",
    "model_call_completed",
    "model_call_failed",
    "cognition_charged",
    "resource_skip",  # agent could not afford the minimum packet; idles
    "decision",  # validated decision received (format gate passed)
    "decision_invalid",  # format gate failed; no world effect
    "skill_saved",
    "skill_rejected",
    "skill_deleted",
    "skill_started",
    "skill_step",  # interpreter ran local logic (ops, cost)
    "skill_finished",
    "skill_error",
    "action",  # world action attempted; details carry the ActionResult
    "message_delivered",
    "damage",
    "death",
    "residue_created",
    "plant_growth",
    "fruit_spawned",
    "fruit_removed",
    "seed_spawned",
    "germination",
    "upkeep",
    "starvation",
    "round_ended",
    "intervention",
    "operator_voice",
    "run_finished",
    "error",
]


class EventCosts(StrictModel):
    compute: float = 0.0
    essence: float = 0.0


class Event(LooseModel):
    """Immutable once emitted.  Seqs are monotonically increasing within one worker process
    and may have gaps in committed history (a re-run turn keeps counting); a restart may
    reissue uncommitted seqs, which the client detects through ``RunStatus.feed_epoch``."""

    seq: int
    turn_id: str
    round: int
    turn: Optional[int]  # turn index within round; None for init/round-end
    actor: str  # agent id | "operator" | "world" | "system"
    kind: EventKind
    summary: str  # one readable line: who did what, result (no latency numbers; those go in details)
    details: dict[str, Any] = Field(default_factory=dict)
    costs: EventCosts = Field(default_factory=EventCosts)
    # True only on model_call_pending.  Never flipped: the UI resolves it when a
    # model_call_completed/failed with the same details.call_id arrives or the turn commits.
    pending: bool = False
    timestamp: str = Field(default_factory=utc_now_iso)


# ---------------------------------------------------------------------------
# Interventions (god mode)
# ---------------------------------------------------------------------------

InterventionOrigin = Literal["ui", "file"]


class InterventionBase(StrictModel):
    id: Optional[str] = None  # assigned by the runner when staged
    origin: InterventionOrigin = "ui"
    note: str = ""
    created_at: Optional[str] = None


class SetStatIntervention(InterventionBase):
    type: Literal["set_stat"]
    entity_id: str
    field: str  # dotted path inside the entity record, e.g. "stats.compute" or "position"
    value: Any


class PlaceEntityIntervention(InterventionBase):
    """``entity`` may be partial: only ``kind``, ``position`` and the kind's required fields
    (agent: name; plant/seed: species; residue: source_id, source_kind) are needed; every
    other field takes its default and an empty ``id`` is assigned.  Plants and seeds must be
    placed on land, agents not on mountains.  For an agent, ``model_key`` /
    ``context_overrides`` go into RunSettings (never onto the Agent record) and a knowledge
    store with a run-start system record is created."""

    type: Literal["place_entity"]
    entity: Entity  # id may be empty -> assigned
    model_key: Optional[str] = None  # agents only; None -> run default
    context_overrides: Optional[ContextOverrides] = None  # agents only


class RemoveEntityIntervention(InterventionBase):
    type: Literal["remove_entity"]
    entity_id: str


class KnowledgeRecordInput(LooseModel):
    """A partial record for ``edit_knowledge`` / ``add_record``: only ``kind`` and ``text``
    are required; ``content``/``tags``/``importance``/``read`` are optional.  Unknown keys
    (an id, seq, round, agent_id or provenance copied from an existing record) are ignored:
    ``context.apply_knowledge_intervention`` assigns the id/seq/round and forces provenance
    source "operator".  ``importance`` None = scored by the importance rule."""

    kind: KnowledgeKind
    text: str
    content: dict[str, Any] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)
    importance: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    read: bool = False


class EditKnowledgeIntervention(InterventionBase):
    type: Literal["edit_knowledge"]
    agent_id: str
    operation: Literal["add_record", "remove_record", "replace_notebook"]
    record: Optional[KnowledgeRecordInput] = None  # add_record (partial; id/seq assigned)
    record_id: Optional[str] = None  # remove_record
    notebook: Optional[str] = None  # replace_notebook


class VoiceRecipientsAgents(StrictModel):
    mode: Literal["agents"]
    agent_ids: list[str]


class VoiceRecipientsBroadcastAll(StrictModel):
    mode: Literal["broadcast_all"]


class VoiceRecipientsAtPoint(StrictModel):
    mode: Literal["at_point"]
    point: Point


VoiceRecipients = Annotated[
    Union[VoiceRecipientsAgents, VoiceRecipientsBroadcastAll, VoiceRecipientsAtPoint],
    Field(discriminator="mode"),
]


class VoiceIntervention(InterventionBase):
    type: Literal["voice"]
    recipients: VoiceRecipients
    text: str


class UpdateContextSettingsIntervention(InterventionBase):
    """scope "run": non-None fields are merged into ``RunSettings.context``.
    scope <agent id>: ``context_overrides[agent]`` is REPLACED by ``settings`` minus None fields;
    an all-None ``settings`` deletes the override.  Validated with ``context.validate_settings``
    against the agent's effective model both when staged (422) and when applied (ok=False)."""

    type: Literal["update_context_settings"]
    scope: str  # "run" or an agent id
    settings: ContextOverrides


class UpdatePlantRulesIntervention(InterventionBase):
    """Replaces ``rules.plant_species[species]`` (a species change, not one instance).
    ``rule.name`` must equal ``species``.  Plants whose ``stage_index`` exceeds the new stage
    count are clamped to the last stage and each clamp is recorded as a FieldChange."""

    type: Literal["update_plant_rules"]
    species: str
    rule: PlantSpeciesRule


class UpdatePricesIntervention(InterventionBase):
    type: Literal["update_prices"]
    prices: Prices


class UpdateModelAssignmentIntervention(InterventionBase):
    """The key must exist and be available.  A key missing from
    ``rules.cognition.mind_multipliers`` is snapshotted from the registry at apply time
    (recorded as a FieldChange).  Every affected agent's effective context settings are
    re-validated against the new model; on failure the intervention is rejected whole."""

    type: Literal["update_model_assignment"]
    scope: str  # "run" or an agent id
    model_key: Optional[str]  # None for an agent clears its override


class UpdateRunSettingsIntervention(InterventionBase):
    """None = unchanged.  ``clear_*`` resets the optional limit to "no limit"."""

    type: Literal["update_run_settings"]
    max_rounds: Optional[int] = Field(default=None, ge=1)
    clear_max_rounds: bool = False
    real_budget_usd: Optional[float] = Field(default=None, ge=0)
    clear_real_budget: bool = False
    play_delay_seconds: Optional[float] = Field(default=None, ge=0, le=60)


class FieldChange(StrictModel):
    path: str  # e.g. "world.agents.a01.stats.compute", "knowledge.a02.records[a02-k000012]", "settings.context.input_token_cap"
    before: Any = None
    after: Any = None


class ApplyWorkingFilesIntervention(InterventionBase):
    """Created by POST working/reload.  Self-contained: the validated WorkingState was copied
    to ``staged_snapshots/{id}.json`` at staging (``snapshot_ref``) and exactly that snapshot
    is applied; later edits to working/ are ignored until the next reload.  Applied only
    when ``base_turn_id`` equals the committed turn at the boundary, otherwise recorded with
    ok=False ("stale: committed turn is X").  Origin is always 'file'."""

    type: Literal["apply_working_files"]
    base_turn_id: str
    snapshot_ref: str  # path relative to the run directory
    changes: list[FieldChange]  # the diff shown to the operator at reload time


Intervention = Annotated[
    Union[
        SetStatIntervention,
        PlaceEntityIntervention,
        RemoveEntityIntervention,
        EditKnowledgeIntervention,
        VoiceIntervention,
        UpdateContextSettingsIntervention,
        UpdatePlantRulesIntervention,
        UpdatePricesIntervention,
        UpdateModelAssignmentIntervention,
        UpdateRunSettingsIntervention,
        ApplyWorkingFilesIntervention,
    ],
    Field(discriminator="type"),
]


class InterventionRecord(LooseModel):
    """What gets written into events (details) and state.json when an intervention is applied."""

    intervention: Intervention
    effective_turn_id: str
    applied_round: int
    ok: bool
    error: Optional[str] = None
    changes: list[FieldChange] = Field(default_factory=list)


class StagedEdits(LooseModel):
    """working/staged_edits.json"""

    interventions: list[Intervention] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Runs, settings, scheduler, checkpoints
# ---------------------------------------------------------------------------


class RunSettings(LooseModel):
    """settings.json: THE source of truth for model assignment and context overrides.
    ``create_run`` copies ``AgentCard.model_key`` / ``context_overrides`` here."""

    context: ContextSettings = Field(default_factory=ContextSettings)
    context_overrides: dict[str, ContextOverrides] = Field(default_factory=dict)  # agent id -> overrides
    default_model_key: str
    model_overrides: dict[str, str] = Field(default_factory=dict)  # agent id -> model key
    max_rounds: Optional[int] = None  # None = run until paused/all dead
    play_delay_seconds: float = 0.2  # pause between turns while play/step_round drives
    # Real-expense ceiling (USD, from provider-reported cost).  Reaching it puts the run in
    # state "error" with last_error "host budget exhausted" (never an ecological event).
    real_budget_usd: Optional[float] = None
    # Test scaffolding for the fake adapter (ignored by real providers):
    fake_scripts: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)  # agent id -> [Decision dicts]
    fake_options: dict[str, dict[str, Any]] = Field(default_factory=dict)  # agent id -> {"aggressive": true, ...}

    def effective_context(self, agent_id: str) -> ContextSettings:
        """Always a fresh copy (callers may mutate it)."""
        ov = self.context_overrides.get(agent_id)
        return ov.apply_to(self.context) if ov else self.context.model_copy(deep=True)

    def effective_model_key(self, agent_id: str) -> str:
        return self.model_overrides.get(agent_id, self.default_model_key)


class SchedulerState(LooseModel):
    """Initiative order for the round.  Tie-breaks use ``world.rng_state`` (the single run
    RNG): living ids sorted ascending, ``rng.shuffle``, then a stable sort by speed
    descending, computed once at round start."""

    round: int = 0
    order: list[str] = Field(default_factory=list)  # agent ids in initiative order for this round
    next_index: int = 0  # index into order of the next agent to act
    round_complete: bool = True  # True when the round-end step has run


TurnKind = Literal["init", "agent_turn", "round_end"]
# skipped_removed: the scheduled agent was removed by an intervention after the order was fixed.
DecisionSource = Literal["model", "skill", "wait", "skipped_unaffordable", "skipped_dead", "skipped_removed", "none"]


class TurnRecord(LooseModel):
    """turns/{turn_id}/state.json"""

    schema_version: str = SCHEMA_VERSION
    turn_id: str
    kind: TurnKind
    round: int
    turn_index: Optional[int] = None
    acting_agent_id: Optional[str] = None
    previous_turn_id: Optional[str] = None
    scheduler: SchedulerState
    decision_source: DecisionSource = "none"
    packet_id: Optional[str] = None
    model_call_ids: list[str] = Field(default_factory=list)
    action: Optional[dict[str, Any]] = None  # {"name","args","via_skill","skill_name"}
    action_result: Optional[ActionResult] = None
    interventions: list[InterventionRecord] = Field(default_factory=list)
    event_seq_start: int = 0
    event_seq_end: int = 0
    code_revision: str = ""
    saved_at: str = Field(default_factory=utc_now_iso)


class Checkpoint(LooseModel):
    """A complete loadable snapshot.  storage.py writes/reads these."""

    turn: TurnRecord
    world: WorldState
    knowledge: dict[str, AgentKnowledge] = Field(default_factory=dict)
    settings: RunSettings
    events: list[Event] = Field(default_factory=list)
    model_calls: list[ModelCallRecord] = Field(default_factory=list)
    decision_packets: list[DecisionPacketRecord] = Field(default_factory=list)


class ParentRef(StrictModel):
    world_id: str
    run_id: str
    turn_id: str


class RealUsageLedger(LooseModel):
    """Real provider usage for the whole run, separate from world compute.  Includes calls
    whose outcome was uncertain (interrupted) so nothing billed goes unrecorded."""

    calls: int = 0
    interrupted_calls: int = 0
    input_tokens: int = 0  # billed input across all calls
    output_tokens: int = 0
    provider_cost_usd: float = 0.0  # sum of reported costs (0 when providers report none)


class Manifest(LooseModel):
    """worlds/{world_id}/runs/{run_id}/manifest.json — the COMMIT POINT: written atomically
    after the turn directory is complete, before the turn index and working/ refresh."""

    schema_version: str = SCHEMA_VERSION
    world_id: str
    run_id: str
    name: str
    created_at: str
    updated_at: str
    seed: int
    parent: Optional[ParentRef] = None
    code_revision: str = ""
    current_turn_id: str  # last complete checkpoint
    last_round: int = 0
    last_turn_index: Optional[int] = None
    next_event_seq: int = 1  # first seq not used by any committed event
    next_intervention_seq: int = 1  # iv_{seq:04d} counter (staged ids included)
    agent_count: int = 0
    living_agent_count: int = 0
    default_model_key: str = ""
    finished: bool = False
    finished_reason: Optional[str] = None
    turn_count: int = 0
    real_usage: RealUsageLedger = Field(default_factory=RealUsageLedger)


class TurnIndexEntry(StrictModel):
    turn_id: str
    kind: TurnKind
    round: int
    turn_index: Optional[int] = None
    acting_agent_id: Optional[str] = None
    action_name: Optional[str] = None
    ok: Optional[bool] = None
    decision_source: DecisionSource = "none"
    intervention_count: int = 0
    event_count: int = 0
    saved_at: str


# ---------------------------------------------------------------------------
# Run creation and API views
# ---------------------------------------------------------------------------


class AgentCard(StrictModel):
    """Semantic setup checks (RunManager.create_run / validate_setup, reported as 422 problems
    with paths like ``agents[2].position``): 6-11 cards; unique ids and names; position inside
    the region (forced to land by generate_world, A-WORLD-6); stats >= 0; health <= max_health;
    essence <= essence_capacity; model exists and is available; effective context settings
    valid for the model; initial_skills compile; initial_plants species exist."""

    id: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9]{1,16}$")  # None -> lowest unused aNN
    name: str = Field(min_length=1, max_length=40)
    model_key: Optional[str] = None  # None -> run default; stored in RunSettings.model_overrides
    position: Point = Field(default_factory=lambda: Point(x=0, y=0))
    stats: AgentStats = Field(default_factory=AgentStats)
    persona: str = ""
    notebook: str = ""
    initial_skills: list[SkillSaveRequest] = Field(default_factory=list)
    context_overrides: Optional[ContextOverrides] = None  # stored in RunSettings.context_overrides
    fake_script: Optional[list[dict[str, Any]]] = None  # fake-scripted only: Decision dicts in order
    fake_options: Optional[dict[str, Any]] = None  # fake-heuristic only: see INTERFACES section 12

    @field_validator("id")
    @classmethod
    def _not_reserved(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v.lower() in RESERVED_AGENT_IDS:
            raise ValueError(f"agent id {v!r} is reserved")
        return v


class RunCreateRequest(StrictModel):
    name: str = Field(default="New run", min_length=1, max_length=80)
    world_id: Optional[str] = None  # None -> new world id
    # strict: a JSON boolean or a numeric string is rejected at the shape gate (422
    # validation_error at path "seed"), not reported later as a semantic problem.
    seed: int = Field(default=1, strict=True)
    world: WorldConfig = Field(default_factory=WorldConfig)
    rules: RulesConfig = Field(default_factory=RulesConfig)
    context: ContextSettings = Field(default_factory=ContextSettings)
    default_model_key: str = "fake-heuristic"
    max_rounds: Optional[int] = Field(default=None, ge=1)
    play_delay_seconds: float = Field(default=0.2, ge=0, le=60)
    real_budget_usd: Optional[float] = Field(default=None, ge=0)
    agents: list[AgentCard] = Field(min_length=6, max_length=11)


class ApiProblem(StrictModel):
    path: str  # "agents[2].position", "context.generation_allowance", "" for the whole request
    message: str


class RunValidationResponse(StrictModel):
    """POST /api/runs/validate: every problem at once, nothing created."""

    ok: bool
    problems: list[ApiProblem] = Field(default_factory=list)


class WorldPreviewRequest(StrictModel):
    """POST /api/world/preview: the terrain a seed + world config would generate."""

    seed: int = Field(default=1, strict=True)
    world: WorldConfig = Field(default_factory=WorldConfig)


RunState = Literal["paused", "running", "pause_requested", "turn_active", "waiting_model", "error", "finished"]
RunCommand = Literal["run_turn", "play", "pause", "step_round"]
NextStep = Literal["agent_turn", "round_end", "new_round"]


class PendingModelCall(StrictModel):
    call_id: str
    agent_id: str
    model_key: str
    started_at: str


class RunStatus(StrictModel):
    """``round``/``turn_index``/``acting_agent_id`` describe the in-progress turn while
    ``state`` is turn_active / waiting_model / pause_requested, and the last committed turn
    otherwise.  ``last_error`` persists until the next successful commit."""

    run_id: str
    world_id: str
    state: RunState
    round: int
    turn_index: Optional[int] = None
    acting_agent_id: Optional[str] = None
    next_agent_id: Optional[str] = None
    next_step: NextStep = "agent_turn"  # what the next run_turn will do
    current_turn_id: str  # last committed checkpoint
    active_turn_id: Optional[str] = None  # turn id being executed, if any
    active_command: Optional[RunCommand] = None  # command driving the worker, if any
    last_error: Optional[str] = None
    pending_model_call: Optional[PendingModelCall] = None
    staged_intervention_count: int = 0
    latest_seq: int = 0
    # Changes whenever a worker (re)starts for this run; the client resets its `since`
    # cursor and drops uncommitted feed lines when it changes.
    feed_epoch: str = ""
    living_agent_count: int = 0
    finished_reason: Optional[str] = None
    play_loop: bool = False  # True while a play/step_round command is driving turns
    real_usage: RealUsageLedger = Field(default_factory=RealUsageLedger)
    # When ``next_step == "new_round"``: the initiative the next round would get from the
    # committed world as it is (a prediction: staged edits applied at the boundary can
    # change it).  None otherwise.
    next_round_order: Optional[list[str]] = None


class RunSummary(StrictModel):
    world_id: str
    run_id: str
    name: str
    current_turn_id: str
    last_round: int
    last_turn_index: Optional[int] = None
    saved_at: str
    agent_count: int
    living_agent_count: int
    status: RunState  # "paused" when not open in the runner
    parent: Optional[ParentRef] = None
    default_model_key: str = ""
    # Absolute path of the run folder on the backend machine (its ``working/`` copy is what
    # the operator edits in literal god mode).  None when it cannot be resolved.
    run_dir: Optional[str] = None


class CommandRequest(StrictModel):
    command: RunCommand


class EntitiesView(StrictModel):
    agents: dict[str, Agent] = Field(default_factory=dict)
    plants: dict[str, Plant] = Field(default_factory=dict)
    fruits: dict[str, Fruit] = Field(default_factory=dict)
    seeds: dict[str, Seed] = Field(default_factory=dict)
    residues: dict[str, Residue] = Field(default_factory=dict)
    removed: dict[str, RemovedEntity] = Field(default_factory=dict)  # ids no longer in the world and why


class ModelCallSummary(StrictModel):
    """Written at commit to turns/{turn_id}/model_calls/index.json so turn views never load
    full request bodies."""

    call_id: str
    agent_id: str
    model_key: str
    provider: str
    model_id: str
    response_model: Optional[str] = None
    status: str
    result_status: Optional[str] = None
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: float = 0.0
    attempts: int = 1
    charged_compute: float = 0.0
    uncharged_compute: float = 0.0
    packet_id: Optional[str] = None
    error: Optional[str] = None
    provider_cost_usd: Optional[float] = None  # as reported by the provider (result.provider_cost_usd)
    reasoning_tokens: int = 0  # informational: thinking tokens inside output_tokens (usage.reasoning_tokens)


class TurnView(StrictModel):
    """GET /api/runs/{run_id}/turns/{turn_id} and GET /api/runs/{run_id}/state (live).
    ``parent`` is the run's parent reference (continuations): when ``turn.previous_turn_id``
    is not in this run, the UI shows "<- parent run @ turn" instead of a previous arrow."""

    live: bool
    turn: TurnRecord
    map: MapState
    entities: EntitiesView
    rules: RulesConfig
    settings: RunSettings
    events: list[Event]
    model_calls: list[ModelCallSummary]
    decision_packet_ids: list[str]
    parent: Optional[ParentRef] = None


class PendingModelCallView(StrictModel):
    """GET /api/runs/{run_id}/pending_model_call: the in-flight request while waiting_model."""

    record: ModelCallRecord
    packet: Optional[DecisionPacketRecord] = None


class AssumptionEntry(StrictModel):
    id: str  # e.g. "A-DEATH-1"
    key: str  # editable config key (dotted path) or a rule description
    default: Any = None
    citation: str
    rationale: str = ""


class AssumptionsView(StrictModel):
    """GET /api/assumptions (registry defaults) and GET /api/runs/{run_id}/assumptions (what the
    run recorded at creation, from assumptions.json).  Read-only; edit the rule keys instead."""

    entries: list[AssumptionEntry]


class EventsResponse(StrictModel):
    events: list[Event]
    latest_seq: int
    status: RunStatus


class StagedInterventionsResponse(StrictModel):
    staged: list[Intervention]


class ReloadResponse(StrictModel):
    ok: bool
    errors: list[str] = Field(default_factory=list)
    changes: list[FieldChange] = Field(default_factory=list)
    staged: Optional[Intervention] = None


class ContinuationRequest(StrictModel):
    from_turn_id: str
    name: Optional[str] = None


class ContextLimits(StrictModel):
    """The context bounds that live in config.py (not in this schema), served so the UI's
    inline validation cannot drift from ``context.validate_settings``."""

    min_packet_input_tokens: int  # config.MIN_PACKET_INPUT_TOKENS <= input_token_cap
    min_generation_tokens: int  # config.MIN_GENERATION_TOKENS <= generation_allowance


class EffectiveSettingsView(StrictModel):
    settings: RunSettings
    effective_context: dict[str, ContextSettings]  # agent id -> effective settings
    effective_model_key: dict[str, str]
    limits: Optional[ContextLimits] = None  # filled by the runner from config


class AgentKnowledgeView(StrictModel):
    turn_id: str
    knowledge: AgentKnowledge
    unread_count: int
    believed_self: BelievedSelf = Field(default_factory=BelievedSelf)  # what the packet would show
    # Fix pass: entities the agent has observed or queried, at their last observed position
    # (``context.observed_entities``), so the UI's agent view can filter the map and the
    # occupant list to what this agent has seen without parsing record text.
    observed_entities: list[ObservedEntity] = Field(default_factory=list)


ApiErrorCode = Literal[
    "run_not_open",  # 409: call POST /open first (also after a backend restart)
    "illegal_command",  # 409: command not allowed in the current state
    "invalid_intervention",  # 422: intervention failed staging validation (problems filled)
    "invalid_setup",  # 422: run creation semantic problems (problems filled)
    "validation_error",  # 422: request body shape (problems filled from pydantic loc)
    "unknown_model",  # 422: model key not in the registry / unavailable
    "not_found",  # 404
    "internal_error",  # 500: message only, traceback in the backend log
]


class ApiError(StrictModel):
    error: ApiErrorCode
    detail: Optional[str] = None
    problems: list[ApiProblem] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Module-boundary helper models (world.py -> runner.py, skills.py -> runner.py, storage)
# ---------------------------------------------------------------------------


class EventDraft(StrictModel):
    """An event before the runner assigns seq/turn_id/round/turn.  Emitted by world.py."""

    actor: str
    kind: EventKind
    summary: str
    details: dict[str, Any] = Field(default_factory=dict)
    costs: EventCosts = Field(default_factory=EventCosts)


class Notice(StrictModel):
    """Something an agent must be told (message received, damage taken, ...).

    world.py emits these; the runner hands them to context.py which turns each
    into a KnowledgeRecord for ``agent_id``.  Never contains hidden state.
    """

    agent_id: str
    kind: KnowledgeKind
    provenance: Provenance
    text: str
    content: dict[str, Any] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)


class ActionQuote(StrictModel):
    """Effective price of an action in the current execution mode.

    ``compute``/``essence`` are the action CHARGE only (the transfer fee, never the
    transferred amount).  ``required_*`` add the outgoing transfer amount and are what the
    affordability check uses.  ``ActionResult.cost_*`` and event costs report the charge."""

    action: str
    via_skill: bool
    base_compute: float  # normal direct price (nominal budget for recover/attack)
    compute: float  # effective compute charge (discounted inside a skill)
    essence: float = 0.0  # essence charge (upgrades); never discounted
    required_compute: float = 0.0  # compute + outgoing compute amount (transfer)
    required_essence: float = 0.0  # essence + outgoing essence amount (transfer)
    attempt_fee: float = 0.0  # min(accounting.failure_fee_cap, base_compute) x (discount if via_skill)
    allowed: bool = True  # False for an upgrade at its hard cap (at_limit)


class ActionOutcome(StrictModel):
    """Return value of world.apply_action."""

    result: ActionResult
    events: list[EventDraft] = Field(default_factory=list)
    notices: list[Notice] = Field(default_factory=list)
    deaths: list[str] = Field(default_factory=list)  # entity ids that died during this action


class RoundEndOutcome(StrictModel):
    """Return value of world.end_round."""

    events: list[EventDraft] = Field(default_factory=list)
    notices: list[Notice] = Field(default_factory=list)
    deaths: list[str] = Field(default_factory=list)


class SkillEnv(StrictModel):
    """Read-only values the interpreter needs from the world for ``self`` and ``here``."""

    agent_id: str
    here: Point
    round: int


class InvalidSkillAction(StrictModel):
    """An action call whose evaluated arguments failed WorldAction validation (A-ACT-13).
    The interpreter already stored ``ActionResult(ok=False, reason="invalid_argument",
    cost 0)`` into the SET variable and advanced; the runner records an ``action`` event
    with that result, sets last_action/last_result and uses the turn (no world call)."""

    name: str
    args: dict[str, Any]
    error: str
    result: ActionResult


class SkillStepOutcome(StrictModel):
    """Return value of skills.run_until_action.  Exactly one of ``action`` /
    ``invalid_action`` is set when the turn is consumed by the skill; both None means the
    skill yielded (op budget) or ended (finished/stopped/error)."""

    state: SkillExecutionState
    action: Optional[WorldAction] = None  # the one world action to execute this turn, if any
    invalid_action: Optional[InvalidSkillAction] = None
    ops_used: int = 0
    cost_compute: float = 0.0  # interpreter cost for this step (ops * cost_per_op)
    error: Optional[str] = None


class WorkingState(LooseModel):
    """The editable subset of a checkpoint, as read from working/ files."""

    world: WorldState
    knowledge: dict[str, AgentKnowledge] = Field(default_factory=dict)
    settings: RunSettings
