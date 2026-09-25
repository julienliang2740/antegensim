"""
End-to-end: module and provider boundaries (QA).

* U4 / U15 and spec "A single model boundary": no provider SDK is imported outside
  ``model.py``; callers never branch on providers.
* Completion criterion "stored playback requires no model calls": every history
  route serves recorded turns without touching a model adapter, also after the run
  is closed (history routes read from disk and work for any run).
* INTERFACES section 13: ``config.default_rules() == RulesConfig()``.
* Live (``@pytest.mark.live``, skipped unless EMPYREAN_LIVE_TESTS=1): the same
  decision flow runs through a real provider chosen by configuration alone, and the
  billed input stays within 1.5x the packet estimate.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from e2e_support import base_request

PACKAGE_DIR = Path(__file__).resolve().parent.parent / "empyrean"
PROVIDER_SDKS = ("anthropic", "openai", "boto3", "botocore", "httpx", "requests", "subprocess")
SDK_IMPORT = re.compile(r"^\s*(?:import|from)\s+(" + "|".join(PROVIDER_SDKS) + r")\b", re.MULTILINE)
LIVE_BILLING_RATIO_LIMIT = 1.5


def test_default_rules_equal_schema_defaults():
    """INTERFACES section 13: the config defaults and the schema defaults cannot drift."""
    from empyrean.config import default_rules
    from empyrean.schemas import RulesConfig

    assert default_rules() == RulesConfig()


def test_provider_sdks_are_imported_only_by_model_py():
    """U4/U15: 'all model calls should go through some sorta model.py'.  Provider SDKs
    and raw HTTP/subprocess clients appear only in model.py (storage may use subprocess
    for the git revision, which is not a model call)."""
    offenders = {}
    for path in sorted(PACKAGE_DIR.glob("*.py")):
        if path.name == "model.py":
            continue
        found = set(SDK_IMPORT.findall(path.read_text(encoding="utf-8")))
        if path.name == "storage.py":
            found.discard("subprocess")  # code_revision() runs git
        if found:
            offenders[path.name] = sorted(found)
    assert offenders == {}, f"provider/HTTP clients imported outside model.py: {offenders}"
    for path in sorted(PACKAGE_DIR.glob("*.py")):
        if path.name == "model.py":
            continue
        text = path.read_text(encoding="utf-8")
        for provider in ("anthropic", "openai", "fireworks", "bedrock", "foundry", "claude_cli"):
            assert not re.search(rf"provider\s*==\s*['\"]{provider}['\"]", text), f"{path.name} branches on provider {provider}"


def test_playback_reads_history_without_model_calls(api, monkeypatch):
    """Stored playback requires no model calls: after a run is recorded, every history
    route (turn views, events, knowledge, packets, call records) works with the model
    adapters disabled, before and after the run is closed."""
    from empyrean import model

    run_id = api.create_run(base_request(api, "e2e playback"))["run_id"]
    api.step_rounds(run_id, 2)

    def forbidden(*args, **kwargs):
        raise AssertionError("a model adapter was called during playback")

    monkeypatch.setattr(model.FakeAdapter, "attempt", forbidden)
    monkeypatch.setattr(model, "call_model", forbidden)

    def read_everything() -> int:
        reads = 0
        for row in api.turns(run_id):
            view = api.turn(run_id, row["turn_id"])
            api.turn_events(run_id, row["turn_id"])
            for agent_id in view["entities"]["agents"]:
                api.knowledge(run_id, row["turn_id"], agent_id)
            for packet_id in view["decision_packet_ids"]:
                api.packet(run_id, row["turn_id"], packet_id)
            for call in view["model_calls"]:
                api.model_call(run_id, row["turn_id"], call["call_id"])
            reads += 1
        return reads

    assert read_everything() == 19  # init + 2 x (8 agent turns + round end)
    api.close(run_id)
    assert read_everything() == 19
    summary = api.get(f"/runs/{run_id}")
    assert summary["current_turn_id"] == "r00002_end" and summary["status"] == "paused"
    assert api.get(f"/runs/{run_id}/assumptions")["entries"]


def _live_model_keys() -> list[str]:
    raw = os.environ.get("EMPYREAN_LIVE_MODELS", "claude-cli-haiku")
    return [key.strip() for key in raw.split(",") if key.strip()]


@pytest.mark.live
@pytest.mark.parametrize("model_key", _live_model_keys())
def test_live_provider_runs_the_same_decision_flow(api, registry, model_key):
    """Completion criterion 'The same decision flow works with each listed provider
    through configuration alone': one agent turn with a real provider (chosen only by
    the run's default model key), a validated decision, recorded usage, and billed input
    <= 1.5 x the packet estimate.  Set EMPYREAN_LIVE_TESTS=1 and optionally
    EMPYREAN_LIVE_MODELS=key1,key2 (registry keys with credentials configured)."""
    problem = registry.validate_key(model_key)
    if problem:
        pytest.skip(problem)
    request = base_request(api, f"e2e live {model_key}", default_model_key=model_key)
    run_id = api.create_run(request)["run_id"]
    api.command(run_id, "run_turn")
    status = api.wait_idle(run_id, timeout=600)
    assert status["state"] == "paused", status.get("last_error")
    view = api.turn(run_id, status["current_turn_id"])
    turn = view["turn"]
    assert turn["packet_id"] and turn["model_call_ids"]
    packet = api.packet(run_id, turn["turn_id"], turn["packet_id"])
    record = api.model_call(run_id, turn["turn_id"], turn["model_call_ids"][-1])
    assert record["model_key"] == model_key and record["provider"] == registry.get(model_key).provider
    assert record["result"]["status"] in ("ok", "malformed", "refusal", "truncated"), record["result"].get("error")
    usage = record["result"]["usage"]
    assert usage["billed_input_tokens"] > 0 and usage["output_tokens"] > 0
    ratio = usage["billed_input_tokens"] / packet["input_token_estimate"]
    assert ratio <= LIVE_BILLING_RATIO_LIMIT, f"billed {usage['billed_input_tokens']} vs estimate {packet['input_token_estimate']}"
    assert status["real_usage"]["calls"] >= 1
