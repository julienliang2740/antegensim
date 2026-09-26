"""
WP0 contract tests (rev 4): the shared-file changes the assistant packages build against.

* GET /api/models hides assistant-only refs unless ``include_assistant=1``; ModelInfo.assistant_only.
* ``ModelRegistry.validate_agent_key`` rejects assistant refs; ``validate_setup`` /
  ``validate_intervention_on`` use it (run setup, card keys, place_entity, update_model_assignment).
* Commit listener fan-out: a raising listener and a slow listener never break commits.
* ``runner.command_allowed`` and ``validate_intervention_on`` agree with the worker.
* New ``ApiErrorCode`` members render through ``_error_response``; 413 maps to payload_too_large.
* ``create_app`` without an assistant answers 503 assistant_unavailable on every assistant route;
  with an ``AssistantService`` the capabilities route works and the service shuts down cleanly.
* ``calls.call_profile`` records a ledger line (fake-scripted key; never a live model).
* ``config.ASSUMPTIONS`` has A-GOD-1 and the A-AST-* entries.
"""

from __future__ import annotations

import threading
import time
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from empyrean import config, model, runner
from empyrean.api import _error_response, create_app
from empyrean.schemas import ApiErrorCode, Intervention, ModelInfo, ModelRequest, ModelResult

ASSISTANT_KEYS = ("claude-cli-sonnet-assistant", "claude-cli-haiku-assistant", "fake-assistant")


def wait_idle(worker: runner.RunWorker, timeout: float = 20.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = worker.status().state
        if state in ("paused", "error", "finished"):
            return state
        time.sleep(0.01)
    raise AssertionError(f"worker did not settle: {worker.status().state}")


# ---------------------------------------------------------------------------
# Registry / models
# ---------------------------------------------------------------------------


def test_registry_marks_assistant_only_and_keeps_fake_order(registry: model.ModelRegistry) -> None:
    assert registry.keys()[:4] == ["fake-heuristic", "fake-scripted", "fake-malformed", "fake-assistant"]
    for key in ASSISTANT_KEYS:
        assert registry.info(key).assistant_only is True
        assert registry.is_assistant_only(key)
    assert registry.info("fake-heuristic").assistant_only is False
    assert ModelInfo.model_fields["assistant_only"].default is False


def test_validate_agent_key_rejects_assistant_refs(registry: model.ModelRegistry) -> None:
    assert registry.validate_agent_key("fake-heuristic") is None
    assert registry.validate_agent_key("fake-assistant") == "model 'fake-assistant' is reserved for the assistant"
    assert registry.validate_agent_key("no-such-key") == "unknown model key 'no-such-key'"
    # the plain check still accepts them (assistant profiles validate with validate_key)
    assert registry.validate_key("fake-assistant") is None


def test_api_models_hides_assistant_refs_unless_asked(client) -> None:
    keys = {m["key"] for m in client.get("/api/models").json()}
    assert keys and not (keys & set(ASSISTANT_KEYS))
    body = client.get("/api/models?include_assistant=1").json()
    all_keys = {m["key"] for m in body}
    assert set(ASSISTANT_KEYS) <= all_keys
    assert {m["key"]: m["assistant_only"] for m in body}["fake-assistant"] is True


def test_validate_setup_rejects_assistant_refs_for_agents(manager: runner.RunManager, default_request) -> None:
    request = default_request.model_copy(deep=True)
    request.default_model_key = "fake-assistant"
    request.agents[2].model_key = "fake-assistant"
    problems = {p.path: p.message for p in manager.validate_setup(request)}
    assert problems["default_model_key"] == "model 'fake-assistant' is reserved for the assistant"
    assert problems["agents[2].model_key"] == "model 'fake-assistant' is reserved for the assistant"
    assert client_ok(manager, default_request)


def client_ok(manager: runner.RunManager, request) -> bool:
    return manager.validate_setup(request) == []


def test_api_create_run_with_assistant_key_is_422_invalid_setup(client, default_request) -> None:
    body = default_request.model_dump(mode="json")
    body["default_model_key"] = "fake-assistant"
    r = client.post("/api/runs", json=body)
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_setup"
    assert any(p["path"] == "default_model_key" for p in r.json()["problems"])


# ---------------------------------------------------------------------------
# runner hooks
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "state,command,expected",
    [
        ("paused", "play", None),
        ("finished", "step_round", None),
        ("paused", "pause", None),
        ("running", "pause", None),
        ("running", "play", "illegal_command: play while running"),
        ("waiting_model", "run_turn", "illegal_command: run_turn while waiting_model"),
        ("error", "run_turn", "illegal_command: run_turn while error"),
        ("paused", "seek", "illegal_command: unknown command 'seek'"),
    ],
)
def test_command_allowed_matches_the_submit_rule(state: str, command: str, expected: Any) -> None:
    assert runner.command_allowed(state, command) == expected


def test_command_allowed_parity_with_run_worker_submit(manager: runner.RunManager, default_request) -> None:
    request = default_request.model_copy(update={"play_delay_seconds": 0.0})
    worker = manager.require(manager.create_run(request).run_id)
    assert runner.command_allowed(worker.status().state, "run_turn") is None
    worker.submit("run_turn")
    wait_idle(worker)
    # a second worker command while running is rejected with the very same message
    worker.submit("play")
    state = worker.status().state
    if state not in ("paused", "finished", "error"):
        with pytest.raises(runner.RunnerError) as exc:
            worker.submit("run_turn")
        assert str(exc.value) == runner.command_allowed(state, "run_turn")
    worker.submit("pause")
    wait_idle(worker)


def test_validate_intervention_on_matches_worker_and_uses_agent_key_rule(manager: runner.RunManager, default_request) -> None:
    worker = manager.require(manager.create_run(default_request).run_id)
    cp = worker.checkpoint
    adapter = TypeAdapter(Intervention)
    good = adapter.validate_python({"type": "set_stat", "entity_id": "a01", "field": "stats.compute", "value": 50})
    bad = adapter.validate_python({"type": "set_stat", "entity_id": "zz99", "field": "stats.compute", "value": 50})
    assign = adapter.validate_python({"type": "update_model_assignment", "scope": "run", "model_key": "fake-assistant"})
    place = adapter.validate_python(
        {"type": "place_entity", "entity": {"kind": "agent", "id": "", "name": "Newcomer", "position": {"x": 0, "y": 0}}, "model_key": "fake-assistant"}
    )
    for iv in (good, bad, assign, place):
        assert runner.validate_intervention_on(cp, manager.registry, worker.run_id, iv) == worker.validate_intervention(iv)
    assert runner.validate_intervention_on(cp, manager.registry, worker.run_id, good) == []
    assert runner.validate_intervention_on(cp, manager.registry, worker.run_id, bad)[0].path == "entity_id"
    assign_problems = runner.validate_intervention_on(cp, manager.registry, worker.run_id, assign)
    assert assign_problems and "reserved for the assistant" in assign_problems[0].message
    place_problems = runner.validate_intervention_on(cp, manager.registry, worker.run_id, place)
    assert place_problems and place_problems[0].path == "model_key" and "reserved" in place_problems[0].message
    # nothing was staged or written by validating
    assert worker.staged() == []


def test_commit_listeners_fan_out_and_never_break_commits(manager: runner.RunManager, default_request) -> None:
    seen: list[tuple[str, str, str, int]] = []
    slow_calls: list[str] = []

    def good(run_id: str, turn_id: str, kind: str, round_no: int) -> None:
        seen.append((run_id, turn_id, kind, round_no))

    def raising(run_id: str, turn_id: str, kind: str, round_no: int) -> None:
        raise RuntimeError("listener bug")

    def exploding(run_id: str, turn_id: str, kind: str, round_no: int) -> None:
        raise ValueError("another listener bug")

    def slow(run_id: str, turn_id: str, kind: str, round_no: int) -> None:
        time.sleep(0.05)
        slow_calls.append(turn_id)

    manager.add_commit_listener(raising)
    manager.add_commit_listener(exploding)
    manager.add_commit_listener(slow)
    manager.add_commit_listener(good)
    manager.add_commit_listener(good)  # idempotent registration
    request = default_request.model_copy(update={"play_delay_seconds": 0.0})
    worker = manager.require(manager.create_run(request).run_id)
    worker.submit("step_round")
    assert wait_idle(worker) == "paused"
    assert worker.status().last_error is None
    committed = [e.turn_id for e in manager.list_turns(worker.run_id)][1:]  # init is not a commit
    assert [s[1] for s in seen] == committed
    assert seen[-1][2] == "round_end" and seen[-1][0] == worker.run_id and seen[-1][3] == 1
    assert all(s[2] in ("agent_turn", "round_end") for s in seen)
    assert slow_calls == committed
    manager.remove_commit_listener(good)
    worker.submit("run_turn")
    wait_idle(worker)
    assert len(seen) == len(committed)  # removed listener is not called again


def test_worker_on_commit_hook_runs_after_the_swap(manager: runner.RunManager, default_request) -> None:
    observed: list[str] = []
    request = default_request.model_copy(update={"play_delay_seconds": 0.0})
    worker = manager.require(manager.create_run(request).run_id)

    def hook(run_id: str, turn_id: str, kind: str, round_no: int) -> None:
        observed.append(worker.checkpoint.turn.turn_id == turn_id and worker.status().current_turn_id == turn_id)

    worker._on_commit = hook  # the constructor parameter; set directly on the live worker for the test
    worker.submit("run_turn")
    wait_idle(worker)
    assert observed == [True]


# ---------------------------------------------------------------------------
# API error contract / assistant wiring
# ---------------------------------------------------------------------------

NEW_CODES = ("assistant_unavailable", "assistant_busy", "brief_not_pending", "assistant_budget_exhausted", "conversation_busy", "payload_too_large")


def test_new_api_error_codes_render() -> None:
    members = set(ApiErrorCode.__args__)  # type: ignore[attr-defined]
    assert set(NEW_CODES) <= members
    for code in NEW_CODES:
        response = _error_response(409, code, "detail")
        assert response.status_code == 409
        assert code.encode() in response.body


def test_assistant_routes_are_503_without_a_service(client) -> None:
    for method, path in [
        ("GET", "/api/assistant/capabilities"),
        ("GET", "/api/assistant/conversations"),
        ("POST", "/api/assistant/conversations"),
        ("GET", "/api/assistant/conversations/abc"),
        ("POST", "/api/assistant/conversations/abc/messages"),
        ("POST", "/api/assistant/conversations/abc/briefs/b/approve"),
        ("POST", "/api/assistant/transcribe"),
        ("GET", "/api/runs/run_x/assistant/settings"),
        ("PUT", "/api/runs/run_x/assistant/settings"),
        ("GET", "/api/runs/run_x/assistant/storybook"),
        ("POST", "/api/runs/run_x/assistant/storybook/generate"),
        ("GET", "/api/runs/run_x/assistant/stories"),
        ("POST", "/api/runs/run_x/assistant/stories/s/approve"),
    ]:
        r = client.request(method, path, json={} if method in ("POST", "PUT") else None)
        assert r.status_code == 503, (method, path, r.status_code)
        assert r.json()["error"] == "assistant_unavailable"
        assert r.json()["problems"] == []
    # unrelated routes are untouched
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/runs/run_x/status").json()["error"] == "run_not_open"


def test_http_413_maps_to_payload_too_large(manager: runner.RunManager) -> None:
    from fastapi import HTTPException
    from fastapi.testclient import TestClient

    app = create_app(manager)

    @app.get("/api/_test_413")
    def _too_large() -> None:
        raise HTTPException(status_code=413, detail="too big")

    with TestClient(app) as c:
        r = c.get("/api/_test_413")
    assert r.status_code == 413 and r.json() == {"error": "payload_too_large", "detail": "too big", "problems": []}


def test_create_app_with_assistant_service_serves_capabilities_and_shuts_down(manager: runner.RunManager, worlds_dir) -> None:
    from fastapi.testclient import TestClient

    from empyrean.assistant import AssistantService

    forbidden_calls: list[str] = []

    def forbidden(self, ref, request, attempt_no, **kwargs):  # never a live CLI call in tests
        forbidden_calls.append(ref.key)
        raise AssertionError("live adapter reached")

    original = model.ClaudeCliAdapter.attempt
    model.ClaudeCliAdapter.attempt = forbidden  # type: ignore[method-assign]
    try:
        service = AssistantService(manager, worlds_dir=worlds_dir)
        assert service.auto_live_allowed is False
        assert service.profile_keys["chat"] == config.ASSISTANT_MODEL_CHAT
        assert service.on_commit in manager._commit_listeners
        app = create_app(manager, service)
        assert app.state.assistant is service
        with TestClient(app) as c:
            body = c.get("/api/assistant/capabilities").json()
            assert [m["profile"] for m in body["models"]] == ["chat", "narrator", "author", "summarizer"]
            assert body["auto_live_allowed"] is False
            assert body["speech"]["status"] in ("ready", "loading", "unavailable", "disabled")
            assert body["budgets"]["overall"]["limit_usd"] == config.ASSISTANT_GLOBAL_BUDGET_USD
            assert c.get("/api/models").status_code == 200
        # the lifespan shut the service down: executors refuse work quietly, listener removed
        assert service.is_shut_down
        assert service.submit("chat", lambda: None) is None
        assert service.on_commit not in manager._commit_listeners
    finally:
        model.ClaudeCliAdapter.attempt = original  # type: ignore[method-assign]
    assert forbidden_calls == []


def test_call_profile_records_a_ledger_line_with_a_fake_key(manager: runner.RunManager, worlds_dir) -> None:
    from empyrean.assistant import AssistantService, calls
    from empyrean.assistant.ledger import BudgetExceeded

    service = AssistantService(manager, worlds_dir=worlds_dir)
    try:
        service.profile_keys["chat"] = "fake-scripted"
        script = [{"kind": "answer", "text": "hello", "refs": []}]
        result = calls.call_profile(
            service,
            "chat",
            system="rules",
            user="question",
            schema={"type": "object"},
            scope="global",
            metadata={"fake_script": script, "fake_script_index": 0},
            budgets=[service.chat_budget(None)],
        )
        assert result.ok and result.parsed == script[0]
        assert result.cost_usd == 0.0 and result.cost_estimated is True  # fake: no provider cost, zero list price
        agg = service.ledger.aggregate("global")
        assert agg.calls == 1 and agg.by_profile["chat"].calls == 1
        assert (worlds_dir / "_assistant" / "usage.jsonl").exists()
        # text mode: a string reply; JSON classification is WP1's, the ledger line is still written
        text_result = calls.call_profile(
            service, "chat", system="rules", user="q", text_mode=True, metadata={"fake_script": ["plain prose"], "fake_script_index": 0}
        )
        assert text_result.line.status in ("ok", "malformed")
        assert service.ledger.aggregate("global").calls == 2
        # budgets are checked before the call
        with pytest.raises(BudgetExceeded):
            calls.call_profile(service, "chat", system="s", user="u", budgets=[service.ledger.budget_view("global", "chat", 0.0)])
        assert service.ledger.aggregate("global").calls == 2
        # request shape: one system + one user message, assistant purpose, response_format
        request = calls.build_request(service, "narrator", system="s", user="u", schema=None, text_mode=True)
        assert [m.role for m in request.messages] == ["system", "user"]
        assert request.purpose == "narrative" and request.response_format == "text" and request.max_output_tokens == 600
        with pytest.raises(calls.PromptTooLarge):
            calls.build_request(service, "chat", system="x" * (config.ASSISTANT_SYSTEM_PROMPT_MAX_BYTES + 1), user="u", schema=None, text_mode=False)
    finally:
        service.shutdown()


def test_model_request_and_result_contract_additions() -> None:
    request = ModelRequest(request_id="r", model_key="fake-assistant", messages=[], purpose="assistant", response_format="text")
    assert request.response_format == "text"
    with pytest.raises(ValidationError):
        ModelRequest(request_id="r", model_key="k", messages=[], response_format="xml")  # type: ignore[arg-type]
    result = ModelResult(request_id="r", ok=False, status="error", provider="claude_cli", model_id="haiku", error_code="budget_exceeded")
    assert result.error_code == "budget_exceeded"
    with pytest.raises(ValidationError):
        ModelResult(request_id="r", ok=False, status="error", provider="p", model_id="m", error_code="nope")  # type: ignore[arg-type]


def test_call_model_accepts_cancel_and_boundary_stubs_never_raise(registry: model.ModelRegistry) -> None:
    request = ModelRequest(request_id="as_x_01", model_key="fake-scripted", messages=[], metadata={"fake_script": [{"a": 1}], "fake_script_index": 0})
    result = model.call_model(request, registry, cancel=threading.Event())
    assert result.ok and result.parsed == {"a": 1}
    assert model.kill_inflight() == 0
    assert model.whisper_status().status in ("ready", "loading", "unavailable", "disabled")
    assert model.transcribe(b"", language="en").status in ("ok", "error", "unavailable")


def test_assumptions_registry_has_god_and_assistant_entries() -> None:
    assert "A-GOD-1" in config.ASSUMPTIONS
    ast = [k for k in config.ASSUMPTIONS if k.startswith("A-AST-")]
    assert ast == [f"A-AST-{i}" for i in range(1, 11)]
    ids = {e.id for e in config.assumption_entries()}
    assert "A-GOD-1" in ids and "A-AST-1" in ids
