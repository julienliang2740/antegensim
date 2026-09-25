"""
Helpers shared by the end-to-end tests (QA; ``tests/test_e2e_*.py``).

The end-to-end tests drive the backend only through the public API routes of
docs/INTERFACES.md section 9 (FastAPI ``TestClient``, fake models, a temporary
worlds directory) and read the run folder only through the documented storage
layout of section 5.  Nothing here imports runner/world/context internals, so
a test failure points at a contract break, not at a test helper.

``E2EApi`` wraps one TestClient.  Every call asserts the documented HTTP status
and returns the parsed JSON body, so a failing test shows the route, the status
code and the backend's ``ApiError`` body.
"""

from __future__ import annotations

import contextlib
import json
import re
import time
from pathlib import Path
from typing import Any, Iterator, Optional

# RunStatus.state values in which no command is driving the worker.
IDLE_STATES = ("paused", "error", "finished")
# RunStatus.state values while a command drives the worker.
ACTIVE_STATES = ("running", "turn_active", "waiting_model", "pause_requested")

# Files every committed turn directory must contain (INTERFACES section 5).
REQUIRED_TURN_FILES = (
    "state.json",
    "world.json",
    "map.json",
    "rules.json",
    "settings.json",
    "events.json",
    "entities/plants.json",
    "entities/fruits.json",
    "entities/seeds.json",
    "entities/residues.json",
    "entities/removed.json",
    "model_calls/index.json",
)
REQUIRED_TURN_DIRS = ("entities/agents", "entities/knowledge", "model_calls", "decision_packets")

# Files at the run root and in working/ (INTERFACES section 5).
REQUIRED_RUN_FILES = ("manifest.json", "run_request.json", "assumptions.json", "turns/index.jsonl")
REQUIRED_WORKING_FILES = (
    "working/README.txt",
    "working/BASE_TURN",
    "working/world.json",
    "working/map.json",
    "working/rules.json",
    "working/settings.json",
    "working/entities/plants.json",
    "working/entities/fruits.json",
    "working/entities/seeds.json",
    "working/entities/residues.json",
    "working/entities/removed.json",
)

AGENT_TURN_ID = re.compile(r"^r(\d{5})_t(\d{2})_([A-Za-z0-9]{1,16})$")
KNOWLEDGE_RECORD_ID = re.compile(r"\b([A-Za-z0-9]{1,16})-k\d{6}\b")

# Direction vectors (INTERFACES section 3).
DIRECTIONS = {"up": (0, 1), "down": (0, -1), "left": (-1, 0), "right": (1, 0)}


class E2EApi:
    """Thin JSON wrapper around a FastAPI TestClient bound to one RunManager."""

    def __init__(self, client: Any, worlds_dir: Path) -> None:
        self.client = client
        self.worlds_dir = Path(worlds_dir)

    # -- raw requests ---------------------------------------------------------

    def get(self, path: str, expect: int = 200, **params: Any) -> Any:
        response = self.client.get("/api" + path, params={k: v for k, v in params.items() if v is not None})
        assert response.status_code == expect, f"GET {path} -> {response.status_code}: {response.text[:2000]}"
        return response.json()

    def post(self, path: str, body: Any = None, expect: int = 200) -> Any:
        response = self.client.post("/api" + path, json=body)
        assert response.status_code == expect, f"POST {path} -> {response.status_code}: {response.text[:2000]}"
        return response.json()

    def post_raw(self, path: str, body: Any = None) -> Any:
        """The httpx response itself (for tests that check error codes)."""
        return self.client.post("/api" + path, json=body)

    def delete(self, path: str, expect: int = 200) -> Any:
        response = self.client.delete("/api" + path)
        assert response.status_code == expect, f"DELETE {path} -> {response.status_code}: {response.text[:2000]}"
        return response.json()

    # -- setup ------------------------------------------------------------------

    def defaults(self, agent_count: int = 8) -> dict[str, Any]:
        return self.get("/defaults", agent_count=agent_count)

    def preview_map(self, request: dict[str, Any]) -> dict[str, Any]:
        """POST /world/preview for the request's seed and world config (A-WORLD-6)."""
        return self.post("/world/preview", {"seed": request["seed"], "world": request["world"]})

    def create_run(self, request: dict[str, Any]) -> dict[str, Any]:
        """POST /runs (201) then POST /open (idempotent while open, as the UI does)."""
        summary = self.post("/runs", request, expect=201)
        self.open(summary["run_id"])
        return summary

    def open(self, run_id: str) -> dict[str, Any]:
        return self.post(f"/runs/{run_id}/open")

    def close(self, run_id: str) -> dict[str, Any]:
        return self.post(f"/runs/{run_id}/close")

    # -- commands -----------------------------------------------------------------

    def status(self, run_id: str) -> dict[str, Any]:
        return self.get(f"/runs/{run_id}/status")

    def command(self, run_id: str, command: str, expect: int = 200) -> dict[str, Any]:
        return self.post(f"/runs/{run_id}/commands", {"command": command}, expect=expect)

    def wait_idle(self, run_id: str, timeout: float = 60.0) -> dict[str, Any]:
        """Poll GET /status until no command drives the worker (paused/error/finished)."""
        deadline = time.monotonic() + timeout
        status = self.status(run_id)
        while time.monotonic() < deadline:
            status = self.status(run_id)
            if status["state"] in IDLE_STATES and not status.get("active_command") and not status.get("play_loop"):
                return status
            time.sleep(0.01)
        raise AssertionError(f"run {run_id} still busy after {timeout}s: {status}")

    def wait_for(self, run_id: str, predicate: Any, timeout: float = 60.0, what: str = "condition") -> dict[str, Any]:
        """Poll GET /status until ``predicate(status)`` is true."""
        deadline = time.monotonic() + timeout
        status = self.status(run_id)
        while time.monotonic() < deadline:
            status = self.status(run_id)
            if predicate(status):
                return status
            if status["state"] == "error":
                raise AssertionError(f"run {run_id} entered error while waiting for {what}: {status.get('last_error')}")
            time.sleep(0.01)
        raise AssertionError(f"timed out waiting for {what}; last status {status}")

    def run_turn(self, run_id: str) -> dict[str, Any]:
        """One agent turn (or round-end step), then paused.  Asserts no error."""
        self.command(run_id, "run_turn")
        status = self.wait_idle(run_id)
        assert status["state"] in ("paused", "finished"), f"run_turn ended in {status['state']}: {status.get('last_error')}"
        return status

    def step_round(self, run_id: str) -> dict[str, Any]:
        """Advance through the rest of the round (until r{n}_end commits), then paused."""
        self.command(run_id, "step_round")
        status = self.wait_idle(run_id)
        assert status["state"] in ("paused", "finished"), f"step_round ended in {status['state']}: {status.get('last_error')}"
        assert status["current_turn_id"].endswith("_end"), f"step_round stopped at {status['current_turn_id']}"
        return status

    def step_rounds(self, run_id: str, count: int) -> dict[str, Any]:
        status = self.status(run_id)
        for _ in range(count):
            status = self.step_round(run_id)
        return status

    # -- reads ----------------------------------------------------------------------

    def turns(self, run_id: str) -> list[dict[str, Any]]:
        return self.get(f"/runs/{run_id}/turns")

    def turn(self, run_id: str, turn_id: str) -> dict[str, Any]:
        """TurnView of one committed turn (``live`` reads the open runner)."""
        return self.get(f"/runs/{run_id}/turns/{turn_id}")

    def live(self, run_id: str) -> dict[str, Any]:
        return self.get(f"/runs/{run_id}/state")

    def turn_events(self, run_id: str, turn_id: str) -> list[dict[str, Any]]:
        return self.get(f"/runs/{run_id}/turns/{turn_id}/events")

    def events(self, run_id: str, since: int = 0, limit: int = 500) -> dict[str, Any]:
        return self.get(f"/runs/{run_id}/events", since=since, limit=limit)

    def knowledge(self, run_id: str, turn_id: str, agent_id: str) -> dict[str, Any]:
        return self.get(f"/runs/{run_id}/turns/{turn_id}/agents/{agent_id}/knowledge")

    def live_knowledge(self, run_id: str, agent_id: str) -> dict[str, Any]:
        return self.get(f"/runs/{run_id}/agents/{agent_id}/knowledge")

    def packet(self, run_id: str, turn_id: str, packet_id: str) -> dict[str, Any]:
        return self.get(f"/runs/{run_id}/turns/{turn_id}/decision_packets/{packet_id}")

    def model_call(self, run_id: str, turn_id: str, call_id: str) -> dict[str, Any]:
        return self.get(f"/runs/{run_id}/turns/{turn_id}/model_calls/{call_id}")

    def settings(self, run_id: str) -> dict[str, Any]:
        return self.get(f"/runs/{run_id}/settings")

    def stage(self, run_id: str, intervention: dict[str, Any]) -> dict[str, Any]:
        """POST /interventions (201) -> StagedInterventionsResponse."""
        return self.post(f"/runs/{run_id}/interventions", intervention, expect=201)

    def staged(self, run_id: str) -> list[dict[str, Any]]:
        return self.get(f"/runs/{run_id}/interventions")["staged"]

    def agent_turns(self, run_id: str, agent_id: str) -> list[dict[str, Any]]:
        """TurnIndexEntry rows of the agent's own turns, in committed order."""
        return [t for t in self.turns(run_id) if t.get("acting_agent_id") == agent_id and t["kind"] == "agent_turn"]

    def turn_and_previous(self, run_id: str, turn_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        view = self.turn(run_id, turn_id)
        previous_id = view["turn"]["previous_turn_id"]
        assert previous_id, f"{turn_id} has no previous turn"
        return view, self.turn(run_id, previous_id)

    # -- disk ------------------------------------------------------------------------

    def run_dir(self, run_id: str) -> Path:
        """worlds/{world_id}/runs/{run_id} (INTERFACES section 5)."""
        matches = list(self.worlds_dir.glob(f"*/runs/{run_id}"))
        assert len(matches) == 1, f"expected exactly one run dir for {run_id}, found {matches}"
        return matches[0]

    def turn_dir(self, run_id: str, turn_id: str) -> Path:
        return self.run_dir(run_id) / "turns" / turn_id

    def read_json(self, path: Path) -> Any:
        return json.loads(Path(path).read_text(encoding="utf-8"))


@contextlib.contextmanager
def fresh_api(registry: Any, worlds_dir: Path) -> Iterator[E2EApi]:
    """A brand-new RunManager + app + TestClient on the same worlds dir (a process restart)."""
    from fastapi.testclient import TestClient

    from empyrean.api import create_app
    from empyrean.runner import RunManager

    manager = RunManager(registry)
    try:
        with TestClient(create_app(manager)) as client:
            yield E2EApi(client, worlds_dir)
    finally:
        manager.shutdown()


# ---------------------------------------------------------------------------
# Request builders
# ---------------------------------------------------------------------------


def base_request(api: E2EApi, name: str, agent_count: int = 8, **overrides: Any) -> dict[str, Any]:
    """GET /defaults with a name, no play delay (tests do not need to watch), and overrides."""
    request = api.defaults(agent_count)
    request["name"] = name
    request["play_delay_seconds"] = 0.0
    request.update(overrides)
    return request


def card(request: dict[str, Any], agent_id: str) -> dict[str, Any]:
    for entry in request["agents"]:
        if entry["id"] == agent_id:
            return entry
    raise KeyError(agent_id)


def script_card(request: dict[str, Any], agent_id: str, script: list[dict[str, Any]]) -> dict[str, Any]:
    """Make one card use fake-scripted with this list of Decision dicts (INTERFACES section 12)."""
    entry = card(request, agent_id)
    entry["model_key"] = "fake-scripted"
    entry["fake_script"] = script
    return entry


def decision(action: str, thought: str = "", **args: Any) -> dict[str, Any]:
    """A Decision dict with one action (section 6)."""
    return {"thought": thought, "action": {"name": action, "args": args}}


def skill_decision(name: str, source: str, params: Optional[list[str]] = None, thought: str = "") -> dict[str, Any]:
    """Save one skill and run it in the same decision (A-SKILL-6: save, then action)."""
    return {
        "thought": thought,
        "save_skills": [{"name": name, "params": params or [], "source": source}],
        "action": {"name": "run_skill", "args": {"skill": name, "arguments": []}},
    }


# ---------------------------------------------------------------------------
# Map helpers
# ---------------------------------------------------------------------------


def key(x: int, y: int) -> str:
    return f"{x},{y}"


def terrain(map_state: dict[str, Any], x: int, y: int) -> Optional[str]:
    return map_state["cells"].get(key(x, y))


def near_origin_cells(map_state: dict[str, Any], radius: int = 6) -> list[tuple[int, int]]:
    """Cells within ``radius`` of (0,0), nearest first, deterministic order."""
    cells = []
    for cell_key in map_state["cells"]:
        x, y = (int(v) for v in cell_key.split(","))
        if abs(x) + abs(y) <= radius:
            cells.append((abs(x) + abs(y), x, y))
    return [(x, y) for _, x, y in sorted(cells)]


def find_clear_path(map_state: dict[str, Any], direction: str, length: int) -> tuple[int, int]:
    """A non-mountain start cell whose next ``length`` cells in ``direction`` are inside the
    region and not mountains (moves onto water are legal)."""
    dx, dy = DIRECTIONS[direction]
    for x, y in near_origin_cells(map_state):
        path = [(x + dx * i, y + dy * i) for i in range(length + 1)]
        if all(terrain(map_state, px, py) in ("land", "water") for px, py in path) and terrain(map_state, x, y) == "land":
            return x, y
    raise AssertionError(f"no clear path of {length} cells {direction} near the origin")


def find_mountain_edge(map_state: dict[str, Any]) -> tuple[tuple[int, int], str]:
    """A land cell (nearest the origin) with a mountain directly next to it, and the
    direction that points at the mountain."""
    for x, y in near_origin_cells(map_state, radius=40):
        if terrain(map_state, x, y) != "land":
            continue
        for direction, (dx, dy) in DIRECTIONS.items():
            if terrain(map_state, x + dx, y + dy) == "mountain":
                return (x, y), direction
    raise AssertionError("the generated map has no mountain next to a land cell")


def far_free_land(map_state: dict[str, Any], occupied: list[tuple[int, int]], min_distance: int = 6) -> tuple[int, int]:
    """A land cell with no occupants at Manhattan distance >= min_distance from every
    point in ``occupied`` (so no agent can see or reach it for a while)."""
    candidates = sorted(
        (abs(x) + abs(y), x, y)
        for x, y in (tuple(int(v) for v in k.split(",")) for k in map_state["cells"])
        if map_state["cells"][key(x, y)] == "land" and not map_state.get("occupants", {}).get(key(x, y))
    )
    for _, x, y in candidates:
        if all(abs(x - ox) + abs(y - oy) >= min_distance for ox, oy in occupied):
            return x, y
    raise AssertionError("no free land cell far from the agents")


def point(value: dict[str, Any]) -> tuple[int, int]:
    return int(value["x"]), int(value["y"])


# ---------------------------------------------------------------------------
# Measurements
# ---------------------------------------------------------------------------


def dir_bytes(path: Path) -> int:
    return sum(p.stat().st_size for p in Path(path).rglob("*") if p.is_file())


def turn_bytes(run_dir: Path) -> dict[str, int]:
    """Bytes on disk per committed turn directory (hidden .partial_ dirs excluded)."""
    turns = Path(run_dir) / "turns"
    return {d.name: dir_bytes(d) for d in sorted(turns.iterdir()) if d.is_dir() and not d.name.startswith(".")}


def knowledge_ids_in_text(text: str) -> set[str]:
    """Agent-id prefixes of every knowledge record id cited in ``text``."""
    return set(KNOWLEDGE_RECORD_ID.findall(text))


def packet_text(packet: dict[str, Any]) -> str:
    return "\n".join(message["content"] for message in packet["messages"])


def events_of(view: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    return [e for e in view["events"] if e["kind"] == kind]


def charged_cognition(view: dict[str, Any]) -> float:
    """Cognition compute charged to the actor in this turn (sum over its model calls)."""
    return sum(call.get("charged_compute", 0.0) for call in view["model_calls"])
