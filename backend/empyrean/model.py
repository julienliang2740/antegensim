"""
model.py — THE ONLY model boundary.  OWNER: models/context/skills team.

Every model call in the application goes through ``call_model``.  No other
module imports a provider SDK, reads a credential, or branches on a provider
(spec "Model calls and validation" / "A single model boundary", user
requirements U4 and U15).

Owns
----
* The model registry: ``ModelRef`` entries loaded from the JSON file named by
  ``EMPYREAN_MODELS_FILE`` (default ``backend/empyrean/models.example.json``),
  with availability computed from the presence of the env vars named in
  ``credential_env`` (values are never stored, logged or returned).
* Adapters: fake (deterministic), anthropic, openai, fireworks
  (OpenAI-compatible endpoint), bedrock (boto3 converse), foundry (Azure
  OpenAI endpoint via the openai SDK), claude_cli (hardened subprocess).
* Translating a ``ModelRequest`` into each provider's format, including the
  per-adapter transform of ``request.response_schema`` and the token overhead
  it adds (``request_overhead_tokens``, A-COG-8).  Unsupported configurations
  return ``status="invalid_config"`` — never silent substitution.
* Usage normalisation without double counting (table on ``schemas.ModelUsage``);
  ``source="estimate"`` from ``config.estimate_tokens`` when a provider reports
  nothing; usage summed across retried attempts.
* Timeouts (per attempt), bounded retries with backoff on retryable failures
  only, latency, error classification and REDACTION of every stored error.
* The decision format gate ``parse_decision`` (spec "Two distinct validation
  gates": format validation).

rev 4 (assistant) additions
---------------------------
* Text response mode: ``ModelRequest.response_format="text"`` sends no JSON-only
  instruction, no schema / forced tool / ``json_object`` mode (all four real adapters), uses
  ``CLI_TEXT_SYSTEM_PROMPT`` as the CLI fallback system prompt, and classifies the reply with
  ``_text_status`` (non-empty text -> ok, ``parsed`` None; empty -> malformed; refusal /
  truncated as usual).  ``request_overhead_tokens(..., response_format="text")`` counts only
  the route's fixed overhead.
* ``fake-assistant``: schema-agnostic replies from ``metadata["fake_script"][
  metadata["fake_script_index"]]``, else ``metadata["fake_reply"]``, else invalid_config.
* ``ModelResult.error_code``: budget_exceeded (CLI subtype error_max_budget_usd),
  rate_limited (HTTP 429/529), schema_mismatch (JSON-mode malformed, incl. the CLI
  validator's error_max_turns), cancelled, timeout, not_logged_in (CLI login text or 401),
  cli_missing (no ``claude`` on PATH).
* ``call_model(..., cancel=threading.Event)``: the CLI adapter polls the event every
  CLI_CANCEL_POLL_SECONDS and kills its process group; ``kill_inflight()`` kills every live CLI
  process group (API lifespan and atexit).
* ``provider_cost_usd`` is summed over the attempts that reported a cost.
* The CLI adapter refuses any argv string over ``config.CLI_ARGV_MAX_BYTES`` (invalid_config).
* Structured-output names follow ``request.purpose`` (``structured_output_names``): the forced
  tool is ``submit_decision`` / schema ``decision`` only for purpose "decision".
* Local speech recognition: ``transcribe`` / ``whisper_status`` / ``preload_whisper`` run
  faster-whisper (imported lazily, only here) on CPU int8.

Must not
--------
* Apply gameplay rules, charge compute, or touch world/knowledge state.
* Forward ``request.metadata`` to any provider (metadata is for the fake
  adapter only).
* Print or log request contents or secrets.  Logging is limited to provider,
  model id, status, latency and usage numbers.
* Raise for provider failures or configuration problems: ``call_model`` always
  returns a ``ModelResult`` (unknown key -> ``invalid_config``).

Hygiene rules every real adapter follows
----------------------------------------
* SDK clients are created with ``max_retries=0`` (boto3: ``Config(retries=
  {"total_max_attempts": 1})`` plus connect/read timeouts) so ``attempts`` is exact
  and our retry policy governs.
* ``request.temperature`` overrides ``ref.options["temperature"]``;
  ``ref.options["param_style"] == "reasoning"`` sends no temperature.
* OpenAI family: ``ref.options["reasoning_effort"]`` is sent as ``reasoning_effort``
  (for example "none" keeps a reasoning model non-thinking); ``ref.options["usd_per_mtok"]``
  (``[input, cached_input, output]``) turns reported usage into ``provider_cost_usd``
  (``list_price_cost``) for routes whose provider reports no cost.
* Forced tool use / structured output: ``ModelResult.text = json.dumps(tool
  input)``; thinking/reasoning blocks are never joined into ``text``.
* ``response_model`` is filled from the provider response (``response.model``,
  CLI ``modelUsage`` keys, Bedrock: the configured id).
* ``redact`` strips the VALUES of every registry ``credential_env`` variable and
  bearer/key-like tokens from every error string and stderr excerpt, then caps
  the text at ``config.ERROR_TEXT_MAX_CHARS``.

Test hooks (no network needed)
------------------------------
* ``CLIENT_FACTORIES[provider]`` builds the SDK client for anthropic / openai /
  fireworks / foundry (``(ref, api_key, timeout_seconds) -> client``) and
  bedrock (``(ref, region, timeout_seconds) -> client``).  Tests replace an
  entry with a fake client that returns golden provider payloads.
* ``ClaudeCliAdapter`` starts the CLI through ``subprocess.Popen`` (so the whole
  process group can be killed on timeout); tests monkeypatch ``subprocess.Popen``.
* ``_sleep`` is the retry backoff sleep; ``_import_sdk`` / ``_sdk_installed``
  import / probe SDK packages.
"""

from __future__ import annotations

import atexit
import copy
import importlib
import importlib.util
import io
import json
import logging
import math
import os
import random
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Optional, Protocol, get_args

from pydantic import ValidationError

from . import config
from .config import MODELS_FILE, estimate_tokens  # noqa: F401  (single token heuristic, re-exported)
from .schemas import (
    AGENT_OUTPUT_STATUSES,
    Decision,
    ModelCapabilities,
    ModelErrorCode,
    ModelInfo,
    ModelRef,
    ModelRequest,
    ModelResult,
    ModelUsage,
    Situation,
    TranscriptionResult,
    WhisperStatus,
    decision_json_schema,
)

logger = logging.getLogger("empyrean.model")


# ---------------------------------------------------------------------------
# Provisional numbers live in config.py (MODEL_FIXED_OVERHEAD_TOKENS, CLI_MAX_TURNS,
# CLI_KILL_GRACE_SECONDS, MAX_JSON_SCAN_STARTS) and are re-exported here under the names
# the adapters and tests use.  Each can be overridden per registry entry through
# ``ref.options`` where noted.  FakePolicy stays here: it is the fake model's own
# personality, not a game rule.
# ---------------------------------------------------------------------------

FAKE_MODEL_IDS: tuple[str, ...] = ("fake-heuristic", "fake-scripted", "fake-malformed", "fake-assistant")
# Fake refs whose options carry assistant_only (hidden from agent pickers, rejected for agents).
FAKE_ASSISTANT_ONLY_IDS: tuple[str, ...] = ("fake-assistant",)
# Fake refs that exist for the test suite (scripted replies, scheduled malformed replies); hidden
# from the operator's model pickers (GET /api/models needs include_test=1) but usable by key.
FAKE_TEST_ONLY_IDS: tuple[str, ...] = ("fake-scripted", "fake-malformed")

# Name of the forced tool that carries the decision schema (Anthropic API).
DECISION_TOOL_NAME = "submit_decision"
DECISION_TOOL_DESCRIPTION = "Submit your decision for this turn as one JSON object."

# Name of the json_schema response format (OpenAI family).
DECISION_SCHEMA_NAME = "decision"

# rev 4: every purpose other than "decision" gets neutral structured-output names, so an
# assistant brief or a summary is never framed as "your decision for this turn".
RESPONSE_TOOL_NAME = "submit_response"
RESPONSE_TOOL_DESCRIPTION = "Submit your reply as one JSON object that matches the input schema."
# purpose -> OpenAI json_schema name (letters, digits, underscores; <= 64 chars).
STRUCTURED_SCHEMA_NAMES: dict[str, str] = {
    "decision": DECISION_SCHEMA_NAME,
    "summarize": "summary",
    "assistant": "assistant_reply",
    "narrative": "narrative",
    "test": "response",
}


def structured_output_names(purpose: str) -> tuple[str, str, str]:
    """(forced tool name, tool description, OpenAI json_schema name) for ``request.purpose``.
    Decision-flavoured names only for purpose ``"decision"``; every other purpose gets
    ``submit_response`` and a purpose-named schema (``assistant_reply``, ``narrative`` ...)."""
    if purpose == "decision":
        return DECISION_TOOL_NAME, DECISION_TOOL_DESCRIPTION, DECISION_SCHEMA_NAME
    return RESPONSE_TOOL_NAME, RESPONSE_TOOL_DESCRIPTION, STRUCTURED_SCHEMA_NAMES.get(purpose, "response")


def _schema_label(purpose: str) -> str:
    """How error messages name the schema a structured reply had to match."""
    return "decision schema" if purpose == "decision" else "response schema"

DEFAULT_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1"

# Provider-side input tokens an adapter adds beyond the messages and the schema text
# (tool-use system prompt, CLI harness text).  Override with ref.options["overhead_tokens"].
FIXED_OVERHEAD_TOKENS: dict[str, int] = dict(config.MODEL_FIXED_OVERHEAD_TOKENS)

# Appended to the system prompt when no native schema is sent (validated fallback:
# the reply is then decoded by extract_json_object and checked by parse_decision).
JSON_ONLY_INSTRUCTION = "Reply with exactly one JSON object and nothing else: no prose and no code fences."

# extract_json_object tries at most this many '{' start positions (bounds the work).
MAX_JSON_SCAN_STARTS = config.MAX_JSON_SCAN_STARTS

# HTTP statuses that mean "the request/configuration is wrong": never retried.
CONFIG_HTTP_STATUSES: frozenset[int] = frozenset({400, 401, 403, 404, 413, 422})
# Host limit on how deeply a decoded reply may nest (like the skill parser's 32-level
# limit): deeper values are ``malformed`` before they leave the boundary, because they
# cannot be stored (json.dumps refuses ~300 levels) and can never be a valid decision.
MAX_REPLY_NESTING = 32
# Retryable HTTP statuses besides 5xx.
RETRYABLE_HTTP_STATUSES: frozenset[int] = frozenset({408, 429, 529})

# claude_cli --max-turns.  Measured with CLI 2.1.x: with --json-schema the CLI validates the
# model's StructuredOutput call and, when it does not match, asks the model again (another
# billed request).  "--max-turns 1" allows exactly one model request: a valid reply
# completes (num_turns == 2, the tool call counts as a turn) and an invalid one ends as
# subtype "error_max_turns", which this adapter reports as the agent-output status
# "malformed".  Override per entry with ref.options["max_turns"].
CLI_MAX_TURNS = config.CLI_MAX_TURNS
# claude_cli: seconds to wait for a killed process group to be reaped.
CLI_KILL_GRACE_SECONDS = config.CLI_KILL_GRACE_SECONDS
# claude_cli: model requests the CLI may spend on ONE decision before the reply is rejected as
# an infrastructure error.  With --json-schema the CLI cannot force the tool choice: when the
# model's first response ends as plain text it re-prompts once for the StructuredOutput call
# (a second billed request; measured live in 1 of 22 decisions).  The envelope's usage and
# total_cost_usd then cover both requests, so the decision is charged in full; the note is
# kept in ModelResult.attempt_errors.  Override per entry with ref.options["max_model_requests"].
CLI_MAX_MODEL_REQUESTS = config.CLI_MAX_MODEL_REQUESTS
# claude_cli: MAX_THINKING_TOKENS for the subprocess (0 disables extended thinking, None
# leaves the CLI default).  Override per entry with ref.options["max_thinking_tokens"]
# (an explicit null keeps the CLI default).
CLI_MAX_THINKING_TOKENS = config.CLI_MAX_THINKING_TOKENS
CLI_MAX_THINKING_TOKENS_ENV = "MAX_THINKING_TOKENS"
# claude_cli, schema route: NOTHING is appended to the system prompt.  A line asking the model
# to "call the StructuredOutput tool with the JSON object as its input" made Haiku wrap the
# decision as a string under an "input" key in 24 of 24 live decisions (schema rejected, turn
# lost); the CLI's own tool description is sufficient (21 of 22 decisions valid without it).
# claude_cli: system prompt used when the request has no system message (never let the
# CLI fall back to its own default system prompt).
CLI_DEFAULT_SYSTEM_PROMPT = "You are a participant in a simulation. Reply with one JSON object."
# rev 4, text response mode: the neutral fallback (no JSON wording) when a text request has no
# system message.
CLI_TEXT_SYSTEM_PROMPT = "You are a helpful assistant. Reply in plain text."
# claude_cli: seconds between cancel checks while the subprocess runs (``call_model(cancel=...)``).
CLI_CANCEL_POLL_SECONDS = 0.5
# claude_cli: stdout/stderr/result text that means the CLI has no usable login (error_code
# "not_logged_in"; the UI tells the operator to run ``claude`` once in a terminal).
CLI_NOT_LOGGED_IN = re.compile(
    r"not logged in|please run /login|invalid api key|oauth token (?:has )?expired|authentication_error",
    re.IGNORECASE,
)
# claude_cli: result text of a reply that ran past the CLI's output token limit ("Claude's response
# exceeded the 250 output token maximum"): classified as a truncated agent reply, not an error.
CLI_OUTPUT_CAP = re.compile(r"exceeded the \d+ output token maximum", re.IGNORECASE)
# HTTP statuses reported as error_code "rate_limited" (429 rate limit, 529 overloaded).
RATE_LIMIT_HTTP_STATUSES: frozenset[int] = frozenset({429, 529})

# Env vars that commonly hold secrets; always excluded from the CLI env and redacted.
DEFAULT_SECRET_ENV_NAMES: frozenset[str] = frozenset(
    {
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "OPENAI_API_KEY",
        "FIREWORKS_API_KEY",
        "AZURE_OPENAI_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
    }
)

# Python package each provider needs (availability and invalid_config reporting).
PROVIDER_SDK_MODULE: dict[str, str] = {
    "anthropic": "anthropic",
    "openai": "openai",
    "fireworks": "openai",
    "foundry": "openai",
    "bedrock": "boto3",
}

# Registry fields whose ``${VAR}`` placeholders are resolved from the environment.
PLACEHOLDER_FIELDS: tuple[str, ...] = ("endpoint", "deployment", "api_version", "region")
_PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")

# Every credential env name any registry built in this process references (so ``redact``
# without a registry argument still strips them, e.g. the runner's traceback excerpts).
_KNOWN_CREDENTIAL_NAMES: set[str] = set()


class UnknownModelError(KeyError):
    """Registry has no such key.  api.py maps it to 422 ``unknown_model``."""


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _env_value(name: str) -> Optional[str]:
    """The env var's value, or None when unset OR empty (placeholder lines in .env)."""
    value = os.environ.get(name)
    return value if value else None


def _field(obj: Any, name: str) -> Any:
    """Read ``name`` from an SDK object or a plain dict (goldens use either)."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _count(value: Any) -> int:
    """A token count: non-negative int; None/garbage -> 0."""
    if isinstance(value, bool):
        return 0
    try:
        number = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, number)


def _import_sdk(module_name: str) -> Any:
    """Import a provider SDK lazily (adapters stay importable without it).  Test hook."""
    return importlib.import_module(module_name)


def _sdk_installed(module_name: str) -> bool:
    """True when the package can be imported (no import side effects).  Test hook."""
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, ValueError):
        return False


def _sleep(seconds: float) -> None:
    """Retry backoff sleep.  Test hook (monkeypatched to record delays)."""
    time.sleep(seconds)


def _compact_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def _default_fake_refs() -> list[ModelRef]:
    """The four fake routes; present in every registry even if the file omits them."""
    descriptions = {
        "fake-heuristic": "Deterministic seeded survival policy; no network.",
        "fake-scripted": "Replays per-agent decision scripts from request.metadata['fake_script'].",
        "fake-malformed": "Returns invalid JSON / illegal actions on a schedule to test validation gates.",
        "fake-assistant": (
            "Assistant test double (assistant_only): returns metadata['fake_script'][metadata['fake_script_index']] "
            "when present, else metadata['fake_reply'], else invalid_config; a string reply is ok in text mode."
        ),
    }
    return [
        ModelRef(
            key=mode,
            provider="fake",
            model_id=mode,
            credential_env=[],
            capabilities=ModelCapabilities(
                supports_json_schema=True,
                supports_json_mode=True,
                context_window=100000,
                max_output_tokens=8000,
                reports_usage=False,
            ),
            mind_multiplier=1.0,
            options=({"assistant_only": True} if mode in FAKE_ASSISTANT_ONLY_IDS else {"test_only": True} if mode in FAKE_TEST_ONLY_IDS else {}),
            description=descriptions[mode],
        )
        for mode in FAKE_MODEL_IDS
    ]


def _resolve_placeholders(ref: ModelRef) -> tuple[ModelRef, list[str]]:
    """Replace ``${VAR}`` in endpoint/deployment/api_version/region with env values.
    Returns the resolved copy and the names that could not be resolved (left literal)."""
    missing: list[str] = []
    updates: dict[str, str] = {}

    def substitute(match: re.Match[str]) -> str:
        value = _env_value(match.group(1))
        if value is None:
            if match.group(1) not in missing:
                missing.append(match.group(1))
            return match.group(0)
        return value

    for field_name in PLACEHOLDER_FIELDS:
        raw = getattr(ref, field_name)
        if raw:
            updates[field_name] = _PLACEHOLDER.sub(substitute, raw)
    return ref.model_copy(update=updates, deep=True), missing


class ModelRegistry:
    """Configured model routes.  Built once at startup by ``load_registry``.

    ``get`` returns each entry exactly as configured (``${VAR}`` placeholders intact,
    env var NAMES only) so it is safe to snapshot into stored records; adapters use
    ``resolved(key)``, whose placeholders were resolved from the environment when the
    registry was built."""

    def __init__(self, refs: list[ModelRef]) -> None:
        ordered: dict[str, ModelRef] = {}
        for ref in refs:
            if ref.key in ordered:
                raise ValueError(f"duplicate model key {ref.key!r}")
            ordered[ref.key] = ref
        # Every default fake ref comes first, in FAKE_MODEL_IDS order (the file's own entry wins
        # when it lists one), then the file's remaining entries in file order.
        fakes = {f.key: ordered.get(f.key, f) for f in _default_fake_refs()}
        self._refs: dict[str, ModelRef] = {**fakes, **{k: v for k, v in ordered.items() if k not in fakes}}
        self._resolved: dict[str, ModelRef] = {}
        self._unresolved: dict[str, list[str]] = {}
        for key, ref in self._refs.items():
            self._resolved[key], self._unresolved[key] = _resolve_placeholders(ref)
        _KNOWN_CREDENTIAL_NAMES.update(self.credential_env_names())

    def get(self, key: str) -> ModelRef:
        """The configured entry.  Raise ``UnknownModelError`` for an unknown key."""
        try:
            return self._refs[key]
        except KeyError:
            raise UnknownModelError(f"unknown model key {key!r}") from None

    def resolved(self, key: str) -> ModelRef:
        """The adapter-facing copy with ``${VAR}`` placeholders resolved at load time."""
        self.get(key)
        return self._resolved[key]

    def keys(self) -> list[str]:
        return list(self._refs)

    def missing_requirements(self, key: str) -> list[str]:
        """Names of what the route needs but does not have: credential env vars (unset or
        empty), unresolved placeholder vars, the claude executable, the SDK package.
        Never values."""
        ref = self.get(key)
        if ref.provider == "fake":
            return []
        missing = [name for name in ref.credential_env if _env_value(name) is None]
        missing += [name for name in self._unresolved[key] if name not in missing]
        if ref.provider == "claude_cli" and shutil.which(config.CLAUDE_CLI_EXECUTABLE) is None:
            missing.append(f"{config.CLAUDE_CLI_EXECUTABLE} (executable on PATH)")
        sdk = PROVIDER_SDK_MODULE.get(ref.provider)
        if sdk is not None and not _sdk_installed(sdk):
            missing.append(f"{sdk} (python package)")
        return missing

    def info(self, key: str) -> ModelInfo:
        """Public view with ``available`` / ``missing_credentials`` computed from ``os.environ``
        (fake needs nothing; claude_cli is available when ``config.CLAUDE_CLI_EXECUTABLE`` is
        on PATH; bedrock with an empty ``credential_env`` relies on the boto3 default chain
        and is reported available)."""
        ref = self.get(key)
        missing = self.missing_requirements(key)
        return ModelInfo(
            key=ref.key,
            provider=ref.provider,
            model_id=ref.model_id,
            available=not missing,
            missing_credentials=missing,
            capabilities=ref.capabilities.model_copy(),
            mind_multiplier=ref.mind_multiplier,
            description=ref.description,
            assistant_only=bool(ref.options.get("assistant_only")),
            test_only=bool(ref.options.get("test_only")),
        )

    def list_info(self) -> list[ModelInfo]:
        return [self.info(key) for key in self._refs]

    def validate_key(self, key: str) -> Optional[str]:
        """None when ``key`` exists and is available; otherwise a readable error message."""
        if key not in self._refs:
            return f"unknown model key '{key}'"
        missing = self.missing_requirements(key)
        if missing:
            return f"model '{key}' is not available: missing {', '.join(missing)}"
        return None

    def is_assistant_only(self, key: str) -> bool:
        """True when the ref carries ``options.assistant_only`` (rev 4; unknown key -> False)."""
        ref = self._refs.get(key)
        return bool(ref is not None and ref.options.get("assistant_only"))

    def validate_agent_key(self, key: str) -> Optional[str]:
        """``validate_key`` plus the rev 4 rule that assistant-only refs cannot drive agents.
        Used by validate_setup, card model keys, place_entity and update_model_assignment."""
        error = self.validate_key(key)
        if error:
            return error
        if self.is_assistant_only(key):
            return f"model '{key}' is reserved for the assistant"
        return None

    def credential_env_names(self) -> set[str]:
        """Every env var name any ref references (for redaction and the CLI env allowlist)."""
        return {name for ref in self._refs.values() for name in ref.credential_env}


def load_registry(path: Optional[Path] = None) -> ModelRegistry:
    """Load ``{"models": [ModelRef, ...]}``.  ``path`` defaults to ``EMPYREAN_MODELS_FILE``
    (read now, so a test can point it elsewhere) else ``config.MODELS_FILE``.  The three
    fake refs are always present even if the file omits them.  ``${VAR}`` placeholders in
    endpoint/deployment/api_version/region are resolved from the environment (unresolved ->
    the ref is unavailable with ``missing_credentials`` naming the var).  Raises
    ``ValueError`` on an unreadable file, invalid JSON or an invalid entry."""
    if path is None:
        path = Path(_env_value("EMPYREAN_MODELS_FILE") or config.MODELS_FILE)
    path = Path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"cannot read model registry {path}: {exc.strerror or exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"model registry {path} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("models"), list):
        raise ValueError(f'model registry {path} must be an object {{"models": [...]}}')
    refs: list[ModelRef] = []
    for index, entry in enumerate(data["models"]):
        try:
            refs.append(ModelRef.model_validate(entry))
        except ValidationError as exc:
            first = exc.errors()[0]
            loc = ".".join(str(p) for p in first.get("loc", ()))
            raise ValueError(f"model registry {path}: models[{index}].{loc}: {first.get('msg')}") from exc
    return ModelRegistry(refs)


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------

_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"sk-[A-Za-z0-9][A-Za-z0-9_\-]{7,}"),  # OpenAI / Anthropic style keys
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),  # AWS access key ids
    re.compile(r"\bfw_[A-Za-z0-9]{8,}"),  # Fireworks keys
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-+/=]{8,}"),  # bearer tokens
)
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)((?:api[_-]?key|x-api-key|access[_-]?key|secret[_-]?key|secret|password|auth[_-]?token|access[_-]?token)"
    r"[\"']?\s*[:=]\s*[\"']?)[^\s\"',;}]{6,}"
)
# Env values shorter than this are not replaced (would shred ordinary text).
_MIN_SECRET_VALUE_CHARS = 6


def redact(text: Optional[str], registry: Optional[ModelRegistry] = None) -> Optional[str]:
    """Remove credential values (every ``credential_env`` variable's current value, plus
    ``sk-``/``AKIA``/``fw_``/bearer-like tokens and ``api_key=...`` assignments) from
    ``text`` and cap it at config.ERROR_TEXT_MAX_CHARS.  Applied to every
    ``ModelResult.error`` / ``attempt_errors`` entry and by the runner to traceback
    excerpts.  None stays None."""
    if text is None:
        return None
    text = str(text)
    names = set(DEFAULT_SECRET_ENV_NAMES) | _KNOWN_CREDENTIAL_NAMES
    if registry is not None:
        names |= registry.credential_env_names()
    # Longest values first so a value containing another is removed whole.
    values = sorted(
        {(os.environ.get(n) or "", n) for n in names if len(os.environ.get(n) or "") >= _MIN_SECRET_VALUE_CHARS},
        key=lambda pair: -len(pair[0]),
    )
    for value, name in values:
        text = text.replace(value, f"[REDACTED:{name}]")
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    text = _SECRET_ASSIGNMENT.sub(lambda m: m.group(1) + "[REDACTED]", text)
    limit = config.ERROR_TEXT_MAX_CHARS
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return text


# ---------------------------------------------------------------------------
# Usage normalisation (schemas.ModelUsage table; no double counting)
# ---------------------------------------------------------------------------


def estimate_usage(request: ModelRequest, output_text: Optional[str], *, extra_input_tokens: int = 0) -> ModelUsage:
    """Estimated usage (source="estimate") for adapters/providers that report none:
    ``config.estimate_tokens`` of each message (summed) plus ``extra_input_tokens`` (the
    adapter's schema/tool overhead when a native schema is sent), and of the output text."""
    input_tokens = sum(estimate_tokens(m.content) for m in request.messages) + max(0, extra_input_tokens)
    return ModelUsage(input_tokens=input_tokens, output_tokens=estimate_tokens(output_text or ""), source="estimate")


def usage_from_anthropic(usage: Any) -> Optional[ModelUsage]:
    """Anthropic Messages ``usage``: input_tokens is already the UNCACHED part;
    cache_read_input_tokens and cache_creation_input_tokens are separate; output_tokens
    includes any thinking (counted once)."""
    if usage is None:
        return None
    details = _field(usage, "output_tokens_details")
    return ModelUsage(
        input_tokens=_count(_field(usage, "input_tokens")),
        cache_read_tokens=_count(_field(usage, "cache_read_input_tokens")),
        cache_creation_tokens=_count(_field(usage, "cache_creation_input_tokens")),
        output_tokens=_count(_field(usage, "output_tokens")),
        reasoning_tokens=_count(_field(details, "thinking_tokens")),
        source="provider",
    )


def usage_from_claude_cli(usage: Any) -> Optional[ModelUsage]:
    """claude CLI ``--output-format json`` envelope ``usage``: same fields as the Anthropic API."""
    return usage_from_anthropic(usage)


def usage_from_openai(usage: Any) -> Optional[ModelUsage]:
    """OpenAI-compatible ``usage`` (openai / fireworks / foundry): prompt_tokens INCLUDES
    the cached tokens, so input = prompt_tokens - cached_tokens and cache_read =
    cached_tokens; output = completion_tokens, which already includes reasoning_tokens
    (reported for information only)."""
    if usage is None:
        return None
    prompt = _count(_field(usage, "prompt_tokens"))
    cached = min(prompt, _count(_field(_field(usage, "prompt_tokens_details"), "cached_tokens")))
    return ModelUsage(
        input_tokens=prompt - cached,
        cache_read_tokens=cached,
        cache_creation_tokens=0,
        output_tokens=_count(_field(usage, "completion_tokens")),
        reasoning_tokens=_count(_field(_field(usage, "completion_tokens_details"), "reasoning_tokens")),
        source="provider",
    )


def usage_from_bedrock(usage: Any) -> Optional[ModelUsage]:
    """Bedrock converse ``usage``: inputTokens (uncached), cacheReadInputTokens,
    cacheWriteInputTokens, outputTokens (totalTokens is their sum and is ignored)."""
    if usage is None:
        return None
    return ModelUsage(
        input_tokens=_count(_field(usage, "inputTokens")),
        cache_read_tokens=_count(_field(usage, "cacheReadInputTokens")),
        cache_creation_tokens=_count(_field(usage, "cacheWriteInputTokens")),
        output_tokens=_count(_field(usage, "outputTokens")),
        source="provider",
    )


def list_price_cost(ref: ModelRef, usage: Optional[ModelUsage]) -> Optional[float]:
    """USD cost of provider-reported ``usage`` at the entry's ``options["usd_per_mtok"]``
    list prices ``[input, cached_input, output]`` per million tokens (cache writes are
    priced as input).  None when the entry sets no prices or the provider reported no
    usage, so a token-billed route without prices keeps reporting no cost."""
    prices = ref.options.get("usd_per_mtok")
    if usage is None or not isinstance(prices, (list, tuple)) or len(prices) != 3:
        return None
    if not all(isinstance(p, (int, float)) and math.isfinite(p) and p >= 0 for p in prices):
        return None
    uncached = usage.input_tokens + usage.cache_creation_tokens
    return (uncached * prices[0] + usage.cache_read_tokens * prices[1] + usage.output_tokens * prices[2]) / 1_000_000


def sum_usage(usages: Iterable[ModelUsage]) -> ModelUsage:
    """Sum over the attempts that returned usage.  ``source`` is "provider" only when every
    contributing attempt was provider-reported; zeros (source "estimate") when none did."""
    contributing = [u for u in usages if u.billed_input_tokens or u.output_tokens]
    if not contributing:
        return ModelUsage()
    return ModelUsage(
        input_tokens=sum(u.input_tokens for u in contributing),
        cache_read_tokens=sum(u.cache_read_tokens for u in contributing),
        cache_creation_tokens=sum(u.cache_creation_tokens for u in contributing),
        output_tokens=sum(u.output_tokens for u in contributing),
        reasoning_tokens=sum(u.reasoning_tokens for u in contributing),
        billed_input_tokens=sum(u.billed_input_tokens for u in contributing),
        source="provider" if all(u.source == "provider" for u in contributing) else "estimate",
    )


# ---------------------------------------------------------------------------
# JSON extraction and the decision format gate
# ---------------------------------------------------------------------------


def _reject_constant(name: str) -> Any:
    raise ValueError(f"non-finite number {name} is not allowed")


def _finite_float(literal: str) -> float:
    value = float(literal)
    if not math.isfinite(value):  # e.g. 1e999
        raise ValueError(f"non-finite number {literal} is not allowed")
    return value


_DECODER = json.JSONDecoder(parse_constant=_reject_constant, parse_float=_finite_float)
_CODE_FENCE = re.compile(r"```[A-Za-z0-9_-]*[ \t]*\n?(.*?)```", re.DOTALL)


def _decode_whole(text: str) -> Any:
    try:
        value, end = _DECODER.raw_decode(text)
    except (ValueError, RecursionError):
        return None
    return value if not text[end:].strip() else None


def extract_json_object(text: Optional[str]) -> Optional[dict[str, Any]]:
    """Return the first JSON object in ``text`` (tolerates code fences and leading or
    trailing prose).  Order: the whole text; each fenced block; then the first ``{`` from
    which a JSON object decodes (at most MAX_JSON_SCAN_STARTS starts).  Decoding rejects
    NaN/Infinity literals and overflowing numbers so they never enter a decision.  None
    when nothing decodes to a dict (arrays and scalars are not objects)."""
    if not text or not isinstance(text, str):
        return None
    candidates = [text.strip()] + [m.group(1).strip() for m in _CODE_FENCE.finditer(text)]
    for candidate in candidates:
        value = _decode_whole(candidate)
        if isinstance(value, dict):
            return value
    start = text.find("{")
    tries = 0
    while start != -1 and tries < MAX_JSON_SCAN_STARTS:
        try:
            value, _end = _DECODER.raw_decode(text, start)
        except (ValueError, RecursionError):
            value = None
        if isinstance(value, dict):
            return value
        tries += 1
        start = text.find("{", start + 1)
    return None


def _first_non_finite(value: Any, path: str = "") -> Optional[str]:
    """Path of the first NaN/Infinity float inside a parsed value, else None."""
    if isinstance(value, float) and not math.isfinite(value):
        return path or "(root)"
    if isinstance(value, dict):
        for key, item in value.items():
            found = _first_non_finite(item, f"{path}.{key}" if path else str(key))
            if found:
                return found
    if isinstance(value, list):
        for index, item in enumerate(value):
            found = _first_non_finite(item, f"{path}[{index}]")
            if found:
                return found
    return None


def _cap(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


PARSE_REASON_MAX_CHARS = 200


def _observe_point_problem(parsed: dict[str, Any]) -> Optional[str]:
    """The rules told to the agent say numbers must be plain numbers (INTERFACES section
    6), but ``schemas.Point`` also accepts ``[x, y]``, ``"x,y"``, numeric strings and
    booleans for the engine's and the skills' sake.  The decision gate is stricter: an
    observe point must be an object whose ``x`` and ``y`` are plain integers."""
    action = parsed.get("action")
    if not isinstance(action, dict) or action.get("name") != "observe":
        return None
    args = action.get("args")
    if not isinstance(args, dict) or "point" not in args:
        return None
    point = args["point"]
    if not isinstance(point, dict) or set(point) != {"x", "y"}:
        return "action.observe.args.point: must be an object with integer x and y"
    for axis in ("x", "y"):
        value = point[axis]
        if isinstance(value, bool) or not isinstance(value, int):
            return f"action.observe.args.point.{axis}: must be a plain integer"
    return None


def parse_decision(result: ModelResult) -> tuple[Optional[Decision], Optional[str]]:
    """Format gate (spec "Two distinct validation gates").  Returns ``(Decision, None)``
    when ``result.parsed`` validates as a ``Decision`` (strict: unknown keys, unknown
    action names, wrong arg types, bool-as-number, non-finite numbers all fail), otherwise
    ``(None, reason)`` where reason is a short readable string such as ``"status=timeout"``
    (with the adapter's error detail when it has one, e.g. ``"status=malformed: structured
    output did not match the decision schema"``, so the agent is told why its turn was lost),
    ``"not a JSON object"`` or the first pydantic error with its location (<= 200 chars)."""
    if result.status != "ok":
        detail = f": {result.error}" if result.error else ""
        return None, _cap(f"status={result.status}{detail}", PARSE_REASON_MAX_CHARS)
    if not isinstance(result.parsed, dict):
        return None, "not a JSON object"
    problem = reply_problem(result.parsed)
    if problem is not None:
        return None, _cap(problem, PARSE_REASON_MAX_CHARS)
    bad = _first_non_finite(result.parsed)
    if bad is not None:
        return None, _cap(f"non-finite number at {bad}", PARSE_REASON_MAX_CHARS)
    point_problem = _observe_point_problem(result.parsed)
    if point_problem is not None:
        return None, _cap(point_problem, PARSE_REASON_MAX_CHARS)
    try:
        return Decision.model_validate(result.parsed), None
    except ValidationError as exc:
        first = exc.errors()[0]
        loc = ".".join(str(part) for part in first.get("loc", ())) or "decision"
        return None, _cap(f"{loc}: {first.get('msg', 'invalid')}", PARSE_REASON_MAX_CHARS)


# ---------------------------------------------------------------------------
# Schema transforms (each adapter owns its transform; INTERFACES 4.4)
# ---------------------------------------------------------------------------

_SCHEMA_MAP_KEYS = ("properties", "$defs", "definitions", "patternProperties")
_SCHEMA_LIST_KEYS = ("anyOf", "oneOf", "allOf", "prefixItems")
_SCHEMA_NODE_KEYS = ("items", "additionalProperties", "not")

# Typed replacement for an untyped ``items: {}`` (RunSkillArgs.arguments): scalars or a point.
JSON_VALUE_ITEMS: dict[str, Any] = {
    "anyOf": [
        {"type": "number"},
        {"type": "string"},
        {"type": "boolean"},
        {"type": "null"},
        {
            "type": "object",
            "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}},
            "required": ["x", "y"],
            "additionalProperties": False,
        },
    ]
}


def _map_schema(node: Any, visit: Callable[[dict[str, Any]], dict[str, Any]]) -> Any:
    """Copy a JSON schema, calling ``visit`` on every schema node after its children
    (property NAMES are never treated as keywords)."""
    if not isinstance(node, dict):
        return copy.deepcopy(node)
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key in _SCHEMA_MAP_KEYS and isinstance(value, dict):
            out[key] = {name: _map_schema(sub, visit) for name, sub in value.items()}
        elif key in _SCHEMA_LIST_KEYS and isinstance(value, list):
            out[key] = [_map_schema(sub, visit) for sub in value]
        elif key in _SCHEMA_NODE_KEYS and isinstance(value, dict):
            out[key] = _map_schema(value, visit)
        else:
            out[key] = copy.deepcopy(value)
    return visit(out)


def compact_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Anthropic tool ``input_schema`` / claude_cli ``--json-schema`` / Bedrock text: the
    raw schema minus decorative keywords (``title``, OpenAPI ``discriminator``)."""

    def visit(node: dict[str, Any]) -> dict[str, Any]:
        node.pop("title", None)
        node.pop("discriminator", None)
        return node

    return _map_schema(schema, visit)


def _nullable(sub: dict[str, Any]) -> dict[str, Any]:
    if "$ref" in sub:
        return {"anyOf": [sub, {"type": "null"}]}
    if "anyOf" in sub:
        if not any(isinstance(v, dict) and v.get("type") == "null" for v in sub["anyOf"]):
            sub["anyOf"].append({"type": "null"})
        return sub
    kind = sub.get("type")
    if isinstance(kind, str) and kind != "null":
        sub["type"] = [kind, "null"]
    elif isinstance(kind, list) and "null" not in kind:
        sub["type"] = kind + ["null"]
    if isinstance(sub.get("enum"), list) and None not in sub["enum"]:
        sub["enum"] = sub["enum"] + [None]
    return sub


def openai_strict_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """OpenAI-family ``json_schema`` transform (strict-mode compatible): oneOf -> anyOf;
    ``discriminator``/``default``/``maxLength``/``title`` dropped; every object lists all
    its properties as required with ``additionalProperties: false``, the originally
    optional ones made nullable; untyped ``items`` get JSON_VALUE_ITEMS.  Replies are
    passed through ``strip_transform_nulls`` before the format gate."""

    def visit(node: dict[str, Any]) -> dict[str, Any]:
        for keyword in ("discriminator", "default", "maxLength", "title"):
            node.pop(keyword, None)
        if "oneOf" in node:
            node["anyOf"] = node.pop("oneOf")
        if node.get("type") == "array" and not node.get("items"):
            node["items"] = copy.deepcopy(JSON_VALUE_ITEMS)
        properties = node.get("properties")
        if isinstance(properties, dict):
            originally_required = set(node.get("required", []))
            for name in list(properties):
                if name not in originally_required and isinstance(properties[name], dict):
                    properties[name] = _nullable(properties[name])
            node["required"] = list(properties)
            node["additionalProperties"] = False
        return node

    return _map_schema(schema, visit)


def _deref(schema: Any, defs: dict[str, Any]) -> dict[str, Any]:
    if isinstance(schema, dict) and isinstance(schema.get("$ref"), str):
        name = schema["$ref"].rsplit("/", 1)[-1]
        target = defs.get(name)
        if isinstance(target, dict):
            return target
    return schema if isinstance(schema, dict) else {}


def _choose_variant(value: dict[str, Any], variants: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """The union member a dict belongs to: by ``const`` discriminator, else by keys."""
    for variant in variants:
        props = variant.get("properties")
        if not isinstance(props, dict):
            continue
        for prop_name, prop_schema in props.items():
            if isinstance(prop_schema, dict) and "const" in prop_schema and value.get(prop_name) == prop_schema["const"]:
                return variant
    for variant in variants:
        props = variant.get("properties")
        if isinstance(props, dict) and set(value) <= set(props):
            return variant
    return None


def strip_transform_nulls(value: Any, schema: dict[str, Any], defs: Optional[dict[str, Any]] = None) -> Any:
    """Undo the nullable-optional part of ``openai_strict_schema``: drop dict keys whose
    value is null when the RAW schema does not require that key, so the reply validates
    against the strict ``Decision`` model (null == "use the default").  Values inside
    untyped arrays (skill arguments) are left untouched."""
    if defs is None:
        defs = schema.get("$defs", {}) if isinstance(schema, dict) else {}
    node = _deref(schema, defs)
    if isinstance(value, dict):
        properties = node.get("properties")
        if isinstance(properties, dict):
            required = set(node.get("required", []))
            out: dict[str, Any] = {}
            for key, item in value.items():
                if item is None and key in properties and key not in required:
                    continue
                out[key] = strip_transform_nulls(item, properties[key], defs) if key in properties else item
            return out
        variants = node.get("oneOf") or node.get("anyOf")
        if isinstance(variants, list):
            chosen = _choose_variant(value, [_deref(v, defs) for v in variants])
            if chosen is not None:
                return strip_transform_nulls(value, chosen, defs)
        return value
    if isinstance(value, list):
        items = node.get("items")
        if isinstance(items, dict) and items:
            return [strip_transform_nulls(item, items, defs) for item in value]
    return value


def _sends_native_schema(ref: ModelRef, schema: Optional[dict[str, Any]]) -> bool:
    """A native schema/forced tool is sent iff the route declares ``supports_json_schema``
    and has a native mechanism (Bedrock converse has none: prompt instructions instead)."""
    return bool(schema) and ref.capabilities.supports_json_schema and ref.provider != "bedrock"


def _json_instruction(ref: ModelRef, schema: Optional[dict[str, Any]]) -> str:
    """System-prompt addition when no native schema is sent.  Bedrock routes that declare
    ``supports_json_schema`` get the compact schema textually (context then leaves it out
    of the stable rules), so the capability is honoured through a validated fallback."""
    if ref.provider == "bedrock" and schema and ref.capabilities.supports_json_schema:
        return f"{JSON_ONLY_INSTRUCTION} It must validate against this JSON schema: {_compact_json(compact_schema(schema))}"
    return JSON_ONLY_INSTRUCTION


def _native_schema_payload(ref: ModelRef, schema: dict[str, Any]) -> Any:
    if ref.provider in ("openai", "fireworks", "foundry"):
        return openai_strict_schema(schema)
    return compact_schema(schema)


def _fixed_overhead(ref: ModelRef) -> int:
    override = ref.options.get("overhead_tokens")
    if isinstance(override, int) and not isinstance(override, bool) and override >= 0:
        return override
    return FIXED_OVERHEAD_TOKENS.get(ref.provider, 0)


def _text_mode(request: ModelRequest) -> bool:
    """rev 4: ``response_format == "text"`` (no JSON instruction, no schema, prose is ok)."""
    return request.response_format == "text"


def _overhead_for(ref: ModelRef, schema: Optional[dict[str, Any]], text_mode: bool = False) -> int:
    """Provider-side input tokens beyond the messages.  Text mode adds no schema and no
    JSON-only instruction: only the route's fixed overhead."""
    if ref.provider == "fake":
        return 0
    if text_mode:
        return _fixed_overhead(ref)
    if _sends_native_schema(ref, schema):
        assert schema is not None
        return estimate_tokens(_compact_json(_native_schema_payload(ref, schema))) + _fixed_overhead(ref)
    return estimate_tokens(_json_instruction(ref, schema)) + _fixed_overhead(ref)


def _request_overhead(ref: ModelRef, request: ModelRequest) -> int:
    return _overhead_for(ref, request.response_schema, _text_mode(request))


def request_overhead_tokens(model_key: str, registry: ModelRegistry, *, response_format: str = "json") -> int:
    """Provider-side input tokens the adapter will add beyond ``request.messages`` for a
    decision request (A-COG-8): the transformed decision schema when a native schema /
    forced tool is sent (``capabilities.supports_json_schema``) plus the route's fixed
    overhead (FIXED_OVERHEAD_TOKENS or ``ref.options["overhead_tokens"]``); otherwise the
    JSON-only instruction appended to the system prompt plus the fixed overhead.  The
    textual schema description in the stable rules (no native schema) is context's and is
    NOT counted here.  ``response_format="text"`` (rev 4) counts the fixed overhead only (no
    JSON instruction, no schema).  0 for fake refs and unknown keys."""
    try:
        ref = registry.resolved(model_key)
    except UnknownModelError:
        return 0
    if response_format == "text":
        return _overhead_for(ref, None, text_mode=True)
    return _overhead_for(ref, decision_json_schema())


# ---------------------------------------------------------------------------
# Retry policy and error classification
# ---------------------------------------------------------------------------


def is_retryable(status: str, http_status: Optional[int]) -> bool:
    """Retry policy: timeouts, HTTP 408, 429, 5xx and 529 -> True.  401/403/404 and
    400/413/422 (schema/params) are ``invalid_config`` and never retried.  Agent-output
    statuses are never retried.  Connection errors carry no HTTP status; adapters mark
    them retryable explicitly (``Attempt.retryable``)."""
    if status in AGENT_OUTPUT_STATUSES or status == "invalid_config":
        return False
    if status == "timeout":
        return True
    if http_status is None:
        return False
    return http_status in RETRYABLE_HTTP_STATUSES or 500 <= http_status <= 599


def _exception_names(exc: BaseException) -> set[str]:
    return {cls.__name__ for cls in type(exc).__mro__}


def _http_status_of(exc: BaseException) -> Optional[int]:
    code = getattr(exc, "status_code", None)
    if isinstance(code, int) and not isinstance(code, bool):
        return code
    response = getattr(exc, "response", None)
    if isinstance(response, dict):  # botocore ClientError
        code = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if isinstance(code, int):
            return code
    return None


def _retry_after_of(exc: BaseException) -> Optional[float]:
    """Seconds from ``retry-after-ms`` / ``retry-after`` (numeric form only)."""
    headers = getattr(getattr(exc, "response", None), "headers", None)
    if headers is None or not hasattr(headers, "get"):
        return None
    for name, scale in (("retry-after-ms", 0.001), ("retry-after", 1.0)):
        raw = headers.get(name)
        if raw is None:
            continue
        try:
            seconds = float(raw) * scale
        except (TypeError, ValueError):
            continue
        if math.isfinite(seconds) and seconds >= 0:
            return seconds
    return None


def _boto_error_code(exc: BaseException) -> Optional[str]:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        code = response.get("Error", {}).get("Code")
        return code if isinstance(code, str) else None
    return None


_CREDENTIAL_EXCEPTIONS = frozenset(
    {"NoCredentialsError", "PartialCredentialsError", "CredentialsError", "NoRegionError", "ProfileNotFound"}
)


def classify_exception(exc: BaseException) -> tuple[str, Optional[int], Optional[bool]]:
    """(status, http_status, retryable override) for an SDK/transport exception, without
    importing any SDK: missing credentials -> invalid_config; timeouts -> timeout
    (retryable); connection errors -> error (retryable); HTTP 400/401/403/404/413/422 ->
    invalid_config; other HTTP statuses -> error (``is_retryable`` decides); anything
    else -> error (not retryable)."""
    names = _exception_names(exc)
    if names & _CREDENTIAL_EXCEPTIONS:
        return "invalid_config", None, False
    http_status = _http_status_of(exc)
    if _boto_error_code(exc) == "ModelTimeoutException" or http_status == 408:
        return "timeout", http_status, True
    if http_status is None:
        if any("Timeout" in name for name in names):
            return "timeout", None, True
        if any("Connection" in name for name in names):
            return "error", None, True
        return "error", None, False
    if http_status in CONFIG_HTTP_STATUSES:
        return "invalid_config", http_status, False
    return "error", http_status, None


def derive_error_code(status: str, http_status: Optional[int], *, text_mode: bool = False) -> Optional[str]:
    """The generic part of ``ModelResult.error_code`` (rev 4), used when an adapter did not set
    a more specific code: ``timeout`` for status timeout, ``rate_limited`` for HTTP 429/529,
    ``schema_mismatch`` for a JSON-mode ``malformed`` reply (no object / not the schema).
    Adapter-specific codes (``budget_exceeded``, ``cancelled``, ``not_logged_in``,
    ``cli_missing``) are set where they are detected.  None for ok and unclassified failures."""
    if status == "ok":
        return None
    if status == "timeout":
        return "timeout"
    if http_status in RATE_LIMIT_HTTP_STATUSES:
        return "rate_limited"
    if status == "malformed" and not text_mode:
        return "schema_mismatch"
    return None


# ---------------------------------------------------------------------------
# Adapter plumbing
# ---------------------------------------------------------------------------


class Adapter(Protocol):
    def complete(self, ref: ModelRef, request: ModelRequest) -> ModelResult: ...


@dataclass
class Attempt:
    """One provider attempt: the result plus what the retry policy needs."""

    result: ModelResult
    http_status: Optional[int] = None
    retry_after: Optional[float] = None
    retryable: Optional[bool] = None  # overrides is_retryable (connection errors, adapter bugs)
    notes: list[str] = field(default_factory=list)  # kept in attempt_errors as "attempt N: note: ..."


def reply_problem(value: Any, depth: int = 0) -> Optional[str]:
    """Why a decoded reply can never be stored or executed: nesting deeper than
    ``MAX_REPLY_NESTING`` levels, or a string (key or value) that is not valid Unicode text
    (a lone UTF-16 surrogate such as ``"\\ud800"`` decodes into a Python str that cannot be
    written as UTF-8).  None when the value is fine.  Such replies are classified
    ``malformed`` (spec "Two distinct validation gates": malformed output is a handled
    result, never an error)."""
    if depth > MAX_REPLY_NESTING:
        return f"nested deeper than {MAX_REPLY_NESTING} levels"
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            return "text contains a lone surrogate character"
        return None
    if isinstance(value, dict):
        for key, item in value.items():
            found = reply_problem(key, depth + 1) or reply_problem(item, depth + 1)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = reply_problem(item, depth + 1)
            if found:
                return found
    return None


def sanitize_text(text: Optional[str]) -> Optional[str]:
    """``text`` with every lone surrogate replaced by U+FFFD so a stored reply is always
    valid UTF-8; other text passes through unchanged."""
    if text is None:
        return None
    try:
        text.encode("utf-8")
        return text
    except UnicodeEncodeError:
        return text.encode("utf-16", "surrogatepass").decode("utf-16", "replace")


def _make_result(
    request: ModelRequest,
    ref: ModelRef,
    status: str,
    *,
    text: Optional[str] = None,
    parsed: Optional[dict[str, Any]] = None,
    usage: Optional[ModelUsage] = None,
    response_model: Optional[str] = None,
    provider_cost_usd: Optional[float] = None,
    error: Optional[str] = None,
    stop_reason: Optional[str] = None,
    error_code: Optional[str] = None,
) -> ModelResult:
    """Assemble one attempt's result.  ``ok``: JSON mode -> status ok and ``parsed`` is a dict;
    text mode (rev 4) -> status ok and the text is non-empty (``parsed`` is always None)."""
    text_mode = _text_mode(request)
    parsed = parsed if status == "ok" and isinstance(parsed, dict) and not text_mode else None
    clean = sanitize_text(text)
    ok = status == "ok" and (bool((clean or "").strip()) if text_mode else parsed is not None)
    return ModelResult(
        request_id=request.request_id,
        ok=ok,
        status=status,  # type: ignore[arg-type]
        text=clean,
        parsed=parsed,
        usage=usage or ModelUsage(),
        provider=ref.provider,
        model_id=ref.model_id,
        response_model=response_model,
        provider_cost_usd=provider_cost_usd,
        error=redact(error),
        stop_reason=stop_reason,
        error_code=error_code,  # type: ignore[arg-type]
    )


def _failure(
    request: ModelRequest,
    ref: ModelRef,
    status: str,
    error: str,
    *,
    http_status: Optional[int] = None,
    retry_after: Optional[float] = None,
    retryable: Optional[bool] = None,
    usage: Optional[ModelUsage] = None,
    error_code: Optional[str] = None,
) -> Attempt:
    return Attempt(
        _make_result(request, ref, status, error=error, usage=usage, error_code=error_code),
        http_status=http_status,
        retry_after=retry_after,
        retryable=retryable,
    )


def _cancelled(request: ModelRequest, ref: ModelRef, detail: str) -> Attempt:
    """A call stopped by ``call_model(cancel=...)`` or ``kill_inflight``: status error,
    error_code cancelled, never retried."""
    return _failure(request, ref, "error", f"cancelled: {detail}", retryable=False, error_code="cancelled")


def _attempt_from_exception(request: ModelRequest, ref: ModelRef, exc: BaseException) -> Attempt:
    status, http_status, retryable = classify_exception(exc)
    prefix = f"HTTP {http_status}: " if http_status is not None else ""
    return _failure(
        request,
        ref,
        status,
        f"{prefix}{type(exc).__name__}: {exc}",
        http_status=http_status,
        retry_after=_retry_after_of(exc),
        retryable=retryable,
    )


def _output_status(
    parsed: Optional[dict[str, Any]], text: Optional[str], *, refused: bool, truncated: bool
) -> tuple[str, Optional[dict[str, Any]]]:
    """Agent-output classification: refusal / truncated (never parsed, so a cut-off reply
    can never execute), ok with a JSON object (native parse or extraction) that can be
    stored (``reply_problem`` is None), else malformed."""
    if refused:
        return "refusal", None
    if truncated:
        return "truncated", None
    candidate = parsed if isinstance(parsed, dict) else extract_json_object(text)
    if candidate is None or reply_problem(candidate) is not None:
        return "malformed", None
    return "ok", candidate


def _text_status(text: Optional[str], *, refused: bool, truncated: bool) -> tuple[str, None]:
    """Text response mode (rev 4) classification: refusal / truncated (the text is kept; the
    caller decides whether a cut-off narrative is usable) / ok for any non-empty text /
    malformed for an empty reply.  Never parses JSON (a code example in prose stays prose)."""
    if refused:
        return "refusal", None
    if truncated:
        return "truncated", None
    if not (text or "").strip():
        return "malformed", None
    return "ok", None


def _classify(
    request: ModelRequest, parsed: Optional[dict[str, Any]], text: Optional[str], *, refused: bool, truncated: bool
) -> tuple[str, Optional[dict[str, Any]]]:
    """``_text_status`` in text mode, else ``_output_status``."""
    if _text_mode(request):
        return _text_status(text, refused=refused, truncated=truncated)
    return _output_status(parsed, text, refused=refused, truncated=truncated)


def _split_messages(request: ModelRequest, ref: Optional[ModelRef] = None) -> tuple[str, list[tuple[str, str]]]:
    """(system text, chat turns) with consecutive same-role turns merged.  When the
    route declares ``capabilities.supports_system_prompt = False`` the documented fallback
    applies: the system text is folded into the first user turn (under a "SYSTEM
    INSTRUCTIONS" heading) and the returned system text is empty, so no adapter ever
    sends a system message such a model cannot take (spec "Model calls and validation":
    unsupported capabilities need an explicit validated fallback)."""
    system = "\n\n".join(m.content for m in request.messages if m.role == "system")
    chat: list[tuple[str, str]] = []
    for message in request.messages:
        if message.role == "system":
            continue
        if chat and chat[-1][0] == message.role:
            chat[-1] = (message.role, chat[-1][1] + "\n\n" + message.content)
        else:
            chat.append((message.role, message.content))
    if ref is not None and not ref.capabilities.supports_system_prompt and system:
        folded = f"SYSTEM INSTRUCTIONS:\n{system}\n\nUSER:\n"
        if chat and chat[0][0] == "user":
            chat[0] = ("user", folded + chat[0][1])
        else:
            chat.insert(0, ("user", folded.rstrip()))
        system = ""
    return system, chat


def _api_key_name(ref: ModelRef, default_name: str) -> str:
    configured = ref.options.get("api_key_env")
    if isinstance(configured, str) and configured:
        return configured
    for name in ref.credential_env:
        if "KEY" in name.upper():
            return name
    return default_name


def _temperature(ref: ModelRef, request: ModelRequest) -> Optional[float]:
    if ref.options.get("param_style") == "reasoning":
        return None
    value = request.temperature if request.temperature is not None else ref.options.get("temperature")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return None


class BaseAdapter:
    """``complete`` = one attempt.  ``call_model`` drives ``attempt`` with the retry policy."""

    def complete(self, ref: ModelRef, request: ModelRequest) -> ModelResult:
        return self.attempt(ref, request, 1).result

    def attempt(self, ref: ModelRef, request: ModelRequest, attempt_no: int, *, cancel: Optional[threading.Event] = None) -> Attempt:
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Fake adapter (INTERFACES section 12)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FakePolicy:
    """Numbers of the fake survival policy (the fake model's own "personality", not game
    rules).  Cadences are in rounds."""

    observation_max_age_rounds: int = 3
    self_query_every_rounds: int = 6
    upgrade_every_rounds: int = 7
    broadcast_every_rounds: int = 10
    skill_every_rounds: int = 11
    notebook_every_rounds: int = 12
    send_probability: float = 0.3
    recover_health_margin: float = 20.0
    recover_min_compute: float = 30.0
    recover_amount: float = 10.0
    upgrade_compute_margin: float = 40.0
    broadcast_min_compute: float = 40.0
    attack_budget: float = 5.0
    attack_min_compute: float = 15.0
    rest_below_compute: float = 6.0
    min_useful_amount: float = 1e-9
    upgrade_rotation: tuple[str, ...] = (
        "vision_range",
        "communication_range",
        "max_health",
        "essence_capacity",
        "compute_absorption",
    )


FAKE_POLICY = FakePolicy()

# Design doc "Examples using only the defined blocks", example 2 (48 blocks).
FORAGE_SKILL_NAME = "forage"
FORAGE_SKILL_SOURCE = """SET observation = observe(here)
IF observation.ok == false
    RETURN observation.reason
END
FOR_EACH entity IN observation.data.entities
    IF entity.kind == "fruit"
        SET fruit_details = query(entity.id)
        IF fruit_details.ok == true
            IF fruit_details.data.available_compute > 0
                SET absorption_result = absorb(entity.id, "compute")
                IF absorption_result.ok == true
                    SET own_details = query(self)
                    IF own_details.ok == true
                        IF own_details.data.health < own_details.data.max_health AND own_details.data.compute >= 10
                            SET recovery_result = recover(5)
                        END
                    END
                    RETURN absorption_result
                END
            END
        END
    END
END
RETURN "no_food_absorbed"
"""

FAKE_DIRECTIONS: tuple[str, ...] = ("up", "down", "left", "right")


def _act(name: str, **args: Any) -> dict[str, Any]:
    return {"name": name, "args": args}


def _decision(thought: str, action: dict[str, Any], **extra: Any) -> dict[str, Any]:
    decision: dict[str, Any] = {"thought": thought}
    decision.update(extra)
    decision["action"] = action
    return decision


@dataclass
class _FakeView:
    """Everything the fake policy derives from one Situation (pure)."""

    situation: Situation
    agent_id: str
    round_no: int
    rng: random.Random
    options: dict[str, Any]
    policy: FakePolicy
    last_name: Optional[str]
    last_args: dict[str, Any]
    last_ok: Optional[bool]
    last_round: Optional[int]
    skip_ids: set[str]
    just_queried: Optional[str]

    @property
    def me(self) -> Any:
        return self.situation.self_state

    @property
    def here(self) -> dict[str, int]:
        return {"x": self.situation.position.x, "y": self.situation.position.y}

    def visible(self, kind: str) -> list[Any]:
        return [
            e
            for e in self.situation.visible_entities
            if e.kind == kind and e.alive is not False and e.id != self.agent_id and e.id not in self.skip_ids
        ]


def _make_fake_view(
    agent_id: str, round_no: int, turn_id: str, situation: Situation, options: dict[str, Any], policy: FakePolicy
) -> _FakeView:
    last = situation.last_action if isinstance(situation.last_action, dict) else {}
    last_args = last.get("args") if isinstance(last.get("args"), dict) else {}
    result = situation.last_result
    last_name = last.get("name") if isinstance(last.get("name"), str) else None
    targeted = next(
        (last_args.get(k) for k in ("source", "entity", "target") if isinstance(last_args.get(k), str)), None
    )
    skip_ids: set[str] = set()
    if targeted and (last_name == "absorb" or (result is not None and not result.ok)):
        skip_ids.add(targeted)  # consumed or failed: do not retry it before re-observing
    just_queried = targeted if last_name == "query" and result is not None and result.ok else None
    return _FakeView(
        situation=situation,
        agent_id=agent_id,
        round_no=round_no,
        rng=random.Random(f"{agent_id}:{round_no}:{turn_id}"),
        options=options,
        policy=policy,
        last_name=last_name,
        last_args=last_args,
        last_ok=None if result is None else result.ok,
        last_round=None if result is None else result.round,
        skip_ids=skip_ids,
        just_queried=just_queried,
    )


def _rule_observe(v: _FakeView) -> Optional[dict[str, Any]]:
    """Observe here if never observed, the observation is too old, or this point changed
    since (we moved, absorbed or attacked after observing)."""
    s = v.situation
    if s.observed_round is None:
        return _decision("I have not observed this point yet.", _act("observe", point=v.here, page=0))
    if v.round_no - s.observed_round > v.policy.observation_max_age_rounds:
        return _decision("My observation here is stale.", _act("observe", point=v.here, page=0))
    if v.last_name in ("move", "absorb", "attack") and s.observed_round < v.round_no:
        return _decision("Things changed here; look again.", _act("observe", point=v.here, page=0))
    return None


def _rule_attack(v: _FakeView) -> Optional[dict[str, Any]]:
    """Only with fake_options.aggressive: attack the first visible agent (same point)."""
    if not v.options.get("aggressive"):
        return None
    compute = v.me.compute
    if compute is not None and compute < v.policy.attack_min_compute:
        return None
    others = sorted(v.visible("agent"), key=lambda e: e.id)
    if not others:
        return None
    target = others[0].id
    return _decision(f"Aggressive: strike {target}.", _act("attack", target=target, compute_budget=v.policy.attack_budget))


def _rule_fruit(v: _FakeView) -> Optional[dict[str, Any]]:
    """Absorb compute from a fruit known to hold some; otherwise query an unknown fruit."""
    fruits = v.visible("fruit")
    eps = v.policy.min_useful_amount
    for fruit in fruits:
        known_full = fruit.available_compute is not None and fruit.available_compute > eps
        queried_now = fruit.available_compute is None and v.just_queried == fruit.id
        if known_full or queried_now:
            return _decision(f"Fruit {fruit.id} has compute; absorb it.", _act("absorb", source=fruit.id, resource="compute"))
    for fruit in fruits:
        if fruit.available_compute is None:
            return _decision(f"Check how much fruit {fruit.id} holds.", _act("query", entity=fruit.id))
    return None


def _rule_residue(v: _FakeView) -> Optional[dict[str, Any]]:
    """Residue: essence while capacity is free (unknown counts as free), else compute."""
    eps = v.policy.min_useful_amount
    me = v.me
    capacity_free = me.essence is None or me.essence_capacity is None or me.essence < me.essence_capacity - eps
    for residue in v.visible("residue"):
        essence, compute = residue.available_essence, residue.available_compute
        if essence is None and compute is None:
            if v.just_queried == residue.id:
                return _decision(f"Absorb residue {residue.id}.", _act("absorb", source=residue.id, resource="compute"))
            return _decision(f"Inspect residue {residue.id}.", _act("query", entity=residue.id))
        if essence is not None and essence > eps and capacity_free:
            return _decision(f"Take essence from {residue.id}.", _act("absorb", source=residue.id, resource="essence"))
        if compute is not None and compute > eps:
            return _decision(f"Take compute from {residue.id}.", _act("absorb", source=residue.id, resource="compute"))
    return None


def _rule_recover(v: _FakeView) -> Optional[dict[str, Any]]:
    me = v.me
    if me.health is None or me.max_health is None or me.compute is None:
        return None
    if me.health < me.max_health - v.policy.recover_health_margin and me.compute >= v.policy.recover_min_compute:
        amount = min(v.policy.recover_amount, me.max_health - me.health)
        return _decision("I am hurt and can afford to heal.", _act("recover", compute_budget=amount))
    return None


def _rule_self_query(v: _FakeView) -> Optional[dict[str, Any]]:
    """query(self) every Nth round (refreshes stale beliefs and upgrade quotes), or when
    nothing at all is known about myself."""
    me = v.me
    nothing_known = me.compute is None and me.health is None
    due = v.round_no % v.policy.self_query_every_rounds == 0
    already = v.last_name == "query" and v.last_args.get("entity") in ("self", v.agent_id) and v.last_round == v.round_no
    if (nothing_known or due) and not already:
        return _decision("Refresh what I know about myself.", _act("query", entity="self"))
    return None


def _rule_send(v: _FakeView) -> Optional[dict[str, Any]]:
    others = sorted(v.visible("agent"), key=lambda e: e.id)
    if not others or v.rng.random() >= v.policy.send_probability:
        return None
    other = others[0].id
    s = v.situation
    if s.unread_messages:
        text = f"{s.name} ({v.agent_id}) here. I got your message in round {v.round_no}."
    else:
        text = f"Hello {other}, this is {s.name} ({v.agent_id}) at ({s.position.x},{s.position.y}) in round {v.round_no}."
    return _decision(f"Say hello to {other}.", _act("send", recipient=other, message=text))


def _rule_broadcast(v: _FakeView) -> Optional[dict[str, Any]]:
    every = v.policy.broadcast_every_rounds
    if v.round_no % every != every // 2:
        return None
    compute = v.me.compute
    if compute is not None and compute < v.policy.broadcast_min_compute:
        return None
    s = v.situation
    fruit_count = len(v.visible("fruit"))
    text = f"{s.name} ({v.agent_id}) is at ({s.position.x},{s.position.y}); fruit here: {fruit_count}."
    return _decision("Tell whoever can hear where I am.", _act("broadcast", message=text))


def _rule_skill(v: _FakeView) -> Optional[dict[str, Any]]:
    """Every Nth round: save the design-example forage skill if absent, then run it."""
    s = v.situation
    if v.round_no % v.policy.skill_every_rounds != 0 or s.skill_running:
        return None
    if s.skill_last_error and FORAGE_SKILL_NAME in s.skill_last_error:
        return None
    action = _act("run_skill", skill=FORAGE_SKILL_NAME, arguments=[])
    if FORAGE_SKILL_NAME in s.skills:
        return _decision("Run my forage skill.", action)
    save = [{"name": FORAGE_SKILL_NAME, "params": [], "source": FORAGE_SKILL_SOURCE}]
    return _decision("Save a forage skill and run it.", action, save_skills=save)


def _rule_upgrade(v: _FakeView) -> Optional[dict[str, Any]]:
    """Every Nth round buy the rotating attribute when the stored quote is affordable with
    a margin (skill-mode quotes are converted back to the direct price)."""
    s = v.situation
    if v.round_no % v.policy.upgrade_every_rounds != 0 or not s.upgrade_quotes:
        return None
    rotation = v.policy.upgrade_rotation
    attribute = rotation[(v.round_no // v.policy.upgrade_every_rounds - 1) % len(rotation)]
    quote = s.upgrade_quotes.get(attribute)
    me = v.me
    if not isinstance(quote, dict) or quote.get("allowed") is not True or me.compute is None or me.essence is None:
        return None
    price = quote.get("base_compute") if s.quote_mode == "skill" else quote.get("compute", quote.get("base_compute"))
    essence_price = quote.get("essence")
    if not isinstance(price, (int, float)) or not isinstance(essence_price, (int, float)):
        return None
    if me.compute >= price + v.policy.upgrade_compute_margin and me.essence >= essence_price:
        return _decision(f"I can afford {attribute}.", _act("upgrade", attribute=attribute))
    return None


def _rule_rest(v: _FakeView) -> Optional[dict[str, Any]]:
    compute = v.me.compute
    if compute is not None and compute < v.policy.rest_below_compute:
        return _decision("Too little compute to wander; rest.", _act("wait", rounds=1))
    return None


def _rule_move(v: _FakeView) -> Optional[dict[str, Any]]:
    directions = list(FAKE_DIRECTIONS)
    if v.last_name == "move" and v.last_ok is False and v.last_args.get("direction") in directions:
        directions.remove(v.last_args["direction"])
    direction = v.rng.choice(directions)
    return _decision("Nothing useful here; explore.", _act("move", direction=direction))


FAKE_RULES: tuple[Callable[[_FakeView], Optional[dict[str, Any]]], ...] = (
    _rule_observe,
    _rule_attack,
    _rule_fruit,
    _rule_residue,
    _rule_recover,
    _rule_self_query,
    _rule_send,
    _rule_broadcast,
    _rule_skill,
    _rule_upgrade,
    _rule_rest,
    _rule_move,
)


def fake_heuristic_decision(
    agent_id: str,
    round_no: int,
    turn_id: str,
    situation: Optional[Situation],
    fake_options: Optional[dict[str, Any]] = None,
    policy: FakePolicy = FAKE_POLICY,
) -> dict[str, Any]:
    """The ``fake-heuristic`` decision: a pure function of its arguments, seeded with
    ``random.Random(f"{agent_id}:{round}:{turn_id}")`` (never ``hash()``).  Priority order
    (first rule that applies wins, see FAKE_RULES):

    idle option -> wait(1); no situation -> query(self);
    1. observe here (never observed, older than 3 rounds, or moved/absorbed/attacked since);
    2. aggressive option only: attack the first visible agent (budget 5);
    3. absorb compute from a fruit known to hold some, else query an unknown fruit;
    4. residue: query it, then absorb essence while capacity is free, else compute;
    5. recover(10) when believed health < max_health - 20 and believed compute >= 30;
    6. query(self) every 6th round (or when nothing about myself is known);
    7. with another agent visible, send it a short message (30% seeded chance);
    8. rounds 5, 15, 25, ...: broadcast a short message;
    9. every 11th round: save the design-example "forage" skill if absent and run it;
    10. every 7th round: upgrade a rotating attribute when the stored quote is affordable;
    11. believed compute < 6: wait(1);
    12. move in a seeded direction (never repeating a direction that was just blocked).
    Every 12th round the decision also rewrites the notebook with a one-line status.
    Unknown (None) believed balances count as "enough" for cheap actions and block the
    expensive ones (recover, upgrade)."""
    options = fake_options if isinstance(fake_options, dict) else {}
    if options.get("idle"):
        return _decision("Idle by configuration.", _act("wait", rounds=1))
    if situation is None:
        return _decision("I have no situation; check myself.", _act("query", entity="self"))
    view = _make_fake_view(agent_id, round_no, turn_id, situation, options, policy)
    decision = None
    for rule in FAKE_RULES:
        decision = rule(view)
        if decision is not None:
            break
    assert decision is not None  # _rule_move always decides
    if round_no > 0 and round_no % policy.notebook_every_rounds == 0:
        compute = situation.self_state.compute
        belief = "unknown" if compute is None else f"{compute:.1f}"
        decision["notebook_update"] = (
            f"Round {round_no}: at ({situation.position.x},{situation.position.y}); believed compute {belief}."
        )
    return decision


def fake_agent_index(agent_id: str) -> int:
    """Index used by the fake-malformed schedule: the trailing digits of the agent id
    (a03 -> 3), else the sum of its character codes (stable across processes)."""
    match = re.search(r"(\d+)$", agent_id or "")
    if match:
        return int(match.group(1))
    return sum(ord(ch) for ch in agent_id or "")


def _situation_from_metadata(metadata: dict[str, Any]) -> Optional[Situation]:
    raw = metadata.get("situation")
    if isinstance(raw, Situation):
        return raw
    if isinstance(raw, dict):
        try:
            return Situation.model_validate(raw)
        except ValidationError:
            return None
    return None


def _call_index(request_id: str) -> int:
    """n from a call id ``mc_{turn_id}_{n:02d}``; 1 when absent."""
    match = re.search(r"_(\d+)$", request_id or "")
    return max(1, int(match.group(1))) if match else 1


def fake_attempt_ordinal(request: ModelRequest, attempt_no: int) -> int:
    """Attempt number counted across all calls of the same turn: call ``_02`` of a turn
    continues after the ``max_retries + 1`` attempts of call ``_01``.  Lets a scheduled
    failure exhaust one call and let the re-run after pause succeed."""
    per_call = max(0, request.max_retries) + 1
    return (_call_index(request.request_id) - 1) * per_call + attempt_no


_FAKE_FAILURE_TEXT = {
    "malformed": "I think I will go north. {not json",
    "refusal": "I can't help with that.",
    "truncated": '{"thought": "I was about to explain my plan when the',
}


class FakeAdapter(BaseAdapter):
    """Deterministic policy; provider "fake".  Mode = ``ref.model_id``:

    * ``fake-heuristic``: ``fake_heuristic_decision`` (see its docstring for the priority
      order) from ``request.metadata["situation"]``.
    * ``fake-scripted``: returns ``metadata["fake_script"][metadata["fake_script_index"]]``
      (a Decision dict; a string entry is returned as raw text and classified like a real
      reply); falls back to the heuristic when exhausted or absent.
    * ``fake-malformed``: staggered by ``(round + fake_agent_index(agent_id)) % 3``:
      0 -> invalid JSON text (status "malformed"); 1 -> unknown action name (status "ok",
      fails the gate); 2 -> valid heuristic decision.

    ``metadata["fake_options"]`` (INTERFACES section 12): ``aggressive``, ``idle``,
    ``sleep_ms`` (simulated latency per attempt; beyond ``timeout_seconds`` the attempt
    times out) and ``fail`` = ``{"status": "timeout"|"error"|"invalid_config"|"refusal"|
    "truncated"|"malformed", "rounds": [ints] (default all), "failing_attempts": n
    (default all), "http_status": int (default 500 for "error")}``.  Attempts are counted
    with ``fake_attempt_ordinal`` (across the calls of one turn), so with the default two
    retries ``failing_attempts: 1`` succeeds on the retry and ``failing_attempts: 3``
    exhausts call ``_01`` while call ``_02`` succeeds.  Usage is estimated; ``status="ok"``
    with ``parsed`` set unless a failure is scheduled.

    rev 4 additions:

    * ``fake-assistant`` (assistant_only): returns ``metadata["fake_script"][metadata[
      "fake_script_index"]]`` when that entry exists (the engine sets the index to the step
      ordinal), else ``metadata["fake_reply"]``, else ``invalid_config`` ("fake-assistant has no
      reply").  Schema-agnostic: the caller supplies replies that fit its own schema.
    * Text mode (``request.response_format == "text"``, every mode): a non-empty string reply is
      ``ok`` with ``text`` set and ``parsed`` None; a dict reply is returned as its JSON text.
      JSON mode: a dict reply is ``ok`` with ``parsed``; a string is classified like a real reply
      (prose -> malformed, a JSON object in the text -> ok).
    * ``fake_options.sleep_ms`` waits on the ``cancel`` event when one is passed: setting it
      ends the attempt at once with status error / error_code cancelled.
    * ``fake_options.fail.error_code`` (any ``ModelErrorCode``) is copied onto a scheduled
      failure; ``fake_options.cost_usd`` (number) is reported as ``provider_cost_usd`` on every
      attempt (ledger tests)."""

    def attempt(self, ref: ModelRef, request: ModelRequest, attempt_no: int, *, cancel: Optional[threading.Event] = None) -> Attempt:
        metadata = request.metadata or {}
        options = metadata.get("fake_options") if isinstance(metadata.get("fake_options"), dict) else {}
        if cancel is not None and cancel.is_set():
            return _cancelled(request, ref, "cancel was set before the fake attempt")
        sleep_ms = options.get("sleep_ms")
        if isinstance(sleep_ms, (int, float)) and not isinstance(sleep_ms, bool) and sleep_ms > 0:
            if sleep_ms / 1000.0 > request.timeout_seconds:
                if _fake_wait(request.timeout_seconds, cancel):
                    return _cancelled(request, ref, "fake attempt interrupted")
                return _failure(
                    request, ref, "timeout", f"fake latency {sleep_ms} ms exceeds the attempt timeout", retryable=True
                )
            if _fake_wait(sleep_ms / 1000.0, cancel):
                return _cancelled(request, ref, "fake attempt interrupted")
        situation = _situation_from_metadata(metadata)
        round_no = metadata.get("round")
        if not isinstance(round_no, int) or isinstance(round_no, bool):
            round_no = situation.round if situation else 0
        agent_id = str(metadata.get("agent_id") or (situation.agent_id if situation else ""))
        turn_id = str(metadata.get("turn_id") or (situation.turn_id if situation else ""))

        failure = self._scheduled_failure(ref, request, options, round_no, attempt_no)
        if failure is not None:
            return failure

        def heuristic() -> dict[str, Any]:
            return fake_heuristic_decision(agent_id, round_no, turn_id, situation, options)

        mode = ref.model_id
        script = metadata.get("fake_script")
        index = metadata.get("fake_script_index")
        scripted = isinstance(script, list) and isinstance(index, int) and not isinstance(index, bool) and 0 <= index < len(script)
        if mode == "fake-heuristic":
            reply: Any = heuristic()
        elif mode == "fake-scripted":
            reply = script[index] if scripted else heuristic()  # type: ignore[index]
        elif mode == "fake-malformed":
            phase = (round_no + fake_agent_index(agent_id)) % 3
            if phase == 0:
                reply = _FAKE_FAILURE_TEXT["malformed"]
            elif phase == 1:
                reply = {"thought": "Try a move that does not exist.", "action": {"name": "teleport", "args": {"to": "anywhere"}}}
            else:
                reply = heuristic()
        elif mode == "fake-assistant":
            if scripted:
                reply = script[index]  # type: ignore[index]
            elif metadata.get("fake_reply") is not None:
                reply = metadata["fake_reply"]
            else:
                return _failure(
                    request, ref, "invalid_config",
                    "fake-assistant has no reply: set metadata fake_script + fake_script_index or fake_reply",
                    retryable=False,
                )
        else:
            return _failure(request, ref, "invalid_config", f"unknown fake mode {mode!r}", retryable=False)

        if _text_mode(request):
            text = json.dumps(reply) if isinstance(reply, (dict, list)) else str(reply)
            status, parsed = _text_status(text, refused=False, truncated=False)
        elif isinstance(reply, dict):
            text = json.dumps(reply)
            status, parsed = "ok", reply
        else:
            text = str(reply)
            status, parsed = _output_status(None, text, refused=False, truncated=False)
        return Attempt(
            _make_result(
                request,
                ref,
                status,
                text=text,
                parsed=parsed,
                usage=estimate_usage(request, text),
                response_model=ref.model_id,
                provider_cost_usd=_fake_cost(options),
                stop_reason="end_turn",
            )
        )

    @staticmethod
    def _scheduled_failure(
        ref: ModelRef, request: ModelRequest, options: dict[str, Any], round_no: int, attempt_no: int
    ) -> Optional[Attempt]:
        fail = options.get("fail")
        if not isinstance(fail, dict):
            return None
        status = fail.get("status", "timeout")
        if status not in ("timeout", "error", "invalid_config", "refusal", "truncated", "malformed"):
            return None
        rounds = fail.get("rounds")
        if isinstance(rounds, list) and round_no not in rounds:
            return None
        failing = fail.get("failing_attempts")
        ordinal = fake_attempt_ordinal(request, attempt_no)
        if isinstance(failing, int) and not isinstance(failing, bool) and ordinal > failing:
            return None
        code = fail.get("error_code") if fail.get("error_code") in MODEL_ERROR_CODES else None
        if status in _FAKE_FAILURE_TEXT:
            text = _FAKE_FAILURE_TEXT[status]
            stop = {"refusal": "refusal", "truncated": "max_tokens"}.get(status, "end_turn")
            return Attempt(
                _make_result(
                    request, ref, status, text=text, usage=estimate_usage(request, text), response_model=ref.model_id,
                    provider_cost_usd=_fake_cost(options), stop_reason=stop, error_code=code,
                )
            )
        message = f"fake scheduled {status} (attempt {ordinal} of the turn)"
        if status == "timeout":
            return _failure(request, ref, "timeout", message, retryable=True, error_code=code)
        if status == "invalid_config":
            return _failure(request, ref, "invalid_config", message, retryable=False, error_code=code)
        http_status = fail.get("http_status", 500)
        http_status = http_status if isinstance(http_status, int) and not isinstance(http_status, bool) else 500
        attempt = _failure(request, ref, "error", f"HTTP {http_status}: {message}", http_status=http_status, error_code=code)
        cost = _fake_cost(options)
        if cost is not None:
            attempt.result = attempt.result.model_copy(update={"provider_cost_usd": cost})
        return attempt


# Every ModelResult.error_code value (schemas.ModelErrorCode).
MODEL_ERROR_CODES: frozenset[str] = frozenset(get_args(ModelErrorCode))


def _fake_wait(seconds: float, cancel: Optional[threading.Event]) -> bool:
    """Sleep ``seconds`` (fake latency); with a cancel event, wait on it instead.  True when
    the wait was interrupted by the event."""
    if cancel is None:
        time.sleep(seconds)
        return False
    return cancel.wait(seconds)


def _fake_cost(options: dict[str, Any]) -> Optional[float]:
    """``fake_options.cost_usd`` as a provider cost (finite, >= 0), else None."""
    value = options.get("cost_usd")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return float(value)
    return None


# ---------------------------------------------------------------------------
# SDK client factories (test hook: replace an entry with a fake client)
# ---------------------------------------------------------------------------


def _anthropic_client(ref: ModelRef, api_key: str, timeout_seconds: float) -> Any:
    anthropic = _import_sdk("anthropic")
    return anthropic.Anthropic(api_key=api_key, base_url=ref.endpoint or None, max_retries=0, timeout=timeout_seconds)


def _openai_client(ref: ModelRef, api_key: str, timeout_seconds: float) -> Any:
    openai = _import_sdk("openai")
    base_url = ref.endpoint or (DEFAULT_FIREWORKS_BASE_URL if ref.provider == "fireworks" else None)
    return openai.OpenAI(api_key=api_key, base_url=base_url, max_retries=0, timeout=timeout_seconds)


def _azure_client(ref: ModelRef, api_key: str, timeout_seconds: float) -> Any:
    openai = _import_sdk("openai")
    return openai.AzureOpenAI(
        azure_endpoint=ref.endpoint,
        api_key=api_key,
        api_version=ref.api_version,
        max_retries=0,
        timeout=timeout_seconds,
    )


def _bedrock_client(ref: ModelRef, region: str, timeout_seconds: float) -> Any:
    boto3 = _import_sdk("boto3")
    botocore_config = _import_sdk("botocore.config")
    # total_max_attempts counts the first request (botocore's legacy "max_attempts" counts
    # RETRIES, so {"max_attempts": 1} would allow a hidden second attempt).
    client_config = botocore_config.Config(
        retries={"total_max_attempts": 1, "mode": "standard"},
        connect_timeout=min(10.0, timeout_seconds),
        read_timeout=timeout_seconds,
    )
    return boto3.client("bedrock-runtime", region_name=region, config=client_config)


CLIENT_FACTORIES: dict[str, Callable[..., Any]] = {
    "anthropic": _anthropic_client,
    "openai": _openai_client,
    "fireworks": _openai_client,
    "foundry": _azure_client,
    "bedrock": _bedrock_client,
}


def _missing_sdk(request: ModelRequest, ref: ModelRef, exc: ImportError) -> Attempt:
    return _failure(request, ref, "invalid_config", f"provider SDK not installed ({exc.name or exc})", retryable=False)


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------


class AnthropicAdapter(BaseAdapter):
    """``anthropic`` SDK Messages API (client ``max_retries=0``).  Structured output: the
    compact schema as the ``input_schema`` of tool ``submit_decision`` (purpose "decision";
    ``submit_response`` for every other purpose, see ``structured_output_names``), forced
    with ``tool_choice={"type": "tool"}`` when ``supports_json_schema`` (set
    ``ref.options["tool_choice"] = "auto"`` for models that reject forced tool use; the
    system prompt then names the tool); otherwise the JSON-only instruction + extraction.
    ``text = json.dumps(tool input)``.  Usage from ``response.usage`` (input_tokens is the
    uncached part; billed input = input + cache read + cache creation); ``response_model =
    response.model``; stop_reason ``refusal`` -> refusal, ``max_tokens`` -> truncated."""

    def build_kwargs(self, ref: ModelRef, request: ModelRequest) -> dict[str, Any]:
        system, chat = _split_messages(request, ref)
        kwargs: dict[str, Any] = {
            "model": ref.model_id,
            "max_tokens": request.max_output_tokens,
            "messages": [{"role": role, "content": content} for role, content in chat],
        }
        temperature = _temperature(ref, request)
        if temperature is not None:
            kwargs["temperature"] = temperature
        tool_name, tool_description, _schema_name = structured_output_names(request.purpose)
        if _text_mode(request):
            pass  # rev 4 text mode: no tool, no JSON-only instruction
        elif _sends_native_schema(ref, request.response_schema):
            assert request.response_schema is not None
            kwargs["tools"] = [
                {
                    "name": tool_name,
                    "description": tool_description,
                    "input_schema": compact_schema(request.response_schema),
                }
            ]
            if ref.options.get("tool_choice") == "auto":
                kwargs["tool_choice"] = {"type": "auto"}
                system = f"{system}\n\nSubmit your {'decision' if request.purpose == 'decision' else 'reply'} by calling the {tool_name} tool exactly once.".strip()
            else:
                kwargs["tool_choice"] = {"type": "tool", "name": tool_name}
        else:
            system = f"{system}\n\n{_json_instruction(ref, request.response_schema)}".strip()
        if system:
            kwargs["system"] = system
        return kwargs

    def parse_response(self, ref: ModelRef, request: ModelRequest, response: Any) -> ModelResult:
        tool_name = structured_output_names(request.purpose)[0]
        tool_input: Any = None
        texts: list[str] = []
        for block in _field(response, "content") or []:
            kind = _field(block, "type")
            if kind == "tool_use" and _field(block, "name") == tool_name and tool_input is None:
                tool_input = _field(block, "input")
            elif kind == "text":
                texts.append(_field(block, "text") or "")
        if tool_input is not None and not _text_mode(request):
            text: Optional[str] = json.dumps(tool_input)
            native = tool_input if isinstance(tool_input, dict) else None
        else:
            text = "".join(texts) or None
            native = None
        stop = _field(response, "stop_reason")
        status, parsed = _classify(request, native, text, refused=stop == "refusal", truncated=stop == "max_tokens")
        usage = usage_from_anthropic(_field(response, "usage")) or estimate_usage(
            request, text, extra_input_tokens=_request_overhead(ref, request)
        )
        return _make_result(
            request, ref, status, text=text, parsed=parsed, usage=usage,
            response_model=_field(response, "model"), stop_reason=stop,
        )

    def attempt(self, ref: ModelRef, request: ModelRequest, attempt_no: int, *, cancel: Optional[threading.Event] = None) -> Attempt:
        key_name = _api_key_name(ref, "ANTHROPIC_API_KEY")
        api_key = _env_value(key_name)
        if api_key is None:
            return _failure(request, ref, "invalid_config", f"missing credential {key_name}", retryable=False)
        try:
            client = CLIENT_FACTORIES["anthropic"](ref, api_key, request.timeout_seconds)
        except ImportError as exc:
            return _missing_sdk(request, ref, exc)
        except Exception as exc:  # noqa: BLE001 - classified, never raised
            return _attempt_from_exception(request, ref, exc)
        try:
            response = client.messages.create(**self.build_kwargs(ref, request))
        except Exception as exc:  # noqa: BLE001
            return _attempt_from_exception(request, ref, exc)
        return Attempt(self.parse_response(ref, request, response))


# ---------------------------------------------------------------------------
# OpenAI family (openai, fireworks, foundry)
# ---------------------------------------------------------------------------


class OpenAIAdapter(BaseAdapter):
    """``openai`` SDK chat completions (client ``max_retries=0``); also serves provider
    "fireworks" (``ref.endpoint`` or DEFAULT_FIREWORKS_BASE_URL as ``base_url``).
    ``response_format``: ``json_schema`` with ``openai_strict_schema`` when
    ``supports_json_schema`` (``strict`` true only when ``ref.options["strict_schema"]``
    is true), else ``json_object`` when ``supports_json_mode``, else none; without a native
    schema the JSON-only instruction is appended to the system message.  Replies are
    decoded with ``extract_json_object`` and passed through ``strip_transform_nulls``.
    ``ref.options["param_style"]``: "chat" (default: max_tokens + temperature) |
    "reasoning" (max_completion_tokens, no temperature).  Usage: input = prompt_tokens -
    cached_tokens, cache_read = cached_tokens, output = completion_tokens (reasoning_tokens
    informational only).  ``ref.options["reasoning_effort"]`` is sent as ``reasoning_effort``;
    ``ref.options["usd_per_mtok"]`` prices the reported usage (``list_price_cost``).
    finish_reason "length" -> truncated; "content_filter" or a ``message.refusal`` -> refusal."""

    default_key_env = "OPENAI_API_KEY"

    def model_param(self, ref: ModelRef) -> str:
        return ref.model_id

    def build_kwargs(self, ref: ModelRef, request: ModelRequest) -> dict[str, Any]:
        system, chat = _split_messages(request, ref)
        text_mode = _text_mode(request)
        native = not text_mode and _sends_native_schema(ref, request.response_schema)
        if not native and not text_mode:
            system = f"{system}\n\n{_json_instruction(ref, request.response_schema)}".strip()
        messages = ([{"role": "system", "content": system}] if system else []) + [
            {"role": role, "content": content} for role, content in chat
        ]
        kwargs: dict[str, Any] = {"model": self.model_param(ref), "messages": messages}
        if ref.options.get("param_style") == "reasoning":
            kwargs["max_completion_tokens"] = request.max_output_tokens
        else:
            kwargs["max_tokens"] = request.max_output_tokens
        temperature = _temperature(ref, request)
        if temperature is not None:
            kwargs["temperature"] = temperature
        effort = ref.options.get("reasoning_effort")
        if isinstance(effort, str) and effort:
            kwargs["reasoning_effort"] = effort
        if native:
            assert request.response_schema is not None
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": structured_output_names(request.purpose)[2],
                    "schema": openai_strict_schema(request.response_schema),
                    "strict": ref.options.get("strict_schema") is True,
                },
            }
        elif ref.capabilities.supports_json_mode and not text_mode:
            kwargs["response_format"] = {"type": "json_object"}
        return kwargs

    def parse_response(self, ref: ModelRef, request: ModelRequest, response: Any) -> ModelResult:
        choices = _field(response, "choices") or []
        choice = choices[0] if choices else None
        message = _field(choice, "message")
        content = _field(message, "content")
        refusal = _field(message, "refusal")
        finish = _field(choice, "finish_reason")
        text = content if isinstance(content, str) else None
        refused = bool(refusal) or finish == "content_filter"
        if refused and not text and isinstance(refusal, str):
            text = refusal
        status, parsed = _classify(request, None, text, refused=refused, truncated=finish == "length")
        if parsed is not None and request.response_schema:
            parsed = strip_transform_nulls(parsed, request.response_schema)
        reported = usage_from_openai(_field(response, "usage"))
        usage = reported or estimate_usage(request, text, extra_input_tokens=_request_overhead(ref, request))
        return _make_result(
            request, ref, status, text=text, parsed=parsed, usage=usage,
            response_model=_field(response, "model"), stop_reason=finish,
            provider_cost_usd=list_price_cost(ref, reported),
        )

    def prepare(self, ref: ModelRef, request: ModelRequest) -> tuple[Optional[ModelRef], Optional[Attempt]]:
        """Hook for subclasses: the effective ref, or a configuration failure."""
        return ref, None

    def attempt(self, ref: ModelRef, request: ModelRequest, attempt_no: int, *, cancel: Optional[threading.Event] = None) -> Attempt:
        effective, problem = self.prepare(ref, request)
        if problem is not None or effective is None:
            return problem or _failure(request, ref, "invalid_config", "invalid configuration", retryable=False)
        key_name = _api_key_name(effective, self.default_key_env)
        api_key = _env_value(key_name)
        if api_key is None:
            return _failure(request, ref, "invalid_config", f"missing credential {key_name}", retryable=False)
        try:
            client = CLIENT_FACTORIES[effective.provider](effective, api_key, request.timeout_seconds)
        except ImportError as exc:
            return _missing_sdk(request, ref, exc)
        except Exception as exc:  # noqa: BLE001
            return _attempt_from_exception(request, ref, exc)
        try:
            response = client.chat.completions.create(**self.build_kwargs(effective, request))
        except Exception as exc:  # noqa: BLE001
            return _attempt_from_exception(request, ref, exc)
        return Attempt(self.parse_response(ref, request, response))


class FireworksAdapter(OpenAIAdapter):
    """Fireworks OpenAI-compatible endpoint (``https://api.fireworks.ai/inference/v1``
    unless ``ref.endpoint`` is set) through the openai SDK; key from FIREWORKS_API_KEY
    (or the entry's ``*KEY*`` credential_env name)."""

    default_key_env = "FIREWORKS_API_KEY"


class FoundryAdapter(OpenAIAdapter):
    """Azure / Microsoft AI Foundry via ``openai.AzureOpenAI`` (endpoint = ``ref.endpoint``
    or AZURE_OPENAI_ENDPOINT; ``api_version`` from ``ref.api_version`` or
    AZURE_OPENAI_API_VERSION; deployment = ``ref.deployment`` or ``ref.model_id``, sent as
    the ``model`` parameter).  Scope: Azure OpenAI deployments only (other Foundry model
    types need their own ref options).  Same schema transform and usage mapping as
    OpenAIAdapter.  Missing/unresolved endpoint, version or deployment -> invalid_config."""

    default_key_env = "AZURE_OPENAI_API_KEY"

    def model_param(self, ref: ModelRef) -> str:
        return ref.deployment or ref.model_id

    def prepare(self, ref: ModelRef, request: ModelRequest) -> tuple[Optional[ModelRef], Optional[Attempt]]:
        def pick(configured: Optional[str], env_name: str) -> Optional[str]:
            if configured and not _PLACEHOLDER.search(configured):
                return configured
            return _env_value(env_name)

        endpoint = pick(ref.endpoint, "AZURE_OPENAI_ENDPOINT")
        api_version = pick(ref.api_version, "AZURE_OPENAI_API_VERSION")
        deployment = ref.deployment if ref.deployment and not _PLACEHOLDER.search(ref.deployment) else None
        if ref.deployment and deployment is None:
            deployment = _env_value("AZURE_OPENAI_DEPLOYMENT")
        missing = [
            name
            for name, value in (
                ("AZURE_OPENAI_ENDPOINT", endpoint),
                ("AZURE_OPENAI_API_VERSION", api_version),
                ("AZURE_OPENAI_DEPLOYMENT", deployment if ref.deployment else ref.model_id),
            )
            if not value
        ]
        if missing:
            return None, _failure(
                request, ref, "invalid_config", f"foundry route needs {', '.join(missing)}", retryable=False
            )
        effective = ref.model_copy(update={"endpoint": endpoint, "api_version": api_version, "deployment": deployment})
        return effective, None


# ---------------------------------------------------------------------------
# Bedrock
# ---------------------------------------------------------------------------


class BedrockAdapter(BaseAdapter):
    """boto3 ``bedrock-runtime`` ``converse`` with ``Config(retries={"total_max_attempts": 1},
    connect_timeout, read_timeout)`` (exactly one HTTP attempt); region: AWS_REGION when set, else ``ref.region``
    (none -> invalid_config); an empty ``credential_env`` uses the default credential
    chain (profiles, roles, session tokens; NoCredentialsError -> invalid_config).  JSON
    via the JSON-only system instruction + extraction (converse has no schema mode for
    every model; a route declaring ``supports_json_schema`` gets the compact schema in
    that instruction).  Usage: inputTokens, cacheReadInputTokens, cacheWriteInputTokens,
    outputTokens.  stopReason ``max_tokens`` -> truncated, ``guardrail_intervened`` /
    ``content_filtered`` -> refusal.  ``response_model`` = the configured id."""

    def region_for(self, ref: ModelRef) -> Optional[str]:
        configured = ref.region if ref.region and not _PLACEHOLDER.search(ref.region) else None
        return _env_value("AWS_REGION") or configured

    def build_kwargs(self, ref: ModelRef, request: ModelRequest) -> dict[str, Any]:
        system, chat = _split_messages(request, ref)
        if not _text_mode(request):
            system = f"{system}\n\n{_json_instruction(ref, request.response_schema)}".strip()
        inference: dict[str, Any] = {"maxTokens": request.max_output_tokens}
        temperature = _temperature(ref, request)
        if temperature is not None:
            inference["temperature"] = temperature
        kwargs: dict[str, Any] = {
            "modelId": ref.model_id,
            "messages": [{"role": role, "content": [{"text": content}]} for role, content in chat],
            "inferenceConfig": inference,
        }
        if system:
            kwargs["system"] = [{"text": system}]
        return kwargs

    def parse_response(self, ref: ModelRef, request: ModelRequest, response: Any) -> ModelResult:
        message = _field(_field(response, "output"), "message")
        texts = [_field(block, "text") for block in (_field(message, "content") or [])]
        text = "".join(t for t in texts if isinstance(t, str)) or None
        stop = _field(response, "stopReason")
        status, parsed = _classify(
            request, None, text, refused=stop in ("guardrail_intervened", "content_filtered"), truncated=stop == "max_tokens"
        )
        usage = usage_from_bedrock(_field(response, "usage")) or estimate_usage(
            request, text, extra_input_tokens=_request_overhead(ref, request)
        )
        return _make_result(
            request, ref, status, text=text, parsed=parsed, usage=usage, response_model=ref.model_id, stop_reason=stop
        )

    def attempt(self, ref: ModelRef, request: ModelRequest, attempt_no: int, *, cancel: Optional[threading.Event] = None) -> Attempt:
        region = self.region_for(ref)
        if not region:
            return _failure(request, ref, "invalid_config", "no AWS region (set the entry's region or AWS_REGION)", retryable=False)
        missing = [name for name in ref.credential_env if _env_value(name) is None]
        if missing:
            return _failure(request, ref, "invalid_config", f"missing credential {', '.join(missing)}", retryable=False)
        try:
            client = CLIENT_FACTORIES["bedrock"](ref, region, request.timeout_seconds)
        except ImportError as exc:
            return _missing_sdk(request, ref, exc)
        except Exception as exc:  # noqa: BLE001
            return _attempt_from_exception(request, ref, exc)
        try:
            response = client.converse(**self.build_kwargs(ref, request))
        except Exception as exc:  # noqa: BLE001
            return _attempt_from_exception(request, ref, exc)
        return Attempt(self.parse_response(ref, request, response))


# ---------------------------------------------------------------------------
# Claude Code CLI (hardened subprocess)
# ---------------------------------------------------------------------------


# Claude Code's own cap on generated tokens per request; set by the adapter (never inherited)
# to the request's generation allowance so a reply cannot exceed the packet reservation.
CLI_MAX_OUTPUT_TOKENS_ENV = "CLAUDE_CODE_MAX_OUTPUT_TOKENS"


def cli_environment(max_output_tokens: Optional[int] = None, max_thinking_tokens: Optional[int] = None) -> dict[str, str]:
    """The CLI's environment: only ``config.CLAUDE_CLI_ENV_ALLOWLIST`` names that are set,
    minus every known credential env name and every ``EMPYREAN_*`` variable (so no API
    key from .env reaches it and ``CLAUDECODE`` is never inherited), plus
    CLI_MAX_OUTPUT_TOKENS_ENV = ``max_output_tokens`` and CLI_MAX_THINKING_TOKENS_ENV =
    ``max_thinking_tokens`` when given (0 turns extended thinking off)."""
    blocked = set(DEFAULT_SECRET_ENV_NAMES) | _KNOWN_CREDENTIAL_NAMES
    env: dict[str, str] = {}
    for name in config.CLAUDE_CLI_ENV_ALLOWLIST:
        if name in blocked or name.startswith("EMPYREAN_"):
            continue
        value = os.environ.get(name)
        if value is not None:
            env[name] = value
    if max_output_tokens is not None:
        env[CLI_MAX_OUTPUT_TOKENS_ENV] = str(max_output_tokens)
    if max_thinking_tokens is not None:
        env[CLI_MAX_THINKING_TOKENS_ENV] = str(max(0, max_thinking_tokens))
    return env


def _kill_process_group(proc: Any) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass


# rev 4: every live CLI subprocess started by ClaudeCliAdapter, keyed by id(proc), so
# ``kill_inflight`` (API lifespan shutdown, atexit) can kill their process groups and no
# orphaned ``claude`` keeps running (and billing) after the server stops.
_INFLIGHT_LOCK = threading.Lock()
_INFLIGHT: dict[int, Any] = {}
_KILLED_INFLIGHT: set[int] = set()  # ids killed by kill_inflight (reported as cancelled)


def _register_inflight(proc: Any) -> None:
    with _INFLIGHT_LOCK:
        _INFLIGHT[id(proc)] = proc


def _unregister_inflight(proc: Any) -> bool:
    """Forget ``proc``; True when ``kill_inflight`` killed it meanwhile."""
    with _INFLIGHT_LOCK:
        _INFLIGHT.pop(id(proc), None)
        killed = id(proc) in _KILLED_INFLIGHT
        _KILLED_INFLIGHT.discard(id(proc))
        return killed


def inflight_count() -> int:
    """Number of CLI subprocesses currently running (diagnostics and tests)."""
    with _INFLIGHT_LOCK:
        return len(_INFLIGHT)


def kill_inflight() -> int:
    """Kill every live CLI process group started by ``ClaudeCliAdapter`` (called from the API
    lifespan and at interpreter exit so no orphaned ``claude`` subprocess keeps billing).  The
    interrupted calls return status ``error`` with error_code ``cancelled`` and are not retried.
    Returns the number of processes signalled.  Never raises."""
    try:
        with _INFLIGHT_LOCK:
            procs = list(_INFLIGHT.items())
            _KILLED_INFLIGHT.update(key for key, _proc in procs)
        for _key, proc in procs:
            _kill_process_group(proc)
        if procs:
            logger.info("killed %d in-flight CLI process group(s)", len(procs))
        return len(procs)
    except Exception:  # noqa: BLE001 - shutdown helper never raises
        return 0


atexit.register(kill_inflight)


class _CliTranscript:
    """What the claude CLI stream-json events exposed besides the final envelope."""

    def __init__(self) -> None:
        self.tool_inputs: list[Any] = []  # StructuredOutput inputs, in order (last = final attempt)
        self.tool_results: list[str] = []  # validator messages, in order
        self.prose: str = ""  # assistant text blocks, joined (capped)


def _read_cli_stream(stdout: str) -> tuple[Any, _CliTranscript]:
    """Parse ``--output-format stream-json`` output (one JSON event per line): return the final
    ``result`` event (the same envelope ``--output-format json`` prints) and the transcript of
    assistant ``tool_use`` inputs, assistant text and ``tool_result`` verdicts.  A plain
    single-envelope stdout (old format, tests) is accepted unchanged."""
    transcript = _CliTranscript()
    envelope: Any = None
    prose_parts: list[str] = []
    for line in stdout.strip().splitlines():
        event = _decode_whole(line.strip())
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "result":
            envelope = event
            continue
        message = event.get("message") if isinstance(event.get("message"), dict) else None
        content = message.get("content") if message else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if kind == "assistant" and block_type == "tool_use":
                transcript.tool_inputs.append(block.get("input"))
            elif kind == "assistant" and block_type == "text" and isinstance(block.get("text"), str):
                prose_parts.append(block["text"])
            elif kind == "user" and block_type == "tool_result":
                body = block.get("content")
                if isinstance(body, list):
                    body = " ".join(str(b.get("text", "")) if isinstance(b, dict) else str(b) for b in body)
                if body:
                    transcript.tool_results.append(str(body)[:config.ERROR_TEXT_MAX_CHARS])
    if envelope is None:
        whole = _decode_whole(stdout.strip())
        if isinstance(whole, dict):
            envelope = whole
    transcript.prose = "\n".join(prose_parts).strip()[:config.ERROR_TEXT_MAX_CHARS]
    return envelope, transcript


class ClaudeCliAdapter(BaseAdapter):
    """Hardened Claude Code CLI subprocess (a real-model path without an API key; still
    behind this boundary).  argv::

        claude -p --model <model_id> --output-format stream-json --verbose --max-turns 1 --tools ""
               --strict-mcp-config --setting-sources "" --no-session-persistence
               --disable-slash-commands --system-prompt <the packet's system message>
               [--json-schema <compact schema>] [--max-budget-usd <ref.options.max_budget_usd>]

    ``--max-turns`` is CLI_MAX_TURNS (1: one billed model request) or
    ``ref.options["max_turns"]``.  With ``--json-schema`` the system prompt is sent exactly as
    built by context (no delivery hint: see the note above CLI_MAX_MODEL_REQUESTS).  The user
    body goes on stdin (never argv).  cwd = a fresh empty temp dir (never the
    repo, so no CLAUDE.md or project settings load).  env = ``cli_environment()`` plus
    CLAUDE_CODE_MAX_OUTPUT_TOKENS = ``request.max_output_tokens`` and MAX_THINKING_TOKENS =
    ``max_thinking_tokens(ref)`` (CLI_MAX_THINKING_TOKENS, default 0 = no extended thinking:
    measured live, thinking took 40-70% of the output tokens, 668 of a 968-token reply under a
    1000-token allowance, so it competes with the notebook and skill text).  Never
    ``--bare`` (it forces API-key auth).  Own process group (``start_new_session``); a
    timeout kills the whole group.  Envelope parsing: ``structured_output`` (or JSON
    extracted from ``result``), ``usage`` (input_tokens, output_tokens,
    cache_read_input_tokens, cache_creation_input_tokens), ``total_cost_usd`` ->
    ``provider_cost_usd``, ``modelUsage`` keys -> ``response_model``.  ``is_error`` ->
    "error" (``api_error_status`` feeds the retry policy), except subtype
    ``error_max_turns`` after a schema-validated reply was attempted (the model answered
    but its structured output did not match within the allowed request) -> "malformed"
    (an agent-output failure, charged by the runner, never retried).  Model requests are
    counted from ``num_turns`` minus the StructuredOutput tool turn (``usage.iterations``
    lists only the LAST request, so it cannot count them): up to ``max_model_requests(ref)``
    (CLI_MAX_MODEL_REQUESTS = 2: the CLI's own re-prompt after a text-only first response)
    are accepted with a note in ``attempt_errors`` and the summed usage charged; more ->
    "error".  A live test asserts billed input <= 1.5 x the packet estimate (catches leaked
    CLAUDE.md or system-prompt text).

    rev 4: text mode (no ``--json-schema``, no JSON instruction, CLI_TEXT_SYSTEM_PROMPT
    fallback); any argv string over ``config.CLI_ARGV_MAX_BYTES`` -> invalid_config before the
    process starts; ``cancel`` polled every CLI_CANCEL_POLL_SECONDS (process group killed,
    error_code cancelled); every live process is registered for ``kill_inflight``; error codes
    budget_exceeded / not_logged_in / cli_missing / schema_mismatch / timeout are filled here."""

    @staticmethod
    def max_turns(ref: ModelRef) -> int:
        value = ref.options.get("max_turns")
        if isinstance(value, int) and not isinstance(value, bool) and value >= 1:
            return value
        return CLI_MAX_TURNS

    @staticmethod
    def max_model_requests(ref: ModelRef) -> int:
        value = ref.options.get("max_model_requests")
        if isinstance(value, int) and not isinstance(value, bool) and value >= 1:
            return value
        return max(1, CLI_MAX_MODEL_REQUESTS)

    @staticmethod
    def max_thinking_tokens(ref: ModelRef) -> Optional[int]:
        """The MAX_THINKING_TOKENS value for the subprocess; None = leave the CLI default."""
        if "max_thinking_tokens" in ref.options:
            value = ref.options["max_thinking_tokens"]
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                return value
            return None
        return CLI_MAX_THINKING_TOKENS

    def build_argv(self, ref: ModelRef, request: ModelRequest, executable: str) -> list[str]:
        """The CLI argv.  JSON mode: native ``--json-schema`` or the JSON-only instruction;
        text mode (rev 4): neither, and CLI_TEXT_SYSTEM_PROMPT when there is no system message."""
        system, _chat = _split_messages(request, ref)
        text_mode = _text_mode(request)
        native = not text_mode and _sends_native_schema(ref, request.response_schema)
        if not native and not text_mode:
            system = f"{system}\n\n{_json_instruction(ref, request.response_schema)}".strip()
        argv = [
            executable,
            "-p",
            "--model",
            ref.model_id,
            "--output-format",
            "stream-json",  # the final "result" event is the --output-format json envelope
            "--verbose",  # required by the CLI for stream-json in -p mode
            "--max-turns",
            str(self.max_turns(ref)),
            "--tools",
            "",
            "--strict-mcp-config",
            "--setting-sources",
            "",
            "--no-session-persistence",
            "--disable-slash-commands",
            "--system-prompt",
            system or (CLI_TEXT_SYSTEM_PROMPT if text_mode else CLI_DEFAULT_SYSTEM_PROMPT),
        ]
        if native:
            assert request.response_schema is not None
            argv += ["--json-schema", _compact_json(compact_schema(request.response_schema))]
        budget = ref.options.get("max_budget_usd")
        if isinstance(budget, (int, float)) and not isinstance(budget, bool) and budget > 0:
            argv += ["--max-budget-usd", str(budget)]
        return argv

    @staticmethod
    def prompt_body(request: ModelRequest, ref: Optional[ModelRef] = None) -> str:
        _system, chat = _split_messages(request, ref)
        if len(chat) == 1 and chat[0][0] == "user":
            return chat[0][1]
        return "\n\n".join(f"{role.upper()}:\n{content}" for role, content in chat)

    @staticmethod
    def oversized_argument(argv: list[str]) -> Optional[int]:
        """Byte length of the first argv string over ``config.CLI_ARGV_MAX_BYTES`` (Linux caps one
        argument at 128 KiB; the system prompt and the schema travel on argv), else None."""
        for part in argv:
            size = len(part.encode("utf-8", "replace"))
            if size > config.CLI_ARGV_MAX_BYTES:
                return size
        return None

    @staticmethod
    def _communicate(proc: Any, body: str, timeout_seconds: float, cancel: Optional[threading.Event]) -> tuple[Optional[tuple[str, str]], Optional[str]]:
        """Feed ``body`` on stdin and wait for the process.  Without ``cancel``: one
        ``communicate`` bounded by the attempt timeout.  With ``cancel``: ``communicate`` in
        CLI_CANCEL_POLL_SECONDS slices (the stdin write continues across slices), checking the
        event between slices.  Returns ((stdout, stderr), None) or (None, "timeout"|"cancelled")."""
        deadline = time.monotonic() + timeout_seconds
        started = False
        while True:
            remaining = max(0.0, deadline - time.monotonic())
            last_slice = cancel is None or remaining <= CLI_CANCEL_POLL_SECONDS
            try:
                output = proc.communicate(input=None if started else body, timeout=remaining if last_slice else CLI_CANCEL_POLL_SECONDS)
                return (output[0] or "", output[1] or ""), None
            except subprocess.TimeoutExpired:
                started = True
                if cancel is not None and cancel.is_set():
                    return None, "cancelled"
                if last_slice:
                    return None, "timeout"

    def attempt(self, ref: ModelRef, request: ModelRequest, attempt_no: int, *, cancel: Optional[threading.Event] = None) -> Attempt:
        executable = shutil.which(config.CLAUDE_CLI_EXECUTABLE)
        if executable is None:
            return _failure(
                request, ref, "invalid_config", f"{config.CLAUDE_CLI_EXECUTABLE} executable not found on PATH",
                retryable=False, error_code="cli_missing",
            )
        if cancel is not None and cancel.is_set():
            return _cancelled(request, ref, "cancel was set before the claude CLI started")
        argv = self.build_argv(ref, request, executable)
        oversized = self.oversized_argument(argv)
        if oversized is not None:
            return _failure(
                request, ref, "invalid_config",
                f"claude CLI argument of {oversized} bytes exceeds CLI_ARGV_MAX_BYTES ({config.CLI_ARGV_MAX_BYTES}); "
                "shorten the system prompt or schema",
                retryable=False,
            )
        schema_sent = "--json-schema" in argv
        with tempfile.TemporaryDirectory(prefix="empyrean_cli_") as workdir:
            if Path(workdir).resolve().is_relative_to(config.REPO_DIR.resolve()):
                return _failure(request, ref, "invalid_config", "temp dir is inside the repository", retryable=False)
            try:
                proc = subprocess.Popen(
                    argv,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=workdir,
                    env=cli_environment(request.max_output_tokens, self.max_thinking_tokens(ref)),
                    start_new_session=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
            except OSError as exc:
                return _failure(request, ref, "error", f"cannot start the CLI: {exc}", retryable=False)
            _register_inflight(proc)
            killed_at_shutdown = False
            try:
                output, stopped = self._communicate(proc, self.prompt_body(request), request.timeout_seconds, cancel)
                if stopped is not None:
                    _kill_process_group(proc)
                    try:
                        proc.communicate(timeout=CLI_KILL_GRACE_SECONDS)
                    except (subprocess.TimeoutExpired, OSError, ValueError):
                        pass
            finally:
                if proc.poll() is None:
                    _kill_process_group(proc)
                killed_at_shutdown = _unregister_inflight(proc)
        if stopped == "cancelled":
            return _cancelled(request, ref, "claude CLI process group killed")
        if killed_at_shutdown:
            return _cancelled(request, ref, "claude CLI process group killed at shutdown")
        if stopped == "timeout":
            return _failure(
                request, ref, "timeout", f"claude CLI exceeded {request.timeout_seconds} s; process group killed",
                retryable=True, error_code="timeout",
            )
        assert output is not None
        stdout, stderr = output
        return self.parse_output(ref, request, stdout, stderr, proc.returncode, schema_sent)

    def parse_output(
        self, ref: ModelRef, request: ModelRequest, stdout: str, stderr: str, returncode: Optional[int], schema_sent: bool
    ) -> Attempt:
        envelope, transcript = _read_cli_stream(stdout)
        if not isinstance(envelope, dict):
            excerpt = (stderr or stdout).strip()[-400:]
            return _failure(
                request, ref, "error", f"claude CLI exit {returncode}; no JSON envelope; stderr: {excerpt}", retryable=False,
                error_code="not_logged_in" if CLI_NOT_LOGGED_IN.search(stderr or stdout or "") else None,
            )
        usage_raw = envelope.get("usage")
        model_usage = envelope.get("modelUsage")
        response_model = ",".join(model_usage) if isinstance(model_usage, dict) and model_usage else None
        cost = envelope.get("total_cost_usd")
        cost = float(cost) if isinstance(cost, (int, float)) and not isinstance(cost, bool) else None
        result_text = envelope.get("result") if isinstance(envelope.get("result"), str) else None
        structured = envelope.get("structured_output")
        usage = usage_from_claude_cli(usage_raw if isinstance(usage_raw, dict) else None)
        if usage is None:
            usage = estimate_usage(request, result_text, extra_input_tokens=_request_overhead(ref, request))

        def error(
            message: str, http_status: Optional[int] = None, retryable: Optional[bool] = False, error_code: Optional[str] = None
        ) -> Attempt:
            # 401/403/404 and schema/param 400s are configuration errors (INTERFACES 4.4),
            # exactly as classify_exception maps them for the SDK adapters.
            status = "invalid_config" if http_status in CONFIG_HTTP_STATUSES else "error"
            result = _make_result(
                request, ref, status, text=result_text, usage=usage, response_model=response_model,
                provider_cost_usd=cost, error=message, stop_reason=envelope.get("stop_reason"),
                error_code=error_code or derive_error_code(status, http_status),
            )
            return Attempt(result, http_status=http_status, retryable=False if status == "invalid_config" else retryable)

        subtype = envelope.get("subtype")
        if subtype == "error_max_turns" and schema_sent and usage.output_tokens > 0:
            # The envelope's "result" is empty here; the stream carries what the model actually
            # sent (its StructuredOutput input) and the validator's verdict.  Store both so the
            # model call record shows the rejected payload, not an empty string.
            rejected = transcript.tool_inputs[-1] if transcript.tool_inputs else None
            text = json.dumps(rejected) if rejected is not None else (result_text or transcript.prose or None)
            verdict = transcript.tool_results[-1] if transcript.tool_results else None
            message = f"structured output did not match the {_schema_label(request.purpose)}"
            if verdict:
                message = f"{message}: {verdict}"
            result = _make_result(
                request, ref, "malformed", text=text, usage=usage, response_model=response_model,
                provider_cost_usd=cost, error=message, stop_reason=envelope.get("stop_reason"),
                error_code="schema_mismatch",
            )
            notes = [f"model prose before the structured reply: {transcript.prose}"] if transcript.prose else []
            return Attempt(result, notes=notes)
        if envelope.get("is_error") and CLI_OUTPUT_CAP.search(result_text or ""):
            # The reply ran past the CLI's output limit (a small generation allowance): an
            # agent-output failure like any other cut-off reply, not an infrastructure error.
            return Attempt(
                _make_result(
                    request, ref, "truncated", text=None, usage=usage, response_model=response_model,
                    provider_cost_usd=cost, error=f"claude CLI: {(result_text or '').strip()[:300]}", stop_reason="max_tokens",
                    error_code=derive_error_code("truncated", None, text_mode=_text_mode(request)),
                )
            )
        if envelope.get("is_error") or (subtype is not None and subtype != "success"):
            http_status = envelope.get("api_error_status")
            http_status = http_status if isinstance(http_status, int) and not isinstance(http_status, bool) else None
            detail = (result_text or "").strip()
            if subtype == "error_max_budget_usd":
                code: Optional[str] = "budget_exceeded"
            elif http_status == 401 or CLI_NOT_LOGGED_IN.search(detail):
                code = "not_logged_in"
            else:
                code = None
            return error(
                f"claude CLI error ({subtype}): {detail[:300]}",
                http_status=http_status,
                retryable=None if http_status is not None else False,
                error_code=code,
            )
        if returncode not in (0, None):
            code = "not_logged_in" if CLI_NOT_LOGGED_IN.search(stderr or "") else None
            return error(f"claude CLI exit {returncode}; stderr: {stderr.strip()[-300:]}", error_code=code)
        num_turns = envelope.get("num_turns")
        if isinstance(num_turns, int) and not isinstance(num_turns, bool):
            model_requests = num_turns - (1 if schema_sent else 0)
        else:
            model_requests = 1
        allowed = self.max_model_requests(ref)
        if model_requests > allowed:
            return error(f"claude CLI made {model_requests} model requests; at most {allowed} allowed")
        notes: list[str] = []
        if model_requests > 1:
            notes.append(
                f"claude CLI re-prompted the model: {model_requests} model requests billed for this reply "
                f"(usage and cost are the sum)"
            )
        stop = envelope.get("stop_reason")
        native = structured if isinstance(structured, dict) and not _text_mode(request) else None
        text = result_text if result_text is not None else (json.dumps(structured) if structured is not None else None)
        status, parsed = _classify(request, native, text, refused=stop == "refusal", truncated=stop == "max_tokens")
        return Attempt(
            _make_result(
                request, ref, status, text=text, parsed=parsed, usage=usage, response_model=response_model,
                provider_cost_usd=cost, stop_reason=stop,
                error_code=derive_error_code(status, None, text_mode=_text_mode(request)),
            ),
            notes=notes,
        )


# ---------------------------------------------------------------------------
# Adapter selection
# ---------------------------------------------------------------------------

ADAPTERS: dict[str, type[BaseAdapter]] = {
    "fake": FakeAdapter,
    "anthropic": AnthropicAdapter,
    "openai": OpenAIAdapter,
    "fireworks": FireworksAdapter,
    "foundry": FoundryAdapter,
    "bedrock": BedrockAdapter,
    "claude_cli": ClaudeCliAdapter,
}


def adapter_for(ref: ModelRef) -> BaseAdapter:
    """Map ``ref.provider`` to an adapter instance; ``ValueError`` for unknown providers."""
    adapter_class = ADAPTERS.get(ref.provider)
    if adapter_class is None:
        raise ValueError(f"unknown provider {ref.provider!r}")
    return adapter_class()


# ---------------------------------------------------------------------------
# The boundary
# ---------------------------------------------------------------------------


def _backoff_delay(retry_index: int, retry_after: Optional[float]) -> float:
    """Delay before retry ``retry_index`` (1-based): config.RETRY_BACKOFF_SECONDS (last value
    repeats), raised to a provider Retry-After capped at config.RETRY_AFTER_MAX_SECONDS."""
    schedule = config.RETRY_BACKOFF_SECONDS or [0.0]
    delay = float(schedule[min(retry_index - 1, len(schedule) - 1)])
    if retry_after is not None:
        delay = max(delay, min(retry_after, config.RETRY_AFTER_MAX_SECONDS))
    return delay


def _config_failure(
    request: ModelRequest,
    ref: Optional[ModelRef],
    message: str,
    started: float,
    registry: Optional[ModelRegistry],
    *,
    status: str = "invalid_config",
    error_code: Optional[str] = None,
) -> ModelResult:
    return ModelResult(
        request_id=request.request_id,
        ok=False,
        status=status,  # type: ignore[arg-type]
        provider=ref.provider if ref else "unknown",
        model_id=ref.model_id if ref else "",
        latency_ms=(time.monotonic() - started) * 1000.0,
        attempts=0,
        attempt_errors=[],
        error=redact(message, registry),
        error_code=error_code,  # type: ignore[arg-type]
    )


def sum_provider_cost(costs: Iterable[Optional[float]]) -> Optional[float]:
    """rev 4: the provider-reported cost of a call = the sum over the attempts that reported one
    (a failed CLI attempt is billed too); None when no attempt reported a cost."""
    reported = [float(c) for c in costs if c is not None]
    return sum(reported) if reported else None


def _log_call(result: ModelResult) -> None:
    logger.info(
        "model call provider=%s model=%s status=%s latency_ms=%.1f attempts=%d input=%d output=%d source=%s",
        result.provider,
        result.model_id,
        result.status,
        result.latency_ms,
        result.attempts,
        result.usage.billed_input_tokens,
        result.usage.output_tokens,
        result.usage.source,
    )


_DEFAULT_REGISTRY: Optional[ModelRegistry] = None


def default_registry() -> ModelRegistry:
    """The registry from ``load_registry()``, built on first use (for callers that do not
    hold one; the application passes its own)."""
    global _DEFAULT_REGISTRY
    if _DEFAULT_REGISTRY is None:
        _DEFAULT_REGISTRY = load_registry()
    return _DEFAULT_REGISTRY


def call_model(request: ModelRequest, registry: Optional[ModelRegistry] = None, *, cancel: Optional[threading.Event] = None) -> ModelResult:
    """Resolve ``request.model_key`` -> ``ModelRef`` -> adapter.  Never raises.
    ``registry`` defaults to ``default_registry()``.

    * unknown key / missing credentials / unknown provider / ``max_output_tokens`` outside
      ``1..capabilities.max_output_tokens`` -> ``status="invalid_config"`` (no attempt
      made, ``attempts == 0``; a claude_cli route whose executable is missing also carries
      ``error_code="cli_missing"``).
    * up to ``request.max_retries`` retries ONLY when retryable (``is_retryable`` or the
      adapter's explicit flag for connection errors), with backoff
      config.RETRY_BACKOFF_SECONDS honouring Retry-After up to RETRY_AFTER_MAX_SECONDS;
      never on agent-output statuses; never past the overall deadline ``timeout_seconds x
      (max_retries + 1)``.  ``timeout_seconds`` applies per attempt.
    * fills ``provider``/``model_id`` (configured)/``response_model``/``latency_ms``
      (total)/``attempts``/``attempt_errors`` (one redacted line per failed attempt),
      sums usage across attempts and returns.  ``request.metadata`` never reaches a real
      provider.
    * ``ok``: JSON mode -> ``status == "ok"`` and ``parsed`` is a dict; text mode
      (``request.response_format == "text"``, rev 4) -> ``status == "ok"`` and ``text`` is
      non-empty (``parsed`` is always None).
    * ``provider_cost_usd`` (rev 4) is the SUM over the attempts that reported a cost (a
      failed or retried CLI attempt is billed too); None when no attempt reported one.
    * ``error_code`` (rev 4): the final attempt's machine-readable failure class
      (budget_exceeded | rate_limited | schema_mismatch | cancelled | timeout | not_logged_in |
      cli_missing), None when ok or unclassified.
    * ``cancel`` (rev 4, keyword-only ``threading.Event``): checked before every attempt and
      handed to the adapter; the CLI adapter polls it every CLI_CANCEL_POLL_SECONDS and kills
      its process group, the fake adapter's ``sleep_ms`` waits on it.  A cancelled call returns
      ``status="error"``, ``error_code="cancelled"`` and is never retried; its cost is
      unknown (None) unless an earlier attempt reported one.
    * decision salvage (A-COG-11): a ``purpose == "decision"`` reply that fails the format gate
      only because of its envelope (nested, wrapped, stringified, ``think`` for ``thought``) is
      repaired deterministically by ``salvage.salvage_decision`` (every provider, every model)
      and returned ``ok`` with ``salvaged_from`` set; no extra model call."""
    started = time.monotonic()
    try:
        if registry is None:
            registry = default_registry()
        result = _call_model(request, registry, started, cancel)
        if request.purpose == "decision":
            from .salvage import salvage_decision  # local: salvage builds on this module's format gate

            result = salvage_decision(request, result)
    except Exception as exc:  # noqa: BLE001 - the boundary never raises
        result = ModelResult(
            request_id=request.request_id,
            ok=False,
            status="error",
            provider="unknown",
            model_id="",
            latency_ms=(time.monotonic() - started) * 1000.0,
            attempts=0,
            error=redact(f"model boundary failure: {type(exc).__name__}: {exc}", registry),
        )
    _log_call(result)
    return result


def _call_model(request: ModelRequest, registry: ModelRegistry, started: float, cancel: Optional[threading.Event] = None) -> ModelResult:
    try:
        public_ref = registry.get(request.model_key)
    except UnknownModelError:
        return _config_failure(request, None, f"unknown model key '{request.model_key}'", started, registry)
    missing = registry.missing_requirements(request.model_key)
    if missing:
        message = f"model '{request.model_key}' is not available: missing {', '.join(missing)}"
        cli_missing = public_ref.provider == "claude_cli" and shutil.which(config.CLAUDE_CLI_EXECUTABLE) is None
        return _config_failure(
            request, public_ref, message, started, registry, error_code="cli_missing" if cli_missing else None
        )
    ref = registry.resolved(request.model_key)
    limit = ref.capabilities.max_output_tokens
    if not 1 <= request.max_output_tokens <= limit:
        message = f"max_output_tokens {request.max_output_tokens} is outside 1..{limit} for '{ref.key}'"
        return _config_failure(request, public_ref, message, started, registry)
    try:
        adapter = adapter_for(ref)
    except ValueError as exc:
        return _config_failure(request, public_ref, str(exc), started, registry)

    max_retries = max(0, request.max_retries)
    deadline = started + request.timeout_seconds * (max_retries + 1)
    attempts: list[Attempt] = []
    attempt_errors: list[str] = []
    cancelled_between_attempts = False
    while True:
        attempt_no = len(attempts) + 1
        if cancel is not None and cancel.is_set():
            if not attempts:
                return _config_failure(
                    request, public_ref, "cancelled before the first attempt", started, registry,
                    status="error", error_code="cancelled",
                )
            cancelled_between_attempts = True
            break
        try:
            outcome = adapter.attempt(ref, request, attempt_no, cancel=cancel)
        except Exception as exc:  # noqa: BLE001 - an adapter bug is an infrastructure error
            outcome = _failure(request, ref, "error", f"adapter failure: {type(exc).__name__}: {exc}", retryable=False)
        attempts.append(outcome)
        for note in outcome.notes:
            attempt_errors.append(redact(f"attempt {attempt_no}: note: {note}", registry) or "")
        status = outcome.result.status
        if status in AGENT_OUTPUT_STATUSES:
            break
        line = f"attempt {attempt_no}: {status}: {outcome.result.error or 'no detail'}"
        attempt_errors.append(redact(line, registry) or "")
        retryable = outcome.retryable if outcome.retryable is not None else is_retryable(status, outcome.http_status)
        if not retryable or attempt_no > max_retries:
            break
        delay = _backoff_delay(attempt_no, outcome.retry_after)
        if time.monotonic() + delay >= deadline:
            break
        _sleep(delay)

    final_attempt = attempts[-1]
    final = final_attempt.result
    text_mode = _text_mode(request)
    status = final.status
    error = final.error
    error_code = final.error_code or derive_error_code(status, final_attempt.http_status, text_mode=text_mode)
    if cancelled_between_attempts:
        status, error_code = "error", "cancelled"
        error = f"cancelled before retry {len(attempts) + 1}; last attempt: {final.status}: {final.error or 'no detail'}"
    parsed = final.parsed if status == "ok" and isinstance(final.parsed, dict) and not text_mode else None
    ok = status == "ok" and (bool((final.text or "").strip()) if text_mode else parsed is not None)
    return final.model_copy(
        update={
            "request_id": request.request_id,
            "provider": public_ref.provider,
            "model_id": public_ref.model_id,
            "ok": ok,
            "status": status,
            "parsed": parsed,
            "usage": sum_usage(a.result.usage for a in attempts),
            "provider_cost_usd": sum_provider_cost(a.result.provider_cost_usd for a in attempts),
            "latency_ms": (time.monotonic() - started) * 1000.0,
            "attempts": len(attempts),
            "attempt_errors": attempt_errors,
            "error": redact(error, registry),
            "error_code": None if status == "ok" else error_code,
        }
    )


# ---------------------------------------------------------------------------
# rev 4: local speech recognition (faster-whisper) behind the model boundary.  faster_whisper
# (and through it ctranslate2 and av) is imported ONLY here and only lazily, through
# ``_import_sdk``; tests replace that hook with a fake module.  Decoding uses
# faster_whisper.decode_audio on the raw bytes (PyAV; no ffmpeg binary needed).
# ---------------------------------------------------------------------------

WHISPER_PACKAGE = "faster_whisper"
WHISPER_SAMPLE_RATE = 16000  # faster_whisper.decode_audio resamples to this
WHISPER_BEAM_SIZE = 5
WHISPER_VAD_FILTER = True
# EMPYREAN_WHISPER_MODEL values that switch speech recognition off (whisper_status "disabled").
WHISPER_OFF_VALUES = frozenset({"", "off", "none", "disabled", "0"})


class _WhisperState:
    """The process-wide Whisper model (one per process; loading takes ~16 s for
    large-v3-turbo on CPU).  ``state``: idle | loading | ready | failed."""

    def __init__(self) -> None:
        self.load_lock = threading.Lock()  # one load at a time
        self.run_lock = threading.Lock()  # one inference at a time (the speech executor has 1 worker)
        self.model: Any = None
        self.model_name: Optional[str] = None
        self.state = "idle"
        self.error: Optional[str] = None


_WHISPER_STATE = _WhisperState()


def _whisper_disabled() -> bool:
    return (config.WHISPER_MODEL or "").strip().lower() in WHISPER_OFF_VALUES


def _whisper_status(state: str, reason: Optional[str] = None) -> WhisperStatus:
    return WhisperStatus(
        status=state,  # type: ignore[arg-type]
        model=config.WHISPER_MODEL,
        device=config.WHISPER_DEVICE,
        compute_type=config.WHISPER_COMPUTE_TYPE,
        reason=reason,
    )


def whisper_model_cached(name: Optional[str] = None) -> bool:
    """True when faster-whisper is installed and the model ``name`` (default
    ``config.WHISPER_MODEL``) is already in the local Hugging Face cache, so loading it needs no
    download.  Used by tests (the ``whisper`` marker) and diagnostics.  Never raises."""
    try:
        if not _sdk_installed(WHISPER_PACKAGE):
            return False
        utils = _import_sdk(f"{WHISPER_PACKAGE}.utils")
        utils.download_model(name or config.WHISPER_MODEL, local_files_only=True)
        return True
    except Exception:  # noqa: BLE001 - absent cache, no package, offline hub: all "not cached"
        return False


def _ensure_whisper() -> _WhisperState:
    """Load ``config.WHISPER_MODEL`` once (device/compute type/threads from config) and return
    the state; a failed load is retried on the next call.  Never raises (a failure is recorded
    in ``state.error``)."""
    state = _WHISPER_STATE
    name = config.WHISPER_MODEL
    if state.state == "ready" and state.model_name == name:
        return state
    with state.load_lock:
        if state.state == "ready" and state.model_name == name:
            return state
        state.state, state.error = "loading", None
        started = time.monotonic()
        try:
            whisper = _import_sdk(WHISPER_PACKAGE)
            state.model = whisper.WhisperModel(
                name,
                device=config.WHISPER_DEVICE,
                compute_type=config.WHISPER_COMPUTE_TYPE,
                cpu_threads=config.WHISPER_CPU_THREADS,
            )
            state.model_name = name
            state.state = "ready"
            logger.info("whisper model=%s loaded in %.1f s", name, time.monotonic() - started)
        except ImportError as exc:
            state.model, state.state = None, "failed"
            state.error = f"faster-whisper is not installed ({exc.name or exc}); pip install faster-whisper"
        except Exception as exc:  # noqa: BLE001 - never raises; surfaced by whisper_status
            state.model, state.state = None, "failed"
            state.error = redact(f"could not load whisper model {name!r}: {type(exc).__name__}: {exc}")
            logger.warning("whisper model=%s failed to load: %s", name, type(exc).__name__)
    return state


def whisper_status() -> WhisperStatus:
    """Whether ``transcribe`` can serve.  Never raises.

    * ``ready``: the model is loaded.
    * ``loading``: a load (``preload_whisper`` or a first ``transcribe``) is in progress.
    * ``unavailable``: faster-whisper is not installed, or the last load failed (``reason``).
    * ``disabled``: EMPYREAN_WHISPER_MODEL is off, or the model is not loaded yet and no load
      was started (preload off); ``reason`` says which.  A ``transcribe`` call still loads it."""
    try:
        if _whisper_disabled():
            return _whisper_status("disabled", "speech recognition is switched off (EMPYREAN_WHISPER_MODEL)")
        state = _WHISPER_STATE
        if state.state == "ready" and state.model_name == config.WHISPER_MODEL:
            return _whisper_status("ready")
        if state.state == "loading":
            return _whisper_status("loading", "loading the whisper model")
        if state.state == "failed":
            return _whisper_status("unavailable", state.error or "the whisper model failed to load")
        if not _sdk_installed(WHISPER_PACKAGE):
            return _whisper_status("unavailable", "faster-whisper is not installed (pip install faster-whisper)")
        return _whisper_status(
            "disabled", "the whisper model is not loaded (preload off); the first transcription loads it"
        )
    except Exception as exc:  # noqa: BLE001
        return _whisper_status("unavailable", redact(f"whisper status failed: {type(exc).__name__}"))


def preload_whisper() -> None:
    """Load the Whisper model (``config.WHISPER_MODEL``, CPU int8) on the calling thread so the
    first ``transcribe`` does not pay the ~16 s cold start.  Called by ``main`` only (never by
    tests).  Never raises; a failure shows up in ``whisper_status().reason``."""
    try:
        if not _whisper_disabled():
            _ensure_whisper()
    except Exception:  # noqa: BLE001
        pass


def _whisper_language(language: Optional[str]) -> Optional[str]:
    """``"en"`` / ``"en-US"`` -> ``"en"``; None / "" / "auto" -> None (auto-detect)."""
    if not language:
        return None
    code = str(language).strip().lower().replace("_", "-").split("-", 1)[0]
    return None if code in ("", "auto") else code


def transcribe(audio: bytes, *, language: Optional[str] = None, initial_prompt: Optional[str] = None) -> TranscriptionResult:
    """Speech to text through the model boundary.  ``audio`` is the raw container bytes (webm/opus
    from MediaRecorder, wav, flac, ...), decoded with ``faster_whisper.decode_audio`` (PyAV) at
    16 kHz; ``language`` (e.g. "en"; None/"auto" detects) and ``initial_prompt`` (vocabulary
    hint: agent names, glossary, control labels) are passed to the model with ``vad_filter`` on
    and ``beam_size`` 5.  Loads the model on first use when it is not preloaded.

    Never raises.  ``status``: ``ok`` (``text`` may be empty when no speech was heard) |
    ``error`` (empty / oversized / undecodable / too long audio, unsupported language, inference
    failure; ``error`` says which, redacted) | ``unavailable`` (switched off, package missing,
    model failed to load).  Logs only sizes, durations and status, never the transcript."""
    started = time.monotonic()
    name = config.WHISPER_MODEL
    lang = _whisper_language(language)

    def result(status: str, *, text: str = "", error: Optional[str] = None, duration: Optional[float] = None,
               detected: Optional[str] = None) -> TranscriptionResult:
        logger.info(
            "transcribe model=%s status=%s audio_s=%s latency_ms=%.0f",
            name, status, "-" if duration is None else f"{duration:.1f}", (time.monotonic() - started) * 1000.0,
        )
        return TranscriptionResult(
            status=status,  # type: ignore[arg-type]
            text=text,
            language=detected or lang,
            duration_s=None if duration is None else round(duration, 3),
            model=name,
            error=redact(error),
        )

    try:
        if _whisper_disabled():
            return result("unavailable", error="speech recognition is switched off (EMPYREAN_WHISPER_MODEL)")
        if not isinstance(audio, (bytes, bytearray, memoryview)) or len(audio) == 0:
            return result("error", error="no audio received")
        if len(audio) > config.WHISPER_MAX_AUDIO_BYTES:
            return result("error", error=f"audio is {len(audio)} bytes; the limit is {config.WHISPER_MAX_AUDIO_BYTES}")
        state = _ensure_whisper()
        if state.model is None:
            return result("unavailable", error=state.error or "the whisper model is not loaded")
        whisper = _import_sdk(WHISPER_PACKAGE)
        try:
            samples = whisper.decode_audio(io.BytesIO(bytes(audio)), sampling_rate=WHISPER_SAMPLE_RATE)
        except Exception as exc:  # noqa: BLE001 - PyAV raises many error types
            return result("error", error=f"could not decode the audio: {type(exc).__name__}: {exc}")
        duration = len(samples) / float(WHISPER_SAMPLE_RATE)
        if duration <= 0:
            return result("error", error="the audio contains no samples", duration=0.0)
        if duration > config.WHISPER_MAX_SECONDS:
            return result(
                "error", error=f"audio is {duration:.0f} s long; the limit is {config.WHISPER_MAX_SECONDS} s", duration=duration
            )
        prompt = (initial_prompt or "").strip() or None
        with state.run_lock:
            segments, info = state.model.transcribe(
                samples,
                language=lang,
                initial_prompt=prompt,
                vad_filter=WHISPER_VAD_FILTER,
                beam_size=WHISPER_BEAM_SIZE,
            )
            # segments is a lazy generator: the decoding happens while iterating.
            text = " ".join(part for part in ((getattr(s, "text", "") or "").strip() for s in segments) if part)
        detected = getattr(info, "language", None)
        return result("ok", text=sanitize_text(text) or "", duration=duration, detected=detected if isinstance(detected, str) else None)
    except Exception as exc:  # noqa: BLE001 - the boundary never raises
        return result("error", error=f"transcription failed: {type(exc).__name__}: {exc}")
