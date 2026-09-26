"""
End-to-end: run lifecycle through the public API (QA).

Covers the spec "Completion criteria" item "An eight-agent run can pause, restart,
and continue without losing state or repeating a committed action", the
"Sessions and run controls" table (Run turn / Play / Pause / Step round), the
"State and file storage" folder layout (INTERFACES section 5), the persistence
requirement (incomplete writes never replace the last complete checkpoint;
pending model calls are recovered), and fake-heuristic determinism
(INTERFACES section 12).

Every test uses FastAPI's TestClient with a fresh RunManager on a temporary
worlds dir (conftest ``api``) and fake models only.
"""

from __future__ import annotations

import json
import re
import time

import pytest

from e2e_support import (
    ACTIVE_STATES,
    AGENT_TURN_ID,
    REQUIRED_RUN_FILES,
    REQUIRED_TURN_DIRS,
    REQUIRED_TURN_FILES,
    REQUIRED_WORKING_FILES,
    base_request,
    fresh_api,
    turn_bytes,
)

# Event kinds whose actor must be the acting agent of an agent turn (INTERFACES section 7).
AGENT_ACTOR_KINDS = (
    "turn_started",
    "model_call_pending",
    "model_call_completed",
    "model_call_failed",
    "resource_skip",
    "decision",
    "decision_invalid",
    "skill_saved",
    "skill_rejected",
    "skill_deleted",
    "skill_started",
    "skill_step",
    "skill_finished",
    "skill_error",
    "action",
)


# ---------------------------------------------------------------------------
# Shared checks
# ---------------------------------------------------------------------------


def predicted_next_agent_turn(state: dict) -> str:
    """The turn id the scheduler of a committed mid-round state.json runs next."""
    scheduler = state["scheduler"]
    assert not scheduler["round_complete"], "prediction only works mid-round"
    index = scheduler["next_index"]
    assert index < len(scheduler["order"]), "round is complete; next is the round end"
    return f"r{scheduler['round']:05d}_t{index + 1:02d}_{scheduler['order'][index]}"


def assert_turn_dir_complete(api, run_id: str, entry: dict, agent_count: int) -> None:
    """Every committed turn has a directory with the documented files (section 5)."""
    tdir = api.turn_dir(run_id, entry["turn_id"])
    for name in REQUIRED_TURN_FILES:
        assert (tdir / name).is_file(), f"{entry['turn_id']}: missing {name}"
    for name in REQUIRED_TURN_DIRS:
        assert (tdir / name).is_dir(), f"{entry['turn_id']}: missing dir {name}/"
    agent_files = sorted(p.name for p in (tdir / "entities" / "agents").glob("*.json"))
    knowledge_files = sorted(p.name for p in (tdir / "entities" / "knowledge").glob("*.json"))
    assert len(agent_files) >= agent_count, f"{entry['turn_id']}: agents {agent_files}"
    # Knowledge files are written only when they changed (storage docstring): the local ones
    # are a subset of the agents, and world.json maps EVERY agent to the turn holding its file.
    assert set(knowledge_files) <= set(agent_files), f"{entry['turn_id']}: knowledge files without an agent"
    refs = api.read_json(tdir / "world.json")["knowledge_files"]
    assert sorted(f"{aid}.json" for aid in refs) == agent_files, f"{entry['turn_id']}: knowledge map does not cover the agents"
    for aid, ref in refs.items():
        held = api.turn_dir(run_id, ref["turn_id"]) / "entities" / "knowledge" / f"{aid}.json"
        assert held.is_file(), f"{entry['turn_id']}: knowledge of {aid} referenced in {ref['turn_id']} is missing"
        assert api.knowledge(run_id, entry["turn_id"], aid)["knowledge"]["agent_id"] == aid

    state = api.read_json(tdir / "state.json")
    assert state["turn_id"] == entry["turn_id"]
    assert state["kind"] == entry["kind"]
    assert state["round"] == entry["round"]

    call_index = api.read_json(tdir / "model_calls" / "index.json")
    assert sorted(c["call_id"] for c in call_index) == sorted(state["model_call_ids"])
    for call_id in state["model_call_ids"]:
        assert (tdir / "model_calls" / f"{call_id}.json").is_file(), f"missing call record {call_id}"
        assert call_id.startswith(f"mc_{entry['turn_id']}_"), call_id
    if state["packet_id"]:
        assert state["packet_id"] == f"pk_{entry['turn_id']}"
        assert (tdir / "decision_packets" / f"{state['packet_id']}.json").is_file()
    if state["decision_source"] == "model":
        assert state["model_call_ids"], f"{entry['turn_id']}: model decision without a call record"
        assert state["packet_id"], f"{entry['turn_id']}: model decision without a packet"


def assert_events_reference_turns(api, run_id: str, entries: list[dict]) -> list[int]:
    """Events carry their turn id, round and actor; seqs strictly increase along the
    committed chain (gaps allowed, section 3).  Returns every committed seq in order."""
    seqs: list[int] = []
    for entry in entries:
        events = api.read_json(api.turn_dir(run_id, entry["turn_id"]) / "events.json")
        state = api.read_json(api.turn_dir(run_id, entry["turn_id"]) / "state.json")
        assert events or entry["kind"] == "init", f"{entry['turn_id']} has no events"
        for event in events:
            assert event["turn_id"] == entry["turn_id"], event
            assert event["round"] == entry["round"], event
            assert event["actor"], event
            assert event["summary"], event
            if entry["kind"] == "agent_turn" and event["kind"] in AGENT_ACTOR_KINDS:
                assert event["actor"] == entry["acting_agent_id"], event
            if event["kind"] in ("round_started", "plant_growth", "round_ended", "upkeep", "starvation"):
                assert event["actor"] == "world", event
            if event["kind"] in ("intervention", "operator_voice"):
                assert event["actor"] == "operator", event
            if event["kind"] == "model_call_pending":
                assert event["pending"] is True
            else:
                assert event["pending"] is False, event
            seqs.append(event["seq"])
        if events:
            assert state["event_seq_start"] <= events[0]["seq"], entry["turn_id"]
            assert events[-1]["seq"] <= state["event_seq_end"], entry["turn_id"]
    assert seqs == sorted(seqs) and len(seqs) == len(set(seqs)), "event seqs repeat or go backwards"
    return seqs


def assert_chain(entries: list[dict], api, run_id: str) -> None:
    """Turn ids are unique and each previous_turn_id links to the entry before it."""
    ids = [e["turn_id"] for e in entries]
    assert len(ids) == len(set(ids)), f"repeated turn ids: {ids}"
    for before, after in zip(entries, entries[1:]):
        state = api.read_json(api.turn_dir(run_id, after["turn_id"]) / "state.json")
        assert state["previous_turn_id"] == before["turn_id"], (before["turn_id"], after["turn_id"])


def event_digest(api, run_id: str, run_ids: tuple[str, str]) -> list[tuple]:
    """(turn id, seq, kind, actor, summary) for every committed event, with the run and
    world ids replaced so two runs can be compared (summaries carry no latency)."""
    rows = []
    for entry in api.turns(run_id):
        for event in api.turn_events(run_id, entry["turn_id"]):
            summary = event["summary"]
            for value, placeholder in zip(run_ids, ("<run>", "<world>")):
                summary = summary.replace(value, placeholder)
            rows.append((entry["turn_id"], event["seq"], event["kind"], event["actor"], summary))
    return rows


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_create_run_from_defaults_opens_paused_with_init_checkpoint(api):
    """New session: defaults (8 cards, seed 1) -> run saved with r00000_init, opened paused."""
    request = api.defaults(8)
    assert len(request["agents"]) == 8
    assert request["seed"] == 1
    assert request["default_model_key"] == "fake-heuristic"
    assert [c["id"] for c in request["agents"]] == [f"a{i:02d}" for i in range(1, 9)]
    request["name"] = "e2e create"

    summary = api.create_run(request)
    run_id = summary["run_id"]
    assert re.match(r"^run_\d{8}_\d{6}_[0-9a-f]{4}$", run_id), run_id
    assert re.match(r"^world_\d{8}_\d{6}_[0-9a-f]{4}$", summary["world_id"])
    assert summary["current_turn_id"] == "r00000_init"
    assert summary["agent_count"] == 8

    status = api.status(run_id)
    assert status["state"] == "paused"
    assert status["current_turn_id"] == "r00000_init"
    assert status["round"] == 0
    assert status["next_step"] == "new_round"
    assert status["living_agent_count"] == 8
    assert status["active_command"] is None

    rdir = api.run_dir(run_id)
    assert rdir.parent.parent.name == summary["world_id"]
    for name in REQUIRED_RUN_FILES + REQUIRED_WORKING_FILES:
        assert (rdir / name).is_file(), f"missing {name}"
    assert (rdir / "working" / "BASE_TURN").read_text().strip() == "r00000_init"
    assert sorted(p.stem for p in (rdir / "working" / "entities" / "agents").glob("*.json")) == [
        f"a{i:02d}" for i in range(1, 9)
    ]

    manifest = api.read_json(rdir / "manifest.json")
    assert manifest["run_id"] == run_id and manifest["world_id"] == summary["world_id"]
    assert manifest["current_turn_id"] == "r00000_init"
    assert manifest["seed"] == 1
    assert manifest["parent"] is None
    assert manifest["agent_count"] == 8
    assert manifest["next_event_seq"] >= 2

    assumptions = api.read_json(rdir / "assumptions.json")
    assert assumptions and all(entry["id"].startswith("A-") for entry in assumptions)

    index_lines = (rdir / "turns" / "index.jsonl").read_text().strip().splitlines()
    assert [json.loads(line)["turn_id"] for line in index_lines] == ["r00000_init"]

    entries = api.turns(run_id)
    assert [e["turn_id"] for e in entries] == ["r00000_init"]
    assert_turn_dir_complete(api, run_id, entries[0], agent_count=8)

    init_dir = api.turn_dir(run_id, "r00000_init")
    state = api.read_json(init_dir / "state.json")
    assert state["kind"] == "init" and state["round"] == 0
    assert list((init_dir / "decision_packets").iterdir()) == []
    assert api.read_json(init_dir / "model_calls" / "index.json") == []

    events = api.read_json(init_dir / "events.json")
    created = [e for e in events if e["kind"] == "run_created"]
    assert len(created) == 1 and created[0]["actor"] == "system"
    assert created[0]["details"]["run_id"] == run_id
    assert created[0]["details"]["seed"] == 1
    assert sorted(created[0]["details"]["agent_ids"]) == [f"a{i:02d}" for i in range(1, 9)]

    map_state = api.read_json(init_dir / "map.json")
    region = map_state["region"]
    assert len(map_state["cells"]) == (region["max_x"] - region["min_x"] + 1) * (region["max_y"] - region["min_y"] + 1)
    placed = {entity_id for ids in map_state["occupants"].values() for entity_id in ids}
    assert {f"a{i:02d}" for i in range(1, 9)} <= placed

    # Each agent starts with the birth disclosure (A-KNOW-6), nothing else hidden in it.
    for agent_id in ("a01", "a08"):
        knowledge = api.read_json(init_dir / "entities" / "knowledge" / f"{agent_id}.json")
        assert knowledge["agent_id"] == agent_id
        assert knowledge["records"], f"{agent_id} has no run-start record"
        assert knowledge["records"][0]["kind"] == "system"
        assert "self" in knowledge["records"][0]["content"]
        assert all(r["id"].startswith(f"{agent_id}-k") for r in knowledge["records"])

    listed = [s for s in api.get("/runs") if s["run_id"] == run_id]
    assert len(listed) == 1 and listed[0]["name"] == "e2e create"


def test_run_turn_step_round_play_pause_and_layout(api, capsys):
    """Run turn = exactly one agent turn; Step round ends at r00001_end; Play for three
    rounds then Pause shows pause_requested then paused; every committed turn has a
    complete checkpoint dir; events reference turn ids and actors; bytes per turn."""
    request = base_request(api, "e2e controls", play_delay_seconds=0.01)
    run_id = api.create_run(request)["run_id"]

    # -- Run turn: exactly one agent turn, then paused.
    response = api.command(run_id, "run_turn")
    assert response["state"] in ACTIVE_STATES + ("paused",), response
    status = api.wait_idle(run_id)
    assert status["state"] == "paused"
    entries = api.turns(run_id)
    assert len(entries) == 2, [e["turn_id"] for e in entries]
    first = entries[1]
    match = AGENT_TURN_ID.match(first["turn_id"])
    assert match and match.group(1) == "00001" and match.group(2) == "01", first["turn_id"]
    assert first["kind"] == "agent_turn" and first["acting_agent_id"] == match.group(3)
    assert status["current_turn_id"] == first["turn_id"]
    assert status["next_step"] == "agent_turn"

    view = api.turn(run_id, first["turn_id"])
    scheduler = view["turn"]["scheduler"]
    assert scheduler["round"] == 1 and scheduler["next_index"] == 1 and not scheduler["round_complete"]
    assert sorted(scheduler["order"]) == [f"a{i:02d}" for i in range(1, 9)]
    assert scheduler["order"][0] == first["acting_agent_id"]
    kinds = [e["kind"] for e in view["events"]]
    assert "round_started" in kinds and "turn_started" in kinds
    round_started = next(e for e in view["events"] if e["kind"] == "round_started")
    assert round_started["details"]["round"] == 1
    assert round_started["details"]["order"] == scheduler["order"]

    # -- Step round: the rest of round 1 and its round-end checkpoint.
    status = api.step_round(run_id)
    assert status["current_turn_id"] == "r00001_end"
    round_one = [e for e in api.turns(run_id) if e["round"] == 1]
    assert [e["turn_id"] for e in round_one] == [
        f"r00001_t{i + 1:02d}_{agent}" for i, agent in enumerate(scheduler["order"])
    ] + ["r00001_end"]
    end_view = api.turn(run_id, "r00001_end")
    assert end_view["turn"]["kind"] == "round_end"
    ended = [e for e in end_view["events"] if e["kind"] == "round_ended"]
    assert len(ended) == 1 and ended[0]["details"]["round"] == 1
    assert status["next_step"] == "new_round"

    # -- Play: overlapping commands are rejected while it drives the worker.
    response = api.command(run_id, "play")
    assert response["state"] in ACTIVE_STATES, response
    overlap = api.post_raw(f"/runs/{run_id}/commands", {"command": "run_turn"})
    assert overlap.status_code == 409, overlap.text
    assert overlap.json()["error"] == "illegal_command"

    # Play for three more rounds (until r00004_end commits), then Pause.
    turns_after_round_4 = lambda s: s["round"] >= 5 or s["current_turn_id"] == "r00004_end"  # noqa: E731
    api.wait_for(run_id, turns_after_round_4, timeout=120, what="round 4 to finish")
    paused = api.command(run_id, "pause")
    assert paused["state"] == "pause_requested", f"pause during play returned {paused['state']}"
    status = api.wait_idle(run_id)
    assert status["state"] == "paused"
    assert status["active_command"] is None and not status["play_loop"]
    assert status["last_error"] is None

    entries = api.turns(run_id)
    assert any(e["turn_id"] == "r00004_end" for e in entries)
    assert status["current_turn_id"] == entries[-1]["turn_id"]

    # -- Every committed turn: complete dir, linked chain, events with turn ids and actors.
    for entry in entries:
        assert_turn_dir_complete(api, run_id, entry, agent_count=8)
    assert_chain(entries, api, run_id)
    assert_events_reference_turns(api, run_id, entries)
    rdir = api.run_dir(run_id)
    index_ids = [json.loads(line)["turn_id"] for line in (rdir / "turns" / "index.jsonl").read_text().splitlines() if line]
    assert index_ids == [e["turn_id"] for e in entries]
    manifest = api.read_json(rdir / "manifest.json")
    assert manifest["current_turn_id"] == entries[-1]["turn_id"]
    assert manifest["turn_count"] == len(entries)
    assert (rdir / "working" / "BASE_TURN").read_text().strip() == entries[-1]["turn_id"]
    assert list((rdir / "turns").glob(".partial_*")) == []

    # -- Bytes per turn (spec "Scale estimate": measure actual bytes per turn early).
    sizes = turn_bytes(rdir)
    agent_sizes = [size for turn_id, size in sizes.items() if AGENT_TURN_ID.match(turn_id)]
    with capsys.disabled():
        print(
            f"\n[e2e bytes] {len(sizes)} turn dirs, total {sum(sizes.values())} B, "
            f"mean agent turn {sum(agent_sizes) // max(1, len(agent_sizes))} B, "
            f"max {max(sizes.values())} B, init {sizes.get('r00000_init')} B"
        )
    assert all(size > 0 for size in sizes.values())


def test_close_reopen_and_restart_continue_without_repeating(api, registry, worlds_dir):
    """Pause/restart/continue (completion criterion 1): close + open in the same process,
    then a fresh RunManager on the same worlds dir; the next turn id is the scheduled one,
    no turn id or event seq repeats, and every agent acts once per round."""
    run_id = api.create_run(base_request(api, "e2e reopen"))["run_id"]
    api.step_round(run_id)
    api.run_turn(run_id)  # mid-round 2
    before = api.turns(run_id)
    last = before[-1]
    expected_next = predicted_next_agent_turn(api.read_json(api.turn_dir(run_id, last["turn_id"]) / "state.json"))
    seqs_before = assert_events_reference_turns(api, run_id, before)
    knowledge_before = api.knowledge(run_id, last["turn_id"], "a01")

    epoch_before = api.status(run_id)["feed_epoch"]
    closed = api.close(run_id)
    assert closed["state"] == "paused"
    not_open = api.client.get(f"/api/runs/{run_id}/status")
    assert not_open.status_code == 409 and not_open.json()["error"] == "run_not_open"
    listed = next(s for s in api.get("/runs") if s["run_id"] == run_id)
    assert listed["current_turn_id"] == last["turn_id"] and listed["status"] == "paused"

    reopened = api.open(run_id)
    assert reopened["state"] == "paused"
    assert reopened["current_turn_id"] == last["turn_id"]
    assert reopened["feed_epoch"] and reopened["feed_epoch"] != epoch_before, "a restarted worker needs a new feed_epoch"
    api.run_turn(run_id)
    after = api.turns(run_id)
    assert [e["turn_id"] for e in after[:-1]] == [e["turn_id"] for e in before]
    assert after[-1]["turn_id"] == expected_next
    seqs_after = assert_events_reference_turns(api, run_id, after)
    assert min(s for s in seqs_after if s not in seqs_before) > max(seqs_before)
    # History is untouched by reopening.
    assert api.knowledge(run_id, last["turn_id"], "a01") == knowledge_before

    api.close(run_id)
    with fresh_api(registry, worlds_dir) as restarted:
        status = restarted.open(run_id)
        assert status["state"] == "paused"
        assert status["current_turn_id"] == after[-1]["turn_id"]
        status = restarted.step_round(run_id)
        assert status["current_turn_id"] == "r00002_end"
        entries = restarted.turns(run_id)
        assert_chain(entries, restarted, run_id)
        assert_events_reference_turns(restarted, run_id, entries)
        for round_no in (1, 2):
            actors = [e["acting_agent_id"] for e in entries if e["round"] == round_no and e["kind"] == "agent_turn"]
            assert sorted(actors) == [f"a{i:02d}" for i in range(1, 9)], f"round {round_no}: {actors}"
        manifest = restarted.read_json(restarted.run_dir(run_id) / "manifest.json")
        assert manifest["turn_count"] == len(entries)
        restarted.close(run_id)


def test_crash_recovery_discards_partial_turn_and_carries_interrupted_call(api, registry, worlds_dir):
    """Persistence requirement: a half-written turn dir never replaces the last complete
    checkpoint, and a pending model call left by a crash is recorded as interrupted
    (failed, uncharged) and carried into the re-run turn, whose new call is ``_02``."""
    from empyrean import storage
    from empyrean.schemas import ModelCallRecord, ModelMessage, ModelRequest, utc_now_iso

    run_id = api.create_run(base_request(api, "e2e crash"))["run_id"]
    api.step_round(run_id)
    api.run_turn(run_id)
    last = api.turns(run_id)[-1]
    state = api.read_json(api.turn_dir(run_id, last["turn_id"]) / "state.json")
    next_turn = predicted_next_agent_turn(state)
    next_agent = next_turn.rsplit("_", 1)[1]
    api.close(run_id)

    # Simulate a crash while the next turn was waiting for its model and being written.
    rdir = api.run_dir(run_id)
    partial = rdir / "turns" / f".partial_{next_turn}"
    (partial / "entities").mkdir(parents=True)
    (partial / "state.json").write_text("{ half written")
    call_id = f"mc_{next_turn}_01"
    storage.write_pending_model_call(
        run_id,
        ModelCallRecord(
            call_id=call_id,
            turn_id=next_turn,
            round=state["scheduler"]["round"],
            turn=state["scheduler"]["next_index"] + 1,
            agent_id=next_agent,
            purpose="decision",
            model_key="fake-heuristic",
            provider="fake",
            model_id="fake-heuristic",
            status="pending",
            started_at=utc_now_iso(),
            request=ModelRequest(
                request_id=call_id,
                model_key="fake-heuristic",
                messages=[ModelMessage(role="user", content="crash simulation")],
            ),
        ),
    )

    with fresh_api(registry, worlds_dir) as restarted:
        status = restarted.open(run_id)
        assert status["state"] == "paused"
        assert status["current_turn_id"] == last["turn_id"], "a partial dir replaced the committed checkpoint"
        assert not partial.exists(), "recover_run must delete .partial_* dirs"

        restarted.run_turn(run_id)
        entries = restarted.turns(run_id)
        assert entries[-1]["turn_id"] == next_turn
        view = restarted.turn(run_id, next_turn)
        call_ids = view["turn"]["model_call_ids"]
        assert call_id in call_ids, f"interrupted call not carried: {call_ids}"
        assert f"mc_{next_turn}_02" in call_ids, f"re-run call must be _02: {call_ids}"
        interrupted = restarted.model_call(run_id, next_turn, call_id)
        assert interrupted["status"] == "failed"
        assert interrupted["charged_compute"] == 0
        assert "interrupted" in (interrupted["error"] or "")
        failed_events = [
            e for e in view["events"] if e["kind"] == "model_call_failed" and e["details"].get("call_id") == call_id
        ]
        assert len(failed_events) == 1
        assert failed_events[0]["details"]["infra"] is True
        assert failed_events[0]["details"].get("interrupted") is True
        assert failed_events[0]["costs"]["compute"] == 0
        manifest = restarted.read_json(rdir / "manifest.json")
        assert manifest["real_usage"]["interrupted_calls"] == 1
        assert list((rdir / "working" / "pending_model_calls").glob("*.json")) == []
        assert_chain(entries, restarted, run_id)
        restarted.close(run_id)


def test_same_seed_runs_produce_identical_event_summaries(api):
    """Determinism (INTERFACES section 12): eight fake-heuristic agents, seed 1, two fresh
    runs -> the same committed turns and event summaries (timestamps ignored)."""
    digests = []
    finals = []
    for _ in range(2):
        summary = api.create_run(base_request(api, "e2e determinism"))
        run_id = summary["run_id"]
        api.step_rounds(run_id, 3)
        digests.append(event_digest(api, run_id, (run_id, summary["world_id"])))
        live = api.live(run_id)
        finals.append(
            {
                agent_id: (agent["position"], agent["stats"], agent["alive"], sorted(agent["skills"]))
                for agent_id, agent in live["entities"]["agents"].items()
            }
        )
        finals[-1]["fruits"] = sorted(live["entities"]["fruits"])
        api.close(run_id)
    assert len(digests[0]) > 30
    first_difference = next((i for i, (a, b) in enumerate(zip(*digests)) if a != b), None)
    assert first_difference is None, f"runs diverge at event {first_difference}: {digests[0][first_difference]} vs {digests[1][first_difference]}"
    assert len(digests[0]) == len(digests[1])
    assert finals[0] == finals[1]


@pytest.mark.parametrize("agent_count", [6, 12])
def test_defaults_support_six_to_twelve_cards(api, agent_count):
    """Spec 'Purpose and scope' (6-11 initially); config allows 6-12. GET /defaults prefills the cards."""
    request = base_request(api, f"e2e {agent_count} agents", agent_count=agent_count)
    assert len(request["agents"]) == agent_count
    summary = api.create_run(request)
    assert summary["agent_count"] == agent_count
    api.run_turn(summary["run_id"])
    assert len(api.turns(summary["run_id"])) == 2


def test_pause_during_a_model_call_finishes_and_saves_that_turn(api):
    """Spec 'Pause': if a turn is active, show 'Pause requested', finish and save that turn,
    then show 'Paused'.  While waiting for the model the status names the pending call and
    GET /pending_model_call serves the in-flight request (U13 pending vs completed)."""
    request = base_request(api, "e2e pause in flight")
    for entry in request["agents"]:
        entry["fake_options"] = {"sleep_ms": 400}
    run_id = api.create_run(request)["run_id"]
    assert api.client.get(f"/api/runs/{run_id}/pending_model_call").status_code == 404

    api.command(run_id, "play")
    waiting = api.wait_for(run_id, lambda s: s["state"] == "waiting_model", timeout=30, what="waiting_model")
    pending = waiting["pending_model_call"]
    assert pending and pending["call_id"].startswith(f"mc_{waiting['active_turn_id']}_")
    assert waiting["acting_agent_id"] == pending["agent_id"]
    view = api.get(f"/runs/{run_id}/pending_model_call")
    assert view["record"]["status"] == "pending" and view["record"]["call_id"] == pending["call_id"]
    assert view["packet"] is None or view["packet"]["agent_id"] == pending["agent_id"]
    live_events = api.events(run_id, since=0)["events"]
    assert any(e["kind"] == "model_call_pending" and e["pending"] for e in live_events)

    paused = api.command(run_id, "pause")
    assert paused["state"] == "pause_requested"
    status = api.wait_idle(run_id)
    assert status["state"] == "paused"
    assert status["current_turn_id"] == waiting["active_turn_id"], "the active turn must finish and commit"
    committed = api.turn(run_id, waiting["active_turn_id"])
    assert pending["call_id"] in committed["turn"]["model_call_ids"]
    assert api.client.get(f"/api/runs/{run_id}/pending_model_call").status_code == 404
    assert api.turn(run_id, "live")["turn"]["turn_id"] == status["current_turn_id"]


def test_setup_validation_reports_every_problem_by_path(api):
    """Spec 'New session': validate setup and explain any invalid values; every problem is
    reported at once with a path like agents[2].position (INTERFACES section 9)."""
    request = base_request(api, "e2e invalid setup")
    request["agents"][1]["name"] = request["agents"][0]["name"]  # duplicate name
    request["agents"][2]["position"] = {"x": 999, "y": 0}  # outside the region
    request["agents"][3]["stats"]["health"] = 150  # above max_health
    request["agents"][4]["model_key"] = "no-such-model"
    request["agents"][5]["stats"]["compute"] = -1  # negative stat

    checked = api.post("/runs/validate", request)
    assert checked["ok"] is False
    paths = [p["path"] for p in checked["problems"]]
    for index in (2, 3, 4, 5):
        assert any(path.startswith(f"agents[{index}]") for path in paths), f"no problem for agents[{index}]: {paths}"
    assert any(path.startswith("agents[1]") or path.startswith("agents[0]") for path in paths), paths
    assert any("position" in path for path in paths if path.startswith("agents[2]"))
    assert all(p["message"] for p in checked["problems"])

    rejected = api.post_raw("/runs", request)
    assert rejected.status_code == 422, rejected.text
    assert rejected.json()["error"] == "invalid_setup"
    assert sorted(p["path"] for p in rejected.json()["problems"]) == sorted(paths)
    assert all(s["name"] != "e2e invalid setup" for s in api.get("/runs")), "an invalid setup created a run"

    too_few = base_request(api, "e2e five agents")
    too_few["agents"] = too_few["agents"][:5]
    response = api.post_raw("/runs", too_few)
    assert response.status_code == 422, response.text
    assert response.json()["error"] in ("validation_error", "invalid_setup")
    assert any(p["path"].startswith("agents") for p in response.json()["problems"])

    fixed = base_request(api, "e2e valid setup")
    assert api.post("/runs/validate", fixed) == {"ok": True, "problems": []}


def test_max_rounds_finishes_and_update_run_settings_revives(api):
    """A-SCHED-3: reaching max_rounds finishes the run (run_finished event, pause is a
    no-op); a staged update_run_settings raising max_rounds is applied by the next run
    command, which re-checks the condition and continues."""
    run_id = api.create_run(base_request(api, "e2e finish", max_rounds=1))["run_id"]
    api.command(run_id, "step_round")
    status = api.wait_idle(run_id)
    if status["state"] == "paused":
        api.command(run_id, "run_turn")
        status = api.wait_idle(run_id)
    assert status["state"] == "finished", status
    assert status["finished_reason"]
    assert any(e["kind"] == "run_finished" for e in api.events(run_id, since=0)["events"])
    assert api.command(run_id, "pause")["state"] == "finished"
    rounds_before = {t["round"] for t in api.turns(run_id)}
    assert max(rounds_before) == 1

    api.stage(run_id, {"type": "update_run_settings", "max_rounds": 2})
    api.command(run_id, "run_turn")
    status = api.wait_idle(run_id)
    assert status["state"] == "paused", status
    assert api.turns(run_id)[-1]["round"] == 2
    assert api.live(run_id)["settings"]["max_rounds"] == 2


def test_live_feed_polling_returns_new_events_in_order(api):
    """U13 live logs: GET /events?since=N returns only newer events in seq order with the
    run status; the live feed and turn history refer to the same recorded events."""
    run_id = api.create_run(base_request(api, "e2e feed"))["run_id"]
    first = api.events(run_id, since=0)
    assert first["events"] and first["latest_seq"] == first["events"][-1]["seq"]
    assert first["status"]["run_id"] == run_id
    cursor = first["latest_seq"]
    api.run_turn(run_id)
    page = api.events(run_id, since=cursor)
    seqs = [e["seq"] for e in page["events"]]
    assert seqs and min(seqs) > cursor and seqs == sorted(seqs)
    turn_id = api.status(run_id)["current_turn_id"]
    committed = api.turn_events(run_id, turn_id)
    assert [(e["seq"], e["summary"]) for e in committed] == [
        (e["seq"], e["summary"]) for e in page["events"] if e["turn_id"] == turn_id
    ]
    limited = api.events(run_id, since=0, limit=2)
    assert len(limited["events"]) == 2
    assert api.events(run_id, since=page["latest_seq"])["events"] == []


def test_one_active_writer_per_run(api, registry, worlds_dir):
    """Spec "Sessions and run controls": one active writer per world run.  A second backend
    (a fresh RunManager on the same worlds dir) cannot open a run that is open elsewhere;
    once it is closed the second one can, and then the first is the one refused."""
    run_id = api.create_run(base_request(api, "e2e one writer"))["run_id"]
    with fresh_api(registry, worlds_dir) as other:
        refused = other.client.post(f"/api/runs/{run_id}/open")
        assert refused.status_code == 409 and refused.json()["error"] == "illegal_command"
        assert "another process" in refused.json()["detail"]
        api.close(run_id)
        deadline = time.monotonic() + 5  # the lock goes when the closed worker has exited
        while time.monotonic() < deadline:
            response = other.client.post(f"/api/runs/{run_id}/open")
            if response.status_code == 200:
                break
            time.sleep(0.02)
        assert response.status_code == 200, response.text
        other.run_turn(run_id)
        refused = api.client.post(f"/api/runs/{run_id}/open")
        assert refused.status_code == 409 and refused.json()["error"] == "illegal_command"
        other.close(run_id)
