"""Unit tests for empyrean.model (the only model boundary).

No test touches the network: real adapters get fake SDK clients through
``model.CLIENT_FACTORIES`` and the CLI adapter a fake ``subprocess.Popen``.  The
single ``@pytest.mark.live`` test runs only with EMPYREAN_LIVE_TESTS=1.
"""

from __future__ import annotations

import json
import os
import random
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

import pytest

from empyrean import config, model
from empyrean.model import (
    FORAGE_SKILL_NAME,
    FORAGE_SKILL_SOURCE,
    JSON_ONLY_INSTRUCTION,
    UnknownModelError,
    call_model,
    extract_json_object,
    fake_heuristic_decision,
    is_retryable,
    load_registry,
    parse_decision,
    redact,
    request_overhead_tokens,
)
from empyrean.schemas import (
    Decision,
    ModelCapabilities,
    ModelMessage,
    ModelRef,
    ModelRequest,
    ModelResult,
    Point,
    Situation,
    decision_json_schema,
)

SECRET_NAMES = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "FIREWORKS_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_DEPLOYMENT",
    "AZURE_OPENAI_API_VERSION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
)

VALID_DECISION = {"thought": "look", "action": {"name": "observe", "args": {"point": {"x": 0, "y": 0}, "page": 0}}}


# ---------------------------------------------------------------------------
# Helpers and fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def clean_env(monkeypatch):
    """No provider credentials in the environment (config may have loaded .env)."""
    for name in SECRET_NAMES:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


@pytest.fixture()
def delays(monkeypatch):
    """Record retry backoff delays instead of sleeping."""
    recorded: list[float] = []
    monkeypatch.setattr(model, "_sleep", recorded.append)
    return recorded


def make_situation(**overrides: Any) -> Situation:
    data: dict[str, Any] = {
        "agent_id": "a01",
        "name": "Aster",
        "round": 1,
        "turn_id": "r00001_t01_a01",
        "position": {"x": 0, "y": 0},
    }
    data.update(overrides)
    return Situation.model_validate(data)


def make_request(
    model_key: str = "fake-heuristic",
    *,
    situation: Optional[Situation] = None,
    round_no: int = 1,
    agent_id: str = "a01",
    turn_index: int = 1,
    call_no: int = 1,
    options: Optional[dict[str, Any]] = None,
    script: Optional[list[Any]] = None,
    script_index: int = 0,
    max_retries: int = 2,
    timeout: float = 5.0,
    schema: Optional[dict[str, Any]] = None,
    use_schema: bool = True,
    max_output_tokens: int = 500,
    temperature: Optional[float] = None,
) -> ModelRequest:
    turn_id = f"r{round_no:05d}_t{turn_index:02d}_{agent_id}"
    if situation is None:
        situation = make_situation(agent_id=agent_id, round=round_no, turn_id=turn_id)
    return ModelRequest(
        request_id=f"mc_{turn_id}_{call_no:02d}",
        model_key=model_key,
        messages=[
            ModelMessage(role="system", content="You are an agent in the Empyrean. Rules follow."),
            ModelMessage(role="user", content="Situation: round 1. Decide one action as JSON."),
        ],
        response_schema=(schema if schema is not None else decision_json_schema()) if use_schema else None,
        max_output_tokens=max_output_tokens,
        temperature=temperature,
        timeout_seconds=timeout,
        max_retries=max_retries,
        metadata={
            "agent_id": agent_id,
            "turn_id": turn_id,
            "round": round_no,
            "situation": situation.model_dump(mode="json"),
            "fake_script": script,
            "fake_script_index": script_index,
            "fake_options": options or {},
            "sentinel": "SENTINEL-METADATA-NEVER-FORWARDED",
        },
    )


def registry_with(*refs: dict[str, Any]) -> model.ModelRegistry:
    return model.ModelRegistry([ModelRef.model_validate(r) for r in refs])


def caps(schema: bool = True, json_mode: bool = True, max_out: int = 4000) -> dict[str, Any]:
    return {
        "supports_json_schema": schema,
        "supports_json_mode": json_mode,
        "context_window": 200000,
        "max_output_tokens": max_out,
        "reports_usage": True,
    }


def schema_keywords(node: Any, found: Optional[set[str]] = None) -> set[str]:
    """Every dict key anywhere in a schema (property names included)."""
    found = set() if found is None else found
    if isinstance(node, dict):
        for key, value in node.items():
            found.add(key)
            schema_keywords(value, found)
    elif isinstance(node, list):
        for item in node:
            schema_keywords(item, found)
    return found


# ---------------------------------------------------------------------------
# Registry and availability (no secret values anywhere)
# ---------------------------------------------------------------------------


def test_example_registry_loads_with_fakes_and_all_providers(clean_env):
    registry = load_registry(config.BACKEND_DIR / "empyrean" / "models.example.json")
    keys = registry.keys()
    assert keys[:3] == ["fake-heuristic", "fake-scripted", "fake-malformed"]
    providers = {registry.get(k).provider for k in keys}
    assert providers == {"fake", "anthropic", "openai", "fireworks", "bedrock", "foundry", "claude_cli"}
    for key in ("fake-heuristic", "fake-scripted", "fake-malformed"):
        info = registry.info(key)
        assert info.available and info.missing_credentials == []
    anthropic_info = registry.info("anthropic-haiku")
    assert not anthropic_info.available
    assert anthropic_info.missing_credentials == ["ANTHROPIC_API_KEY"]
    assert registry.validate_key("anthropic-haiku") == "model 'anthropic-haiku' is not available: missing ANTHROPIC_API_KEY"
    assert registry.validate_key("fake-heuristic") is None
    assert "ANTHROPIC_API_KEY" in registry.credential_env_names()


def test_info_reports_names_never_values(clean_env):
    secret = "sk-ant-test-THIS-IS-A-SECRET-0123456789"
    clean_env.setenv("ANTHROPIC_API_KEY", secret)
    registry = load_registry()
    info = registry.info("anthropic-haiku")
    assert info.available and info.missing_credentials == []
    dumped = json.dumps([i.model_dump(mode="json") for i in registry.list_info()])
    assert secret not in dumped
    clean_env.setenv("ANTHROPIC_API_KEY", "")  # empty placeholder line in .env counts as missing
    assert registry.info("anthropic-haiku").missing_credentials == ["ANTHROPIC_API_KEY"]


def test_models_file_env_override_and_placeholders(tmp_path, clean_env):
    path = tmp_path / "models.json"
    path.write_text(
        json.dumps(
            {
                "models": [
                    {
                        "key": "my-foundry",
                        "provider": "foundry",
                        "model_id": "gpt-x",
                        "credential_env": ["AZURE_OPENAI_API_KEY"],
                        "endpoint": "${EMPYREAN_TEST_ENDPOINT}",
                        "deployment": "${EMPYREAN_TEST_DEPLOYMENT}",
                        "api_version": "2024-10-21",
                        "capabilities": caps(),
                    }
                ]
            }
        )
    )
    clean_env.setenv("EMPYREAN_MODELS_FILE", str(path))
    clean_env.setenv("EMPYREAN_TEST_ENDPOINT", "https://example.openai.azure.com/")
    clean_env.delenv("EMPYREAN_TEST_DEPLOYMENT", raising=False)
    registry = load_registry()
    assert registry.keys() == ["fake-heuristic", "fake-scripted", "fake-malformed", "fake-assistant", "my-foundry"]
    # Stored/snapshotted ref keeps the placeholder; the adapter copy is resolved.
    assert registry.get("my-foundry").endpoint == "${EMPYREAN_TEST_ENDPOINT}"
    assert registry.resolved("my-foundry").endpoint == "https://example.openai.azure.com/"
    assert registry.info("my-foundry").missing_credentials == ["AZURE_OPENAI_API_KEY", "EMPYREAN_TEST_DEPLOYMENT"]
    clean_env.setenv("EMPYREAN_TEST_DEPLOYMENT", "dep1")
    clean_env.setenv("AZURE_OPENAI_API_KEY", "azure-key-value-123456")
    registry = load_registry()
    assert registry.info("my-foundry").available
    assert registry.resolved("my-foundry").deployment == "dep1"


@pytest.mark.parametrize(
    "content",
    [
        "{not json",
        json.dumps({"entries": []}),
        json.dumps({"models": [{"key": "x", "provider": "nope", "model_id": "m"}]}),
        json.dumps({"models": [{"key": "x", "provider": "fake", "model_id": "fake-heuristic"}] * 2}),
    ],
)
def test_invalid_registry_files_raise_value_error(tmp_path, content):
    path = tmp_path / "bad.json"
    path.write_text(content)
    with pytest.raises(ValueError):
        load_registry(path)


def test_missing_registry_file_raises_value_error(tmp_path):
    with pytest.raises(ValueError):
        load_registry(tmp_path / "missing.json")


def test_claude_cli_availability_follows_path(monkeypatch):
    registry = load_registry()
    monkeypatch.setattr(model.shutil, "which", lambda name: None)
    info = registry.info("claude-cli-haiku")
    assert not info.available
    assert info.missing_credentials == ["claude (executable on PATH)"]
    monkeypatch.setattr(model.shutil, "which", lambda name: "/opt/bin/claude")
    assert registry.info("claude-cli-haiku").available


def test_bedrock_default_chain_and_missing_sdk(clean_env, monkeypatch):
    registry = load_registry()
    assert registry.info("bedrock-haiku").available  # empty credential_env -> boto3 default chain
    monkeypatch.setattr(model, "_sdk_installed", lambda name: False)
    assert registry.info("bedrock-haiku").missing_credentials == ["boto3 (python package)"]
    assert registry.info("fake-heuristic").available


def test_unknown_key(registry):
    with pytest.raises(UnknownModelError):
        registry.get("nope")
    assert registry.validate_key("nope") == "unknown model key 'nope'"
    result = call_model(make_request("nope"), registry)
    assert result.status == "invalid_config" and not result.ok
    assert result.attempts == 0 and result.provider == "unknown"
    assert request_overhead_tokens("nope", registry) == 0


def test_missing_credentials_and_output_limit_are_invalid_config(clean_env, registry):
    result = call_model(make_request("anthropic-haiku"), registry)
    assert result.status == "invalid_config" and result.attempts == 0
    assert "ANTHROPIC_API_KEY" in (result.error or "")
    too_big = call_model(make_request("fake-heuristic", max_output_tokens=8001), registry)
    assert too_big.status == "invalid_config" and "max_output_tokens" in (too_big.error or "")


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------


def test_redact_removes_env_values_and_key_shapes(clean_env):
    clean_env.setenv("OPENAI_API_KEY", "plain-openai-secret-value-42")
    text = (
        "failed with key plain-openai-secret-value-42 and sk-ant-api03-abcdefghijklmnop "
        "AKIAABCDEFGHIJKLMNOP Authorization: Bearer abc.def.ghijklmnop api_key=zzzzzzzzzz fw_abcdefghijk"
    )
    cleaned = redact(text)
    for leaked in ("plain-openai-secret-value-42", "sk-ant-api03", "AKIAABCDEFGHIJKLMNOP", "abc.def.ghijklmnop", "zzzzzzzzzz", "fw_abcdefghijk"):
        assert leaked not in cleaned
    assert "[REDACTED:OPENAI_API_KEY]" in cleaned
    assert redact(None) is None
    long = redact("x" * 5000)
    assert len(long) <= config.ERROR_TEXT_MAX_CHARS


def test_registry_credential_names_are_redacted(tmp_path, clean_env):
    clean_env.setenv("MY_CUSTOM_TOKEN_VAR", "custom-secret-value-777")
    registry = registry_with(
        {"key": "custom", "provider": "openai", "model_id": "m", "credential_env": ["MY_CUSTOM_TOKEN_VAR"], "capabilities": caps()}
    )
    assert "custom-secret-value-777" not in redact("boom custom-secret-value-777", registry)
    assert "custom-secret-value-777" not in redact("boom custom-secret-value-777")  # remembered names


# ---------------------------------------------------------------------------
# JSON extraction and the format gate
# ---------------------------------------------------------------------------


def test_extract_json_object_variants():
    body = {"action": {"name": "wait", "args": {"rounds": 1}}}
    assert extract_json_object(json.dumps(body)) == body
    assert extract_json_object("Sure!\n```json\n" + json.dumps(body) + "\n```\nDone.") == body
    assert extract_json_object("I choose " + json.dumps(body) + " because it is safe.") == body
    assert extract_json_object('prose {"a": "brace } inside", "b": {"c": 1}} tail') == {"a": "brace } inside", "b": {"c": 1}}
    assert extract_json_object("{broken {\"ok\": 1}") == {"ok": 1}
    assert extract_json_object("[1, 2, 3]") is None
    assert extract_json_object("no json here") is None
    assert extract_json_object("") is None
    assert extract_json_object('{"x": NaN}') is None
    assert extract_json_object('{"x": Infinity}') is None
    assert extract_json_object('{"x": 1e999}') is None


def test_parse_decision_gate():
    def result(status: str = "ok", parsed: Any = None) -> ModelResult:
        return ModelResult(request_id="r", ok=status == "ok", status=status, parsed=parsed, provider="fake", model_id="m")

    decision, reason = parse_decision(result(parsed=VALID_DECISION))
    assert isinstance(decision, Decision) and reason is None
    assert parse_decision(result("timeout")) == (None, "status=timeout")
    assert parse_decision(result("ok", None)) == (None, "not a JSON object")
    _, reason = parse_decision(result(parsed={"action": {"name": "teleport", "args": {}}}))
    assert reason and reason.startswith("action:") and len(reason) <= 200
    _, reason = parse_decision(result(parsed={"action": {"name": "wait", "args": {"rounds": True}}}))
    assert reason and "rounds" in reason
    _, reason = parse_decision(result(parsed={"extra": 1, **VALID_DECISION}))
    assert reason and reason.startswith("extra")
    _, reason = parse_decision(result(parsed={"action": {"name": "recover", "args": {"compute_budget": float("nan")}}}))
    assert reason and "non-finite" in reason


def test_is_retryable_policy():
    assert is_retryable("timeout", None)
    for code in (408, 429, 500, 502, 503, 529):
        assert is_retryable("error", code)
    for code in (400, 401, 403, 404, 422):
        assert not is_retryable("error", code)
    assert not is_retryable("error", None)
    for status in ("ok", "malformed", "refusal", "truncated", "invalid_config"):
        assert not is_retryable(status, 503)


# ---------------------------------------------------------------------------
# Fake adapter
# ---------------------------------------------------------------------------


def random_situation(rng: random.Random, agent_id: str = "a01") -> Situation:
    round_no = rng.randint(1, 60)
    position = {"x": rng.randint(-10, 10), "y": rng.randint(-10, 10)}
    entities = [{"id": agent_id, "kind": "agent", "position": position}]
    for index in range(rng.randint(0, 4)):
        kind = rng.choice(["fruit", "residue", "agent", "plant", "seed"])
        entity: dict[str, Any] = {
            "id": f"a{rng.randint(2, 9):02d}" if kind == "agent" else f"{kind[0]}{index:04d}",
            "kind": kind,
            "position": position,
        }
        if kind in ("fruit", "residue") and rng.random() < 0.6:
            entity["available_compute"] = rng.choice([0.0, 4.5, 60.0])
        if kind == "residue" and rng.random() < 0.6:
            entity["available_essence"] = rng.choice([0.0, 3.0])
        entities.append(entity)
    if rng.random() < 0.3:
        self_state: dict[str, Any] = {}
    else:
        self_state = {
            "source": "derived",
            "known_round": round_no - 1,
            "compute": rng.choice([None, 2.0, 45.0, 200.0]),
            "health": rng.choice([None, 40.0, 100.0]),
            "max_health": rng.choice([None, 100.0]),
            "essence": rng.choice([None, 1.0, 20.0]),
            "essence_capacity": rng.choice([None, 100.0]),
        }
    last_action = rng.choice(
        [
            None,
            {"name": "move", "args": {"direction": "up"}},
            {"name": "query", "args": {"entity": "f0000"}},
            {"name": "absorb", "args": {"source": "f0000", "resource": "compute"}},
            {"name": "query", "args": {"entity": "self"}},
        ]
    )
    last_result = None
    if last_action is not None:
        ok = rng.random() < 0.7
        last_result = {"ok": ok, "reason": "ok" if ok else "blocked", "round": round_no - 1}
    observed = rng.choice([None, round_no, round_no - 1, round_no - 5])
    quotes = {}
    if rng.random() < 0.5:
        quotes = {
            attribute: {"base_compute": 25, "skill_compute": 20, "compute": 25, "essence": 2, "next_value": 1, "allowed": True}
            for attribute in ("vision_range", "communication_range", "max_health", "essence_capacity", "compute_absorption")
        }
    return make_situation(
        agent_id=agent_id,
        round=round_no,
        turn_id=f"r{round_no:05d}_t01_{agent_id}",
        position=position,
        self_state=self_state,
        visible_entities=entities if observed is not None else [],
        observed_round=observed,
        last_action=last_action,
        last_result=last_result,
        unread_messages=rng.choice([0, 1]),
        skills=rng.choice([[], [FORAGE_SKILL_NAME]]),
        upgrade_quotes=quotes,
        quote_mode="direct" if quotes else None,
    )


def test_fake_heuristic_always_passes_the_gate():
    rng = random.Random(7)
    seen_actions: set[str] = set()
    for index in range(600):
        situation = random_situation(rng)
        options = rng.choice([{}, {"aggressive": True}])
        decision = fake_heuristic_decision("a01", situation.round, situation.turn_id, situation, options)
        result = ModelResult(request_id="r", ok=True, status="ok", parsed=decision, provider="fake", model_id="fake-heuristic")
        parsed, reason = parse_decision(result)
        assert parsed is not None, (reason, decision)
        seen_actions.add(parsed.action.name)
    assert {"observe", "query", "absorb", "move", "run_skill", "attack", "recover", "wait"} <= seen_actions


def test_fake_heuristic_tolerates_unknown_self_state():
    situation = make_situation(round=4, turn_id="r00004_t01_a01", observed_round=4, self_state={})
    decision = fake_heuristic_decision("a01", 4, "r00004_t01_a01", situation, {})
    assert decision["action"] == {"name": "query", "args": {"entity": "self"}}
    assert fake_heuristic_decision("a01", 4, "t", None, {})["action"]["name"] == "query"


def test_fake_heuristic_priorities():
    base_self = {"compute": 150.0, "health": 100.0, "max_health": 100.0, "essence": 20.0, "essence_capacity": 100.0}
    here = {"x": 2, "y": 3}

    def decide(round_no: int = 2, options: Optional[dict[str, Any]] = None, **kw: Any) -> dict[str, Any]:
        kw.setdefault("self_state", base_self)
        kw.setdefault("observed_round", round_no)
        situation = make_situation(round=round_no, turn_id=f"r{round_no:05d}_t01_a01", position=here, **kw)
        return fake_heuristic_decision("a01", round_no, situation.turn_id, situation, options or {})

    assert decide(observed_round=None)["action"] == {"name": "observe", "args": {"point": here, "page": 0}}
    assert decide(round_no=9, observed_round=5)["action"]["name"] == "observe"  # older than 3 rounds
    fruit = {"id": "f0001", "kind": "fruit", "position": here}
    assert decide(visible_entities=[fruit])["action"] == {"name": "query", "args": {"entity": "f0001"}}
    full = {**fruit, "available_compute": 60.0}
    assert decide(visible_entities=[full])["action"] == {"name": "absorb", "args": {"source": "f0001", "resource": "compute"}}
    after_absorb = decide(
        round_no=3,
        observed_round=2,
        visible_entities=[full],
        last_action={"name": "absorb", "args": {"source": "f0001", "resource": "compute"}},
        last_result={"ok": True, "reason": "ok", "round": 2},
    )
    assert after_absorb["action"]["name"] == "observe"
    hurt = {**base_self, "health": 50.0}
    assert decide(self_state=hurt)["action"] == {"name": "recover", "args": {"compute_budget": 10.0}}
    assert decide(round_no=6)["action"] == {"name": "query", "args": {"entity": "self"}}
    other = {"id": "a02", "kind": "agent", "position": here}
    assert decide(options={"aggressive": True}, visible_entities=[other])["action"] == {
        "name": "attack",
        "args": {"target": "a02", "compute_budget": 5.0},
    }
    assert decide(options={"idle": True})["action"] == {"name": "wait", "args": {"rounds": 1}}
    skill = decide(round_no=11)
    assert skill["action"] == {"name": "run_skill", "args": {"skill": FORAGE_SKILL_NAME, "arguments": []}}
    assert skill["save_skills"][0]["source"] == FORAGE_SKILL_SOURCE
    assert "save_skills" not in decide(round_no=11, skills=[FORAGE_SKILL_NAME])
    quotes = {"vision_range": {"base_compute": 25, "skill_compute": 20, "compute": 25, "essence": 2, "next_value": 1, "allowed": True}}
    assert decide(round_no=7, upgrade_quotes=quotes, quote_mode="direct")["action"] == {
        "name": "upgrade",
        "args": {"attribute": "vision_range"},
    }
    assert decide(round_no=2, self_state={**base_self, "compute": 3.0})["action"]["name"] == "wait"
    assert decide(round_no=2)["action"]["name"] == "move"
    blocked = decide(
        round_no=2,
        last_action={"name": "move", "args": {"direction": "up"}},
        last_result={"ok": False, "reason": "blocked", "round": 1},
    )
    assert blocked["action"] != {"name": "move", "args": {"direction": "up"}}
    assert "notebook_update" in decide(round_no=12)
    # Another agent visible and nothing else to do: a seeded 30% chance to message it.
    sends = []
    for turn in range(1, 10):
        situation = make_situation(
            round=2, turn_id=f"r00002_t{turn:02d}_a01", position=here, observed_round=2, self_state=base_self, visible_entities=[other]
        )
        sends.append(fake_heuristic_decision("a01", 2, situation.turn_id, situation, {})["action"])
    messages = [a for a in sends if a["name"] == "send"]
    assert messages and all(a["args"]["recipient"] == "a02" for a in messages)
    assert all(a["name"] in ("send", "move") for a in sends)


def test_fake_heuristic_is_deterministic_within_a_process(registry):
    request = make_request("fake-heuristic", round_no=2)
    first = call_model(request, registry)
    second = call_model(request)  # default registry
    assert first.text == second.text and first.parsed == second.parsed
    assert first.status == "ok" and first.ok and first.usage.source == "estimate"
    assert first.provider == "fake" and first.model_id == "fake-heuristic" and first.attempts == 1


def test_fake_heuristic_is_deterministic_across_processes():
    rng = random.Random(11)
    cases = []
    for _ in range(40):
        situation = random_situation(rng)
        cases.append((situation.round, situation.turn_id, situation.model_dump(mode="json")))
    local = [
        fake_heuristic_decision("a01", r, t, Situation.model_validate(s), {"aggressive": True}) for r, t, s in cases
    ]
    script = (
        "import json, sys\n"
        "from empyrean.model import fake_heuristic_decision\n"
        "from empyrean.schemas import Situation\n"
        "cases = json.load(sys.stdin)\n"
        "print(json.dumps([fake_heuristic_decision('a01', r, t, Situation.model_validate(s), {'aggressive': True}) for r, t, s in cases]))\n"
    )
    for hash_seed in ("0", "12345"):
        env = {**os.environ, "PYTHONHASHSEED": hash_seed}
        out = subprocess.run(
            [sys.executable, "-c", script],
            input=json.dumps(cases),
            capture_output=True,
            text=True,
            cwd=str(config.BACKEND_DIR),
            env=env,
            timeout=120,
            check=True,
        )
        assert json.loads(out.stdout) == local


def test_forage_skill_is_valid_skill_source():
    from empyrean import skills

    try:
        blocks = skills.parse_skill(FORAGE_SKILL_SOURCE)
        size = skills.count_blocks(blocks)
    except NotImplementedError:
        pytest.skip("skills.py parser not implemented yet")
    assert size == 48  # design example 2 (INTERFACES 4.2)


def test_fake_scripted_replays_by_index_then_falls_back(registry):
    script = [VALID_DECISION, {"action": {"name": "wait", "args": {"rounds": 2}}}, "not json at all"]
    first = call_model(make_request("fake-scripted", script=script, script_index=0), registry)
    assert first.parsed == VALID_DECISION
    second = call_model(make_request("fake-scripted", script=script, script_index=1), registry)
    assert second.parsed == script[1]
    raw = call_model(make_request("fake-scripted", script=script, script_index=2), registry)
    assert raw.status == "malformed" and raw.text == "not json at all" and not raw.ok
    exhausted = call_model(make_request("fake-scripted", script=script, script_index=3), registry)
    heuristic = call_model(make_request("fake-heuristic"), registry)
    assert exhausted.parsed == heuristic.parsed
    absent = call_model(make_request("fake-scripted", script=None), registry)
    assert absent.parsed == heuristic.parsed


def test_fake_malformed_schedule(registry):
    # a01 has index 1: phase = (round + 1) % 3
    expected = {2: "invalid_json", 3: "unknown_action", 4: "valid", 5: "invalid_json", 6: "unknown_action", 7: "valid"}
    for round_no, kind in expected.items():
        result = call_model(make_request("fake-malformed", round_no=round_no), registry)
        decision, reason = parse_decision(result)
        if kind == "invalid_json":
            assert result.status == "malformed" and result.parsed is None and decision is None
        elif kind == "unknown_action":
            assert result.status == "ok" and result.parsed["action"]["name"] == "teleport"
            assert decision is None and reason and reason.startswith("action")
        else:
            assert result.status == "ok" and decision is not None
    # a second agent is staggered: a02 in round 1 -> (1 + 2) % 3 == 0 -> invalid JSON
    assert call_model(make_request("fake-malformed", round_no=1, agent_id="a02"), registry).status == "malformed"
    assert model.fake_agent_index("a03") == 3 and model.fake_agent_index("zed") == sum(map(ord, "zed"))


def test_fake_fail_timeout_recovers_on_retry(registry, delays):
    options = {"fail": {"status": "timeout", "rounds": [1], "failing_attempts": 1}}
    result = call_model(make_request(options=options), registry)
    assert result.status == "ok" and result.attempts == 2
    assert len(result.attempt_errors) == 1 and result.attempt_errors[0].startswith("attempt 1: timeout")
    assert delays == [config.RETRY_BACKOFF_SECONDS[0]]
    other_round = call_model(make_request(options=options, round_no=2), registry)
    assert other_round.status == "ok" and other_round.attempts == 1


def test_fake_fail_exhausts_retries_then_next_call_id_succeeds(registry, delays):
    options = {"fail": {"status": "timeout", "failing_attempts": 3}}
    first = call_model(make_request(options=options, call_no=1), registry)
    assert first.status == "timeout" and first.attempts == 3 and not first.ok
    assert len(first.attempt_errors) == 3
    assert first.usage.billed_input_tokens == 0 and first.usage.output_tokens == 0
    assert delays == config.RETRY_BACKOFF_SECONDS[:2]
    rerun = call_model(make_request(options=options, call_no=2), registry)  # mc_..._02 after pause
    assert rerun.status == "ok" and rerun.attempts == 1


def test_fake_fail_statuses_classification(registry, delays):
    def run(status: str, **extra: Any) -> ModelResult:
        return call_model(make_request(options={"fail": {"status": status, **extra}}), registry)

    server = run("error")
    assert server.status == "error" and server.attempts == 3  # HTTP 500: retryable
    client_error = run("error", http_status=400)
    assert client_error.status == "error" and client_error.attempts == 1
    config_error = run("invalid_config")
    assert config_error.status == "invalid_config" and config_error.attempts == 1
    delays.clear()
    for status in ("refusal", "truncated", "malformed"):
        result = run(status)
        assert result.status == status and result.attempts == 1 and not result.ok and result.parsed is None
        assert result.usage.source == "estimate" and result.usage.billed_input_tokens > 0
        assert parse_decision(result) == (None, f"status={status}")
    assert delays == []  # agent-output statuses are never retried


def test_fake_sleep_ms_and_attempt_timeout(registry, delays):
    slow = call_model(make_request(options={"sleep_ms": 30}), registry)
    assert slow.status == "ok" and slow.latency_ms >= 30
    too_slow = call_model(make_request(options={"sleep_ms": 400}, timeout=0.05, max_retries=0), registry)
    assert too_slow.status == "timeout" and too_slow.attempts == 1


def test_overhead_tokens(registry):
    assert request_overhead_tokens("fake-heuristic", registry) == 0
    schema_tokens = model.estimate_tokens(model._compact_json(model.compact_schema(decision_json_schema())))
    assert request_overhead_tokens("anthropic-haiku", registry) == schema_tokens + model.FIXED_OVERHEAD_TOKENS["anthropic"]
    assert request_overhead_tokens("claude-cli-haiku", registry) == schema_tokens + model.FIXED_OVERHEAD_TOKENS["claude_cli"]
    assert request_overhead_tokens("bedrock-haiku", registry) == model.estimate_tokens(JSON_ONLY_INSTRUCTION)
    openai_tokens = model.estimate_tokens(model._compact_json(model.openai_strict_schema(decision_json_schema())))
    assert request_overhead_tokens("openai-mini", registry) == openai_tokens + model.FIXED_OVERHEAD_TOKENS["openai"]
    custom = registry_with(
        {"key": "c", "provider": "anthropic", "model_id": "m", "capabilities": caps(schema=False), "options": {"overhead_tokens": 7}}
    )
    assert request_overhead_tokens("c", custom) == model.estimate_tokens(JSON_ONLY_INSTRUCTION) + 7


# ---------------------------------------------------------------------------
# Schema transforms
# ---------------------------------------------------------------------------


def test_openai_strict_schema_transform_and_null_stripping():
    raw = decision_json_schema()
    strict = model.openai_strict_schema(raw)
    text = json.dumps(strict)
    assert '"oneOf"' not in text and '"discriminator"' not in text and '"maxLength"' not in text and '"default"' not in text

    def check_objects(node: Any) -> None:
        if isinstance(node, dict):
            if isinstance(node.get("properties"), dict):
                assert set(node["required"]) == set(node["properties"])
                assert node["additionalProperties"] is False
            for value in node.values():
                check_objects(value)
        elif isinstance(node, list):
            for item in node:
                check_objects(item)

    check_objects(strict)
    arguments = strict["$defs"]["RunSkillArgs"]["properties"]["arguments"]
    assert arguments["type"] == ["array", "null"] and arguments["items"]["anyOf"]
    # A strict-mode reply fills every optional field with null; stripping restores validity.
    reply = {
        "thought": None,
        "notebook_update": None,
        "save_skills": None,
        "delete_skills": None,
        "memory_priorities": None,
        "action": {"name": "observe", "args": {"point": {"x": 1, "y": 2}, "page": None}},
    }
    with pytest.raises(Exception):
        Decision.model_validate(reply)
    cleaned = model.strip_transform_nulls(reply, raw)
    assert cleaned == {"action": {"name": "observe", "args": {"point": {"x": 1, "y": 2}}}}
    Decision.model_validate(cleaned)
    skill = {"action": {"name": "run_skill", "args": {"skill": "s", "arguments": [None, 1]}}, "thought": None}
    assert model.strip_transform_nulls(skill, raw) == {"action": {"name": "run_skill", "args": {"skill": "s", "arguments": [None, 1]}}}


def test_compact_schema_keeps_property_names():
    schema = {"type": "object", "title": "T", "properties": {"title": {"type": "string", "title": "Title"}}, "required": ["title"]}
    assert model.compact_schema(schema) == {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}


# ---------------------------------------------------------------------------
# Real adapters with fake SDK clients (golden payloads, no network)
# ---------------------------------------------------------------------------


class Recorder:
    """A fake SDK client: records kwargs and returns queued responses / raises queued errors."""

    def __init__(self, *outcomes: Any) -> None:
        self.outcomes = list(outcomes)
        self.calls: list[dict[str, Any]] = []
        self.messages = self  # anthropic: client.messages.create
        self.chat = self  # openai: client.chat.completions.create
        self.completions = self

    def _next(self, kwargs: dict[str, Any]) -> Any:
        self.calls.append(kwargs)
        outcome = self.outcomes.pop(0) if len(self.outcomes) > 1 else self.outcomes[0]
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    def create(self, **kwargs: Any) -> Any:
        return self._next(kwargs)

    def converse(self, **kwargs: Any) -> Any:
        return self._next(kwargs)


def install_client(monkeypatch, provider: str, client: Recorder) -> list[tuple]:
    built: list[tuple] = []

    def factory(ref: ModelRef, credential: str, timeout: float) -> Recorder:
        built.append((ref, credential, timeout))
        return client

    monkeypatch.setitem(model.CLIENT_FACTORIES, provider, factory)
    return built


def anthropic_message(tool_input: Optional[dict[str, Any]] = None, *, stop: str = "tool_use", text: Optional[str] = None, usage: Optional[dict[str, Any]] = None):
    from anthropic.types import Message

    content: list[dict[str, Any]] = []
    if text is not None:
        content.append({"type": "text", "text": text})
    if tool_input is not None:
        content.append({"type": "tool_use", "id": "toolu_01", "name": model.DECISION_TOOL_NAME, "input": tool_input})
    return Message.model_validate(
        {
            "id": "msg_01",
            "type": "message",
            "role": "assistant",
            "model": "claude-haiku-4-5-20251001",
            "content": content,
            "stop_reason": stop,
            "stop_sequence": None,
            "usage": usage
            or {"input_tokens": 1200, "cache_creation_input_tokens": 300, "cache_read_input_tokens": 2000, "output_tokens": 150},
        }
    )


def openai_completion(content: Optional[str], *, finish: str = "stop", usage: Optional[dict[str, Any]] = None, refusal: Optional[str] = None):
    from openai.types.chat import ChatCompletion

    return ChatCompletion.model_validate(
        {
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "created": 1,
            "model": "gpt-4o-mini-2024-07-18",
            "choices": [
                {"index": 0, "finish_reason": finish, "message": {"role": "assistant", "content": content, "refusal": refusal}}
            ],
            "usage": usage
            or {
                "prompt_tokens": 3000,
                "completion_tokens": 400,
                "total_tokens": 3400,
                "prompt_tokens_details": {"cached_tokens": 1024},
                "completion_tokens_details": {"reasoning_tokens": 256},
            },
        }
    )


def http_error(sdk: str, cls_name: str, status: int, headers: Optional[dict[str, str]] = None, message: str = "boom"):
    import httpx2

    module = __import__(sdk)
    request = httpx2.Request("POST", "https://provider.invalid/v1")
    response = httpx2.Response(status, headers=headers or {}, request=request)
    return getattr(module, cls_name)(message, response=response, body=None)


def test_anthropic_forced_tool_and_usage_golden(clean_env, monkeypatch, registry):
    clean_env.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key-000000000000")
    client = Recorder(anthropic_message(VALID_DECISION))
    built = install_client(monkeypatch, "anthropic", client)
    result = call_model(make_request("anthropic-haiku", timeout=12.0), registry)
    assert result.status == "ok" and result.ok and result.parsed == VALID_DECISION
    assert json.loads(result.text) == VALID_DECISION
    assert result.response_model == "claude-haiku-4-5-20251001" and result.model_id == "claude-haiku-4-5"
    usage = result.usage
    assert (usage.input_tokens, usage.cache_read_tokens, usage.cache_creation_tokens, usage.output_tokens) == (1200, 2000, 300, 150)
    assert usage.billed_input_tokens == 3500 and usage.source == "provider"
    kwargs = client.calls[0]
    assert kwargs["tool_choice"] == {"type": "tool", "name": model.DECISION_TOOL_NAME}
    assert "title" not in schema_keywords(kwargs["tools"][0]["input_schema"])  # no property is named "title"
    assert "discriminator" not in schema_keywords(kwargs["tools"][0]["input_schema"])
    assert kwargs["system"].startswith("You are an agent") and kwargs["messages"][0]["role"] == "user"
    assert kwargs["temperature"] == 0.7 and kwargs["max_tokens"] == 500 and kwargs["model"] == "claude-haiku-4-5"
    assert "metadata" not in kwargs and "SENTINEL" not in repr(kwargs)
    assert built[0][1] == "sk-ant-test-key-000000000000" and built[0][2] == 12.0
    call_model(make_request("anthropic-haiku", temperature=0.1), registry)
    assert client.calls[-1]["temperature"] == 0.1


def test_anthropic_agent_output_statuses_are_not_retried(clean_env, monkeypatch, registry, delays):
    clean_env.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key-000000000000")
    install_client(monkeypatch, "anthropic", Recorder(anthropic_message(None, stop="refusal", text="I can't")))
    refused = call_model(make_request("anthropic-haiku"), registry)
    assert refused.status == "refusal" and refused.attempts == 1 and refused.usage.source == "provider"
    install_client(monkeypatch, "anthropic", Recorder(anthropic_message({"thought": "cut"}, stop="max_tokens")))
    assert call_model(make_request("anthropic-haiku"), registry).status == "truncated"
    install_client(monkeypatch, "anthropic", Recorder(anthropic_message(None, stop="end_turn", text="I will just move north.")))
    malformed = call_model(make_request("anthropic-haiku"), registry)
    assert malformed.status == "malformed" and malformed.text == "I will just move north."
    assert delays == []


def test_anthropic_prompt_guided_fallback(clean_env, monkeypatch):
    clean_env.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key-000000000000")
    registry = registry_with(
        {"key": "plain", "provider": "anthropic", "model_id": "m", "credential_env": ["ANTHROPIC_API_KEY"], "capabilities": caps(schema=False)}
    )
    client = Recorder(anthropic_message(None, stop="end_turn", text="```json\n" + json.dumps(VALID_DECISION) + "\n```"))
    install_client(monkeypatch, "anthropic", client)
    result = call_model(make_request("plain"), registry)
    assert result.status == "ok" and result.parsed == VALID_DECISION
    assert "tools" not in client.calls[0] and client.calls[0]["system"].endswith(JSON_ONLY_INSTRUCTION)


def test_anthropic_errors_retry_policy_and_redaction(clean_env, monkeypatch, registry, delays):
    secret = "sk-ant-test-key-SECRET-111111111"
    clean_env.setenv("ANTHROPIC_API_KEY", secret)
    rate_limited = http_error("anthropic", "RateLimitError", 429, {"retry-after": "3"}, message=f"slow down {secret}")
    client = Recorder(rate_limited, rate_limited, anthropic_message(VALID_DECISION))
    install_client(monkeypatch, "anthropic", client)
    result = call_model(make_request("anthropic-haiku"), registry)
    assert result.status == "ok" and result.attempts == 3
    assert delays == [3.0, 3.0]  # Retry-After (3 s) beats the 1 s / 2 s backoff
    assert len(result.attempt_errors) == 2 and all("429" in e for e in result.attempt_errors)
    assert secret not in json.dumps(result.model_dump(mode="json"))
    assert result.usage.billed_input_tokens == 3500  # only the answered attempt reported usage

    delays.clear()
    install_client(monkeypatch, "anthropic", Recorder(http_error("anthropic", "AuthenticationError", 401, message=f"bad key {secret}")))
    denied = call_model(make_request("anthropic-haiku"), registry)
    assert denied.status == "invalid_config" and denied.attempts == 1 and delays == []
    assert secret not in (denied.error or "") and "401" in (denied.error or "")

    install_client(monkeypatch, "anthropic", Recorder(http_error("anthropic", "InternalServerError", 500)))
    server = call_model(make_request("anthropic-haiku", max_retries=1), registry)
    assert server.status == "error" and server.attempts == 2

    install_client(monkeypatch, "anthropic", Recorder(http_error("anthropic", "OverloadedError", 529)))
    assert call_model(make_request("anthropic-haiku"), registry).attempts == 3

    install_client(monkeypatch, "anthropic", Recorder(RuntimeError(f"unexpected {secret}")))
    crashed = call_model(make_request("anthropic-haiku"), registry)
    assert crashed.status == "error" and crashed.attempts == 1 and secret not in (crashed.error or "")


def test_default_sdk_clients_disable_sdk_retries():
    ref = ModelRef(key="k", provider="anthropic", model_id="m")
    assert model._anthropic_client(ref, "sk-ant-fake-000000", 7.0).max_retries == 0
    openai_client = model._openai_client(ModelRef(key="o", provider="openai", model_id="m"), "sk-fake-000000", 7.0)
    assert openai_client.max_retries == 0
    fireworks = model._openai_client(ModelRef(key="f", provider="fireworks", model_id="m"), "fw_fake000000", 7.0)
    assert str(fireworks.base_url).rstrip("/") == model.DEFAULT_FIREWORKS_BASE_URL
    bedrock = model._bedrock_client(ModelRef(key="b", provider="bedrock", model_id="m"), "us-east-1", 7.0)
    assert bedrock.meta.config.retries["total_max_attempts"] == 1
    assert bedrock.meta.config.read_timeout == 7.0


def test_missing_sdk_is_invalid_config(clean_env, monkeypatch, registry):
    clean_env.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key-000000000000")

    def no_sdk(name: str) -> Any:
        raise ImportError(f"No module named {name!r}", name=name)

    monkeypatch.setattr(model, "_import_sdk", no_sdk)
    result = call_model(make_request("anthropic-haiku"), registry)
    assert result.status == "invalid_config" and "anthropic" in (result.error or "") and result.attempts == 1


def test_openai_json_schema_nulls_and_usage_golden(clean_env, monkeypatch, registry):
    clean_env.setenv("OPENAI_API_KEY", "sk-proj-test-0000000000000")
    reply = {
        "thought": None,
        "notebook_update": None,
        "save_skills": None,
        "delete_skills": None,
        "memory_priorities": None,
        "action": {"name": "wait", "args": {"rounds": 1}},
    }
    client = Recorder(openai_completion(json.dumps(reply)))
    install_client(monkeypatch, "openai", client)
    result = call_model(make_request("openai-mini"), registry)
    assert result.status == "ok" and result.parsed == {"action": {"name": "wait", "args": {"rounds": 1}}}
    assert parse_decision(result)[0] is not None
    usage = result.usage
    assert (usage.input_tokens, usage.cache_read_tokens, usage.cache_creation_tokens) == (1976, 1024, 0)
    assert usage.billed_input_tokens == 3000 and usage.output_tokens == 400 and usage.reasoning_tokens == 256
    assert result.response_model == "gpt-4o-mini-2024-07-18"
    assert result.provider_cost_usd is None  # no usd_per_mtok on the entry: no cost reported
    kwargs = client.calls[0]
    fmt = kwargs["response_format"]
    assert fmt["type"] == "json_schema" and fmt["json_schema"]["strict"] is False
    assert "oneOf" not in schema_keywords(fmt["json_schema"]["schema"])
    assert kwargs["max_tokens"] == 500 and kwargs["temperature"] == 0.7
    assert kwargs["messages"][0] == {"role": "system", "content": "You are an agent in the Empyrean. Rules follow."}
    assert "SENTINEL" not in repr(kwargs)


def test_openai_options_strict_reasoning_and_json_mode(clean_env, monkeypatch):
    clean_env.setenv("OPENAI_API_KEY", "sk-proj-test-0000000000000")
    registry = registry_with(
        {"key": "strict", "provider": "openai", "model_id": "o", "credential_env": ["OPENAI_API_KEY"], "capabilities": caps(), "options": {"strict_schema": True, "param_style": "reasoning", "temperature": 0.5}},
        {"key": "jsonmode", "provider": "openai", "model_id": "o", "credential_env": ["OPENAI_API_KEY"], "capabilities": caps(schema=False)},
    )
    client = Recorder(openai_completion(json.dumps(VALID_DECISION)))
    install_client(monkeypatch, "openai", client)
    call_model(make_request("strict"), registry)
    kwargs = client.calls[-1]
    assert kwargs["response_format"]["json_schema"]["strict"] is True
    assert kwargs["max_completion_tokens"] == 500 and "max_tokens" not in kwargs and "temperature" not in kwargs
    call_model(make_request("jsonmode"), registry)
    kwargs = client.calls[-1]
    assert kwargs["response_format"] == {"type": "json_object"}
    assert kwargs["messages"][0]["content"].endswith(JSON_ONLY_INSTRUCTION)


def test_openai_reasoning_effort_and_list_price_cost(clean_env, monkeypatch):
    clean_env.setenv("AZURE_AI_API_KEY", "azure-test-key-0000000000")
    clean_env.setenv("AZURE_AI_V1_ENDPOINT", "https://example.openai.azure.com/openai/v1")
    registry = registry_with(
        {"key": "luna", "provider": "openai", "model_id": "gpt-6-luna", "credential_env": ["AZURE_AI_V1_ENDPOINT", "AZURE_AI_API_KEY"],
         "endpoint": "${AZURE_AI_V1_ENDPOINT}", "capabilities": caps(),
         "options": {"api_key_env": "AZURE_AI_API_KEY", "param_style": "reasoning", "reasoning_effort": "none", "usd_per_mtok": [0.10, 0.01, 0.50]}},
        {"key": "unpriced", "provider": "openai", "model_id": "m", "credential_env": ["AZURE_AI_API_KEY"], "capabilities": caps(),
         "options": {"usd_per_mtok": [0.1, "free", 0.5]}},
    )
    assert registry.resolved("luna").endpoint == "https://example.openai.azure.com/openai/v1"
    client = Recorder(openai_completion(json.dumps(VALID_DECISION)))
    install_client(monkeypatch, "openai", client)
    result = call_model(make_request("luna"), registry)
    assert client.calls[-1]["reasoning_effort"] == "none"
    # golden usage: 1976 uncached + 1024 cached input, 400 output tokens
    assert result.provider_cost_usd == pytest.approx((1976 * 0.10 + 1024 * 0.01 + 400 * 0.50) / 1_000_000)
    unpriced = call_model(make_request("unpriced"), registry)
    assert "reasoning_effort" not in client.calls[-1] and unpriced.provider_cost_usd is None


def test_openai_refusal_truncation_and_errors(clean_env, monkeypatch, registry, delays):
    clean_env.setenv("OPENAI_API_KEY", "sk-proj-test-0000000000000")
    install_client(monkeypatch, "openai", Recorder(openai_completion(None, refusal="I cannot comply.")))
    refused = call_model(make_request("openai-mini"), registry)
    assert refused.status == "refusal" and refused.text == "I cannot comply."
    install_client(monkeypatch, "openai", Recorder(openai_completion('{"thought": "cut', finish="length")))
    assert call_model(make_request("openai-mini"), registry).status == "truncated"
    import httpx2
    import openai

    timeout = openai.APITimeoutError(request=httpx2.Request("POST", "https://provider.invalid"))
    install_client(monkeypatch, "openai", Recorder(timeout))
    timed_out = call_model(make_request("openai-mini"), registry)
    assert timed_out.status == "timeout" and timed_out.attempts == 3
    connection = openai.APIConnectionError(request=httpx2.Request("POST", "https://provider.invalid"))
    install_client(monkeypatch, "openai", Recorder(connection, openai_completion(json.dumps(VALID_DECISION))))
    recovered = call_model(make_request("openai-mini"), registry)
    assert recovered.status == "ok" and recovered.attempts == 2
    install_client(monkeypatch, "openai", Recorder(http_error("openai", "BadRequestError", 400, message="schema invalid")))
    bad = call_model(make_request("openai-mini"), registry)
    assert bad.status == "invalid_config" and bad.attempts == 1


def test_fireworks_usage_golden_without_details(clean_env, monkeypatch, registry):
    clean_env.setenv("FIREWORKS_API_KEY", "fw_testkey000000000000")
    usage = {"prompt_tokens": 900, "completion_tokens": 80, "total_tokens": 980}
    client = Recorder(openai_completion("Here: " + json.dumps(VALID_DECISION), usage=usage))
    built = install_client(monkeypatch, "fireworks", client)
    result = call_model(make_request("fireworks-llama"), registry)
    assert result.status == "ok" and result.parsed == VALID_DECISION
    assert (result.usage.input_tokens, result.usage.cache_read_tokens, result.usage.output_tokens) == (900, 0, 80)
    assert result.usage.billed_input_tokens == 900 and result.usage.reasoning_tokens == 0
    assert built[0][0].endpoint == model.DEFAULT_FIREWORKS_BASE_URL and built[0][1] == "fw_testkey000000000000"
    assert client.calls[0]["model"] == "accounts/fireworks/models/llama-v3p1-8b-instruct"


def test_foundry_configuration_and_usage_golden(clean_env, monkeypatch):
    clean_env.setenv("AZURE_OPENAI_API_KEY", "azure-test-key-0000000000")
    clean_env.setenv("AZURE_OPENAI_ENDPOINT", "https://unit.openai.azure.com/")
    registry = load_registry()
    unresolved = call_model(make_request("foundry-gpt"), registry)
    assert unresolved.status == "invalid_config" and "AZURE_OPENAI_DEPLOYMENT" in (unresolved.error or "")
    clean_env.setenv("AZURE_OPENAI_DEPLOYMENT", "my-deployment")
    clean_env.setenv("AZURE_OPENAI_API_VERSION", "2024-10-21")
    registry = load_registry()
    usage = {
        "prompt_tokens": 2500,
        "completion_tokens": 120,
        "total_tokens": 2620,
        "prompt_tokens_details": {"cached_tokens": 2048, "audio_tokens": 0},
        "completion_tokens_details": {"reasoning_tokens": 0, "audio_tokens": 0},
    }
    client = Recorder(openai_completion(json.dumps(VALID_DECISION), usage=usage))
    built = install_client(monkeypatch, "foundry", client)
    result = call_model(make_request("foundry-gpt"), registry)
    assert result.status == "ok"
    assert (result.usage.input_tokens, result.usage.cache_read_tokens, result.usage.billed_input_tokens) == (452, 2048, 2500)
    assert client.calls[0]["model"] == "my-deployment"
    effective = built[0][0]
    assert (effective.endpoint, effective.api_version, effective.deployment) == (
        "https://unit.openai.azure.com/",
        "2024-10-21",
        "my-deployment",
    )
    assert load_registry().get("foundry-gpt").endpoint == "${AZURE_OPENAI_ENDPOINT}"  # snapshot keeps the name


def bedrock_response(text: str, stop: str = "end_turn") -> dict[str, Any]:
    return {
        "ResponseMetadata": {"HTTPStatusCode": 200},
        "output": {"message": {"role": "assistant", "content": [{"text": text}]}},
        "stopReason": stop,
        "usage": {"inputTokens": 500, "outputTokens": 60, "totalTokens": 1360, "cacheReadInputTokens": 700, "cacheWriteInputTokens": 100},
        "metrics": {"latencyMs": 800},
    }


def test_bedrock_converse_and_usage_golden(clean_env, monkeypatch, registry):
    client = Recorder(bedrock_response("Decision:\n" + json.dumps(VALID_DECISION)))
    built = install_client(monkeypatch, "bedrock", client)
    result = call_model(make_request("bedrock-haiku"), registry)
    assert result.status == "ok" and result.parsed == VALID_DECISION
    usage = result.usage
    assert (usage.input_tokens, usage.cache_read_tokens, usage.cache_creation_tokens, usage.output_tokens) == (500, 700, 100, 60)
    assert usage.billed_input_tokens == 1300 and usage.source == "provider"
    assert result.response_model == "anthropic.claude-3-5-haiku-20241022-v1:0"
    kwargs = client.calls[0]
    assert kwargs["system"][0]["text"].endswith(JSON_ONLY_INSTRUCTION)
    assert kwargs["inferenceConfig"] == {"maxTokens": 500}
    assert kwargs["messages"] == [{"role": "user", "content": [{"text": "Situation: round 1. Decide one action as JSON."}]}]
    assert built[0][1] == "us-east-1"
    clean_env.setenv("AWS_REGION", "eu-west-1")
    call_model(make_request("bedrock-haiku"), registry)
    assert built[-1][1] == "eu-west-1"
    install_client(monkeypatch, "bedrock", Recorder(bedrock_response('{"thought": "x', stop="max_tokens")))
    assert call_model(make_request("bedrock-haiku"), registry).status == "truncated"
    install_client(monkeypatch, "bedrock", Recorder(bedrock_response("no", stop="guardrail_intervened")))
    assert call_model(make_request("bedrock-haiku"), registry).status == "refusal"


def test_bedrock_error_classification(clean_env, monkeypatch, registry, delays):
    from botocore.exceptions import ClientError, NoCredentialsError, ReadTimeoutError

    def client_error(code: str, status: int) -> ClientError:
        return ClientError({"Error": {"Code": code, "Message": "m"}, "ResponseMetadata": {"HTTPStatusCode": status}}, "Converse")

    install_client(monkeypatch, "bedrock", Recorder(client_error("ThrottlingException", 429), bedrock_response(json.dumps(VALID_DECISION))))
    assert call_model(make_request("bedrock-haiku"), registry).attempts == 2
    install_client(monkeypatch, "bedrock", Recorder(client_error("ValidationException", 400)))
    assert call_model(make_request("bedrock-haiku"), registry).status == "invalid_config"
    install_client(monkeypatch, "bedrock", Recorder(client_error("ModelTimeoutException", 408)))
    assert call_model(make_request("bedrock-haiku"), registry).status == "timeout"
    install_client(monkeypatch, "bedrock", Recorder(NoCredentialsError()))
    no_creds = call_model(make_request("bedrock-haiku"), registry)
    assert no_creds.status == "invalid_config" and no_creds.attempts == 1
    install_client(monkeypatch, "bedrock", Recorder(ReadTimeoutError(endpoint_url="https://bedrock.invalid")))
    assert call_model(make_request("bedrock-haiku", max_retries=0), registry).status == "timeout"


def test_bedrock_without_region_is_invalid_config(clean_env):
    registry = registry_with({"key": "br", "provider": "bedrock", "model_id": "m", "capabilities": caps(schema=False)})
    result = call_model(make_request("br"), registry)
    assert result.status == "invalid_config" and "region" in (result.error or "")


# ---------------------------------------------------------------------------
# claude_cli (fake subprocess)
# ---------------------------------------------------------------------------


def cli_envelope(**overrides: Any) -> dict[str, Any]:
    """Shape of a real `claude -p --output-format json --json-schema` result (CLI 2.1.x)."""
    envelope: dict[str, Any] = {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "num_turns": 2,
        "stop_reason": "tool_use",
        "result": json.dumps(VALID_DECISION),
        "structured_output": VALID_DECISION,
        "total_cost_usd": 0.001666,
        "usage": {
            "input_tokens": 1181,
            "cache_creation_input_tokens": 40,
            "cache_read_input_tokens": 2000,
            "output_tokens": 97,
            "output_tokens_details": {"thinking_tokens": 40},
            "iterations": [{"input_tokens": 1181, "output_tokens": 97, "type": "message"}],
        },
        "modelUsage": {"claude-haiku-4-5-20251001": {"inputTokens": 1181, "outputTokens": 97, "costUSD": 0.001666}},
    }
    envelope.update(overrides)
    return envelope


class FakePopen:
    """Stands in for subprocess.Popen; records how the CLI would have been started."""

    instances: list["FakePopen"] = []
    stdout_text = ""
    raise_timeout = False

    def __init__(self, argv: list[str], **kwargs: Any) -> None:
        self.argv = argv
        self.kwargs = kwargs
        self.pid = 424242
        self.returncode: Optional[int] = None
        self.stdin_text: Optional[str] = None
        self.cwd_listing = sorted(os.listdir(kwargs["cwd"]))
        self.timeouts = 0
        FakePopen.instances.append(self)

    def communicate(self, input: Optional[str] = None, timeout: Optional[float] = None) -> tuple[str, str]:
        if FakePopen.raise_timeout and self.timeouts == 0:
            self.timeouts += 1
            raise subprocess.TimeoutExpired(self.argv, timeout or 0)
        self.stdin_text = input if input is not None else self.stdin_text
        self.returncode = 0 if not FakePopen.raise_timeout else -9
        return FakePopen.stdout_text, ""

    def poll(self) -> Optional[int]:
        return self.returncode


@pytest.fixture()
def fake_cli(monkeypatch):
    FakePopen.instances = []
    FakePopen.stdout_text = json.dumps(cli_envelope())
    FakePopen.raise_timeout = False
    monkeypatch.setattr(model.shutil, "which", lambda name: "/opt/fake/bin/claude")
    monkeypatch.setattr(subprocess, "Popen", FakePopen)
    return FakePopen


def test_claude_cli_argv_env_cwd(fake_cli, monkeypatch, registry):
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-never-reach-cli-000")
    monkeypatch.setenv("EMPYREAN_MODELS_FILE", str(config.MODELS_FILE))
    monkeypatch.setenv("HOME", os.environ.get("HOME", "/tmp"))
    request = make_request("claude-cli-haiku", timeout=33.0)
    result = call_model(request, registry)
    assert result.status == "ok" and result.ok and result.parsed == VALID_DECISION
    proc = fake_cli.instances[0]
    argv = proc.argv
    assert os.path.basename(argv[0]) == "claude" and argv[1] == "-p"

    def value_of(flag: str) -> str:
        return argv[argv.index(flag) + 1]

    assert value_of("--model") == "haiku"
    assert value_of("--output-format") == "stream-json" and "--verbose" in argv
    assert value_of("--max-turns") == str(model.CLI_MAX_TURNS) == "1"
    assert value_of("--tools") == ""
    assert value_of("--setting-sources") == ""
    # schema route: the packet's system message exactly, nothing appended (a "call the
    # StructuredOutput tool with the JSON object as its input" hint made Haiku wrap the
    # decision under an "input" key in 24 of 24 live decisions)
    assert value_of("--system-prompt") == "You are an agent in the Empyrean. Rules follow."
    assert value_of("--max-budget-usd") == "0.05"
    assert json.loads(value_of("--json-schema")) == model.compact_schema(decision_json_schema())
    for flag in ("--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"):
        assert flag in argv
    assert "--bare" not in argv
    assert all("Situation: round 1" not in part for part in argv)  # the body goes on stdin
    assert proc.stdin_text == "Situation: round 1. Decide one action as JSON."
    env = proc.kwargs["env"]
    assert set(env) <= set(config.CLAUDE_CLI_ENV_ALLOWLIST) | {model.CLI_MAX_OUTPUT_TOKENS_ENV, model.CLI_MAX_THINKING_TOKENS_ENV}
    assert env[model.CLI_MAX_OUTPUT_TOKENS_ENV] == "500"  # the request's generation allowance
    assert env[model.CLI_MAX_THINKING_TOKENS_ENV] == str(config.CLI_MAX_THINKING_TOKENS) == "0"  # A-COG-10
    assert "CLAUDECODE" not in env and "ANTHROPIC_API_KEY" not in env
    assert not any(name.startswith("EMPYREAN_") for name in env)
    assert not set(env) & registry.credential_env_names()
    assert env.get("HOME") == os.environ.get("HOME")
    cwd = Path(proc.kwargs["cwd"])
    assert proc.cwd_listing == [] and not cwd.exists()  # fresh empty dir, removed afterwards
    assert not cwd.resolve().is_relative_to(config.REPO_DIR.resolve())
    assert proc.kwargs["start_new_session"] is True
    assert result.usage.input_tokens == 1181 and result.usage.cache_read_tokens == 2000
    assert result.usage.cache_creation_tokens == 40 and result.usage.billed_input_tokens == 3221
    assert result.usage.output_tokens == 97 and result.usage.reasoning_tokens == 40
    assert result.provider_cost_usd == pytest.approx(0.001666)
    assert result.response_model == "claude-haiku-4-5-20251001"


def test_claude_cli_timeout_kills_process_group(fake_cli, monkeypatch, registry):
    fake_cli.raise_timeout = True
    killed: list[tuple[int, int]] = []
    monkeypatch.setattr(model.os, "killpg", lambda pid, sig: killed.append((pid, sig)))
    result = call_model(make_request("claude-cli-haiku", max_retries=0), registry)
    assert result.status == "timeout" and result.attempts == 1
    assert killed and killed[0] == (424242, signal.SIGKILL)


@pytest.mark.parametrize(
    "overrides, status",
    [
        ({"is_error": True, "subtype": "error_max_budget_usd", "result": ""}, "error"),
        # A rejected StructuredOutput call within the single allowed request: the agent answered badly.
        ({"is_error": True, "subtype": "error_max_turns", "result": None, "structured_output": None}, "malformed"),
        ({"num_turns": 2}, "ok"),  # one model request + the StructuredOutput tool turn
        # usage.iterations lists only the last request; it must not be used to count requests
        ({"usage": {"input_tokens": 10, "output_tokens": 5, "iterations": [{}, {}]}}, "ok"),
        ({"stop_reason": "max_tokens"}, "truncated"),
        # the CLI's own output cap (a small generation allowance): a cut-off agent reply, not an error
        ({"is_error": True, "subtype": "success", "structured_output": None,
          "result": "API Error: Claude's response exceeded the 250 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable."}, "truncated"),
        # the CLI re-prompted once after a text-only first response: accepted (A-COG-9)
        ({"num_turns": 3}, "ok"),
        # beyond CLI_MAX_MODEL_REQUESTS: infrastructure error
        ({"num_turns": 4}, "error"),
        ({"stop_reason": "refusal", "structured_output": None, "result": "No."}, "refusal"),
        ({"structured_output": None, "result": "Sure:\n```json\n" + json.dumps(VALID_DECISION) + "\n```"}, "ok"),
        ({"structured_output": None, "result": "I refuse to use JSON."}, "malformed"),
    ],
)
def test_claude_cli_envelope_classification(fake_cli, registry, overrides, status):
    fake_cli.stdout_text = json.dumps(cli_envelope(**overrides))
    result = call_model(make_request("claude-cli-haiku", max_retries=0), registry)
    assert result.status == status
    if status == "ok":
        assert result.parsed == VALID_DECISION


def test_claude_cli_reprompt_is_accepted_charged_and_noted(fake_cli, registry, delays):
    """A-COG-9: num_turns 3 = two model requests (the CLI re-prompted for the StructuredOutput
    call).  The decision is used, the envelope's summed usage is kept, and attempt_errors
    carries a note; more requests than the limit are an error (not retried)."""
    usage = {"input_tokens": 20, "cache_read_input_tokens": 10743, "cache_creation_input_tokens": 2426, "output_tokens": 1205}
    fake_cli.stdout_text = json.dumps(cli_envelope(num_turns=3, usage=usage, total_cost_usd=0.0119713))
    result = call_model(make_request("claude-cli-haiku"), registry)
    assert result.status == "ok" and result.parsed == VALID_DECISION and result.attempts == 1
    assert result.usage.billed_input_tokens == 13189 and result.usage.output_tokens == 1205
    assert result.provider_cost_usd == pytest.approx(0.0119713)
    assert result.attempt_errors == ["attempt 1: note: claude CLI re-prompted the model: 2 model requests billed for this reply (usage and cost are the sum)"]
    assert result.error is None and delays == []
    # the limit is configurable per entry
    strict = model.ModelRegistry([registry.get("claude-cli-haiku").model_copy(update={"options": {"max_budget_usd": 0.05, "max_model_requests": 1}})])
    result = call_model(make_request("claude-cli-haiku"), strict)
    assert result.status == "error" and "at most 1 allowed" in (result.error or "") and result.attempts == 1
    assert result.usage.billed_input_tokens == 13189  # the spend is still recorded


def test_claude_cli_thinking_env_follows_config_and_options(fake_cli, registry, monkeypatch):
    """A-COG-10: MAX_THINKING_TOKENS = config.CLI_MAX_THINKING_TOKENS unless the entry sets
    options.max_thinking_tokens (an explicit null leaves the CLI default: no variable)."""
    call_model(make_request("claude-cli-haiku"), registry)
    assert fake_cli.instances[-1].kwargs["env"][model.CLI_MAX_THINKING_TOKENS_ENV] == "0"
    monkeypatch.setattr(model, "CLI_MAX_THINKING_TOKENS", None)
    call_model(make_request("claude-cli-haiku"), registry)
    assert model.CLI_MAX_THINKING_TOKENS_ENV not in fake_cli.instances[-1].kwargs["env"]
    for value, expected in ((1024, "1024"), (None, None), (0, "0"), ("lots", None)):
        custom = model.ModelRegistry([registry.get("claude-cli-haiku").model_copy(update={"options": {"max_thinking_tokens": value}})])
        call_model(make_request("claude-cli-haiku"), custom)
        assert fake_cli.instances[-1].kwargs["env"].get(model.CLI_MAX_THINKING_TOKENS_ENV) == expected


def test_claude_cli_malformed_structured_output_is_charged_not_infra(fake_cli, registry, delays):
    fake_cli.stdout_text = json.dumps(cli_envelope(is_error=True, subtype="error_max_turns", result=None, structured_output=None))
    result = call_model(make_request("claude-cli-haiku"), registry)
    assert result.status == "malformed" and result.attempts == 1 and delays == []
    assert result.usage.source == "provider" and result.usage.billed_input_tokens == 3221
    assert parse_decision(result) == (None, "status=malformed: structured output did not match the decision schema")


def test_claude_cli_error_status_retries_on_overload(fake_cli, registry, delays):
    fake_cli.stdout_text = json.dumps(cli_envelope(is_error=True, subtype="error_during_execution", api_error_status=529))
    result = call_model(make_request("claude-cli-haiku"), registry)
    assert result.status == "error" and result.attempts == 3
    assert result.usage.billed_input_tokens == 3 * 3221  # spent usage is summed over attempts
    fake_cli.stdout_text = "not json"
    garbage = call_model(make_request("claude-cli-haiku"), registry)
    assert garbage.status == "error" and garbage.attempts == 1


def test_claude_cli_prompt_guided_when_no_schema(fake_cli, registry):
    fake_cli.stdout_text = json.dumps(cli_envelope(structured_output=None, num_turns=1))
    request = make_request("claude-cli-haiku", use_schema=False)
    call_model(request, registry)
    argv = fake_cli.instances[-1].argv
    assert "--json-schema" not in argv
    assert argv[argv.index("--system-prompt") + 1].endswith(JSON_ONLY_INSTRUCTION)


# ---------------------------------------------------------------------------
# Live (skipped unless EMPYREAN_LIVE_TESTS=1)
# ---------------------------------------------------------------------------


@pytest.mark.live
def test_live_claude_cli_haiku_tiny_schema():
    registry = load_registry()
    problem = registry.validate_key("claude-cli-haiku")
    if problem:
        pytest.skip(problem)
    schema = {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
        "additionalProperties": False,
    }
    request = ModelRequest(
        request_id="mc_live_test_01",
        model_key="claude-cli-haiku",
        messages=[
            ModelMessage(role="system", content="You answer with JSON only."),
            ModelMessage(role="user", content='Return {"answer": "ok"}.'),
        ],
        response_schema=schema,
        max_output_tokens=200,
        timeout_seconds=120.0,
        max_retries=0,
        purpose="test",
    )
    result = call_model(request, registry)
    assert result.status == "ok", result.error
    assert isinstance(result.parsed, dict) and isinstance(result.parsed.get("answer"), str)
    assert result.usage.source == "provider"
    assert result.usage.billed_input_tokens > 0 and result.usage.output_tokens > 0
    assert result.response_model
    assert result.provider_cost_usd is not None and result.provider_cost_usd > 0


@pytest.mark.live
def test_live_claude_cli_decision_bills_near_packet_estimate():
    """INTERFACES 13: a claude_cli call with the real decision schema bills <= 1.5x the
    packet estimate (messages + request_overhead_tokens); catches leaked CLAUDE.md,
    project settings or the CLI's default system prompt."""
    registry = load_registry()
    problem = registry.validate_key("claude-cli-haiku")
    if problem:
        pytest.skip(problem)
    rules = "\n".join(
        f"Rule {i}: moving costs 5 compute; observing costs 1; absorbing fruit converts compute at 20 percent."
        for i in range(40)
    )
    rules += (
        '\nReply with one JSON object: {"thought": "one or two sentences", "action": {"name": "...", "args": {...}}}'
        '\naction is exactly one of: {"name":"move","args":{"direction":"up"}} {"name":"observe","args":{"point":{"x":0,"y":0}}}'
        ' {"name":"query","args":{"entity":"self"}} {"name":"absorb","args":{"source":"<id>","resource":"compute"}}'
    )
    body = "Situation: round 3. You are at (0,0) on land. You see fruit f0001 here. " * 12 + "\nDecide exactly one action."
    request = ModelRequest(
        request_id="mc_live_packet_01",
        model_key="claude-cli-haiku",
        messages=[
            ModelMessage(role="system", content="You are Aster (a01), an agent in the Empyrean.\n" + rules),
            ModelMessage(role="user", content=body),
        ],
        response_schema=decision_json_schema(),
        max_output_tokens=1000,
        timeout_seconds=120.0,
        max_retries=0,
    )
    estimate = sum(model.estimate_tokens(m.content) for m in request.messages) + request_overhead_tokens(
        "claude-cli-haiku", registry
    )
    result = call_model(request, registry)
    # A stochastic malformed reply is still billed; the billing bound is what this test
    # checks, so only infrastructure failures fail it.
    assert result.status in ("ok", "malformed"), result.error
    if result.status == "ok":
        decision, reason = parse_decision(result)
        assert decision is not None, reason
    assert 0 < result.usage.billed_input_tokens <= 1.5 * estimate


# ---------------------------------------------------------------------------
# Review regressions: unstorable replies, strict observe points, CLI config errors,
# the system-prompt fallback
# ---------------------------------------------------------------------------


def test_unstorable_replies_are_malformed_at_the_boundary():
    """A reply that decodes but cannot be stored (a lone surrogate, ~300 nesting levels)
    is a handled agent-output result (malformed, parsed None), never an engine error."""
    surrogate = '{"thought": "look \\ud800 here", "action": {"name": "wait", "args": {"rounds": 1}}}'
    assert model._output_status(None, surrogate, refused=False, truncated=False) == ("malformed", None)
    deep = '{"action": {"name": "run_skill", "args": {"skill": "s", "arguments": [' + "[" * 300 + "]" * 300 + "]}}}"
    assert model._output_status(None, deep, refused=False, truncated=False) == ("malformed", None)
    native_deep = {"action": {"name": "run_skill", "args": {"skill": "s", "arguments": [json.loads("[" * 40 + "]" * 40)]}}}
    assert model._output_status(native_deep, None, refused=False, truncated=False) == ("malformed", None)
    assert model._output_status(None, json.dumps(VALID_DECISION), refused=False, truncated=False) == ("ok", VALID_DECISION)
    assert model.reply_problem({"a": [[["x"]]], "b": {"c": 1}}) is None
    assert model.reply_problem({"k\ud800": 1}) and model.reply_problem(json.loads(surrogate))
    assert model.sanitize_text("ok \ud800 text") == "ok \ufffd text"
    assert model.sanitize_text("plain") == "plain" and model.sanitize_text(None) is None
    ref = ModelRef(key="f", provider="fake", model_id="f")
    stored = model._make_result(make_request(), ref, "malformed", text="look \ud800")
    assert stored.text is not None and stored.text.encode("utf-8") and stored.parsed is None
    result = ModelResult(request_id="r", ok=True, status="ok", parsed=json.loads(deep), provider="fake", model_id="m")
    decision, reason = parse_decision(result)
    assert decision is None and reason and "nested deeper" in reason


def test_parse_decision_requires_plain_integer_observe_points():
    """Section 6 rules of the game: numbers are plain numbers; the engine's Point accepts
    lists, strings and booleans, the decision gate does not."""

    def result(parsed: Any) -> ModelResult:
        return ModelResult(request_id="r", ok=True, status="ok", parsed=parsed, provider="fake", model_id="m")

    for point in ({"x": True, "y": False}, {"x": "1", "y": "2"}, {"x": 1.0, "y": 2}, [1, 2], [True, 1], "3,4", {"x": 1}, {"x": 1, "y": 1, "z": 0}):
        decision, reason = parse_decision(result({"action": {"name": "observe", "args": {"point": point}}}))
        assert decision is None and reason and reason.startswith("action.observe.args.point"), (point, reason)
    decision, reason = parse_decision(result({"action": {"name": "observe", "args": {"point": {"x": -1, "y": 2}, "page": 0}}}))
    assert reason is None and decision is not None and decision.action.args.point == Point(x=-1, y=2)


def test_claude_cli_configuration_statuses_are_invalid_config(fake_cli, registry, delays):
    for status in (401, 403, 404, 400):
        fake_cli.stdout_text = json.dumps(cli_envelope(is_error=True, subtype="error_during_execution", api_error_status=status))
        result = call_model(make_request("claude-cli-haiku"), registry)
        assert result.status == "invalid_config" and result.attempts == 1, status
    assert delays == []


def test_system_prompt_fallback_folds_the_system_text_into_the_first_user_turn():
    request = ModelRequest(
        request_id="r", model_key="k", messages=[ModelMessage(role="system", content="RULES"), ModelMessage(role="user", content="BODY")]
    )
    no_system = ModelRef(key="k", provider="fake", model_id="m", capabilities=ModelCapabilities(supports_system_prompt=False))
    assert model._split_messages(request, no_system) == ("", [("user", "SYSTEM INSTRUCTIONS:\nRULES\n\nUSER:\nBODY")])
    with_system = ModelRef(key="k", provider="fake", model_id="m")
    assert model._split_messages(request, with_system) == ("RULES", [("user", "BODY")])
    assert model._split_messages(request) == ("RULES", [("user", "BODY")])


def test_claude_cli_rejected_payload_is_stored(fake_cli, registry, delays):
    """A schema-rejected StructuredOutput reply is stored: result.text holds the payload the
    model sent, result.error the validator's message, attempt_errors the model's prose."""
    def rejected_stream(payload: dict[str, Any]) -> str:
        events = [
            {"type": "system", "subtype": "init"},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "I will wait this turn."}]}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "StructuredOutput", "input": payload}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "content": verdict}]}},
            cli_envelope(is_error=True, subtype="error_max_turns", result=None, structured_output=None),
        ]
        return "\n".join(json.dumps(e) for e in events)

    verdict = "Output does not match required schema: root: must have required property 'action'"
    rejected = {"notebook_update": "a note but no action"}  # no decision inside: salvage cannot help
    fake_cli.stdout_text = rejected_stream(rejected)
    result = call_model(make_request("claude-cli-haiku"), registry)
    assert result.status == "malformed" and not result.ok and result.salvaged_from is None
    assert json.loads(result.text) == rejected
    assert result.error.startswith("structured output did not match the decision schema: Output does not match")
    assert any("I will wait this turn." in note for note in result.attempt_errors)
    assert result.usage.output_tokens == 97 and result.provider_cost_usd == 0.001666

    # The measured Haiku envelope mistake (decision nested under "action") is salvaged (A-COG-11).
    nested = {"action": {"thought": "nested by mistake", "action": {"name": "wait", "args": {"rounds": 1}}}}
    fake_cli.stdout_text = rejected_stream(nested)
    salvaged = call_model(make_request("claude-cli-haiku"), registry)
    assert salvaged.status == "ok" and salvaged.ok and json.loads(salvaged.text) == nested
    assert salvaged.parsed == nested["action"] and salvaged.salvaged_from.startswith("status=malformed: structured output")
    assert salvaged.usage.output_tokens == 97 and salvaged.provider_cost_usd == 0.001666


def test_claude_cli_stream_success_uses_the_result_event(fake_cli, registry):
    """With stream-json the envelope is the final result event; earlier events do not confuse it."""
    events = [
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "StructuredOutput", "input": VALID_DECISION}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "content": "Structured output provided successfully"}]}},
        cli_envelope(),
    ]
    fake_cli.stdout_text = "\n".join(json.dumps(e) for e in events)
    result = call_model(make_request("claude-cli-haiku"), registry)
    assert result.status == "ok" and result.parsed == VALID_DECISION and result.error is None


# ---------------------------------------------------------------------------
# rev 4 (assistant): text response mode, fake-assistant, error codes, cancellation,
# cost summing, argv cap, purpose-named structured output, local Whisper
# ---------------------------------------------------------------------------

import re  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
from types import SimpleNamespace  # noqa: E402

TEXT_SYSTEM = "You narrate a simulation. Write two sentences."
PROSE = 'Aster crossed the ridge at dawn. She found fruit {"not": "a decision"} and ate.'


def text_request(
    model_key: str,
    *,
    system: Optional[str] = TEXT_SYSTEM,
    user: str = "Narrate turn r00001_t01_a01.",
    metadata: Optional[dict[str, Any]] = None,
    purpose: str = "narrative",
    response_format: str = "text",
    schema: Optional[dict[str, Any]] = None,
    max_retries: int = 0,
    timeout: float = 5.0,
    request_id: str = "as_narrator_test_01",
) -> ModelRequest:
    messages = ([ModelMessage(role="system", content=system)] if system is not None else []) + [
        ModelMessage(role="user", content=user)
    ]
    return ModelRequest(
        request_id=request_id,
        model_key=model_key,
        messages=messages,
        response_schema=schema,
        response_format=response_format,  # type: ignore[arg-type]
        max_output_tokens=600,
        timeout_seconds=timeout,
        max_retries=max_retries,
        purpose=purpose,  # type: ignore[arg-type]
        metadata=metadata or {},
    )


ANSWER_SCHEMA = {
    "type": "object",
    "properties": {"kind": {"type": "string", "enum": ["answer"]}, "text": {"type": "string"}},
    "required": ["kind", "text"],
    "additionalProperties": False,
}


def anthropic_tool_message(tool_name: str, tool_input: dict[str, Any]):
    from anthropic.types import Message

    return Message.model_validate(
        {
            "id": "msg_02",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-6",
            "content": [{"type": "tool_use", "id": "toolu_02", "name": tool_name, "input": tool_input}],
            "stop_reason": "tool_use",
            "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 5},
        }
    )


# --- text response mode, per adapter ---------------------------------------------------------


def test_text_mode_anthropic_sends_no_tool_or_json_instruction(clean_env, monkeypatch, registry):
    clean_env.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key-000000000000")
    client = Recorder(anthropic_message(None, stop="end_turn", text=PROSE))
    install_client(monkeypatch, "anthropic", client)
    result = call_model(text_request("anthropic-haiku"), registry)
    assert result.status == "ok" and result.ok and result.parsed is None and result.text == PROSE
    assert result.error_code is None
    kwargs = client.calls[0]
    assert "tools" not in kwargs and "tool_choice" not in kwargs
    assert kwargs["system"] == TEXT_SYSTEM and JSON_ONLY_INSTRUCTION not in repr(kwargs)
    # a schema passed by mistake is ignored in text mode (no forced tool, prose stays prose)
    call_model(text_request("anthropic-haiku", schema=ANSWER_SCHEMA), registry)
    assert "tools" not in client.calls[-1]
    install_client(monkeypatch, "anthropic", Recorder(anthropic_message(None, stop="end_turn", text="   ")))
    empty = call_model(text_request("anthropic-haiku"), registry)
    assert empty.status == "malformed" and not empty.ok and empty.error_code is None
    install_client(monkeypatch, "anthropic", Recorder(anthropic_message(None, stop="max_tokens", text="Aster crossed the")))
    cut = call_model(text_request("anthropic-haiku"), registry)
    assert cut.status == "truncated" and not cut.ok and cut.text == "Aster crossed the"


def test_text_mode_openai_family_sends_no_response_format(clean_env, monkeypatch, registry):
    clean_env.setenv("OPENAI_API_KEY", "sk-proj-test-0000000000000")
    jsonmode = registry_with(
        {"key": "jsonmode", "provider": "openai", "model_id": "o", "credential_env": ["OPENAI_API_KEY"], "capabilities": caps(schema=False)}
    )
    for reg, key in ((registry, "openai-mini"), (jsonmode, "jsonmode")):
        client = Recorder(openai_completion(PROSE))
        install_client(monkeypatch, "openai", client)
        result = call_model(text_request(key), reg)
        assert result.status == "ok" and result.ok and result.parsed is None and result.text == PROSE, key
        kwargs = client.calls[0]
        assert "response_format" not in kwargs, key
        assert kwargs["messages"][0] == {"role": "system", "content": TEXT_SYSTEM}


def test_text_mode_bedrock_sends_no_json_instruction(clean_env, monkeypatch, registry):
    client = Recorder(bedrock_response(PROSE))
    install_client(monkeypatch, "bedrock", client)
    result = call_model(text_request("bedrock-haiku"), registry)
    assert result.status == "ok" and result.ok and result.parsed is None and result.text == PROSE
    assert client.calls[0]["system"] == [{"text": TEXT_SYSTEM}]


def test_text_mode_claude_cli(fake_cli, registry):
    fake_cli.stdout_text = json.dumps(cli_envelope(structured_output=None, num_turns=1, result=PROSE, stop_reason="end_turn"))
    result = call_model(text_request("claude-cli-haiku"), registry)
    assert result.status == "ok" and result.ok and result.parsed is None and result.text == PROSE
    assert result.provider_cost_usd == pytest.approx(0.001666) and result.usage.source == "provider"
    argv = fake_cli.instances[-1].argv
    assert "--json-schema" not in argv
    assert argv[argv.index("--system-prompt") + 1] == TEXT_SYSTEM
    assert fake_cli.instances[-1].stdin_text == "Narrate turn r00001_t01_a01."
    # no system message: the neutral text fallback, never the JSON one
    call_model(text_request("claude-cli-haiku", system=None), registry)
    argv = fake_cli.instances[-1].argv
    assert argv[argv.index("--system-prompt") + 1] == model.CLI_TEXT_SYSTEM_PROMPT
    assert "JSON" not in model.CLI_TEXT_SYSTEM_PROMPT
    # JSON requests without a system message still get the JSON-only instruction (unchanged)
    call_model(text_request("claude-cli-haiku", system=None, response_format="json"), registry)
    argv = fake_cli.instances[-1].argv
    assert argv[argv.index("--system-prompt") + 1] == JSON_ONLY_INSTRUCTION
    fake_cli.stdout_text = json.dumps(cli_envelope(structured_output=None, num_turns=1, result=""))
    empty = call_model(text_request("claude-cli-haiku"), registry)
    assert empty.status == "malformed" and not empty.ok and empty.error_code is None
    # text mode sends no schema, so every turn is a model request (3 > the default 2)
    fake_cli.stdout_text = json.dumps(cli_envelope(structured_output=None, num_turns=3, result=PROSE))
    assert call_model(text_request("claude-cli-haiku"), registry).status == "error"


def test_text_mode_has_no_json_instruction_overhead(registry):
    for key, provider in (("claude-cli-haiku", "claude_cli"), ("anthropic-haiku", "anthropic"), ("openai-mini", "openai")):
        assert request_overhead_tokens(key, registry, response_format="text") == model.FIXED_OVERHEAD_TOKENS[provider]
        assert request_overhead_tokens(key, registry) > request_overhead_tokens(key, registry, response_format="text")
    assert request_overhead_tokens("bedrock-haiku", registry, response_format="text") == model.FIXED_OVERHEAD_TOKENS.get("bedrock", 0)
    assert request_overhead_tokens("fake-assistant", registry, response_format="text") == 0


def test_fake_modes_in_text_mode(registry):
    scripted = call_model(text_request("fake-scripted", metadata={"fake_script": [PROSE], "fake_script_index": 0}), registry)
    assert scripted.status == "ok" and scripted.ok and scripted.text == PROSE and scripted.parsed is None
    # the same string in JSON mode is still classified like a real reply
    as_json = call_model(text_request("fake-scripted", response_format="json", metadata={"fake_script": ["no json"], "fake_script_index": 0}), registry)
    assert as_json.status == "malformed" and as_json.error_code == "schema_mismatch"
    heuristic = call_model(text_request("fake-heuristic"), registry)
    assert heuristic.ok and heuristic.parsed is None and json.loads(heuristic.text)["action"]


# --- fake-assistant ----------------------------------------------------------------------------


def test_fake_assistant_script_then_reply_then_invalid_config(registry):
    assert registry.info("fake-assistant").assistant_only and registry.info("fake-assistant").available
    step1 = {"kind": "tool", "calls": [{"name": "search_docs", "args": {"query": "budget"}}]}
    step2 = {"kind": "answer", "text": "The budget is 5 USD.", "refs": []}
    script = [step1, step2]
    first = call_model(text_request("fake-assistant", response_format="json", purpose="assistant", metadata={"fake_script": script, "fake_script_index": 0}), registry)
    assert first.status == "ok" and first.ok and first.parsed == step1 and first.error_code is None
    second = call_model(text_request("fake-assistant", response_format="json", purpose="assistant", metadata={"fake_script": script, "fake_script_index": 1}), registry)
    assert second.parsed == step2
    # index past the script: the per-profile default reply
    fallback = call_model(
        text_request("fake-assistant", response_format="json", metadata={"fake_script": script, "fake_script_index": 2, "fake_reply": {"kind": "answer", "text": "default"}}),
        registry,
    )
    assert fallback.ok and fallback.parsed == {"kind": "answer", "text": "default"}
    nothing = call_model(text_request("fake-assistant", metadata={}), registry)
    assert nothing.status == "invalid_config" and not nothing.ok and nothing.attempts == 1
    assert "fake_reply" in (nothing.error or "")
    # strings: ok in text mode; in JSON mode prose is malformed and a JSON string decodes
    story = call_model(text_request("fake-assistant", metadata={"fake_reply": "## r00001_t01_a01\nAster ate."}), registry)
    assert story.status == "ok" and story.ok and story.text.startswith("## r00001_t01_a01") and story.parsed is None
    prose = call_model(text_request("fake-assistant", response_format="json", metadata={"fake_reply": "Sure! Here you go."}), registry)
    assert prose.status == "malformed" and not prose.ok and prose.error_code == "schema_mismatch"
    wrapped = call_model(text_request("fake-assistant", response_format="json", metadata={"fake_reply": json.dumps(step2)}), registry)
    assert wrapped.ok and wrapped.parsed == step2
    # a dict reply in text mode comes back as its JSON text
    as_text = call_model(text_request("fake-assistant", metadata={"fake_reply": step2}), registry)
    assert as_text.ok and json.loads(as_text.text) == step2 and as_text.parsed is None
    empty = call_model(text_request("fake-assistant", metadata={"fake_reply": ""}), registry)
    assert empty.status == "malformed" and not empty.ok


def test_fake_options_error_code_and_cost(registry, delays):
    failing = call_model(
        text_request("fake-assistant", max_retries=2, metadata={"fake_reply": "x", "fake_options": {"fail": {"status": "error", "http_status": 400, "error_code": "budget_exceeded"}, "cost_usd": 0.02}}),
        registry,
    )
    assert failing.status == "error" and failing.error_code == "budget_exceeded" and failing.attempts == 1
    assert failing.provider_cost_usd == pytest.approx(0.02)
    rate = call_model(text_request("fake-assistant", metadata={"fake_reply": "x", "fake_options": {"fail": {"status": "error", "http_status": 429}}}), registry)
    assert rate.error_code == "rate_limited"
    ignored = call_model(text_request("fake-assistant", metadata={"fake_reply": "x", "fake_options": {"fail": {"status": "timeout", "error_code": "bogus"}}}), registry)
    assert ignored.status == "timeout" and ignored.error_code == "timeout"
    ok = call_model(text_request("fake-assistant", metadata={"fake_reply": "x", "fake_options": {"cost_usd": 0.5}}), registry)
    assert ok.ok and ok.provider_cost_usd == pytest.approx(0.5) and ok.error_code is None


# --- error codes -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "overrides, status, code",
    [
        ({"is_error": True, "subtype": "error_max_budget_usd", "result": ""}, "error", "budget_exceeded"),
        ({"is_error": True, "subtype": "error_during_execution", "api_error_status": 429}, "error", "rate_limited"),
        ({"is_error": True, "subtype": "error_during_execution", "api_error_status": 529}, "error", "rate_limited"),
        ({"is_error": True, "subtype": "error_max_turns", "result": None, "structured_output": None}, "malformed", "schema_mismatch"),
        ({"structured_output": None, "result": "I refuse to use JSON."}, "malformed", "schema_mismatch"),
        ({"is_error": True, "subtype": "success", "result": "Invalid API key · Please run /login"}, "error", "not_logged_in"),
        ({"is_error": True, "subtype": "error_during_execution", "api_error_status": 401, "result": "OAuth token has expired"}, "invalid_config", "not_logged_in"),
        ({"is_error": True, "subtype": "error_during_execution", "api_error_status": 500}, "error", None),
        ({}, "ok", None),
    ],
)
def test_claude_cli_error_codes(fake_cli, registry, overrides, status, code):
    fake_cli.stdout_text = json.dumps(cli_envelope(**overrides))
    result = call_model(make_request("claude-cli-haiku", max_retries=0), registry)
    assert (result.status, result.error_code) == (status, code)


def test_error_codes_for_timeout_missing_cli_and_sdk_errors(fake_cli, clean_env, monkeypatch, registry, delays):
    fake_cli.raise_timeout = True
    monkeypatch.setattr(model.os, "killpg", lambda pid, sig: None)
    timed_out = call_model(make_request("claude-cli-haiku", max_retries=0), registry)
    assert timed_out.status == "timeout" and timed_out.error_code == "timeout"
    fake_cli.raise_timeout = False
    # no executable: pre-flight (no attempt) and adapter level both say cli_missing
    monkeypatch.setattr(model.shutil, "which", lambda name: None)
    missing = call_model(make_request("claude-cli-haiku"), registry)
    assert missing.status == "invalid_config" and missing.attempts == 0 and missing.error_code == "cli_missing"
    direct = model.ClaudeCliAdapter().attempt(registry.resolved("claude-cli-haiku"), make_request("claude-cli-haiku"), 1)
    assert direct.result.status == "invalid_config" and direct.result.error_code == "cli_missing"
    # other unavailable routes carry no code
    clean_env.delenv("ANTHROPIC_API_KEY", raising=False)
    assert call_model(make_request("anthropic-haiku"), registry).error_code is None
    # SDK adapters: 429 -> rate_limited, a transport timeout -> timeout
    clean_env.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key-000000000000")
    install_client(monkeypatch, "anthropic", Recorder(http_error("anthropic", "RateLimitError", 429)))
    limited = call_model(make_request("anthropic-haiku", max_retries=0), registry)
    assert limited.status == "error" and limited.error_code == "rate_limited"
    import httpx2
    import openai

    clean_env.setenv("OPENAI_API_KEY", "sk-proj-test-0000000000000")
    install_client(monkeypatch, "openai", Recorder(openai.APITimeoutError(request=httpx2.Request("POST", "https://provider.invalid"))))
    slow = call_model(make_request("openai-mini", max_retries=0), registry)
    assert slow.status == "timeout" and slow.error_code == "timeout"


def test_derive_error_code_table():
    assert model.derive_error_code("ok", 429) is None
    assert model.derive_error_code("timeout", None) == "timeout"
    assert model.derive_error_code("error", 429) == "rate_limited"
    assert model.derive_error_code("error", 529) == "rate_limited"
    assert model.derive_error_code("error", 500) is None
    assert model.derive_error_code("malformed", None) == "schema_mismatch"
    assert model.derive_error_code("malformed", None, text_mode=True) is None
    assert model.MODEL_ERROR_CODES == {
        "budget_exceeded", "rate_limited", "schema_mismatch", "cancelled", "timeout", "not_logged_in", "cli_missing"
    }


# --- cancellation and the in-flight registry --------------------------------------------------


@pytest.fixture()
def slow_cli(tmp_path, monkeypatch):
    """A real, slow stand-in for the claude executable (a shell script that sleeps), so the
    cancel path kills a genuine process group.  Records every Popen instance."""
    script = tmp_path / "claude"
    script.write_text("#!/bin/sh\nexec sleep 30\n")
    script.chmod(0o755)
    monkeypatch.setattr(model.shutil, "which", lambda name: str(script))
    started: list[subprocess.Popen] = []
    real_popen = subprocess.Popen

    class RecordingPopen(real_popen):  # type: ignore[misc, valid-type]
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            started.append(self)

    monkeypatch.setattr(subprocess, "Popen", RecordingPopen)
    return started


def _run_in_thread(fn) -> tuple[threading.Thread, dict[str, Any]]:
    box: dict[str, Any] = {}

    def target() -> None:
        box["result"] = fn()

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    return thread, box


def _wait_for(predicate, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def test_cancel_kills_the_cli_process_group(slow_cli, registry, delays):
    cancel = threading.Event()
    request = text_request("claude-cli-haiku", max_retries=2, timeout=60.0)
    thread, box = _run_in_thread(lambda: call_model(request, registry, cancel=cancel))
    assert _wait_for(lambda: model.inflight_count() == 1 and slow_cli)
    proc = slow_cli[0]
    assert proc.poll() is None  # really running
    stop = time.monotonic()
    cancel.set()
    thread.join(timeout=10)
    assert not thread.is_alive()
    elapsed = time.monotonic() - stop
    result = box["result"]
    assert result.status == "error" and result.error_code == "cancelled" and not result.ok
    assert result.attempts == 1 and delays == []  # never retried
    assert result.provider_cost_usd is None
    assert elapsed < 3.0  # one poll slice plus the kill, not the 60 s timeout
    assert proc.returncode == -signal.SIGKILL
    assert model.inflight_count() == 0
    with pytest.raises(ProcessLookupError):
        os.killpg(proc.pid, 0)  # the whole group is gone


def test_kill_inflight_stops_running_calls(slow_cli, registry, delays):
    request = text_request("claude-cli-haiku", max_retries=2, timeout=60.0)
    thread, box = _run_in_thread(lambda: call_model(request, registry))  # no cancel event at all
    assert _wait_for(lambda: model.inflight_count() == 1)
    assert model.kill_inflight() == 1
    thread.join(timeout=10)
    assert not thread.is_alive()
    result = box["result"]
    assert result.status == "error" and result.error_code == "cancelled" and "shutdown" in (result.error or "")
    assert result.attempts == 1 and delays == []
    assert model.inflight_count() == 0 and model.kill_inflight() == 0


def test_cancel_set_before_the_call_starts_nothing(fake_cli, registry):
    cancel = threading.Event()
    cancel.set()
    result = call_model(make_request("claude-cli-haiku"), registry, cancel=cancel)
    assert result.status == "error" and result.error_code == "cancelled" and result.attempts == 0
    assert fake_cli.instances == []


def test_cancel_between_retries_stops_retrying(registry, monkeypatch):
    cancel = threading.Event()
    monkeypatch.setattr(model, "_sleep", lambda seconds: cancel.set())  # cancelled during the backoff
    request = text_request("fake-assistant", max_retries=2, metadata={"fake_reply": "x", "fake_options": {"fail": {"status": "error", "http_status": 500}}})
    result = call_model(request, registry, cancel=cancel)
    assert result.status == "error" and result.error_code == "cancelled" and result.attempts == 1
    assert "before retry 2" in (result.error or "")


def test_fake_sleep_is_interrupted_by_cancel(registry):
    cancel = threading.Event()
    request = text_request("fake-assistant", timeout=30.0, metadata={"fake_reply": "late", "fake_options": {"sleep_ms": 20000}})
    thread, box = _run_in_thread(lambda: call_model(request, registry, cancel=cancel))
    time.sleep(0.1)
    started = time.monotonic()
    cancel.set()
    thread.join(timeout=5)
    assert not thread.is_alive() and time.monotonic() - started < 2.0
    assert box["result"].error_code == "cancelled" and box["result"].status == "error"
    # without an event the fake still just sleeps and answers
    quick = call_model(text_request("fake-assistant", metadata={"fake_reply": "on time", "fake_options": {"sleep_ms": 10}}), registry)
    assert quick.ok and quick.text == "on time"


# --- cost summed over attempts ------------------------------------------------------------------


def test_provider_cost_is_summed_over_attempts(fake_cli, registry, delays):
    fake_cli.stdout_text = json.dumps(cli_envelope(is_error=True, subtype="error_during_execution", api_error_status=529, total_cost_usd=0.01))
    result = call_model(make_request("claude-cli-haiku"), registry)
    assert result.attempts == 3 and result.provider_cost_usd == pytest.approx(0.03)
    assert model.sum_provider_cost([None, None]) is None
    assert model.sum_provider_cost([]) is None
    assert model.sum_provider_cost([None, 0.02, 0.0]) == pytest.approx(0.02)
    # an attempt without a reported cost adds nothing; the answered one counts
    mixed = call_model(
        text_request("fake-assistant", max_retries=2, metadata={"fake_reply": "x", "fake_options": {"cost_usd": 0.02, "fail": {"status": "timeout", "failing_attempts": 1}}}),
        registry,
    )
    assert mixed.ok and mixed.attempts == 2 and mixed.provider_cost_usd == pytest.approx(0.02)
    none_reported = call_model(text_request("fake-assistant", metadata={"fake_reply": "x"}), registry)
    assert none_reported.provider_cost_usd is None


# --- argv byte cap ------------------------------------------------------------------------------


def test_claude_cli_refuses_oversized_argv(fake_cli, registry):
    at_cap = call_model(text_request("claude-cli-haiku", system="s" * config.CLI_ARGV_MAX_BYTES), registry)
    assert at_cap.status == "ok" and len(fake_cli.instances) == 1
    over = call_model(text_request("claude-cli-haiku", system="s" * (config.CLI_ARGV_MAX_BYTES + 1)), registry)
    assert over.status == "invalid_config" and over.attempts == 1 and "CLI_ARGV_MAX_BYTES" in (over.error or "")
    # bytes, not characters: 2-byte characters hit the cap at half the length
    wide = call_model(text_request("claude-cli-haiku", system="é" * (config.CLI_ARGV_MAX_BYTES // 2 + 1)), registry)
    assert wide.status == "invalid_config"
    assert len(fake_cli.instances) == 1  # neither oversized call started a process


# --- purpose-named structured output ------------------------------------------------------------


def test_structured_output_names_follow_the_purpose():
    assert model.structured_output_names("decision") == ("submit_decision", model.DECISION_TOOL_DESCRIPTION, "decision")
    for purpose, schema_name in (("assistant", "assistant_reply"), ("narrative", "narrative"), ("summarize", "summary"), ("test", "response")):
        tool, description, name = model.structured_output_names(purpose)
        assert tool == "submit_response" and "decision" not in description and name == schema_name


def test_anthropic_forced_tool_is_named_by_purpose(clean_env, monkeypatch, registry):
    clean_env.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key-000000000000")
    reply = {"kind": "answer", "text": "Hello."}
    client = Recorder(anthropic_tool_message("submit_response", reply))
    install_client(monkeypatch, "anthropic", client)
    result = call_model(text_request("anthropic-haiku", response_format="json", purpose="assistant", schema=ANSWER_SCHEMA), registry)
    assert result.ok and result.parsed == reply
    kwargs = client.calls[0]
    assert kwargs["tools"][0]["name"] == "submit_response" and kwargs["tool_choice"] == {"type": "tool", "name": "submit_response"}
    assert "decision" not in kwargs["tools"][0]["description"]
    # a tool call under the decision name is not this request's tool
    install_client(monkeypatch, "anthropic", Recorder(anthropic_tool_message("submit_decision", reply)))
    wrong = call_model(text_request("anthropic-haiku", response_format="json", purpose="assistant", schema=ANSWER_SCHEMA), registry)
    assert wrong.status == "malformed" and wrong.error_code == "schema_mismatch"
    auto = registry_with(
        {"key": "auto", "provider": "anthropic", "model_id": "m", "credential_env": ["ANTHROPIC_API_KEY"], "capabilities": caps(), "options": {"tool_choice": "auto"}}
    )
    client = Recorder(anthropic_tool_message("submit_response", reply))
    install_client(monkeypatch, "anthropic", client)
    call_model(text_request("auto", response_format="json", purpose="assistant", schema=ANSWER_SCHEMA), auto)
    assert client.calls[0]["system"].endswith("Submit your reply by calling the submit_response tool exactly once.")


def test_openai_schema_name_follows_purpose(clean_env, monkeypatch, registry):
    clean_env.setenv("OPENAI_API_KEY", "sk-proj-test-0000000000000")
    client = Recorder(openai_completion(json.dumps({"kind": "answer", "text": "Hi."})))
    install_client(monkeypatch, "openai", client)
    for purpose, name in (("assistant", "assistant_reply"), ("narrative", "narrative"), ("decision", "decision")):
        call_model(text_request("openai-mini", response_format="json", purpose=purpose, schema=ANSWER_SCHEMA), registry)
        assert client.calls[-1]["response_format"]["json_schema"]["name"] == name


# --- golden malformed CLI envelopes (the shapes the engine's salvage step must handle) ----------


def test_claude_cli_golden_stringified_wrapper_is_malformed_with_payload(fake_cli, registry, delays):
    """Haiku's recorded failure shape: the StructuredOutput input wraps the JSON as a string
    under one key.  The boundary reports malformed + schema_mismatch and keeps the payload in
    ``text`` so the engine can salvage it without a re-call."""
    inner = {"kind": "answer", "text": "Round 3 had two deaths.", "refs": []}
    rejected = {"input": json.dumps(inner)}
    verdict = "Output does not match required schema: must have required property 'kind'"
    events = [
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "StructuredOutput", "input": rejected}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "content": verdict}]}},
        cli_envelope(is_error=True, subtype="error_max_turns", result=None, structured_output=None, num_turns=2),
    ]
    fake_cli.stdout_text = "\n".join(json.dumps(e) for e in events)
    result = call_model(text_request("claude-cli-haiku", response_format="json", purpose="assistant", schema=ANSWER_SCHEMA), registry)
    assert result.status == "malformed" and result.error_code == "schema_mismatch" and not result.ok
    assert json.loads(json.loads(result.text)["input"]) == inner
    assert result.error.startswith("structured output did not match the response schema: Output does not match")
    assert result.provider_cost_usd == pytest.approx(0.001666) and delays == []


def test_claude_cli_golden_output_wrapper_passes_through_unchanged(fake_cli, registry):
    """A schema-valid envelope whose object is ``{"output": "<json>"}`` (a lenient schema let it
    through) is ok at the boundary; unwrapping it is the engine's deterministic salvage."""
    wrapped = {"output": json.dumps({"kind": "answer", "text": "Hi."})}
    fake_cli.stdout_text = json.dumps(cli_envelope(structured_output=wrapped, result=json.dumps(wrapped)))
    result = call_model(text_request("claude-cli-haiku", response_format="json", purpose="assistant", schema={"type": "object"}), registry)
    assert result.ok and result.parsed == wrapped


# --- local Whisper (fake faster_whisper module; the real model only under the marker) ---------


class FakeSegment:
    def __init__(self, text: str) -> None:
        self.text = text


class FakeWhisperModel:
    instances: list["FakeWhisperModel"] = []
    fail_load: Optional[BaseException] = None
    fail_transcribe: Optional[BaseException] = None

    def __init__(self, name: str, **kwargs: Any) -> None:
        if FakeWhisperModel.fail_load is not None:
            raise FakeWhisperModel.fail_load
        self.name = name
        self.kwargs = kwargs
        self.calls: list[tuple[Any, dict[str, Any]]] = []
        FakeWhisperModel.instances.append(self)

    def transcribe(self, audio: Any, **kwargs: Any):
        if FakeWhisperModel.fail_transcribe is not None:
            raise FakeWhisperModel.fail_transcribe
        self.calls.append((audio, kwargs))
        segments = (s for s in (FakeSegment(" Move Aster north. "), FakeSegment(""), FakeSegment("Then pause.")))
        return segments, SimpleNamespace(language="en", duration=2.0)


@pytest.fixture()
def fake_whisper(monkeypatch):
    """A fake faster_whisper package behind model._import_sdk, and a fresh model state."""
    FakeWhisperModel.instances = []
    FakeWhisperModel.fail_load = None
    FakeWhisperModel.fail_transcribe = None
    decoded: list[tuple[bytes, int]] = []

    def decode_audio(fileobj: Any, sampling_rate: int = 16000) -> list[float]:
        data = fileobj.read()
        decoded.append((data, sampling_rate))
        if data == b"garbage":
            raise ValueError("Invalid data found when processing input")
        seconds = 0 if data == b"silence" else 2
        return [0.0] * (sampling_rate * seconds)

    cached: dict[str, bool] = {"value": True}

    def download_model(name: str, local_files_only: bool = False) -> str:
        assert local_files_only
        if not cached["value"]:
            raise RuntimeError("not in cache")
        return f"/cache/{name}"

    fake_module = SimpleNamespace(WhisperModel=FakeWhisperModel, decode_audio=decode_audio)
    fake_utils = SimpleNamespace(download_model=download_model)
    real_import = model._import_sdk

    def import_sdk(name: str) -> Any:
        if name == "faster_whisper":
            return fake_module
        if name == "faster_whisper.utils":
            return fake_utils
        return real_import(name)

    monkeypatch.setattr(model, "_import_sdk", import_sdk)
    real_installed = model._sdk_installed
    monkeypatch.setattr(model, "_sdk_installed", lambda name: True if name == "faster_whisper" else real_installed(name))
    monkeypatch.setattr(model, "_WHISPER_STATE", model._WhisperState())
    monkeypatch.setattr(config, "WHISPER_MODEL", "large-v3-turbo")
    return SimpleNamespace(decoded=decoded, cached=cached, module=fake_module)


def test_whisper_status_and_preload(fake_whisper):
    status = model.whisper_status()
    assert status.status == "disabled" and "not loaded" in (status.reason or "")
    assert (status.model, status.device, status.compute_type) == ("large-v3-turbo", "cpu", "int8")
    model.preload_whisper()
    assert model.whisper_status().status == "ready" and model.whisper_status().reason is None
    (loaded,) = FakeWhisperModel.instances
    assert loaded.name == "large-v3-turbo"
    assert loaded.kwargs == {"device": "cpu", "compute_type": "int8", "cpu_threads": config.WHISPER_CPU_THREADS}
    model.preload_whisper()
    assert len(FakeWhisperModel.instances) == 1  # loaded once per process
    assert model.whisper_model_cached() is True
    fake_whisper.cached["value"] = False
    assert model.whisper_model_cached("medium") is False


def test_transcribe_passes_language_prompt_vad_and_beam(fake_whisper, caplog):
    caplog.set_level("INFO", logger="empyrean.model")
    result = model.transcribe(b"webm-bytes", language="en-US", initial_prompt="  Aster, Borealis, step_round  ")
    assert result.status == "ok" and result.text == "Move Aster north. Then pause."
    assert result.language == "en" and result.duration_s == 2.0 and result.model == "large-v3-turbo" and result.error is None
    assert fake_whisper.decoded == [(b"webm-bytes", 16000)]
    (whisper_model,) = FakeWhisperModel.instances  # loaded lazily by the first call
    audio, kwargs = whisper_model.calls[0]
    assert len(audio) == 32000
    assert kwargs == {"language": "en", "initial_prompt": "Aster, Borealis, step_round", "vad_filter": True, "beam_size": 5}
    assert "Aster" not in caplog.text and "transcribe model=large-v3-turbo status=ok" in caplog.text
    for language in (None, "", "auto"):
        model.transcribe(b"webm-bytes", language=language, initial_prompt="")
        assert whisper_model.calls[-1][1]["language"] is None and whisper_model.calls[-1][1]["initial_prompt"] is None


def test_transcribe_rejections_never_raise(fake_whisper, monkeypatch):
    assert model.transcribe(b"").status == "error"
    assert model.transcribe("not bytes").status == "error"  # type: ignore[arg-type]
    bad = model.transcribe(b"garbage")
    assert bad.status == "error" and "could not decode the audio" in (bad.error or "")
    assert model.transcribe(b"silence").status == "error"
    monkeypatch.setattr(config, "WHISPER_MAX_SECONDS", 1)
    too_long = model.transcribe(b"webm-bytes")
    assert too_long.status == "error" and "limit is 1 s" in (too_long.error or "") and too_long.duration_s == 2.0
    monkeypatch.setattr(config, "WHISPER_MAX_SECONDS", 65)
    monkeypatch.setattr(config, "WHISPER_MAX_AUDIO_BYTES", 5)
    assert model.transcribe(b"webm-bytes").status == "error"
    monkeypatch.setattr(config, "WHISPER_MAX_AUDIO_BYTES", 10_000_000)
    FakeWhisperModel.fail_transcribe = RuntimeError("ctranslate2 blew up")
    crashed = model.transcribe(b"webm-bytes")
    assert crashed.status == "error" and "RuntimeError" in (crashed.error or "")


def test_whisper_load_failures_are_unavailable(fake_whisper, monkeypatch):
    FakeWhisperModel.fail_load = RuntimeError("model download failed")
    result = model.transcribe(b"webm-bytes", language="en")
    assert result.status == "unavailable" and "model download failed" in (result.error or "")
    status = model.whisper_status()
    assert status.status == "unavailable" and "could not load" in (status.reason or "")
    FakeWhisperModel.fail_load = None  # a failed load is retried on the next use
    assert model.transcribe(b"webm-bytes").status == "ok" and model.whisper_status().status == "ready"
    # package missing
    monkeypatch.setattr(model, "_WHISPER_STATE", model._WhisperState())
    monkeypatch.setattr(model, "_sdk_installed", lambda name: False)
    assert model.whisper_status().status == "unavailable"

    def no_package(name: str) -> Any:
        raise ImportError(f"No module named {name!r}", name=name)

    monkeypatch.setattr(model, "_import_sdk", no_package)
    missing = model.transcribe(b"webm-bytes")
    assert missing.status == "unavailable" and "not installed" in (missing.error or "")
    assert model.whisper_model_cached() is False


def test_whisper_can_be_switched_off(fake_whisper, monkeypatch):
    monkeypatch.setattr(config, "WHISPER_MODEL", "off")
    assert model.whisper_status().status == "disabled"
    model.preload_whisper()
    assert FakeWhisperModel.instances == []
    assert model.transcribe(b"webm-bytes").status == "unavailable"


WHISPER_TEST_AUDIO = Path(os.environ.get("EMPYREAN_WHISPER_TEST_AUDIO") or Path(__file__).parent / "data" / "jfk.flac")


@pytest.mark.whisper
def test_whisper_transcribes_the_jfk_sample(monkeypatch):
    """Real faster-whisper on CPU (config.WHISPER_MODEL): runs only when the model is already in
    the local cache and the sample exists (EMPYREAN_WHISPER_TEST_AUDIO or tests/data/jfk.flac,
    the 11 s public-domain JFK clip); never downloads."""
    if not WHISPER_TEST_AUDIO.is_file():
        pytest.skip(f"no test audio at {WHISPER_TEST_AUDIO}")
    if not model.whisper_model_cached():
        pytest.skip(f"whisper model {config.WHISPER_MODEL!r} is not cached locally")
    monkeypatch.setattr(model, "_WHISPER_STATE", model._WhisperState())  # load fresh, drop afterwards
    result = model.transcribe(WHISPER_TEST_AUDIO.read_bytes(), language="en", initial_prompt="Empyrean, Aster")
    assert result.status == "ok", result.error
    words = re.sub(r"[^a-z ]", "", result.text.lower())
    assert "ask not what your country can do for you" in words
    assert result.language == "en" and result.duration_s is not None and 10.0 < result.duration_s < 12.5
