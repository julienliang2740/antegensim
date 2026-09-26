"""
WP3 digest tests (rev 4): deterministic, read-only digests over committed storage.

Against the committed sample (docs/sample_run, copied into the temporary worlds dir with its
manifest pointed at the last included turn) and against fresh fake runs made with the
``manager`` fixture: turn / round-end / round digests, the empty-thought fallback, killer
attribution from damage events, trends, highlights salience, event search, the agent dossier
(operator truth vs the agent's belief, labelled), the run card, continuation parent following
and the max_chars trimming.  No model is ever called.
"""

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

import pytest

from empyrean import config, runner, storage
from empyrean.assistant import digest
from empyrean.schemas import ContinuationRequest, Point

SAMPLE = Path(__file__).resolve().parents[2] / "docs" / "sample_run" / "world_sample"


@pytest.fixture(autouse=True)
def _fresh_cache():
    digest.clear_cache()
    yield
    digest.clear_cache()


@pytest.fixture()
def sample_run(worlds_dir) -> str:
    """The trimmed sample run (3 turns: init, r00011_t03_a04, r00011_end) as run 'run_sample'."""
    target = worlds_dir / "world_sample"
    shutil.copytree(SAMPLE, target)
    manifest_path = target / "runs" / "run_sample" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest.update(run_id="run_sample", world_id="world_sample", current_turn_id="r00011_end")
    manifest_path.write_text(json.dumps(manifest))
    return "run_sample"


def wait_idle(worker: runner.RunWorker, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if worker.status().state in ("paused", "error", "finished"):
            return
        time.sleep(0.01)
    raise AssertionError("worker did not settle")


def play(worker: runner.RunWorker, rounds: int) -> None:
    for _ in range(rounds):
        worker.submit("step_round")
        wait_idle(worker)
        assert worker.status().last_error is None


def kill_run(manager: runner.RunManager) -> runner.RunWorker:
    """6 fake-scripted agents: a01 attacks a02 (health 5, same point) in round 1; the others wait."""
    request = config.default_run_request("fake-scripted", 6).model_copy(update={"play_delay_seconds": 0.0})
    a01, a02 = request.agents[0], request.agents[1]
    a02.position = Point(x=a01.position.x, y=a01.position.y)
    a02.stats.health = 5
    a01.fake_script = [{"thought": "Boreas looks weak; I strike first.", "action": {"name": "attack", "args": {"target": "a02", "compute_budget": 10}}}]
    for card in request.agents[1:]:
        card.fake_script = [{"thought": "", "action": {"name": "wait", "args": {"rounds": 1}}}]
    return manager.require(manager.create_run(request).run_id)


# ---------------------------------------------------------------------------
# Sample data
# ---------------------------------------------------------------------------


def test_sample_turn_digest_falls_back_to_the_action_when_the_thought_is_empty(sample_run) -> None:
    d = digest.turn_digest(sample_run, "r00011_t03_a04")
    assert d["actor"] == {"id": "a04", "name": "Damaris"}
    assert d["decision_source"] == "model"
    assert "thought" not in d  # the sample's haiku decision had an empty thought
    assert "reasoning" not in d["text"] and "belief" not in d["text"]
    assert d["text"].startswith("Damaris (a04) sent a message to Aster (a01): “Greetings a01!")
    assert d["action"] == {"name": "send", "args": {"recipient": "a01"}}  # message text lives in messages[]
    assert d["result"]["ok"] is True and d["result"]["cost"] == {"compute": 3}
    [message] = d["messages"]
    assert message["from"] == "a04" and message["to"] == ["a01"] and message["delivered"] is True
    assert message["text"].startswith("Greetings a01! I'm Damaris")
    assert d["costs"] == {"thinking": 1.7, "action": 3}
    assert "lost" not in d and "deaths" not in d
    # the previous turn is not in the trimmed sample: no deltas, no crash
    assert "actor_delta" not in d


def test_sample_round_end_and_round_digest(sample_run) -> None:
    end = digest.turn_digest(sample_run, "r00011_end")
    assert end["kind"] == "round_end"
    assert end["growth"] == {"plants": 12, "energy_in": 144, "essence_in": 12}
    assert end["fruit"] == {"removed": {"consumed": 2}}
    assert end["upkeep_paid"] == 8 and "upkeep_short" not in end
    assert [x["id"] for x in end["living"]] == [f"a0{i}" for i in range(1, 9)]
    assert end["living"][0] == {"id": "a01", "name": "Aster"} and all(x.get("name") for x in end["living"])
    assert "8 agents alive: Aster (a01), " in end["text"]  # the narrator gets names, never bare ids
    rd = digest.round_digest(sample_run, 11)
    assert rd["complete"] is True and rd["order"][:3] == ["a07", "a08", "a04"]
    assert [t["turn_id"] for t in rd["turns"]] == ["r00011_t03_a04"]
    assert rd["counts"] == {"actions": {"send": 1}, "messages": 1}
    assert rd["end"]["turn_id"] == "r00011_end"
    assert len(rd["agents"]) == 8 and rd["agents"][0]["name"] == "Aster"
    assert digest.last_round_digest(sample_run)["round"] == 11
    brief = digest.round_digest(sample_run, 11, detail="brief")
    assert "agents" not in brief and brief["turns"][0]["action"] == "send"
    with pytest.raises(storage.StorageError):
        digest.round_digest(sample_run, 3)
    with pytest.raises(ValueError):
        digest.round_digest(sample_run, 11, detail="huge")


def test_round_end_names_starving_short_and_living_agents() -> None:
    from empyrean.schemas import Event, TurnRecord

    agents = {"a04": {"id": "a04", "name": "Damaris", "alive": True}, "a05": {"id": "a05", "name": "Eos", "alive": True}, "a08": {"id": "a08", "name": "Halcyon", "alive": False}}
    record = TurnRecord.model_construct(turn_id="r00019_end", kind="round_end", round=19, action_result=None)

    def ev(seq: int, kind: str, details: dict, actor: str = "world") -> Event:
        return Event(seq=seq, turn_id="r00019_end", round=19, turn=None, actor=actor, kind=kind, summary=kind, details=details)

    events = [
        ev(1, "upkeep", {"agent_id": "a05", "paid": 1, "owed": 2}),
        ev(2, "upkeep", {"agent_id": "a08", "paid": 0, "owed": 2}),
        ev(3, "starvation", {"agent_id": "a08", "health_after": 0}),
        ev(4, "round_ended", {"round": 19, "living_agents": ["a04", "a05"], "deaths": ["a08"]}),
    ]
    end = digest._round_end_digest(record, events, agents)
    assert end["living"] == [{"id": "a04", "name": "Damaris"}, {"id": "a05", "name": "Eos"}]
    assert end["upkeep_short"] == [{"id": "a05", "name": "Eos"}, {"id": "a08", "name": "Halcyon"}]
    assert end["starvation"] == [{"id": "a08", "name": "Halcyon", "health_after": 0}]
    assert "2 agents alive: Damaris (a04), Eos (a05)." in end["text"] and "Halcyon (a08) starved" in end["text"]
    unknown = digest._round_end_digest(record, [ev(5, "round_ended", {"living_agents": ["zz9"]})], agents)
    assert unknown["living"] == [{"id": "zz9"}]  # no name to give: the id alone, never an invented one


def test_cast_map_lists_every_agent_with_alive_flag(sample_run) -> None:
    cast = digest.cast_map(sample_run, "r00011_end")
    assert [c["id"] for c in cast] == [f"a0{i}" for i in range(1, 9)]
    assert cast[0] == {"id": "a01", "name": "Aster", "alive": True}
    assert digest.cast_map(sample_run) == cast  # default: the current turn
    with pytest.raises(storage.StorageError):
        digest.cast_map(sample_run, "r00099_end")


def test_sample_dossier_separates_truth_and_belief(sample_run) -> None:
    d = digest.agent_dossier(sample_run, "a04")
    assert d["as_of_turn_id"] == "r00011_end"
    assert d["truth"]["label"].startswith("operator truth")
    assert d["belief"]["label"].startswith("the agent's own view")
    assert d["truth"]["stats"]["compute"] == 124 and d["truth"]["model"] == "claude-cli-haiku"
    assert d["belief"]["from_turn_id"] == "r00011_t03_a04"
    assert d["belief"]["believed_self"]["compute"] == 131.8
    assert "compute: believes 131.8, actually 124" in d["discrepancies"]
    with pytest.raises(storage.StorageError):
        digest.agent_dossier(sample_run, "a99")


def test_sample_search_highlights_and_card(sample_run) -> None:
    found = digest.search_events(sample_run, text="greetings", kinds=["action"])
    assert found["total"] == 1 and found["matches"][0]["kind"] == "action"
    assert digest.search_events(sample_run, actor="a01")["total"] >= 1  # a01 is a recipient / payer
    limited = digest.search_events(sample_run, kinds=["upkeep"], limit=3)
    assert limited["total"] == 8 and len(limited["matches"]) == 3 and limited["truncated"] is True
    ranged = digest.search_events(sample_run, from_turn_id="r00011_end", to_turn_id="r00011_end")
    assert ranged["scanned_turns"] == 1
    highlights = digest.get_highlights(sample_run)
    assert [h["kind"] for h in highlights] == ["message"]
    card = digest.run_card(sample_run)
    assert card.name == "live-story-8x12" and len(card.cast) == 8 and card.turns == 1 and card.rounds == 11
    assert card.first_turn_id == "r00000_init" and card.last_turn_id == "r00011_end"
    opening = digest.opening_digest(sample_run)
    assert opening["turn_id"] == "r00000_init" and opening["plants"] == {"fruit_tree": 12}
    assert opening["terrain"]["land"] == 410 and opening["parent"] is None


def test_live_alias_and_bad_ids(sample_run) -> None:
    assert digest.turn_digest(sample_run, "live")["turn_id"] == "r00011_end"
    with pytest.raises(ValueError):
        digest.turn_digest(sample_run, "../etc")
    with pytest.raises(storage.StorageError):
        digest.turn_digest(sample_run, "r00009_end")


def test_max_chars_trims_long_fields(sample_run) -> None:
    small = digest.turn_digest(sample_run, "r00011_t03_a04", max_chars=400)
    assert small["truncated"] is True
    assert len(json.dumps(small, ensure_ascii=False, separators=(",", ":"))) <= 600
    assert digest.digest_sha(small) == digest.digest_sha(json.loads(json.dumps(small)))


# ---------------------------------------------------------------------------
# Fresh fake runs
# ---------------------------------------------------------------------------


def test_killer_is_attributed_from_the_damage_event(manager) -> None:
    worker = kill_run(manager)
    play(worker, 2)
    turns = manager.list_turns(worker.run_id)
    kill_turn = next(t.turn_id for t in turns if t.acting_agent_id == "a01" and t.round == 1)
    d = digest.turn_digest(worker.run_id, kill_turn)
    assert d["thought"] == "Boreas looks weak; I strike first."
    assert "Its own stated reasoning (a belief, not a fact)" in d["text"]
    [death] = d["deaths"]
    assert death["id"] == "a02" and death["cause"] == "attack" and death["by"] == "a01"
    assert death["residue"]["id"].startswith("res")
    assert d["damage"][0]["by"] == "a01" and d["damage"][0]["target"] == "a02"
    assert "killed by" in d["text"]
    assert d["others"][0]["id"] == "a02" and d["others"][0]["alive"] == [True, False]
    card = digest.run_card(worker.run_id)
    by_id = {c.agent_id: c for c in card.cast}
    assert card.deaths == 1 and card.kills == 1
    assert by_id["a01"].kills == 1 and by_id["a02"].died_turn_id == kill_turn and by_id["a02"].alive is False
    highlights = digest.get_highlights(worker.run_id, limit=3)
    assert highlights[0]["kind"] == "death" and highlights[0]["salience"] == digest.SALIENCE["death"]
    assert "killed by" in highlights[0]["text"]
    dossier = digest.agent_dossier(worker.run_id, "a02")
    assert dossier["truth"]["alive"] is False and dossier["truth"]["killed_by"]["by"] == "a01"
    assert digest.agent_dossier(worker.run_id, "a01")["truth"]["kills"] == [{"id": "a02", "turn_id": kill_turn}]
    # later turns of the dead agent are skipped and stated as such
    skipped = [t.turn_id for t in turns if t.acting_agent_id == "a02" and t.round == 2]
    if skipped:
        sd = digest.turn_digest(worker.run_id, skipped[0])
        assert sd.get("skipped") is True and "dead" in sd["text"]
    rd = digest.round_digest(worker.run_id, 1)
    assert rd["counts"]["deaths"] == 1 and rd["counts"]["kills"] == 1 and rd["counts"]["attacks"] == 1
    assert any("killed by" in h for h in rd["highlights"])


def test_trends_over_rounds(manager, default_request) -> None:
    worker = manager.require(manager.create_run(default_request.model_copy(update={"play_delay_seconds": 0.0})).run_id)
    play(worker, 3)
    t = digest.trends(worker.run_id, 2)
    assert t["rounds"] == [2, 3] and t["partial_round"] is None
    assert set(t["metrics"]) == set(digest.TREND_METRICS)
    assert all(len(v) == 2 for v in t["metrics"].values())
    assert t["metrics"]["living"] == [8, 8]
    assert t["delta"]["held_compute"] == pytest.approx(t["metrics"]["held_compute"][1] - t["metrics"]["held_compute"][0], abs=0.2)
    # a round in progress is reported as partial
    worker.submit("run_turn")
    wait_idle(worker)
    t2 = digest.trends(worker.run_id, 5)
    assert t2["rounds"] == [1, 2, 3, 4] and t2["partial_round"] == 4
    full = digest.trends(worker.run_id, 50)
    assert full["rounds"][0] == 1


def test_continuations_follow_the_parent(manager, default_request) -> None:
    parent = manager.require(manager.create_run(default_request.model_copy(update={"play_delay_seconds": 0.0})).run_id)
    play(parent, 2)
    fork = "r00001_end"
    child_summary = manager.create_continuation(parent.run_id, ContinuationRequest(from_turn_id=fork, name="Branch"))
    child = manager.require(child_summary.run_id)
    play(child, 1)
    timeline = digest.timeline(child.run_id)
    ids = [r.turn_id for r in timeline]
    assert ids[0] == "r00000_init" and ids.count(fork) == 1
    assert timeline[ids.index(fork)].run_id == child.run_id or timeline[ids.index(fork)].run_id == parent.run_id
    assert all(r.run_id == parent.run_id for r in timeline[: ids.index(fork)])
    assert all(r.run_id == child.run_id for r in timeline[ids.index(fork) + 1 :])
    # the child's own turns exclude the copied fork turn
    own = [r.turn_id for r in digest.own_turns(child.run_id)]
    assert fork not in own and own[0].startswith("r00002_")
    # a pre-fork turn of the child is read from the parent run
    pre = next(r.turn_id for r in timeline if r.round == 1 and r.entry.kind == "agent_turn")
    d = digest.turn_digest(child.run_id, pre)
    assert d["run_id"] == parent.run_id
    # round 1 digest of the child crosses into the parent; trends span the fork
    assert digest.round_digest(child.run_id, 1)["complete"] is True
    assert digest.trends(child.run_id, 5)["rounds"] == [1, 2]
    # the child's round 2 is its own, not the parent's round 2
    child_r2 = {t["turn_id"] for t in digest.round_digest(child.run_id, 2)["turns"]}
    assert child_r2 and all(digest._resolve(child.run_id, t).run_id == child.run_id for t in child_r2)
    opening = digest.opening_digest(child.run_id)
    assert opening["turn_id"] == fork and opening["parent"]["run_id"] == parent.run_id
    card = digest.run_card(child.run_id)
    assert card.parent["turn_id"] == fork and card.first_turn_id == fork


def test_digests_are_read_only(manager, default_request, worlds_dir) -> None:
    worker = manager.require(manager.create_run(default_request.model_copy(update={"play_delay_seconds": 0.0})).run_id)
    play(worker, 1)
    rdir = storage.find_run_dir(worker.run_id)
    before = {p: p.stat().st_mtime_ns for p in rdir.rglob("*") if p.is_file()}
    for ref in digest.timeline(worker.run_id):
        digest.turn_digest(worker.run_id, ref.turn_id)
    digest.round_digest(worker.run_id, 1, detail="full")
    digest.trends(worker.run_id, 3)
    digest.run_card(worker.run_id)
    digest.agent_dossier(worker.run_id, "a01")
    digest.search_events(worker.run_id, text="a01")
    after = {p: p.stat().st_mtime_ns for p in rdir.rglob("*") if p.is_file()}
    assert before == after
    assert not any("knowledge" in str(p) for p in digest._cache)  # never cached a knowledge file
