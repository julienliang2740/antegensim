"""
Defaults for the Empyrean prototype.

Every gameplay number lives here or in a run's stored ``RulesConfig``; game
logic must read prices/rates from the rules carried by the world state, never
from literals.  Values marked in the design document as provisional are
plain constants below so they can be changed in one place.

The ASSUMPTIONS registry names every gameplay rule the design document leaves
undecided.  Nothing is settled silently: each entry has a config key, the
chosen default, and a citation.  ``docs/ASSUMPTIONS.md`` is the human-readable
copy of this registry and must be kept in sync with it.  The registry is
written once per run to ``assumptions.json`` (never into rules.json).

Environment: ``.env`` at the repository root is loaded HERE, before any other
empyrean module reads ``os.environ`` (python-dotenv, never overriding variables
already set).  Empty values fall back to the defaults.  Secret values are read
only by ``model.py`` adapters through ``os.environ`` and are never logged.

This file is FROZEN after the architecture phase (see docs/INTERFACES.md).
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from .schemas import (
    MAX_AGENT_CARDS,
    MIN_AGENT_CARDS,
    AccountingRules,
    AgentCard,
    AgentStats,
    AssumptionEntry,
    CognitionRates,
    ContextSettings,
    DeathRules,
    MessageRules,
    PlantSpeciesRule,
    Point,
    Prices,
    RangeRules,
    RecoveryRules,
    Region,
    RetrievalWeights,
    RulesConfig,
    RunCreateRequest,
    SkillRules,
    TerrainGenConfig,
    UpgradeSchedule,
    UpkeepRules,
    WorldConfig,
    default_fruit_tree,
)

# ---------------------------------------------------------------------------
# Paths and process settings (environment-overridable, never secrets)
# ---------------------------------------------------------------------------

BACKEND_DIR = Path(__file__).resolve().parent.parent  # .../backend
REPO_DIR = BACKEND_DIR.parent  # .../antegensim
ENV_FILE = REPO_DIR / ".env"

load_dotenv(ENV_FILE, override=False)


def _env(name: str, default: str) -> str:
    """Environment value or ``default`` when unset OR empty (placeholder lines in .env)."""
    return os.environ.get(name) or default


WORLDS_DIR = Path(_env("EMPYREAN_WORLDS_DIR", str(REPO_DIR / "worlds")))
MODELS_FILE = Path(_env("EMPYREAN_MODELS_FILE", str(BACKEND_DIR / "empyrean" / "models.example.json")))

API_HOST = _env("EMPYREAN_API_HOST", "127.0.0.1")
API_PORT = int(_env("EMPYREAN_API_PORT", "8000"))
# Vite dev server (5173) and its fallback port; the Vite config also proxies /api so the
# frontend can use a same-origin base URL.
CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
]

CODE_REVISION = _env("EMPYREAN_CODE_REVISION", "dev")

# Storage durability (storage.write_checkpoint).  The manifest (commit point), pending-call
# files, staged edits and snapshots are always fsynced.  Turn files are fsynced before the
# manifest points at them so a power loss cannot leave a committed turn with empty files;
# EMPYREAN_FSYNC=0 skips that (a process crash alone stays safe; commits run ~2.5x faster,
# useful for fake-model test runs).  Turn files are flushed concurrently by FSYNC_WORKERS.
FSYNC_TURN_FILES = _env("EMPYREAN_FSYNC", "1").strip().lower() not in ("0", "false", "no", "off")
FSYNC_WORKERS = max(1, int(_env("EMPYREAN_FSYNC_WORKERS", "8")))

# ---------------------------------------------------------------------------
# Token estimate heuristic (A-COG-4).  The ONLY definition; model.py and context.py import it.
# ---------------------------------------------------------------------------

TOKEN_CHARS_PER_TOKEN = 4


def estimate_tokens(text: str) -> int:
    """ceil(len(text) / TOKEN_CHARS_PER_TOKEN); 0 for empty text."""
    return 0 if not text else math.ceil(len(text) / TOKEN_CHARS_PER_TOKEN)


# ---------------------------------------------------------------------------
# Action prices and execution rules (design doc: "Action blocks and approximate costs")
# ---------------------------------------------------------------------------

DEFAULT_PRICES = Prices(move=5, observe=1, query=1, send=3, broadcast=7, absorb=3, transfer=1, wait=0)

# "Upgradeable attributes and prices": 25*2^n compute + 2*2^n essence; attack 100*4^n + 10*4^n;
# the damage cap per attack (A-ACT-19) is priced like attack: 100*4^n + 10*4^n, +25 per purchase.
DEFAULT_UPGRADES = UpgradeSchedule(
    standard_base_compute=25,
    standard_base_essence=2,
    standard_growth=2,
    attack_base_compute=100,
    attack_base_essence=10,
    attack_growth=4,
    attack_cap_base_compute=100,
    attack_cap_base_essence=10,
    attack_cap_growth=4,
)

# "Saved skill compute discount" 0.8; "Turns speed and skill execution" interpreter
# 0.01/op, 100 ops/turn, no recursion.
DEFAULT_SKILL_RULES = SkillRules(
    action_discount=0.8,
    interpreter_cost_per_op=0.01,
    max_ops_per_turn=100,
    allow_recursion=False,
    max_call_depth=16,
    max_repeat_count=10000,
    max_source_chars=4000,
    max_string_chars=4096,
    interrupt_on=[],
)

# "Failure and resource handling" fee min(1, price); "Absorption efficiency" precise accounting.
DEFAULT_ACCOUNTING = AccountingRules(eps=1e-9, failure_fee_cap=1.0)

# "Health damage and recovery": upkeep 1/round, 5 health loss when unpaid; 1 compute -> 1 health.
DEFAULT_UPKEEP = UpkeepRules(compute_per_round=1.0, starvation_health_loss=5.0)
DEFAULT_RECOVERY = RecoveryRules(health_per_compute=1.0)

# "Compute metering": rates are lead decisions (assumption A-COG-1).  mind_multipliers is
# filled per run by RunManager.create_run from the registry.
DEFAULT_COGNITION = CognitionRates(
    input_rate=0.0002,
    generation_rate=0.001,
    default_mind_multiplier=1.0,
    mind_multipliers={},
    usage_estimate_safety_factor=1.0,
    charge_failed_calls=True,
)

DEFAULT_MESSAGES = MessageRules(max_message_tokens=256, chars_per_token=TOKEN_CHARS_PER_TOKEN)

# "Agent death and essence residue": fractions are open -> assumptions A-DEATH-1/2.
DEFAULT_DEATH = DeathRules(essence_residue_fraction=0.4, compute_residue_fraction=0.5, residue_decay_per_round=0.0)

DEFAULT_RANGES = RangeRules()

# "Minimal agent stats" table.
DEFAULT_AGENT_STATS = AgentStats(
    compute=200,
    essence=20,
    essence_capacity=100,
    health=100,
    max_health=100,
    attack=1.0,
    attack_cap=50.0,  # A-ACT-19: at most 50 damage per attack, so a fresh 100-health agent takes 2 hits
    speed=1,
    vision_range=0,
    communication_range=0,
    compute_absorption=0.20,
    essence_absorption=0.10,
    skill_count_limit=5,
    skill_block_limit=100,
)

# ---------------------------------------------------------------------------
# Plants (design doc: "Plants as channels from the ultimate source", "Growth leaves fruit and seeds")
# All numbers are assumptions (A-PLANT-*).  The definition lives in schemas.default_fruit_tree
# so RulesConfig() and default_rules() can never drift.
# ---------------------------------------------------------------------------

FRUIT_TREE: PlantSpeciesRule = default_fruit_tree()

DEFAULT_PLANT_SPECIES: dict[str, PlantSpeciesRule] = {FRUIT_TREE.name: FRUIT_TREE}

# ---------------------------------------------------------------------------
# World generation defaults (design doc defers generation; these are assumptions A-WORLD-*)
# ---------------------------------------------------------------------------

DEFAULT_WORLD = WorldConfig(
    region=Region(min_x=-10, max_x=10, min_y=-10, max_y=10),
    terrain=TerrainGenConfig(
        mountain_clusters=4,
        mountain_cluster_size=4,
        water_clusters=3,
        water_cluster_size=5,
        keep_origin_clear_radius=2,
    ),
    initial_plants={"fruit_tree": 12},
    initial_plant_stage=2,  # start with mature plants so fruit exists early
    plants_at_agent_starts=True,  # A-WORLD-7: one initial plant on each agent's start cell
    initial_plant_fruit=1,  # A-PLANT-13: each initial plant carries one ripe fruit at round 0
    max_entities_per_observation_page=40,
)

# Agents start spread near the origin (assumption A-WORLD-4): the first 12 cards within Manhattan
# radius 2, further cards (up to MAX_AGENTS) on the next rings, generated below.
_FIRST_AGENT_POSITIONS: list[Point] = [
    Point(x=0, y=0),
    Point(x=1, y=0),
    Point(x=0, y=1),
    Point(x=-1, y=0),
    Point(x=0, y=-1),
    Point(x=1, y=1),
    Point(x=-1, y=-1),
    Point(x=2, y=0),
    Point(x=0, y=2),
    Point(x=-2, y=0),
    Point(x=0, y=-2),
    Point(x=1, y=-1),
]


def _ring_positions(count: int) -> list[Point]:
    """``_FIRST_AGENT_POSITIONS`` followed by the remaining points of each Manhattan ring around
    the origin (distance 1, 2, 3, ...), each ring in a fixed order (x ascending, then y
    ascending), until ``count`` points; deterministic, no duplicates."""
    points = [p.model_copy() for p in _FIRST_AGENT_POSITIONS]
    seen = {(p.x, p.y) for p in points}
    distance = 1
    while len(points) < count:
        ring = sorted((x, y) for x in range(-distance, distance + 1) for y in range(-distance, distance + 1) if abs(x) + abs(y) == distance)
        for x, y in ring:
            if len(points) >= count:
                break
            if (x, y) not in seen:
                seen.add((x, y))
                points.append(Point(x=x, y=y))
        distance += 1
    return points[:count]


DEFAULT_AGENT_NAMES: list[str] = [
    "Aster",
    "Boreas",
    "Cyrene",
    "Damaris",
    "Eos",
    "Ferrin",
    "Galene",
    "Halcyon",
    "Iole",
    "Jarek",
    "Kallias",
    "Lysandra",
    # cards 13-64 (MAX_AGENTS)
    "Myrrine", "Nereus", "Orestes", "Phaedra", "Quilla", "Rhea", "Selene", "Theron", "Urania", "Vesna",
    "Wystan", "Xanthe", "Yara", "Zephyr", "Alcyone", "Brisa", "Castor", "Delia", "Elara", "Fenna",
    "Galen", "Hesper", "Ilias", "Jora", "Kora", "Leda", "Melis", "Nyx", "Oriel", "Pallas",
    "Quenby", "Rhodes", "Sabra", "Talos", "Ulric", "Vela", "Wren", "Xenia", "Yael", "Zeno",
    "Arion", "Bellis", "Corin", "Dione", "Evander", "Fiora", "Gideon", "Hestia", "Isidore", "Jessa",
    "Kalyx", "Lorcan",
]

# The spec suggests 6-11 agents; 12 was allowed for arena experiments and 64 since 2026-09-27 for
# large battles (every run pays one model call per living agent per round, so cost and time grow
# with the count).
MAX_AGENTS = MAX_AGENT_CARDS  # 64; the schema's RunCreateRequest.agents bounds are the single source
MIN_AGENTS = MIN_AGENT_CARDS  # 6

DEFAULT_AGENT_POSITIONS: list[Point] = _ring_positions(MAX_AGENTS)

# ---------------------------------------------------------------------------
# Context / memory defaults (technical spec: "Budget delivery and inspection")
# ---------------------------------------------------------------------------

# A-KNOW-9: the persona tip, appended to every agent's persona line when context.persona_tip is on
# (the shipped default for new runs).  It names options the rules already describe; it never
# says which to use.  Without it, un-instructed Haiku agents in live runs almost never wrote
# skills, messaged, gave or attacked (docs/LIMITATIONS.md); with it they did all four.
PERSONA_TIP_TEXT = (
    "Tip: a routine you find yourself repeating can be saved as a skill (save_skills) and started with "
    "run_skill; while it runs you make no decisions, so you pay no thinking. Other agents are options too: "
    "you can message them (send, broadcast), give them compute (transfer) or attack them; a killed agent "
    "leaves all its compute as residue that anyone at that point can absorb. Whether and how to use any "
    "of this is your call."
)

DEFAULT_CONTEXT = ContextSettings(
    input_token_cap=6000,
    generation_allowance=1000,
    recent_history_length=5,
    notebook_max_tokens=400,
    retrieved_memory_limit=5,
    new_event_digest_limit=10,
    weights=RetrievalWeights(relevance=1.0, recency=1.0, importance=1.0),
    include_skill_source=False,
    persona_tip=True,
    persona_tip_text=PERSONA_TIP_TEXT,
)

# Minimum packet: stable rules + core situation + decision request must fit in this many
# input tokens or the agent is skipped for the turn (A-COG-2).
MIN_PACKET_INPUT_TOKENS = 1200
MIN_GENERATION_TOKENS = 200

# Unread digest: one line per urgent record in the mandatory part, at most this many tokens.
DIGEST_LINE_MAX_TOKENS = 40

# Memory priorities (A-KNOW-7)
MAX_STORED_PRIORITIES = 20
PRIORITY_IMPORTANCE_BONUS = 0.3

DEFAULT_MODEL_KEY = "fake-heuristic"  # code and test default (free, deterministic)
# The model GET /api/defaults, the New session form and the assistant's create-run briefs start
# from (EMPYREAN_DEFAULT_MODEL). Falls back to DEFAULT_MODEL_KEY when the key is unknown or
# unavailable (for example no `claude` on PATH); see operator_default_model_key().
OPERATOR_DEFAULT_MODEL_KEY = _env("EMPYREAN_DEFAULT_MODEL", "claude-cli-haiku")
DEFAULT_PLAY_DELAY_SECONDS = 0.2

# ---------------------------------------------------------------------------
# Model boundary
# ---------------------------------------------------------------------------

MODEL_TIMEOUT_SECONDS = 90.0  # per attempt
MODEL_MAX_RETRIES = 2  # retries after the first attempt (timeouts / retryable HTTP only)
# Decision concurrency (A-SCHED-5): every agent that thinks in a round gets its model call
# at round start, and all of them run at once on one process-wide thread pool of this size
# (shared by every open run in the process), so a round costs about one call's latency.
# Lower it on a small machine: each claude_cli call is a subprocess of ~250 MB.
MODEL_CALL_CONCURRENCY = max(1, int(_env("EMPYREAN_MODEL_CONCURRENCY", "16")))
RETRY_BACKOFF_SECONDS = [1.0, 2.0]  # before retry 1, retry 2, ...
RETRY_AFTER_MAX_SECONDS = 10.0  # honour Retry-After up to this
ERROR_TEXT_MAX_CHARS = 500  # every stored error string is redacted and capped

# claude_cli adapter: the subprocess gets ONLY these environment variables (plus nothing
# named in any registry credential_env and nothing starting with EMPYREAN_).
CLAUDE_CLI_ENV_ALLOWLIST = ("PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER", "SHELL", "TMPDIR", "XDG_CONFIG_HOME")
CLAUDE_CLI_EXECUTABLE = "claude"

# Provider-side input tokens an adapter adds beyond the messages and the schema text
# (tool-use system prompt, CLI harness text), counted by model.request_overhead_tokens
# (A-COG-8).  Provisional: anthropic is an estimate of the tool-use preamble; claude_cli was
# measured (~1140 tokens for a tiny prompt with --json-schema, CLI 2.1.x).  A registry entry
# overrides its own value with options.overhead_tokens.
MODEL_FIXED_OVERHEAD_TOKENS: dict[str, int] = {
    "fake": 0,
    "anthropic": 350,
    "openai": 50,
    "fireworks": 50,
    "foundry": 50,
    "bedrock": 0,
    "claude_cli": 1150,
}
# claude_cli --max-turns: 1 allows exactly one billed model request (a valid structured
# reply reports num_turns == 2 because the CLI counts the StructuredOutput tool call; an
# invalid one ends as subtype error_max_turns, reported as the agent-output status
# "malformed").  Override per registry entry with options.max_turns.
CLI_MAX_TURNS = 1
# claude_cli: seconds to wait for a killed process group to be reaped after a timeout.
CLI_KILL_GRACE_SECONDS = 5.0
# claude_cli: model requests the CLI may spend on one decision (A-COG-9).  The CLI cannot force
# the StructuredOutput tool choice; when the model's first response is text only it re-prompts
# once (a second billed request whose usage and cost the envelope sums).  1 of 22 live Haiku
# decisions did this; rejecting it as an infrastructure error halted the run.  Beyond this many
# requests the reply is an "error".  Override per registry entry with options.max_model_requests.
# (Asking for the tool call in the system prompt is NOT a fix: a "call StructuredOutput with the
# JSON object as its input" line made Haiku wrap the decision under an "input" key, 24/24 malformed.)
CLI_MAX_MODEL_REQUESTS = 2
# claude_cli: MAX_THINKING_TOKENS for the subprocess (A-COG-10).  0 = no extended thinking (the
# CLI default is adaptive thinking; measured live it used 40-70% of the output tokens, 668 of a
# 968-token reply under the 1000-token generation allowance, so it competes with the notebook
# and skill text and doubles latency).  None = leave the CLI default.  Override per registry
# entry with options.max_thinking_tokens (an explicit null keeps the CLI default).
CLI_MAX_THINKING_TOKENS: int | None = 0
# model.extract_json_object tries at most this many '{' start positions in a reply.
MAX_JSON_SCAN_STARTS = 200

# ---------------------------------------------------------------------------
# Runner / feed
# ---------------------------------------------------------------------------

EVENTS_PAGE_LIMIT = 500
EVENT_RING_BUFFER_SIZE = 2000  # recent seqs served from memory
INITIAL_FEED_WINDOW = 300  # the UI starts polling at max(0, latest_seq - this)
POLL_INTERVAL_MS = 700

# ---------------------------------------------------------------------------
# Assistant (rev 4).  Every value is environment-overridable and none is a secret.  The
# assistant's model calls go through model.call_model like the agents' but are metered in
# their own ledger (<scope>/assistant/usage.jsonl), never in Manifest.real_usage.
# ---------------------------------------------------------------------------


def _env_float(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


def _env_flag(name: str, default: str) -> bool:
    return _env(name, default).strip().lower() not in ("0", "false", "no", "off")


# Model key per profile (registry keys; validated with ModelRegistry.validate_key at service start).
ASSISTANT_MODEL_CHAT = _env("EMPYREAN_ASSISTANT_MODEL_CHAT", "claude-cli-sonnet-assistant")
ASSISTANT_MODEL_NARRATOR = _env("EMPYREAN_ASSISTANT_MODEL_NARRATOR", "claude-cli-haiku-assistant")
ASSISTANT_MODEL_AUTHOR = _env("EMPYREAN_ASSISTANT_MODEL_AUTHOR", "claude-cli-sonnet-assistant")
ASSISTANT_MODEL_SUMMARIZER = _env("EMPYREAN_ASSISTANT_MODEL_SUMMARIZER", "claude-cli-haiku-assistant")
ASSISTANT_PROFILES: tuple[str, ...] = ("chat", "narrator", "author", "summarizer")

# Budgets in USD (list-price estimates; A-AST-2).  chat: per scope (run or global); storybook: per
# run; story: per story job (the story brief may set its own); message: per user message (all
# steps); global: across every scope in this process.
ASSISTANT_CHAT_BUDGET_USD = _env_float("EMPYREAN_ASSISTANT_CHAT_BUDGET_USD", 5.0)
ASSISTANT_STORYBOOK_BUDGET_USD = _env_float("EMPYREAN_ASSISTANT_STORYBOOK_BUDGET_USD", 2.0)
ASSISTANT_STORY_BUDGET_USD = _env_float("EMPYREAN_ASSISTANT_STORY_BUDGET_USD", 5.0)
ASSISTANT_GLOBAL_BUDGET_USD = _env_float("EMPYREAN_ASSISTANT_GLOBAL_BUDGET_USD", 20.0)
ASSISTANT_MESSAGE_BUDGET_USD = _env_float("EMPYREAN_ASSISTANT_MESSAGE_BUDGET_USD", 0.75)
# Before every call the engine checks spent + this estimate against the applicable limits (R1).
ASSISTANT_CALL_COST_ESTIMATE_USD = 0.05

# Chat step loop (A-AST-7).
ASSISTANT_MAX_STEPS = 4  # model calls per user message; the last step gets the answer|ask schema
ASSISTANT_MESSAGE_TIMEOUT_SECONDS = 90.0  # wall clock per user message (all steps)
ASSISTANT_TOOL_OUTPUT_MAX_CHARS = 6000  # each read tool's result is capped with a truncation note
ASSISTANT_TOOLS_PER_STEP = 3  # read tools one step may request

# Prompt layout (A-AST-4/5): byte-stable system prompt (knowledge core + rules + tool catalogue),
# volatile user message (context, memory, retrieved docs, tool results, the question).
KNOWLEDGE_CORE_TOKENS = 8000
KNOWLEDGE_RETRIEVAL_TOKENS = 4000
MEMORY_TOKEN_BUDGET = 3000
ASSISTANT_SYSTEM_PROMPT_MAX_BYTES = 96 * 1024  # asserted before every call (CLI argv)
ASSISTANT_SCHEMA_MAX_BYTES = 16 * 1024  # compact per-profile JSON schema
# Output caps per profile (R6): generous relative to the expected output; the prompt asks for brevity.
ASSISTANT_OUTPUT_TOKENS: dict[str, int] = {
    "chat": 6000,  # a create-run brief with 12 agent cards needs well over 2000 output tokens
    "narrator": 600,
    "narrator_batched": 2400,
    "chapter": 3000,
    "summarizer": 1000,
}
# Request settings per profile (R6): (timeout_seconds per attempt, max_retries).
ASSISTANT_REQUEST_SETTINGS: dict[str, tuple[float, int]] = {
    "chat": (90.0, 0),
    "author": (90.0, 0),
    "narrator": (60.0, 1),
    "summarizer": (60.0, 1),
}

# Storybook (A-AST-1/3).  STORYBOOK_AUTO: "on" | "off" | "auto" (default "off": narration only on
# request; auto = on unless a paid narrator would narrate an all-fake-agent run).
STORYBOOK_AUTO = _env("EMPYREAN_STORYBOOK_AUTO", "off").strip().lower()
if STORYBOOK_AUTO not in ("on", "off", "auto"):
    STORYBOOK_AUTO = "off"
STORYBOOK_BATCH_MAX = 12  # turns per narrator call when the backlog is > STORYBOOK_BATCH_THRESHOLD
STORYBOOK_BATCH_THRESHOLD = 2
ASSISTANT_BACKGROUND_PAUSE_SECONDS = 60.0  # background profiles pause after a 429/overload

# List prices in USD per million tokens keyed by response_model PREFIX (longest match wins):
# (input, cache_read, cache_write, output).  Anthropic first-party rates as of 2026-06 (the CLI
# reports total_cost_usd itself; this table only prices calls whose cost the provider left None).
ASSISTANT_PRICES: dict[str, tuple[float, float, float, float]] = {
    "claude-haiku-4-5": (1.00, 0.10, 1.25, 5.00),
    "claude-sonnet-4-6": (3.00, 0.30, 3.75, 15.00),
    "claude-sonnet-5": (2.00, 0.20, 2.50, 10.00),
    "claude-opus-4": (5.00, 0.50, 6.25, 25.00),
    "claude-opus-5": (5.00, 0.50, 6.25, 25.00),
    "fake": (0.0, 0.0, 0.0, 0.0),
}
ASSISTANT_PRICE_FALLBACK: tuple[float, float, float, float] = (3.00, 0.30, 3.75, 15.00)

# Speech (A-AST-6): local faster-whisper behind model.transcribe.  Preload happens in main only.
WHISPER_MODEL = _env("EMPYREAN_WHISPER_MODEL", "large-v3-turbo")
WHISPER_PRELOAD = _env_flag("EMPYREAN_WHISPER_PRELOAD", "1")
WHISPER_MAX_AUDIO_BYTES = 10_000_000
WHISPER_MAX_SECONDS = 65  # the UI stops recording at 60 s
WHISPER_CPU_THREADS = min(8, os.cpu_count() or 1)
WHISPER_DEVICE = "cpu"
WHISPER_COMPUTE_TYPE = "int8"
WHISPER_LANGUAGE_DEFAULT = "en"

# Server log ring buffer (assistant get_server_log tool): empyrean.* loggers at INFO+, redacted.
SERVER_LOG_RING_LINES = 2000
SERVER_LOG_TAIL_MAX_CHARS = 6000

# claude_cli: any single argv string above this many bytes is refused as invalid_config (the OS
# limit is ~128 KiB; the assistant asserts its system prompt < ASSISTANT_SYSTEM_PROMPT_MAX_BYTES).
CLI_ARGV_MAX_BYTES = 100_000

# Storage under the worlds dir for conversations that belong to no run (A-AST-10).
ASSISTANT_GLOBAL_DIR_NAME = "_assistant"

# ---------------------------------------------------------------------------
# ASSUMPTIONS registry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Assumption:
    key: str  # config key (dotted path into RulesConfig / WorldConfig / this module) or rule name
    default: Any
    citation: str  # design-doc or spec section
    rationale: str


ASSUMPTIONS: dict[str, Assumption] = {
    # -- death and residue ----------------------------------------------------
    "A-DEATH-1": Assumption(
        key="rules.death.essence_residue_fraction",
        default=0.4,
        citation="Design: 'Agent death and essence residue' (fraction 'still undecided'; 40% used illustratively)",
        rationale="Use the doc's illustrative 40% so residue is meaningful but lossy.",
    ),
    "A-DEATH-2": Assumption(
        key="rules.death.compute_residue_fraction",
        default=0.5,
        citation="Design: 'Residue and extraction' ('Compute residue policy ... remain parameters to settle')",
        rationale="Half of held compute becomes residue compute at death; the rest is lost.",
    ),
    "A-DEATH-3": Assumption(
        key="rules.death.residue_decay_per_round",
        default=0.0,
        citation="Design: 'Residue and extraction' (persistence/decay open)",
        rationale="Residue persists until absorbed; decay is available but off.",
    ),
    "A-DEATH-4": Assumption(
        key="rules.plant_species.<name>.essence_residue_fraction",
        default=0.5,
        citation="Design: 'Conflict injury and extraction' plant compatibility suggestion",
        rationale="Lethal hit converts half of the pre-hit living essence into residue essence.",
    ),
    "A-DEATH-5": Assumption(
        key="rules.plant_species.<name>.energy_residue_fraction",
        default=0.0,
        citation="Design: 'Residue and extraction' (plant energy at death unspecified)",
        rationale="A dead plant's stored (unfruited) energy is lost; fruit already spawned remains.",
    ),
    "A-DEATH-6": Assumption(
        key="dead entity lifecycle",
        default="dead agents/plants stay in the world with alive=false, balances/health 0 and their position; excluded from observe, targeting and initiative (actions against them -> target_gone); residue only when compute or essence > eps; an operator edit leaving a living agent at health <= 0 resolves kill_agent(cause='operator') at the boundary",
        citation="Design: 'Agent death and essence residue' (death resolved once); Spec: 'God mode' (edits preserve valid state); 'Display' (after-death)",
        rationale="One death path for every cause; the UI can still show where an agent died.",
    ),
    # -- cognition and metering ------------------------------------------------
    "A-COG-1": Assumption(
        key="rules.cognition.{input_rate,generation_rate,default_mind_multiplier}",
        default={"input_rate": 0.0002, "generation_rate": 0.001, "mind_multiplier": 1.0},
        citation="Design: 'Compute metering' (rates are 'conversion factors'; open decision 1)",
        rationale="A 6000-token packet + 500 output tokens costs ~1.7 compute, comparable to one cheap action.",
    ),
    "A-COG-2": Assumption(
        key="config.MIN_PACKET_INPUT_TOKENS / MIN_GENERATION_TOKENS",
        default={"input": 1200, "output": 200},
        citation="Spec: 'Budget delivery and inspection' ('if the minimum valid packet is unaffordable ... explicit resource result')",
        rationale="Below this reservation the agent idles for the turn with a resource_skip event and a system record.",
    ),
    "A-COG-3": Assumption(
        key="rules.cognition.charge_failed_calls / usage_estimate_safety_factor",
        default={"charge_failed_calls": True, "usage_estimate_safety_factor": 1.0},
        citation="Design: 'Compute metering' implementation note (fallback when usage unavailable; retry accounting policy)",
        rationale="Agent-output failures (malformed/refusal/truncated) charge reported usage; the safety factor applies only to estimated usage.",
    ),
    "A-COG-4": Assumption(
        key="config.TOKEN_CHARS_PER_TOKEN",
        default=4,
        citation="Lead decision: token estimate heuristic ceil(len(text)/4)",
        rationale="Single definition config.estimate_tokens used for packet budgeting and as usage fallback.",
    ),
    "A-COG-5": Assumption(
        key="infrastructure failures",
        default="timeout/error/invalid_config after bounded retries -> model_call_failed(infra=true), no charge, no agent turn committed; the run enters state 'error' (last_error 'provider failure: <status>'); pause recovers and the same turn is re-run",
        citation="Spec: 'Two distinct validation gates' ('distinguish infrastructure errors from agent choices'); Design: 'Compute metering' caution (pause explicitly)",
        rationale="A host problem never looks like an agent choice or an ecological event.",
    ),
    "A-COG-6": Assumption(
        key="cognition overdraft",
        default="actual cognition is charged up to the agent's balance; the remainder is recorded as ModelCallRecord.uncharged_compute (ledger stays exact)",
        citation="Design: 'Compute metering' (charge measured usage; explicit fallback)",
        rationale="Never negative balances, never a hidden gap.",
    ),
    "A-COG-7": Assumption(
        key="settings.real_budget_usd",
        default=None,
        citation="Design: 'Compute metering' caution ('If the host budget is exhausted, pause the experiment explicitly')",
        rationale=(
            "The budget is 'reached' when the ledger's provider_cost_usd > 0 and >= real_budget_usd (a fake run with "
            "budget 0 never trips); the runner checks before each call and again after it.  A post-call trip records "
            "the measured usage uncharged and carries the call record into the re-run; the run enters 'error' with "
            "last_error 'host budget exhausted'."
        ),
    ),
    "A-COG-8": Assumption(
        key="schema overhead in the packet budget",
        default="model.request_overhead_tokens(model_key) (native schema/tool-use tokens) is added to the mandatory packet size and the reservation",
        citation="Spec: 'Budget delivery and inspection' ('Count instructions and schemas too')",
        rationale="Keeps provider branching inside model.py while the cap stays honest.",
    ),
    "A-COG-9": Assumption(
        key="config.CLI_MAX_MODEL_REQUESTS / options.max_model_requests",
        default=2,
        citation="Design: 'Compute metering' ('Charge measured usage after the call'; retries need 'an experiment-wide accounting policy')",
        rationale=(
            "The claude_cli route cannot force the StructuredOutput tool choice: when the model's first response is "
            "text only the CLI re-prompts once and its envelope sums both requests' usage and cost.  Such a reply is "
            "accepted (charged in full, noted in attempt_errors); more requests than this are an infrastructure error.  "
            "Live evidence: 1 of 22 Haiku decisions; treating it as an error halted the run with a valid decision in hand."
        ),
    ),
    "A-COG-10": Assumption(
        key="config.CLI_MAX_THINKING_TOKENS / options.max_thinking_tokens",
        default=0,
        citation="Design: 'Compute metering' (generated tokens include 'any separately reported reasoning usage'); Spec: 'Budget delivery' (generation allowance)",
        rationale=(
            "Extended thinking is off for the claude_cli route: measured live it took 40-70% of the output tokens "
            "(668 of a 968-token reply under the 1000-token allowance), competing with the notebook and skill text "
            "and doubling latency.  The 'thought' field remains the agent's paid reasoning.  Set to null to keep the CLI default."
        ),
    ),
    "A-ECON-2": Assumption(
        key="cognition reservation",
        default="reserve = min(balance, cost(input_cap, generation_allowance)); charge actual after the call; nothing is deducted up front",
        citation="Design: 'Compute metering' suggested enforcement",
        rationale="If reserve < cost(min packet) the call is skipped.",
    ),
    # -- actions and ranges --------------------------------------------------
    "A-ACT-1": Assumption(
        key="rules.ranges.*_requires_same_point",
        default=True,
        citation="Design: 'Action blocks' suggested range defaults (Manhattan; attack/absorb/transfer same point)",
        rationale="observe/query follow vision range; send/broadcast follow communication range; others same point.",
    ),
    "A-ACT-2": Assumption(
        key="rules.ranges.outside_region_is_blocked",
        default=True,
        citation="Design: 'Spawned terrain and passage' (region generation deferred)",
        rationale=(
            "A move outside the generated region is always refused (every entity must stay inside the region); "
            "the flag only picks the reason: True -> 'blocked' (like a mountain), False -> 'out_of_range'."
        ),
    ),
    "A-ACT-3": Assumption(
        key="rules.messages.{max_message_tokens,chars_per_token}",
        default={"max_message_tokens": 256, "chars_per_token": 4},
        citation="Design: 'Action blocks' suggested message limit",
        rationale="world.py measures ceil(len/chars_per_token); longer or empty messages fail with invalid_argument and the attempt fee.",
    ),
    "A-ACT-4": Assumption(
        key="world.max_entities_per_observation_page",
        default=40,
        citation="Design: 'Observe query and action feedback' (pagination allowed)",
        rationale=(
            "observe returns at most this many entities per page plus total count and page info; a page past the "
            "end is ok with an empty list.  generate_world copies the value to WorldState.observation_page_size, "
            "which the run keeps (editable in god mode)."
        ),
    ),
    "A-ACT-5": Assumption(
        key="query(other agent) public fields",
        default=["id", "name", "position", "health", "max_health", "attack", "attack_cap", "speed", "alive"],
        citation="Design: 'Observe query and action feedback' query table ('Visibility choice')",
        rationale="Private balances (compute/essence) are not public.",
    ),
    "A-ACT-6": Assumption(
        key="transfer recipient kinds",
        default=["agent"],
        citation="Design: 'Action blocks' (transfer to 'a valid recipient'; plants excluded)",
        rationale="Only living, visible agents at the same point can receive transfers.",
    ),
    "A-ACT-7": Assumption(
        key="wait(rounds) semantics",
        default="consumes the current turn and the next rounds-1 turns; wait costs 0",
        citation="Design: 'Turns speed and skill execution' (wait(3) example)",
        rationale="Waiting agents receive events normally and get no model call while waiting.",
    ),
    "A-ACT-8": Assumption(
        key="attack on dead/absent/unseen target",
        default="target_gone with attempt fee",
        citation="Design: 'Conflict injury' ('A subsequent attack against an already-dead target fails')",
        rationale="Attempt fee min(1, price) where price = nominal budget.",
    ),
    "A-ACT-9": Assumption(
        key="rules.accounting.failure_fee_cap",
        default=1.0,
        citation="Design: 'Failure and resource handling' (fee min(1, normal action compute cost))",
        rationale="Cap on the attempt fee for affordable-but-illegal actions, in BOTH direct and skill mode (x discount in a skill).",
    ),
    "A-ACT-10": Assumption(
        key="rules.recovery.health_per_compute",
        default=1.0,
        citation="Design: 'Health damage and recovery' (suggested 1 compute restores 1 health)",
        rationale="Recovery conversion rate.",
    ),
    "A-ACT-11": Assumption(
        key="rules.upkeep.{compute_per_round,starvation_health_loss}",
        default={"compute_per_round": 1.0, "starvation_health_loss": 5.0},
        citation="Design: 'Health damage and recovery' (suggested initial values)",
        rationale="An agent at 100 health with zero compute lasts 20 rounds.",
    ),
    "A-ACT-12": Assumption(
        key="broadcast with no recipient in range",
        default="succeeds and charges the full price",
        citation="Design: 'Action blocks' (fan-out follows current range)",
        rationale="The action was legal; nobody heard it.",
    ),
    "A-ACT-13": Assumption(
        key="skill action with invalid evaluated arguments",
        default="the interpreter delivers ActionResult(ok=false, reason='invalid_argument', cost 0) to the skill, the turn is used, no world call and no fee",
        citation="Design: 'Failure and resource handling' (budgets positive/finite); 'Imperative blocks' (a failed action yields a result later logic can inspect)",
        rationale="Skills branch on r.ok instead of dying; direct decisions with bad arguments never reach the world (format gate).",
    ),
    "A-ACT-14": Assumption(
        key="visibility-first failure reasons",
        default="entity-targeted actions return target_gone for any id that is not a living, present entity the caller can currently see; out_of_range is reserved for point arguments and for visible entities not at the required distance",
        citation="Design: 'Observe query and action feedback' ('knowing an old ID does not bypass range'; effects without leaking hidden state); 'Design principles' #3",
        rationale="A 1-compute probe cannot reveal whether a distant id exists.",
    ),
    "A-ACT-15": Assumption(
        key="send/broadcast visibility",
        default="send requires the recipient to be visible to the sender AND within communication range (else target_gone); broadcast delivers to every living agent within range but reports only recipients the sender can see (data.delivered_to_visible) and no total count",
        citation="Design: 'Coordinates vision and communication' (asymmetric reception; vision and reach are separate capabilities)",
        rationale="Messaging never becomes a sensor beyond vision range.",
    ),
    "A-ACT-16": Assumption(
        key="self-target and wrong entity kind",
        default="target == actor or a target of the wrong kind (attack a fruit, absorb from an agent) -> invalid_argument with the attempt fee; absorb checks empty_source before at_limit",
        citation="Design: 'Action blocks' (valid recipient; another agent); 'Absorption efficiency'",
        rationale="target_gone would falsely say the target vanished.",
    ),
    "A-ACT-17": Assumption(
        key="rules.accounting.eps",
        default=1e-9,
        citation="Design: 'Absorption efficiency' ('Use precise resource accounting'; fail rather than destroy for zero gain); 'Upgradeable attributes' (capped at 100%)",
        rationale="Amounts below eps are empty; absorption stats are rounded to 9 decimals and clamped; essence gained = min(raw x eff, free capacity).",
    ),
    "A-ACT-18": Assumption(
        key="upgrade at a hard cap",
        default="quote shows the formula price, next_value = current, allowed = false; upgrade returns at_limit and charges only the attempt fee when affordable, else insufficient_compute with no debit",
        citation="Design: 'Upgradeable attributes and prices' (at_limit changes nothing and does not charge the full price)",
        rationale="Deterministic behaviour a skill can branch on.",
    ),
    "A-ACT-19": Assumption(
        key="stats.attack_cap (damage cap per attack)",
        default=(
            "50 damage per attack (starting stat); damage = min(attack x compute_budget, attack_cap); a budget above "
            "attack_cap / attack is cut to it and only the cut budget is charged (x skill discount); upgradable by +25 "
            "for upgrades.attack_cap_base_compute x attack_cap_growth^n compute + attack_cap_base_essence x "
            "attack_cap_growth^n essence (100 x 4^n + 10 x 4^n)"
        ),
        citation="Operator request (2026-09-27): fights of several exchanges instead of one decisive blow",
        rationale=(
            "Without a cap damage grows linearly with the compute committed, so any agent holding enough compute "
            "kills in one blow and the victim never acts; a cap forces several hits, giving the victim turns to flee, "
            "recover or strike back.  Priced like attack so a higher cap is a real, exponentially costly investment."
        ),
    ),
    # -- skills and interpreter ------------------------------------------------
    "A-SKILL-1": Assumption(
        key="action calls only as whole SET rhs or bare statement",
        default=True,
        citation="Design: 'Imperative blocks and expressions' (all examples use SET x = action(...))",
        rationale="Makes resumption after a world action trivial; nested action calls are rejected at save time.",
    ),
    "A-SKILL-2": Assumption(
        key="rules.skills.max_ops_per_turn exhausted without reaching an action",
        default="skill yields; the agent's turn is consumed with no world action; resumes next turn",
        citation="Design: 'Turns speed and skill execution' interpreter suggestion",
        rationale="Bounds runaway loops; the turn is spent (upkeep continues).",
    ),
    "A-SKILL-3": Assumption(
        key="rules.skills.{max_source_chars,max_string_chars}",
        default={"max_source_chars": 4000, "max_string_chars": 4096},
        citation="Design: 'Minimal agent stats' per-skill block limit (chars are not blocks; this bounds parsing)",
        rationale=(
            "Prevents pathological sources and unbounded '+' string growth; the block limit remains the gameplay "
            "limit.  Parser nesting depths (32 levels) are host limits in skills.py, not rules."
        ),
    ),
    "A-SKILL-4": Assumption(
        key="skill block counting",
        default="each statement = 1; each expression operator (binary/unary), field access, coord and action call = 1; literals, names, ELSE, END = 0; CALL counts 1 in the caller",
        citation="Design: 'Minimal agent stats' ('Skill size counts action statements, control statements, assignments, calls, and expression operations')",
        rationale="Deterministic, documented count (design example 2 = 48 blocks).",
    ),
    "A-SKILL-5": Assumption(
        key="run_skill while skill_execution exists",
        default="a model decision is only taken when no skill is running (or after an interrupt stopped it), so run_skill never finds a running skill; a finished/stopped/error execution record is replaced",
        citation="Design: 'Turns speed and skill execution'",
        rationale="A skill mid-execution never gets a model call unless interrupted (A-SKILL-9).",
    ),
    "A-SKILL-6": Assumption(
        key="saving/deleting skills in the same decision as run_skill",
        default="delete_skills, then save_skills in list order (each save sees earlier saves), then the action; saving or deleting a skill named in a running execution's frames stops it",
        citation="Lead decision: saving/deleting skills does not consume the world-action turn",
        rationale="Order: delete, then save, then action.",
    ),
    "A-SKILL-7": Assumption(
        key="rules.skills.{interpreter_cost_per_op,action_discount}",
        default={"interpreter_cost_per_op": 0.01, "action_discount": 0.8},
        citation="Design: interpreter suggestion; 'Saved skill compute discount'",
        rationale="The discount is a fixed execution rule; the op cost is an engine limit.",
    ),
    "A-SKILL-8": Assumption(
        key="rules.skills.allow_recursion / max_call_depth",
        default={"allow_recursion": False, "max_call_depth": 16},
        citation="Design: interpreter suggestion ('Reject recursive skill-call cycles initially')",
        rationale="Cycles are rejected at save time; the depth limit only matters when recursion is enabled.",
    ),
    "A-SKILL-9": Assumption(
        key="rules.skills.interrupt_on",
        default=[],
        citation="Spec: 'Purpose and scope' (unresolved rules must be configurable); Design: 'Observe query and action feedback' (events available at the skill-resume boundary)",
        rationale="An unread record of a listed kind stops the running skill at its resume boundary ('interrupted') and the agent takes a model decision that turn; default off. The check is made at round start with every decision (A-SCHED-5), so an arrival during the round interrupts at the next round.",
    ),
    "A-SKILL-10": Assumption(
        key="events inside skills",
        default="skills cannot read received events; only self and here are implicit; data reaches a skill through run_skill arguments and action results",
        citation="Design: 'Imperative blocks and expressions' ('supplied events')",
        rationale="Deferred; an implicit events list can be added later without changing the grammar.",
    ),
    "A-SKILL-11": Assumption(
        key="skill ends on a resumed turn without an action",
        default="the skill event is emitted (interpreter ops charged first) and the agent continues into a normal model decision in the SAME turn, made at that moment from the world as it is (not a round-start decision, A-SCHED-5); a run_skill from a model decision that ends without an action uses the turn",
        citation="Design: 'Turns speed and skill execution' ('Chaining five moves in a saved skill therefore takes five turns')",
        rationale="Design example 1 uses exactly 3 agent turns; the 4th turn is a model decision.",
    ),
    "A-SKILL-12": Assumption(
        key="REPEAT count and literal argument checks",
        default="REPEAT accepts an integer-valued number >= 0 (0 = zero iterations) up to rules.skills.max_repeat_count, else runtime error; literal action arguments are validated at save time (direction, resource, attribute, positive budgets/amounts, positive integer wait, integer coordinates)",
        citation="Design: 'Failure and resource handling' (counts are positive integers); 'Imperative blocks' (validate argument types before accepting)",
        rationale="Bad literals fail at save; only computed values can fail at runtime (A-ACT-13).",
    ),
    "A-SKILL-13": Assumption(
        key="interpreter op accounting",
        default="1 op per executed instruction + 1 per evaluated operator/field/coord node (same node set as block counting); literals, variables and the action-call node are free; when AND/OR short-circuits, neither the right operand nor the AND/OR node itself is counted (IF a.ok == true AND b > 1 with a.ok false = 1 + 2 = 3 ops; fully evaluated 5, its static maximum); an instruction whose maximum static cost would exceed the per-turn budget is not started (yield)",
        citation="Design: 'Turns speed and skill execution' interpreter suggestion ('per evaluated instruction or expression operation')",
        rationale="Deterministic and aligned with block counting; charged as an unrounded fraction.",
    ),
    "A-SKILL-14": Assumption(
        key="skill mutation rules",
        default="deleting a skill that another saved skill CALLs is rejected ('referenced by X'); re-saving a called skill re-checks callers' arity; run_skill/CALL arity is exact; run_skill of an unknown skill emits skill_error, no action, no fee, turn used",
        citation="Design: 'Imperative blocks' (validate referenced skill names); Spec: 'Persistence requirement' (restart with the correct skill position)",
        rationale="A frame's pc always indexes the code it was compiled from.",
    ),
    # -- plants ---------------------------------------------------------------
    "A-PLANT-1": Assumption(
        key="rules.plant_species.fruit_tree.stages",
        default="sprout(0) / sapling(5) / mature(15) by age; inflow 2/6/12 energy and 0.2/0.5/1.0 essence per round; essence caps 10/25/60; energy caps 60/120/180",
        citation="Design: 'Growth leaves fruit and seeds' (stages, maturation open)",
        rationale="Stage by age; inflow grows with stage.",
    ),
    "A-PLANT-2": Assumption(
        key="fruit funding",
        default="fruit spawns when interval elapsed AND plant.energy >= fruit_energy AND live fruit < max_fruit; deducts fruit_energy",
        citation="Design: 'Plants as channels' suggested first policy",
        rationale="Source inflow is the only origin of fruit energy; the ledger balances.",
    ),
    "A-PLANT-3": Assumption(
        key="rules.plant_species.fruit_tree.fruit_energy",
        default=60.0,
        citation="Design: open decision 'Do low absorption yields support survival?'",
        rationale="At 20% efficiency one fruit yields 12 compute minus 3 fee = 9 net, ~9 rounds of upkeep.",
    ),
    "A-PLANT-4": Assumption(
        key="seeds",
        default="mature plants drop a seed every seed_interval_rounds within dispersal radius on land; germinate after delay; capped by max_seeds_alive per plant",
        citation="Design: 'Growth leaves fruit and seeds' seed suggestion",
        rationale="Dormant seed records, source-funded initial essence at germination; no harvestable essence.",
    ),
    "A-PLANT-5": Assumption(
        key="plant attack",
        default="damage reduces living essence; lethal when essence <= 0; residue from pre-hit essence * essence_residue_fraction",
        citation="Design: 'Conflict injury' plant compatibility suggestion",
        rationale="Provisional bridge rule as written.",
    ),
    "A-PLANT-6": Assumption(
        key="fruit lifetime",
        default="fruit persists until absorbed (fruit_decay_rounds=0); with N > 0 a fruit is removed at age >= N and its remaining compute is recorded as lost",
        citation="Design: 'Growth leaves fruit and seeds' (ripening/regrowth open)",
        rationale="Fruit with available_compute < eps is removed at round end.",
    ),
    "A-PLANT-7": Assumption(
        key="world.initial_plant_stage",
        default=2,
        citation="Design: 'Minimum prototype' (one deterministic fruit/seed plant)",
        rationale="Initial plants are placed mature so fruit exists within a few rounds.",
    ),
    "A-PLANT-13": Assumption(
        key="world.initial_plant_fruit",
        default=1,
        citation="Design: 'Minimum prototype' ('Verify a basic loop: observe a point, query fruit, absorb compute'); 'Plants as channels' (the source funds plants)",
        rationale=(
            "Each initial plant carries this many ripe fruit at round 0 (capped by the species max_fruit), funded by "
            "the source and recorded in total_fruit_produced / total_source_energy.  Without it initial plants start "
            "with an empty energy store and the first fruit appears at round 5 (12 energy/round, 60 per fruit, "
            "5-round interval), so no live run shorter than that can exercise absorption.  0 restores the old behaviour."
        ),
    ),
    "A-PLANT-8": Assumption(
        key="mature stage fruit/seed intervals > 0",
        default=True,
        citation="Design: 'Growth leaves fruit and seeds' (continuing production is a proposal)",
        rationale="Mature plants keep producing so they never become inert.",
    ),
    "A-PLANT-9": Assumption(
        key="total world source budget",
        default=None,
        citation="Design: 'Plants as channels' suggested first policy (optional total budget)",
        rationale="No global cap; more plants increase aggregate inflow.",
    ),
    "A-PLANT-10": Assumption(
        key="plants on non-land terrain",
        default="end_round skips aging, inflow, fruit and seed production for a plant whose cell is not land (recorded in the round summary); placing a plant or seed on non-land is rejected; a seed on non-land at germination time stays dormant",
        citation="Design: 'Spawned terrain and passage' and 'Plants as channels' ('Water never supports plant spawning, germination, or growth')",
        rationale="Terrain edits under a plant simply pause it.",
    ),
    "A-PLANT-11": Assumption(
        key="rules.plant_species.<name>.stages[*].max_energy",
        default="max_fruit x fruit_energy for the mature stage (180); 60 / 120 for sprout / sapling",
        citation="Design: 'Plants as channels' ('Individual resource stores also have limits'); 'Design principles' #5",
        rationale="Inflow is clipped at the cap; total_source_* record only the admitted inflow so the ledger balances.",
    ),
    "A-PLANT-12": Assumption(
        key="round-end counters",
        default="rounds_since_fruit/seed are incremented in step 1; a spawn happens when counter >= interval and all conditions hold, then the counter resets to 0; a blocked spawn keeps the counter; max_fruit and max_seeds_alive apply per plant",
        citation="Design: 'Growth leaves fruit and seeds'",
        rationale="One documented counting rule.",
    ),
    # -- world generation and scheduling --------------------------------------
    "A-WORLD-1": Assumption(
        key="world.region",
        default="-10..10 on both axes",
        citation="Design: 'Minimum prototype' ('A modest integer-coordinate region')",
        rationale="441 cells is inspectable in one screen.",
    ),
    "A-WORLD-2": Assumption(
        key="world.terrain",
        default="seeded clusters: 4 mountain clusters of ~4 cells, 3 water clusters of ~5 cells; origin radius 2 kept land",
        citation="Design: 'Spawned terrain and passage' (generation deferred)",
        rationale="Mostly land, a few obstacles.",
    ),
    "A-WORLD-3": Assumption(
        key="world.initial_plants",
        default={"fruit_tree": 12},
        citation="Design: 'Minimum prototype'",
        rationale="Seeded uniform placement on land cells.",
    ),
    "A-WORLD-7": Assumption(
        key="world.plants_at_agent_starts",
        default=True,
        citation="Design: 'Minimum prototype' (basic loop verification); 'Coordinates vision and communication' (starting vision is the own point)",
        rationale=(
            "The first initial plants of each species (one per distinct agent start cell, in card order) are placed on "
            "the agents' start cells; the rest are uniform on land.  With vision_range 0 an agent only sees its own "
            "cell; in two live worlds (seeds 1 and 3) the nearest uniformly placed plant was 5 steps from the start "
            "cluster in an unknown direction, so fruit was unfindable.  false restores uniform placement."
        ),
    ),
    "A-WORLD-4": Assumption(
        key="config.DEFAULT_AGENT_POSITIONS",
        default="the first 12 cards spread within Manhattan radius 2 of the origin; cards 13-64 on the next Manhattan rings (out to radius 6)",
        citation="Spec: 'New session' (starting coordinate per card)",
        rationale="Agents start near each other so same-point communication is possible.",
    ),
    "A-WORLD-5": Assumption(
        key="terrain occlusion",
        default="none: vision and communication use pure Manhattan distance",
        citation="Design: 'Spawned terrain and passage' deferred note ('Whether terrain affects longer-range vision or communication remains undecided')",
        rationale="Simplest rule; configurable later.",
    ),
    "A-WORLD-6": Assumption(
        key="card positions on generated terrain",
        default="a card position on a mountain is moved to the nearest land cell (deterministic scan) and reported as a run_created warning; POST /api/world/preview shows the terrain beforehand",
        citation="Spec: 'New session' (validate setup, explain invalid values)",
        rationale="Setup never fails on terrain the operator could not see.",
    ),
    "A-SCHED-1": Assumption(
        key="initiative tie-break",
        default="single run RNG (world.rng_state): living ids sorted ascending, rng.shuffle, stable sort by -speed, once at round start",
        citation="Design: 'Turns speed and skill execution' ('seeded, reproducible tie-break')",
        rationale="Deterministic given the seed; no second RNG to desynchronise.",
    ),
    "A-SCHED-2": Assumption(
        key="agents that die mid-round",
        default="skipped when their turn comes; a dead agent gets a 'skipped_dead' turn record only if it was scheduled; its round-start decision (A-SCHED-5) is recorded there as an unused call (failed, never charged)",
        citation="Spec: 'Turn orchestration' step 2 ('Select the next living agent')",
        rationale="Order is fixed at round start; dead agents are skipped, not removed.",
    ),
    "A-SCHED-3": Assumption(
        key="run finishes",
        default="when no living agents remain, or max_rounds reached; run_turn/play in 'finished' apply staged edits and re-check the condition (stays finished if it still holds)",
        citation="Spec: 'Sessions and run controls' ('until paused or the run stops')",
        rationale="Status 'finished' with finished_reason; place_entity or update_run_settings can revive a run.",
    ),
    "A-SCHED-5": Assumption(
        key="decision timing within a round",
        default="simultaneous: at round start every living agent that is not waiting and has no running skill (or whose skill an unread arrival interrupts) gets its packet built from the world and its knowledge as they are then, and all these model calls run at once (process-wide pool of EMPYREAN_MODEL_CONCURRENCY); the turns then resolve one by one in initiative order (A-SCHED-1), each action checked against the world as it is at that turn",
        citation="Operator request 2026-09-27 (async batch rounds: speed resolves conflicts, a round of 20 agents costs about one call's latency); Design: 'Turns speed and skill execution' (one turn per round, speed orders the turns)",
        rationale="Conflicts (two agents after one fruit, mutual attacks) are resolved by speed: the faster action lands first and the slower one fails its legality check (empty_source, target_gone, out_of_range, dead). Running skills act at their turn without a call; a skill that ends there falls through to a decision made at that moment (A-SKILL-11).",
    ),
    "A-SCHED-6": Assumption(
        key="round decisions that are never used",
        default="cancelled and recorded as failed calls (charged 0, measured cost as uncharged_compute) in the agent's own turn of the round after its turn_started (or the round end / final checkpoint): an agent that died or was removed before its turn; every waiting decision when an operator edit is applied at a boundary after the decisions were made (the rest of the round decides again from the edited world, new call ids); closing a run mid-round cancels the waiting calls, which come back as interrupted when the run is opened",
        citation="Spec: 'avoid duplicate usage accounting'; INTERFACES section 7 (agent events of an agent turn are the acting agent's)",
        rationale="Every billed call reaches the ledger exactly once and no call id is reused; nobody is charged for a decision that could not be acted on.",
    ),
    "A-SCHED-4": Assumption(
        key="removed and placed agents vs the round order",
        default="an id in order[next_index:] that no longer exists gets a 'skipped_removed' turn record; agents placed mid-round join at the next round's initiative",
        citation="Spec: 'God mode' (place/remove entities)",
        rationale="The recorded order of a round never changes.",
    ),
    "A-ECON-1": Assumption(
        key="upkeep order at round end",
        default="plants grow -> fruit/seed spawn -> germination -> residue decay -> upkeep/starvation -> deaths -> cleanup",
        citation="Design: 'Turns speed and skill execution' ('advance deterministic plant processes, settle upkeep and starvation, resolve deaths')",
        rationale="Fixed order recorded in the round_end checkpoint events.",
    ),
    # -- knowledge and context -------------------------------------------------
    "A-KNOW-1": Assumption(
        key="importance rule",
        default="damage/death 1.0; resource change >= 10 compute or any essence change 0.7; failed action 0.5; message 0.6; operator voice 0.8; observation/query 0.3; other 0.2",
        citation="Spec: 'How selection works' step 3",
        rationale="Transparent, editable rule table in context.py.",
    ),
    "A-KNOW-2": Assumption(
        key="relevance and recency rules",
        default="relevance = shared tags (entity ids, 'x,y' points, action names, plan words) between a record and the situation + notebook, divided by 5 and capped at 1; recency = 1 / (1 + age in rounds)",
        citation="Spec: 'How selection works' step 3",
        rationale="Deterministic keyword/tag overlap; no embeddings.",
    ),
    "A-KNOW-3": Assumption(
        key="message delivery visibility",
        default="recipient sees sender id only if the sender is within the recipient's vision range; otherwise 'unknown'",
        citation="Design: 'Coordinates vision and communication' (asymmetric reception)",
        rationale="Provenance.sender_visible records the decision.",
    ),
    "A-KNOW-4": Assumption(
        key="context.* defaults",
        default={
            "input_token_cap": 6000,
            "generation_allowance": 1000,
            "recent_history_length": 5,
            "notebook_max_tokens": 400,
            "retrieved_memory_limit": 5,
            "new_event_digest_limit": 10,
            "weights": {"relevance": 1.0, "recency": 1.0, "importance": 1.0},
        },
        citation="Spec: 'Budget delivery and inspection' (suggested initial limits)",
        rationale="Editable run defaults, not targets to fill.",
    ),
    "A-KNOW-5": Assumption(
        key="unread records marked read",
        default="the runner marks the packet's digest_record_ids read only after the provider returned a response (ok/malformed/refusal/truncated); never after infrastructure failures or an unaffordable packet",
        citation="Spec: 'Budget delivery and inspection' ('Skipped material stays available for future retrieval')",
        rationale="A message is never lost to a timeout.",
    ),
    "A-KNOW-6": Assumption(
        key="self-knowledge in the packet",
        default="the situation's self state is derived from knowledge only: the run-start system record (card values), the latest own query(self), then disclosed deltas (own action costs and effects, damage/starvation health_after, transfer-received notices, the disclosed cognition charge of the previous decision); upkeep is not disclosed unless the agent starves; labelled 'as of round N'",
        citation="Spec: 'Agent context and memory selection' -> Knowledge boundary ('Do not silently supply a fresh query(self) every turn')",
        rationale="query(self) stays a meaningful paid action; the runner bills from authoritative balances.",
    ),
    "A-KNOW-7": Assumption(
        key="Decision.memory_priorities",
        default="up to 5 {record_id, priority 0..1} per decision, at most 20 kept per agent (newest wins); adds min(0.3, 0.3 x priority) to a record's importance in ranking",
        citation="Spec: 'How selection works' step 3 ('bounded agent-supplied priorities')",
        rationale="Attention hints rank memories; they never choose actions.",
    ),
    "A-KNOW-8": Assumption(
        key="packet mandatory part and fill order",
        default="mandatory = stable rules (catalogue without source) + core situation (believed self, latest result, digest header with counts by kind and one <= 40-token line per urgent record) + decision request + model overhead; then fill: full unread bodies (urgent kinds first), notebook, recent history, retrieved memories, skill source",
        citation="Spec: 'How selection works' step 1 (compact digest; overflow counts)",
        rationale="A flood of messages can never make every packet unaffordable.",
    ),
    "A-KNOW-9": Assumption(
        key="context.persona_tip, context.persona_tip_text",
        default={"persona_tip": True, "persona_tip_text": "config.PERSONA_TIP_TEXT"},
        citation="Live sweep finding 2026-09-27: with the plain persona, Haiku agents in a crowded world sent 0 messages, wrote 0 skills and made 0 attacks; the same world with the tip gave messages, skills, trades and kills",
        rationale="On for new runs so scenarios are not silent; a stored setting without the field reads as off (runs made before the setting existed had no tip), so reopening an old run never changes its prompts.",
    ),
    # -- god mode -----------------------------------------------------------------
    "A-GOD-1": Assumption(
        key="staged edits application order; working/ reload applied as a diff (storage.apply_working_changes)",
        default="staged edits are applied at the boundary in staging order, each as a delta onto the state at that moment; a working/ reload is staged as the field diff of the files against the committed turn and applied AS THAT DIFF (never a wholesale replacement), so UI edits staged before or after it all survive; a field changed by both keeps the value of the edit staged later; a file change whose parent no longer exists or a result failing validation (schema, cross-file references, validate_world, effective context settings) rejects the whole file edit (ok=false with the paths and reasons; the other edits still apply); the record's before values are the values found at apply time",
        citation="Spec: 'God mode and direct file editing' (both paths record before/after values, origin and effective boundary; invalid files leave the last valid state available); fix-pass finding (a reload staged after UI edits silently undid them)",
        rationale="An operator's UI edits and file edits for the same turn must both take effect; the later-staged value wins a conflict.",
    ),
    # -- assistant (rev 4) ----------------------------------------------------------
    "A-AST-1": Assumption(
        key="storybook automatic narration default (STORYBOOK_AUTO, <run>/assistant/settings.json)",
        default="off: a new run's storybook_auto is OFF (the storybook is written on request); with STORYBOOK_AUTO 'auto' it is ON unless the narrator model is a paid (non-fake) key AND every agent model in the run is fake, with 'on' always ON; runs without assistant/settings.json (existing runs) are OFF; auto covers only turns committed after auto_since_turn_id (set when the flag is switched on) plus the opening entry written at creation; catch-up of history is never automatic (only the explicit 'Write missing' button / POST storybook/generate); auto pauses with a visible notice at the run's storybook budget",
        citation="User requirement 5 (automatic per-turn storybook); measured Haiku CLI cost $0.0081 and 7.3 s per call, fake runs commit ~5 turns/s, 285-turn runs on disk",
        rationale="Operator decision 2026-09-27: story making is an after-the-fact step, so narration spends nothing unless asked (live narration also grew backend memory in long runs). Per-turn live narration stays one switch away.",
    ),
    "A-AST-2": Assumption(
        key="assistant budgets (ASSISTANT_*_BUDGET_USD) and ledger",
        default="separate limits: chat per scope (run or global) 5.0, storybook per run 2.0, story per job 5.0 (the story brief may set its own), per user message 0.75, global across all scopes 20.0; before every call the engine checks spent + ASSISTANT_CALL_COST_ESTIMATE_USD (0.05) against the applicable limits; each call settles the CLI-reported provider_cost_usd or, when None, a list-price estimate from tokens (ASSISTANT_PRICES by response_model prefix; cost_estimated=true); usage.jsonl per scope is the only source and is aggregated on read; nothing is ever written to Manifest.real_usage; limits are per-run/per-scope settings the user raises directly",
        citation="Design 'Compute metering' (the agents' economy is separate); judges' finding that one shared budget lets background narration lock the user out of chat",
        rationale="Background narration, chat and story generation must not starve one another, and assistant spend must never distort the agents' ledger or run budget.",
    ),
    "A-AST-3": Assumption(
        key="storybook batching (STORYBOOK_BATCH_MAX, STORYBOOK_BATCH_THRESHOLD)",
        default="one coalescing job per run narrates missing eligible turns in order; when the backlog is > 2 turns a narrator call covers up to 12 turns (one round) and returns one '## <turn_id>' section per turn, parsed deterministically, with missing sections re-queued singly; a backlog <= 2 is narrated singly so live play gets prompt per-turn entries; background profiles share a global semaphore of 1 while any open claude_cli run is not idle and pause 60 s after a 429/overload; a non-blocking flock on <run>/assistant/.storybook.lock guards against a second process",
        citation="Measured: the fixed prompt prefix is ~3k tokens per narrator call, so batching per round saves ~65%; fake runs commit ~30x faster than one narrator writes",
        rationale="Keeps one entry per turn (the user's unit) without an hour-long tail behind a fast run.",
    ),
    "A-AST-4": Assumption(
        key="assistant structured output: lean schemas, untyped brief action args, one repair step",
        default="constrained JSON is used only where code consumes the output (chat step answer|tool|ask|brief, interview ask/brief, story brief); every compact schema is < 16 KB and brief.action is {type: enum, args: object} with args untyped in the JSON schema, validated server-side with TypeAdapter(BriefAction); before any re-call the engine applies deterministic salvage (unwrap single-key string wrappers such as {'output': '<json>'}, json-decode stringified fields, collapse doubled nesting) and then at most one repair step with the validation errors; assistant refs run with max_turns 2 and max_model_requests 3 so the CLI's own validator verdict reaches the model against a warm cache",
        citation="Measured: 144 of 1,066 live Haiku schema calls in worlds/ were malformed (13.5%), terminal and paid with max_turns=1; the typed Intervention schema is 35,634 chars with 215 $refs",
        rationale="A typed action union would add ~12k tokens per step; server-side validation gives the same safety at a fraction of the cost.",
    ),
    "A-AST-5": Assumption(
        key="ModelRequest.response_format='text' profiles",
        default="narrator entries, story chapters and both summaries (conversation memory, story-so-far) are requested in text mode (no JSON instruction, neutral CLI fallback prompt, any non-empty reply is ok); the engine supplies metadata deterministically (turn ids, chapter numbers, the title from the first '# ' line); chat steps, interview ask/brief and the story brief stay constrained JSON",
        citation="Design decision D2 as amended (hybrid); model.py single boundary (U4/U15)",
        rationale="Prose profiles gain nothing from a schema and inherit its failure mode; text mode keeps every provider difference inside model.py.",
    ),
    "A-AST-6": Assumption(
        key="speech input (WHISPER_* defaults; 'Dictate')",
        default="local faster-whisper large-v3-turbo, int8 on CPU with min(8, nproc) threads, behind model.transcribe on a dedicated 1-worker speech executor with a bounded queue; preloaded by main only (never in tests); 60 s recording cap in the UI (WHISPER_MAX_SECONDS 65 server side), raw-body POST capped at 10 MB (413 payload_too_large); language defaults to en; initial_prompt built from the run's agent names, glossary terms and control labels; the feature is called 'Dictate' everywhere because god mode owns 'voice'",
        citation="User requirement 9 (accurate local Whisper, not tiny); measured 7.2 s (large-v3-turbo) vs 5.5-6 s (medium) for an 11 s clip, 15.8 s cold load",
        rationale="Accuracy on game vocabulary matters more than one second of latency; preload removes the cold-start risk.",
    ),
    "A-AST-7": Assumption(
        key="chat step loop (ASSISTANT_MAX_STEPS, ASSISTANT_MESSAGE_TIMEOUT_SECONDS, ASSISTANT_TOOLS_PER_STEP)",
        default="at most 4 model calls per user message; step 1 is pre-injected with deterministic context (run status, viewed turn digest, selected entity dossier, last round digest, highlights) so most questions need one call; a tool step may request up to 3 read tools; the last step is sent the restricted answer|ask schema so a chain always ends in an answer; wall clock 90 s and ASSISTANT_MESSAGE_BUDGET_USD per message; answers are stamped 'as of turn <id>'; the system prompt is byte-stable across steps (< 96 KiB) so the CLI serves it from cache",
        citation="Live records: mean cache_read 4,412 / cache_creation 2,399 tokens per Haiku call; every CLI step is a blocking subprocess of 7-20 s",
        rationale="Bounded latency and spend per question; the cache makes the stable prefix nearly free after step 1.",
    ),
    "A-AST-8": Assumption(
        key="assistant-only model refs (ref.options.assistant_only)",
        default="claude-cli-sonnet-assistant (sonnet, max_budget_usd 0.25), claude-cli-haiku-assistant (haiku, 0.08) and the default fake ref fake-assistant carry options.assistant_only=true; GET /api/models hides them unless ?include_assistant=1; ModelRegistry.validate_agent_key rejects them ('reserved for the assistant') in validate_setup, card model keys, place_entity and update_model_assignment; assistant profile keys validate with validate_key",
        citation="runner.validate_setup / validate_intervention check validate_key only; the assistant refs carry larger per-call CLI caps and turn limits",
        rationale="A frontend-only filter would leave the assistant's larger caps assignable to agents through the API, god mode and the assistant's own briefs.",
    ),
    "A-AST-9": Assumption(
        key="execution briefs: validation, approval lifecycle, provenance",
        default="the model's brief is data, never authority: a typed action (create_run | run_command {rounds 1-50 only with step_round} | stage_interventions | create_continuation | open_run | update_assistant_settings) is validated deterministically before it is shown (validation never opens a run: the open worker's committed checkpoint or storage.load_checkpoint read-only); approve = POST {validated_against_turn_id} under the conversation lock with CAS pending->executing, revalidation, server-side execution and a stored idempotent effect; interventions staged by a brief get origin 'assistant' and note 'assistant: <summary>'; apply_working_files can never be proposed; a play/step is never chained into a create_run approval",
        citation="User requirement 2 (request -> brief -> Approve/Change/Reject -> execute); spec 'God mode' (record origin)",
        rationale="Nothing mutates before approval; a double click or second tab cannot execute twice; history shows what the assistant did.",
    ),
    "A-AST-10": Assumption(
        key="conversation scope and storage (<worlds_dir>/_assistant/conversations/<conv_id>/)",
        default="every conversation lives under the worlds dir's _assistant folder with meta.json (mutable run_id, null = global) and messages.jsonl; the drawer lists conversations by the page's scope; after an approved create_run or open_run the same conversation is rebound to the new run; a ConversationStore with a per-conversation lock owns every mutation; on service start and lazily on load, messages or jobs left pending/executing are rewritten to interrupted; the sim state is the memory: no cross-conversation memory, the assistant re-reads the world through read tools",
        citation="User requirement 4 (conversations/memory/sessions tightly bound to the sim); recovery never touches <run>/assistant/",
        rationale="One location with a mutable scope avoids moving files across runs and keeps the flagship flow ('set up a fight arena' on Home, approve, follow into the run) in one thread.",
    ),
}


def assumption_entries() -> list[AssumptionEntry]:
    """The registry as API/JSON entries (written once per run to assumptions.json)."""
    return [
        AssumptionEntry(id=aid, key=a.key, default=a.default, citation=a.citation, rationale=a.rationale)
        for aid, a in ASSUMPTIONS.items()
    ]


# ---------------------------------------------------------------------------
# Default run request (GET /api/defaults)
# ---------------------------------------------------------------------------


def default_rules() -> RulesConfig:
    """Equal to ``RulesConfig()`` (schema defaults) by construction; a test asserts it."""
    return RulesConfig(
        prices=DEFAULT_PRICES.model_copy(),
        upgrades=DEFAULT_UPGRADES.model_copy(deep=True),
        skills=DEFAULT_SKILL_RULES.model_copy(deep=True),
        accounting=DEFAULT_ACCOUNTING.model_copy(),
        upkeep=DEFAULT_UPKEEP.model_copy(),
        recovery=DEFAULT_RECOVERY.model_copy(),
        cognition=DEFAULT_COGNITION.model_copy(deep=True),
        messages=DEFAULT_MESSAGES.model_copy(),
        death=DEFAULT_DEATH.model_copy(),
        ranges=DEFAULT_RANGES.model_copy(),
        plant_species={k: v.model_copy(deep=True) for k, v in DEFAULT_PLANT_SPECIES.items()},
    )


def default_agent_card(index: int, model_key: str | None = None) -> AgentCard:
    """Prefilled card ``index`` (0-based, < MAX_AGENTS): id aNN, name, position from the tables."""
    if not 0 <= index < MAX_AGENTS:
        raise ValueError(f"card index must be 0..{MAX_AGENTS - 1}")
    return AgentCard(
        id=f"a{index + 1:02d}",
        name=DEFAULT_AGENT_NAMES[index],
        model_key=model_key,
        position=DEFAULT_AGENT_POSITIONS[index].model_copy(),
        stats=DEFAULT_AGENT_STATS.model_copy(),
        persona="",
        notebook="",
        initial_skills=[],
        context_overrides=None,
    )


def default_agent_cards(count: int = 8, model_key: str | None = None) -> list[AgentCard]:
    if not MIN_AGENTS <= count <= MAX_AGENTS:
        raise ValueError(f"agent count must be {MIN_AGENTS}..{MAX_AGENTS}")
    return [default_agent_card(i, model_key) for i in range(count)]


def operator_default_model_key(registry: Any = None) -> str:
    """``OPERATOR_DEFAULT_MODEL_KEY`` when the registry knows it and it is available (credentials
    or the CLI present), else ``DEFAULT_MODEL_KEY``.  ``registry`` is a model.ModelRegistry; None
    means "trust the configured key"."""
    key = OPERATOR_DEFAULT_MODEL_KEY or DEFAULT_MODEL_KEY
    if registry is None:
        return key
    try:
        if registry.validate_key(key) is None and not registry.is_assistant_only(key):
            return key
    except Exception:  # noqa: BLE001 - a broken registry never breaks the defaults
        pass
    return DEFAULT_MODEL_KEY


def default_run_request(default_model_key: str = DEFAULT_MODEL_KEY, agent_count: int = 8) -> RunCreateRequest:
    return RunCreateRequest(
        name="New run",
        world_id=None,
        seed=1,
        world=DEFAULT_WORLD.model_copy(deep=True),
        rules=default_rules(),
        context=DEFAULT_CONTEXT.model_copy(deep=True),
        default_model_key=default_model_key,
        max_rounds=None,
        play_delay_seconds=DEFAULT_PLAY_DELAY_SECONDS,
        real_budget_usd=None,
        agents=default_agent_cards(agent_count),
    )
