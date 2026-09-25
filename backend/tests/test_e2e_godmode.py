"""
End-to-end: god mode and direct file editing (QA).

Spec "God mode and direct file editing" and INTERFACES section 10: staged UI
edits and ``working/`` file edits apply at the next turn boundary, are recorded
with before/after values, origin and effective turn, and never charge agents;
an unseen operator voice reaches only its recipients (U7); context settings can
change in god mode with run and agent scope (U16); invalid files leave the last
valid state available; a continuation from history keeps the parent's future.
"""

from __future__ import annotations

import json

import pytest

from e2e_support import (
    base_request,
    events_of,
    far_free_land,
    packet_text,
    point,
)

ALL_AGENTS = [f"a{i:02d}" for i in range(1, 9)]


def voice_records(knowledge_view: dict) -> list[dict]:
    return [r for r in knowledge_view["knowledge"]["records"] if r["kind"] == "operator_voice"]


def first_packet_turn(api, run_id: str, agent_id: str, not_before: str) -> tuple[str, str]:
    """(turn id, packet id) of the agent's first turn with a decision packet at or after
    the committed turn ``not_before``."""
    ids = [t["turn_id"] for t in api.turns(run_id)]
    start = ids.index(not_before)
    for row in api.turns(run_id)[start:]:
        if row.get("acting_agent_id") != agent_id:
            continue
        view = api.turn(run_id, row["turn_id"])
        if view["turn"]["packet_id"]:
            return row["turn_id"], view["turn"]["packet_id"]
    raise AssertionError(f"{agent_id} built no packet after {not_before}")


def change_mentions(record: dict, *words: str) -> list[dict]:
    """FieldChanges of an InterventionRecord whose path or values mention every word."""
    found = []
    for change in record["changes"]:
        blob = change["path"] + json.dumps(change.get("before")) + json.dumps(change.get("after"))
        if all(word in blob for word in words):
            found.append(change)
    return found


def test_voice_reaches_only_recipients_and_their_next_packet(api):
    """U7 / completion criterion 'An unseen operator voice reaches the selected recipients
    and appears in their recorded experience': one agent, selected agents, broadcast."""
    run_id = api.create_run(base_request(api, "e2e voice"))["run_id"]
    voices = [
        ({"mode": "agents", "agent_ids": ["a01"]}, "QA voice for one"),
        ({"mode": "agents", "agent_ids": ["a02", "a03"]}, "QA voice for two"),
        ({"mode": "broadcast_all"}, "QA voice for all"),
    ]
    for recipients, text in voices:
        api.stage(run_id, {"type": "voice", "recipients": recipients, "text": text})
    assert len(api.staged(run_id)) == 3
    assert api.status(run_id)["staged_intervention_count"] == 3
    # Nothing is delivered before the boundary.
    assert voice_records(api.live_knowledge(run_id, "a01")) == []

    api.run_turn(run_id)
    boundary = api.status(run_id)["current_turn_id"]
    view = api.turn(run_id, boundary)
    assert len(view["turn"]["interventions"]) == 3
    assert all(r["ok"] and r["effective_turn_id"] == boundary for r in view["turn"]["interventions"])
    voice_events = events_of(view, "operator_voice")
    assert len(voice_events) == 3 and all(e["actor"] == "operator" for e in voice_events)
    by_text = {e["details"]["text"]: e for e in voice_events}
    assert sorted(by_text["QA voice for one"]["details"]["recipients"]) == ["a01"]
    assert sorted(by_text["QA voice for two"]["details"]["recipients"]) == ["a02", "a03"]
    assert sorted(by_text["QA voice for all"]["details"]["recipients"]) == ALL_AGENTS
    assert api.staged(run_id) == []

    expected = {agent_id: {"QA voice for all"} for agent_id in ALL_AGENTS}
    expected["a01"].add("QA voice for one")
    expected["a02"].add("QA voice for two")
    expected["a03"].add("QA voice for two")
    for agent_id in ALL_AGENTS:
        records = voice_records(api.live_knowledge(run_id, agent_id))
        assert {r["content"]["text"] for r in records} == expected[agent_id], agent_id
        assert all(r["provenance"]["source"] == "unknown" for r in records)
        assert all(r["agent_id"] == agent_id for r in records)

    # The next packet of every agent carries its voices (and nobody else's).
    api.step_round(run_id)
    for agent_id in ALL_AGENTS:
        turn_id, packet_id = first_packet_turn(api, run_id, agent_id, boundary)
        packet = api.packet(run_id, turn_id, packet_id)
        text = packet_text(packet)
        own_ids = {r["id"] for r in voice_records(api.knowledge(run_id, turn_id, agent_id))}
        shown = set(packet["digest_record_ids"]) | set(packet["selected_record_ids"])
        assert own_ids <= shown, f"{agent_id}: voice records {own_ids - shown} not in its next packet"
        for voice_text in expected[agent_id]:
            assert voice_text in text, f"{agent_id}: '{voice_text}' missing from packet {packet_id}"
        for other in {"QA voice for one", "QA voice for two"} - expected[agent_id]:
            assert other not in text, f"{agent_id} saw a voice meant for someone else"


def test_context_settings_change_at_the_next_boundary(api):
    """U16 / spec 'Operator controls': run-scope and agent-scope context settings are
    staged, validated, applied at the next turn boundary (recorded with before/after and
    the effective turn id) and visible in that turn's settings.json and packets."""
    run_id = api.create_run(base_request(api, "e2e context settings"))["run_id"]
    before = api.settings(run_id)
    assert before["settings"]["context"]["recent_history_length"] == 5
    assert before["effective_context"]["a02"]["input_token_cap"] == 6000

    # Invalid settings are rejected at staging with problems (422 invalid_intervention).
    too_small = api.post_raw(
        f"/runs/{run_id}/interventions",
        {"type": "update_context_settings", "scope": "a02", "settings": {"input_token_cap": 100}},
    )
    assert too_small.status_code == 422, too_small.text
    assert too_small.json()["error"] == "invalid_intervention" and too_small.json()["problems"]
    unknown = api.post_raw(
        f"/runs/{run_id}/interventions",
        {"type": "update_context_settings", "scope": "zz99", "settings": {"input_token_cap": 5000}},
    )
    assert unknown.status_code == 422, unknown.text

    api.stage(
        run_id,
        {"type": "update_context_settings", "scope": "run", "settings": {"recent_history_length": 3, "retrieved_memory_limit": 2}},
    )
    api.stage(run_id, {"type": "update_context_settings", "scope": "a02", "settings": {"input_token_cap": 5000}})
    staged_view = api.settings(run_id)
    assert staged_view["settings"]["context"]["recent_history_length"] == 5, "staged settings applied too early"
    assert staged_view["effective_context"]["a02"]["input_token_cap"] == 6000

    api.run_turn(run_id)
    boundary = api.status(run_id)["current_turn_id"]
    view = api.turn(run_id, boundary)
    records = view["turn"]["interventions"]
    assert [r["intervention"]["type"] for r in records] == ["update_context_settings"] * 2
    assert all(r["ok"] and r["effective_turn_id"] == boundary for r in records)
    # Field-level (path ...recent_history_length, 5 -> 3) or object-level (after holds 3).
    run_changes = change_mentions(records[0], "recent_history_length")
    assert any(c["before"] == 5 and c["after"] == 3 for c in run_changes) or any(
        isinstance(c["after"], dict) and c["after"].get("recent_history_length") == 3 for c in run_changes
    ), records[0]["changes"]
    assert change_mentions(records[1], "5000"), records[1]["changes"]
    events = events_of(view, "intervention")
    assert len(events) == 2
    for event in events:
        assert event["actor"] == "operator"
        assert event["details"]["ok"] is True
        assert event["details"]["effective_turn_id"] == boundary
        assert event["details"]["origin"] == "ui"
        assert event["details"]["changes"]

    # settings.json of that turn reflects the change; history before it does not.
    settings_file = api.read_json(api.turn_dir(run_id, boundary) / "settings.json")
    assert settings_file["context"]["recent_history_length"] == 3
    assert settings_file["context"]["retrieved_memory_limit"] == 2
    assert settings_file["context_overrides"]["a02"]["input_token_cap"] == 5000
    init_settings = api.read_json(api.turn_dir(run_id, "r00000_init") / "settings.json")
    assert init_settings["context"]["recent_history_length"] == 5
    assert "a02" not in init_settings["context_overrides"]

    after = api.settings(run_id)
    assert after["effective_context"]["a02"]["input_token_cap"] == 5000
    assert after["effective_context"]["a01"]["input_token_cap"] == 6000
    assert all(ctx["recent_history_length"] == 3 for ctx in after["effective_context"].values())

    # Packets built from this boundary on use the effective settings.
    api.step_round(run_id)
    checked = 0
    for row in api.turns(run_id):
        if row["kind"] != "agent_turn" or row["round"] != 1:
            continue
        turn = api.turn(run_id, row["turn_id"])["turn"]
        if not turn["packet_id"]:
            continue
        packet = api.packet(run_id, row["turn_id"], turn["packet_id"])
        effective = packet["effective_settings"]
        assert effective["recent_history_length"] == 3 and effective["retrieved_memory_limit"] == 2
        assert effective["input_token_cap"] == (5000 if row["acting_agent_id"] == "a02" else 6000)
        checked += 1
    assert checked >= 7


def test_set_stat_place_and_remove_entity_without_charging_agents(api):
    """U8: set_stat with before/after; place a fruit (tells nobody); remove it (recorded
    in world.removed with reason operator); no agent is charged for any edit."""
    run_id = api.create_run(base_request(api, "e2e set place remove"))["run_id"]
    init = api.live(run_id)
    agent_points = [point(a["position"]) for a in init["entities"]["agents"].values()]
    fx, fy = far_free_land(init["map"], agent_points, min_distance=6)

    api.stage(run_id, {"type": "set_stat", "entity_id": "a04", "field": "stats.compute", "value": 123.5, "note": "qa"})
    api.stage(
        run_id,
        {
            "type": "place_entity",
            "entity": {"kind": "fruit", "id": "", "position": {"x": fx, "y": fy}, "available_compute": 50},
        },
    )
    api.run_turn(run_id)
    boundary = api.status(run_id)["current_turn_id"]
    view = api.turn(run_id, boundary)
    set_record, place_record = view["turn"]["interventions"]
    assert set_record["ok"] and set_record["effective_turn_id"] == boundary
    change = next(c for c in set_record["changes"] if c["path"].endswith("stats.compute"))
    assert change["before"] == pytest.approx(200.0) and change["after"] == pytest.approx(123.5)
    assert set_record["intervention"]["note"] == "qa"
    assert place_record["ok"], place_record

    new_fruits = set(view["entities"]["fruits"]) - set(init["entities"]["fruits"])
    assert len(new_fruits) == 1, new_fruits
    fruit_id = new_fruits.pop()
    fruit = view["entities"]["fruits"][fruit_id]
    assert point(fruit["position"]) == (fx, fy)
    assert fruit["available_compute"] == pytest.approx(50.0)
    assert fruit_id in view["map"]["occupants"].get(f"{fx},{fy}", [])

    actor = view["turn"]["acting_agent_id"]
    if actor != "a04":
        assert view["entities"]["agents"]["a04"]["stats"]["compute"] == pytest.approx(123.5)
    for agent_id, agent in view["entities"]["agents"].items():
        if agent_id not in (actor, "a04"):
            assert agent["stats"]["compute"] == init["entities"]["agents"][agent_id]["stats"]["compute"], (
                f"{agent_id} was charged for an operator edit"
            )
        knowledge = api.knowledge(run_id, boundary, agent_id)["knowledge"]
        assert fruit_id not in json.dumps(knowledge), f"placing a fruit told {agent_id} (reality edit != knowledge edit)"

    api.stage(run_id, {"type": "remove_entity", "entity_id": fruit_id})
    api.run_turn(run_id)
    removal_turn = api.status(run_id)["current_turn_id"]
    view = api.turn(run_id, removal_turn)
    (remove_record,) = view["turn"]["interventions"]
    assert remove_record["ok"] and remove_record["changes"]
    assert fruit_id not in view["entities"]["fruits"]
    assert view["entities"]["removed"][fruit_id]["reason"] == "operator"
    assert fruit_id not in view["map"]["occupants"].get(f"{fx},{fy}", [])
    # History keeps the fruit in the turn where it existed.
    assert fruit_id in api.turn(run_id, boundary)["entities"]["fruits"]


def test_working_file_edit_and_reload_records_before_after(api):
    """U9 literal god mode: edit working/entities/agents/a01.json while paused, POST
    working/reload -> an apply_working_files intervention with FieldChange before/after,
    applied at the next boundary with origin 'file'."""
    run_id = api.create_run(base_request(api, "e2e working reload"))["run_id"]
    api.step_round(run_id)
    base_turn = api.status(run_id)["current_turn_id"]
    rdir = api.run_dir(run_id)
    assert (rdir / "working" / "BASE_TURN").read_text().strip() == base_turn

    agent_file = rdir / "working" / "entities" / "agents" / "a01.json"
    data = json.loads(agent_file.read_text())
    old_compute = data["stats"]["compute"]
    data["stats"]["compute"] = 77.0
    agent_file.write_text(json.dumps(data, indent=2))

    reload = api.post(f"/runs/{run_id}/working/reload")
    assert reload["ok"] is True, reload
    assert reload["errors"] == []
    changes = [c for c in reload["changes"] if "a01" in c["path"] and c["path"].endswith("stats.compute")]
    assert len(changes) == 1, reload["changes"]
    assert changes[0]["before"] == pytest.approx(old_compute) and changes[0]["after"] == pytest.approx(77.0)
    staged = reload["staged"]
    assert staged["type"] == "apply_working_files" and staged["origin"] == "file"
    assert staged["base_turn_id"] == base_turn
    assert [iv["type"] for iv in api.staged(run_id)] == ["apply_working_files"]

    api.run_turn(run_id)
    boundary = api.status(run_id)["current_turn_id"]
    view = api.turn(run_id, boundary)
    (record,) = view["turn"]["interventions"]
    assert record["intervention"]["type"] == "apply_working_files"
    assert record["ok"] is True and record["effective_turn_id"] == boundary
    applied = [c for c in record["changes"] if "a01" in c["path"] and c["path"].endswith("stats.compute")]
    assert applied and applied[0]["before"] == pytest.approx(old_compute) and applied[0]["after"] == pytest.approx(77.0)
    (event,) = events_of(view, "intervention")
    assert event["details"]["origin"] == "file" and event["details"]["effective_turn_id"] == boundary
    if view["turn"]["acting_agent_id"] != "a01":
        assert view["entities"]["agents"]["a01"]["stats"]["compute"] == pytest.approx(77.0)
    assert (rdir / "working" / "BASE_TURN").read_text().strip() == boundary
    assert api.staged(run_id) == []


def test_invalid_working_json_is_reported_and_state_stays_intact(api):
    """Spec 'Literal god mode': invalid JSON produces a clear error naming the file and
    leaves the last valid state available; nothing is staged and the run keeps going."""
    run_id = api.create_run(base_request(api, "e2e bad working file"))["run_id"]
    api.run_turn(run_id)
    committed = api.status(run_id)["current_turn_id"]
    live_before = api.live(run_id)
    rdir = api.run_dir(run_id)
    bad_file = rdir / "working" / "entities" / "agents" / "a02.json"
    bad_file.write_text("{ this is not json")

    response = api.post_raw(f"/runs/{run_id}/working/reload")
    body = response.json()
    if response.status_code == 422:
        message = json.dumps(body)
    else:
        assert response.status_code == 200, response.text
        assert body["ok"] is False and body["errors"], body
        assert body.get("staged") is None
        message = json.dumps(body["errors"])
    assert "a02.json" in message, f"the error must name the file: {message}"

    assert api.staged(run_id) == []
    status = api.status(run_id)
    assert status["state"] == "paused" and status["current_turn_id"] == committed
    assert api.live(run_id)["entities"] == live_before["entities"]

    api.run_turn(run_id)
    assert api.status(run_id)["current_turn_id"] != committed
    # The commit refreshes working/ from the new checkpoint (the bad file is replaced).
    assert json.loads(bad_file.read_text())["id"] == "a02"


def test_continuation_from_history_keeps_the_parent_future(api):
    """Spec 'Editing history': a continuation from a recorded turn is a new run whose
    first checkpoint equals that turn, with a parent link, while the parent's later turns
    still exist unchanged."""
    parent = api.create_run(base_request(api, "e2e parent"))
    parent_id = parent["run_id"]
    api.step_rounds(parent_id, 2)
    parent_turns = api.turns(parent_id)
    historical = next(t for t in parent_turns if t["round"] == 1 and t.get("turn_index") == 4)
    source_view = api.turn(parent_id, historical["turn_id"])
    later_ids = [t["turn_id"] for t in parent_turns[parent_turns.index(historical) + 1 :]]
    assert later_ids and later_ids[-1] == "r00002_end"

    child = api.post(
        f"/runs/{parent_id}/continuations", {"from_turn_id": historical["turn_id"], "name": "e2e branch"}, expect=201
    )
    child_id = child["run_id"]
    assert child_id != parent_id
    assert child["world_id"] == parent["world_id"]
    assert child["parent"] == {"world_id": parent["world_id"], "run_id": parent_id, "turn_id": historical["turn_id"]}
    assert child["current_turn_id"] == historical["turn_id"]
    assert child["name"] == "e2e branch"

    child_turns = api.turns(child_id)
    assert [t["turn_id"] for t in child_turns] == [historical["turn_id"]]
    copied = api.turn(child_id, historical["turn_id"])
    for field in ("map", "entities", "rules", "settings"):
        assert copied[field] == source_view[field], f"continuation {field} differs from the parent turn"
    for field in ("turn_id", "kind", "round", "turn_index", "acting_agent_id", "scheduler", "action", "action_result"):
        assert copied["turn"][field] == source_view["turn"][field], field
    assert copied["parent"]["run_id"] == parent_id
    child_manifest = api.read_json(api.run_dir(child_id) / "manifest.json")
    assert child_manifest["parent"]["turn_id"] == historical["turn_id"]
    assert child_manifest["next_event_seq"] == source_view["turn"]["event_seq_end"] + 1
    assert child_manifest["next_intervention_seq"] == 1

    # The child opens paused and runs forward from the copied turn.
    status = api.open(child_id)
    assert status["state"] == "paused" and status["current_turn_id"] == historical["turn_id"]
    api.run_turn(child_id)
    new_turn = api.turns(child_id)[-1]
    scheduler = source_view["turn"]["scheduler"]
    assert new_turn["turn_id"] == f"r00001_t05_{scheduler['order'][4]}"
    new_view = api.turn(child_id, new_turn["turn_id"])
    assert new_view["turn"]["previous_turn_id"] == historical["turn_id"]
    assert min(e["seq"] for e in new_view["events"]) > source_view["turn"]["event_seq_end"]

    # The parent's future is preserved: same turns, same files, same manifest pointer.
    assert [t["turn_id"] for t in api.turns(parent_id)] == [t["turn_id"] for t in parent_turns]
    for turn_id in later_ids:
        assert api.turn_dir(parent_id, turn_id).is_dir(), turn_id
    assert api.read_json(api.run_dir(parent_id) / "manifest.json")["current_turn_id"] == "r00002_end"
    assert api.turn(parent_id, historical["turn_id"])["entities"] == source_view["entities"]


def test_plant_rules_are_readable_and_editable_as_a_species_change(api):
    """U3 'plant rules must be easy to see and modify': GET /rules shows the species rule;
    update_plant_rules replaces it at the next boundary (recorded before/after) without
    rewriting history; a rule whose name differs from the species is rejected (422)."""
    run_id = api.create_run(base_request(api, "e2e plant rules"))["run_id"]
    rules = api.get(f"/runs/{run_id}/rules")
    tree = rules["plant_species"]["fruit_tree"]
    assert [stage["name"] for stage in tree["stages"]] == ["sprout", "sapling", "mature"]
    assert tree["fruit_energy"] == pytest.approx(60.0)

    wrong_name = dict(tree, name="not_fruit_tree")
    rejected = api.post_raw(
        f"/runs/{run_id}/interventions", {"type": "update_plant_rules", "species": "fruit_tree", "rule": wrong_name}
    )
    assert rejected.status_code == 422 and rejected.json()["error"] == "invalid_intervention"

    edited = dict(tree, fruit_energy=80.0, max_fruit=4)
    api.stage(run_id, {"type": "update_plant_rules", "species": "fruit_tree", "rule": edited})
    assert api.get(f"/runs/{run_id}/rules")["plant_species"]["fruit_tree"]["fruit_energy"] == pytest.approx(60.0)
    api.run_turn(run_id)
    boundary = api.status(run_id)["current_turn_id"]
    (record,) = api.turn(run_id, boundary)["turn"]["interventions"]
    assert record["ok"] and record["intervention"]["type"] == "update_plant_rules"
    assert change_mentions(record, "fruit_energy") or change_mentions(record, "80"), record["changes"]
    turn_rules = api.read_json(api.turn_dir(run_id, boundary) / "rules.json")
    assert turn_rules["plant_species"]["fruit_tree"]["fruit_energy"] == pytest.approx(80.0)
    assert turn_rules["plant_species"]["fruit_tree"]["max_fruit"] == 4
    init_rules = api.read_json(api.turn_dir(run_id, "r00000_init") / "rules.json")
    assert init_rules["plant_species"]["fruit_tree"]["fruit_energy"] == pytest.approx(60.0)
    assert api.get(f"/runs/{run_id}/rules")["plant_species"]["fruit_tree"]["max_fruit"] == 4


def test_model_assignment_changes_at_the_next_boundary(api):
    """Spec 'Model calls': models are configured globally and per agent; god mode can
    reassign one agent (unknown keys rejected); the next packet/call uses the new model."""
    run_id = api.create_run(base_request(api, "e2e model assignment"))["run_id"]
    unknown = api.post_raw(
        f"/runs/{run_id}/interventions", {"type": "update_model_assignment", "scope": "a02", "model_key": "no-such-model"}
    )
    assert unknown.status_code == 422, unknown.text
    api.stage(run_id, {"type": "update_model_assignment", "scope": "a02", "model_key": "fake-malformed"})
    assert api.settings(run_id)["effective_model_key"]["a02"] == "fake-heuristic"
    api.step_round(run_id)
    settings = api.settings(run_id)
    assert settings["effective_model_key"]["a02"] == "fake-malformed"
    assert settings["effective_model_key"]["a01"] == "fake-heuristic"
    assert "fake-malformed" in api.get(f"/runs/{run_id}/rules")["cognition"]["mind_multipliers"]
    (row,) = [t for t in api.turns(run_id) if t.get("acting_agent_id") == "a02"]
    view = api.turn(run_id, row["turn_id"])
    assert [call["model_key"] for call in view["model_calls"]] == ["fake-malformed"]


def test_reload_at_the_round_end_starts_the_next_round_on_the_edited_world(api):
    """The literal god-mode flow at the boundary where step_round pauses: edit working/,
    reload, step_round.  Round 2 is committed as r00002_* on top of r00001_end, the
    committed r00001_end is untouched, and a reopen finds an intact chain."""
    run_id = api.create_run(base_request(api, "e2e reload at round end"))["run_id"]
    api.step_round(run_id)
    rdir = api.run_dir(run_id)
    end_state_before = (rdir / "turns" / "r00001_end" / "state.json").read_text()
    plants_file = rdir / "working" / "entities" / "plants.json"
    plants = json.loads(plants_file.read_text())
    first = next(iter(plants))
    plants[first]["energy"] += 1.0
    plants_file.write_text(json.dumps(plants, indent=2))
    assert api.post(f"/runs/{run_id}/working/reload")["ok"]

    status = api.step_round(run_id)
    assert status["current_turn_id"] == "r00002_end"
    entries = api.turns(run_id)
    ids = [e["turn_id"] for e in entries]
    assert len(ids) == len(set(ids)), ids
    round2 = [e for e in entries if e["round"] == 2]
    assert round2 and all(e["turn_id"].startswith("r00002_") for e in round2)
    assert ids[ids.index("r00001_end") + 1] == round2[0]["turn_id"]
    first_turn = api.turn(run_id, round2[0]["turn_id"])
    (record,) = first_turn["turn"]["interventions"]
    assert record["ok"] and record["effective_turn_id"] == round2[0]["turn_id"] and record["applied_round"] == 2
    assert first_turn["entities"]["plants"][first]["energy"] == pytest.approx(plants[first]["energy"])
    assert first_turn["turn"]["action_result"] is None or first_turn["turn"]["action_result"]["round"] == 2
    assert (rdir / "turns" / "r00001_end" / "state.json").read_text() == end_state_before

    api.close(run_id)
    assert api.open(run_id)["current_turn_id"] == "r00002_end"
    assert [e["turn_id"] for e in api.turns(run_id)] == ids


# ---------------------------------------------------------------------------
# Fix pass: a working/ reload never undoes UI edits staged in the same boundary (A-GOD-1)
# ---------------------------------------------------------------------------


def _reload_after_editing_a05_health(api, run_id: str, health: float) -> dict:
    agent_file = api.run_dir(run_id) / "working" / "entities" / "agents" / "a05.json"
    data = json.loads(agent_file.read_text())
    data["stats"]["health"] = health
    agent_file.write_text(json.dumps(data, indent=2))
    reload = api.post(f"/runs/{run_id}/working/reload")
    assert reload["ok"] is True, reload
    assert [c["path"] for c in reload["changes"]] == ["world.agents.a05.stats.health"]
    return reload


def _stage_ui_edits(api, run_id: str, live: dict) -> tuple[int, int]:
    """Voice, a placed fruit, a stat change on the agent the file also edits, a run setting."""
    api.stage(run_id, {"type": "voice", "recipients": {"mode": "agents", "agent_ids": ["a01"]}, "text": "repro voice"})
    fx, fy = far_free_land(live["map"], [point(a["position"]) for a in live["entities"]["agents"].values()])
    api.stage(
        run_id,
        {"type": "place_entity", "entity": {"kind": "fruit", "id": "", "position": {"x": fx, "y": fy}, "available_compute": 33, "available_essence": 0}},
    )
    api.stage(run_id, {"type": "set_stat", "entity_id": "a05", "field": "stats.health", "value": 50})
    api.stage(run_id, {"type": "update_context_settings", "scope": "run", "settings": {"recent_history_length": 3}})
    return fx, fy


def _a05_was_attacked(view: dict) -> bool:
    for event in events_of(view, "action"):
        action = event["details"].get("action") or {}
        if action.get("name") == "attack" and (action.get("args") or {}).get("target") == "a05":
            return True
    return False


@pytest.mark.parametrize("order", ["ui_then_file", "file_then_ui"])
def test_working_reload_and_ui_edits_all_survive_in_either_staging_order(api, order):
    """Regression (qa/retest/p3_reload_revert.mjs): a reload staged after UI edits used to
    replace world/knowledge/settings wholesale and silently undo them.  Now every staged
    edit is applied in staging order and the file edit is a field diff, so voice, placement,
    stat change and settings all survive; the one field both edited (a05 health) keeps the
    value of the edit staged later, and each record shows the value it really replaced."""
    run_id = api.create_run(base_request(api, f"e2e reload order {order}"))["run_id"]
    live = api.live(run_id)
    if order == "ui_then_file":
        fx, fy = _stage_ui_edits(api, run_id, live)
        _reload_after_editing_a05_health(api, run_id, 77.0)
    else:
        _reload_after_editing_a05_health(api, run_id, 77.0)
        fx, fy = _stage_ui_edits(api, run_id, live)
    assert [iv["type"] for iv in api.staged(run_id)] == (
        ["voice", "place_entity", "set_stat", "update_context_settings", "apply_working_files"]
        if order == "ui_then_file"
        else ["apply_working_files", "voice", "place_entity", "set_stat", "update_context_settings"]
    )

    api.run_turn(run_id)
    boundary = api.status(run_id)["current_turn_id"]
    view = api.turn(run_id, boundary)
    records = view["turn"]["interventions"]
    assert [(r["intervention"]["type"], r["ok"], r["error"]) for r in records] == [(iv, True, None) for iv in [r["intervention"]["type"] for r in records]]
    assert len(records) == 5 and api.staged(run_id) == []

    # Every UI edit survived ...
    assert len(voice_records(api.knowledge(run_id, boundary, "a01"))) == 1
    placed = [f for f in view["entities"]["fruits"].values() if f["available_compute"] == 33]
    assert len(placed) == 1 and point(placed[0]["position"]) == (fx, fy)
    assert placed[0]["id"] in view["map"]["occupants"][f"{fx},{fy}"]
    assert view["settings"]["context"]["recent_history_length"] == 3
    # ... and so did the file edit (both changed a05's health: the later-staged value wins).
    file_record = next(r for r in records if r["intervention"]["type"] == "apply_working_files")
    stat_record = next(r for r in records if r["intervention"]["type"] == "set_stat")
    (file_change,) = [c for c in file_record["changes"] if c["path"] == "world.agents.a05.stats.health"]
    (stat_change,) = [c for c in stat_record["changes"] if c["path"] == "world.agents.a05.stats.health"]
    if order == "ui_then_file":
        assert stat_change["before"] == pytest.approx(100.0) and stat_change["after"] == pytest.approx(50.0)
        assert file_change["before"] == pytest.approx(50.0) and file_change["after"] == pytest.approx(77.0)
        expected_health = 77.0
    else:
        assert file_change["before"] == pytest.approx(100.0) and file_change["after"] == pytest.approx(77.0)
        assert stat_change["before"] == pytest.approx(77.0) and stat_change["after"] == pytest.approx(50.0)
        expected_health = 50.0
    if not _a05_was_attacked(view):
        assert view["entities"]["agents"]["a05"]["stats"]["health"] == pytest.approx(expected_health)
    # The staged intervention still shows the diff as reloaded (before = committed value).
    assert file_record["intervention"]["changes"][0]["before"] == pytest.approx(100.0)
    # The feed carries the same record.
    (event,) = [e for e in events_of(view, "intervention") if e["details"]["intervention"]["type"] == "apply_working_files"]
    assert event["details"]["ok"] is True and event["details"]["changes"] == file_record["changes"]


def test_working_reload_is_rejected_whole_when_an_earlier_edit_removed_its_target(api):
    """A file change whose target an earlier staged edit removed cannot be applied: the file
    edit is recorded ok=False with the path and reason, NOTHING of it is applied (the other
    field it changed stays), and the earlier removal stands."""
    run_id = api.create_run(base_request(api, "e2e reload conflict"))["run_id"]
    live = api.live(run_id)
    fruit_id = sorted(live["entities"]["fruits"])[0]
    health_before = live["entities"]["agents"]["a05"]["stats"]["health"]
    api.stage(run_id, {"type": "remove_entity", "entity_id": fruit_id})

    rdir = api.run_dir(run_id)
    fruits_file = rdir / "working" / "entities" / "fruits.json"
    fruits = json.loads(fruits_file.read_text())
    fruits[fruit_id]["available_compute"] = 12.5
    fruits_file.write_text(json.dumps(fruits, indent=2))
    agent_file = rdir / "working" / "entities" / "agents" / "a05.json"
    agent = json.loads(agent_file.read_text())
    agent["stats"]["health"] = 77.0
    agent_file.write_text(json.dumps(agent, indent=2))
    reload = api.post(f"/runs/{run_id}/working/reload")
    assert reload["ok"] is True and sorted(c["path"] for c in reload["changes"]) == ["world.agents.a05.stats.health", f"world.fruits.{fruit_id}.available_compute"]

    api.run_turn(run_id)
    boundary = api.status(run_id)["current_turn_id"]
    view = api.turn(run_id, boundary)
    remove_record, file_record = view["turn"]["interventions"]
    assert remove_record["intervention"]["type"] == "remove_entity" and remove_record["ok"] is True
    assert file_record["intervention"]["type"] == "apply_working_files" and file_record["ok"] is False
    assert f"world.fruits.{fruit_id}.available_compute: world.fruits.{fruit_id} does not exist any more" in file_record["error"], file_record["error"]
    assert fruit_id not in view["entities"]["fruits"] and view["entities"]["removed"][fruit_id]["reason"] == "operator"
    if not _a05_was_attacked(view):
        assert view["entities"]["agents"]["a05"]["stats"]["health"] == pytest.approx(health_before), "nothing of the failed file edit may apply"
    assert api.staged(run_id) == []
    # The stale snapshot file is cleaned up with the failed intervention.
    assert not (rdir / file_record["intervention"]["snapshot_ref"]).exists()
