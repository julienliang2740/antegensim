"""
End-to-end: game rules through the whole stack (QA).

Scripted fake agents (``fake-scripted``, INTERFACES section 12) submit exact
decisions; the tests then read the committed turns through the API and check
the rule outcomes against the design document:

* "Saved skill compute discount": a direct move costs 5, the same move from a
  saved skill costs 4; a skill transfer of 10 compute charges a 0.8 fee and
  moves the full 10 (INTERFACES 4.1 "Quotes and charges").
* "Turns speed and skill execution" + A-SKILL-11: design example 1 as a skill
  uses exactly three agent turns; the fourth is a model decision.
* Spec "Two distinct validation gates": malformed output never applies an
  effect and the run keeps going.
* "Action blocks": a move into a mountain fails and the position is unchanged.
* Spec "Budget delivery" + A-COG-2: an agent that cannot afford the minimum
  packet is skipped with a resource event and starves at round end.
"""

from __future__ import annotations

import pytest

from e2e_support import (
    base_request,
    card,
    charged_cognition,
    decision,
    events_of,
    find_clear_path,
    find_mountain_edge,
    point,
    script_card,
    skill_decision,
    terrain,
)

# Design example 1, verbatim ("Move three points upward, stopping if a move fails").
DESIGN_EXAMPLE_1 = """REPEAT 3
    SET movement_result = move("up")
    IF movement_result.ok == false
        RETURN movement_result.reason
    END
END
RETURN "completed"
"""


def agent_of(view: dict, agent_id: str) -> dict:
    return view["entities"]["agents"][agent_id]


def first_turns(api, run_id: str, agent_id: str, count: int) -> list[dict]:
    rows = api.agent_turns(run_id, agent_id)
    assert len(rows) >= count, f"{agent_id} took only {len(rows)} turns"
    return rows[:count]


def test_direct_move_costs_5_and_skill_move_costs_4(api):
    """Design 'Saved skill compute discount' table: Move 5 direct, 4 in a saved skill.
    The debit equals action charge + cognition (+ interpreter work in the skill)."""
    request = base_request(api, "e2e move prices")
    card(request, "a01")["position"] = {"x": 0, "y": 0}
    script_card(
        request,
        "a01",
        [
            decision("move", "Go up directly.", direction="up"),
            skill_decision("step_down", 'move("down")', thought="Come back through a skill."),
        ],
    )
    run_id = api.create_run(request)["run_id"]
    assert terrain(api.live(run_id)["map"], 0, 1) != "mountain"  # origin radius is kept land
    api.step_rounds(run_id, 2)
    direct_row, skill_row = first_turns(api, run_id, "a01", 2)

    # Direct move: charge 5.
    view, previous = api.turn_and_previous(run_id, direct_row["turn_id"])
    turn = view["turn"]
    assert turn["decision_source"] == "model"
    assert turn["action"]["name"] == "move" and turn["action"]["via_skill"] is False
    result = turn["action_result"]
    assert result["ok"] is True and result["reason"] == "ok"
    assert result["cost_compute"] == pytest.approx(5.0)
    assert point(result["effects"]["from"]) == (0, 0) and point(result["effects"]["to"]) == (0, 1)
    before, after = agent_of(previous, "a01"), agent_of(view, "a01")
    assert point(after["position"]) == (0, 1)
    assert after["total_compute_spent"] - before["total_compute_spent"] == pytest.approx(5.0)
    cognition = charged_cognition(view)
    assert cognition > 0
    assert before["stats"]["compute"] - after["stats"]["compute"] == pytest.approx(5.0 + cognition)
    action_events = events_of(view, "action")
    assert len(action_events) == 1 and action_events[0]["costs"]["compute"] == pytest.approx(5.0)
    assert action_events[0]["details"]["via_skill"] is False

    # Same move through a saved skill: charge 4 plus 1 interpreter op.
    view, previous = api.turn_and_previous(run_id, skill_row["turn_id"])
    turn = view["turn"]
    assert turn["action"]["name"] == "move"
    assert turn["action"]["via_skill"] is True and turn["action"]["skill_name"] == "step_down"
    result = turn["action_result"]
    assert result["ok"] is True
    assert result["cost_compute"] == pytest.approx(4.0)
    before, after = agent_of(previous, "a01"), agent_of(view, "a01")
    assert "step_down" in after["skills"]
    assert point(after["position"]) == (0, 0)
    assert after["total_compute_spent"] - before["total_compute_spent"] == pytest.approx(4.0)
    interpreter = after["total_interpreter_spent"] - before["total_interpreter_spent"]
    assert interpreter == pytest.approx(0.01), "a bare move statement is 1 op at 0.01 (INTERFACES 4.2 worked numbers)"
    cognition = charged_cognition(view)
    assert before["stats"]["compute"] - after["stats"]["compute"] == pytest.approx(4.0 + interpreter + cognition)
    action_events = events_of(view, "action")
    assert len(action_events) == 1 and action_events[0]["costs"]["compute"] == pytest.approx(4.0)
    assert action_events[0]["details"]["via_skill"] is True
    assert action_events[0]["details"]["skill_name"] == "step_down"
    assert events_of(view, "skill_saved"), "saving the skill must be recorded"


def test_design_example_1_skill_uses_three_turns_then_model_decision(api):
    """A-SKILL-11: 'Chaining five moves in a saved skill therefore takes five turns';
    design example 1 moves on three agent turns (one world action each, 4 compute each)
    and the agent's fourth turn is a fresh model decision after skill_finished."""
    request = base_request(api, "e2e example 1")
    preview = api.preview_map(request)
    start = find_clear_path(preview, "up", 3)
    card(request, "a01")["position"] = {"x": start[0], "y": start[1]}
    script_card(
        request,
        "a01",
        [
            skill_decision("climb", DESIGN_EXAMPLE_1, thought="Climb three cells."),
            decision("query", "Where am I now?", entity="self"),
        ],
    )
    run_id = api.create_run(request)["run_id"]
    live_map = api.live(run_id)["map"]
    assert live_map["cells"] == preview["cells"], "POST /world/preview must show the terrain the run gets (A-WORLD-6)"
    api.step_rounds(run_id, 4)
    rows = first_turns(api, run_id, "a01", 4)
    views = [api.turn(run_id, row["turn_id"]) for row in rows]

    assert [v["turn"]["decision_source"] for v in views] == ["model", "skill", "skill", "model"]
    assert len(views[0]["turn"]["model_call_ids"]) == 1
    assert views[1]["turn"]["model_call_ids"] == [] and views[2]["turn"]["model_call_ids"] == []
    for step, view in enumerate(views[:3], start=1):
        turn = view["turn"]
        assert turn["action"]["name"] == "move" and turn["action"]["args"] == {"direction": "up"}
        assert turn["action"]["via_skill"] is True and turn["action"]["skill_name"] == "climb"
        assert turn["action_result"]["ok"] is True, turn["action_result"]
        assert turn["action_result"]["cost_compute"] == pytest.approx(4.0)
        assert point(agent_of(view, "a01")["position"]) == (start[0], start[1] + step)
        assert len(events_of(view, "action")) == 1, "one world action per turn, even inside a skill"

    fourth = views[3]
    kinds = [e["kind"] for e in fourth["events"]]
    assert "skill_finished" in kinds and "decision" in kinds
    assert kinds.index("skill_finished") < kinds.index("decision")
    finished = events_of(fourth, "skill_finished")[0]
    assert finished["details"]["skill"] == "climb"
    assert finished["details"].get("return_value") == "completed"
    assert fourth["turn"]["model_call_ids"], "the fourth turn needs a model call"
    assert fourth["turn"]["action"]["name"] == "query" and fourth["turn"]["action"]["via_skill"] is False
    assert point(agent_of(fourth, "a01")["position"]) == (start[0], start[1] + 3)


def test_skill_transfer_of_10_compute_charges_only_the_fee(api):
    """INTERFACES 4.1 example: a skill transfer of 10 compute leaves the sender at -10.8,
    the recipient at +10, cost_compute 0.8 (the transferred amount is never discounted)."""
    request = base_request(api, "e2e transfer")
    for agent_id in ("a01", "a02"):
        card(request, agent_id)["position"] = {"x": 0, "y": 0}
    card(request, "a02")["fake_options"] = {"idle": True}  # the recipient stays put
    script_card(
        request,
        "a01",
        [skill_decision("give", 'SET r = transfer("a02", "compute", 10)\nRETURN r', thought="Share compute.")],
    )
    run_id = api.create_run(request)["run_id"]
    api.step_round(run_id)
    (row,) = first_turns(api, run_id, "a01", 1)
    view, previous = api.turn_and_previous(run_id, row["turn_id"])

    turn = view["turn"]
    assert turn["action"]["name"] == "transfer" and turn["action"]["via_skill"] is True
    result = turn["action_result"]
    assert result["ok"] is True, result
    assert result["cost_compute"] == pytest.approx(0.8)
    assert result["effects"]["transferred"] == pytest.approx(10.0)
    assert result["effects"]["resource"] == "compute" and result["effects"]["to"] == "a02"

    sender_before, sender_after = agent_of(previous, "a01"), agent_of(view, "a01")
    recipient_before, recipient_after = agent_of(previous, "a02"), agent_of(view, "a02")
    assert recipient_after["stats"]["compute"] - recipient_before["stats"]["compute"] == pytest.approx(10.0)
    sender_delta = sender_after["stats"]["compute"] - sender_before["stats"]["compute"]
    cognition = sender_after["total_cognition_spent"] - sender_before["total_cognition_spent"]
    interpreter = sender_after["total_interpreter_spent"] - sender_before["total_interpreter_spent"]
    assert sender_delta + cognition + interpreter == pytest.approx(-10.8)
    assert sender_after["total_compute_spent"] - sender_before["total_compute_spent"] == pytest.approx(0.8)
    assert events_of(view, "action")[0]["costs"]["compute"] == pytest.approx(0.8)

    # The recipient is told (system notice with the amount, A-KNOW-6 transfer-received).
    knowledge = api.knowledge(run_id, row["turn_id"], "a02")["knowledge"]
    received = [r for r in knowledge["records"] if r["kind"] == "system" and r["content"].get("amount") == pytest.approx(10.0)]
    assert received, "the recipient needs a transfer-received record"
    assert received[-1]["content"].get("resource") == "compute"


def test_malformed_model_output_never_applies_an_effect(api):
    """fake-malformed cycles invalid JSON / unknown action / valid decision by
    (round + agent index) % 3.  Invalid replies produce decision_invalid feedback, change
    nothing but the cognition charge, and the run keeps going (no error state)."""
    request = base_request(api, "e2e malformed", default_model_key="fake-malformed")
    run_id = api.create_run(request)["run_id"]
    for _ in range(3):
        status = api.step_round(run_id)
        assert status["state"] == "paused" and status["last_error"] is None

    invalid_json_turns = unknown_action_turns = valid_turns = 0
    for row in api.turns(run_id):
        if row["kind"] != "agent_turn":
            continue
        view, previous = api.turn_and_previous(run_id, row["turn_id"])
        agent_id = row["acting_agent_id"]
        invalid = events_of(view, "decision_invalid")
        if not invalid:
            valid_turns += 1
            continue
        assert len(invalid) == 1
        assert invalid[0]["details"].get("reason"), invalid[0]
        assert "raw_text_excerpt" in invalid[0]["details"]
        statuses = {call.get("result_status") or call["status"] for call in view["model_calls"]}
        if "malformed" in statuses:
            invalid_json_turns += 1
        else:
            unknown_action_turns += 1

        # No world effect: no action event, no action in the record, nothing moved.
        assert events_of(view, "action") == []
        assert view["turn"]["action"] is None
        before, after = agent_of(previous, agent_id), agent_of(view, agent_id)
        for field in ("position", "skills", "upgrade_counts", "alive", "total_compute_spent"):
            assert after[field] == before[field], f"{row['turn_id']}: {field} changed"
        for stat in ("health", "essence", "max_health", "vision_range", "speed"):
            assert after["stats"][stat] == before["stats"][stat], f"{row['turn_id']}: {stat} changed"
        assert before["stats"]["compute"] - after["stats"]["compute"] == pytest.approx(charged_cognition(view))
        assert after["last_result"]["ok"] is False and after["last_result"]["reason"] == "invalid_action"

        # Feedback record for the agent (told why next turn), besides the cognition charge.
        records = api.knowledge(run_id, row["turn_id"], agent_id)["knowledge"]["records"]
        feedback = [
            r
            for r in records
            if r["kind"] == "system"
            and "cognition_charged" not in r["content"]
            and (r["provenance"].get("turn_id") == row["turn_id"] or (r["provenance"].get("turn_id") is None and r["round"] == row["round"]))
        ]
        assert feedback, f"{row['turn_id']}: no decision_invalid feedback record"

    assert invalid_json_turns == 8, f"expected one invalid-JSON turn per agent, got {invalid_json_turns}"
    assert unknown_action_turns == 8, f"expected one unknown-action turn per agent, got {unknown_action_turns}"
    assert valid_turns == 8


def test_envelope_mistakes_are_salvaged_and_the_action_applies(api):
    """A-COG-11: a decision nested under "action", or pasted as a JSON string under an invented key,
    is repaired without a model call; the turn is not lost and the action applies normally."""
    import json

    request = base_request(api, "e2e salvage")
    card(request, "a01")["position"] = {"x": 0, "y": 0}
    up, down = decision("move", "Go up.", direction="up"), decision("move", "Come back.", direction="down")
    script_card(request, "a01", [{"action": up}, {"output": json.dumps(down)}])
    run_id = api.create_run(request)["run_id"]
    api.step_rounds(run_id, 2)
    for row, expected in zip(first_turns(api, run_id, "a01", 2), [(0, 1), (0, 0)]):
        view, _ = api.turn_and_previous(run_id, row["turn_id"])
        assert events_of(view, "decision_invalid") == []
        assert view["turn"]["action"]["name"] == "move" and view["turn"]["action_result"]["ok"] is True
        assert point(agent_of(view, "a01")["position"]) == expected
        completed = events_of(view, "model_call_completed")
        assert len(completed) == 1 and completed[0]["details"].get("salvaged_from"), completed


def test_move_into_mountain_fails_and_position_is_unchanged(api):
    """Design 'Action blocks': moving into a mountain fails without changing position;
    the affordable-but-illegal attempt costs only the fee min(1, 5) = 1."""
    request = base_request(api, "e2e mountain")
    preview = api.preview_map(request)
    start, direction = find_mountain_edge(preview)
    card(request, "a01")["position"] = {"x": start[0], "y": start[1]}
    script_card(request, "a01", [decision("move", "Walk into the rock.", direction=direction)])
    run_id = api.create_run(request)["run_id"]
    live_map = api.live(run_id)["map"]
    assert live_map["cells"] == preview["cells"], "POST /world/preview must show the terrain the run gets (A-WORLD-6)"
    assert point(api.live(run_id)["entities"]["agents"]["a01"]["position"]) == start
    api.step_round(run_id)
    (row,) = first_turns(api, run_id, "a01", 1)
    view, previous = api.turn_and_previous(run_id, row["turn_id"])
    result = view["turn"]["action_result"]
    assert result["ok"] is False and result["reason"] == "blocked", result
    assert result["cost_compute"] == pytest.approx(1.0)
    assert point(agent_of(view, "a01")["position"]) == start
    before, after = agent_of(previous, "a01"), agent_of(view, "a01")
    assert after["total_compute_spent"] - before["total_compute_spent"] == pytest.approx(1.0)
    assert "blocked" in events_of(view, "action")[0]["summary"]


def test_unaffordable_agent_is_skipped_and_starves_at_round_end(api):
    """Set a03's compute to 0 (god mode set_stat): its turn is skipped with a resource
    event (no model call, A-COG-2) and upkeep at round end costs it 5 health (A-ACT-11)."""
    run_id = api.create_run(base_request(api, "e2e unaffordable"))["run_id"]
    staged = api.stage(run_id, {"type": "set_stat", "entity_id": "a03", "field": "stats.compute", "value": 0})
    assert [iv["type"] for iv in staged["staged"]] == ["set_stat"]
    assert staged["staged"][0]["id"].startswith("iv_")
    api.step_round(run_id)

    turns = api.turns(run_id)
    first = api.turn(run_id, turns[1]["turn_id"])
    records = first["turn"]["interventions"]
    assert len(records) == 1 and records[0]["ok"] is True
    assert records[0]["effective_turn_id"] == turns[1]["turn_id"]
    change = next(c for c in records[0]["changes"] if c["path"].endswith("stats.compute"))
    assert change["before"] == pytest.approx(200.0) and change["after"] == pytest.approx(0.0)

    (row,) = [t for t in turns if t.get("acting_agent_id") == "a03"]
    view = api.turn(run_id, row["turn_id"])
    assert view["turn"]["decision_source"] == "skipped_unaffordable"
    assert view["turn"]["model_call_ids"] == [] and view["turn"]["action"] is None
    skips = events_of(view, "resource_skip")
    assert len(skips) == 1 and skips[0]["actor"] == "a03"
    assert skips[0]["details"]["compute"] == pytest.approx(0.0)
    assert skips[0]["details"]["minimum_needed"] > 0
    assert events_of(view, "action") == [] and events_of(view, "model_call_pending") == []
    records = api.knowledge(run_id, row["turn_id"], "a03")["knowledge"]["records"]
    assert any(r["kind"] == "system" and r["round"] == 1 and "cognition_charged" not in r["content"] for r in records[1:])

    end = api.turn(run_id, "r00001_end")
    upkeep = [e for e in events_of(end, "upkeep") if e["details"]["agent_id"] == "a03"]
    assert upkeep and upkeep[0]["details"]["paid"] == pytest.approx(0.0)
    assert upkeep[0]["details"]["owed"] == pytest.approx(1.0)
    starvation = [e for e in events_of(end, "starvation") if e["details"]["agent_id"] == "a03"]
    assert len(starvation) == 1
    assert starvation[0]["details"]["health_loss"] == pytest.approx(5.0)
    assert starvation[0]["details"]["health_after"] == pytest.approx(95.0)
    assert agent_of(end, "a03")["stats"]["health"] == pytest.approx(95.0)
    assert agent_of(end, "a03")["alive"] is True


# Design example 3, verbatim ("Buy one vision upgrade if the current quote is affordable").
DESIGN_EXAMPLE_3 = """SET own_details = query(self)
IF own_details.ok == false
    RETURN own_details.reason
END
SET upgrade_quote = own_details.data.upgrade_quotes.vision_range
IF upgrade_quote.allowed == true
    IF own_details.data.compute >= upgrade_quote.compute + 5 AND own_details.data.essence >= upgrade_quote.essence
        SET upgrade_result = upgrade("vision_range")
        RETURN upgrade_result
    END
END
RETURN "upgrade_not_affordable_or_unavailable"
"""


def test_design_example_3_skill_sees_skill_prices_and_upgrades(api):
    """INTERFACES section 13: example 3 as a skill sees upgrade_quotes.vision_range.compute
    == 20 and essence == 2 (skill mode); the upgrade charges 20 compute + 2 essence, raises
    vision by 1 and does not refill anything (design 'Minimum prototype' checks)."""
    request = base_request(api, "e2e example 3")
    script_card(request, "a01", [skill_decision("see_further", DESIGN_EXAMPLE_3, thought="Upgrade vision.")])
    run_id = api.create_run(request)["run_id"]
    api.step_rounds(run_id, 2)
    query_row, upgrade_row = first_turns(api, run_id, "a01", 2)

    query_view = api.turn(run_id, query_row["turn_id"])
    turn = query_view["turn"]
    assert turn["action"]["name"] == "query" and turn["action"]["via_skill"] is True
    data = turn["action_result"]["data"]
    assert turn["action_result"]["cost_compute"] == pytest.approx(0.4)
    assert data["quote_mode"] == "skill"
    quote = data["upgrade_quotes"]["vision_range"]
    assert quote["compute"] == pytest.approx(20.0) and quote["essence"] == pytest.approx(2.0)
    assert quote["base_compute"] == pytest.approx(25.0) and quote["skill_compute"] == pytest.approx(20.0)
    assert quote["allowed"] is True and quote["next_value"] == 1

    view, previous = api.turn_and_previous(run_id, upgrade_row["turn_id"])
    turn = view["turn"]
    assert view["turn"]["decision_source"] == "skill"
    assert turn["action"]["name"] == "upgrade" and turn["action"]["via_skill"] is True
    result = turn["action_result"]
    assert result["ok"] is True, result
    assert result["cost_compute"] == pytest.approx(20.0) and result["cost_essence"] == pytest.approx(2.0)
    before, after = agent_of(previous, "a01"), agent_of(view, "a01")
    assert after["stats"]["vision_range"] == before["stats"]["vision_range"] + 1
    assert after["stats"]["essence"] == pytest.approx(before["stats"]["essence"] - 2.0)
    assert after["upgrade_counts"].get("vision_range") == 1
    for unchanged in ("health", "max_health", "essence_capacity", "speed", "communication_range"):
        assert after["stats"][unchanged] == before["stats"][unchanged], unchanged


def test_failed_upgrade_changes_nothing(api):
    """Design 'Failure and resource handling': an unaffordable upgrade fails with no debit
    (insufficient_essence) and leaves every stat unchanged."""
    request = base_request(api, "e2e failed upgrade")
    card(request, "a02")["stats"]["essence"] = 1  # the first upgrade needs 2 essence
    script_card(request, "a02", [decision("upgrade", "Try to get faster.", attribute="speed")])
    run_id = api.create_run(request)["run_id"]
    api.step_round(run_id)
    (row,) = first_turns(api, run_id, "a02", 1)
    view, previous = api.turn_and_previous(run_id, row["turn_id"])
    result = view["turn"]["action_result"]
    assert result["ok"] is False and result["reason"] == "insufficient_essence", result
    assert result["cost_compute"] == 0 and result["cost_essence"] == 0
    before, after = agent_of(previous, "a02"), agent_of(view, "a02")
    assert after["stats"]["speed"] == before["stats"]["speed"]
    assert after["stats"]["essence"] == before["stats"]["essence"]
    assert after["upgrade_counts"] == before["upgrade_counts"]
    assert after["total_compute_spent"] == before["total_compute_spent"]


def test_card_on_a_mountain_is_moved_to_land_with_a_warning(api):
    """A-WORLD-6: a card position on a mountain is moved to the nearest land cell and
    reported as a run_created warning (setup never fails on terrain the operator could
    not see; POST /world/preview shows it beforehand)."""
    request = base_request(api, "e2e mountain card")
    preview = api.preview_map(request)
    mountain = next(
        tuple(int(v) for v in cell.split(",")) for cell, kind in sorted(preview["cells"].items()) if kind == "mountain"
    )
    card(request, "a05")["position"] = {"x": mountain[0], "y": mountain[1]}
    run_id = api.create_run(request)["run_id"]
    init = api.turn(run_id, "r00000_init")
    moved_to = point(agent_of(init, "a05")["position"])
    assert moved_to != mountain
    assert terrain(init["map"], *moved_to) == "land"
    (created,) = events_of(init, "run_created")
    assert any("a05" in warning for warning in created["details"]["warnings"]), created["details"]["warnings"]
