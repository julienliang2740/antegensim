"""
WP3 Story Mode tests (rev 4, amended D8 / R10).  Fake models only: the author and summarizer
profiles run on ``fake-assistant`` and ``model.call_model`` is replaced by a local scripted fake
for assistant requests (agents' decisions still go through the real fake adapters); a guard
fails the test on any Claude CLI attempt.

Covered: the deterministic step-0 run card (no model call), the interview (ask, then a brief
with both per-turn and per-round estimates and a job budget; one repair call for invalid
output), Change supersedes a pending brief, reject, approve -> lazy chapters 3 ahead of the
reader, quiet-turn interludes and the follow POV, generate-all progress and cancel, the
every-5-chapters summarizer refresh, the job budget pause, continue past the pinned end turn,
restart recovery, Markdown export, the story queue position and the HTTP routes.
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any, Callable, Optional

import pytest

from empyrean import config, model, runner, storage
from empyrean.api import ApiException
from empyrean.assistant import digest, story as story_mod
from empyrean.assistant.models import (
    JobView,
    StoryApproveRequest,
    StoryContinueRequest,
    StoryCreateRequest,
    StoryMessageRequest,
    StoryQuickPicks,
)
from empyrean.assistant.service import AssistantService
from empyrean.assistant.story import StoryService, parse_summary, split_title
from empyrean.assistant.storybook import reset_background_pause
from empyrean.schemas import ModelRequest, ModelResult, ModelUsage

FAKE_KEY = "fake-assistant"


@pytest.fixture(autouse=True)
def never_live(monkeypatch):
    def boom(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("a live Claude CLI call was attempted in an assistant test")

    monkeypatch.setattr(model.ClaudeCliAdapter, "attempt", boom)
    monkeypatch.setattr(config, "STORYBOOK_AUTO", "off")  # no narrator traffic from the storybook in these tests
    reset_background_pause()
    digest.clear_cache()
    yield
    reset_background_pause()


def role_of(request: ModelRequest) -> str:
    system = request.messages[0].content
    if system == story_mod.AUTHOR_INTERVIEW_SYSTEM:
        return "interview"
    if system == story_mod.AUTHOR_CHAPTER_SYSTEM:
        return "chapter"
    if system == story_mod.SUMMARIZER_SYSTEM:
        return "summary"
    return "other"


class FakeModel:
    """Scripted ``model.call_model`` for assistant requests: ``metadata['fake_reply']`` (a str
    for text mode, a dict for JSON) unless ``responders[role]`` overrides it."""

    def __init__(self, original: Callable[..., ModelResult]) -> None:
        self.original = original
        self.requests: list[ModelRequest] = []
        self.responders: dict[str, Callable[[ModelRequest], Any]] = {}
        self.cost: Optional[float] = None
        self.gate: Optional[threading.Event] = None
        self.lock = threading.Lock()

    def __call__(self, request: ModelRequest, registry: Any = None, *, cancel: Any = None) -> ModelResult:
        if request.purpose not in ("assistant", "narrative"):
            return self.original(request, registry, cancel=cancel)
        role = role_of(request)
        if self.gate is not None and role == "chapter":
            while not self.gate.wait(0.05):
                if cancel is not None and cancel.is_set():
                    return ModelResult(request_id=request.request_id, ok=False, status="error", provider="fake", model_id=FAKE_KEY, error="cancelled", error_code="cancelled")
        with self.lock:
            self.requests.append(request)
        responder = self.responders.get(role)
        reply = responder(request) if responder else request.metadata.get("fake_reply")
        if isinstance(reply, dict):
            text, parsed, status = json.dumps(reply), reply, "ok"
        else:
            text, parsed = (reply or ""), None
            status = "ok" if text.strip() else "malformed"
        return ModelResult(
            request_id=request.request_id,
            ok=parsed is not None,
            status=status,  # type: ignore[arg-type]
            text=text,
            parsed=parsed,
            usage=ModelUsage(input_tokens=200, output_tokens=100, billed_input_tokens=200),
            provider="fake",
            model_id=FAKE_KEY,
            response_model=FAKE_KEY,
            provider_cost_usd=self.cost,
            attempts=1,
        )

    def of(self, role: str) -> list[ModelRequest]:
        with self.lock:
            return [r for r in self.requests if role_of(r) == role]


@pytest.fixture()
def fake_model(monkeypatch) -> FakeModel:
    fake = FakeModel(model.call_model)
    monkeypatch.setattr(model, "call_model", fake)
    return fake


def make_service(manager, registry) -> AssistantService:
    svc = AssistantService(manager, registry)
    svc.profile_keys = {p: FAKE_KEY for p in svc.profile_keys}
    StoryService.attach(svc)
    return svc


@pytest.fixture()
def service(manager, registry, worlds_dir, fake_model):
    svc = make_service(manager, registry)
    yield svc
    svc.shutdown()


def wait_for(predicate: Callable[[], bool], timeout: float = 20.0, what: str = "condition") -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {what}")


def wait_idle(worker: runner.RunWorker, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if worker.status().state in ("paused", "error", "finished"):
            return
        time.sleep(0.01)
    raise AssertionError("worker did not settle")


def played_run(manager, rounds: int = 1, agent_count: int = 6) -> runner.RunWorker:
    request = config.default_run_request("fake-heuristic", agent_count).model_copy(update={"play_delay_seconds": 0.0})
    worker = manager.require(manager.create_run(request).run_id)
    for _ in range(rounds):
        worker.submit("step_round")
        wait_idle(worker)
    return worker


def story_idle(svc: AssistantService, story_id: str) -> bool:
    return not svc.story._busy(story_id)


def brief_ready(svc: AssistantService, run_id: str, story_id: str):
    wait_for(lambda: story_idle(svc, story_id), what="author idle")
    return svc.story.get(run_id, story_id)


def approved_story(svc: AssistantService, run_id: str, **approve: Any):
    view = svc.story.create(run_id, StoryCreateRequest(text="Tell it as a chronicle."))
    story_id = view.session.story_id
    view = brief_ready(svc, run_id, story_id)
    assert view.session.status == "brief_pending", view.session
    request = StoryApproveRequest(brief_id=view.session.brief.brief_id, **approve)
    return svc.story.approve(run_id, story_id, request)


def done_numbers(svc: AssistantService, run_id: str, story_id: str) -> list[int]:
    return [c.number for c in svc.story.get(run_id, story_id).chapters]


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_split_title_and_parse_summary() -> None:
    assert split_title("# The Ambush\n\nBoreas fell.", "fallback") == ("The Ambush", "Boreas fell.")
    assert split_title("No heading here.", "Round 1") == ("Round 1", "No heading here.")
    so_far, cast = parse_summary("## Story so far\nThey met.\n\n## Cast\n- Aster (a01): scout")
    assert so_far == "They met." and cast == "- Aster (a01): scout"
    assert parse_summary("just prose") == ("just prose", "")


# ---------------------------------------------------------------------------
# Step 0 and the interview
# ---------------------------------------------------------------------------


def test_step0_card_is_deterministic_and_calls_no_model(service, manager, fake_model) -> None:
    worker = played_run(manager, 2)
    view = service.story.create(worker.run_id, None)
    card = view.run_card
    assert card is not None and card.run_id == worker.run_id and len(card.cast) == 6
    assert card.rounds == 2 and card.turns == len([t for t in manager.list_turns(worker.run_id) if t.kind == "agent_turn"])
    assert card.suggested == StoryQuickPicks()
    assert view.session.status == "interviewing" and view.session.messages == [] and view.job is None
    time.sleep(0.1)
    assert fake_model.requests == []
    assert service.paths.story_file(worker.run_id, view.session.story_id).is_file()
    assert [s.story_id for s in service.story.list(worker.run_id)] == [view.session.story_id]
    with pytest.raises(ApiException) as err:
        service.story.create(worker.run_id, StoryCreateRequest(picks=StoryQuickPicks(pov="follow", follow_agent_id="zz")))
    assert err.value.status_code == 422


def test_interview_ask_then_brief_with_both_estimates(service, manager, fake_model) -> None:
    worker = played_run(manager, 2)
    fake_model.responders["interview"] = lambda r: {"kind": "ask", "text": "Whose side are we on?", "options": ["Aster", "Nobody"]}
    view = service.story.create(worker.run_id, StoryCreateRequest(text="Make it dramatic.", picks=StoryQuickPicks(genre="saga")))
    sid = view.session.story_id
    view = brief_ready(service, worker.run_id, sid)
    assert view.session.status == "interviewing"
    ask = view.session.messages[-1]
    assert ask.role == "assistant" and ask.text == "Whose side are we on?" and ask.ask_options == ["Aster", "Nobody"]
    request = fake_model.of("interview")[0]
    assert request.response_format == "json" and request.response_schema == story_mod.INTERVIEW_SCHEMA
    assert "Make it dramatic." in request.messages[1].content and '"genre":"saga"' in request.messages[1].content
    del fake_model.responders["interview"]  # now the default fake brief
    service.story.message(worker.run_id, sid, StoryMessageRequest(text="Nobody. Just write it."))
    view = brief_ready(service, worker.run_id, sid)
    brief = view.session.brief
    assert view.session.status == "brief_pending" and brief is not None and brief.status == "pending"
    eligible = [r for r in digest.own_turns(worker.run_id) if r.entry.kind != "init"]
    assert brief.estimate_turn.unit == "turn" and brief.estimate_turn.chapters == len(eligible) + 1  # + opening
    assert brief.estimate_round.unit == "round" and brief.estimate_round.chapters == 2 + 1
    assert brief.chapter_plan[0].kind == "opening" and len(brief.chapter_plan) == len(eligible) + 1
    assert brief.job_budget_usd >= config.ASSISTANT_STORY_BUDGET_USD
    assert brief.cast_map and brief.in_reply_to == view.session.messages[-2].message_id
    assert view.session.messages[-1].brief_id == brief.brief_id


def test_invalid_author_reply_gets_one_repair_call(service, manager, fake_model) -> None:
    worker = played_run(manager, 1)
    replies = iter([{"kind": "brief", "brief": {"title": ""}}, None])

    def first_bad(request: ModelRequest) -> Any:
        value = next(replies)
        return value if value is not None else request.metadata["fake_reply"]

    fake_model.responders["interview"] = first_bad
    view = service.story.create(worker.run_id, StoryCreateRequest(text="go"))
    view = brief_ready(service, worker.run_id, view.session.story_id)
    assert view.session.status == "brief_pending"
    calls = fake_model.of("interview")
    assert len(calls) == 2 and "previous reply was invalid" in calls[1].messages[1].content


def test_change_supersedes_and_reject_returns_to_interview(service, manager, fake_model) -> None:
    worker = played_run(manager, 1)
    view = service.story.create(worker.run_id, StoryCreateRequest(text="go"))
    sid = view.session.story_id
    first = brief_ready(service, worker.run_id, sid).session.brief
    service.story.message(worker.run_id, sid, StoryMessageRequest(text="Darker, please.", picks=StoryQuickPicks(tone="grim")))
    view = brief_ready(service, worker.run_id, sid)
    assert view.session.superseded_briefs[0].brief_id == first.brief_id
    assert view.session.superseded_briefs[0].status == "superseded"
    assert view.session.brief.brief_id != first.brief_id and view.session.picks.tone == "grim"
    with pytest.raises(ApiException) as err:
        service.story.approve(worker.run_id, sid, StoryApproveRequest(brief_id=first.brief_id))
    assert err.value.error == "brief_not_pending"
    view = service.story.reject(worker.run_id, sid, "not yet")
    assert view.session.status == "interviewing" and view.session.brief is None
    assert view.session.superseded_briefs[-1].status == "rejected"


# ---------------------------------------------------------------------------
# Chapters
# ---------------------------------------------------------------------------


def test_approve_writes_lazily_three_ahead_of_the_reader(service, manager, fake_model) -> None:
    worker = played_run(manager, 2)
    view = approved_story(service, worker.run_id)
    sid = view.session.story_id
    assert view.session.status == "generating" and view.session.chapters_total > 6
    wait_for(lambda: story_idle(service, sid), what="lazy chapters")
    assert done_numbers(service, worker.run_id, sid) == [1, 2, 3]
    requests = fake_model.of("chapter")
    assert len(requests) == 3 and all(r.response_format == "text" and r.response_schema is None for r in requests)
    assert all(r.max_output_tokens == config.ASSISTANT_OUTPUT_TOKENS["chapter"] for r in requests)
    first = service.story.chapter(worker.run_id, sid, 1)
    assert first.kind == "opening" and first.title == "Opening" and first.status == "done" and first.text
    wait_for(lambda: story_idle(service, sid), what="lookahead after reading 1")
    assert done_numbers(service, worker.run_id, sid) == [1, 2, 3, 4]
    placeholder = service.story.chapter(worker.run_id, sid, 9, mark_read=False)
    assert placeholder.status == "pending" and placeholder.turn_ids
    service.story.chapter(worker.run_id, sid, 5)
    wait_for(lambda: story_idle(service, sid), what="lookahead after reading 5")
    assert done_numbers(service, worker.run_id, sid) == list(range(1, 9))
    session = service.story.get(worker.run_id, sid).session
    assert session.reader_position == 5 and session.chapters_done == 8
    # the chapter text is faithful to the digest (the fake author echoes the records)
    plan = session.brief.chapter_plan[3]
    chapter = service.story.chapter(worker.run_id, sid, 4, mark_read=False)
    assert chapter.turn_ids == plan.turn_ids
    assert digest.turn_digest(worker.run_id, plan.turn_ids[0], max_chars=1500)["text"] in chapter.text
    with pytest.raises(storage.StorageError):
        service.story.chapter(worker.run_id, sid, 999)


def test_quiet_turns_become_interludes_and_follow_pov_keeps_chapters(service, manager, fake_model) -> None:
    worker = played_run(manager, 2)
    picks = StoryQuickPicks(pov="follow", follow_agent_id="a01")
    plan = service.story.build_plan(worker.run_id, picks, "turn")
    for entry in plan[1:]:
        ref = next(r for r in digest.own_turns(worker.run_id) if r.turn_id == entry.turn_ids[0])
        if ref.entry.acting_agent_id == "a01":
            assert entry.kind == "chapter"
        elif digest.quiet_turn(ref):
            assert entry.kind == "interlude"
        else:
            assert entry.kind == "chapter"
    chronicler = service.story.build_plan(worker.run_id, StoryQuickPicks(), "turn")
    assert any(p.kind == "interlude" for p in chronicler)  # fake-heuristic runs have quiet turns
    rounds = service.story.build_plan(worker.run_id, StoryQuickPicks(), "round")
    assert [p.title for p in rounds] == ["Opening", "Round 1", "Round 2"]
    estimate_turn = service.story.estimate(chronicler, "turn")
    assert estimate_turn.cost_usd == 0.0  # fake author: free
    service.profile_keys["author"] = "claude-cli-sonnet-assistant"
    paid = service.story.estimate(chronicler, "turn")
    per_round = service.story.estimate(rounds, "round")
    assert paid.cost_usd > per_round.cost_usd > 0 and paid.seconds > per_round.seconds


def test_generate_all_progress_cancel_and_continue(service, manager, fake_model) -> None:
    worker = played_run(manager, 2)
    fake_model.gate = threading.Event()
    view = approved_story(service, worker.run_id, generate_all=True)
    sid = view.session.story_id
    total = view.session.chapters_total
    wait_for(lambda: (service.story.get(worker.run_id, sid).job or JobView(job_id="x", kind="story")).progress.startswith("writing chapter 1 of"), what="job progress")
    job = service.story.get(worker.run_id, sid).job
    assert job.kind == "story" and job.status == "running" and job.progress.startswith("writing chapter 1 of")
    view = service.story.cancel(worker.run_id, sid)
    assert view.session.status == "cancelled"
    wait_for(lambda: story_idle(service, sid), what="cancel lands")
    assert service.get_job(job.job_id).status == "cancelled"
    assert done_numbers(service, worker.run_id, sid) == []
    # reading does not resume a cancelled story; continue does (and generate_all finishes it)
    service.story.chapter(worker.run_id, sid, 1)
    time.sleep(0.1)
    assert story_idle(service, sid)
    fake_model.gate.set()
    service.story.generate_all(worker.run_id, sid)
    wait_for(lambda: service.story.get(worker.run_id, sid).session.status == "complete", what="complete")
    assert done_numbers(service, worker.run_id, sid) == list(range(1, total + 1))
    assert service.story.get(worker.run_id, sid).session.chapters_done == total


def test_summarizer_refreshes_every_five_chapters(service, manager, fake_model) -> None:
    worker = played_run(manager, 2)
    view = approved_story(service, worker.run_id, generate_all=True)
    sid = view.session.story_id
    wait_for(lambda: service.story.get(worker.run_id, sid).session.status == "complete", what="complete")
    total = view.session.chapters_total
    summaries = fake_model.of("summary")
    assert len(summaries) == total // story_mod.SUMMARY_EVERY
    assert all(r.response_format == "text" for r in summaries)
    session = service.story.get(worker.run_id, sid).session
    assert session.story_so_far and session.cast_sheet.startswith("- ")
    chapters = fake_model.of("chapter")
    assert "Story so far: (the story begins)" in chapters[0].messages[1].content
    assert "Story so far: <data" in chapters[story_mod.SUMMARY_EVERY].messages[1].content  # chapter 6 uses the refresh


def test_job_budget_pauses_and_a_raise_resumes(service, manager, fake_model) -> None:
    worker = played_run(manager, 1)
    fake_model.cost = 0.1
    view = approved_story(service, worker.run_id, generate_all=True, job_budget_usd=0.35)
    sid = view.session.story_id
    wait_for(lambda: service.story.get(worker.run_id, sid).session.status == "paused", what="budget pause")
    session = service.story.get(worker.run_id, sid).session
    assert "budget" in (session.error or "")
    assert session.spent_usd <= 0.35 + 1e-9
    written = len(done_numbers(service, worker.run_id, sid))
    assert 0 < written < session.chapters_total
    # the story's spend is in the run's ledger with the story id
    lines = [l for l in service.ledger.lines(worker.run_id) if l.story_id == sid]
    assert sum(l.cost_usd for l in lines) == pytest.approx(session.spent_usd)
    service.story.continue_story(worker.run_id, sid, None, job_budget_usd=50.0)
    wait_for(lambda: service.story.get(worker.run_id, sid).session.status == "complete", what="complete after raise")


def test_continue_extends_a_pinned_story_over_a_running_run(service, manager, fake_model) -> None:
    worker = played_run(manager, 1)
    view = approved_story(service, worker.run_id, generate_all=True)
    sid = view.session.story_id
    end = view.session.end_turn_id
    total = view.session.chapters_total
    assert end == manager.list_turns(worker.run_id)[-1].turn_id
    wait_for(lambda: service.story.get(worker.run_id, sid).session.status == "complete", what="complete")
    worker.submit("step_round")
    wait_idle(worker)
    view = service.story.continue_story(worker.run_id, sid, StoryContinueRequest())
    assert view.session.end_turn_id == manager.list_turns(worker.run_id)[-1].turn_id
    assert view.session.chapters_total > total
    new = view.session.brief.chapter_plan[total:]
    assert new[0].number == total + 1 and new[0].turn_ids[0].startswith("r00002_")
    wait_for(lambda: service.story.get(worker.run_id, sid).session.status == "complete", what="complete again")
    assert done_numbers(service, worker.run_id, sid) == list(range(1, view.session.chapters_total + 1))


def test_restart_recovery_resumes_from_the_first_missing_chapter(manager, registry, worlds_dir, fake_model) -> None:
    svc = make_service(manager, registry)
    worker = played_run(manager, 1)
    try:
        view = approved_story(svc, worker.run_id)
        sid = view.session.story_id
        wait_for(lambda: story_idle(svc, sid), what="first chapters")
        assert done_numbers(svc, worker.run_id, sid) == [1, 2, 3]
    finally:
        svc.shutdown()
    # simulate a crash while generating: status stays "generating", chapter 4 half-written
    path = svc.paths.story_file(worker.run_id, sid)
    data = json.loads(path.read_text())
    data["status"] = "generating"
    data["reader_position"] = 3
    path.write_text(json.dumps(data))
    chapter4 = svc.paths.chapter_file(worker.run_id, sid, 4)
    chapter4.write_text(json.dumps({"number": 4, "status": "running"}))
    svc2 = make_service(manager, registry)  # attach runs resume_interrupted
    try:
        session = svc2.story.get(worker.run_id, sid).session
        assert session.status == "interrupted" and "restart" in (session.error or "")
        assert not chapter4.exists()
        svc2.story.chapter(worker.run_id, sid, 3)  # reading resumes
        wait_for(lambda: story_idle(svc2, sid) and len(done_numbers(svc2, worker.run_id, sid)) >= 6, what="resumed")
        assert done_numbers(svc2, worker.run_id, sid) == [1, 2, 3, 4, 5, 6]
        assert svc2.story.get(worker.run_id, sid).session.status == "generating"
    finally:
        svc2.shutdown()


def test_export_markdown(service, manager, fake_model) -> None:
    worker = played_run(manager, 1)
    view = approved_story(service, worker.run_id)
    sid = view.session.story_id
    wait_for(lambda: story_idle(service, sid), what="chapters")
    export = service.story.export_markdown(worker.run_id, sid)
    md = export.markdown
    assert export.title == view.session.title and md.startswith(f"# {export.title}\n")
    assert "AI-written from the Empyrean run" in md and "the Turn record has the facts" in md
    assert f"_3 of {view.session.chapters_total} chapters written._" in md
    assert "## 1. Opening" in md


def test_story_queue_position(service, manager, fake_model) -> None:
    worker = played_run(manager, 1)
    briefs = []
    for _ in range(2):  # both interviews first: they share the single story executor too
        sid = service.story.create(worker.run_id, StoryCreateRequest(text="go")).session.story_id
        briefs.append((sid, brief_ready(service, worker.run_id, sid).session.brief.brief_id))
    fake_model.gate = threading.Event()
    first = service.story.approve(worker.run_id, briefs[0][0], StoryApproveRequest(brief_id=briefs[0][1], generate_all=True))
    second = service.story.approve(worker.run_id, briefs[1][0], StoryApproveRequest(brief_id=briefs[1][1], generate_all=True))
    try:
        wait_for(lambda: service.story.get(worker.run_id, second.session.story_id).job is not None, what="queued")
        job = service.story.get(worker.run_id, second.session.story_id).job
        assert job.queue_position == 1 and job.queued_behind.startswith('Queued behind "')
        assert service.story.get(worker.run_id, first.session.story_id).job.queue_position == 0
    finally:
        fake_model.gate.set()
    for sid in (first.session.story_id, second.session.story_id):
        wait_for(lambda sid=sid: service.story.get(worker.run_id, sid).session.status == "complete", what="both complete")


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------


def test_story_routes(manager, registry, worlds_dir, fake_model) -> None:
    from fastapi.testclient import TestClient

    from empyrean.api import create_app

    svc = AssistantService(manager, registry)
    svc.profile_keys = {p: FAKE_KEY for p in svc.profile_keys}
    app = create_app(manager, svc)
    assert isinstance(svc.story, StoryService)
    worker = played_run(manager, 1)
    base = f"/api/runs/{worker.run_id}/assistant/stories"
    with TestClient(app) as client:
        r = client.post(base, json={})
        assert r.status_code == 201 and r.json()["run_card"]["run_id"] == worker.run_id
        sid = r.json()["session"]["story_id"]
        r = client.post(f"{base}/{sid}/messages", json={"text": "Write it.", "picks": {"tone": "wry"}})
        assert r.status_code == 202
        wait_for(lambda: client.get(f"{base}/{sid}").json()["session"]["status"] == "brief_pending", what="brief")
        brief_id = client.get(f"{base}/{sid}").json()["session"]["brief"]["brief_id"]
        r = client.post(f"{base}/{sid}/approve", json={"brief_id": brief_id, "unit": "round"})
        assert r.status_code == 202 and r.json()["session"]["unit"] == "round"
        assert client.post(f"{base}/{sid}/approve", json={"brief_id": brief_id}).json()["error"] == "brief_not_pending"
        wait_for(lambda: client.get(f"{base}/{sid}").json()["session"]["status"] == "complete", what="complete")
        chapter = client.get(f"{base}/{sid}/chapters/2?mark_read=1").json()
        assert chapter["status"] == "done" and chapter["title"] == "Round 1"
        r = client.post(f"{base}/{sid}/continue", json={"to_turn_id": None, "generate_all": True, "job_budget_usd": 9})
        assert r.status_code == 202 and r.json()["session"]["generate_all"] is True and r.json()["session"]["job_budget_usd"] == 9
        assert client.post(f"{base}/{sid}/continue", json={"bogus": 1}).status_code == 422
        assert "Round 1" in client.get(f"{base}/{sid}/export").json()["markdown"]
        assert [s["story_id"] for s in client.get(base).json()] == [sid]
        assert client.get(f"{base}/{'0' * 32}").status_code == 404
        assert client.get(f"{base}/not-an-id").status_code == 404
        assert client.get(f"{base}/{sid}/chapters/99").status_code == 404
        r = client.post(base, json={"picks": {"from_turn_id": "r00042_end"}})
        assert r.status_code == 422 and r.json()["error"] == "validation_error"
        assert client.post(f"{base}/{sid}/cancel").json()["session"]["status"] == "cancelled"
