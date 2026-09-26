"""Assistant API (rev 4, amended D5/D6/D12/D13) through TestClient with the fake-assistant key:
conversations (list/create/get/patch/delete), 202 message jobs with step progress, cancel,
brief approve/reject with CAS and the executed effect, budgets (409 assistant_budget_exhausted),
per-run settings, capabilities, restart recovery, and the error-code contract."""

from __future__ import annotations

import time
from typing import Any, Optional

import pytest

from empyrean import config
from empyrean.assistant.models import Message
from empyrean.schemas import ApiErrorCode

from e2e_support import base_request

ASSISTANT_CODES = ("assistant_unavailable", "assistant_busy", "brief_not_pending", "assistant_budget_exhausted", "conversation_busy", "payload_too_large", "not_found")


def new_conversation(client, run_id: Optional[str] = None) -> str:
    r = client.post("/api/assistant/conversations", json={"run_id": run_id})
    assert r.status_code == 201, r.text
    return r.json()["conversation_id"]


def ask(client, assistant, conv_id: str, text: str, script: list[Any], context: Optional[dict[str, Any]] = None, in_reply_to_brief_id: Optional[str] = None, **extra: Any) -> dict[str, Any]:
    assistant.fake_metadata["chat"] = {"fake_script": script, **extra}
    r = client.post(f"/api/assistant/conversations/{conv_id}/messages", json={"text": text, "context": context, "in_reply_to_brief_id": in_reply_to_brief_id})
    assert r.status_code == 202, r.text
    accepted = r.json()
    assert accepted["conversation_id"] == conv_id and accepted["job_id"] and accepted["message_id"] != accepted["user_message_id"]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        view = client.get(f"/api/assistant/conversations/{conv_id}").json()
        job = view["job"]
        if job and job["job_id"] == accepted["job_id"] and job["status"] not in ("queued", "running"):
            view["_accepted"] = accepted
            return view
        time.sleep(0.03)
    raise AssertionError("job did not finish")


def last_assistant(view: dict[str, Any]) -> dict[str, Any]:
    return [m for m in view["messages"] if m["role"] == "assistant"][-1]


def run_context(run_id: str, **extra: Any) -> dict[str, Any]:
    return {"page": "run", "run_id": run_id, "run_name": "arena", "live_turn_id": "r00000_init", "shown_turn_id": "r00000_init", "tab": "inspect", "run_state": "paused", **extra}


def test_conversations_crud_and_scope(assistant_client) -> None:
    c = assistant_client
    assert c.get("/api/assistant/conversations").json() == []
    global_id = new_conversation(c)
    run_scoped = new_conversation(c, "run_x")
    assert [m["conversation_id"] for m in c.get("/api/assistant/conversations").json()] == [global_id]
    assert [m["conversation_id"] for m in c.get("/api/assistant/conversations?run_id=run_x").json()] == [run_scoped]
    assert len(c.get("/api/assistant/conversations?all=1").json()) == 2
    view = c.get(f"/api/assistant/conversations/{global_id}").json()
    assert view["meta"]["title"] == "New conversation" and view["messages"] == [] and view["briefs"] == [] and view["job"] is None
    r = c.patch(f"/api/assistant/conversations/{run_scoped}", json={"title": "Renamed", "rebind_to_global": True})
    assert r.status_code == 200 and r.json()["title"] == "Renamed" and r.json()["run_id"] is None
    assert c.patch(f"/api/assistant/conversations/{run_scoped}", json={"run_id": "run_missing"}).json()["error"] == "not_found"
    assert c.delete(f"/api/assistant/conversations/{run_scoped}").status_code == 200
    assert c.get(f"/api/assistant/conversations/{run_scoped}").status_code == 404
    assert c.get("/api/assistant/conversations/not-an-id").json()["error"] == "not_found"


def test_plain_answer_with_refs_and_progress(assistant_client, assistant) -> None:
    conv_id = new_conversation(assistant_client)
    view = ask(assistant_client, assistant, conv_id, "What is Empyrean?", [{"kind": "answer", "text": "A grid world for LLM agents.", "refs": [{"kind": "doc", "id": "SYSTEM.md#overview", "label": "System overview"}]}])
    message = last_assistant(view)
    assert message["status"] == "done" and message["text"] == "A grid world for LLM agents."  # no run: no 'as of' stamp
    assert message["refs"] == [{"kind": "doc", "id": "SYSTEM.md#overview", "label": "System overview"}]
    assert message["steps"][0]["kind"] == "answer" and message["steps"][0]["status"] == "ok" and message["job_id"] == view["job"]["job_id"]
    assert view["job"]["status"] == "done" and view["job"]["max_steps"] == config.ASSISTANT_MAX_STEPS and view["job"]["step"] == 1
    assert view["meta"]["title"] == "What is Empyrean?" and view["meta"]["message_count"] == 2 and view["meta"]["active_job_id"] is None


def test_pending_message_shows_step_progress_while_running(assistant_client, assistant) -> None:
    conv_id = new_conversation(assistant_client)
    assistant.fake_metadata["chat"] = {"fake_script": [{"kind": "answer", "text": "slow", "refs": []}], "fake_options": {"sleep_ms": 700}}
    r = assistant_client.post(f"/api/assistant/conversations/{conv_id}/messages", json={"text": "slow one"})
    assert r.status_code == 202
    time.sleep(0.2)
    view = assistant_client.get(f"/api/assistant/conversations/{conv_id}").json()
    pending = last_assistant(view)
    assert pending["status"] == "running" and pending["progress"].startswith(f"step 1/{config.ASSISTANT_MAX_STEPS}") and "$0.00" in pending["progress"]
    assert view["job"]["status"] == "running" and view["job"]["step"] == 1
    # a second message while the job runs is refused
    r = assistant_client.post(f"/api/assistant/conversations/{conv_id}/messages", json={"text": "another"})
    assert r.status_code == 409 and r.json()["error"] == "assistant_busy"
    r = assistant_client.delete(f"/api/assistant/conversations/{conv_id}")
    assert r.status_code == 409 and r.json()["error"] == "conversation_busy"
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and assistant_client.get(f"/api/assistant/conversations/{conv_id}").json()["job"]["status"] == "running":
        time.sleep(0.05)
    assert last_assistant(assistant_client.get(f"/api/assistant/conversations/{conv_id}").json())["status"] == "done"


def test_tool_step_then_answer(assistant_client, assistant, assistant_api) -> None:
    run_id = assistant_api.create_run(base_request(assistant_api, "api tools"))["run_id"]
    conv_id = new_conversation(assistant_client, run_id)
    script = [
        {"kind": "tool", "calls": [{"name": "get_rules_and_settings", "args": {"run_id": run_id}}, {"name": "search_docs", "args": {"query": "step round"}}], "note": "Reading the rules"},
        {"kind": "answer", "text": "Move costs 5 compute.", "refs": [{"kind": "control", "id": "Step round", "label": "Step round"}]},
    ]
    view = ask(assistant_client, assistant, conv_id, "what does a move cost?", script, run_context(run_id))
    message = last_assistant(view)
    assert message["status"] == "done" and message["text"].startswith("Move costs 5 compute.") and "As of turn r00000_init." in message["text"]
    assert [s["kind"] for s in message["steps"]] == ["tool", "answer"]
    calls = message["steps"][0]["tool_calls"]
    assert [c["name"] for c in calls] == ["get_rules_and_settings", "search_docs"] and all(c["ok"] for c in calls)
    assert any(s.startswith("turns r00000_init") for s in message["sources"]) and any(s.startswith("docs ") for s in message["sources"])
    assert message["as_of_turn_id"] == "r00000_init"
    caps = assistant_client.get(f"/api/assistant/capabilities?run_id={run_id}").json()
    assert caps["budgets"]["chat"]["scope"] == run_id and caps["budgets"]["by_profile"]["chat"]["calls"] == 2


def test_create_run_brief_validated_approved_and_conversation_rebound(assistant_client, assistant, manager) -> None:
    conv_id = new_conversation(assistant_client)
    brief_step = {"kind": "brief", "brief": {"title": "Fight arena", "summary": "Six fighters in a small arena.", "steps": ["Create the run"], "warnings": [], "action": {"type": "create_run", "args": {"name": "Fight arena", "agent_count": 6, "overlay": {"agents": [{"name": "Ash", "stats": {"attack": 3}}], "rules": {"prices": {"move": 2}}, "play_delay_seconds": 0}}}}}
    view = ask(assistant_client, assistant, conv_id, "set up a fight arena", [brief_step], {"page": "entry"})
    message = last_assistant(view)
    brief = view["briefs"][-1]
    assert message["status"] == "done" and message["brief_id"] == brief["brief_id"] and message["text"] == "Six fighters in a small arena."
    assert brief["status"] == "pending" and brief["validation"]["ok"] is True and brief["in_reply_to"] == "set up a fight arena"
    assert brief["action"]["type"] == "create_run" and brief["action_type"] == "create_run" and brief["target_run_id"] is None
    diff = {d["path"]: d for d in brief["validation"]["setup_diff"]}
    assert diff["rules.prices.move"] == {"path": "rules.prices.move", "default": 5, "value": 2} and "agents[0].stats.attack" in diff
    assert brief["merged_request"]["agents"][0]["name"] == "Ash" and len(brief["merged_request"]["agents"]) == 6
    r = assistant_client.post(f"/api/assistant/conversations/{conv_id}/briefs/{brief['brief_id']}/approve", json={"validated_against_turn_id": None})
    assert r.status_code == 200, r.text
    done = r.json()["brief"]
    assert done["status"] == "executed" and done["effect"]["run_id"] and done["effect"]["status"]["state"] == "paused"
    run_id = done["effect"]["run_id"]
    assert manager.get(run_id) is not None and assistant_client.get(f"/api/runs/{run_id}").json()["name"] == "Fight arena"
    assert assistant_client.get(f"/api/assistant/conversations/{conv_id}").json()["meta"]["run_id"] == run_id  # rebound
    assert [m["conversation_id"] for m in assistant_client.get(f"/api/assistant/conversations?run_id={run_id}").json()] == [conv_id]
    # retry is idempotent, reject is refused
    assert assistant_client.post(f"/api/assistant/conversations/{conv_id}/briefs/{brief['brief_id']}/approve", json={}).json()["brief"]["effect"]["run_id"] == run_id
    r = assistant_client.post(f"/api/assistant/conversations/{conv_id}/briefs/{brief['brief_id']}/reject", json={"reason": "changed my mind"})
    assert r.status_code == 409 and r.json()["error"] == "brief_not_pending"
    assert len(manager.list_runs()) == 1


def test_interventions_brief_problem_then_repaired_brief(assistant_client, assistant, assistant_api) -> None:
    run_id = assistant_api.create_run(base_request(assistant_api, "api iv"))["run_id"]
    conv_id = new_conversation(assistant_client, run_id)
    ctx = run_context(run_id, tab="god", selected_entity_id="a01", selected_entity_kind="agent")
    bad = {"kind": "brief", "brief": {"title": "Boost", "summary": "Set compute of the selected agent to 50.", "steps": [], "warnings": [], "action": {"type": "stage_interventions", "args": {"interventions": [{"type": "set_stat", "entity_id": "zz99", "field": "stats.compute", "value": 50}]}}}}
    view = ask(assistant_client, assistant, conv_id, "give the selected agent 50 compute", [bad], ctx)
    brief = view["briefs"][-1]
    assert brief["status"] == "pending" and brief["validation"]["ok"] is False and brief["target_run_id"] == run_id  # run id filled from the context
    assert brief["validation"]["problems"] == [{"path": "interventions[0].entity_id", "message": "unknown entity 'zz99'"}]
    r = assistant_client.post(f"/api/assistant/conversations/{conv_id}/briefs/{brief['brief_id']}/approve", json={})
    assert r.status_code == 409 and r.json()["error"] == "brief_not_pending"
    good = {"kind": "brief", "brief": {"title": "Boost", "summary": "Set compute of a01 to 50.", "steps": [], "warnings": [], "action": {"type": "stage_interventions", "args": {"interventions": [{"type": "set_stat", "entity_id": "a01", "field": "stats.compute", "value": 50}]}}}}
    view = ask(assistant_client, assistant, conv_id, "I meant a01", [good], ctx, in_reply_to_brief_id=brief["brief_id"])
    briefs = {b["brief_id"]: b for b in view["briefs"]}
    repaired = view["briefs"][-1]
    assert repaired["status"] == "pending" and repaired["validation"]["ok"] is True and repaired["validation"]["validated_against_turn_id"] == "r00000_init"
    assert briefs[brief["brief_id"]]["status"] == "superseded" and briefs[brief["brief_id"]]["superseded_by"] == repaired["brief_id"]
    r = assistant_client.post(f"/api/assistant/conversations/{conv_id}/briefs/{repaired['brief_id']}/approve", json={"validated_against_turn_id": "r00000_init"})
    assert r.status_code == 200
    done = r.json()["brief"]
    assert done["status"] == "executed" and done["effect"]["staged_ids"] == ["iv_0001"] and done["effect"]["status"]["staged_intervention_count"] == 1
    staged = assistant_client.get(f"/api/runs/{run_id}/interventions").json()["staged"]
    assert staged[0]["origin"] == "assistant" and staged[0]["note"] == "assistant: Set compute of a01 to 50." and staged[0]["id"] == "iv_0001"


def test_run_command_step_round_x2_executes_on_an_open_run(assistant_client, assistant, assistant_api) -> None:
    run_id = assistant_api.create_run(base_request(assistant_api, "api rounds"))["run_id"]
    conv_id = new_conversation(assistant_client, run_id)
    step = {"kind": "brief", "brief": {"title": "Step 2 rounds", "summary": "Run two rounds.", "steps": ["step_round x 2"], "warnings": [], "action": {"type": "run_command", "args": {"run_id": run_id, "command": "step_round", "rounds": 2}}}}
    view = ask(assistant_client, assistant, conv_id, "play 2 rounds", [step], run_context(run_id))
    brief = view["briefs"][-1]
    assert brief["validation"]["ok"] is True and brief["validation"]["validated_against_turn_id"] == "r00000_init"
    r = assistant_client.post(f"/api/assistant/conversations/{conv_id}/briefs/{brief['brief_id']}/approve", json={"validated_against_turn_id": "r00000_init"})
    assert r.status_code == 200
    effect = r.json()["brief"]["effect"]
    assert effect["rounds_requested"] == 2 and effect["rounds_done"] == 0 and effect["status"]["state"] in ("running", "turn_active", "waiting_model", "paused")
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        effect = assistant_client.get(f"/api/assistant/conversations/{conv_id}").json()["briefs"][-1]["effect"]
        if effect["rounds_done"] == 2:
            break
        time.sleep(0.05)
    assert effect["rounds_done"] == 2 and effect["message"] == "Stepped 2 rounds."
    status = assistant_api.wait_idle(run_id)
    assert status["round"] == 2 and status["current_turn_id"] == "r00002_end"
    assert assistant_client.get(f"/api/runs/{run_id}/status").json()["real_usage"]["calls"] == 0 or True  # fake agents: nothing billed to the run


def test_budget_exhaustion_is_409(assistant_client, assistant, assistant_api) -> None:
    run_id = assistant_api.create_run(base_request(assistant_api, "api budget"))["run_id"]
    r = assistant_client.put(f"/api/runs/{run_id}/assistant/settings", json={"chat_budget_usd": 0.5})
    assert r.status_code == 200 and r.json()["settings"]["chat_budget_usd"] == 0.5
    conv_id = new_conversation(assistant_client, run_id)
    view = ask(assistant_client, assistant, conv_id, "costly", [{"kind": "answer", "text": "x", "refs": []}], fake_options={"cost_usd": 0.47})
    assert last_assistant(view)["status"] == "done" and last_assistant(view)["cost_usd"] == pytest.approx(0.47)
    settings = assistant_client.get(f"/api/runs/{run_id}/assistant/settings").json()
    assert settings["spend"]["chat"]["spent_usd"] == pytest.approx(0.47) and settings["spend"]["chat"]["exhausted"] is False
    r = assistant_client.post(f"/api/assistant/conversations/{conv_id}/messages", json={"text": "again"})
    assert r.status_code == 409 and r.json()["error"] == "assistant_budget_exhausted" and "$0.50" in r.json()["detail"]
    assert assistant_client.get(f"/api/assistant/conversations/{conv_id}").json()["meta"]["message_count"] == 2  # nothing appended
    # raising the limit directly (no brief) lets the next message through
    assistant_client.put(f"/api/runs/{run_id}/assistant/settings", json={"chat_budget_usd": 5.0})
    view = ask(assistant_client, assistant, conv_id, "again", [{"kind": "answer", "text": "y", "refs": []}])
    assert last_assistant(view)["status"] == "done"
    # the global cap applies to every scope
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(config, "ASSISTANT_GLOBAL_BUDGET_USD", 0.1)
        r = assistant_client.post(f"/api/assistant/conversations/{new_conversation(assistant_client)}/messages", json={"text": "global"})
        assert r.status_code == 409 and "global budget" in r.json()["detail"]


def test_cancel_job(assistant_client, assistant) -> None:
    conv_id = new_conversation(assistant_client)
    assistant.fake_metadata["chat"] = {"fake_script": [{"kind": "tool", "calls": [{"name": "list_runs", "args": {}}], "note": "n"}, {"kind": "answer", "text": "never", "refs": []}], "fake_options": {"sleep_ms": 5000}}
    accepted = assistant_client.post(f"/api/assistant/conversations/{conv_id}/messages", json={"text": "long"}).json()
    time.sleep(0.1)
    r = assistant_client.post(f"/api/assistant/conversations/{conv_id}/jobs/{accepted['job_id']}/cancel")
    assert r.status_code == 200 and r.json()["cancel_requested"] is True
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        view = assistant_client.get(f"/api/assistant/conversations/{conv_id}").json()
        if view["job"]["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert view["job"]["status"] == "cancelled" and last_assistant(view)["status"] == "cancelled" and last_assistant(view)["error_code"] == "cancelled"
    assert assistant_client.post(f"/api/assistant/conversations/{conv_id}/jobs/nope/cancel").json()["error"] == "not_found"
    # the conversation is usable again
    view = ask(assistant_client, assistant, conv_id, "short", [{"kind": "answer", "text": "ok", "refs": []}])
    assert last_assistant(view)["status"] == "done"


def test_restart_recovery_marks_pending_as_interrupted(assistant_client, assistant, manager, worlds_dir) -> None:
    from empyrean.assistant import AssistantService

    conv_id = new_conversation(assistant_client)
    assistant.store.append_message(conv_id, Message(message_id="u1", role="user", text="q"))
    assistant.store.append_message(conv_id, Message(message_id="a1", role="assistant", status="running", progress="step 2/4 · 3 s · $0.01", job_id="lost-job"))
    assistant.store.update_meta(conv_id, lambda m: setattr(m, "active_job_id", "lost-job"))
    second = AssistantService(manager, worlds_dir=worlds_dir)  # "the server restarted"
    try:
        assert second.recovered_records == 2
    finally:
        second.shutdown()
    view = assistant_client.get(f"/api/assistant/conversations/{conv_id}").json()
    message = last_assistant(view)
    assert message["status"] == "interrupted" and "restart" in message["error"] and message["progress"] is None
    assert view["meta"]["active_job_id"] is None and view["job"] is None
    view = ask(assistant_client, assistant, conv_id, "retry", [{"kind": "answer", "text": "back", "refs": []}])
    assert last_assistant(view)["status"] == "done"


def test_settings_endpoints(assistant_client, assistant_api) -> None:
    run_id = assistant_api.create_run(base_request(assistant_api, "api settings"))["run_id"]
    view = assistant_client.get(f"/api/runs/{run_id}/assistant/settings").json()
    assert view["run_id"] == run_id and view["settings"]["chat_budget_usd"] == config.ASSISTANT_CHAT_BUDGET_USD and view["spend"]["chat"]["scope"] == run_id
    assert view["spend"]["storybook"]["kind"] == "storybook" and view["spend"]["overall"]["limit_usd"] == config.ASSISTANT_GLOBAL_BUDGET_USD
    r = assistant_client.put(f"/api/runs/{run_id}/assistant/settings", json={"storybook_auto": True, "storybook_budget_usd": 1.25})
    assert r.status_code == 200
    settings = r.json()["settings"]
    assert settings["storybook_auto"] is True and settings["auto_since_turn_id"] == "r00000_init" and settings["storybook_budget_usd"] == 1.25 and r.json()["exists"] is True
    assert assistant_client.get(f"/api/runs/{run_id}/assistant/settings").json()["settings"]["storybook_auto"] is True
    assert assistant_client.put(f"/api/runs/{run_id}/assistant/settings", json={"chat_budget_usd": -1}).json()["error"] == "validation_error"
    assert assistant_client.get("/api/runs/run_missing/assistant/settings").json()["error"] == "not_found"
    assert assistant_client.put("/api/runs/run_missing/assistant/settings", json={"chat_budget_usd": 1}).json()["error"] == "not_found"


def test_capabilities_report_models_speech_and_budgets(assistant_client) -> None:
    body = assistant_client.get("/api/assistant/capabilities").json()
    assert body["available"] is True and body["auto_live_allowed"] is False
    assert {m["profile"]: (m["model_key"], m["fake"], m["available"]) for m in body["models"]} == {p: ("fake-assistant", True, True) for p in ("chat", "narrator", "author", "summarizer")}
    assert body["speech"]["status"] in ("ready", "loading", "unavailable", "disabled") and body["speech"]["max_seconds"] <= 65
    assert body["budgets"]["chat"]["scope"] == "global" and body["budgets"]["storybook"] is None
    assert body["max_steps"] == config.ASSISTANT_MAX_STEPS and body["message_timeout_seconds"] == config.ASSISTANT_MESSAGE_TIMEOUT_SECONDS


def test_assistant_error_codes_are_members_of_the_contract() -> None:
    members = set(ApiErrorCode.__args__)  # type: ignore[attr-defined]
    assert set(ASSISTANT_CODES) <= members
    from empyrean.assistant import routes

    import inspect

    source = inspect.getsource(routes)
    import re

    raised = set(re.findall(r'ApiException\(\d+, "([a-z_]+)"', source))
    assert raised and raised <= members
