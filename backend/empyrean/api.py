"""
FastAPI routes.  OWNER: engine/storage team (thin layer; frontend team reads it).

Rules
-----
* No game logic here.  Every route validates its body with a schemas.py model,
  calls one ``RunManager``/``RunWorker``/``storage``/``model`` function, and
  returns a schemas.py model.
* Errors always have the ``ApiError`` body ``{error, detail, problems}`` with
  ``error`` one of ``schemas.ApiErrorCode``:
    RunnerError("run_not_open")      -> 409 run_not_open
    RunnerError (other)              -> 409 illegal_command
    SetupError (run creation)        -> 422 invalid_setup        (problems filled)
    SetupError (interventions)       -> 422 invalid_intervention (problems filled)
    RequestValidationError           -> 422 validation_error     (problems from loc -> "agents[2].position")
    UnknownModelError                -> 422 unknown_model
    StorageError / NotFoundError     -> 404 not_found
    HTTP 413 (body over a cap)       -> 413 payload_too_large
    storage.RunInUseError            -> 409 run_in_use (DELETE of an open run, one held by another
                                        process, or one with a queued/running story, storybook or
                                        sequencer job)
    anything else                    -> 500 internal_error (message only; traceback in the log)
  Assistant routes (rev 4) raise ``ApiException`` with the assistant codes:
    assistant_unavailable 503 (no AssistantService in this process, or no usable model),
    assistant_busy 409, brief_not_pending 409, assistant_budget_exhausted 409,
    conversation_busy 409, payload_too_large 413.
  The 500 handler is a middleware INSIDE CORSMiddleware so the browser gets a
  body and CORS headers, never a bare "Failed to fetch".
* Never returns credentials or reads ``.env``.
* Lifespan (rev 4): on shutdown ``manager.shutdown()`` (no more commits), then
  ``assistant.shutdown()`` when present (executors, cancel events), then
  ``model.kill_inflight()`` (no orphaned CLI processes).

Route table (all JSON; see docs/INTERFACES.md "API" for request/response models):

    GET    /api/health                                   -> {"ok": true, "version": SCHEMA_VERSION}
    GET    /api/defaults?agent_count=8                   -> RunCreateRequest (6..64 prefilled cards)
    GET    /api/models?include_assistant=0&include_test=0 -> list[ModelInfo] (assistant-only refs hidden unless include_assistant=1; test-only fakes hidden unless include_test=1)
    GET    /api/assumptions                              -> AssumptionsView (registry defaults)
    POST   /api/world/preview       WorldPreviewRequest  -> MapState (terrain only)
    GET    /api/runs?archived=0|1|all                    -> list[RunSummary] (default 0: active runs only)
    POST   /api/runs                RunCreateRequest     -> RunSummary          (201)
    POST   /api/runs/validate       RunCreateRequest     -> RunValidationResponse
    POST   /api/runs/{run_id}/open                       -> RunStatus
    POST   /api/runs/{run_id}/close                      -> RunStatus (paused, worker stopped)
    GET    /api/runs/{run_id}                            -> RunSummary
    DELETE /api/runs/{run_id}                            -> 204 (folder removed for good; 409 run_in_use while open)
    POST   /api/runs/{run_id}/archive                    -> RunSummary (writes archive.json; idempotent)
    POST   /api/runs/{run_id}/unarchive                  -> RunSummary (removes archive.json; idempotent)
    GET    /api/runs/{run_id}/assumptions                -> AssumptionsView (as recorded at creation)
    GET    /api/runs/{run_id}/status                     -> RunStatus
    POST   /api/runs/{run_id}/commands  CommandRequest   -> RunStatus           (409 on illegal)
    GET    /api/runs/{run_id}/events?since=0&limit=500   -> EventsResponse
    GET    /api/runs/{run_id}/state                      -> TurnView (live=true)
    GET    /api/runs/{run_id}/pending_model_call         -> PendingModelCallView (404 when none)
    GET    /api/runs/{run_id}/turns?from_round&to_round  -> list[TurnIndexEntry]
    GET    /api/runs/{run_id}/turns/{turn_id}            -> TurnView (live=false)
    GET    /api/runs/{run_id}/turns/{turn_id}/events     -> list[Event]
    GET    /api/runs/{run_id}/turns/{turn_id}/agents/{agent_id}/knowledge -> AgentKnowledgeView
    GET    /api/runs/{run_id}/turns/{turn_id}/model_calls/{call_id}       -> ModelCallRecord
    GET    /api/runs/{run_id}/turns/{turn_id}/decision_packets/{packet_id} -> DecisionPacketRecord
    GET    /api/runs/{run_id}/agents/{agent_id}/knowledge -> AgentKnowledgeView (live)
    GET    /api/runs/{run_id}/settings                   -> EffectiveSettingsView
    GET    /api/runs/{run_id}/rules                      -> RulesConfig (live)
    GET    /api/runs/{run_id}/interventions              -> StagedInterventionsResponse
    POST   /api/runs/{run_id}/interventions Intervention -> StagedInterventionsResponse (201)
    DELETE /api/runs/{run_id}/interventions/{iv_id}      -> StagedInterventionsResponse
    POST   /api/runs/{run_id}/working/reload             -> ReloadResponse
    POST   /api/runs/{run_id}/continuations ContinuationRequest -> RunSummary (201)

Assistant routes (rev 4; ``empyrean/assistant/routes*.py``, included by ``create_app`` through
``assistant.routes.build_routers(assistant)``; all answer 503 assistant_unavailable when the app
was built without an AssistantService):

    GET    /api/assistant/capabilities                   -> AssistantCapabilities
    GET    /api/assistant/conversations?run_id=&all=0    -> list[ConversationMeta]
    POST   /api/assistant/conversations ConversationCreateRequest -> ConversationMeta (201)
    GET    /api/assistant/conversations/{conv_id}        -> ConversationView
    PATCH  /api/assistant/conversations/{conv_id} ConversationPatchRequest -> ConversationMeta
    DELETE /api/assistant/conversations/{conv_id}        -> {} (409 conversation_busy while a job runs)
    POST   /api/assistant/conversations/{conv_id}/messages MessageCreateRequest -> MessageAccepted (202 {job_id})
    POST   /api/assistant/conversations/{conv_id}/jobs/{job_id}/cancel -> JobView
    POST   /api/assistant/conversations/{conv_id}/briefs/{brief_id}/approve BriefApproveRequest {validated_against_turn_id} -> BriefResponse
    POST   /api/assistant/conversations/{conv_id}/briefs/{brief_id}/reject BriefRejectRequest -> BriefResponse
    GET    /api/runs/{run_id}/assistant/settings         -> AssistantRunSettingsView
    PUT    /api/runs/{run_id}/assistant/settings AssistantRunSettingsUpdate -> AssistantRunSettingsView
    GET    /api/runs/{run_id}/assistant/storybook?last_n= -> StorybookView (read-only)
    POST   /api/runs/{run_id}/assistant/storybook/generate StorybookGenerateRequest -> StorybookGenerateResponse (202)
    POST   /api/runs/{run_id}/assistant/storybook/entries/{turn_id}/regenerate -> StorybookGenerateResponse (202)
    GET    /api/assistant/stories?status=all|unfinished|finished -> list[StorySessionSummary] (every run, newest first)
    GET    /api/runs/{run_id}/assistant/stories          -> list[StorySessionSummary]
    POST   /api/runs/{run_id}/assistant/stories StoryCreateRequest -> StoryView (201)
    GET    /api/runs/{run_id}/assistant/stories/{story_id} -> StoryView
    POST   /api/runs/{run_id}/assistant/stories/{story_id}/messages StoryMessageRequest -> StoryView (202)
    POST   /api/runs/{run_id}/assistant/stories/{story_id}/approve StoryApproveRequest -> StoryView (202)
    POST   /api/runs/{run_id}/assistant/stories/{story_id}/reject StoryRejectRequest -> StoryView
    POST   /api/runs/{run_id}/assistant/stories/{story_id}/cancel -> StoryView
    POST   /api/runs/{run_id}/assistant/stories/{story_id}/continue StoryContinueRequest {to_turn_id?, generate_all?, job_budget_usd?} -> StoryView (202)
    GET    /api/runs/{run_id}/assistant/stories/{story_id}/chapters/{n}?mark_read=1 -> StoryChapter
    GET    /api/runs/{run_id}/assistant/stories/{story_id}/export -> StoryExport
    POST   /api/assistant/transcribe?language=en&run_id=&initial_prompt= (raw audio body, async, 10 MB cap) -> TranscriptionResult

``turn_id`` may be the literal ``live`` in the turn-scoped GET routes to read
from the open runner instead of disk.  Every route body is a one-line
translation into a ``RunManager`` call; history reads go through the manager's
thin storage wrappers so this module never assembles views itself.

Routes are plain ``def`` (not ``async``) on purpose: every manager call does
blocking file I/O or waits on the worker lock, so FastAPI runs them in its
thread pool and the event loop stays free for status/event polling of every
run while a run is created, reloaded or closed (``POST /close`` itself returns
as soon as the worker has been told to stop; the worker finishes its active
turn on its own).
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any, AsyncIterator, Literal, Optional

from fastapi import FastAPI, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config, model
from .runner import NotFoundError, RunManager, RunnerError, SetupError
from .schemas import (
    SCHEMA_VERSION,
    AgentKnowledgeView,
    ApiError,
    ApiProblem,
    AssumptionsView,
    CommandRequest,
    ContinuationRequest,
    DecisionPacketRecord,
    EffectiveSettingsView,
    Event,
    EventsResponse,
    Intervention,
    MapState,
    ModelCallRecord,
    ModelInfo,
    PendingModelCallView,
    ReloadResponse,
    RulesConfig,
    RunCreateRequest,
    RunStatus,
    RunSummary,
    RunValidationResponse,
    StagedInterventionsResponse,
    TurnIndexEntry,
    TurnView,
    WorldPreviewRequest,
)
from .storage import RunInUseError, StorageError

if TYPE_CHECKING:  # pragma: no cover - the assistant package imports ApiException from here
    from .assistant.service import AssistantService

log = logging.getLogger("empyrean.api")


class ApiException(Exception):
    """Raised by a route that must pick a specific ``ApiErrorCode`` (interventions)."""

    def __init__(self, status_code: int, error: str, detail: Optional[str] = None, problems: Optional[list[ApiProblem]] = None) -> None:
        super().__init__(detail or error)
        self.status_code = status_code
        self.error = error
        self.detail = detail
        self.problems = problems or []


def _error_response(status_code: int, error: str, detail: Optional[str] = None, problems: Optional[list[ApiProblem]] = None) -> JSONResponse:
    body = ApiError(error=error, detail=detail, problems=problems or [])  # type: ignore[arg-type]
    return JSONResponse(status_code=status_code, content=body.model_dump(mode="json"))


def _loc_to_path(loc: tuple[Any, ...]) -> str:
    """pydantic ``loc`` -> ``agents[2].position`` (the leading body/query marker is dropped)."""
    parts = [p for p in loc if p not in ("body", "query", "path")]
    path = ""
    for part in parts:
        if isinstance(part, int):
            path += f"[{part}]"
        else:
            path += ("." if path else "") + str(part)
    return path


def _safe_message(exc: BaseException, registry: Any) -> str:
    """A redacted, capped error message for API bodies (never a secret, never a traceback)."""
    text = f"{type(exc).__name__}: {exc}"
    try:
        return model.redact(text, registry) or text[: config.ERROR_TEXT_MAX_CHARS]
    except Exception:  # noqa: BLE001 - redaction must not break error reporting
        return text[: config.ERROR_TEXT_MAX_CHARS]


class InternalErrorMiddleware:
    """Pure-ASGI catch-all: any unhandled exception becomes a JSON 500 ``ApiError``.
    Added before CORSMiddleware so CORS wraps it and the browser gets headers."""

    def __init__(self, app: Any, registry: Any = None) -> None:
        self.app = app
        self.registry = registry

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def send_wrapper(message: Any) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as exc:  # noqa: BLE001 - the whole point of this middleware
            log.exception("unhandled error in %s %s", scope.get("method"), scope.get("path"))
            if started:
                raise
            response = _error_response(500, "internal_error", _safe_message(exc, self.registry))
            await response(scope, receive, send)


def create_app(manager: RunManager, assistant: Optional["AssistantService"] = None) -> FastAPI:
    """Build the FastAPI app: CORS for config.CORS_ORIGINS, the error handlers/middleware
    described above, every route in the table, the assistant routers
    (``assistant.routes.build_routers(assistant)``; 503 fallbacks when ``assistant`` is None)
    and the shutdown lifespan.  ``app.state.manager = manager``, ``app.state.assistant = assistant``."""
    from .assistant import routes as assistant_routes  # local import: assistant modules import ApiException from here

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield
        shutdown = getattr(manager, "shutdown", None)
        if callable(shutdown):
            try:
                shutdown()
            except Exception:  # noqa: BLE001 - shutdown must run to the end
                log.exception("manager shutdown failed")
        if assistant is not None:
            try:
                assistant.shutdown()
            except Exception:  # noqa: BLE001
                log.exception("assistant shutdown failed")
        try:
            model.kill_inflight()
        except Exception:  # noqa: BLE001
            log.exception("kill_inflight failed")

    app = FastAPI(title="Empyrean", version=SCHEMA_VERSION, lifespan=lifespan)
    app.state.manager = manager

    def _notify_assistant_run_created(run_id: str, request_body: Optional[RunCreateRequest]) -> None:
        """Lets the assistant's storybook write ``<run>/assistant/settings.json`` and the opening
        entry for a run created through the API (a continuation passes ``None``).  Never fatal:
        run creation succeeded already."""
        if assistant is None:
            return
        try:
            assistant.notify_run_created(run_id, request_body)
        except Exception:  # noqa: BLE001 - the assistant must never break run creation
            logging.getLogger("empyrean.api").exception("assistant run-created hook failed for %s", run_id)
    app.state.assistant = assistant
    registry = getattr(manager, "registry", None)
    # add_middleware prepends: the error middleware is added first so CORS wraps it.
    app.add_middleware(InternalErrorMiddleware, registry=registry)
    app.add_middleware(CORSMiddleware, allow_origins=list(config.CORS_ORIGINS), allow_methods=["*"], allow_headers=["*"])

    # -- error handlers ---------------------------------------------------------

    @app.exception_handler(ApiException)
    async def _api_exception(request: Request, exc: ApiException) -> JSONResponse:
        return _error_response(exc.status_code, exc.error, exc.detail, exc.problems)

    @app.exception_handler(RunnerError)
    async def _runner_error(request: Request, exc: RunnerError) -> JSONResponse:
        message = str(exc)
        code = "run_not_open" if message.startswith("run_not_open") else "illegal_command"
        return _error_response(409, code, message)

    @app.exception_handler(NotFoundError)
    async def _not_found(request: Request, exc: NotFoundError) -> JSONResponse:
        return _error_response(404, "not_found", str(exc))

    @app.exception_handler(RunInUseError)
    async def _run_in_use(request: Request, exc: RunInUseError) -> JSONResponse:
        return _error_response(409, "run_in_use", str(exc))

    @app.exception_handler(StorageError)
    async def _storage_error(request: Request, exc: StorageError) -> JSONResponse:
        return _error_response(404, "not_found", _safe_message(exc, registry))

    @app.exception_handler(SetupError)
    async def _setup_error(request: Request, exc: SetupError) -> JSONResponse:
        return _error_response(422, "invalid_setup", "invalid run setup", exc.problems)

    @app.exception_handler(model.UnknownModelError)
    async def _unknown_model(request: Request, exc: model.UnknownModelError) -> JSONResponse:
        return _error_response(422, "unknown_model", str(exc).strip("'\""))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        problems = [ApiProblem(path=_loc_to_path(tuple(e.get("loc", ()))), message=str(e.get("msg", ""))) for e in exc.errors()]
        return _error_response(422, "validation_error", "request validation failed", problems)

    @app.exception_handler(StarletteHTTPException)
    async def _http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "illegal_command", 413: "payload_too_large"}.get(exc.status_code, "internal_error")
        return _error_response(exc.status_code, code, str(exc.detail))

    # -- global ---------------------------------------------------------------------

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "version": SCHEMA_VERSION}

    @app.get("/api/defaults", response_model=RunCreateRequest)
    def defaults(agent_count: int = Query(8, ge=config.MIN_AGENTS, le=config.MAX_AGENTS)) -> RunCreateRequest:
        return config.default_run_request(config.operator_default_model_key(getattr(manager, "registry", None)), agent_count)

    @app.get("/api/models", response_model=list[ModelInfo])
    def models(include_assistant: bool = Query(False), include_test: bool = Query(False)) -> list[ModelInfo]:
        infos = manager.models_info()
        return [m for m in infos if (include_assistant or not m.assistant_only) and (include_test or not m.test_only)]

    @app.get("/api/assumptions", response_model=AssumptionsView)
    def assumptions() -> AssumptionsView:
        return AssumptionsView(entries=config.assumption_entries())

    @app.post("/api/world/preview", response_model=MapState)
    def world_preview(body: WorldPreviewRequest) -> MapState:
        return manager.preview_world(body)

    # -- runs --------------------------------------------------------------------------

    @app.get("/api/runs", response_model=list[RunSummary])
    def list_runs(archived: Literal["0", "1", "all"] = Query("0")) -> list[RunSummary]:
        return manager.list_runs(archived)

    @app.post("/api/runs", response_model=RunSummary, status_code=201)
    def create_run(body: RunCreateRequest) -> RunSummary:
        summary = manager.create_run(body)
        _notify_assistant_run_created(summary.run_id, body)
        return summary

    @app.post("/api/runs/validate", response_model=RunValidationResponse)
    def validate_run(body: RunCreateRequest) -> RunValidationResponse:
        problems = manager.validate_setup(body)
        return RunValidationResponse(ok=not problems, problems=problems)

    @app.post("/api/runs/{run_id}/open", response_model=RunStatus)
    def open_run(run_id: str) -> RunStatus:
        return manager.open_run(run_id).status()

    @app.post("/api/runs/{run_id}/close", response_model=RunStatus)
    def close_run(run_id: str) -> RunStatus:
        return manager.close_run(run_id)

    @app.get("/api/runs/{run_id}", response_model=RunSummary)
    def get_run(run_id: str) -> RunSummary:
        return manager.get_summary(run_id)

    @app.delete("/api/runs/{run_id}", status_code=204)
    def delete_run(run_id: str) -> Response:
        if assistant is not None and assistant.run_writing_jobs(run_id):
            raise RunInUseError(f"run {run_id} has a story, storybook or sequencer job queued or running; cancel it or wait before deleting")
        manager.delete_run(run_id)
        return Response(status_code=204)

    @app.post("/api/runs/{run_id}/archive", response_model=RunSummary)
    def archive_run(run_id: str) -> RunSummary:
        return manager.archive_run(run_id)

    @app.post("/api/runs/{run_id}/unarchive", response_model=RunSummary)
    def unarchive_run(run_id: str) -> RunSummary:
        return manager.unarchive_run(run_id)

    @app.get("/api/runs/{run_id}/assumptions", response_model=AssumptionsView)
    def run_assumptions(run_id: str) -> AssumptionsView:
        return AssumptionsView(entries=manager.run_assumptions(run_id))

    @app.get("/api/runs/{run_id}/status", response_model=RunStatus)
    def run_status(run_id: str) -> RunStatus:
        return manager.require(run_id).status()

    @app.post("/api/runs/{run_id}/commands", response_model=RunStatus)
    def run_command(run_id: str, body: CommandRequest) -> RunStatus:
        return manager.require(run_id).submit(body.command)

    @app.get("/api/runs/{run_id}/events", response_model=EventsResponse)
    def run_events(run_id: str, since: int = Query(0, ge=0), limit: int = Query(config.EVENTS_PAGE_LIMIT, ge=1, le=5000)) -> EventsResponse:
        worker = manager.require(run_id)
        events = worker.events_since(since, limit)
        status = worker.status()
        return EventsResponse(events=events, latest_seq=status.latest_seq, status=status)

    @app.get("/api/runs/{run_id}/state", response_model=TurnView)
    def run_state(run_id: str) -> TurnView:
        return manager.require(run_id).live_view()

    @app.get("/api/runs/{run_id}/pending_model_call", response_model=PendingModelCallView)
    def pending_model_call(run_id: str) -> PendingModelCallView:
        view = manager.require(run_id).pending_model_call_view()
        if view is None:
            raise NotFoundError("no model call is pending")
        return view

    # -- history -------------------------------------------------------------------------

    @app.get("/api/runs/{run_id}/turns", response_model=list[TurnIndexEntry])
    def list_turns(run_id: str, from_round: Optional[int] = None, to_round: Optional[int] = None) -> list[TurnIndexEntry]:
        return manager.list_turns(run_id, from_round, to_round)

    @app.get("/api/runs/{run_id}/turns/{turn_id}", response_model=TurnView)
    def get_turn(run_id: str, turn_id: str) -> TurnView:
        return manager.turn_view(run_id, turn_id)

    @app.get("/api/runs/{run_id}/turns/{turn_id}/events", response_model=list[Event])
    def turn_events(run_id: str, turn_id: str) -> list[Event]:
        return manager.turn_events(run_id, turn_id)

    @app.get("/api/runs/{run_id}/turns/{turn_id}/agents/{agent_id}/knowledge", response_model=AgentKnowledgeView)
    def turn_knowledge(run_id: str, turn_id: str, agent_id: str) -> AgentKnowledgeView:
        return manager.turn_knowledge(run_id, turn_id, agent_id)

    @app.get("/api/runs/{run_id}/turns/{turn_id}/model_calls/{call_id}", response_model=ModelCallRecord)
    def turn_model_call(run_id: str, turn_id: str, call_id: str) -> ModelCallRecord:
        return manager.model_call(run_id, turn_id, call_id)

    @app.get("/api/runs/{run_id}/turns/{turn_id}/decision_packets/{packet_id}", response_model=DecisionPacketRecord)
    def turn_decision_packet(run_id: str, turn_id: str, packet_id: str) -> DecisionPacketRecord:
        return manager.decision_packet(run_id, turn_id, packet_id)

    # -- live views ----------------------------------------------------------------------

    @app.get("/api/runs/{run_id}/agents/{agent_id}/knowledge", response_model=AgentKnowledgeView)
    def live_knowledge(run_id: str, agent_id: str) -> AgentKnowledgeView:
        return manager.require(run_id).knowledge(agent_id)

    @app.get("/api/runs/{run_id}/settings", response_model=EffectiveSettingsView)
    def run_settings(run_id: str) -> EffectiveSettingsView:
        return manager.require(run_id).effective_settings()

    @app.get("/api/runs/{run_id}/rules", response_model=RulesConfig)
    def run_rules(run_id: str) -> RulesConfig:
        return manager.require(run_id).checkpoint.world.rules

    # -- interventions -------------------------------------------------------------------

    @app.get("/api/runs/{run_id}/interventions", response_model=StagedInterventionsResponse)
    def staged_interventions(run_id: str) -> StagedInterventionsResponse:
        return StagedInterventionsResponse(staged=manager.require(run_id).staged())

    @app.post("/api/runs/{run_id}/interventions", response_model=StagedInterventionsResponse, status_code=201)
    def stage_intervention(run_id: str, body: Intervention) -> StagedInterventionsResponse:
        worker = manager.require(run_id)
        try:
            worker.stage_intervention(body)
        except SetupError as exc:
            raise ApiException(422, "invalid_intervention", "invalid intervention", exc.problems) from exc
        return StagedInterventionsResponse(staged=worker.staged())

    @app.delete("/api/runs/{run_id}/interventions/{iv_id}", response_model=StagedInterventionsResponse)
    def unstage_intervention(run_id: str, iv_id: str) -> StagedInterventionsResponse:
        worker = manager.require(run_id)
        worker.unstage(iv_id)
        return StagedInterventionsResponse(staged=worker.staged())

    @app.post("/api/runs/{run_id}/working/reload", response_model=ReloadResponse)
    def reload_working(run_id: str) -> ReloadResponse:
        return manager.require(run_id).reload_working()

    @app.post("/api/runs/{run_id}/continuations", response_model=RunSummary, status_code=201)
    def create_continuation(run_id: str, body: ContinuationRequest) -> RunSummary:
        summary = manager.create_continuation(run_id, body)
        _notify_assistant_run_created(summary.run_id, None)
        return summary

    # -- assistant (rev 4) -----------------------------------------------------------

    for router in assistant_routes.build_routers(assistant):
        app.include_router(router)

    return app
