"""Execution briefs (rev 4, amended D6): overlay merge and setup diff, validation without
opening runs (typed action union, deterministic problems and warnings), interventions
prepared with origin 'assistant', CAS approval with revalidation, idempotent retry, reject,
execution of every action type including the step_round sequencer."""

from __future__ import annotations

import time

import pytest
from pydantic import ValidationError

from empyrean import config, storage
from empyrean.assistant import briefs
from empyrean.assistant.models import Brief, BriefActionEnvelope, BriefDraft, brief_action_adapter
from empyrean.assistant.store import read_run_settings
from empyrean.schemas import RunCreateRequest


def draft(action_type: str, args: dict, summary: str = "do it") -> BriefDraft:
    return BriefDraft(title="t", summary=summary, steps=["s"], warnings=[], action=BriefActionEnvelope(type=action_type, args=args))


def store_brief(assistant, conv_id: str, action_type: str, args: dict, run_id_hint=None) -> Brief:
    d = draft(action_type, args)
    action, validation = briefs.validate_brief(assistant, d, run_id_hint=run_id_hint)
    brief = Brief(
        brief_id=f"b{len(assistant.store.briefs(conv_id)) + 1}",
        conversation_id=conv_id,
        message_id="m",
        title=d.title,
        summary=d.summary,
        status="pending" if action is not None else "invalid",
        action=action.model_dump(mode="json") if action is not None else None,
        action_raw=d.action.model_dump(mode="json"),
        action_type=action_type,
        target_run_id=briefs.target_run_of(action) if action is not None else None,
        validation=validation,
    )
    return assistant.store.put_brief(conv_id, brief)


def wait_idle(worker, timeout: float = 30.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        st = worker.status()
        if st.state in ("paused", "finished", "error") and st.active_command is None and not st.play_loop:
            return st
        time.sleep(0.02)
    raise AssertionError("worker did not settle")


def test_deep_merge_and_merge_create_run(assistant) -> None:
    assert briefs.deep_merge({"a": {"b": 1, "c": 2}, "l": [1]}, {"a": {"b": 9}, "l": [2, 3]}) == {"a": {"b": 9, "c": 2}, "l": [2, 3]}
    overlay = {"seed": 7, "rules": {"prices": {"move": 9}}, "agents": [{"name": "Ash", "stats": {"attack": 3}}, {}, {"persona": "quiet"}] + [{"name": f"x{n}"} for n in range(10)]}
    request = briefs.merge_create_run(assistant, "Arena", 6, overlay)
    assert isinstance(request, RunCreateRequest) and request.name == "Arena" and request.seed == 7
    assert len(request.agents) == 6  # cards beyond agent_count dropped
    assert request.agents[0].name == "Ash" and request.agents[0].stats.attack == 3 and request.agents[0].stats.compute == config.DEFAULT_AGENT_STATS.compute
    assert request.agents[1].name == config.DEFAULT_AGENT_NAMES[1] and request.agents[2].persona == "quiet"
    assert request.rules.prices.move == 9 and request.rules.prices.observe == 1
    assert request.rules.plant_species == config.default_rules().plant_species
    with pytest.raises(ValidationError):
        briefs.merge_create_run(assistant, "bad", 6, {"seed": "seven"})
    diff = {d.path: d for d in briefs.setup_diff(request)}
    assert {"name", "seed", "rules.prices.move", "agents[0].name", "agents[0].stats.attack", "agents[2].persona"} <= set(diff)
    assert diff["rules.prices.move"].default == 5 and diff["rules.prices.move"].value == 9
    assert "rules.prices.observe" not in diff


def test_validate_create_run_reports_setup_problems_and_warnings(assistant) -> None:
    action, validation = briefs.validate_brief(assistant, draft("create_run", {"name": "x", "agent_count": 6, "overlay": {"agents": [{"id": "a01"}, {"id": "a01"}]}}), run_id_hint=None)
    assert action is not None and validation.ok is False
    assert any("agents[1]" in p.path for p in validation.problems)
    action, validation = briefs.validate_brief(assistant, draft("create_run", {"name": "x", "agent_count": 6, "overlay": {"default_model_key": "claude-cli-haiku"}}), run_id_hint=None)
    assert validation.ok is True and any("live model" in w for w in validation.warnings) and any("real_budget_usd" in w for w in validation.warnings)
    # assistant-only models are rejected for agents by validate_setup
    _action, validation = briefs.validate_brief(assistant, draft("create_run", {"name": "x", "agent_count": 6, "overlay": {"default_model_key": "fake-assistant"}}), run_id_hint=None)
    assert validation.ok is False and "reserved for the assistant" in validation.problems[0].message
    # untyped args
    action, validation = briefs.validate_brief(assistant, draft("create_run", {"name": "x", "agent_count": 99}), run_id_hint=None)
    assert action is None and validation.problems[0].path == "action.agent_count"


def test_validate_run_command_and_interventions_without_opening(assistant, manager, default_request) -> None:
    run_id = manager.create_run(default_request).run_id
    manager.close_run(run_id)
    manager._wait_for_closing(run_id)
    assert manager.get(run_id) is None
    action, validation = briefs.validate_brief(assistant, draft("run_command", {"command": "step_round", "rounds": 2}), run_id_hint=run_id)
    assert action is not None and action.run_id == run_id and validation.ok is True
    assert validation.validated_against_turn_id == "r00000_init" and any("not open" in w for w in validation.warnings)
    assert manager.get(run_id) is None  # validation never opened the run
    _a, validation = briefs.validate_brief(assistant, draft("run_command", {"run_id": run_id, "command": "play", "rounds": 2}), run_id_hint=None)
    assert validation.ok is False and validation.problems[0].path.startswith("action")  # rounds only with step_round
    _a, validation = briefs.validate_brief(assistant, draft("stage_interventions", {"run_id": run_id, "interventions": [{"type": "set_stat", "entity_id": "zz99", "field": "stats.compute", "value": 1}, {"type": "set_stat", "entity_id": "a01", "field": "stats.compute", "value": 1}]}), run_id_hint=None)
    assert validation.ok is False and validation.problems[0].path == "interventions[0].entity_id" and len(validation.problems) == 1
    assert manager.get(run_id) is None
    _a, validation = briefs.validate_brief(assistant, draft("stage_interventions", {"run_id": run_id, "interventions": [{"type": "apply_working_files", "base_turn_id": "r00000_init", "snapshot_ref": "x", "changes": []}]}), run_id_hint=None)
    assert validation.ok is False and validation.problems[0].path.startswith("action.interventions")
    _a, validation = briefs.validate_brief(assistant, draft("create_continuation", {"run_id": run_id, "from_turn_id": "r00009_end"}), run_id_hint=None)
    assert validation.ok is False and validation.problems[0].path == "from_turn_id"
    _a, validation = briefs.validate_brief(assistant, draft("open_run", {"run_id": "run_missing"}), run_id_hint=None)
    assert validation.ok is False and validation.problems[0].path == "run_id"
    _a, validation = briefs.validate_brief(assistant, draft("update_assistant_settings", {"run_id": run_id}), run_id_hint=None)
    assert _a is None  # nothing to change


def test_prepared_intervention_sets_origin_and_note() -> None:
    iv = brief_action_adapter.validate_python({"type": "stage_interventions", "run_id": "r", "interventions": [{"type": "set_stat", "entity_id": "a01", "field": "stats.compute", "value": 5, "id": "iv_9999", "origin": "ui", "note": "mine"}]}).interventions[0]
    prepared = briefs.prepared_intervention(iv, "give a01 compute")
    assert prepared.origin == "assistant" and prepared.note == "assistant: give a01 compute" and prepared.id is None and prepared.created_at is None


def test_approve_create_run_executes_rebinds_and_is_idempotent(assistant, manager) -> None:
    conv = assistant.store.create(None)
    brief = store_brief(assistant, conv.conversation_id, "create_run", {"name": "Arena", "agent_count": 6, "overlay": {"play_delay_seconds": 0}})
    assert brief.status == "pending" and brief.validation.ok
    done = briefs.approve_brief(assistant, conv.conversation_id, brief.brief_id, None)
    assert done.status == "executed" and done.effect is not None and done.effect.run_id
    run_id = done.effect.run_id
    assert manager.get(run_id) is not None and done.effect.status.state == "paused" and done.effect.run_summary.name == "Arena"
    assert assistant.store.meta(conv.conversation_id).run_id == run_id
    again = briefs.approve_brief(assistant, conv.conversation_id, brief.brief_id, None)
    assert again.status == "executed" and again.effect.run_id == run_id and len(manager.list_runs()) == 1
    with pytest.raises(briefs.BriefNotPending):
        briefs.reject_brief(assistant, conv.conversation_id, brief.brief_id)


def test_reject_and_invalid_briefs(assistant, manager, default_request) -> None:
    run_id = manager.create_run(default_request).run_id
    conv = assistant.store.create(run_id)
    brief = store_brief(assistant, conv.conversation_id, "run_command", {"run_id": run_id, "command": "run_turn"})
    rejected = briefs.reject_brief(assistant, conv.conversation_id, brief.brief_id, "not now")
    assert rejected.status == "rejected" and rejected.reject_reason == "not now"
    with pytest.raises(briefs.BriefNotPending):
        briefs.approve_brief(assistant, conv.conversation_id, brief.brief_id, None)
    bad = store_brief(assistant, conv.conversation_id, "stage_interventions", {"run_id": run_id, "interventions": [{"type": "set_stat", "entity_id": "zz", "field": "stats.compute", "value": 1}]})
    assert bad.status == "pending" and bad.validation.ok is False
    with pytest.raises(briefs.BriefNotPending):
        briefs.approve_brief(assistant, conv.conversation_id, bad.brief_id, None)
    assert manager.require(run_id).staged() == []


def test_stage_interventions_is_all_or_nothing_and_revalidates(assistant, manager, default_request) -> None:
    request = default_request.model_copy(update={"play_delay_seconds": 0.0})
    run_id = manager.create_run(request).run_id
    worker = manager.require(run_id)
    conv = assistant.store.create(run_id)
    brief = store_brief(assistant, conv.conversation_id, "stage_interventions", {"run_id": run_id, "interventions": [
        {"type": "set_stat", "entity_id": "a01", "field": "stats.compute", "value": 77},
        {"type": "voice", "recipients": {"mode": "broadcast_all"}, "text": "hello all"},
    ]})
    assert brief.validation.ok and brief.validation.validated_against_turn_id == "r00000_init"
    # the world moves on before approval: a01 is removed, so revalidation must catch it
    worker.stage_intervention(brief_action_adapter.validate_python({"type": "stage_interventions", "run_id": run_id, "interventions": [{"type": "remove_entity", "entity_id": "a01"}]}).interventions[0])
    worker.submit("run_turn")
    wait_idle(worker)
    assert not worker.checkpoint.world.agents.get("a01") or worker.checkpoint.world.agents["a01"].alive is False or "a01" in worker.checkpoint.world.removed
    back = briefs.approve_brief(assistant, conv.conversation_id, brief.brief_id, "r00000_init")
    assert back.status == "pending" and back.validation.ok is False and back.validation.problems[0].path.startswith("interventions[0]")
    assert any("Revalidated" in w for w in back.validation.warnings)
    assert worker.staged() == []  # nothing staged (the voice was not staged alone)
    # a good brief stages both with origin assistant and the note
    good = store_brief(assistant, conv.conversation_id, "stage_interventions", {"run_id": run_id, "interventions": [
        {"type": "set_stat", "entity_id": "a02", "field": "stats.compute", "value": 77},
        {"type": "voice", "recipients": {"mode": "broadcast_all"}, "text": "hello all"},
    ]})
    done = briefs.approve_brief(assistant, conv.conversation_id, good.brief_id, good.validation.validated_against_turn_id)
    assert done.status == "executed" and len(done.effect.staged_ids) == 2 and done.effect.status.staged_intervention_count == 2
    staged = worker.staged()
    assert all(iv.origin == "assistant" and iv.note.startswith("assistant: ") for iv in staged)
    assert [iv.id for iv in staged] == done.effect.staged_ids


def test_run_command_sequencer_steps_rounds_and_reports_progress(assistant, manager, default_request) -> None:
    request = default_request.model_copy(update={"play_delay_seconds": 0.0})
    run_id = manager.create_run(request).run_id
    conv = assistant.store.create(run_id)
    brief = store_brief(assistant, conv.conversation_id, "run_command", {"run_id": run_id, "command": "step_round", "rounds": 2})
    done = briefs.approve_brief(assistant, conv.conversation_id, brief.brief_id, "r00000_init")
    assert done.status == "executed" and done.effect.rounds_requested == 2 and done.effect.rounds_done == 0
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        effect = assistant.store.brief(conv.conversation_id, brief.brief_id).effect
        if effect.rounds_done == 2:
            break
        time.sleep(0.05)
    assert effect.rounds_done == 2 and "2 rounds" in effect.message
    status = manager.require(run_id).status()
    assert status.round == 2 and status.current_turn_id == "r00002_end" and status.state == "paused"
    jobs = [j for j in assistant.jobs.values() if j.kind == "sequencer"]
    assert jobs and jobs[0].status == "done" and jobs[0].step == 2


def test_run_command_rejected_while_running(assistant, manager, default_request) -> None:
    request = default_request.model_copy(update={"play_delay_seconds": 0.5})
    run_id = manager.create_run(request).run_id
    worker = manager.require(run_id)
    worker.submit("play")
    conv = assistant.store.create(run_id)
    brief = store_brief(assistant, conv.conversation_id, "run_command", {"run_id": run_id, "command": "run_turn"})
    assert brief.validation.ok is False and "illegal_command" in brief.validation.problems[0].message
    worker.submit("pause")
    wait_idle(worker)


def test_continuation_and_settings_actions(assistant, manager, default_request) -> None:
    request = default_request.model_copy(update={"play_delay_seconds": 0.0})
    run_id = manager.create_run(request).run_id
    worker = manager.require(run_id)
    worker.submit("run_turn")
    wait_idle(worker)
    first_turn = worker.status().current_turn_id
    conv = assistant.store.create(run_id)
    brief = store_brief(assistant, conv.conversation_id, "create_continuation", {"run_id": run_id, "from_turn_id": first_turn, "name": "Branch"})
    done = briefs.approve_brief(assistant, conv.conversation_id, brief.brief_id, None)
    assert done.status == "executed" and done.effect.run_summary.parent.turn_id == first_turn and done.effect.run_summary.name == "Branch"
    assert assistant.store.meta(conv.conversation_id).run_id == done.effect.run_id
    from empyrean.assistant.store import default_run_settings, write_run_settings

    write_run_settings(assistant.paths, run_id, default_run_settings())  # auto off (WP3's default may have turned it on)
    settings_brief = store_brief(assistant, conv.conversation_id, "update_assistant_settings", {"run_id": run_id, "storybook_auto": True, "chat_budget_usd": 2.5})
    done = briefs.approve_brief(assistant, conv.conversation_id, settings_brief.brief_id, None)
    assert done.status == "executed"
    settings = read_run_settings(assistant.paths, run_id)
    assert settings is not None and settings.storybook_auto is True and settings.chat_budget_usd == 2.5 and settings.auto_since_turn_id == first_turn
    open_brief = store_brief(assistant, conv.conversation_id, "open_run", {"run_id": run_id})
    done = briefs.approve_brief(assistant, conv.conversation_id, open_brief.brief_id, None)
    assert done.status == "executed" and done.effect.run_id == run_id and assistant.store.meta(conv.conversation_id).run_id == run_id


def test_execution_failure_marks_the_brief_failed(assistant, manager, default_request, monkeypatch) -> None:
    run_id = manager.create_run(default_request).run_id
    conv = assistant.store.create(run_id)
    brief = store_brief(assistant, conv.conversation_id, "run_command", {"run_id": run_id, "command": "run_turn"})

    def boom(*args, **kwargs):
        raise RuntimeError("worker exploded with secret sk-abcdefghijklmnopqrstuvwxyz012345")

    monkeypatch.setattr(manager.require(run_id), "submit", boom)
    failed = briefs.approve_brief(assistant, conv.conversation_id, brief.brief_id, None)
    assert failed.status == "failed" and "exploded" in failed.error and "sk-abc" not in failed.error
    with pytest.raises(briefs.BriefNotPending):
        briefs.approve_brief(assistant, conv.conversation_id, brief.brief_id, None)
    assert isinstance(storage.read_manifest(run_id).current_turn_id, str)
