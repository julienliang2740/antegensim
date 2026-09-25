"""
End-to-end: decision packets, the knowledge boundary and model-call failures (QA).

Spec "Agent context and memory selection" (Knowledge boundary: "filter to that
agent's permitted records"; "Do not silently supply a fresh query(self) every
turn") and completion criterion "Each model decision has an inspectable, bounded
context built only from that agent's permitted information"; A-KNOW-5/6;
A-COG-5 and INTERFACES section 13 "a fake fail timeout puts the run in error
with no charge and pause re-runs the same turn with call id _02".
"""

from __future__ import annotations

import pytest

from e2e_support import (
    base_request,
    card,
    charged_cognition,
    decision,
    events_of,
    knowledge_ids_in_text,
    packet_text,
    script_card,
)

ALL_AGENTS = [f"a{i:02d}" for i in range(1, 9)]


def notebook_marker(agent_id: str) -> str:
    return f"NOTEBOOK-MARKER-{agent_id.upper()}"


def test_packets_cite_only_the_agents_own_records(api):
    """For every model call: the packet's cited record ids (selected, digest, section and
    omitted ids, and ids rendered in the text) all belong to the acting agent and exist in
    its knowledge; other agents' notebooks never appear; the stored call request carries
    exactly the packet's messages."""
    request = base_request(api, "e2e knowledge boundary")
    for agent_id in ALL_AGENTS:
        card(request, agent_id)["notebook"] = f"Plan: survive. {notebook_marker(agent_id)}"
    run_id = api.create_run(request)["run_id"]
    api.stage(run_id, {"type": "voice", "recipients": {"mode": "agents", "agent_ids": ["a01"]}, "text": "Only a01 hears this."})
    api.step_rounds(run_id, 3)

    packets_checked = 0
    own_notebook_seen = set()
    for row in api.turns(run_id):
        if row["kind"] != "agent_turn":
            continue
        view = api.turn(run_id, row["turn_id"])
        turn = view["turn"]
        if not turn["packet_id"]:
            continue
        agent_id = row["acting_agent_id"]
        packet = api.packet(run_id, row["turn_id"], turn["packet_id"])
        assert packet["agent_id"] == agent_id and packet["turn_id"] == row["turn_id"]
        prefix = f"{agent_id}-k"

        cited = set(packet["selected_record_ids"]) | set(packet["digest_record_ids"])
        for section in packet["sections"]:
            cited |= set(section["record_ids"])
        cited |= {o["record_id"] for o in packet["omitted"]}
        foreign = sorted(r for r in cited if not r.startswith(prefix))
        assert not foreign, f"{row['turn_id']}: {agent_id}'s packet cites {foreign}"

        known = {r["id"] for r in api.knowledge(run_id, row["turn_id"], agent_id)["knowledge"]["records"]}
        assert set(packet["selected_record_ids"]) <= known, "packet cites records the agent does not have"

        text = packet_text(packet)
        # The stable rules and decision request quote section 6's example id (a03-k000012);
        # every other section is built from this agent's records only.
        agent_sections = "\n".join(
            s["text"] for s in packet["sections"] if s["name"] not in ("stable_rules", "decision_request")
        )
        cited_prefixes = knowledge_ids_in_text(agent_sections)
        assert cited_prefixes <= {agent_id}, f"{row['turn_id']}: foreign record ids {cited_prefixes} in the packet"
        for other in ALL_AGENTS:
            if other != agent_id:
                assert notebook_marker(other) not in text, f"{agent_id}'s packet shows {other}'s notebook"
        if notebook_marker(agent_id) in text:
            own_notebook_seen.add(agent_id)
        if agent_id != "a01":
            assert "Only a01 hears this." not in text
        assert packet["affordable"] is True
        assert 0 < packet["input_token_estimate"] <= packet["effective_settings"]["input_token_cap"]
        assert packet["situation"]["agent_id"] == agent_id

        assert turn["model_call_ids"], row["turn_id"]
        for call_id in turn["model_call_ids"]:
            record = api.model_call(run_id, row["turn_id"], call_id)
            assert record["agent_id"] == agent_id
            assert record["packet_id"] == turn["packet_id"]
            assert record["request"]["messages"] == packet["messages"], "the call must send exactly the packet"
            metadata = record["request"]["metadata"]
            assert metadata["agent_id"] == agent_id and metadata["turn_id"] == row["turn_id"]
            assert metadata["situation"]["agent_id"] == agent_id
        packets_checked += 1

    assert packets_checked >= 20
    assert own_notebook_seen == set(ALL_AGENTS), f"notebooks missing from own packets: {set(ALL_AGENTS) - own_notebook_seen}"


def test_self_state_is_derived_unless_the_agent_queried_itself(api):
    """A-KNOW-6: the packet's self state is derived from disclosed records (run-start card
    values, own costs, cognition charges) and labelled 'derived'; upkeep is not disclosed,
    so it differs from the authoritative balance; right after a query(self) it is 'query'."""
    request = base_request(api, "e2e believed self")
    here = card(request, "a01")["position"]
    script_card(
        request,
        "a01",
        [
            decision("observe", "Look here.", point=here),
            decision("query", "Check myself.", entity="self"),
            decision("observe", "Look again.", point=here),
            decision("observe", "And again.", point=here),
        ],
    )
    run_id = api.create_run(request)["run_id"]
    api.step_rounds(run_id, 4)
    rows = api.agent_turns(run_id, "a01")[:4]
    views = [api.turn(run_id, row["turn_id"]) for row in rows]
    previous = [api.turn(run_id, view["turn"]["previous_turn_id"]) for view in views]
    packets = [api.packet(run_id, row["turn_id"], view["turn"]["packet_id"]) for row, view in zip(rows, views)]
    believed = [p["situation"]["self_state"] for p in packets]
    actual = [prev["entities"]["agents"]["a01"]["stats"]["compute"] for prev in previous]
    upkeep = previous[0]["rules"]["upkeep"]["compute_per_round"]

    # Round 1: only the birth disclosure (card values).
    assert believed[0]["source"] == "derived"
    assert believed[0]["compute"] == pytest.approx(200.0)
    assert believed[0]["health"] == pytest.approx(100.0)

    # Round 2: card value - disclosed cognition - observe cost; upkeep is not disclosed.
    expected = 200.0 - charged_cognition(views[0]) - views[0]["turn"]["action_result"]["cost_compute"]
    assert believed[1]["source"] == "derived"
    assert believed[1]["compute"] == pytest.approx(expected)
    assert believed[1]["compute"] - actual[1] == pytest.approx(upkeep), "the packet must not reveal undisclosed upkeep"

    # Round 3: right after query(self) the packet shows the queried values.
    queried = views[1]["turn"]["action_result"]
    assert views[1]["turn"]["action"]["name"] == "query" and queried["ok"] is True
    assert believed[2]["source"] == "query"
    assert believed[2]["compute"] == pytest.approx(queried["data"]["compute"])
    assert believed[2]["compute"] != pytest.approx(actual[2]), "upkeep after the query is still undisclosed"

    # Round 4: later disclosed deltas make it derived again.
    assert believed[3]["source"] == "derived"
    assert believed[3]["known_round"] == 3

    # The inspector view of knowledge reports the same belief the packet would show.
    view_now = api.live_knowledge(run_id, "a01")
    assert view_now["believed_self"]["source"] in ("derived", "query")


def test_fake_timeout_puts_run_in_error_without_charge_and_pause_reruns_with_call_02(api):
    """A-COG-5: an infrastructure failure after retries puts the run in error, charges
    nothing and marks nothing read (A-KNOW-5); pause returns to paused and the same turn
    id is re-run with the next call id (_02), carrying the failed call record."""
    request = base_request(api, "e2e timeout")
    card(request, "a01")["fake_options"] = {"fail": {"status": "timeout", "rounds": [1], "failing_attempts": 3}}
    run_id = api.create_run(request)["run_id"]
    unread_before = api.live_knowledge(run_id, "a01")["unread_count"]

    for _ in range(8):
        api.command(run_id, "run_turn")
        status = api.wait_idle(run_id)
        if status["state"] == "error":
            break
    assert status["state"] == "error", "a01's scheduled timeout never happened"
    assert status["last_error"], status
    assert "timeout" in status["last_error"] or "provider" in status["last_error"]
    committed = status["current_turn_id"]
    assert not any(t.get("acting_agent_id") == "a01" for t in api.turns(run_id)), "the failed turn must not commit"

    events = api.events(run_id, since=0)["events"]
    failed = [e for e in events if e["kind"] == "model_call_failed" and e["actor"] == "a01"]
    assert len(failed) == 1, failed
    failed_turn = failed[0]["turn_id"]
    assert failed_turn.endswith("_a01") and failed_turn.startswith("r00001_t")
    assert failed[0]["details"]["call_id"] == f"mc_{failed_turn}_01"
    assert failed[0]["details"]["infra"] is True
    assert failed[0]["details"]["status"] == "timeout"
    assert failed[0]["details"]["attempts"] == 3
    assert failed[0]["costs"]["compute"] == 0
    assert any(e["kind"] == "error" and e["actor"] == "system" for e in events)

    live = api.live(run_id)["entities"]["agents"]["a01"]
    assert live["stats"]["compute"] == pytest.approx(200.0), "an infrastructure failure must not be charged"
    assert live["total_cognition_spent"] == 0 and live["model_call_count"] == 0
    assert api.live_knowledge(run_id, "a01")["unread_count"] == unread_before, "unread records were marked read"

    refused = api.post_raw(f"/runs/{run_id}/commands", {"command": "run_turn"})
    assert refused.status_code == 409 and refused.json()["error"] == "illegal_command"

    paused = api.command(run_id, "pause")
    assert paused["state"] == "paused"
    assert paused["current_turn_id"] == committed

    status = api.run_turn(run_id)
    assert status["current_turn_id"] == failed_turn
    assert status["last_error"] is None
    view = api.turn(run_id, failed_turn)
    call_ids = view["turn"]["model_call_ids"]
    assert f"mc_{failed_turn}_02" in call_ids, call_ids
    completed = api.model_call(run_id, failed_turn, f"mc_{failed_turn}_02")
    assert completed["status"] == "completed" and completed["result"]["status"] == "ok"
    carried = [e for e in events_of(view, "model_call_failed") if e["details"]["call_id"] == f"mc_{failed_turn}_01"]
    assert len(carried) == 1, "the failed attempt's call event must be carried into the re-run turn"
    if f"mc_{failed_turn}_01" in call_ids:
        first = api.model_call(run_id, failed_turn, f"mc_{failed_turn}_01")
        assert first["status"] == "failed" and first["charged_compute"] == 0
    agent = view["entities"]["agents"]["a01"]
    assert agent["model_call_count"] == 1
    assert agent["total_cognition_spent"] == pytest.approx(completed["charged_compute"])
    assert agent["total_cognition_spent"] == pytest.approx(charged_cognition(view))


def test_context_settings_from_run_creation_reach_the_packets(api):
    """U16 at run creation: run-default context settings and a per-card override are saved
    in the initial settings.json, shown as effective settings, and bound the packets;
    a card override invalid for its model is reported by path."""
    request = base_request(api, "e2e creation settings")
    request["context"]["recent_history_length"] = 4
    card(request, "a03")["context_overrides"] = {"input_token_cap": 4000}
    bad = base_request(api, "e2e bad override")
    card(bad, "a04")["context_overrides"] = {"generation_allowance": 10_000_000}
    checked = api.post("/runs/validate", bad)
    assert checked["ok"] is False
    assert any(p["path"].startswith("agents[3]") for p in checked["problems"]), checked["problems"]

    run_id = api.create_run(request)["run_id"]
    init_settings = api.read_json(api.turn_dir(run_id, "r00000_init") / "settings.json")
    assert init_settings["context"]["recent_history_length"] == 4
    assert init_settings["context_overrides"]["a03"]["input_token_cap"] == 4000
    effective = api.settings(run_id)["effective_context"]
    assert effective["a03"]["input_token_cap"] == 4000 and effective["a01"]["input_token_cap"] == 6000
    assert all(ctx["recent_history_length"] == 4 for ctx in effective.values())

    api.step_round(run_id)
    for row in api.turns(run_id):
        if row["kind"] != "agent_turn":
            continue
        turn = api.turn(run_id, row["turn_id"])["turn"]
        packet = api.packet(run_id, row["turn_id"], turn["packet_id"])
        cap = 4000 if row["acting_agent_id"] == "a03" else 6000
        assert packet["effective_settings"]["input_token_cap"] == cap
        assert packet["effective_settings"]["recent_history_length"] == 4
        assert packet["input_token_estimate"] <= cap
