"""Deterministic format salvage (A-COG-11): envelope mistakes are repaired for every model, real
content errors are not, and nothing but a failing reply is ever touched."""

from __future__ import annotations

import json
from typing import Any

import pytest

from empyrean import model, salvage
from empyrean.schemas import ModelMessage, ModelRequest, ModelResult

GOOD = {"thought": "look around", "action": {"name": "observe", "args": {"point": {"x": 0, "y": 0}, "page": 0}}}


def request(**extra: Any) -> ModelRequest:
    return ModelRequest(
        request_id="mc_r00001_t01_a01_01",
        model_key="fake-scripted",
        messages=[ModelMessage(role="system", content="rules"), ModelMessage(role="user", content="decide")],
        max_output_tokens=500,
        timeout_seconds=5.0,
        max_retries=0,
        **extra,
    )


def result(status: str = "ok", parsed: Any = None, text: Any = None, provider: str = "claude_cli", error: Any = None) -> ModelResult:
    return ModelResult(request_id="mc_r00001_t01_a01_01", ok=status == "ok" and isinstance(parsed, dict), status=status,
                       text=text, parsed=parsed, provider=provider, model_id="m", error=error)


@pytest.mark.parametrize("provider", ["claude_cli", "openai", "anthropic", "bedrock", "fake"])
def test_nested_and_string_wrapped_decisions_are_salvaged_for_every_provider(provider: str) -> None:
    nested = {"action": {**GOOD, "notebook_update": "note"}}
    wrapped_text = json.dumps({"output": json.dumps(GOOD)})
    cases = [
        result("ok", parsed=nested, provider=provider),
        result("malformed", text=json.dumps(nested), provider=provider, error="structured output did not match the decision schema"),
        result("malformed", text=wrapped_text, provider=provider),
        result("ok", parsed={"value": json.dumps(GOOD)}, provider=provider),
        result("ok", parsed={"think": "look around", "action": GOOD["action"]}, provider=provider),
    ]
    for case in cases:
        fixed = salvage.salvage_decision(request(), case)
        assert fixed.status == "ok" and fixed.ok and fixed.error is None
        assert fixed.salvaged_from, "the original problem is recorded"
        decision, reason = model.parse_decision(fixed)
        assert reason is None and decision is not None and decision.action.name == "observe"
        assert decision.thought == "look around"


def test_valid_replies_and_real_errors_are_left_alone() -> None:
    valid = result("ok", parsed=GOOD)
    assert salvage.salvage_decision(request(), valid) is valid
    single_key = {"action": {"name": "wait", "args": {"rounds": 1}}}  # a legitimate one-key decision
    ok_single = result("ok", parsed=single_key)
    assert salvage.salvage_decision(request(), ok_single) is ok_single
    for bad in (
        result("ok", parsed={"action": {"name": "fly", "args": {}}}),  # unknown action: content, not envelope
        result("ok", parsed={"notebook_update": "only a note"}),  # no action anywhere
        result("malformed", text="I think I will go north. {not json"),
        result("truncated", text=json.dumps({"action": GOOD})),  # cut-off replies are never salvaged
        result("refusal", text="no"),
        result("error", text=json.dumps({"action": GOOD})),
    ):
        assert salvage.salvage_decision(request(), bad) is bad
    text_mode = result("ok", parsed={"action": GOOD})
    assert salvage.salvage_decision(request(response_format="text"), text_mode) is text_mode


def test_call_model_salvages_decisions_but_not_other_purposes() -> None:
    registry = model.load_registry()
    nested = {"action": {**GOOD}}
    meta = {"fake_script": [nested], "fake_script_index": 0, "fake_options": {}}
    fixed = model.call_model(request(metadata=meta), registry)
    assert fixed.ok and fixed.salvaged_from and model.parse_decision(fixed)[0] is not None
    wrapped = {"fake_script": [json.dumps({"output": json.dumps(GOOD)})], "fake_script_index": 0, "fake_options": {}}
    assert model.call_model(request(metadata=wrapped), registry).salvaged_from
    other = model.call_model(request(metadata=meta, purpose="summarize"), registry)
    assert other.salvaged_from is None and other.parsed == nested


def test_salvage_json_is_the_assistant_salvage() -> None:
    from empyrean.assistant import calls

    text = json.dumps({"output": json.dumps({"kind": "answer", "text": "hi"})})
    assert calls.salvage(None, text) == salvage.salvage_json(None, text) == ({"kind": "answer", "text": "hi"}, True)
