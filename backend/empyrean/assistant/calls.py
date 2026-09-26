"""
The assistant's single way to call a model (rev 4): ``call_profile`` builds the ``ModelRequest``
for a profile (model key, output cap, timeout/retries, response_format), checks the budgets
(R1), calls ``model.call_model(request, registry, cancel=cancel)``, prices the call, appends the
ledger line and returns a ``ProfileCallResult``.  Deterministic salvage of malformed JSON and
the one repair step (A-AST-4): ``salvage`` here is the deterministic part, the engine re-calls
the model once with the validation error.  OWNER: WP2.
"""
# DOCS: every assistant model call goes through call_profile -> model.call_model; costs settle to
# provider_cost_usd or a list-price estimate; the system prompt must stay byte-stable and under
# config.ASSISTANT_SYSTEM_PROMPT_MAX_BYTES (asserted here).

from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Optional

from .. import config, model
from ..schemas import ModelMessage, ModelRequest, ModelResult
from .ledger import BudgetExceeded, estimate_cost_usd
from .models import GLOBAL_SCOPE, BudgetView, LedgerLine

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService


class PromptTooLarge(ValueError):
    """The byte-stable system prompt would exceed ``config.ASSISTANT_SYSTEM_PROMPT_MAX_BYTES``."""


@dataclass
class ProfileCallResult:
    """What a profile call returns.  ``ok`` mirrors ``result.ok`` for JSON mode and
    ``status == "ok"`` for text mode; ``parsed`` is the (salvaged) JSON object, ``text`` the
    reply text.  ``cost_usd`` is what the ledger recorded (``cost_estimated`` when priced from
    tokens)."""

    profile: str
    scope: str
    result: ModelResult
    line: LedgerLine
    cost_usd: float
    cost_estimated: bool
    text_mode: bool
    salvaged: bool = False
    parsed: Optional[dict[str, Any]] = None
    notes: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        if self.text_mode:
            return self.result.status == "ok" and bool((self.result.text or "").strip())
        return self.result.status == "ok" and isinstance(self.parsed, dict)

    @property
    def text(self) -> str:
        return self.result.text or ""

    @property
    def error(self) -> Optional[str]:
        return self.result.error

    @property
    def error_code(self) -> Optional[str]:
        return self.result.error_code


_MISSING = object()
_WRAPPER_KEYS = ("output", "result", "response", "step", "data", "json", "reply", "answer_step")


def _decode_json_string(value: Any) -> Any:
    """A str that decodes to a JSON object/array -> the decoded value; else ``_MISSING``."""
    if not isinstance(value, str):
        return _MISSING
    stripped = value.strip()
    if not stripped or stripped[0] not in "{[":
        return _MISSING
    try:
        decoded = json.loads(stripped)
    except ValueError:
        return _MISSING
    return decoded if isinstance(decoded, (dict, list)) else _MISSING


def _salvage_once(obj: dict[str, Any]) -> dict[str, Any]:
    """One pass of the deterministic repairs; returns the same object when nothing applied."""
    if len(obj) == 1:
        (key, value), = obj.items()
        decoded = _decode_json_string(value)
        if isinstance(decoded, dict):  # {"output": "<json>"}
            return decoded
        if isinstance(value, dict) and "kind" not in obj and ("kind" in value or key in _WRAPPER_KEYS):
            return dict(value)  # doubled nesting: {"step": {"kind": ...}}
    out: dict[str, Any] = {}
    changed = False
    for key, value in obj.items():
        decoded = _decode_json_string(value)
        if decoded is not _MISSING:  # json-decode a stringified field ("brief": "{...}")
            out[key] = decoded
            changed = True
        elif isinstance(value, dict) and value:
            inner = _salvage_once(value)
            out[key] = inner
            changed = changed or inner is not value
        else:
            out[key] = value
    return out if changed else obj


def salvage(parsed: Optional[dict[str, Any]], text: Optional[str]) -> tuple[Optional[dict[str, Any]], bool]:
    """Deterministic repair of common CLI envelope shapes BEFORE any re-call (A-AST-4):
    a JSON object recovered from prose, single-key string wrappers such as
    ``{"output": "<json>"}``, doubled nesting (``{"step": {"kind": ...}}``) and stringified
    fields (``"brief": "{...}"``, ``"calls": "[...]"``) at any depth.  Returns ``(object,
    changed)``; ``object`` is None when nothing decodes to a dict.  Schema-agnostic: the
    engine validates the result with the step adapters and repairs once more via the model."""
    changed = False
    obj: Any = parsed
    if obj is None and text:
        obj = model.extract_json_object(text)
        changed = obj is not None
    if not isinstance(obj, dict):
        return None, changed
    for _ in range(4):
        repaired = _salvage_once(obj)
        if repaired is obj:
            break
        obj = repaired
        changed = True
    return obj, changed


def request_settings(profile: str) -> tuple[float, int]:
    """(timeout_seconds per attempt, max_retries) from ``config.ASSISTANT_REQUEST_SETTINGS``."""
    return config.ASSISTANT_REQUEST_SETTINGS.get(profile, (config.MODEL_TIMEOUT_SECONDS, 0))


def output_cap(profile: str, *, batched: bool = False, chapter: bool = False) -> int:
    caps = config.ASSISTANT_OUTPUT_TOKENS
    if profile == "narrator":
        return caps["narrator_batched"] if batched else caps["narrator"]
    if profile == "author":
        return caps["chapter"] if chapter else caps["chat"]
    return caps.get(profile, caps["chat"])


def build_request(
    service: "AssistantService",
    profile: str,
    *,
    system: str,
    user: str,
    schema: Optional[dict[str, Any]],
    text_mode: bool,
    request_id: Optional[str] = None,
    max_output_tokens: Optional[int] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> ModelRequest:
    """The ``ModelRequest`` for a profile call.  One system message (byte-stable prefix) and one
    user message (volatile suffix); never a flattened multi-role transcript (R8)."""
    system_bytes = len(system.encode("utf-8"))
    if system_bytes > config.ASSISTANT_SYSTEM_PROMPT_MAX_BYTES:
        raise PromptTooLarge(f"system prompt is {system_bytes} bytes > {config.ASSISTANT_SYSTEM_PROMPT_MAX_BYTES}")
    if schema is not None and text_mode:
        raise ValueError("a schema and text mode are mutually exclusive")
    if schema is not None:
        schema_bytes = len(json.dumps(schema, separators=(",", ":"), sort_keys=True).encode("utf-8"))
        if schema_bytes > config.ASSISTANT_SCHEMA_MAX_BYTES:
            raise PromptTooLarge(f"schema is {schema_bytes} bytes > {config.ASSISTANT_SCHEMA_MAX_BYTES}")
    timeout, retries = request_settings(profile)
    return ModelRequest(
        request_id=request_id or f"as_{profile}_{uuid.uuid4().hex[:12]}_01",
        model_key=service.profile_model_key(profile),
        messages=[ModelMessage(role="system", content=system), ModelMessage(role="user", content=user)],
        response_schema=schema,
        response_format="text" if text_mode else "json",
        max_output_tokens=max_output_tokens or output_cap(profile),
        timeout_seconds=timeout,
        max_retries=retries,
        purpose="narrative" if profile in ("narrator", "author") else "assistant",
        metadata=dict(metadata or {}),
    )


def call_profile(
    service: "AssistantService",
    profile: str,
    *,
    system: str,
    user: str,
    schema: Optional[dict[str, Any]] = None,
    text_mode: bool = False,
    scope: str = GLOBAL_SCOPE,
    cancel: Optional[threading.Event] = None,
    budgets: Optional[list[BudgetView]] = None,
    request_id: Optional[str] = None,
    max_output_tokens: Optional[int] = None,
    metadata: Optional[dict[str, Any]] = None,
    job_id: Optional[str] = None,
    conversation_id: Optional[str] = None,
    story_id: Optional[str] = None,
    step: Optional[int] = None,
    batch_size: Optional[int] = None,
) -> ProfileCallResult:
    """One model call for ``profile`` in ``scope``.

    * ``budgets``: the applicable ``BudgetView`` list (message, scope, global ...); each is
      checked with ``spent + ASSISTANT_CALL_COST_ESTIMATE_USD`` and ``BudgetExceeded`` is
      raised BEFORE the call.  None = check nothing (callers that already checked).
    * ``schema`` XOR ``text_mode``; ``metadata`` reaches the fake adapter only
      (``fake_script`` / ``fake_script_index`` / ``fake_reply``).
    * Never raises for model failures (the result carries status/error/error_code); raises
      ``PromptTooLarge`` / ``ValueError`` for caller bugs and ``BudgetExceeded`` for budgets.
    * Always appends one ledger line (also for failures, so failed spend is visible)."""
    for view in budgets or []:
        service.ledger.check_budget(view)
    request = build_request(
        service,
        profile,
        system=system,
        user=user,
        schema=schema,
        text_mode=text_mode,
        request_id=request_id,
        max_output_tokens=max_output_tokens,
        metadata=metadata,
    )
    if cancel is not None and cancel.is_set():
        result = ModelResult(
            request_id=request.request_id,
            ok=False,
            status="error",
            provider="unknown",
            model_id="",
            attempts=0,
            error="cancelled before the call",
            error_code="cancelled",
        )
    else:
        result = model.call_model(request, service.registry, cancel=cancel)
    if result.provider_cost_usd is not None:
        cost, estimated = float(result.provider_cost_usd), False
    else:
        cost, estimated = estimate_cost_usd(result.usage, result.response_model), True
    line = LedgerLine(
        request_id=request.request_id,
        scope=scope,
        profile=profile,
        purpose=request.purpose,
        model_key=request.model_key,
        response_model=result.response_model,
        status=result.status,
        error_code=result.error_code,
        usage=result.usage,
        cost_usd=cost,
        cost_estimated=estimated,
        latency_ms=result.latency_ms,
        attempts=result.attempts,
        job_id=job_id,
        conversation_id=conversation_id,
        story_id=story_id,
        step=step,
        batch_size=batch_size,
    )
    service.ledger.append(line)
    parsed, salvaged = (None, False) if text_mode else salvage(result.parsed, result.text if result.status in ("ok", "malformed") else None)
    return ProfileCallResult(
        profile=profile,
        scope=scope,
        result=result,
        line=line,
        cost_usd=cost,
        cost_estimated=estimated,
        text_mode=text_mode,
        salvaged=salvaged,
        parsed=parsed,
    )


__all__ = ["BudgetExceeded", "ProfileCallResult", "PromptTooLarge", "build_request", "call_profile", "output_cap", "request_settings", "salvage"]
