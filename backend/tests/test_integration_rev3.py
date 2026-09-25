"""
Integration checks for the revision-3 contract changes (docs/INTERFACES.md "rev 3").

Run:  cd backend && ../.venv/bin/pytest -q tests/test_integration_rev3.py

Each test pins one behaviour the integration pass added or changed:
WorldState.observation_page_size, BelievedSelf.position, SituationEntity.queried_round,
the disclosed interpreter cost, the strict seed gate, ContextLimits on the settings view,
death events for an operator kill, the partial knowledge-record input, the configurable
string limit for skills, and the field paths of context problems.
"""

from __future__ import annotations

import pytest

from empyrean import context, skills, world as W
from empyrean.config import default_rules, default_run_request
from empyrean.schemas import (
    ActionRequest,
    ActionResult,
    Agent,
    AgentStats,
    ContextSettings,
    Point,
    SkillEnv,
    SkillSaveRequest,
    TurnId,
)
from e2e_support import base_request, events_of


# ---------------------------------------------------------------------------
# world.py
# ---------------------------------------------------------------------------


def test_observation_page_size_is_copied_from_the_world_config():
    """A-ACT-4: the run keeps the page size it was created with (WorldConfig is not stored)."""
    request = default_run_request()
    request.world.max_entities_per_observation_page = 2
    state = W.generate_world(request.world, default_rules(), request.seed, request.agents)
    assert state.observation_page_size == 2
    # Five agents share (0,0) with the defaults' neighbours? Not necessarily: observe the
    # actor's own point, which always lists at least the actor, and check the page size.
    actor = state.agents["a01"]
    outcome = W.apply_action(
        state,
        ActionRequest(agent_id="a01", action={"name": "observe", "args": {"point": actor.position, "page": 0}}),
    )
    assert outcome.result.ok and outcome.result.data["page_size"] == 2
    # The value survives a copy and a JSON round trip like any other world field.
    copied = type(state).model_validate(state.model_dump(mode="json"))
    assert copied.observation_page_size == 2


# ---------------------------------------------------------------------------
# context.py
# ---------------------------------------------------------------------------


def _agent(agent_id: str = "a01") -> Agent:
    return Agent(id=agent_id, name="Aster", position=Point(x=0, y=0), stats=AgentStats())


def _observe_result(round_no: int, entities: list[dict]) -> ActionResult:
    return ActionResult(
        ok=True,
        reason="ok",
        cost_compute=1.0,
        round=round_no,
        data={
            "point": {"x": 0, "y": 0},
            "terrain": "land",
            "entities": entities,
            "observed_round": round_no,
            "page": 0,
            "page_size": 40,
            "total_entities": len(entities),
            "has_more": False,
        },
    )


def test_situation_entity_carries_the_round_of_its_query_and_believed_position_follows_moves():
    agent = _agent()
    knowledge = context.new_knowledge("a01")
    context.record_run_start(knowledge, agent, 0, TurnId.INIT)
    fruit = {"id": "f0001", "kind": "fruit", "position": {"x": 0, "y": 0}}
    context.record_action_result(
        knowledge, {"name": "observe", "args": {"point": {"x": 0, "y": 0}, "page": 0}}, _observe_result(1, [fruit]), 1, "r00001_t01_a01", False
    )
    query = ActionResult(
        ok=True, reason="ok", cost_compute=1.0, round=2,
        data={"id": "f0001", "kind": "fruit", "position": {"x": 0, "y": 0}, "available_compute": 60.0, "available_essence": 0.0},
    )
    context.record_action_result(knowledge, {"name": "query", "args": {"entity": "f0001"}}, query, 2, "r00002_t01_a01", False)

    believed = context.believed_self(knowledge)
    assert believed.position == Point(x=0, y=0)
    assert believed.compute == pytest.approx(200 - 1.0 - 1.0)

    situation = context.build_situation(agent, knowledge, default_rules(), ContextSettings(), 3, "r00003_t01_a01")
    [entity] = situation.visible_entities
    assert entity.id == "f0001" and entity.available_compute == pytest.approx(60.0)
    assert entity.queried_round == 2
    text = "\n".join(context.situation_core_lines(situation))
    assert "last query in round 2" in text

    move = ActionResult(ok=True, reason="ok", cost_compute=5.0, round=3, effects={"from": {"x": 0, "y": 0}, "to": {"x": 0, "y": 1}})
    context.record_action_result(knowledge, {"name": "move", "args": {"direction": "up"}}, move, 3, "r00003_t01_a01", False)
    assert context.believed_self(knowledge).position == Point(x=0, y=1)


def test_interpreter_cost_is_disclosed_and_subtracted_from_the_believed_compute():
    """A-KNOW-6 (rev 3): a skill action record carries interpreter_charged; a skill-step
    system record with interpreter_charged is subtracted too."""
    knowledge = context.new_knowledge("a01")
    context.record_run_start(knowledge, _agent(), 0, TurnId.INIT)
    result = ActionResult(ok=True, reason="ok", cost_compute=4.0, round=1)
    record = context.record_action_result(
        knowledge, {"name": "move", "args": {"direction": "up"}, "skill_name": "walk"}, result, 1, "r00001_t01_a01", True,
        interpreter_cost=0.05,
    )
    assert record.content["interpreter_charged"] == pytest.approx(0.05)
    assert "Interpreter cost 0.05 compute" in record.text
    context.record_system(knowledge, "skill walk yielded", 2, "r00002_t01_a01", {"skill": "walk", "reason": "op_budget_exhausted", "interpreter_charged": 0.5})
    believed = context.believed_self(knowledge)
    assert believed.compute == pytest.approx(200 - 4.0 - 0.05 - 0.5)
    assert believed.source == "derived" and believed.known_round == 2


# ---------------------------------------------------------------------------
# skills.py
# ---------------------------------------------------------------------------


def test_string_limit_comes_from_the_skill_rules():
    rules = default_rules().skills
    rules.max_string_chars = 5
    request = SkillSaveRequest(name="shout", params=[], source='SET s = "abc" + "def"\nRETURN s')
    definition = skills.validate_and_build(request, {}, 5, 100, rules, 0)
    state = skills.start_execution("shout", [], {"shout": definition}, 1)
    outcome = skills.run_until_action(state, {"shout": definition}, rules, SkillEnv(agent_id="a01", here=Point(x=0, y=0), round=1), 100.0)
    assert outcome.state.status == "error"
    assert outcome.error == "line 1: string longer than 5 characters"
    # With the default rule the same skill finishes.
    ok_state = skills.start_execution("shout", [], {"shout": definition}, 1)
    ok = skills.run_until_action(ok_state, {"shout": definition}, default_rules().skills, SkillEnv(agent_id="a01", here=Point(x=0, y=0), round=1), 100.0)
    assert ok.state.status == "finished" and ok.state.return_value == "abcdef"


# ---------------------------------------------------------------------------
# API (real runner, fake models)
# ---------------------------------------------------------------------------


def test_seed_is_strict_at_the_shape_gate(api):
    request = base_request(api, "strict seed")
    request["seed"] = True
    body = api.post_raw("/runs", request)
    assert body.status_code == 422, body.text
    error = body.json()
    assert error["error"] == "validation_error"
    assert any(p["path"] == "seed" for p in error["problems"]), error
    preview = api.post_raw("/world/preview", {"seed": "3"})
    assert preview.status_code == 422 and preview.json()["error"] == "validation_error"


def test_context_problems_point_at_the_field(api):
    request = base_request(api, "context path")
    request["context"]["generation_allowance"] = 10_000_000
    body = api.post_raw("/runs/validate", request)
    assert body.status_code == 200, body.text
    problems = body.json()["problems"]
    assert body.json()["ok"] is False
    assert any(p["path"].startswith("context.generation_allowance") for p in problems), problems


def test_settings_view_serves_the_context_limits(api):
    from empyrean import config

    run_id = api.create_run(base_request(api, "limits"))["run_id"]
    view = api.settings(run_id)
    assert view["limits"] == {
        "min_packet_input_tokens": config.MIN_PACKET_INPUT_TOKENS,
        "min_generation_tokens": config.MIN_GENERATION_TOKENS,
    }


def test_operator_kill_through_set_stat_emits_death_and_residue_events(api):
    """A-DEATH-6: health 0 by set_stat resolves kill_agent(cause='operator') in world.py;
    the runner emits the death / residue_created events from the returned changes."""
    run_id = api.create_run(base_request(api, "operator kill"))["run_id"]
    api.stage(run_id, {"type": "set_stat", "entity_id": "a04", "field": "stats.health", "value": 0})
    api.run_turn(run_id)
    boundary = api.status(run_id)["current_turn_id"]
    view = api.turn(run_id, boundary)
    [record] = view["turn"]["interventions"]
    assert record["ok"], record
    agent = view["entities"]["agents"]["a04"]
    assert agent["alive"] is False and agent["death_cause"] == "operator"
    [death] = events_of(view, "death")
    assert death["actor"] == "world"
    assert death["details"]["entity_id"] == "a04" and death["details"]["cause"] == "operator"
    residue_id = death["details"]["residue_id"]
    assert residue_id in view["entities"]["residues"]
    [created] = events_of(view, "residue_created")
    assert created["details"]["residue_id"] == residue_id and created["details"]["source_id"] == "a04"
    assert created["details"]["compute"] == pytest.approx(200 * 0.5)
    # Cause before effect (fix pass): the intervention event comes first, then the death and
    # residue events it produced, all before the acting agent's turn_started.
    kinds = [e["kind"] for e in view["events"]]
    assert kinds.index("intervention") < kinds.index("death") < kinds.index("residue_created") < kinds.index("turn_started")


def test_partial_knowledge_record_with_placeholder_keys_is_accepted(api):
    """The UI sends placeholder id/seq/round/provenance copied from a full record; the
    backend ignores them (KnowledgeRecordInput) and assigns its own."""
    run_id = api.create_run(base_request(api, "partial record"))["run_id"]
    api.stage(
        run_id,
        {
            "type": "edit_knowledge",
            "agent_id": "a02",
            "operation": "add_record",
            "record": {
                "id": "", "agent_id": "a02", "seq": 0, "round": 0, "provenance": {"source": "operator"},
                "kind": "system", "text": "You remember a cave at (2,2).",
            },
        },
    )
    api.run_turn(run_id)
    boundary = api.status(run_id)["current_turn_id"]
    records = api.knowledge(run_id, boundary, "a02")["knowledge"]["records"]
    added = [r for r in records if "cave" in r["text"]]
    assert len(added) == 1
    assert added[0]["provenance"]["source"] == "operator" and added[0]["id"].startswith("a02-k")
    # delivered (and marked read) only if a02 was the agent that acted in this first turn
    assert added[0]["read"] is boundary.endswith("_a02") and added[0]["importance"] > 0
