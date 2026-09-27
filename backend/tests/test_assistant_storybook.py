"""
WP3 storybook tests (rev 4, amended D7 / R9).  Fake models only: every test runs the narrator
profile on ``fake-assistant`` and replaces ``model.call_model`` with a local scripted fake (so
the tests do not depend on the fake adapter's text mode), and a guard makes any Claude CLI
attempt fail the test.

Covered: listener-driven generation (commit fan-in -> coalescing job), raising and slow commit
handlers never break commits, dedup across the listener and a manual "Write missing", batched
narration with deterministic '## <turn_id>' parsing and a missing section re-queued singly,
the storybook budget pause (and resume after raising the limit), the A-AST-1 default rule
matrix, runs without settings.json staying off, GET never catching up history, the flock
against a second writer, regenerate, continuation openings and the HTTP routes.
"""

from __future__ import annotations

import fcntl
import os
import threading
import time
from typing import Any, Callable, Optional

import pytest

from empyrean import config, model, runner
from empyrean.assistant import digest
from empyrean.assistant.models import AssistantRunSettingsUpdate
from empyrean.assistant.service import AssistantService
from empyrean.assistant.storybook import (
    OPENING_ID,
    StorybookService,
    default_auto,
    parse_batched,
    reset_background_pause,
)
from empyrean.schemas import ContinuationRequest, ModelRequest, ModelResult, ModelUsage

FAKE_KEY = "fake-assistant"


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def storybook_auto_rule(monkeypatch):
    """These tests exercise automatic narration: use the ``auto`` rule (the shipped default is
    ``off``, so narration happens only on request); tests of other modes set their own."""
    monkeypatch.setattr(config, "STORYBOOK_AUTO", "auto")


@pytest.fixture(autouse=True)
def never_live(monkeypatch):
    """Any Claude CLI attempt fails the test (the assistant must never go live in tests)."""

    def boom(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("a live Claude CLI call was attempted in an assistant test")

    monkeypatch.setattr(model.ClaudeCliAdapter, "attempt", boom)
    reset_background_pause()
    digest.clear_cache()
    yield
    reset_background_pause()


class FakeModel:
    """Scripted stand-in for ``model.call_model``: replies with ``metadata['fake_reply']``
    (what the storybook supplies for a fake narrator) unless ``responder`` overrides it."""

    def __init__(self, original: Callable[..., ModelResult]) -> None:
        self.original = original  # agents' decisions (fake-heuristic) still use the real boundary
        self.requests: list[ModelRequest] = []
        self.responder: Optional[Callable[[ModelRequest], Any]] = None
        self.cost: Optional[float] = None
        self.gate: Optional[threading.Event] = None
        self.lock = threading.Lock()

    def __call__(self, request: ModelRequest, registry: Any = None, *, cancel: Any = None) -> ModelResult:
        if request.purpose not in ("assistant", "narrative"):
            return self.original(request, registry, cancel=cancel)
        if self.gate is not None:
            assert self.gate.wait(20), "fake model gate never opened"
        with self.lock:
            self.requests.append(request)
        reply = self.responder(request) if self.responder else request.metadata.get("fake_reply")
        if isinstance(reply, ModelResult):
            return reply
        if isinstance(reply, Exception):
            raise reply
        text = reply if isinstance(reply, str) else ""
        status = "ok" if text.strip() else "malformed"
        return ModelResult(
            request_id=request.request_id,
            ok=False,
            status=status,  # type: ignore[arg-type]
            text=text,
            parsed=None,
            usage=ModelUsage(input_tokens=100, output_tokens=50, billed_input_tokens=100),
            provider="fake",
            model_id=FAKE_KEY,
            response_model=FAKE_KEY,
            provider_cost_usd=self.cost,
            attempts=1,
        )

    def narrator_requests(self) -> list[ModelRequest]:
        with self.lock:
            return [r for r in self.requests if r.purpose == "narrative"]


def turns_in(request: ModelRequest) -> list[str]:
    """The turn ids a narrator request asked for (from its task line)."""
    user = request.messages[-1].content
    task = user.strip().splitlines()[-1]
    if "these turns" in task:
        return [t.strip(" .") for t in task.split(":", 1)[1].split(",")]
    if task.startswith("Write the storybook entry for turn"):
        return [task.rsplit(" ", 1)[1].strip(".")]
    return [OPENING_ID]


@pytest.fixture()
def fake_model(monkeypatch) -> FakeModel:
    fake = FakeModel(model.call_model)
    monkeypatch.setattr(model, "call_model", fake)
    return fake


@pytest.fixture()
def service(manager, registry, worlds_dir, fake_model):
    svc = AssistantService(manager, registry)
    svc.profile_keys = {p: FAKE_KEY for p in svc.profile_keys}
    StorybookService.attach(svc)
    yield svc
    svc.shutdown()


def wait_for(predicate: Callable[[], bool], timeout: float = 20.0, what: str = "condition") -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {what}")


def wait_idle(worker: runner.RunWorker, timeout: float = 30.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = worker.status().state
        if state in ("paused", "error", "finished"):
            return state
        time.sleep(0.01)
    raise AssertionError(f"worker did not settle: {worker.status().state}")


def new_run(manager: runner.RunManager, agent_count: int = 6) -> runner.RunWorker:
    request = config.default_run_request("fake-heuristic", agent_count).model_copy(update={"play_delay_seconds": 0.0})
    return manager.require(manager.create_run(request).run_id)


def play_rounds(worker: runner.RunWorker, rounds: int = 1) -> None:
    for _ in range(rounds):
        worker.submit("step_round")
        assert wait_idle(worker) == "paused"
        assert worker.status().last_error is None


def eligible(run_id: str) -> list[str]:
    return [r.turn_id for r in digest.own_turns(run_id) if r.entry.kind != "init"]


def storybook_idle(svc: AssistantService, run_id: str) -> bool:
    status = svc.storybook.status(run_id)
    return not status.in_flight


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_parse_batched_is_deterministic_and_tolerant() -> None:
    ids = ["r00001_t01_a01", "r00001_t02_a02", "r00001_end"]
    text = (
        "Here are the entries:\n"
        "## r00001_t01_a01\nAster moved north.\n\n"
        "### r00001_t02_a02 - The ambush\nBoreas attacked.\nIt hurt.\n"
        "## r00001_t01_a01\nduplicate section is ignored\n"
        "## unknown_turn\nstray text stays with no section\n"
    )
    out = parse_batched(text, ids)
    assert out == {"r00001_t01_a01": "Aster moved north.", "r00001_t02_a02": "Boreas attacked.\nIt hurt."}
    assert "r00001_end" not in out  # missing -> re-queued singly by the caller
    assert parse_batched("", ids) == {}
    assert parse_batched("## r00001_end\n\n", ids) == {}  # empty section counts as missing


def test_default_auto_rule_matrix(service, monkeypatch, registry) -> None:
    fake_request = config.default_run_request("fake-heuristic", 6)
    live_key = next(k for k in registry.keys() if registry.info(k).provider != "fake" and not registry.info(k).assistant_only)
    mixed_request = fake_request.model_copy(deep=True)
    mixed_request.agents[0].model_key = live_key
    cases = [
        # (STORYBOOK_AUTO, narrator key, request, expected)
        ("auto", FAKE_KEY, fake_request, True),  # a fake narrator never costs money
        ("auto", FAKE_KEY, mixed_request, True),
        ("auto", "claude-cli-haiku-assistant", fake_request, False),  # paid narrator on an all-fake run
        ("auto", "claude-cli-haiku-assistant", mixed_request, True),
        ("on", "claude-cli-haiku-assistant", fake_request, True),
        ("off", FAKE_KEY, mixed_request, False),
    ]
    for mode, narrator, request, expected in cases:
        monkeypatch.setattr(config, "STORYBOOK_AUTO", mode)
        service.profile_keys["narrator"] = narrator
        assert default_auto(service, request) is expected, (mode, narrator, expected)


def test_existing_runs_without_settings_stay_off(manager, registry, worlds_dir, fake_model) -> None:
    worker = new_run(manager)  # created BEFORE the service exists: an "existing" run
    time.sleep(0.01)
    svc = AssistantService(manager, registry)
    svc.profile_keys = {p: FAKE_KEY for p in svc.profile_keys}
    StorybookService.attach(svc)
    try:
        play_rounds(worker, 1)
        time.sleep(0.3)
        wait_for(lambda: storybook_idle(svc, worker.run_id), what="idle storybook")
        status = svc.storybook.status(worker.run_id)
        assert status.auto is False and status.auto_state == "off"
        assert status.entry_count == 0 and status.pending_count == 0
        assert status.missing_count == len(eligible(worker.run_id)) + 1  # + the opening
        assert fake_model.narrator_requests() == []
        assert not svc.paths.run_settings(worker.run_id).exists()
    finally:
        svc.shutdown()


# ---------------------------------------------------------------------------
# Listener-driven generation
# ---------------------------------------------------------------------------


def test_listener_writes_opening_and_every_turn_of_a_new_run(service, manager, fake_model) -> None:
    worker = new_run(manager)
    settings = service.storybook.on_run_created(worker.run_id, None)
    assert settings is not None and settings.storybook_auto is True
    assert settings.auto_since_turn_id == "r00000_init"
    play_rounds(worker, 2)
    ids = eligible(worker.run_id)
    wait_for(lambda: service.storybook.status(worker.run_id).entry_count == len(ids) and storybook_idle(service, worker.run_id), what="all entries")
    view = service.storybook.view(worker.run_id)
    assert view.opening is not None and view.opening.kind == "opening"
    assert [e.turn_id for e in view.entries] == ids  # commit order
    for entry in view.entries:
        d = digest.turn_digest(worker.run_id, entry.turn_id, max_chars=1500)
        assert entry.text == d["text"]  # the fake narrator echoes the digest text
        assert entry.kind == ("round_end" if entry.turn_id.endswith("_end") else "turn")
        assert entry.model_key == FAKE_KEY and entry.digest_sha
        assert entry.regenerated == 0
        if entry.kind == "turn":
            assert entry.entities[0] == d["actor"]["id"]
    status = view.status
    assert status.auto_state == "on" and status.pending_count == 0 and status.missing_count == 0
    # every narrator call was a text-mode call in the run's ledger scope
    requests = fake_model.narrator_requests()
    assert requests and all(r.response_format == "text" and r.response_schema is None for r in requests)
    lines = service.ledger.lines(worker.run_id)
    assert lines and all(line.profile == "narrator" and line.scope == worker.run_id for line in lines)
    narrated = [t for r in requests for t in turns_in(r)]
    assert sorted(narrated) == sorted(ids + [OPENING_ID])  # each exactly once


def test_a_new_run_without_on_run_created_stays_off(service, manager, fake_model) -> None:
    worker = new_run(manager)  # created after the service started, but nobody called on_run_created
    play_rounds(worker, 1)
    time.sleep(0.2)
    wait_for(lambda: storybook_idle(service, worker.run_id), what="idle")
    assert not service.paths.run_settings(worker.run_id).exists()
    assert service.storybook.status(worker.run_id).auto is False
    assert fake_model.narrator_requests() == []
    # the run-creation hook of the service (briefs) initialises it like a new run
    service.notify_run_created(worker.run_id, config.default_run_request("fake-heuristic", 6))
    assert service.storybook.status(worker.run_id).auto is True
    wait_for(lambda: service.storybook.read_entry(worker.run_id, OPENING_ID) is not None and storybook_idle(service, worker.run_id), what="opening")


def test_every_narrator_turn_call_carries_the_cast_map(service, manager, fake_model) -> None:
    worker = new_run(manager, agent_count=6)
    service.storybook.on_run_created(worker.run_id, None)
    play_rounds(worker, 1)
    ids = eligible(worker.run_id)
    wait_for(lambda: service.storybook.status(worker.run_id).entry_count == len(ids) and storybook_idle(service, worker.run_id), what="entries")
    turn_calls = [r for r in fake_model.narrator_requests() if turns_in(r) != [OPENING_ID]]
    assert turn_calls
    names = [c["name"] for c in digest.cast_map(worker.run_id)]
    for request in turn_calls:
        user = request.messages[-1].content
        line = next(ln for ln in user.splitlines() if ln.startswith("Cast (every agent: id, name, alive after turn "))
        assert turns_in(request)[-1] in line and all(f'"name":"{n}"' in line for n in names) and '"alive":true' in line
    assert "never make up a name" in fake_model.narrator_requests()[0].messages[0].content


def test_backlog_is_batched_per_round(service, manager, fake_model) -> None:
    worker = new_run(manager, agent_count=6)
    service.storybook.on_run_created(worker.run_id, None)
    fake_model.gate = threading.Event()  # the narrator is slow: the backlog builds up
    play_rounds(worker, 2)
    fake_model.gate.set()
    ids = eligible(worker.run_id)
    wait_for(lambda: service.storybook.status(worker.run_id).entry_count == len(ids) and storybook_idle(service, worker.run_id), what="batched entries")
    batched = [r for r in fake_model.narrator_requests() if len(turns_in(r)) > 1]
    assert batched, "a backlog > 2 must be narrated in batched calls"
    for request in batched:
        asked = turns_in(request)
        assert len(asked) <= config.STORYBOOK_BATCH_MAX
        assert request.max_output_tokens == config.ASSISTANT_OUTPUT_TOKENS["narrator_batched"]
        ends = [i for i, t in enumerate(asked) if t.endswith("_end")]
        assert all(i == len(asked) - 1 for i in ends)  # a batch never runs past a round end
    batch_ids = {service.storybook.read_entry(worker.run_id, t).batch_id for t in turns_in(batched[0])}
    assert len(batch_ids) == 1 and None not in batch_ids


def test_raising_and_slow_handlers_never_break_commits(service, manager, fake_model) -> None:
    calls: list[str] = []

    def raising(run_id: str, turn_id: str, kind: str, round_no: int) -> None:
        raise RuntimeError("listener bug")

    def slow(run_id: str, turn_id: str, kind: str, round_no: int) -> None:
        time.sleep(0.05)
        calls.append(turn_id)

    service.add_commit_handler(raising)
    service.add_commit_handler(slow)
    fake_model.responder = lambda request: ValueError("narrator exploded")  # the storybook job fails too
    worker = new_run(manager)
    service.storybook.on_run_created(worker.run_id, None)
    play_rounds(worker, 1)
    committed = [e.turn_id for e in manager.list_turns(worker.run_id)][1:]
    assert calls == committed
    assert worker.status().state == "paused" and worker.status().last_error is None
    wait_for(lambda: storybook_idle(service, worker.run_id), what="idle after failures")
    status = service.storybook.status(worker.run_id)
    assert status.last_error and "narrator exploded" in status.last_error
    assert status.entry_count == 0


def test_dedup_between_listener_and_manual_generate(service, manager, fake_model) -> None:
    worker = new_run(manager)
    service.storybook.on_run_created(worker.run_id, None)
    fake_model.gate = threading.Event()
    play_rounds(worker, 1)
    # while the auto job is blocked in its first call, the user presses "Write missing" twice
    first = service.storybook.enqueue(worker.run_id, None)
    second = service.storybook.enqueue(worker.run_id, None)
    assert first.job_id is not None and second.job_id == first.job_id  # one coalescing job per run
    fake_model.gate.set()
    ids = eligible(worker.run_id)
    wait_for(lambda: service.storybook.status(worker.run_id).entry_count == len(ids) and storybook_idle(service, worker.run_id), what="entries")
    narrated = [t for r in fake_model.narrator_requests() for t in turns_in(r)]
    assert sorted(narrated) == sorted(ids + [OPENING_ID])
    assert all(service.storybook.read_entry(worker.run_id, t).regenerated == 0 for t in ids)


def test_batch_with_missing_section_is_requeued_singly(service, manager, fake_model) -> None:
    worker = new_run(manager)  # lazy init would switch auto on: switch it off first
    service.storybook.update_settings(worker.run_id, AssistantRunSettingsUpdate(storybook_auto=False))
    play_rounds(worker, 1)
    ids = eligible(worker.run_id)
    dropped = ids[2]

    def drop_one_section(request: ModelRequest) -> str:
        reply = request.metadata["fake_reply"]
        if len(turns_in(request)) > 1:
            sections = reply.split("\n\n## ")
            kept = [s for s in sections if not s.lstrip("# ").startswith(dropped)]
            return "\n\n## ".join(kept)
        return reply

    fake_model.responder = drop_one_section
    response = service.storybook.enqueue(worker.run_id, None, include_opening=False)
    assert response.queued == len(ids)
    wait_for(lambda: service.storybook.status(worker.run_id).entry_count == len(ids) and storybook_idle(service, worker.run_id), what="all entries")
    asked = [turns_in(r) for r in fake_model.narrator_requests()]
    assert len(asked[0]) > 1 and dropped in asked[0]
    assert [dropped] in asked[1:], "the missing section must be re-queued as a single call"
    assert service.storybook.read_entry(worker.run_id, dropped).batch_id is None
    assert service.storybook.read_entry(worker.run_id, OPENING_ID) is None  # include_opening=False


def test_budget_pause_and_resume(service, manager, fake_model) -> None:
    fake_model.cost = 0.04  # 0.08 after two calls (opening + one turn); 0.08 + 0.05 estimate > 0.10 -> paused
    worker = new_run(manager)
    service.storybook.update_settings(worker.run_id, AssistantRunSettingsUpdate(storybook_budget_usd=0.1))
    settings = service.storybook.update_settings(worker.run_id, AssistantRunSettingsUpdate(storybook_auto=True))
    assert settings.auto_since_turn_id == "r00000_init"  # switched on before the first commit
    service.storybook.enqueue(worker.run_id, [], include_opening=True)
    play_rounds(worker, 1)
    wait_for(lambda: storybook_idle(service, worker.run_id) and len(fake_model.narrator_requests()) >= 2, what="budget stop")
    time.sleep(0.2)
    status = service.storybook.status(worker.run_id)
    assert len(fake_model.narrator_requests()) == 2
    assert status.auto_state == "paused_budget"
    assert status.notice and "budget" in status.notice
    assert status.spend.spent_usd == pytest.approx(0.08)
    assert status.pending_count > 0
    # the chat budget is not touched by narration
    assert service.ledger.spent(worker.run_id, "chat") == 0
    # raising the limit continues the pending auto turns (no catch-up of anything else)
    service.storybook.update_settings(worker.run_id, AssistantRunSettingsUpdate(storybook_budget_usd=5.0))
    ids = eligible(worker.run_id)
    wait_for(lambda: service.storybook.status(worker.run_id).entry_count == len(ids) and storybook_idle(service, worker.run_id), what="resume after raise")
    assert service.storybook.status(worker.run_id).auto_state == "on"


def test_switching_auto_on_later_never_catches_up_history(service, manager, fake_model) -> None:
    worker = new_run(manager)
    service.storybook.update_settings(worker.run_id, AssistantRunSettingsUpdate(storybook_auto=False))
    play_rounds(worker, 1)
    history = eligible(worker.run_id)
    settings = service.storybook.update_settings(worker.run_id, AssistantRunSettingsUpdate(storybook_auto=True))
    assert settings.auto_since_turn_id == history[-1]
    play_rounds(worker, 1)
    new_turns = [t for t in eligible(worker.run_id) if t not in history]
    wait_for(lambda: service.storybook.status(worker.run_id).entry_count == len(new_turns) and storybook_idle(service, worker.run_id), what="new entries")
    status = service.storybook.status(worker.run_id)
    assert status.missing_count == len(history) + 1  # + the opening (not written by late auto)
    narrated = [t for r in fake_model.narrator_requests() for t in turns_in(r)]
    assert sorted(narrated) == sorted(new_turns)


def test_second_process_lock_blocks_writing(service, manager, fake_model) -> None:
    worker = new_run(manager)
    service.storybook.update_settings(worker.run_id, AssistantRunSettingsUpdate(storybook_auto=False))
    play_rounds(worker, 1)
    wait_for(lambda: storybook_idle(service, worker.run_id), what="commit wakes to settle")
    path = service.paths.storybook_lock(worker.run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # "another process" holds the storybook
        service.storybook.enqueue(worker.run_id, None)
        wait_for(lambda: storybook_idle(service, worker.run_id), what="blocked job end")
        status = service.storybook.status(worker.run_id)
        assert status.notice and "Another process" in status.notice
        assert status.entry_count == 0 and fake_model.narrator_requests() == []
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
    service.storybook.enqueue(worker.run_id, None)
    wait_for(lambda: service.storybook.status(worker.run_id).entry_count == len(eligible(worker.run_id)) and storybook_idle(service, worker.run_id), what="entries after unlock")


def test_regenerate_rewrites_one_entry(service, manager, fake_model) -> None:
    worker = new_run(manager)
    service.storybook.on_run_created(worker.run_id, None)
    play_rounds(worker, 1)
    ids = eligible(worker.run_id)
    wait_for(lambda: service.storybook.status(worker.run_id).entry_count == len(ids) and storybook_idle(service, worker.run_id), what="entries")
    before = len(fake_model.narrator_requests())
    fake_model.responder = lambda request: "A new telling."
    service.storybook.regenerate(worker.run_id, ids[0])
    wait_for(lambda: service.storybook.read_entry(worker.run_id, ids[0]).regenerated == 1 and storybook_idle(service, worker.run_id), what="regenerated")
    assert service.storybook.read_entry(worker.run_id, ids[0]).text == "A new telling."
    assert len(fake_model.narrator_requests()) == before + 1
    with pytest.raises(ValueError):
        service.storybook.regenerate(worker.run_id, "r00099_t01_a01")


def test_continuation_opening_recalls_the_parent(service, manager, fake_model) -> None:
    parent = new_run(manager)
    service.storybook.on_run_created(parent.run_id, None)
    play_rounds(parent, 1)
    ids = eligible(parent.run_id)
    wait_for(lambda: service.storybook.status(parent.run_id).entry_count == len(ids) and storybook_idle(service, parent.run_id), what="parent entries")
    fork = ids[3]
    child = manager.create_continuation(parent.run_id, ContinuationRequest(from_turn_id=fork, name="Branch"))
    previously = service.storybook.continuation_opening(child.run_id)
    assert previously is not None and previously.startswith("Previously, in")
    assert service.storybook.read_entry(parent.run_id, fork).text in previously
    assert service.storybook.read_entry(parent.run_id, ids[4]).text not in previously  # after the fork
    service.storybook.on_run_created(child.run_id, None)
    wait_for(lambda: service.storybook.read_entry(child.run_id, OPENING_ID) is not None and storybook_idle(service, child.run_id), what="child opening")
    opening = service.storybook.read_entry(child.run_id, OPENING_ID)
    assert opening.text.startswith("Previously, in")
    # the child's own turns exclude the copied fork turn
    assert fork not in eligible(child.run_id)
    assert service.storybook.continuation_opening(parent.run_id) is None


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------


def test_routes_get_is_read_only_and_generate_writes(manager, registry, worlds_dir, fake_model) -> None:
    from fastapi.testclient import TestClient

    from empyrean.api import create_app

    worker = new_run(manager)
    play_rounds(worker, 1)  # history made before the assistant existed
    svc = AssistantService(manager, registry)
    svc.profile_keys = {p: FAKE_KEY for p in svc.profile_keys}
    app = create_app(manager, svc)
    assert isinstance(svc.storybook, StorybookService)  # attached by the router
    ids = eligible(worker.run_id)
    with TestClient(app) as client:
        body = client.get(f"/api/runs/{worker.run_id}/assistant/storybook").json()
        assert body["entries"] == [] and body["opening"] is None
        status = body["status"]
        assert status["auto"] is False and status["missing_count"] == len(ids) + 1
        assert status["estimate"]["entries"] == len(ids) + 1 and status["estimate"]["model_key"] == FAKE_KEY
        time.sleep(0.2)
        assert fake_model.narrator_requests() == []  # GET never catches up
        assert not svc.paths.storybook_entries_dir(worker.run_id).exists()

        r = client.post(f"/api/runs/{worker.run_id}/assistant/storybook/generate", json={})
        assert r.status_code == 202 and r.json()["queued"] == len(ids) + 1 and r.json()["job_id"]
        wait_for(lambda: len(client.get(f"/api/runs/{worker.run_id}/assistant/storybook").json()["entries"]) == len(ids), what="entries via API")
        wait_for(lambda: not client.get(f"/api/runs/{worker.run_id}/assistant/storybook").json()["status"]["in_flight"], what="idle")
        body = client.get(f"/api/runs/{worker.run_id}/assistant/storybook?last_n=2").json()
        assert [e["turn_id"] for e in body["entries"]] == ids[-2:] and body["opening"]["kind"] == "opening"

        r = client.post(f"/api/runs/{worker.run_id}/assistant/storybook/entries/{ids[1]}/regenerate")
        assert r.status_code == 202
        r = client.post(f"/api/runs/{worker.run_id}/assistant/storybook/entries/r00077_t01_a01/regenerate")
        assert r.status_code == 422 and r.json()["error"] == "validation_error"
        r = client.post(f"/api/runs/{worker.run_id}/assistant/storybook/generate", json={"turn_ids": ["nope"]})
        assert r.status_code == 422
        assert client.get("/api/runs/run_20990101_000000_ffff/assistant/storybook").status_code == 404


def test_real_fake_assistant_adapter_path_when_available(manager, registry, worlds_dir) -> None:
    """End to end through model.call_model with the fake-assistant ref (skipped until the
    model boundary's fake-assistant text mode is in place)."""
    probe = model.call_model(
        ModelRequest(request_id="probe_01", model_key=FAKE_KEY, messages=[{"role": "user", "content": "x"}], response_format="text", metadata={"fake_reply": "hello"}),
        registry,
    )
    if probe.status != "ok" or (probe.text or "") != "hello":
        pytest.skip(f"fake-assistant text mode not available yet ({probe.status}: {probe.error})")
    svc = AssistantService(manager, registry)
    svc.profile_keys = {p: FAKE_KEY for p in svc.profile_keys}
    StorybookService.attach(svc)
    try:
        worker = new_run(manager)
        svc.storybook.on_run_created(worker.run_id, None)
        play_rounds(worker, 1)
        ids = eligible(worker.run_id)
        wait_for(lambda: svc.storybook.status(worker.run_id).entry_count == len(ids) and storybook_idle(svc, worker.run_id), what="entries")
        assert svc.storybook.read_entry(worker.run_id, OPENING_ID) is not None
    finally:
        svc.shutdown()
