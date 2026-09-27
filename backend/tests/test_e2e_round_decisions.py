"""
End-to-end: simultaneous round decisions (A-SCHED-5, A-SCHED-6) through the public API.

Every agent that thinks in a round builds its packet from the world at round start and all
model calls of the round run at once; the turns then resolve one by one in speed order
(A-SCHED-1), so a faster agent's action lands first and a slower agent's decision is
checked against the world as it is when its own turn comes.  The per-turn records, ids and
files keep their formats (INTERFACES sections 5, 7 and 8).
"""

from __future__ import annotations

import time

from e2e_support import base_request, card, decision, events_of, packet_text, script_card, skill_decision

from empyrean import runner


def all_call_ids(api, run_id: str) -> list[str]:
    ids: list[str] = []
    for row in api.turns(run_id):
        ids += [c["call_id"] for c in api.turn(run_id, row["turn_id"])["model_calls"]]
    return ids


def agent_turn(api, run_id: str, agent_id: str, round_no: int) -> dict:
    rows = [r for r in api.agent_turns(run_id, agent_id) if r["round"] == round_no]
    assert rows, f"{agent_id} has no turn in round {round_no}"
    return api.turn(run_id, rows[0]["turn_id"])


def test_a_round_of_slow_calls_takes_about_one_call(api):
    """Eight agents whose calls each take 0.4 s: one round takes about one call's latency,
    not eight (the calls run at once on the decision pool)."""
    request = base_request(api, "e2e concurrent round", agent_count=8)
    for entry in request["agents"]:
        entry["fake_options"] = {"sleep_ms": 400}
    run_id = api.create_run(request)["run_id"]
    started = time.monotonic()
    api.step_round(run_id)
    elapsed = time.monotonic() - started
    assert elapsed < 8 * 0.4 * 0.5, f"a round of 8 x 0.4 s calls took {elapsed:.2f} s"
    calls = [c for row in api.turns(run_id) for c in api.turn(run_id, row["turn_id"])["model_calls"]]
    assert len(calls) == 8 and all(c["status"] == "completed" for c in calls)


def test_faster_agent_strikes_first_and_the_slower_decision_is_discarded(api):
    """Two agents on one point decide at round start to kill each other.  The faster one
    resolves first; the slower one is dead when its turn comes, its call is recorded as
    unused and nothing is charged for it."""
    request = base_request(api, "e2e speed race", agent_count=6)
    for agent_id, speed in (("a01", 3), ("a02", 1)):
        entry = card(request, agent_id)
        entry["position"] = {"x": 0, "y": 0}
        entry["stats"] = {**entry.get("stats", {}), "speed": speed, "health": 20.0, "compute": 200.0}
    script_card(request, "a01", [decision("attack", "Strike first.", target="a02", compute_budget=30)])
    script_card(request, "a02", [decision("attack", "Strike first.", target="a01", compute_budget=30)])
    run_id = api.create_run(request)["run_id"]
    api.step_round(run_id)

    first = agent_turn(api, run_id, "a01", 1)
    assert first["turn"]["turn_index"] == 1 and first["turn"]["action_result"]["ok"]
    assert first["turn"]["action_result"]["effects"]["killed"] is True

    second = agent_turn(api, run_id, "a02", 1)
    assert second["turn"]["decision_source"] == "skipped_dead" and second["turn"]["action"] is None
    [unused] = second["model_calls"]
    assert unused["status"] == "failed" and unused["error"] == runner.DEAD_BEFORE_TURN_MESSAGE
    assert unused["charged_compute"] == 0
    failed = events_of(second, "model_call_failed")
    assert len(failed) == 1 and failed[0]["details"]["infra"] is False and failed[0]["costs"]["compute"] == 0
    assert api.live(run_id)["entities"]["agents"]["a01"]["alive"] is True


def test_decisions_see_the_world_as_it_was_at_round_start(api):
    """A faster agent's message sent in round 1 is not in the slower agent's round-1 packet
    (that packet was built at round start); it is in the round-2 packet."""
    request = base_request(api, "e2e round start view", agent_count=6)
    for agent_id, speed in (("a01", 3), ("a02", 1)):
        entry = card(request, agent_id)
        entry["position"] = {"x": 0, "y": 0}
        entry["stats"] = {**entry.get("stats", {}), "speed": speed}
    script_card(request, "a01", [decision("send", "Say hello.", recipient="a02", message="PELICAN-7 hello"),
                                 decision("wait", "Rest.", rounds=1)])
    script_card(request, "a02", [decision("wait", "Rest.", rounds=1), decision("wait", "Rest.", rounds=1)])
    run_id = api.create_run(request)["run_id"]
    api.step_rounds(run_id, 2)

    round_one = agent_turn(api, run_id, "a02", 1)
    packet_one = api.packet(run_id, round_one["turn"]["turn_id"], round_one["turn"]["packet_id"])
    assert "PELICAN-7" not in packet_text(packet_one)
    round_two = agent_turn(api, run_id, "a02", 2)
    packet_two = api.packet(run_id, round_two["turn"]["turn_id"], round_two["turn"]["packet_id"])
    assert "PELICAN-7" in packet_text(packet_two)


def test_an_edit_between_turns_makes_the_rest_of_the_round_decide_again(api):
    """A staged edit applied mid-round voids the decisions still waiting (each recorded in
    its own agent's turn, never charged) and the remaining agents decide again from the
    edited world with new call ids."""
    request = base_request(api, "e2e edit mid round", agent_count=6)
    run_id = api.create_run(request)["run_id"]
    api.run_turn(run_id)
    order = api.live(run_id)["turn"]["scheduler"]["order"]
    api.stage(run_id, {"type": "set_stat", "entity_id": order[1], "field": "stats.compute", "value": 123})
    api.step_round(run_id)
    for agent_id in order[1:]:
        view = agent_turn(api, run_id, agent_id, 1)
        turn_id = view["turn"]["turn_id"]
        calls = {c["call_id"]: c for c in view["model_calls"]}
        assert set(calls) == {f"mc_{turn_id}_01", f"mc_{turn_id}_02"}, calls
        voided, used = calls[f"mc_{turn_id}_01"], calls[f"mc_{turn_id}_02"]
        assert voided["error"] == runner.EDITED_BEFORE_TURN_MESSAGE and voided["charged_compute"] == 0
        assert used["status"] == "completed"
        assert all(e["actor"] == agent_id for e in events_of(view, "model_call_failed"))
    assert agent_turn(api, run_id, order[1], 1)["entities"]["agents"][order[1]]["stats"]["compute"] < 123
    ids = all_call_ids(api, run_id)
    assert len(ids) == len(set(ids)), "a call id was reused"


def test_close_and_reopen_mid_round_never_reuses_a_call_id(api):
    """Closing mid-round cancels the waiting round calls (they come back as interrupted on
    open); the rest of the round decides again and every call id in the run stays unique."""
    request = base_request(api, "e2e reopen mid round", agent_count=6)
    run_id = api.create_run(request)["run_id"]
    api.run_turn(run_id)
    api.close(run_id)
    api.open(run_id)
    api.step_round(run_id)
    ids = all_call_ids(api, run_id)
    assert len(ids) == len(set(ids)), "a call id was reused"
    interrupted = [c for row in api.turns(run_id) for c in api.turn(run_id, row["turn_id"])["model_calls"]
                   if c["error"] == runner.INTERRUPTED_MESSAGE]
    assert len(interrupted) == 5
    assert api.status(run_id)["real_usage"]["interrupted_calls"] == 5


def fail_first_turn(api, name: str) -> dict:
    """a01 (fastest) times out on every attempt of its round-1 call: the run enters error in
    the round's first turn, after every round decision was already started."""
    request = base_request(api, name, agent_count=6)
    for entry in request["agents"]:
        entry["stats"] = {**entry.get("stats", {}), "speed": 1}
    first = card(request, "a01")
    first["stats"] = {**first.get("stats", {}), "speed": 5}
    first["fake_options"] = {"fail": {"status": "timeout", "rounds": [1], "failing_attempts": 3}}
    return request


def test_an_edit_staged_after_a_failed_first_turn_reaches_the_round_decisions(api):
    """The round's first turn fails after the round decisions were made; a voice staged while
    the run is in error must reach a02's round-1 packet: the re-run applies a different set of
    edits, so the old decisions are voided and made again."""
    run_id = api.create_run(fail_first_turn(api, "e2e edit after error"))["run_id"]
    api.command(run_id, "run_turn")
    assert api.wait_idle(run_id)["state"] == "error"
    api.stage(run_id, {"type": "voice", "recipients": {"mode": "agents", "agent_ids": ["a02"]}, "text": "ZEBRA-99 beware"})
    api.command(run_id, "pause")
    api.step_round(run_id)
    view = agent_turn(api, run_id, "a02", 1)
    assert "ZEBRA-99" in packet_text(api.packet(run_id, view["turn"]["turn_id"], view["turn"]["packet_id"]))
    ids = all_call_ids(api, run_id)
    assert len(ids) == len(set(ids))


def test_reopen_after_a_failed_first_turn_records_each_call_in_its_own_turn(api):
    """Error in the round's first turn, then close and open: the other agents' interrupted
    round calls are recorded in their own turns, not all in the first one (A-SCHED-6)."""
    run_id = api.create_run(fail_first_turn(api, "e2e reopen after error"))["run_id"]
    api.command(run_id, "run_turn")
    assert api.wait_idle(run_id)["state"] == "error"
    api.command(run_id, "pause")
    api.close(run_id)
    api.open(run_id)
    api.step_round(run_id)
    for row in api.turns(run_id):
        if row["kind"] != "agent_turn":
            continue
        view = api.turn(run_id, row["turn_id"])
        assert {e["actor"] for e in events_of(view, "model_call_failed")} <= {row["acting_agent_id"]}, row["turn_id"]
        assert all(c["agent_id"] == row["acting_agent_id"] for c in view["model_calls"]), row["turn_id"]
    ids = all_call_ids(api, run_id)
    assert len(ids) == len(set(ids))


def test_an_interrupted_skill_shows_as_stopped_in_the_round_packet(api):
    """interrupt_on ["message"]: a02's looping skill is interrupted by a01's message at the next
    round start; the packet of that decision shows the skill stopped, not running."""
    request = base_request(api, "e2e interrupt packet", agent_count=6)
    request["rules"]["skills"]["interrupt_on"] = ["message"]
    for agent_id, speed in (("a01", 5), ("a02", 1)):
        entry = card(request, agent_id)
        entry["position"] = {"x": 0, "y": 0}
        entry["stats"] = {**entry.get("stats", {}), "speed": speed}
    script_card(request, "a01", [decision("send", "hi", recipient="a02", message="KESTREL-3"),
                                 decision("wait", "r", rounds=1), decision("wait", "r", rounds=1)])
    pace = 'REPEAT 20\n    SET r = move("up")\n    SET r = move("down")\nEND\nRETURN "done"\n'
    script_card(request, "a02", [skill_decision("pace", pace, thought="pace"), decision("wait", "r", rounds=1)])
    run_id = api.create_run(request)["run_id"]
    api.step_rounds(run_id, 2)
    view = agent_turn(api, run_id, "a02", 2)
    finished = events_of(view, "skill_finished")
    assert finished and finished[0]["details"]["error"] == "interrupted"
    text = packet_text(api.packet(run_id, view["turn"]["turn_id"], view["turn"]["packet_id"]))
    lines = [line for line in text.splitlines() if "Skill execution" in line]
    assert lines and not any("is running" in line for line in lines), lines


def test_a_removal_mid_round_records_the_removed_agents_call_after_its_turn_started(api):
    """remove_entity for the next agent in the order: its skipped_removed turn shows
    turn_started first, then its unused round call with the removal reason (A-SCHED-4/6)."""
    run_id = api.create_run(base_request(api, "e2e remove mid round", agent_count=6))["run_id"]
    api.run_turn(run_id)
    victim = api.live(run_id)["turn"]["scheduler"]["order"][1]
    api.stage(run_id, {"type": "remove_entity", "entity_id": victim})
    api.step_round(run_id)
    row = next(r for r in api.turns(run_id) if r["turn_id"].startswith("r00001_t02_"))
    view = api.turn(run_id, row["turn_id"])
    assert view["turn"]["decision_source"] == "skipped_removed"
    kinds = [e["kind"] for e in view["events"] if e["actor"] == victim]
    assert kinds == ["turn_started", "model_call_failed"], kinds
    [unused] = view["model_calls"]
    assert unused["error"] == runner.REMOVED_BEFORE_TURN_MESSAGE and unused["charged_compute"] == 0


def test_voided_round_calls_are_cancelled_not_waited_out(api):
    """a01 answers at once, the other five take 4 s.  An edit after a01's turn voids the five
    waiting calls: they are cancelled (not waited out), so the next turn takes about one new
    call, not two."""
    request = base_request(api, "e2e cancel voided", agent_count=6)
    for entry in request["agents"]:
        entry["stats"] = {**entry.get("stats", {}), "speed": 1}
        entry["fake_options"] = {"sleep_ms": 4000}
    first = card(request, "a01")
    first["stats"]["speed"] = 5
    first["fake_options"] = {}
    run_id = api.create_run(request)["run_id"]
    api.run_turn(run_id)
    second = api.live(run_id)["turn"]["scheduler"]["order"][1]
    api.stage(run_id, {"type": "set_stat", "entity_id": second, "field": "stats.compute", "value": 150})
    started = time.monotonic()
    api.run_turn(run_id)
    assert time.monotonic() - started < 7.0  # one new 4 s call, not the old one waited out first
    view = api.live(run_id)
    voided = next(c for c in view["model_calls"] if c["error"] == runner.EDITED_BEFORE_TURN_MESSAGE)
    assert voided["result_status"] == "error" and voided["charged_compute"] == 0
    assert [e["kind"] for e in view["events"] if e["actor"] == second][:2] == ["turn_started", "model_call_failed"]
