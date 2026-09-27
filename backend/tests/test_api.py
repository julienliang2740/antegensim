"""
Route-shape and error-code tests for empyrean.api against a fake RunManager.

The app is built with ``create_app(FakeManager())``: every route must translate
its request into exactly one manager call and its errors into the ``ApiError``
body with the code table from docs/INTERFACES.md section 9.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from empyrean import config
from empyrean.api import create_app
from empyrean.model import UnknownModelError
from empyrean.runner import NotFoundError, RunnerError, SetupError
from empyrean.schemas import (
    AgentKnowledge,
    AgentKnowledgeView,
    ApiProblem,
    AssumptionEntry,
    Checkpoint,
    ContextSettings,
    EffectiveSettingsView,
    Event,
    Intervention,
    MapState,
    ModelCallRecord,
    ModelInfo,
    ModelRequest,
    PendingModelCallView,
    Region,
    ReloadResponse,
    RulesConfig,
    RunSettings,
    RunStatus,
    RunSummary,
    SchedulerState,
    TurnId,
    TurnIndexEntry,
    TurnRecord,
    WorldState,
)
from empyrean.storage import StorageError

RUN = "run_20260925_101500_cd34"
WORLD = "world_20260925_101500_ab12"


def make_checkpoint() -> Checkpoint:
    turn = TurnRecord(turn_id=TurnId.INIT, kind="init", round=0, scheduler=SchedulerState())
    world = WorldState(map=MapState(region=Region(), cells={"0,0": "land"}))
    return Checkpoint(turn=turn, world=world, settings=RunSettings(default_model_key="fake-heuristic"), events=[])


def make_status(state: str = "paused") -> RunStatus:
    return RunStatus(run_id=RUN, world_id=WORLD, state=state, round=0, current_turn_id=TurnId.INIT, feed_epoch="abc")  # type: ignore[arg-type]


def make_summary() -> RunSummary:
    return RunSummary(world_id=WORLD, run_id=RUN, name="First fake run", current_turn_id=TurnId.INIT, last_round=0, saved_at="2026-09-25T10:15:00+00:00", agent_count=8, living_agent_count=8, status="paused")


class FakeWorker:
    def __init__(self) -> None:
        self.state = "paused"
        self.checkpoint = make_checkpoint()
        self.commands: list[str] = []
        self.staged_list: list[Intervention] = []

    def status(self) -> RunStatus:
        return make_status(self.state)

    def submit(self, command: str) -> RunStatus:
        self.commands.append(command)
        if command == "pause":
            self.state = "paused"
            return self.status()
        if self.state != "paused":
            raise RunnerError(f"illegal_command: {command} while {self.state}")
        self.state = "running"
        return self.status()

    def live_view(self) -> Any:
        from empyrean.runner import turn_view

        return turn_view(self.checkpoint, [], [], None, live=True, extra_events=[Event(seq=1, turn_id=TurnId.INIT, round=0, turn=None, actor="system", kind="run_created", summary="created")])

    def events_since(self, since: int, limit: int) -> list[Event]:
        return [Event(seq=s, turn_id=TurnId.INIT, round=0, turn=None, actor="system", kind="run_created", summary="e") for s in range(since + 1, min(since + limit, 3) + 1)]

    def pending_model_call_view(self) -> Optional[PendingModelCallView]:
        if self.state != "waiting_model":
            return None
        record = ModelCallRecord(call_id="mc_r00001_t01_a01_01", turn_id="r00001_t01_a01", round=1, turn=1, agent_id="a01", purpose="decision", model_key="fake-heuristic", provider="fake", model_id="fake-heuristic", status="pending", started_at="t", request=ModelRequest(request_id="x", model_key="fake-heuristic", messages=[]))
        return PendingModelCallView(record=record)

    def stage_intervention(self, iv: Intervention) -> Intervention:
        if getattr(iv, "entity_id", "") == "zz":
            raise SetupError([ApiProblem(path="entity_id", message="unknown entity zz")])
        staged = iv.model_copy(update={"id": f"iv_{len(self.staged_list) + 1:04d}"})
        self.staged_list.append(staged)
        return staged

    def staged(self) -> list[Intervention]:
        return list(self.staged_list)

    def unstage(self, iv_id: str) -> None:
        if not any(iv.id == iv_id for iv in self.staged_list):
            raise NotFoundError(f"no staged intervention {iv_id}")
        self.staged_list = [iv for iv in self.staged_list if iv.id != iv_id]

    def reload_working(self) -> ReloadResponse:
        if self.state != "paused":
            raise RunnerError("illegal_command: working/reload while running")
        return ReloadResponse(ok=True)

    def effective_settings(self) -> EffectiveSettingsView:
        return EffectiveSettingsView(settings=self.checkpoint.settings, effective_context={"a01": ContextSettings()}, effective_model_key={"a01": "fake-heuristic"})

    def knowledge(self, agent_id: str) -> AgentKnowledgeView:
        if agent_id != "a01":
            raise NotFoundError(f"no knowledge store for agent {agent_id}")
        return AgentKnowledgeView(turn_id=TurnId.INIT, knowledge=AgentKnowledge(agent_id="a01"), unread_count=0)

    def model_call(self, call_id: str) -> ModelCallRecord:
        view = self.pending_model_call_view()
        if view is None or view.record.call_id != call_id:
            raise NotFoundError(call_id)
        return view.record


class FakeManager:
    def __init__(self) -> None:
        self.registry = None
        self.workers: dict[str, FakeWorker] = {}
        self.created: list[Any] = []
        self.list_filters: list[str] = []
        self.deleted: list[str] = []

    def models_info(self) -> list[ModelInfo]:
        return [ModelInfo(key="fake-heuristic", provider="fake", model_id="fake-heuristic", available=True, capabilities={})]  # type: ignore[arg-type]

    def preview_world(self, request: Any) -> MapState:
        return MapState(region=request.world.region, cells={"0,0": "land"})

    def list_runs(self, archived: str = "0") -> list[RunSummary]:
        self.list_filters.append(archived)
        return [make_summary()]

    def archive_run(self, run_id: str) -> RunSummary:
        if run_id == "missing":
            raise StorageError("unknown run")
        return make_summary().model_copy(update={"archived": True, "archived_at": "2026-09-26T10:00:00+00:00"})

    def unarchive_run(self, run_id: str) -> RunSummary:
        if run_id == "missing":
            raise StorageError("unknown run")
        return make_summary()

    def delete_run(self, run_id: str) -> list[str]:
        from empyrean.storage import RunInUseError

        if run_id == "missing":
            raise StorageError("unknown run")
        if run_id in self.workers:
            raise RunInUseError(f"run {run_id} is open")
        self.deleted.append(run_id)
        return [run_id]

    def validate_setup(self, request: Any) -> list[ApiProblem]:
        return [ApiProblem(path="agents[1].id", message="duplicate id")] if request.name == "dupe" else []

    def create_run(self, request: Any) -> RunSummary:
        if request.name == "dupe":
            raise SetupError(self.validate_setup(request))
        if request.name == "nomodel":
            raise UnknownModelError("nope")
        self.created.append(request)
        self.workers[RUN] = FakeWorker()
        return make_summary()

    def open_run(self, run_id: str) -> FakeWorker:
        if run_id == "missing":
            raise StorageError(f"unknown run {run_id}")
        return self.workers.setdefault(run_id, FakeWorker())

    def close_run(self, run_id: str) -> RunStatus:
        if run_id not in self.workers:
            raise RunnerError("run_not_open")
        del self.workers[run_id]
        return make_status("paused")

    def get(self, run_id: str) -> Optional[FakeWorker]:
        return self.workers.get(run_id)

    def require(self, run_id: str) -> FakeWorker:
        worker = self.workers.get(run_id)
        if worker is None:
            raise RunnerError("run_not_open")
        return worker

    def get_summary(self, run_id: str) -> RunSummary:
        if run_id == "missing":
            raise StorageError("unknown run")
        return make_summary()

    def run_assumptions(self, run_id: str) -> list[AssumptionEntry]:
        return [AssumptionEntry(id="A-COG-1", key="k", citation="c")]

    def list_turns(self, run_id: str, from_round: Optional[int], to_round: Optional[int]) -> list[TurnIndexEntry]:
        if run_id == "boom":
            raise RuntimeError("disk on fire: token sk-secret")
        return [TurnIndexEntry(turn_id=TurnId.INIT, kind="init", round=0, saved_at="t")]

    def turn_view(self, run_id: str, turn_id: str) -> Any:
        from empyrean.runner import turn_view

        if turn_id == "live":
            return self.require(run_id).live_view()
        if turn_id == "nope":
            raise StorageError("unknown turn")
        return turn_view(make_checkpoint(), [], [], None, live=False)

    def turn_events(self, run_id: str, turn_id: str) -> list[Event]:
        return self.require(run_id).live_view().events if turn_id == "live" else []

    def turn_knowledge(self, run_id: str, turn_id: str, agent_id: str) -> AgentKnowledgeView:
        return AgentKnowledgeView(turn_id=turn_id, knowledge=AgentKnowledge(agent_id=agent_id), unread_count=0)

    def model_call(self, run_id: str, turn_id: str, call_id: str) -> ModelCallRecord:
        if turn_id == "live":
            return self.require(run_id).model_call(call_id)
        raise StorageError("no call")

    def decision_packet(self, run_id: str, turn_id: str, packet_id: str) -> Any:
        raise StorageError("no packet")

    def create_continuation(self, run_id: str, request: Any) -> RunSummary:
        summary = make_summary()
        return summary.model_copy(update={"run_id": RUN + "_cont", "current_turn_id": request.from_turn_id})


@pytest.fixture()
def fake_manager() -> FakeManager:
    return FakeManager()


@pytest.fixture()
def client(fake_manager: FakeManager):
    app = create_app(fake_manager)  # type: ignore[arg-type]
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture()
def open_client(client: TestClient) -> TestClient:
    assert client.post(f"/api/runs/{RUN}/open").status_code == 200
    return client


def test_health_defaults_models_assumptions(client: TestClient) -> None:
    body = client.get("/api/health").json()
    assert body == {"ok": True, "version": config.default_rules().__class__.__module__ and "0.1.0"}
    defaults = client.get("/api/defaults?agent_count=6").json()
    assert len(defaults["agents"]) == 6 and defaults["default_model_key"] == config.DEFAULT_MODEL_KEY
    assert len(client.get(f"/api/defaults?agent_count={config.MAX_AGENTS}").json()["agents"]) == config.MAX_AGENTS == 64
    bad = client.get(f"/api/defaults?agent_count={config.MAX_AGENTS + 1}")
    assert bad.status_code == 422 and bad.json()["error"] == "validation_error" and bad.json()["problems"][0]["path"] == "agent_count"
    assert client.get("/api/models").json()[0]["key"] == "fake-heuristic"
    assumptions = client.get("/api/assumptions").json()
    assert {e["id"] for e in assumptions["entries"]} == set(config.ASSUMPTIONS)


def test_world_preview_and_run_listing(client: TestClient) -> None:
    preview = client.post("/api/world/preview", json={"seed": 3})
    assert preview.status_code == 200 and preview.json()["cells"] == {"0,0": "land"}
    runs = client.get("/api/runs").json()
    assert runs[0]["run_id"] == RUN and runs[0]["status"] == "paused"
    assert client.get(f"/api/runs/{RUN}").json()["name"] == "First fake run"
    missing = client.get("/api/runs/missing")
    assert missing.status_code == 404 and missing.json()["error"] == "not_found"
    assert client.get(f"/api/runs/{RUN}/assumptions").json()["entries"][0]["id"] == "A-COG-1"


def test_archive_unarchive_delete_routes_and_list_filter(client: TestClient, fake_manager: FakeManager) -> None:
    for query, expected in (("", "0"), ("?archived=0", "0"), ("?archived=1", "1"), ("?archived=all", "all")):
        assert client.get(f"/api/runs{query}").status_code == 200
        assert fake_manager.list_filters[-1] == expected
    bad = client.get("/api/runs?archived=yes")
    assert bad.status_code == 422 and bad.json()["error"] == "validation_error" and bad.json()["problems"][0]["path"] == "archived"
    archived = client.post(f"/api/runs/{RUN}/archive")
    assert archived.status_code == 200 and archived.json()["archived"] is True and archived.json()["archived_at"]
    restored = client.post(f"/api/runs/{RUN}/unarchive")
    assert restored.status_code == 200 and restored.json()["archived"] is False and restored.json()["archived_at"] is None
    for route in ("/api/runs/missing/archive", "/api/runs/missing/unarchive"):
        assert client.post(route).json()["error"] == "not_found"
    deleted = client.delete(f"/api/runs/{RUN}")
    assert deleted.status_code == 204 and deleted.content == b"" and fake_manager.deleted == [RUN]
    missing = client.delete("/api/runs/missing")
    assert missing.status_code == 404 and missing.json()["error"] == "not_found"
    assert client.post(f"/api/runs/{RUN}/open").status_code == 200
    in_use = client.delete(f"/api/runs/{RUN}")
    assert in_use.status_code == 409 and in_use.json()["error"] == "run_in_use" and fake_manager.deleted == [RUN]


def test_create_and_validate_runs(client: TestClient, fake_manager: FakeManager) -> None:
    request = config.default_run_request().model_dump(mode="json")
    created = client.post("/api/runs", json=request)
    assert created.status_code == 201 and created.json()["run_id"] == RUN
    assert len(fake_manager.created) == 1
    request["name"] = "dupe"
    invalid = client.post("/api/runs", json=request)
    assert invalid.status_code == 422
    assert invalid.json()["error"] == "invalid_setup" and invalid.json()["problems"] == [{"path": "agents[1].id", "message": "duplicate id"}]
    validation = client.post("/api/runs/validate", json=request).json()
    assert validation == {"ok": False, "problems": [{"path": "agents[1].id", "message": "duplicate id"}]}
    request["name"] = "nomodel"
    unknown = client.post("/api/runs", json=request)
    assert unknown.status_code == 422 and unknown.json()["error"] == "unknown_model"
    shape = client.post("/api/runs", json={"name": "x", "agents": [{"name": "a", "position": {"x": "north"}}]})
    assert shape.status_code == 422 and shape.json()["error"] == "validation_error"
    paths = {p["path"] for p in shape.json()["problems"]}
    assert "agents[0].position.x" in paths


def test_run_not_open_then_open_close(client: TestClient) -> None:
    for path in ("status", "state", "events", "settings", "rules", "interventions", "agents/a01/knowledge", "pending_model_call"):
        response = client.get(f"/api/runs/{RUN}/{path}")
        assert response.status_code == 409 and response.json()["error"] == "run_not_open", path
    response = client.post(f"/api/runs/{RUN}/commands", json={"command": "run_turn"})
    assert response.status_code == 409 and response.json()["error"] == "run_not_open"
    assert client.post(f"/api/runs/{RUN}/close").status_code == 409
    missing = client.post("/api/runs/missing/open")
    assert missing.status_code == 404 and missing.json()["error"] == "not_found"
    opened = client.post(f"/api/runs/{RUN}/open")
    assert opened.status_code == 200 and opened.json()["state"] == "paused" and opened.json()["feed_epoch"] == "abc"
    closed = client.post(f"/api/runs/{RUN}/close")
    assert closed.status_code == 200 and closed.json()["state"] == "paused"
    assert client.get(f"/api/runs/{RUN}/status").status_code == 409


def test_commands_and_illegal_command(open_client: TestClient, fake_manager: FakeManager) -> None:
    response = open_client.post(f"/api/runs/{RUN}/commands", json={"command": "play"})
    assert response.status_code == 200 and response.json()["state"] == "running"
    overlap = open_client.post(f"/api/runs/{RUN}/commands", json={"command": "run_turn"})
    assert overlap.status_code == 409 and overlap.json()["error"] == "illegal_command"
    assert fake_manager.workers[RUN].commands == ["play", "run_turn"]
    reload = open_client.post(f"/api/runs/{RUN}/working/reload")
    assert reload.status_code == 409 and reload.json()["error"] == "illegal_command"
    bad = open_client.post(f"/api/runs/{RUN}/commands", json={"command": "jump"})
    assert bad.status_code == 422 and bad.json()["error"] == "validation_error" and bad.json()["problems"][0]["path"] == "command"
    assert open_client.post(f"/api/runs/{RUN}/commands", json={"command": "pause"}).json()["state"] == "paused"
    assert open_client.post(f"/api/runs/{RUN}/working/reload").json() == {"ok": True, "errors": [], "changes": [], "staged": None}


def test_live_reads(open_client: TestClient, fake_manager: FakeManager) -> None:
    events = open_client.get(f"/api/runs/{RUN}/events?since=1&limit=10").json()
    assert [e["seq"] for e in events["events"]] == [2, 3] and events["status"]["state"] == "paused" and "latest_seq" in events
    bad = open_client.get(f"/api/runs/{RUN}/events?since=-1")
    assert bad.status_code == 422 and bad.json()["problems"][0]["path"] == "since"
    state = open_client.get(f"/api/runs/{RUN}/state").json()
    assert state["live"] is True and state["turn"]["turn_id"] == TurnId.INIT and state["events"][0]["kind"] == "run_created"
    assert set(state) >= {"map", "entities", "rules", "settings", "model_calls", "decision_packet_ids", "parent"}
    pending = open_client.get(f"/api/runs/{RUN}/pending_model_call")
    assert pending.status_code == 404 and pending.json()["error"] == "not_found"
    fake_manager.workers[RUN].state = "waiting_model"
    pending = open_client.get(f"/api/runs/{RUN}/pending_model_call")
    assert pending.status_code == 200 and pending.json()["record"]["call_id"] == "mc_r00001_t01_a01_01"
    assert open_client.get(f"/api/runs/{RUN}/turns/live/model_calls/mc_r00001_t01_a01_01").json()["status"] == "pending"
    assert open_client.get(f"/api/runs/{RUN}/turns/live/model_calls/mc_x").status_code == 404
    knowledge = open_client.get(f"/api/runs/{RUN}/agents/a01/knowledge").json()
    assert knowledge["turn_id"] == TurnId.INIT and knowledge["believed_self"]["compute"] is None
    assert open_client.get(f"/api/runs/{RUN}/agents/zz/knowledge").status_code == 404
    settings = open_client.get(f"/api/runs/{RUN}/settings").json()
    assert settings["effective_model_key"] == {"a01": "fake-heuristic"}
    rules = open_client.get(f"/api/runs/{RUN}/rules").json()
    assert rules == RulesConfig().model_dump(mode="json")


def test_history_reads(open_client: TestClient) -> None:
    turns = open_client.get(f"/api/runs/{RUN}/turns?from_round=0&to_round=1").json()
    assert turns[0]["turn_id"] == TurnId.INIT
    view = open_client.get(f"/api/runs/{RUN}/turns/{TurnId.INIT}").json()
    assert view["live"] is False
    assert open_client.get(f"/api/runs/{RUN}/turns/live").json()["live"] is True
    assert open_client.get(f"/api/runs/{RUN}/turns/nope").status_code == 404
    assert open_client.get(f"/api/runs/{RUN}/turns/{TurnId.INIT}/events").json() == []
    assert open_client.get(f"/api/runs/{RUN}/turns/live/events").json()[0]["kind"] == "run_created"
    knowledge = open_client.get(f"/api/runs/{RUN}/turns/{TurnId.INIT}/agents/a02/knowledge").json()
    assert knowledge["knowledge"]["agent_id"] == "a02"
    assert open_client.get(f"/api/runs/{RUN}/turns/{TurnId.INIT}/model_calls/mc_x").status_code == 404
    packet = open_client.get(f"/api/runs/{RUN}/turns/{TurnId.INIT}/decision_packets/pk_x")
    assert packet.status_code == 404 and packet.json()["error"] == "not_found"


def test_interventions_routes(open_client: TestClient) -> None:
    assert open_client.get(f"/api/runs/{RUN}/interventions").json() == {"staged": []}
    body = {"type": "set_stat", "entity_id": "a01", "field": "stats.compute", "value": 5}
    staged = open_client.post(f"/api/runs/{RUN}/interventions", json=body)
    assert staged.status_code == 201 and staged.json()["staged"][0]["id"] == "iv_0001"
    invalid = open_client.post(f"/api/runs/{RUN}/interventions", json={**body, "entity_id": "zz"})
    assert invalid.status_code == 422
    assert invalid.json()["error"] == "invalid_intervention" and invalid.json()["problems"] == [{"path": "entity_id", "message": "unknown entity zz"}]
    shape = open_client.post(f"/api/runs/{RUN}/interventions", json={"type": "voice", "text": "hi"})
    assert shape.status_code == 422 and shape.json()["error"] == "validation_error"
    unknown_type = open_client.post(f"/api/runs/{RUN}/interventions", json={"type": "teleport"})
    assert unknown_type.status_code == 422 and unknown_type.json()["error"] == "validation_error"
    removed = open_client.delete(f"/api/runs/{RUN}/interventions/iv_0001")
    assert removed.status_code == 200 and removed.json() == {"staged": []}
    gone = open_client.delete(f"/api/runs/{RUN}/interventions/iv_0001")
    assert gone.status_code == 404 and gone.json()["error"] == "not_found"


def test_continuation_route(client: TestClient) -> None:
    response = client.post(f"/api/runs/{RUN}/continuations", json={"from_turn_id": "r00001_t02_a01"})
    assert response.status_code == 201
    assert response.json()["run_id"] == RUN + "_cont" and response.json()["current_turn_id"] == "r00001_t02_a01"
    shape = client.post(f"/api/runs/{RUN}/continuations", json={})
    assert shape.status_code == 422 and shape.json()["problems"][0]["path"] == "from_turn_id"


def test_internal_error_has_api_body_and_cors_headers(client: TestClient) -> None:
    response = client.get("/api/runs/boom/turns", headers={"Origin": "http://localhost:5173"})
    assert response.status_code == 500
    body = response.json()
    assert body["error"] == "internal_error" and "disk on fire" in body["detail"] and body["problems"] == []
    assert response.headers.get("access-control-allow-origin") == "http://localhost:5173"


def test_unknown_route_and_cors_preflight(client: TestClient) -> None:
    response = client.get("/api/nothing")
    assert response.status_code == 404 and response.json()["error"] == "not_found"
    preflight = client.options("/api/runs", headers={"Origin": "http://localhost:5174", "Access-Control-Request-Method": "POST"})
    assert preflight.status_code == 200 and preflight.headers.get("access-control-allow-origin") == "http://localhost:5174"
