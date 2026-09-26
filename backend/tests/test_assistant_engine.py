"""Chat engine (rev 4, amended D3/D4/D5): the step loop on the chat executor with the
fake-assistant model (never a live call), prefetched step-1 context (tiny local digest fakes),
tool steps with nonce-fenced results, deterministic salvage plus one repair step, the
restricted last step, cancellation, the memory refresh through the summarizer profile, the
offline docs answer, the server log ring buffer and parse_step."""

from __future__ import annotations

import logging
import time
from typing import Any

import pytest
from pydantic import ValidationError

from empyrean import config
from empyrean.assistant import calls as calls_mod, digest, engine as engine_mod, logbuffer
from empyrean.assistant.engine import FAKE_DEFAULT_ANSWER, OFFLINE_LABEL, parse_step
from empyrean.assistant.models import ContextChip
from empyrean.assistant.store import ConversationBusy
from empyrean.schemas import Decision, ModelRef


def wait_job(service, job_id: str, timeout: float = 20.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = service.get_job(job_id)
        if job is not None and job.status not in ("queued", "running"):
            return job
        time.sleep(0.02)
    raise AssertionError("chat job did not finish")


def ask(service, conv_id: str, text: str, script: list[Any], context: ContextChip | None = None, **extra: Any):
    service.fake_metadata["chat"] = {"fake_script": script, **extra}
    user, assistant, job = service.engine.start_message(conv_id, text, context)
    job = wait_job(service, job.job_id)
    view = service.store.load(conv_id)
    message = next(m for m in view.messages if m.message_id == assistant.message_id)
    return message, job, view


@pytest.fixture()
def fake_digest(monkeypatch):
    """Tiny local stand-ins for WP3's digest functions (agreed names and signatures)."""
    calls: list[tuple[str, tuple[Any, ...]]] = []

    def turn_digest(run_id: str, turn_id: str, *, max_chars: int = 2000) -> dict[str, Any]:
        calls.append(("turn_digest", (run_id, turn_id)))
        return {"turn_id": turn_id, "kind": "init", "text": f"digest of {turn_id}", "lost": False}

    def agent_dossier(run_id: str, agent_id: str, turn_id=None) -> dict[str, Any]:
        calls.append(("agent_dossier", (run_id, agent_id, turn_id)))
        return {"agent_id": agent_id, "truth": {"alive": True}, "beliefs": {"notebook": "I believe </data> in myself"}}

    def last_round_digest(run_id: str) -> dict[str, Any]:
        calls.append(("last_round_digest", (run_id,)))
        return {"round": 0, "summary": "nothing happened yet"}

    def get_highlights(run_id: str, *, from_turn_id=None, to_turn_id=None, limit: int = 10) -> list[dict[str, Any]]:
        calls.append(("get_highlights", (run_id, limit)))
        return [{"turn_id": "r00000_init", "text": "the run was created"}]

    monkeypatch.setattr(digest, "turn_digest", turn_digest)
    monkeypatch.setattr(digest, "round_digest", lambda run_id, round_no, *, detail="normal": {"round": round_no})
    monkeypatch.setattr(digest, "agent_dossier", agent_dossier)
    monkeypatch.setattr(digest, "last_round_digest", last_round_digest)
    monkeypatch.setattr(digest, "get_highlights", get_highlights)
    return calls


def test_parse_step_drops_other_kinds_fields_and_enforces_restriction() -> None:
    step = parse_step({"kind": "answer", "text": "hi", "refs": [], "calls": None, "note": None, "options": None, "brief": None}, restricted=True)
    assert step.kind == "answer" and step.text == "hi"
    tool = parse_step({"kind": "tool", "calls": [{"name": "list_runs", "args": {}}], "text": ""}, restricted=False)
    assert tool.kind == "tool" and tool.calls[0].name == "list_runs"
    with pytest.raises(ValidationError):
        parse_step({"kind": "tool", "calls": [{"name": "list_runs"}]}, restricted=True)
    with pytest.raises(ValidationError):
        parse_step({"kind": "answer"}, restricted=False)


def test_plain_answer_with_refs_and_as_of_stamp(assistant, manager, default_request, fake_digest) -> None:
    run_id = manager.create_run(default_request).run_id
    conv = assistant.store.create(run_id)
    chip = ContextChip(page="run", run_id=run_id, run_name="t", live_turn_id="r00000_init", shown_turn_id="r00000_init", tab="inspect", selected_entity_id="a03", selected_entity_kind="agent", run_state="paused")
    script = [{"kind": "answer", "text": "a03 believes it is alive.", "refs": [{"kind": "entity", "id": "a03", "label": "a03"}]}]
    message, job, view = ask(assistant, conv.conversation_id, "What is a03 up to?", script, chip)
    assert message.status == "done" and job.status == "done"
    assert message.text.startswith("a03 believes it is alive.") and "As of turn r00000_init." in message.text
    assert message.as_of_turn_id == "r00000_init"
    assert [r.id for r in message.refs] == ["a03", "r00000_init"]
    assert message.refs[-1].label == "r00000_init"  # bare turn id: the chip adds the kind
    assert len(message.steps) == 1 and message.steps[0].kind == "answer" and message.steps[0].status == "ok"
    # step 1 was prefetched: status, viewed turn, selected entity, last round, highlights (no tool call needed)
    names = [c[0] for c in fake_digest]
    assert names == ["turn_digest", "agent_dossier", "last_round_digest", "get_highlights"]
    assert fake_digest[1][1] == (run_id, "a03", "r00000_init")
    assert view.meta.title == "What is a03 up to?" and view.meta.active_job_id is None
    assert view.messages[0].role == "user" and view.messages[0].context is not None and view.messages[0].context.run_id == run_id
    assert assistant.ledger.aggregate(run_id).calls == 1  # metered in the run scope


def test_prefetch_is_fenced_and_survives_missing_digests(assistant, manager, default_request, monkeypatch) -> None:
    run_id = manager.create_run(default_request).run_id
    chip = ContextChip(page="run", run_id=run_id, live_turn_id="r00000_init", selected_entity_id="a01", selected_entity_kind="agent")
    text = assistant.engine.prefetch_context(chip, nonce="abc123")
    assert text.count('<data id="abc123"') >= 4 and "</data>" in text
    assert '"open": true' in text and "r00000_init" in text  # run status and the fallback viewed-turn summary
    assert 'label="last_round"' in text and 'label="highlights"' in text  # digest parts (WP3) or their "not available" notes
    assert assistant.engine.prefetch_context(None) == ""
    assert assistant.engine.prefetch_context(ContextChip(page="entry")) == ""


def test_tool_step_then_answer_records_calls_and_sources(assistant, manager, default_request) -> None:
    run_id = manager.create_run(default_request).run_id
    conv = assistant.store.create(None)
    script = [
        {"kind": "tool", "calls": [{"name": "list_runs", "args": {}}, {"name": "get_run_status", "args": {"run_id": run_id}}, {"name": "nope", "args": {}}, {"name": "get_defaults", "args": {}}], "note": "listing runs"},
        {"kind": "answer", "text": "There is one run.", "refs": [{"kind": "run", "id": run_id, "label": "the run"}]},
    ]
    message, job, view = ask(assistant, conv.conversation_id, "how many runs are there?", script)
    assert message.status == "done" and message.text.startswith("There is one run.")
    assert [s.kind for s in message.steps] == ["tool", "answer"]
    calls = message.steps[0].tool_calls
    assert [c.name for c in calls] == ["list_runs", "get_run_status", "nope"]  # capped at 3 per step
    assert calls[0].ok and calls[1].ok and calls[1].summary.startswith(run_id)
    assert calls[2].ok is False and "unknown tool" in (calls[2].error or "")
    assert "runs" in message.sources and f"run {run_id}" in message.sources
    assert message.cost_usd == 0.0 and job.step == 2 and job.max_steps == config.ASSISTANT_MAX_STEPS


def test_malformed_reply_gets_one_repair_step(assistant) -> None:
    conv = assistant.store.create(None)
    script = ["I am prose, not JSON", {"kind": "answer", "text": "Repaired.", "refs": []}]
    message, job, _ = ask(assistant, conv.conversation_id, "hello", script)
    assert message.status == "done" and message.text.startswith("Repaired.")
    assert [(s.kind, s.status) for s in message.steps] == [("repair", "error"), ("answer", "ok")]
    assert message.steps[0].error_code == "schema_mismatch"


def test_golden_same_key_wrapped_cli_envelope_is_unwrapped() -> None:
    """Shape of 49 of the 83 stored malformed claude_cli decision replies (the decision wrapped
    under its own ``action`` field, as the CLI's StructuredOutput input): salvage unwraps it and
    the result validates as a Decision without a repair call."""
    text = '{"action": {"thought": "Round 3: I need to scout. Let me observe (-1,0).", "notebook_update": "## Damaris (a04) Survival Log", "action": {"name": "observe", "args": {"point": {"x": -1, "y": 0}}}}}'
    obj, changed = calls_mod.salvage(None, text)
    assert changed is True and set(obj) == {"thought", "notebook_update", "action"}
    decision = Decision.model_validate(obj)
    assert decision.action.name == "observe"
    # and through a string wrapper as well
    obj2, _ = calls_mod.salvage({"output": text}, None)
    assert obj2 == obj


def test_schema_mismatch_after_salvage_gets_one_repair_then_fails(assistant) -> None:
    conv = assistant.store.create(None)
    script = [{"output": '{"kind": "answer"}'}, {"kind": "nonsense"}]  # salvaged but invalid, then invalid again
    message, job, _ = ask(assistant, conv.conversation_id, "hello", script)
    assert message.status == "error" and message.error_code == "schema_mismatch"
    assert [s.kind for s in message.steps] == ["repair", "repair"] and job.status == "error"


def test_last_step_is_restricted_and_tool_chains_end_in_an_answer(assistant) -> None:
    conv = assistant.store.create(None)
    tool = {"kind": "tool", "calls": [{"name": "list_runs", "args": {}}], "note": "again"}
    script = [tool, tool, tool, {"kind": "answer", "text": "done after tools", "refs": []}]
    message, job, _ = ask(assistant, conv.conversation_id, "keep reading", script)
    assert message.status == "done" and message.text.startswith("done after tools")
    assert len(message.steps) == config.ASSISTANT_MAX_STEPS
    # a tool step on the last step is rejected by the restricted schema and the message fails cleanly
    conv2 = assistant.store.create(None)
    message, job, _ = ask(assistant, conv2.conversation_id, "keep reading", [tool, tool, tool, tool])
    assert message.status == "error" and message.error_code == "schema_mismatch"


def test_default_fake_reply_when_no_script(assistant) -> None:
    conv = assistant.store.create(None)
    assistant.fake_metadata = {}
    _user, msg, job = assistant.engine.start_message(conv.conversation_id, "anything", None)
    wait_job(assistant, job.job_id)
    message = assistant.store.message(conv.conversation_id, msg.message_id)
    assert message.status == "done" and message.text.startswith(FAKE_DEFAULT_ANSWER["text"])


def test_busy_conversation_rejects_a_second_message(assistant) -> None:
    conv = assistant.store.create(None)
    script = [{"kind": "answer", "text": "slow", "refs": []}]
    assistant.fake_metadata["chat"] = {"fake_script": script, "fake_options": {"sleep_ms": 400}}
    _u, _m, job = assistant.engine.start_message(conv.conversation_id, "one", None)
    with pytest.raises(ConversationBusy):
        assistant.engine.start_message(conv.conversation_id, "two", None)
    wait_job(assistant, job.job_id)
    assistant.fake_metadata["chat"] = {"fake_script": script}
    _u, _m, job2 = assistant.engine.start_message(conv.conversation_id, "two", None)
    assert wait_job(assistant, job2.job_id).status == "done"


def test_cancel_stops_the_message(assistant) -> None:
    conv = assistant.store.create(None)
    script = [{"kind": "tool", "calls": [{"name": "list_runs", "args": {}}], "note": "n"}, {"kind": "answer", "text": "never", "refs": []}]
    assistant.fake_metadata["chat"] = {"fake_script": script, "fake_options": {"sleep_ms": 5000}}
    _u, msg, job = assistant.engine.start_message(conv.conversation_id, "long", None)
    time.sleep(0.1)
    cancelled = assistant.request_cancel(job.job_id)
    assert cancelled is not None and cancelled.cancel_requested is True
    started = time.monotonic()
    job = wait_job(assistant, job.job_id)
    assert time.monotonic() - started < 4.0  # the fake waited on the cancel event, not the full sleep
    assert job.status == "cancelled"
    message = assistant.store.message(conv.conversation_id, msg.message_id)
    assert message.status == "cancelled" and message.error_code == "cancelled"


def test_message_budget_stops_a_costly_chain(assistant, monkeypatch) -> None:
    monkeypatch.setattr(config, "ASSISTANT_MESSAGE_BUDGET_USD", 0.10)
    conv = assistant.store.create(None)
    tool = {"kind": "tool", "calls": [{"name": "list_runs", "args": {}}], "note": "n"}
    message, job, _ = ask(assistant, conv.conversation_id, "expensive", [tool, tool, {"kind": "answer", "text": "x", "refs": []}], fake_options={"cost_usd": 0.06})
    assert message.status == "error" and message.error_code == "budget_exhausted"
    assert message.cost_usd == pytest.approx(0.06) and "message budget" in (message.error or "")


def test_memory_refresh_folds_old_messages_through_the_summarizer(assistant, monkeypatch) -> None:
    monkeypatch.setattr(config, "MEMORY_TOKEN_BUDGET", 30)
    assistant.fake_metadata["summarizer"] = {"fake_reply": "SUMMARY: the operator asked about a03 twice."}
    conv = assistant.store.create(None)
    answer = {"kind": "answer", "text": "an answer that is long enough to exceed the tiny memory budget " * 3, "refs": []}
    for i in range(3):
        message, job, _ = ask(assistant, conv.conversation_id, f"question {i} about a03", [answer])
        assert message.status == "done"
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not assistant.store.meta(conv.conversation_id).summary:
        time.sleep(0.05)
    meta = assistant.store.meta(conv.conversation_id)
    assert meta.summary.startswith("SUMMARY:") and meta.summary_through_message_id is not None
    assert assistant.ledger.aggregate("global").by_profile["summarizer"].calls >= 1
    # the next message renders the summary plus only the recent exchanges
    text = assistant.engine._memory_text(meta, assistant.store.messages(conv.conversation_id), "none")
    assert "SUMMARY:" in text and "> Operator:" in text and "USER:" not in text


def test_no_summary_refresh_when_summarizer_would_be_paid(assistant, monkeypatch) -> None:
    monkeypatch.setattr(config, "MEMORY_TOKEN_BUDGET", 5)
    assistant.profile_keys["summarizer"] = "claude-cli-haiku-assistant"  # paid; auto_live_allowed is False
    conv = assistant.store.create(None)
    message, _job, _ = ask(assistant, conv.conversation_id, "a question that is longer than five tokens for sure", [{"kind": "answer", "text": "an answer that is also long enough", "refs": []}])
    assert message.status == "done"
    time.sleep(0.2)
    assert assistant.store.meta(conv.conversation_id).summary == ""
    assert assistant.ledger.aggregate("global").by_profile.get("summarizer") is None


def test_offline_answer_when_no_chat_model(assistant) -> None:
    assistant.profile_keys["chat"] = "no-such-model"
    conv = assistant.store.create(None)
    _u, msg, job = assistant.engine.start_message(conv.conversation_id, "how do I pause a run?", None)
    job = wait_job(assistant, job.job_id)
    message = assistant.store.message(conv.conversation_id, msg.message_id)
    assert message.status == "done" and message.offline is True and message.text.startswith(OFFLINE_LABEL)
    assert message.refs and all(r.kind == "doc" for r in message.refs)
    assert assistant.ledger.aggregate("global").calls == 0
    assert assistant.capabilities().available is False


def test_log_ring_buffer_redacts_and_caps(registry) -> None:
    handler = logbuffer.install(registry)
    assert logbuffer.install(registry) is handler  # idempotent
    handler.clear()
    log = logging.getLogger("empyrean.test.ring")
    log.info("token sk-abcdefghijklmnopqrstuvwxyz0123456789 and hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234 and path /home/x/y.json")
    log.info("plain line %d", 7)
    logging.getLogger("uvicorn.access").info("GET /api/health 200")
    lines = handler.tail(10)
    assert len(lines) == 2 and "sk-" not in lines[0] and "hf_" not in lines[0] and "[REDACTED]" in lines[0] and "/home/x/y.json" in lines[0]
    assert lines[1].endswith("plain line 7") and " INFO empyrean.test.ring: " in lines[1]
    assert handler.tail(10, "PLAIN") == lines[1:]
    assert handler.tail(10, "[unbalanced") == []  # an invalid regex falls back to a substring match
    for i in range(50):
        log.info("filler line %03d " + "x" * 100, i)
    assert sum(len(ln) + 1 for ln in handler.tail(50, max_chars=500)) <= 500
    assert len(handler.tail(5)) == 5


def test_engine_never_flattens_roles_and_uses_one_user_message(assistant, monkeypatch) -> None:
    from empyrean import model as model_mod

    seen: list[Any] = []
    original = model_mod.call_model

    def spy(request, registry=None, *, cancel=None):
        seen.append(request)
        return original(request, registry, cancel=cancel)

    monkeypatch.setattr(model_mod, "call_model", spy)
    conv = assistant.store.create(None)
    ask(assistant, conv.conversation_id, "first", [{"kind": "answer", "text": "one", "refs": []}])
    ask(assistant, conv.conversation_id, "second", [{"kind": "answer", "text": "two", "refs": []}])
    assert len(seen) == 2
    for request in seen:
        assert [m.role for m in request.messages] == ["system", "user"]
        assert request.purpose == "assistant" and request.response_format == "json" and request.response_schema is not None
        assert request.max_output_tokens == config.ASSISTANT_OUTPUT_TOKENS["chat"] and request.max_retries == 0
    assert seen[0].messages[0].content == seen[1].messages[0].content  # byte-stable system prompt
    assert "> Operator: first" in seen[1].messages[1].content and "> Assistant: one" in seen[1].messages[1].content
    assert seen[1].messages[1].content.startswith("Fence id for this request: ")
    assert isinstance(ModelRef.model_validate({"key": "k", "provider": "fake", "model_id": "fake-assistant"}), ModelRef)
    assert engine_mod.MEMORY_RECENT_MESSAGES >= 2


def _spy_requests(monkeypatch) -> list[Any]:
    from empyrean import model as model_mod

    seen: list[Any] = []
    original = model_mod.call_model

    def spy(request, registry=None, *, cancel=None):
        seen.append(request)
        return original(request, registry, cancel=cancel)

    monkeypatch.setattr(model_mod, "call_model", spy)
    return seen


def _set_stat_brief(field: str, entity: str = "a05") -> dict[str, Any]:
    args = {"interventions": [{"type": "set_stat", "entity_id": entity, "field": field, "value": 5}]}
    return {"kind": "brief", "brief": {"title": "Heal", "summary": f"Set {entity} health to 5.", "steps": [], "warnings": [], "action": {"type": "stage_interventions", "args": args}}}


def test_brief_with_fixable_validation_problems_gets_one_repair_step(assistant, manager, default_request, monkeypatch) -> None:
    run_id = manager.create_run(default_request).run_id
    conv = assistant.store.create(run_id)
    chip = ContextChip(page="run", run_id=run_id, live_turn_id="r00000_init", shown_turn_id="r00000_init", tab="god", run_state="paused")
    seen = _spy_requests(monkeypatch)
    message, job, view = ask(assistant, conv.conversation_id, "Set Eos's health to 5", [_set_stat_brief("health"), _set_stat_brief("stats.health")], chip)
    assert message.status == "done" and job.status == "done"
    assert [(s.kind, s.status) for s in message.steps] == [("brief-repair", "ok"), ("brief", "ok")]
    assert len(view.briefs) == 1 and view.briefs[0].validation.ok is True and view.briefs[0].status == "pending"
    assert view.briefs[0].action["interventions"][0]["field"] == "stats.health"
    repair_prompt = seen[1].messages[1].content
    assert "brief_validation_problems" in repair_prompt and "unknown field path" in repair_prompt and "rejected_action" in repair_prompt
    assert seen[1].messages[0].content == seen[0].messages[0].content  # the repair step is not the restricted one


def test_brief_problems_the_model_cannot_fix_are_shown_without_a_repair(assistant, manager, default_request) -> None:
    run_id = manager.create_run(default_request.model_copy(update={"play_delay_seconds": 0.5})).run_id
    worker = manager.require(run_id)
    worker.submit("play")
    try:
        conv = assistant.store.create(run_id)
        # run_turn while the run plays: a run-state problem another model call cannot fix
        cmd = {"kind": "brief", "brief": {"title": "Step", "summary": "Run one turn.", "steps": [], "warnings": [], "action": {"type": "run_command", "args": {"run_id": run_id, "command": "run_turn"}}}}
        message, _job, view = ask(assistant, conv.conversation_id, "run a turn", [cmd])
        assert [s.kind for s in message.steps] == ["brief"]
        assert view.briefs[-1].validation.ok is False and view.briefs[-1].validation.problems[0].path == "command"
    finally:
        worker.submit("pause")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and worker.status().state not in ("paused", "finished", "error"):
            time.sleep(0.02)


def test_brief_problem_on_the_step_before_the_last_is_shown_not_repaired(assistant, manager, default_request) -> None:
    run_id = manager.create_run(default_request).run_id
    conv = assistant.store.create(run_id)
    tool = {"kind": "tool", "calls": [{"name": "list_runs", "args": {}}], "note": "n"}
    bad = _set_stat_brief("health")
    bad["brief"]["action"]["args"]["run_id"] = run_id
    message, _job, view = ask(assistant, conv.conversation_id, "heal", [tool, tool, bad])
    assert [s.kind for s in message.steps] == ["tool", "tool", "brief"]  # step 4 could not emit a brief
    assert view.briefs[-1].validation.ok is False


def test_progress_and_elapsed_tick_while_a_model_call_runs(assistant, monkeypatch) -> None:
    monkeypatch.setattr(engine_mod, "PROGRESS_TICK_SECONDS", 0.1)
    conv = assistant.store.create(None)
    assistant.fake_metadata["chat"] = {"fake_script": [{"kind": "answer", "text": "slow", "refs": []}], "fake_options": {"sleep_ms": 1800}}
    _u, msg, job = assistant.engine.start_message(conv.conversation_id, "slow", None)
    time.sleep(1.3)
    running = assistant.get_job(job.job_id)
    pending = assistant.store.message(conv.conversation_id, msg.message_id)
    assert running is not None and running.status == "running" and running.elapsed_s >= 1.0
    assert pending.status == "running" and pending.progress is not None and pending.progress.startswith("step 1/") and " · 0 s · " not in pending.progress
    job = wait_job(assistant, job.job_id)
    final = assistant.store.message(conv.conversation_id, msg.message_id)
    assert job.status == "done" and final.status == "done" and final.progress is None  # no tick after the finish


def test_finished_job_never_shows_a_stale_active_job_id(assistant) -> None:
    conv = assistant.store.create(None)
    for i in range(5):
        assistant.fake_metadata["chat"] = {"fake_script": [{"kind": "answer", "text": f"a{i}", "refs": []}]}
        _u, _m, job = assistant.engine.start_message(conv.conversation_id, f"q{i}", None)
        while True:  # poll the way the GET route composes its view: both reads under the conversation lock
            with assistant.store.lock(conv.conversation_id):
                meta = assistant.store.meta(conv.conversation_id)
                current = assistant.get_job(job.job_id)
            if current is not None and current.status not in ("queued", "running"):
                assert meta.active_job_id is None, "a finished job with a stale active id"
                break
            time.sleep(0.001)


def test_search_events_counts_the_whole_range_and_says_when_the_list_is_cut(assistant, manager, default_request) -> None:
    import json as _json

    from empyrean import storage
    from empyrean.assistant import tools

    request = default_request.model_copy(update={"play_delay_seconds": 0.0})
    run_id = manager.create_run(request).run_id
    worker = manager.require(run_id)
    for k in range(1, 4):
        worker.submit("step_round")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not (worker.status().state == "paused" and worker.status().current_turn_id == f"r{k:05d}_end"):
            time.sleep(0.01)
        assert worker.status().current_turn_id == f"r{k:05d}_end"
    upkeep = sum(1 for e in storage.list_turns(run_id) for ev in storage.read_turn_events(run_id, e.turn_id) if ev.kind == "upkeep")
    assert upkeep >= 3
    res = tools.run_tool(assistant, "search_events", {"run_id": run_id, "kinds": ["upkeep"], "limit": 2})
    assert res.ok and not res.truncated
    p = res.payload
    assert p["total_matches"] == upkeep and p["counts_by_kind"] == {"upkeep": upkeep} and sum(p["counts_by_round"].values()) == upkeep
    assert len(p["matches"]) == 2 and p["truncated_after"] == 2 and "total_matches" in p["note"]
    one = tools.run_tool(assistant, "search_events", {"run_id": run_id, "kinds": ["upkeep"], "from_round": 2, "to_round": 2})
    assert one.ok and one.payload["rounds"] == [2, 2] and list(one.payload["counts_by_round"]) == ["2"] and "truncated_after" not in one.payload
    # everything, 50 listed: the list shrinks to fit the output cap, the totals survive
    big = tools.run_tool(assistant, "search_events", {"run_id": run_id, "limit": 50})
    assert big.ok and not big.truncated and big.payload["total_matches"] > len(big.payload["matches"])
    assert len(_json.dumps(big.payload, ensure_ascii=False, sort_keys=True)) <= config.ASSISTANT_TOOL_OUTPUT_MAX_CHARS
    # a turn id that is not committed is an error, never a silently widened range
    bad = tools.run_tool(assistant, "search_events", {"run_id": run_id, "from_turn": "r00002_t01"})
    assert bad.ok is False and "from_round" in bad.payload["error"]
