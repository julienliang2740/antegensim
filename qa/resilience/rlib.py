"""Shared helpers for the resilience / completion-criteria QA scripts.

Everything talks to a real backend process over HTTP (default port 8020, worlds dir
qa/resilience/worlds). Only fake models are used. Server processes started here are
recorded in qa/resilience/pids.txt so the lead (and the cleanup step) can kill exactly
these PIDs and nothing else.

Environment overrides (all optional): RES_PORT (backend port, default 8020), RES_PORT2
(second backend for i_one_writer, default RES_PORT + 1), RES_WORLDS (worlds dir handed to
the backend as EMPYREAN_WORLDS_DIR), RES_OUT (per-scenario .log/.json output dir) and
RES_LOG (backend log file; c_playback and d_invalid grep it).
"""
from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

ROOT = Path("/home/ubuntu/antegensim")
QA = ROOT / "qa" / "resilience"
WORLDS = Path(os.environ.get("RES_WORLDS", str(QA / "worlds")))
OUT = Path(os.environ.get("RES_OUT", str(QA / "out")))
PY = str(ROOT / ".venv" / "bin" / "python")
PORT = int(os.environ.get("RES_PORT", "8020"))
PORT2 = int(os.environ.get("RES_PORT2", str(PORT + 1)))
LOG = Path(os.environ.get("RES_LOG", str(QA / "server.log")))
PID_FILE = QA / "server.pid"
PIDS_ALL = QA / "pids.txt"

OUT.mkdir(parents=True, exist_ok=True)
WORLDS.mkdir(parents=True, exist_ok=True)


def base(port: int = PORT) -> str:
    return f"http://127.0.0.1:{port}/api"


def client(port: int = PORT, timeout: float = 60.0) -> httpx.Client:
    return httpx.Client(base_url=base(port), timeout=timeout)


# ---------------------------------------------------------------------------
# server processes
# ---------------------------------------------------------------------------


def healthy(port: int = PORT) -> bool:
    try:
        return httpx.get(base(port) + "/health", timeout=1).status_code == 200
    except Exception:
        return False


def current_pid() -> Optional[int]:
    try:
        return int(PID_FILE.read_text().strip())
    except Exception:
        return None


def start_server(port: int = PORT, log: Path = LOG, pid_file: Path = PID_FILE, worlds: Path = WORLDS) -> int:
    """Start `python -m empyrean.main` exactly like the task's command (cwd backend,
    EMPYREAN_API_PORT / EMPYREAN_WORLDS_DIR), appending to the log. Returns the PID."""
    # EMPYREAN_DEFAULT_MODEL is forced to the fake so runs created from /defaults never spend money.
    env = dict(os.environ, EMPYREAN_API_PORT=str(port), EMPYREAN_WORLDS_DIR=str(worlds), EMPYREAN_DEFAULT_MODEL="fake-heuristic")
    env.pop("CLAUDECODE", None)
    fh = open(log, "ab")
    fh.write(f"\n===== start_server port={port} at {time.strftime('%H:%M:%S')} =====\n".encode())
    fh.flush()
    p = subprocess.Popen([PY, "-m", "empyrean.main"], cwd=str(ROOT / "backend"), env=env, stdout=fh, stderr=fh,
                         start_new_session=True)
    pid_file.write_text(str(p.pid))
    with open(PIDS_ALL, "a") as f:
        f.write(f"{p.pid} port={port} started={time.strftime('%H:%M:%S')}\n")
    for _ in range(200):
        if healthy(port):
            return p.pid
        if p.poll() is not None:
            raise RuntimeError(f"server on {port} exited with {p.returncode}")
        time.sleep(0.05)
    raise RuntimeError(f"server on {port} did not start")


def ensure_server(port: int = PORT) -> int:
    if healthy(port):
        pid = current_pid()
        return pid or -1
    return start_server(port)


def kill9(pid: int) -> None:
    os.kill(pid, signal.SIGKILL)
    for _ in range(200):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        # reap if it is our child
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass
        time.sleep(0.02)


def stop_server(pid: int) -> None:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(300):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass
        time.sleep(0.05)
    kill9(pid)


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------


def defaults(c: httpx.Client, n: int = 8) -> dict:
    r = c.get("/defaults", params={"agent_count": n})
    r.raise_for_status()
    return r.json()


def create_run(c: httpx.Client, req: dict) -> dict:
    r = c.post("/runs", json=req)
    if r.status_code != 201:
        raise RuntimeError(f"create failed {r.status_code}: {r.text[:2000]}")
    return r.json()


def open_run(c: httpx.Client, run_id: str) -> dict:
    r = c.post(f"/runs/{run_id}/open")
    if r.status_code != 200:
        raise RuntimeError(f"open failed {r.status_code}: {r.text[:500]}")
    return r.json()


def status(c: httpx.Client, run_id: str) -> dict:
    r = c.get(f"/runs/{run_id}/status")
    r.raise_for_status()
    return r.json()


def command(c: httpx.Client, run_id: str, cmd: str) -> httpx.Response:
    return c.post(f"/runs/{run_id}/commands", json={"command": cmd})


IDLE_STATES = ("paused", "error", "finished")


def wait_idle(c: httpx.Client, run_id: str, timeout: float = 300, poll: float = 0.05) -> dict:
    deadline = time.time() + timeout
    st = status(c, run_id)
    while time.time() < deadline:
        st = status(c, run_id)
        if st["state"] in IDLE_STATES and not st.get("active_command"):
            return st
        time.sleep(poll)
    raise TimeoutError(f"run {run_id} not idle after {timeout}s: {st}")


def wait_for(pred: Callable[[], Any], timeout: float = 120, poll: float = 0.03, what: str = "condition") -> Any:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = pred()
        if last:
            return last
        time.sleep(poll)
    raise TimeoutError(f"timeout waiting for {what}; last={last}")


def run_turns(c: httpx.Client, run_id: str, n: int) -> list[dict]:
    out = []
    for _ in range(n):
        r = command(c, run_id, "run_turn")
        assert r.status_code == 200, r.text
        out.append(wait_idle(c, run_id))
    return out


def step_round(c: httpx.Client, run_id: str) -> dict:
    r = command(c, run_id, "step_round")
    assert r.status_code == 200, r.text
    return wait_idle(c, run_id)


def stage(c: httpx.Client, run_id: str, iv: dict) -> httpx.Response:
    return c.post(f"/runs/{run_id}/interventions", json=iv)


# ---------------------------------------------------------------------------
# disk helpers
# ---------------------------------------------------------------------------


def run_dir(run_id: str, worlds: Path = WORLDS) -> Path:
    hits = list(worlds.glob(f"*/runs/{run_id}"))
    assert len(hits) == 1, hits
    return hits[0]


def read_json(p: Path) -> Any:
    return json.loads(Path(p).read_text())


def index_entries(rd: Path) -> list[dict]:
    return [json.loads(line) for line in (rd / "turns" / "index.jsonl").read_text().splitlines() if line.strip()]


def chain_from_manifest(rd: Path) -> list[str]:
    """Follow previous_turn_id from manifest.current_turn_id back to the first turn."""
    man = read_json(rd / "manifest.json")
    chain = []
    tid = man["current_turn_id"]
    seen = set()
    while tid:
        d = rd / "turns" / tid
        if not d.is_dir():
            break
        if tid in seen:
            raise AssertionError(f"cycle at {tid}")
        seen.add(tid)
        chain.append(tid)
        tid = read_json(d / "state.json").get("previous_turn_id")
    return list(reversed(chain))


def committed_events(rd: Path, chain: Optional[list[str]] = None) -> list[dict]:
    chain = chain or chain_from_manifest(rd)
    out = []
    for tid in chain:
        out += read_json(rd / "turns" / tid / "events.json")
    return out


def call_records(rd: Path, chain: Optional[list[str]] = None) -> list[dict]:
    chain = chain or chain_from_manifest(rd)
    out = []
    for tid in chain:
        for f in sorted((rd / "turns" / tid / "model_calls").glob("mc_*.json")):
            out.append(read_json(f))
    return out


def knowledge_refs(rd: Path, turn_id: str) -> Optional[dict]:
    """The turn's ``world.json`` ``knowledge_files`` map ({agent_id: {turn_id, sha256}}), or
    None for a turn written without one (INTERFACES section 5)."""
    return read_json(rd / "turns" / turn_id / "world.json").get("knowledge_files")


def knowledge_file(rd: Path, turn_id: str, agent_id: str) -> Path:
    """Path of the knowledge file that holds ``agent_id``'s store as of ``turn_id``: the
    turn's own file when it has one, else the turn dir the ``knowledge_files`` map names
    (a turn dir holds only the stores that changed since the previous committed turn)."""
    local = rd / "turns" / turn_id / "entities" / "knowledge" / f"{agent_id}.json"
    if local.exists():
        return local
    refs = knowledge_refs(rd, turn_id) or {}
    ref = refs.get(agent_id)
    if ref is None:
        raise FileNotFoundError(f"{turn_id}: no knowledge file and no knowledge_files entry for {agent_id}")
    return rd / "turns" / ref["turn_id"] / "entities" / "knowledge" / f"{agent_id}.json"


def read_knowledge_file(rd: Path, turn_id: str, agent_id: str) -> dict:
    return read_json(knowledge_file(rd, turn_id, agent_id))


def tree_hashes(d: Path) -> dict[str, str]:
    """sha256 of every file under d (relative path -> hex digest)."""
    res = {}
    for p in sorted(d.rglob("*")):
        if p.is_file():
            res[str(p.relative_to(d))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return res


def file_inventory(d: Path) -> dict[str, tuple[int, float]]:
    res = {}
    for p in sorted(d.rglob("*")):
        if p.is_file():
            st = p.stat()
            res[str(p.relative_to(d))] = (st.st_size, st.st_mtime)
    return res


def dir_bytes(d: Path) -> int:
    return sum(p.stat().st_size for p in d.rglob("*") if p.is_file())


def save(name: str, data: Any) -> Path:
    p = OUT / f"{name}.json"
    p.write_text(json.dumps(data, indent=2, default=str))
    return p


class Checks:
    """Collects named pass/fail checks with evidence."""

    def __init__(self, scenario: str):
        self.scenario = scenario
        self.items: list[dict] = []

    def check(self, name: str, ok: bool, evidence: Any = None) -> bool:
        self.items.append({"check": name, "ok": bool(ok), "evidence": evidence})
        mark = "PASS" if ok else "FAIL"
        ev = json.dumps(evidence, default=str)
        if len(ev) > 400:
            ev = ev[:400] + "..."
        print(f"[{mark}] {self.scenario}: {name} :: {ev}", flush=True)
        return bool(ok)

    @property
    def all_ok(self) -> bool:
        return all(i["ok"] for i in self.items)

    def dump(self, extra: Optional[dict] = None) -> Path:
        data = {"scenario": self.scenario, "all_ok": self.all_ok, "checks": self.items}
        if extra:
            data.update(extra)
        return save(self.scenario, data)


def terrain_map(c: httpx.Client, seed: int, world: Optional[dict] = None) -> dict[str, str]:
    body = {"seed": seed}
    if world is not None:
        body["world"] = world
    r = c.post("/world/preview", json=body)
    r.raise_for_status()
    return r.json()["cells"]


def log_offset() -> int:
    return LOG.stat().st_size if LOG.exists() else 0


def log_since(offset: int) -> str:
    with open(LOG, "rb") as f:
        f.seek(offset)
        return f.read().decode(errors="replace")
