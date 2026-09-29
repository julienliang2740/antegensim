"""
Deterministic format salvage: repairs a structured reply whose JSON envelope is wrong but whose
content is right, without calling a model.  Provider- and model-agnostic: it works on the JSON a
reply decoded to, so the same repairs apply to every model and route.

Two users:
* agent decisions (A-COG-11): ``model.call_model`` passes every ``purpose == "decision"`` result
  through ``salvage_decision``; a reply the format gate rejects as given is repaired and accepted
  when the repaired object passes the gate;
* the assistant (A-AST-4): ``assistant.calls.salvage`` delegates to ``salvage_json`` before its
  one repair step.
"""
# DOCS: salvage only touches replies that fail validation as given; it never re-calls a model;
# a salvaged decision records ModelResult.salvaged_from (the original problem) and counts as an ok
# call.  Repairs: nested/wrapped envelopes, stringified JSON, think -> thought (decisions only).

from __future__ import annotations

import json
from typing import Any, Optional

from . import model
from .schemas import ModelRequest, ModelResult

_MISSING = object()
WRAPPER_KEYS = ("output", "result", "response", "step", "data", "json", "reply", "answer_step")
MAX_PASSES = 4
# Decision fields a model sometimes renames; mapped back only when the real name is absent.
DECISION_KEY_ALIASES: dict[str, str] = {"think": "thought", "thoughts": "thought"}


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


def _salvage_once(obj: dict[str, Any], *, top: bool = True) -> dict[str, Any]:
    """One pass of the deterministic repairs; returns the same object when nothing applied.
    ``top``: the same-key unwrap applies only to the reply object itself, never inside it."""
    if len(obj) == 1:
        (key, value), = obj.items()
        decoded = _decode_json_string(value)
        if isinstance(decoded, dict):  # {"output": "<json>"}
            return decoded
        if isinstance(value, dict) and "kind" not in obj and ("kind" in value or key in WRAPPER_KEYS):
            return dict(value)  # doubled nesting: {"step": {"kind": ...}}
        if top and isinstance(value, dict) and key in value:
            return dict(value)  # wrapped under one of its own fields: {"action": {"action": ..., "thought": ...}}
    out: dict[str, Any] = {}
    changed = False
    for key, value in obj.items():
        decoded = _decode_json_string(value)
        if decoded is not _MISSING:  # json-decode a stringified field ("brief": "{...}")
            out[key] = decoded
            changed = True
        elif isinstance(value, dict) and value:
            inner = _salvage_once(value, top=False)
            out[key] = inner
            changed = changed or inner is not value
        else:
            out[key] = value
    return out if changed else obj


def salvage_json(parsed: Optional[dict[str, Any]], text: Optional[str]) -> tuple[Optional[dict[str, Any]], bool]:
    """Repair common structured-output envelope mistakes (A-AST-4, A-COG-11): a JSON object
    recovered from prose, single-key string wrappers such as ``{"output": "<json>"}``, doubled
    nesting (``{"step": {"kind": ...}}``), the whole reply wrapped under one of its own field
    names (``{"action": {"action": ..., "thought": ...}}``, top level only) and stringified fields
    (``"brief": "{...}"``, ``"calls": "[...]"``) at any depth.  Returns ``(object, changed)``;
    ``object`` is None when nothing decodes to a dict.  Schema-agnostic: callers validate the
    result, and should only use it for a reply that failed validation as given (a valid reply may
    legitimately hold JSON-looking strings)."""
    changed = False
    obj: Any = parsed
    if obj is None and text:
        obj = model.extract_json_object(text)
        changed = obj is not None
    if not isinstance(obj, dict):
        return None, changed
    for _ in range(MAX_PASSES):
        repaired = _salvage_once(obj)
        if repaired is obj:
            break
        obj = repaired
        changed = True
    return obj, changed


def salvage_decision(request: ModelRequest, result: ModelResult) -> ModelResult:
    """Agent-decision salvage (A-COG-11), for every model.  Only a reply that fails the format
    gate (``model.parse_decision``) as given is touched: status ``malformed``, or ``ok`` with a
    parsed object the gate rejects.  ``salvage_json`` runs over the parsed object (or the raw
    text), then the top-level ``DECISION_KEY_ALIASES``, then the OpenAI-family null strip.  When
    the repaired object passes the gate the result becomes ``ok`` with the repaired ``parsed`` and
    ``salvaged_from`` = the original problem; otherwise the result is returned unchanged.
    Text-mode requests and truncated, refused or infrastructure failures are never salvaged."""
    if request.response_format == "text" or result.status not in ("ok", "malformed"):
        return result
    decision, reason = model.parse_decision(result)
    if decision is not None:
        return result
    obj, _ = salvage_json(result.parsed, result.text)
    if obj is None:
        return result
    obj = {(DECISION_KEY_ALIASES[k] if k in DECISION_KEY_ALIASES and DECISION_KEY_ALIASES[k] not in obj else k): v
           for k, v in obj.items()}
    if request.response_schema:
        obj = model.strip_transform_nulls(obj, request.response_schema)
    if obj == result.parsed:
        return result
    candidate = result.model_copy(update={
        "status": "ok", "ok": True, "parsed": obj, "error": None, "error_code": None,
        "salvaged_from": (reason or "invalid decision")[: model.PARSE_REASON_MAX_CHARS],
    })
    if model.parse_decision(candidate)[0] is None:
        return result
    return candidate
