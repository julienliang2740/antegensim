"""
Unit tests for empyrean.storage (engine/storage team).

Every test writes under the temporary ``worlds_dir`` (conftest).  Checkpoints are built by
hand from the schema models so storage is tested independently of the runner; the only
engine helpers used are ``world.rebuild_occupants`` (occupants) and, inside
``storage.load_working``, ``world.validate_world``.
"""

from __future__ import annotations

import json
import os
import random
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from empyrean import config, storage, world as world_engine
from empyrean.schemas import (
    ActionResult,
    Agent,
    AgentKnowledge,
    ContextOverrides,
    ContextSettings,
    DecisionPacketRecord,
    Event,
    EventCosts,
    FieldChange,
    Fruit,
    InterventionRecord,
    KnowledgeRecord,
    Manifest,
    MapState,
    ModelCallRecord,
    ModelMessage,
    ModelRequest,
    ModelResult,
    ModelUsage,
    PacketSection,
    Plant,
    Point,
    Provenance,
    RealUsageLedger,
    Region,
    RemovedEntity,
    Residue,
    RulesConfig,
    RunSettings,
    SchedulerState,
    Seed,
    SetStatIntervention,
    Situation,
    SkillDefinition,
    SkillExecutionState,
    SkillFrame,
    StagedEdits,
    TurnId,
    TurnRecord,
    VoiceIntervention,
    WorldState,
    decision_json_schema,
    utc_now_iso,
)
from empyrean.storage import StorageError


class SimulatedCrash(BaseException):
    """Stands in for the process dying at a precise point of the commit protocol."""


# ---------------------------------------------------------------------------
# Builders for a realistic 8-agent checkpoint
# ---------------------------------------------------------------------------

AGENT_COUNT = 8
MOUNTAINS = {(5, 5), (5, 6), (6, 5)}
WATER = {(-5, -5), (-5, -6)}


def _rng_state(seed: int) -> str:
    """Same serialisation as world.save_rng."""
    version, internal, gauss_next = random.Random(seed).getstate()
    return json.dumps([version, list(internal), gauss_next])


def _map() -> MapState:
    region = Region()
    cells = {}
    for x in range(region.min_x, region.max_x + 1):
        for y in range(region.min_y, region.max_y + 1):
            terrain = "mountain" if (x, y) in MOUNTAINS else "water" if (x, y) in WATER else "land"
            cells[f"{x},{y}"] = terrain
    return MapState(region=region, cells=cells)


def _skill() -> SkillDefinition:
    blocks = [
        {"type": "set", "var": "r", "line": 1, "expr": {"type": "action", "action": "observe", "args": [{"type": "var", "name": "here"}]}},
        {"type": "return", "line": 2, "expr": {"type": "var", "name": "r"}},
    ]
    compiled = [
        {"op": "set", "var": "r", "line": 1, "expr": {"type": "action", "action": "observe", "args": [{"type": "var", "name": "here"}]}},
        {"op": "return", "line": 2, "expr": {"type": "var", "name": "r"}},
    ]
    return SkillDefinition.model_validate(
        {
            "name": "look",
            "params": [],
            "source": "SET r = observe(here)\nRETURN r",
            "blocks": blocks,
            "compiled": compiled,
            "block_count": 3,
            "saved_round": 0,
        }
    )


def _agents() -> dict[str, Agent]:
    agents = {}
    for card in config.default_agent_cards(AGENT_COUNT):
        agents[card.id] = Agent(id=card.id, name=card.name, position=card.position, stats=card.stats.model_copy())
    first = agents["a01"]
    first.skills = {"look": _skill()}
    first.skill_execution = SkillExecutionState(
        root_skill="look", frames=[SkillFrame(skill="look", pc=1, vars={"r": {"ok": True}})], status="running", total_ops=3
    )
    first.last_action = {"name": "observe", "args": {"point": {"x": 0, "y": 0}, "page": 0}}
    first.last_result = ActionResult(ok=True, reason="ok", cost_compute=1.0, round=0, data={"terrain": "land"})
    first.upgrade_counts = {"vision_range": 1}
    return agents


def _plants() -> tuple[dict[str, Plant], dict[str, Fruit], dict[str, Seed]]:
    plants: dict[str, Plant] = {}
    for n in range(1, 13):
        pid = f"p{n:04d}"
        plants[pid] = Plant(
            id=pid, position=Point(x=n - 6, y=4), species="fruit_tree", stage_index=2, age_rounds=15, size=3.0,
            energy=100.0 + n / 3, essence=30.0, total_source_energy=180.0, total_source_essence=12.5,
        )
    fruits = {
        "f0001": Fruit(id="f0001", position=Point(x=-5, y=4), plant_id="p0001", available_compute=60.0),
        "f0002": Fruit(id="f0002", position=Point(x=-5, y=4), plant_id="p0001", available_compute=42.25),
        "f0003": Fruit(id="f0003", position=Point(x=-4, y=4), plant_id="p0002", available_compute=60.0),
    }
    plants["p0001"].fruit_ids = ["f0001", "f0002"]
    plants["p0002"].fruit_ids = ["f0003"]
    seeds = {"s0001": Seed(id="s0001", position=Point(x=-3, y=3), species="fruit_tree", plant_id="p0003", germinates_round=10)}
    plants["p0003"].seed_ids = ["s0001"]
    return plants, fruits, seeds


def _record(agent_id: str, seq: int, round_no: int) -> KnowledgeRecord:
    """Mixed realistic record kinds with the content shapes context.py produces."""
    kind_cycle = seq % 4
    rid = f"{agent_id}-k{seq:06d}"
    if kind_cycle == 1:
        result = ActionResult(
            ok=True, reason="ok", cost_compute=1.0, round=round_no,
            data={
                "point": {"x": 0, "y": 0}, "terrain": "land", "observed_round": round_no, "page": 0, "page_size": 40,
                "total_entities": 4, "has_more": False,
                "entities": [{"id": f"a0{i}", "kind": "agent", "position": {"x": 0, "y": 0}} for i in range(1, 5)],
            },
        )
        return KnowledgeRecord(
            id=rid, agent_id=agent_id, round=round_no, seq=seq, kind="observation",
            provenance=Provenance(source="own_action", action="observe"),
            text="You observed (0,0): land; a01, a02, a03, a04 are here.",
            content={"action": {"name": "observe", "args": {"point": {"x": 0, "y": 0}, "page": 0}}, "result": result.model_dump(mode="json"), "via_skill": False, "thought": "Look around first."},
            tags=["0,0", "observe", "a01", "a02"], importance=0.4, read=True,
        )
    if kind_cycle == 2:
        return KnowledgeRecord(
            id=rid, agent_id=agent_id, round=round_no, seq=seq, kind="message",
            provenance=Provenance(source="agent:a02", sender_visible=True),
            text='a02 says: "There is fruit at (-5,4); meet me there and we can share it fairly."',
            content={"text": "There is fruit at (-5,4); meet me there and we can share it fairly.", "sender": "a02", "sender_visible": True, "broadcast": False},
            tags=["a02", "-5,4", "fruit"], importance=0.7, read=seq % 8 != 2,
        )
    if kind_cycle == 3:
        return KnowledgeRecord(
            id=rid, agent_id=agent_id, round=round_no, seq=seq, kind="system",
            provenance=Provenance(source="world"),
            text="Your last decision cost 0.3452 compute.",
            content={"text": "Your last decision cost 0.3452 compute.", "cognition_charged": 0.3452},
            tags=["cognition"], importance=0.3, read=True,
        )
    return KnowledgeRecord(
        id=rid, agent_id=agent_id, round=round_no, seq=seq, kind="action_result",
        provenance=Provenance(source="own_action", action="move"),
        text="move up -> ok (cost 5): you are now at (0,1).",
        content={"action": {"name": "move", "args": {"direction": "up"}}, "result": {"ok": True, "reason": "ok", "cost_compute": 5.0, "cost_essence": 0.0, "round": round_no, "data": {}, "effects": {"from": {"x": 0, "y": 0}, "to": {"x": 0, "y": 1}}}, "via_skill": False, "thought": "Head north."},
        tags=["move", "0,1"], importance=0.2, read=True,
    )


def _knowledge(agent_ids: list[str], records_per_agent: int, round_no: int) -> dict[str, AgentKnowledge]:
    stores = {}
    for aid in agent_ids:
        records = [
            KnowledgeRecord(
                id=f"{aid}-k000001", agent_id=aid, round=0, seq=1, kind="system", provenance=Provenance(source="world"),
                text=f"You are {aid}. Your starting state is known to you.",
                content={"text": "run start", "self": {"compute": 200, "essence": 20, "health": 100}}, tags=["self"], importance=0.9, read=True,
            )
        ]
        records += [_record(aid, seq, min(round_no, seq // 3)) for seq in range(2, records_per_agent + 1)]
        stores[aid] = AgentKnowledge(agent_id=aid, records=records, notebook="Fruit at (-5,4). a02 seems friendly.", notebook_version=2, next_seq=records_per_agent + 1, priorities={f"{aid}-k000002": 0.8})
    return stores


def _settings() -> RunSettings:
    return RunSettings(
        default_model_key="fake-heuristic",
        context_overrides={"a02": ContextOverrides(recent_history_length=3)},
        model_overrides={"a03": "fake-scripted"},
        fake_scripts={"a03": [{"action": {"name": "wait", "args": {"rounds": 1}}}]},
    )


def _world(round_no: int) -> WorldState:
    plants, fruits, seeds = _plants()
    rules = RulesConfig()
    rules.cognition.mind_multipliers = {"fake-heuristic": 1.0, "fake-scripted": 1.0}
    state = WorldState(
        round=round_no,
        map=_map(),
        agents=_agents(),
        plants=plants,
        fruits=fruits,
        seeds=seeds,
        residues={"res0001": Residue(id="res0001", position=Point(x=2, y=2), source_id="p0012", source_kind="plant", available_essence=4.5)},
        removed={"f0004": RemovedEntity(id="f0004", kind="fruit", position=Point(x=-5, y=4), round=0, reason="consumed")},
        rules=rules,
        next_entity_seq={"agent": 9, "plant": 13, "fruit": 5, "seed": 2, "residue": 2},
        rng_state=_rng_state(1),
    )
    world_engine.rebuild_occupants(state)
    return state


def _event(seq: int, turn_id: str, round_no: int, turn_index: int | None, actor: str, kind: str, summary: str, **details: Any) -> Event:
    return Event(seq=seq, turn_id=turn_id, round=round_no, turn=turn_index, actor=actor, kind=kind, summary=summary, details=details, costs=EventCosts(compute=0.0))


def _stable_rules_text() -> str:
    lines = [f"Rule {i}: every action has a compute price; skills get the 0.8 discount; upkeep is 1 per round." for i in range(80)]
    return "\n".join(lines)


def _body_text(agent_id: str) -> str:
    return "\n".join(f"[{agent_id}-k{i:06d} r{i // 3} observation own] You observed (0,0): land; a01, a02 are here." for i in range(150))


def _model_call(turn_id: str, round_no: int, turn_index: int, agent_id: str, n: int = 1) -> ModelCallRecord:
    call_id = f"mc_{turn_id}_{n:02d}"
    situation = Situation(agent_id=agent_id, name="Aster", round=round_no, turn_id=turn_id, position=Point(x=0, y=0))
    request = ModelRequest(
        request_id=call_id,
        model_key="fake-heuristic",
        messages=[ModelMessage(role="system", content=_stable_rules_text()), ModelMessage(role="user", content=_body_text(agent_id))],
        response_schema=decision_json_schema(),
        max_output_tokens=1000,
        metadata={"agent_id": agent_id, "turn_id": turn_id, "round": round_no, "situation": situation.model_dump(mode="json"), "fake_script": None, "fake_script_index": 0, "fake_options": {}},
    )
    result = ModelResult(
        request_id=call_id, ok=True, status="ok",
        text='{"thought": "Look around first", "action": {"name": "observe", "args": {"point": {"x": 0, "y": 1}}}}',
        parsed={"thought": "Look around first", "action": {"name": "observe", "args": {"point": {"x": 0, "y": 1}}}},
        usage=ModelUsage(input_tokens=1420, output_tokens=61, source="provider"),
        provider="fake", model_id="fake-heuristic", latency_ms=1.2, provider_cost_usd=0.0015,
    )
    return ModelCallRecord(
        call_id=call_id, turn_id=turn_id, round=round_no, turn=turn_index, agent_id=agent_id, purpose="decision",
        model_key="fake-heuristic", provider="fake", model_id="fake-heuristic", status="completed",
        started_at=utc_now_iso(), finished_at=utc_now_iso(), request=request, result=result,
        packet_id=f"pk_{turn_id}", reservation_compute=2.2, charged_compute=0.345, mind_multiplier=1.0,
    )


def _packet(turn_id: str, round_no: int, agent_id: str) -> DecisionPacketRecord:
    rules_text, body = _stable_rules_text(), _body_text(agent_id)
    return DecisionPacketRecord(
        packet_id=f"pk_{turn_id}", turn_id=turn_id, round=round_no, agent_id=agent_id,
        effective_settings=ContextSettings(),
        sections=[
            PacketSection(name="stable_rules", text=rules_text, token_estimate=config.estimate_tokens(rules_text)),
            PacketSection(name="recent_history", text=body, token_estimate=config.estimate_tokens(body), record_ids=[f"{agent_id}-k000002"]),
        ],
        messages=[ModelMessage(role="system", content=rules_text), ModelMessage(role="user", content=body)],
        situation=Situation(agent_id=agent_id, name="Aster", round=round_no, turn_id=turn_id, position=Point(x=0, y=0)),
        selected_record_ids=[f"{agent_id}-k000002"], digest_record_ids=[f"{agent_id}-k000003"],
        input_token_estimate=5200, generation_allowance=1000, reservation_compute=2.04,
    )


def make_checkpoint(turn_id: str, previous: str | None, seq_start: int, records_per_agent: int = 6, calls: int = 1):
    """A complete checkpoint for ``turn_id``; agent turns get a model call and a packet."""
    from empyrean.schemas import Checkpoint

    round_no, turn_index, actor = TurnId.parse(turn_id)
    kind = "init" if turn_id == TurnId.INIT else ("round_end" if turn_index is None else "agent_turn")
    state = _world(round_no)
    order = sorted(state.agents)
    first_kind = {"init": "run_created", "round_end": "round_ended", "agent_turn": "turn_started"}[kind]
    events = [_event(seq_start, turn_id, round_no, turn_index, actor or "world", first_kind, f"{actor or 'world'} {first_kind}")]
    model_calls, packets, call_ids = [], [], []
    action, action_result = None, None
    if kind == "agent_turn":
        state.agents[actor].stats.compute -= 1.345
        model_calls = [_model_call(turn_id, round_no, turn_index, actor, n) for n in range(1, calls + 1)]
        call_ids = [c.call_id for c in model_calls]
        packets = [_packet(turn_id, round_no, actor)]
        action = {"name": "observe", "args": {"point": {"x": 0, "y": 1}, "page": 0}, "via_skill": False, "skill_name": None}
        action_result = ActionResult(ok=True, reason="ok", cost_compute=1.0, round=round_no, data={"point": {"x": 0, "y": 1}, "terrain": "land", "entities": []})
        events += [
            _event(seq_start + 1, turn_id, round_no, turn_index, actor, "model_call_completed", f"{actor} got a decision", call_id=call_ids[0], status="ok"),
            _event(seq_start + 2, turn_id, round_no, turn_index, actor, "action", f"{actor} observe (0,1) -> ok", action=action, result=action_result.model_dump(mode="json"), via_skill=False, skill_name=None),
        ]
    interventions = []
    if turn_index == 1:
        interventions = [
            InterventionRecord(
                intervention=SetStatIntervention(type="set_stat", id="iv_0001", entity_id="a02", field="stats.compute", value=150),
                effective_turn_id=turn_id, applied_round=round_no, ok=True,
                changes=[FieldChange(path="world.agents.a02.stats.compute", before=200.0, after=150.0)],
            )
        ]
    turn = TurnRecord(
        turn_id=turn_id, kind=kind, round=round_no, turn_index=turn_index, acting_agent_id=actor, previous_turn_id=previous,
        scheduler=SchedulerState(round=round_no, order=order, next_index=turn_index or 0, round_complete=kind != "agent_turn"),
        decision_source="model" if kind == "agent_turn" else "none",
        packet_id=packets[0].packet_id if packets else None, model_call_ids=call_ids,
        action=action, action_result=action_result, interventions=interventions,
        event_seq_start=events[0].seq, event_seq_end=events[-1].seq, code_revision="test",
    )
    return Checkpoint(
        turn=turn, world=state, knowledge=_knowledge(list(state.agents), records_per_agent, round_no),
        settings=_settings(), events=events, model_calls=model_calls, decision_packets=packets,
    )


def new_run(name: str = "Test run"):
    """Create a run with its init checkpoint; returns (manifest, init checkpoint)."""
    world_id, run_id = storage.new_world_id(), storage.new_run_id(name)
    now = utc_now_iso()
    manifest = Manifest(
        world_id=world_id, run_id=run_id, name=name, created_at=now, updated_at=now, seed=1,
        current_turn_id=TurnId.INIT, default_model_key="fake-heuristic", code_revision="test",
    )
    init = make_checkpoint(TurnId.INIT, None, 1)
    request = config.default_run_request("fake-heuristic")
    manifest = storage.create_run(request, manifest, init, config.assumption_entries())
    return manifest, init


def commit_turns(manifest: Manifest, turn_ids: list[str], seq: int):
    """Commit a sequence of turns after the manifest's current turn; returns (manifest, {id: checkpoint}, next seq)."""
    committed = {}
    for turn_id in turn_ids:
        checkpoint = make_checkpoint(turn_id, manifest.current_turn_id, seq)
        manifest = storage.write_checkpoint(manifest, checkpoint)
        committed[turn_id] = checkpoint
        seq = checkpoint.turn.event_seq_end + 1
    return manifest, committed, seq


def rdir_of(manifest: Manifest) -> Path:
    return storage.run_dir(manifest.world_id, manifest.run_id)


def dir_bytes(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


T1 = TurnId.agent_turn(1, 1, "a03")
T2 = TurnId.agent_turn(1, 2, "a01")
T3 = TurnId.agent_turn(1, 3, "a05")
R1_END = TurnId.round_end(1)
R2_T1 = TurnId.agent_turn(2, 1, "a01")


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------


def test_worlds_root_follows_config_at_call_time(worlds_dir):
    assert storage.worlds_root() == worlds_dir


def test_ids_have_the_fixed_patterns(worlds_dir):
    import re

    assert re.fullmatch(r"run_\d{8}_\d{6}_[0-9a-f]{4}", storage.new_run_id("x"))
    assert re.fullmatch(r"world_\d{8}_\d{6}_[0-9a-f]{4}", storage.new_world_id())
    assert storage.code_revision()


def test_json_is_pretty_atomic_and_rejects_non_finite(worlds_dir):
    path = worlds_dir / "x.json"
    storage.atomic_write_json(path, {"b": 1, "a": [1, 2]})
    text = path.read_text()
    assert text.startswith("{\n  ") and text.endswith("\n")
    assert storage.read_json(path) == {"b": 1, "a": [1, 2]}
    assert not [p for p in worlds_dir.iterdir() if ".tmp-" in p.name]
    with pytest.raises(StorageError, match="cannot be written"):
        storage.atomic_write_json(path, {"x": float("nan")})
    path.write_text('{"x": NaN}')
    with pytest.raises(StorageError, match="non-finite"):
        storage.read_json(path)
    path.write_text('{"x": 1,}')
    with pytest.raises(StorageError, match=r"x\.json: invalid JSON at line 1"):
        storage.read_json(path)
    with pytest.raises(StorageError, match="file not found"):
        storage.read_json(worlds_dir / "missing.json")


def test_unsafe_ids_are_rejected(worlds_dir):
    manifest, _ = new_run()
    for bad in ("../x", "a/b", "*", ".partial_r00000_init", ""):
        with pytest.raises(StorageError):
            storage.find_run_dir(bad)
        with pytest.raises(StorageError):
            storage.load_checkpoint(manifest.run_id, bad)
    with pytest.raises(StorageError):
        storage.read_model_call(manifest.run_id, TurnId.INIT, "../../manifest")
    with pytest.raises(StorageError):
        storage.read_staged_snapshot(manifest.run_id, "../manifest.json")


# ---------------------------------------------------------------------------
# Create, commit, load
# ---------------------------------------------------------------------------


def test_create_commit_load_round_trip(worlds_dir):
    manifest, init = new_run()
    rdir = rdir_of(manifest)
    assert (rdir / "manifest.json").is_file()
    assert storage.read_json(rdir / "run_request.json")["name"] == "New run"
    assert storage.read_assumptions(manifest.run_id) == config.assumption_entries()
    assert (rdir / "staged_snapshots").is_dir()
    assert (rdir / "working" / "pending_model_calls").is_dir()
    assert storage.read_staged_edits(manifest.run_id) == StagedEdits()
    assert "POST /api/runs/{run_id}/working/reload" in (rdir / "working" / "README.txt").read_text()
    assert manifest.turn_count == 1 and manifest.current_turn_id == TurnId.INIT
    assert manifest.next_event_seq == 2
    assert storage.load_checkpoint(manifest.run_id) == init

    t1 = make_checkpoint(T1, TurnId.INIT, 2)
    manifest = storage.write_checkpoint(manifest, t1)
    assert manifest.current_turn_id == T1
    assert (manifest.last_round, manifest.last_turn_index, manifest.turn_count) == (1, 1, 2)
    assert manifest.next_event_seq == t1.turn.event_seq_end + 1 == 5
    assert (manifest.agent_count, manifest.living_agent_count) == (8, 8)
    assert storage.read_manifest(manifest.run_id) == manifest

    loaded = storage.load_checkpoint(manifest.run_id)
    assert loaded == t1
    assert list(loaded.world.agents) == list(t1.world.agents)  # insertion order kept
    assert storage.load_checkpoint(manifest.run_id, TurnId.INIT) == init

    tdir = rdir / "turns" / T1
    for rel in ("state.json", "map.json", "rules.json", "settings.json", "world.json", "events.json",
                "entities/agents/a01.json", "entities/knowledge/a08.json", "entities/plants.json",
                "entities/fruits.json", "entities/seeds.json", "entities/residues.json", "entities/removed.json",
                "model_calls/index.json", f"model_calls/mc_{T1}_01.json", f"decision_packets/pk_{T1}.json"):
        assert (tdir / rel).is_file(), rel
    assert (rdir / "turns" / TurnId.INIT / "decision_packets").is_dir()
    assert storage.read_json(rdir / "turns" / TurnId.INIT / "model_calls" / "index.json") == []
    assert (rdir / "working" / "BASE_TURN").read_text().strip() == T1
    assert not list((rdir / "turns").glob(".partial_*"))


def test_turn_scoped_reads_and_light_load(worlds_dir):
    manifest, _ = new_run()
    t1 = make_checkpoint(T1, TurnId.INIT, 2)
    manifest = storage.write_checkpoint(manifest, t1)
    run_id = manifest.run_id

    assert storage.read_turn_events(run_id, T1) == t1.events
    assert storage.read_model_call(run_id, T1, f"mc_{T1}_01") == t1.model_calls[0]
    assert storage.read_decision_packet(run_id, T1, f"pk_{T1}") == t1.decision_packets[0]
    assert storage.read_knowledge(run_id, T1, "a03") == t1.knowledge["a03"]
    with pytest.raises(StorageError, match="not found"):
        storage.read_knowledge(run_id, T1, "a99")

    light, summaries, packet_ids = storage.load_checkpoint_light(run_id, T1)
    assert light.knowledge == {} and light.model_calls == [] and light.decision_packets == []
    assert light.world == t1.world and light.turn == t1.turn and light.events == t1.events
    assert packet_ids == [f"pk_{T1}"]
    (summary,) = summaries
    assert summary.call_id == f"mc_{T1}_01"
    assert (summary.input_tokens, summary.output_tokens, summary.status, summary.result_status) == (1420, 61, "completed", "ok")
    assert summary.charged_compute == 0.345 and summary.packet_id == f"pk_{T1}"
    with pytest.raises(StorageError, match="not found"):
        storage.load_checkpoint(run_id, R2_T1)


def test_commit_rejects_a_broken_chain(worlds_dir):
    manifest, _ = new_run()
    with pytest.raises(StorageError, match="follows"):
        storage.write_checkpoint(manifest, make_checkpoint(T2, T1, 2))
    manifest = storage.write_checkpoint(manifest, make_checkpoint(T1, TurnId.INIT, 2))
    with pytest.raises(StorageError, match="already committed"):
        storage.write_checkpoint(manifest, make_checkpoint(T1, T1, 5))
    assert storage.read_manifest(manifest.run_id).current_turn_id == T1


def test_create_run_refuses_existing_and_cleans_up_failures(worlds_dir, monkeypatch):
    manifest, init = new_run()
    with pytest.raises(StorageError, match="already exists"):
        storage.create_run(config.default_run_request(), manifest, init, [])
    fresh = manifest.model_copy(update={"run_id": storage.new_run_id("x")})

    def disk_full(m):
        raise StorageError("disk full")

    monkeypatch.setattr(storage, "write_manifest", disk_full)
    with pytest.raises(StorageError, match="disk full"):
        storage.create_run(config.default_run_request(), fresh, init, [])
    assert not storage.run_dir(fresh.world_id, fresh.run_id).exists()


# ---------------------------------------------------------------------------
# Crash simulation and recovery
# ---------------------------------------------------------------------------


def test_crash_while_partial_dir_exists_keeps_previous_checkpoint(worlds_dir, monkeypatch):
    manifest, _ = new_run()
    manifest, committed, seq = commit_turns(manifest, [T1], 2)
    rdir = rdir_of(manifest)

    def crash(partial, final):
        raise SimulatedCrash()

    with monkeypatch.context() as patch:
        patch.setattr(storage, "_promote_partial", crash)
        with pytest.raises(SimulatedCrash):
            storage.write_checkpoint(manifest, make_checkpoint(T2, T1, seq))
    assert (rdir / "turns" / f".partial_{T2}" / "state.json").is_file()

    assert storage.read_manifest(manifest.run_id).current_turn_id == T1
    assert storage.load_checkpoint(manifest.run_id) == committed[T1]
    assert [e.turn_id for e in storage.list_turns(manifest.run_id)] == [TurnId.INIT, T1]

    report = storage.recover_run(manifest.run_id)
    assert report.deleted_dirs == [f"turns/.partial_{T2}"]
    assert not report.index_rebuilt and not report.working_rebuilt and report.pending_calls == []
    assert not (rdir / "turns" / f".partial_{T2}").exists()
    # The same turn id is simply re-run.
    manifest = storage.write_checkpoint(manifest, make_checkpoint(T2, T1, seq))
    assert storage.load_checkpoint(manifest.run_id).turn.turn_id == T2


def test_crash_after_rename_before_manifest_drops_the_unreachable_turn(worlds_dir, monkeypatch):
    manifest, _ = new_run()
    manifest, committed, seq = commit_turns(manifest, [T1], 2)
    rdir = rdir_of(manifest)

    def crash(m):
        raise SimulatedCrash()

    with monkeypatch.context() as patch:
        patch.setattr(storage, "write_manifest", crash)
        with pytest.raises(SimulatedCrash):
            storage.write_checkpoint(manifest, make_checkpoint(T2, T1, seq))
    assert (rdir / "turns" / T2 / "state.json").is_file()
    assert storage.load_checkpoint(manifest.run_id) == committed[T1]
    assert [e.turn_id for e in storage.list_turns(manifest.run_id)] == [TurnId.INIT, T1]

    report = storage.recover_run(manifest.run_id)
    assert report.deleted_dirs == [f"turns/{T2}"]
    assert not (rdir / "turns" / T2).exists()


def test_crash_after_manifest_before_index_and_working_is_repaired(worlds_dir, monkeypatch):
    manifest, _ = new_run()
    manifest, _, seq = commit_turns(manifest, [T1], 2)
    rdir = rdir_of(manifest)
    index_path = rdir / "turns" / "index.jsonl"

    def crash(path, entry):
        raise SimulatedCrash()

    t2 = make_checkpoint(T2, T1, seq)
    with monkeypatch.context() as patch:
        patch.setattr(storage, "_append_index", crash)
        with pytest.raises(SimulatedCrash):
            storage.write_checkpoint(manifest, t2)

    # The commit point was reached: the new turn is current.
    assert storage.read_manifest(manifest.run_id).current_turn_id == T2
    assert storage.load_checkpoint(manifest.run_id) == t2
    assert storage.read_base_turn(manifest.run_id) == T1  # working/ still the old copy
    stale_index = index_path.read_text()
    assert T2 not in stale_index
    # Read paths derive the missing entry without writing.
    assert [e.turn_id for e in storage.list_turns(manifest.run_id)] == [TurnId.INIT, T1, T2]
    assert index_path.read_text() == stale_index
    state, errors = storage.load_working(manifest.run_id)
    assert state is None and any("BASE_TURN" in e and "reopen the run" in e for e in errors)

    report = storage.recover_run(manifest.run_id)
    assert report.index_rebuilt and report.working_rebuilt and report.deleted_dirs == []
    assert any("stale" in w for w in report.warnings)
    lines = [json.loads(line)["turn_id"] for line in index_path.read_text().splitlines()]
    assert lines == [TurnId.INIT, T1, T2]
    assert storage.read_base_turn(manifest.run_id) == T2
    state, errors = storage.load_working(manifest.run_id)
    assert errors == [] and storage.diff_working(t2, state) == []
    # A second recovery finds nothing to do.
    again = storage.recover_run(manifest.run_id)
    assert not again.changed_anything()


def test_post_commit_io_failures_do_not_undo_the_commit(worlds_dir, monkeypatch):
    manifest, _ = new_run()

    def failing_refresh(wdir, checkpoint):
        (wdir / "BASE_TURN").unlink(missing_ok=True)
        raise OSError(28, "No space left on device")

    with monkeypatch.context() as patch:
        patch.setattr(storage, "_refresh_working_dir", failing_refresh)
        manifest = storage.write_checkpoint(manifest, make_checkpoint(T1, TurnId.INIT, 2))
    assert storage.read_manifest(manifest.run_id).current_turn_id == T1
    assert storage.read_base_turn(manifest.run_id) is None
    assert storage.recover_run(manifest.run_id).working_rebuilt
    assert storage.read_base_turn(manifest.run_id) == T1


def test_damaged_history_is_reported_and_never_deleted(worlds_dir):
    manifest, _ = new_run()
    manifest, _, _ = commit_turns(manifest, [T1, T2], 2)
    rdir = rdir_of(manifest)
    (rdir / "turns" / T1 / "state.json").write_text("{ broken")
    report = storage.recover_run(manifest.run_id)
    assert any("unreadable" in w for w in report.warnings)
    assert (rdir / "turns" / TurnId.INIT).is_dir() and (rdir / "turns" / T1).is_dir()
    assert not report.index_rebuilt  # the index keeps listing the damaged history
    assert [t.turn_id for t in storage.list_turns(manifest.run_id)] == [TurnId.INIT, T1, T2]


def test_recovery_moves_a_corrupt_staged_edits_file_aside(worlds_dir):
    manifest, _ = new_run()
    wdir = rdir_of(manifest) / "working"
    (wdir / "staged_edits.json").write_text("{ nope")
    report = storage.recover_run(manifest.run_id)
    assert any("staged_edits" in w for w in report.warnings)
    assert storage.read_staged_edits(manifest.run_id) == StagedEdits()
    assert list(wdir.glob("staged_edits.corrupt-*.json"))


# ---------------------------------------------------------------------------
# Listing runs and turns, events
# ---------------------------------------------------------------------------


def test_list_runs_orders_newest_first_and_skips_dirs_without_manifest(worlds_dir):
    older, _ = new_run("Older")
    older = older.model_copy(update={"updated_at": "2020-01-01T00:00:00+00:00"})
    storage.write_manifest(older)
    newer, _ = new_run("Newer")
    newer, _, _ = commit_turns(newer, [T1, T2], 2)
    finished = newer.model_copy(update={"finished": True, "finished_reason": "all agents dead"})
    (worlds_dir / "world_x" / "runs" / "run_orphan" / "turns").mkdir(parents=True)

    runs = storage.list_runs()
    assert [r.name for r in runs] == ["Newer", "Older"]
    top = runs[0]
    assert (top.run_id, top.world_id, top.current_turn_id) == (newer.run_id, newer.world_id, T2)
    assert (top.last_round, top.last_turn_index, top.saved_at) == (1, 2, newer.updated_at)
    assert (top.agent_count, top.living_agent_count, top.status, top.parent) == (8, 8, "paused", None)
    assert top.default_model_key == "fake-heuristic"
    storage.write_manifest(finished)
    assert storage.list_runs()[0].status == "finished"
    with pytest.raises(StorageError, match="not found"):
        storage.read_manifest("run_orphan")


def test_list_turns_order_fields_and_round_filter(worlds_dir):
    manifest, _ = new_run()
    manifest, _, _ = commit_turns(manifest, [T1, T2, T3, R1_END, R2_T1], 2)
    turns = storage.list_turns(manifest.run_id)
    assert [t.turn_id for t in turns] == [TurnId.INIT, T1, T2, T3, R1_END, R2_T1]
    first = turns[1]
    assert (first.kind, first.round, first.turn_index, first.acting_agent_id) == ("agent_turn", 1, 1, "a03")
    assert (first.action_name, first.ok, first.decision_source, first.event_count, first.intervention_count) == ("observe", True, "model", 3, 1)
    assert (turns[4].kind, turns[4].turn_index, turns[4].action_name) == ("round_end", None, None)
    assert [t.turn_id for t in storage.list_turns(manifest.run_id, from_round=1, to_round=1)] == [T1, T2, T3, R1_END]
    assert [t.turn_id for t in storage.list_turns(manifest.run_id, from_round=2)] == [R2_T1]
    assert [t.turn_id for t in storage.list_turns(manifest.run_id, to_round=0)] == [TurnId.INIT]


def test_list_turns_tolerates_a_line_being_appended(worlds_dir):
    manifest, _ = new_run()
    manifest, _, _ = commit_turns(manifest, [T1], 2)
    index_path = rdir_of(manifest) / "turns" / "index.jsonl"
    with open(index_path, "a") as handle:
        handle.write('{"turn_id": "r000')  # half-written line, no newline yet
    assert [t.turn_id for t in storage.list_turns(manifest.run_id)] == [TurnId.INIT, T1]


def test_read_events_pages_forward_across_turns(worlds_dir):
    manifest, _ = new_run()
    manifest, _, _ = commit_turns(manifest, [T1, T2, T3], 2)
    all_seqs = [e.seq for e in storage.read_events(manifest.run_id, 0, 500)]
    assert all_seqs == list(range(1, 11))
    assert [e.seq for e in storage.read_events(manifest.run_id, 0, 3)] == [1, 2, 3]
    assert [e.seq for e in storage.read_events(manifest.run_id, 5, 3)] == [6, 7, 8]
    assert storage.read_events(manifest.run_id, 10, 50) == []
    assert manifest.next_event_seq == 11


# ---------------------------------------------------------------------------
# Working copy (literal god mode)
# ---------------------------------------------------------------------------


def _edit_json(path: Path, change) -> None:
    data = json.loads(path.read_text())
    change(data)
    path.write_text(json.dumps(data, indent=2))


def test_working_edit_validates_and_diffs_with_before_after(worlds_dir):
    manifest, _ = new_run()
    t1 = make_checkpoint(T1, TurnId.INIT, 2)
    manifest = storage.write_checkpoint(manifest, t1)
    wdir = rdir_of(manifest) / "working"

    _edit_json(wdir / "entities/agents/a01.json", lambda d: d["stats"].__setitem__("compute", 150.5))
    state, errors = storage.load_working(manifest.run_id)
    assert errors == []
    assert storage.diff_working(t1, state) == [FieldChange(path="world.agents.a01.stats.compute", before=200.0, after=150.5)]

    def edit_record(d):
        d["records"][1]["text"] = "Edited by the operator."

    _edit_json(wdir / "entities/knowledge/a02.json", edit_record)
    _edit_json(wdir / "settings.json", lambda d: d["context"].__setitem__("input_token_cap", 5000))

    def drop_fruit(d):
        d.pop("f0003")

    _edit_json(wdir / "entities/fruits.json", drop_fruit)
    _edit_json(wdir / "entities/plants.json", lambda d: d["p0002"].__setitem__("fruit_ids", []))
    _edit_json(wdir / "map.json", lambda d: d["occupants"].clear())  # occupants are recomputed, never diffed

    state, errors = storage.load_working(manifest.run_id)
    assert errors == []
    changes = {c.path: c for c in storage.diff_working(t1, state)}
    assert changes["knowledge.a02.records[a02-k000002].text"].after == "Edited by the operator."
    assert changes["settings.context.input_token_cap"] == FieldChange(path="settings.context.input_token_cap", before=6000, after=5000)
    assert changes["world.fruits.f0003"].after is None and changes["world.fruits.f0003"].before["id"] == "f0003"
    assert changes["world.plants.p0002.fruit_ids"] == FieldChange(path="world.plants.p0002.fruit_ids", before=["f0003"], after=[])
    assert not any("occupants" in path for path in changes)
    assert state.world.map.occupants["-4,4"] == ["p0002"]  # recomputed without the removed fruit
    assert "a01" in state.world.map.occupants["0,0"]
    assert len(changes) == 5


def test_invalid_working_files_report_clear_errors_and_change_nothing(worlds_dir):
    manifest, _ = new_run()
    t1 = make_checkpoint(T1, TurnId.INIT, 2)
    manifest = storage.write_checkpoint(manifest, t1)
    run_id = manifest.run_id
    wdir = rdir_of(manifest) / "working"
    staged = StagedEdits(interventions=[VoiceIntervention(type="voice", id="iv_0001", recipients={"mode": "broadcast_all"}, text="Hello")])
    storage.write_staged_edits(run_id, staged)
    manifest_before = (rdir_of(manifest) / "manifest.json").read_bytes()

    broken = wdir / "entities/agents/a03.json"
    broken.write_text('{"id": "a03", "name": "Cyrene",, }')
    state, errors = storage.load_working(run_id)
    assert state is None
    assert any(e.startswith("working/entities/agents/a03.json: invalid JSON at line 1 column") for e in errors), errors
    # Nothing changed: the committed state, staged edits and the operator's file stay as they are.
    assert storage.load_checkpoint(run_id) == t1
    assert storage.read_staged_edits(run_id) == staged
    assert (rdir_of(manifest) / "manifest.json").read_bytes() == manifest_before
    assert broken.read_text() == '{"id": "a03", "name": "Cyrene",, }'
    assert storage.read_base_turn(run_id) == T1

    storage.refresh_working(run_id, t1)
    _edit_json(wdir / "entities/agents/a03.json", lambda d: d["stats"].__setitem__("compute", "lots"))
    _edit_json(wdir / "entities/agents/a04.json", lambda d: d.__setitem__("position", {"x": 40, "y": 0}))
    _edit_json(wdir / "entities/seeds.json", lambda d: d["s0001"].__setitem__("plant_id", "p9999"))
    (wdir / "entities/knowledge/zz9.json").write_text(json.dumps(AgentKnowledge(agent_id="zz9").model_dump(mode="json")))
    state, errors = storage.load_working(run_id)
    assert state is None
    assert any(e.startswith("working/entities/agents/a03.json: stats.compute:") for e in errors), errors

    _edit_json(wdir / "entities/agents/a03.json", lambda d: d["stats"].__setitem__("compute", 10))
    state, errors = storage.load_working(run_id)
    assert state is None
    joined = "\n".join(errors)
    assert "working/entities/knowledge/zz9.json: no agent zz9" in joined
    assert "working/entities/seeds.json: seed s0001 refers to missing plant p9999" in joined
    assert "working/entities/agents/a04.json: a04 position (40,0) is outside the region" in joined
    # The engine's own consistency checks run too and name the working file they point at
    # (INTERFACES section 9: "file path + problem"), not a bare "world:" prefix.
    assert "working/entities/agents/a04.json: position (40,0) is outside the region" in joined, errors
    assert not any(e.startswith("world: agents.") for e in errors), errors
    assert storage.load_checkpoint(run_id) == t1


def test_staged_edits_and_snapshots_round_trip(worlds_dir):
    manifest, init = new_run()
    run_id = manifest.run_id
    state, errors = storage.load_working(run_id)
    assert errors == []
    ref = storage.write_staged_snapshot(run_id, "iv_0003", state)
    assert ref == "staged_snapshots/iv_0003.json"
    assert storage.read_staged_snapshot(run_id, ref) == state
    storage.delete_staged_snapshot(run_id, ref)
    with pytest.raises(StorageError, match="file not found"):
        storage.read_staged_snapshot(run_id, ref)

    staged = StagedEdits(interventions=[SetStatIntervention(type="set_stat", id="iv_0001", entity_id="a01", field="stats.compute", value=10)])
    storage.write_staged_edits(run_id, staged)
    assert storage.read_staged_edits(run_id) == staged
    # Commits refresh working/ but never touch staged_edits.json.
    storage.write_checkpoint(manifest, make_checkpoint(T1, TurnId.INIT, 2))
    assert storage.read_staged_edits(run_id) == staged


# ---------------------------------------------------------------------------
# Pending model calls and the real usage ledger
# ---------------------------------------------------------------------------


def test_pending_call_lifecycle_write_rewrite_clear_on_commit(worlds_dir):
    manifest, _ = new_run()
    run_id = manifest.run_id
    t1 = make_checkpoint(T1, TurnId.INIT, 2)
    call = t1.model_calls[0]
    pending = call.model_copy(update={"status": "pending", "result": None, "finished_at": None, "charged_compute": 0.0})

    storage.write_pending_model_call(run_id, pending)
    (listed,) = storage.list_pending_model_calls(run_id)
    assert listed.status == "pending" and listed.result is None
    storage.write_pending_model_call(run_id, call)  # rewritten with the result right after the call
    (listed,) = storage.list_pending_model_calls(run_id)
    assert listed.result.usage.billed_input_tokens == 1420

    storage.write_checkpoint(manifest, t1)
    assert storage.list_pending_model_calls(run_id) == []

    storage.write_pending_model_call(run_id, pending.model_copy(update={"call_id": "mc_x_01"}))
    storage.clear_pending_model_calls(run_id, ["mc_x_01", "mc_missing_01"])
    assert storage.list_pending_model_calls(run_id) == []


def test_interrupted_call_is_recovered_carried_and_cleared(worlds_dir):
    manifest, _ = new_run()
    run_id = manifest.run_id
    manifest, _, seq = commit_turns(manifest, [T1], 2)
    t2_first = make_checkpoint(T2, T1, seq).model_calls[0]
    storage.write_pending_model_call(run_id, t2_first)  # the process dies before T2 commits

    report = storage.recover_run(run_id)
    (carried,) = report.pending_calls
    assert carried.call_id == f"mc_{T2}_01"
    assert (carried.status, carried.error, carried.charged_compute) == ("failed", "interrupted (outcome uncertain)", 0.0)
    assert carried.result.usage.billed_input_tokens == 1420  # known usage survives
    assert storage.list_pending_model_calls(run_id)  # file kept until the carrying commit

    ledger = storage.add_call_usage(manifest.real_usage, carried, interrupted=True)
    assert ledger == RealUsageLedger(calls=1, interrupted_calls=1, input_tokens=1420, output_tokens=61, provider_cost_usd=0.0015)

    rerun = make_checkpoint(T2, T1, seq, calls=2)  # same turn id; the new call is _02
    rerun.model_calls[0] = carried
    manifest = storage.write_checkpoint(manifest.model_copy(update={"real_usage": ledger}), rerun)
    assert storage.list_pending_model_calls(run_id) == []
    assert storage.read_manifest(run_id).real_usage == ledger
    assert storage.read_model_call(run_id, T2, f"mc_{T2}_01").error == "interrupted (outcome uncertain)"


def test_pending_file_of_an_already_committed_call_is_not_counted_twice(worlds_dir, monkeypatch):
    manifest, _ = new_run()
    run_id = manifest.run_id
    t1 = make_checkpoint(T1, TurnId.INIT, 2)
    storage.write_pending_model_call(run_id, t1.model_calls[0])

    def crash(pending_dir, call_ids):
        raise SimulatedCrash()

    with monkeypatch.context() as patch:
        patch.setattr(storage, "_clear_pending_in", crash)
        with pytest.raises(SimulatedCrash):
            storage.write_checkpoint(manifest, t1)
    assert storage.read_manifest(run_id).current_turn_id == T1
    assert len(storage.list_pending_model_calls(run_id)) == 1

    report = storage.recover_run(run_id)
    assert report.pending_calls == [] and report.cleared_pending_calls == [f"mc_{T1}_01"]
    assert storage.list_pending_model_calls(run_id) == []


# ---------------------------------------------------------------------------
# Continuations
# ---------------------------------------------------------------------------


def test_continuation_copies_the_turn_and_keeps_the_parent_future(worlds_dir):
    parent, _ = new_run("Parent")
    parent, committed, _ = commit_turns(parent, [T1, T2, T3], 2)
    parent_dir = rdir_of(parent)
    parent_bytes = {p.relative_to(parent_dir): p.read_bytes() for p in parent_dir.rglob("*") if p.is_file()}
    storage.write_staged_edits(parent.run_id, StagedEdits(interventions=[VoiceIntervention(type="voice", id="iv_0002", recipients={"mode": "broadcast_all"}, text="x")]))
    parent_bytes[Path("working/staged_edits.json")] = (parent_dir / "working/staged_edits.json").read_bytes()

    child = storage.create_continuation(parent.run_id, T1, None)
    assert child.run_id != parent.run_id and child.world_id == parent.world_id
    assert child.name == f"Parent from {T1}"
    assert child.parent.model_dump() == {"world_id": parent.world_id, "run_id": parent.run_id, "turn_id": T1}
    assert (child.current_turn_id, child.last_round, child.last_turn_index, child.turn_count) == (T1, 1, 1, 1)
    assert child.next_event_seq == committed[T1].turn.event_seq_end + 1
    assert child.next_intervention_seq == 1 and child.real_usage == RealUsageLedger()
    assert storage.read_manifest(child.run_id) == child

    assert storage.load_checkpoint(child.run_id) == committed[T1]
    assert storage.load_checkpoint(child.run_id).turn.previous_turn_id == TurnId.INIT  # resolved via TurnView.parent
    assert [t.turn_id for t in storage.list_turns(child.run_id)] == [T1]
    assert storage.read_base_turn(child.run_id) == T1
    assert storage.read_staged_edits(child.run_id) == StagedEdits()
    assert storage.read_assumptions(child.run_id) == storage.read_assumptions(parent.run_id)
    assert storage.list_pending_model_calls(child.run_id) == []
    state, errors = storage.load_working(child.run_id)
    assert errors == [] and storage.diff_working(committed[T1], state) == []
    assert not storage.recover_run(child.run_id).changed_anything()

    # The continuation runs forward under the parent's later turn ids with different content.
    diverged = make_checkpoint(T2, T1, child.next_event_seq)
    diverged.world.agents["a01"].stats.compute = 1.0
    child = storage.write_checkpoint(child, diverged)
    assert storage.load_checkpoint(child.run_id).world.agents["a01"].stats.compute == 1.0

    after = {p.relative_to(parent_dir): p.read_bytes() for p in parent_dir.rglob("*") if p.is_file()}
    assert after == parent_bytes  # the parent and its future are untouched
    assert storage.load_checkpoint(parent.run_id) == committed[T3]
    assert storage.load_checkpoint(parent.run_id, T2) == committed[T2]
    names = {r.run_id: r for r in storage.list_runs()}
    assert names[child.run_id].parent == child.parent

    named = storage.create_continuation(parent.run_id, TurnId.INIT, "Branch B")
    assert named.name == "Branch B" and named.next_event_seq == 2 and named.last_turn_index is None
    with pytest.raises(StorageError, match="not a committed turn"):
        storage.create_continuation(parent.run_id, R2_T1, None)


# ---------------------------------------------------------------------------
# Measurement: bytes per turn for an 8-agent checkpoint
# ---------------------------------------------------------------------------


def test_bytes_per_turn_for_an_eight_agent_checkpoint(worlds_dir, capsys):
    manifest, _ = new_run()
    rdir = rdir_of(manifest)
    lines = []
    previous, seq = TurnId.INIT, 2
    for round_no, records in ((1, 6), (30, 100), (100, 300)):
        turn_id = TurnId.agent_turn(round_no, 1, "a01")
        checkpoint = make_checkpoint(turn_id, previous, seq, records_per_agent=records)
        started = time.perf_counter()
        manifest = storage.write_checkpoint(manifest, checkpoint)
        elapsed_ms = (time.perf_counter() - started) * 1000
        tdir = rdir / "turns" / turn_id
        total = dir_bytes(tdir)
        knowledge = dir_bytes(tdir / "entities" / "knowledge")
        calls = dir_bytes(tdir / "model_calls") + dir_bytes(tdir / "decision_packets")
        lines.append(
            f"8 agents, {records} knowledge records/agent: {total / 1024:.0f} KiB per turn "
            f"(knowledge {knowledge / 1024:.0f} KiB, model call + packet {calls / 1024:.0f} KiB, "
            f"other {(total - knowledge - calls) / 1024:.0f} KiB); commit {elapsed_ms:.0f} ms"
        )
        previous, seq = turn_id, checkpoint.turn.event_seq_end + 1
        load_started = time.perf_counter()
        assert storage.load_checkpoint(manifest.run_id) == checkpoint
        lines[-1] += f", full load {(time.perf_counter() - load_started) * 1000:.0f} ms"
        if records == 6:
            assert total < 400 * 1024
    with capsys.disabled():
        print("\n[storage bytes per turn]\n  " + "\n  ".join(lines))


# ---------------------------------------------------------------------------
# Compatibility with the real engine output
# ---------------------------------------------------------------------------


def test_generated_world_round_trips_and_validates_as_working_copy(worlds_dir, world):
    manifest, _ = new_run()
    checkpoint = make_checkpoint(T1, TurnId.INIT, 2)
    checkpoint.world = world
    checkpoint.knowledge = _knowledge(list(world.agents), 4, 1)
    manifest = storage.write_checkpoint(manifest, checkpoint)
    assert storage.load_checkpoint(manifest.run_id) == checkpoint
    state, errors = storage.load_working(manifest.run_id)
    assert errors == []
    assert state.world.map.occupants == world.map.occupants
    assert storage.diff_working(checkpoint, state) == []


def test_removed_agent_keeps_its_knowledge_and_stays_valid(worlds_dir):
    manifest, _ = new_run()
    checkpoint = make_checkpoint(T1, TurnId.INIT, 2)
    gone = checkpoint.world.agents.pop("a08")
    checkpoint.world.removed["a08"] = RemovedEntity(id="a08", kind="agent", position=gone.position, round=1, reason="operator")
    dead = checkpoint.world.agents["a07"]
    dead.alive, dead.stats.health, dead.stats.compute, dead.stats.essence = False, 0.0, 0.0, 0.0
    world_engine.rebuild_occupants(checkpoint.world)
    manifest = storage.write_checkpoint(manifest, checkpoint)
    assert manifest.agent_count == 7 and manifest.living_agent_count == 6
    assert storage.load_checkpoint(manifest.run_id) == checkpoint
    wdir = rdir_of(manifest) / "working"
    assert not (wdir / "entities/agents/a08.json").exists()  # entity dir replaced wholesale
    assert (wdir / "entities/knowledge/a08.json").exists()
    state, errors = storage.load_working(manifest.run_id)
    assert errors == [] and storage.diff_working(checkpoint, state) == []


# ---------------------------------------------------------------------------
# Review regressions: committed history is immutable, one active writer, code revision
# ---------------------------------------------------------------------------


def test_commit_refuses_any_committed_turn_id(worlds_dir):
    """INTERFACES 4.5: write_checkpoint refuses an already committed turn id, not only the
    current one, so committed history can never be replaced."""
    manifest, _ = new_run()
    manifest, _, seq = commit_turns(manifest, [T1, T2], 2)
    forged = make_checkpoint(T1, T2, seq)  # an older committed id on top of the chain
    with pytest.raises(storage.StorageError, match="already committed"):
        storage.write_checkpoint(manifest, forged)
    assert storage.load_checkpoint(manifest.run_id, T1).turn.previous_turn_id == TurnId.INIT
    assert storage.read_manifest(manifest.run_id).current_turn_id == T2
    assert [e.turn_id for e in storage.list_turns(manifest.run_id)] == [TurnId.INIT, T1, T2]
    assert not (rdir_of(manifest) / "turns" / f".partial_{T1}").exists()
    with pytest.raises(storage.StorageError, match="already committed"):
        storage.write_checkpoint(manifest, make_checkpoint(TurnId.INIT, T2, seq))
    # a stale never-committed directory of the next id is still replaced
    stale = rdir_of(manifest) / "turns" / T3
    stale.mkdir()
    (stale / "state.json").write_text("{ half written")
    manifest, _, _ = commit_turns(manifest, [T3], seq)
    assert storage.load_checkpoint(manifest.run_id, T3).turn.previous_turn_id == T2


def test_commit_refuses_a_chain_head_moved_by_another_writer(worlds_dir):
    """Second line of defence for 'one active writer': the chain head on disk must be the
    caller's before anything is written."""
    manifest, _ = new_run()
    manifest, _, seq = commit_turns(manifest, [T1], 2)
    other = manifest.model_copy(deep=True)  # another process with its own manifest copy
    other, _, _ = commit_turns(other, [T2], seq)
    with pytest.raises(storage.StorageError, match="another writer"):
        storage.write_checkpoint(manifest, make_checkpoint(T3, T1, seq))
    assert storage.read_manifest(manifest.run_id).current_turn_id == T2
    assert not (rdir_of(manifest) / "turns" / T3).exists()


def test_writer_lock_is_exclusive_per_run_and_across_processes(worlds_dir):
    manifest, _ = new_run()
    run_id = manifest.run_id
    lock = storage.acquire_writer_lock(run_id)
    assert lock is not None and lock.held
    assert storage.acquire_writer_lock(run_id) is None
    probe = (
        "from empyrean import storage; "
        f"print('taken' if storage.acquire_writer_lock({run_id!r}) is None else 'free')"
    )
    env = {**os.environ, "EMPYREAN_WORLDS_DIR": str(worlds_dir)}
    backend = Path(__file__).resolve().parent.parent
    done = subprocess.run([sys.executable, "-c", probe], cwd=str(backend), env=env, capture_output=True, text=True, timeout=60)
    assert done.returncode == 0 and done.stdout.strip() == "taken", done.stderr
    lock.release()
    assert not lock.held
    done = subprocess.run([sys.executable, "-c", probe], cwd=str(backend), env=env, capture_output=True, text=True, timeout=60)
    assert done.stdout.strip() == "free", done.stderr
    again = storage.acquire_writer_lock(run_id)
    assert again is not None
    again.release()
    again.release()  # idempotent
    with pytest.raises(storage.StorageError):
        storage.acquire_writer_lock("run_missing")
    report = storage.recover_run(run_id)  # the lock file is not a temp file to clean
    assert (rdir_of(manifest) / storage.WRITER_LOCK_FILE).exists() and not report.warnings


def test_code_revision_identifies_a_dirty_tree(monkeypatch):
    outputs = {("rev-parse", "--short", "HEAD"): "abc1234\n", ("status", "--porcelain"): "?? backend/\n"}
    monkeypatch.setattr(storage, "_git", lambda *args: outputs.get(args))
    storage.code_revision.cache_clear()
    try:
        assert re.fullmatch(r"abc1234\+dirty\.[0-9a-f]{8}", storage.code_revision())
        storage.code_revision.cache_clear()
        outputs[("status", "--porcelain")] = ""
        assert storage.code_revision() == "abc1234"
        storage.code_revision.cache_clear()
        monkeypatch.setattr(storage, "_git", lambda *args: None)
        assert re.fullmatch(re.escape(config.CODE_REVISION) + r"\+src\.[0-9a-f]{8}", storage.code_revision())
    finally:
        storage.code_revision.cache_clear()


def test_world_validation_problems_are_mapped_to_working_files():
    """Fix pass: ``world.validate_world`` messages become "<working file>: <problem>"."""
    to_file = storage._working_file_for_problem
    assert to_file("agents.a02: health 500.0 exceeds max_health 100.0") == "working/entities/agents/a02.json: health 500.0 exceeds max_health 100.0"
    assert to_file("plants.p0003: position (40,0) is outside the region") == "working/entities/plants.json: p0003: position (40,0) is outside the region"
    assert to_file("fruits.f0001: id also appears in removed") == "working/entities/fruits.json: f0001: id also appears in removed"
    assert to_file("duplicate entity id 'x' in agents and plants") == "world: duplicate entity id 'x' in agents and plants"


def test_run_summary_names_the_absolute_run_folder(worlds_dir):
    manifest, _ = new_run()
    (summary,) = storage.list_runs()
    assert summary.run_dir == str((Path(worlds_dir) / manifest.world_id / "runs" / manifest.run_id).resolve())
    assert storage.run_dir_path("bad/../id", manifest.run_id) is None


def test_knowledge_files_are_written_only_when_they_changed(worlds_dir):
    """Fix pass (storage growth): a turn dir holds a knowledge file only for the agents
    whose store changed since the previous committed turn; world.json maps every agent to
    the turn holding its file; every loader resolves it; a continuation stands alone."""
    manifest, init = new_run()
    run_id = manifest.run_id
    rdir = rdir_of(manifest)
    manifest, committed, seq = commit_turns(manifest, [T1], 2)  # round 0 -> 1: every store changes
    t1_files = sorted(p.name for p in (rdir / "turns" / T1 / "entities/knowledge").glob("*.json"))
    assert t1_files == sorted(f"{aid}.json" for aid in init.knowledge)

    t2 = make_checkpoint(T2, T1, seq)
    # The fixture stamps fresh created_at values: start from T1's stores and change only a01's.
    t2.knowledge = {aid: store.model_copy(deep=True) for aid, store in committed[T1].knowledge.items()}
    t2.knowledge["a01"].notebook = "changed in T2"
    manifest = storage.write_checkpoint(manifest, t2)
    t2_dir = rdir / "turns" / T2
    assert sorted(p.name for p in (t2_dir / "entities/knowledge").glob("*.json")) == ["a01.json"]
    refs = storage.read_json(t2_dir / "world.json")["knowledge_files"]
    assert set(refs) == set(t2.knowledge)
    assert refs["a01"]["turn_id"] == T2 and refs["a03"]["turn_id"] == T1
    assert storage.load_checkpoint(run_id, T2) == t2
    assert storage.read_knowledge(run_id, T2, "a03") == t2.knowledge["a03"]
    assert storage.read_knowledge(run_id, T2, "a01").notebook == "changed in T2"
    assert storage.read_knowledge(run_id, T1, "a01") == committed[T1].knowledge["a01"]  # history unchanged
    with pytest.raises(StorageError, match="not found"):
        storage.read_knowledge(run_id, T2, "a99")
    # working/ always holds every file (the operator edits there).
    assert sorted(p.name for p in (rdir / "working/entities/knowledge").glob("*.json")) == t1_files
    assert "knowledge_files" not in storage.read_json(rdir / "working/world.json")

    t3 = make_checkpoint(T3, T2, t2.turn.event_seq_end + 1)  # nothing changed: no file at all
    t3.knowledge = {aid: store.model_copy(deep=True) for aid, store in t2.knowledge.items()}
    manifest = storage.write_checkpoint(manifest, t3)
    t3_dir = rdir / "turns" / T3
    assert (t3_dir / "entities/knowledge").is_dir() and list((t3_dir / "entities/knowledge").glob("*.json")) == []
    assert storage.load_checkpoint(run_id, T3).knowledge == t2.knowledge
    assert dir_bytes(t3_dir) < dir_bytes(rdir / "turns" / T1)

    # A stale working copy is rebuilt from the resolved knowledge on open.
    (rdir / "working" / "BASE_TURN").unlink()
    report = storage.recover_run(run_id)
    assert report.working_rebuilt
    assert sorted(p.name for p in (rdir / "working/entities/knowledge").glob("*.json")) == t1_files
    assert storage.load_working(run_id)[0].knowledge == t2.knowledge

    # A continuation from T3 gets every file materialized and its map points at itself.
    child = storage.create_continuation(run_id, T3, None)
    cdir = rdir_of(child) / "turns" / T3
    assert sorted(p.name for p in (cdir / "entities/knowledge").glob("*.json")) == t1_files
    child_refs = storage.read_json(cdir / "world.json")["knowledge_files"]
    assert all(ref["turn_id"] == T3 for ref in child_refs.values())
    assert storage.load_checkpoint(child.run_id).knowledge == t2.knowledge
    # ... and its next commit dedups against that copy.
    t4 = make_checkpoint(R1_END, T3, t3.turn.event_seq_end + 1)
    t4.knowledge = {aid: store.model_copy(deep=True) for aid, store in t2.knowledge.items()}
    storage.write_checkpoint(child, t4)
    assert list((rdir_of(child) / "turns" / R1_END / "entities/knowledge").glob("*.json")) == []
    assert storage.load_checkpoint(child.run_id, R1_END).knowledge == t2.knowledge


def test_runs_without_a_knowledge_map_still_load(worlds_dir):
    """A run written before the map existed has every file local and no map: it reads the
    same way, and the next commit writes every file again (nothing to compare against)."""
    manifest, init = new_run()
    rdir = rdir_of(manifest)
    manifest, committed, seq = commit_turns(manifest, [T1], 2)
    world_doc = storage.read_json(rdir / "turns" / T1 / "world.json")
    world_doc.pop("knowledge_files")
    storage.atomic_write_json(rdir / "turns" / T1 / "world.json", world_doc)
    assert storage.load_checkpoint(manifest.run_id, T1) == committed[T1]
    t2 = make_checkpoint(T2, T1, seq)
    storage.write_checkpoint(manifest, t2)
    assert len(list((rdir / "turns" / T2 / "entities/knowledge").glob("*.json"))) == len(t2.knowledge)


# ---------------------------------------------------------------------------
# Fix pass: a reload's diff applied onto a boundary state that other staged edits changed
# ---------------------------------------------------------------------------


def test_apply_working_changes_merges_the_reload_diff_onto_a_changed_state(worlds_dir):
    """A-GOD-1: ``apply_working_changes`` applies a ``diff_working`` result field by field
    onto the CURRENT state, so edits staged before the reload survive; a field changed by
    both keeps the diff's value and the returned change shows the value found at apply
    time; the inputs are never modified."""
    manifest, _ = new_run()
    t1 = make_checkpoint(T1, TurnId.INIT, 2)
    manifest = storage.write_checkpoint(manifest, t1)
    wdir = rdir_of(manifest) / "working"

    _edit_json(wdir / "entities/agents/a01.json", lambda d: d["stats"].__setitem__("compute", 150.5))
    _edit_json(wdir / "entities/knowledge/a02.json", lambda d: d["records"][1].__setitem__("text", "Edited by the operator."))
    hand_record = {
        "id": "a01-k000099", "agent_id": "a01", "round": 1, "seq": 99, "kind": "system", "provenance": {"source": "operator"},
        "text": "Hand-added record.", "content": {}, "tags": [], "importance": 0.5, "read": False,
    }

    def add_record(d):
        d["records"].append(hand_record)
        d["next_seq"] = 100

    _edit_json(wdir / "entities/knowledge/a01.json", add_record)
    _edit_json(wdir / "settings.json", lambda d: d["context"].__setitem__("input_token_cap", 5000))
    _edit_json(wdir / "entities/fruits.json", lambda d: d.pop("f0003"))
    _edit_json(wdir / "entities/plants.json", lambda d: d["p0002"].__setitem__("fruit_ids", []))
    working, errors = storage.load_working(manifest.run_id)
    assert errors == []
    changes = storage.diff_working(t1, working)
    assert {c.path for c in changes} >= {
        "world.agents.a01.stats.compute", "world.fruits.f0003", "world.plants.p0002.fruit_ids",
        "knowledge.a02.records[a02-k000002].text", "knowledge.a01.records[a01-k000099]", "knowledge.a01.next_seq",
        "settings.context.input_token_cap",
    }

    # The boundary state already differs from T1: earlier staged edits changed a01's compute,
    # placed a fruit, delivered a voice to a01 and changed a setting the file did not touch.
    current = t1.model_copy(deep=True)
    current.world.agents["a01"].stats.compute = 120.0
    current.world.fruits["f0099"] = Fruit(id="f0099", position=Point(x=1, y=1), available_compute=33.0, available_essence=0.0)
    current.world.next_entity_seq["fruit"] = 100
    world_engine.rebuild_occupants(current.world)
    voice = KnowledgeRecord(
        id="a01-k000007", agent_id="a01", round=1, seq=7, kind="operator_voice", provenance=Provenance(source="unknown"),
        text="A voice from nowhere.", content={"text": "A voice from nowhere."}, importance=0.8,
    )
    current.knowledge["a01"].records.append(voice)
    current.knowledge["a01"].next_seq = 8
    current.settings.context.recent_history_length = 3
    frozen = current.model_copy(deep=True)

    new_state, applied, problems = storage.apply_working_changes(current.world, current.knowledge, current.settings, changes)
    assert problems == [] and new_state is not None
    assert current == frozen, "the inputs must not be modified"
    # Every file change is there ...
    assert new_state.world.agents["a01"].stats.compute == 150.5  # both edited this field: the diff (staged later) wins
    assert "f0003" not in new_state.world.fruits and new_state.world.plants["p0002"].fruit_ids == []
    assert new_state.knowledge["a02"].records[1].text == "Edited by the operator."
    assert [r.id for r in new_state.knowledge["a01"].records][-2:] == ["a01-k000007", "a01-k000099"]
    assert new_state.knowledge["a01"].next_seq == 100
    assert new_state.settings.context.input_token_cap == 5000
    # ... and every earlier edit survived.
    assert "f0099" in new_state.world.fruits and "f0099" in new_state.world.map.occupants["1,1"]
    assert new_state.settings.context.recent_history_length == 3
    # The applied changes carry the value found at apply time (the record shows what really changed).
    by_path = {c.path: c for c in applied}
    assert by_path["world.agents.a01.stats.compute"] == FieldChange(path="world.agents.a01.stats.compute", before=120.0, after=150.5)
    assert by_path["knowledge.a01.next_seq"] == FieldChange(path="knowledge.a01.next_seq", before=8, after=100)
    assert by_path["world.fruits.f0003"].before["id"] == "f0003" and by_path["world.fruits.f0003"].after is None
    assert len(applied) == len(changes)


def test_apply_working_changes_reports_problems_and_applies_nothing_partially(worlds_dir):
    manifest, _ = new_run()
    t1 = make_checkpoint(T1, TurnId.INIT, 2)
    storage.write_checkpoint(manifest, t1)
    current = t1.model_copy(deep=True)
    # An earlier staged edit removed the fruit the file edit changes.
    gone = current.world.fruits.pop("f0003")
    current.world.plants["p0002"].fruit_ids = []
    current.world.removed["f0003"] = RemovedEntity(id="f0003", kind="fruit", position=gone.position, round=1, reason="operator")
    world_engine.rebuild_occupants(current.world)
    changes = [
        FieldChange(path="world.fruits.f0003.available_compute", before=gone.available_compute, after=1.0),
        FieldChange(path="world.agents.a01.stats.compute", before=200.0, after=150.5),
    ]
    new_state, applied, problems = storage.apply_working_changes(current.world, current.knowledge, current.settings, changes)
    assert new_state is None
    assert problems == ["world.fruits.f0003.available_compute: world.fruits.f0003 does not exist any more (removed or renamed by an earlier staged edit?)"]
    assert [c.path for c in applied] == ["world.agents.a01.stats.compute"]  # what would have applied, for the record
    assert current.world.agents["a01"].stats.compute == 200.0

    # Removing something that is already gone is satisfied, not a problem.
    new_state, applied, problems = storage.apply_working_changes(
        current.world, current.knowledge, current.settings, [FieldChange(path="world.fruits.f0003", before=gone.model_dump(mode="json"), after=None)]
    )
    assert problems == [] and new_state is not None and applied == [FieldChange(path="world.fruits.f0003", before=None, after=None)]

    # A result that fails the world checks names the working file and applies nothing.
    new_state, _, problems = storage.apply_working_changes(
        current.world, current.knowledge, current.settings, [FieldChange(path="world.agents.a02.stats.health", before=100.0, after=500.0)]
    )
    assert new_state is None and any(p.startswith("working/entities/agents/a02.json: health 500.0 exceeds max_health") for p in problems), problems

    # Unknown roots, list indexes out of range and unreadable segments are problems too.
    for path in ("rules.prices.move", "world", "knowledge.a01.records[7]", "world.agents.a01.stats.compute[0]"):
        new_state, _, problems = storage.apply_working_changes(current.world, current.knowledge, current.settings, [FieldChange(path=path, before=1, after=2)])
        assert new_state is None and len(problems) == 1 and problems[0].startswith(path + ": "), (path, problems)


def test_load_working_says_when_semantic_checks_did_not_run(worlds_dir):
    """Two-stage reload errors: while any file fails to parse, the list ends with a line saying
    the semantic checks still have to run; once every file parses, that line is absent."""
    manifest, _ = new_run()
    wdir = rdir_of(manifest) / "working"
    (wdir / "entities/agents/a03.json").write_text('{"id": "a03", "name": "Cyrene",, }')
    state, errors = storage.load_working(manifest.run_id)
    assert state is None
    assert errors[-1] == "working/: fix the JSON errors above first; semantic checks run once every file parses"
    assert any(e.startswith("working/entities/agents/a03.json: invalid JSON") for e in errors)

    storage.refresh_working(manifest.run_id, storage.load_checkpoint(manifest.run_id))
    _edit_json(wdir / "entities/agents/a04.json", lambda d: d.__setitem__("position", {"x": 40, "y": 0}))
    state, errors = storage.load_working(manifest.run_id)
    assert state is None and errors and not any("fix the JSON errors" in e for e in errors)
