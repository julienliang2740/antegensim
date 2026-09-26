"""
FastAPI routers of the assistant (rev 4).  ``build_routers(service)`` returns the list
``create_app`` includes: this module's core router (capabilities, conversations, messages, jobs,
briefs, per-run settings) plus ``routes_storybook`` / ``routes_story`` / ``routes_speech``.
With ``service is None`` a single fallback router answers every ``/api/assistant/*`` and
``/api/runs/{run_id}/assistant/*`` path with 503 ``assistant_unavailable``.  Routes are plain
``def`` (thread pool) except the raw-body transcribe route.  Errors use ``api.ApiException``
with codes from ``schemas.ApiErrorCode``.  OWNER: WP2.

Route table (also in api.py's docstring and docs/INTERFACES.md section 9):

    GET    /api/assistant/capabilities?run_id=                          -> AssistantCapabilities
    GET    /api/assistant/conversations?run_id=&all=0                   -> list[ConversationMeta]
    POST   /api/assistant/conversations   ConversationCreateRequest     -> ConversationMeta (201)
    GET    /api/assistant/conversations/{conv_id}                       -> ConversationView (job filled)
    PATCH  /api/assistant/conversations/{conv_id}  ConversationPatchRequest -> ConversationMeta (rename / rebind)
    DELETE /api/assistant/conversations/{conv_id}                       -> {} (409 conversation_busy while a job runs)
    POST   /api/assistant/conversations/{conv_id}/messages MessageCreateRequest -> MessageAccepted (202; 409 assistant_busy / assistant_budget_exhausted)
    POST   /api/assistant/conversations/{conv_id}/jobs/{job_id}/cancel  -> JobView
    POST   /api/assistant/conversations/{conv_id}/briefs/{brief_id}/approve BriefApproveRequest -> BriefResponse (409 brief_not_pending)
    POST   /api/assistant/conversations/{conv_id}/briefs/{brief_id}/reject  BriefRejectRequest  -> BriefResponse (409 brief_not_pending)
    GET    /api/runs/{run_id}/assistant/settings                        -> AssistantRunSettingsView
    PUT    /api/runs/{run_id}/assistant/settings AssistantRunSettingsUpdate -> AssistantRunSettingsView
    (storybook, story and transcribe routes: see routes_storybook / routes_story / routes_speech)
"""
# DOCS: routes.build_routers(service) is the ONLY hook api.py calls; service=None -> 503 for all
# assistant routes; every error code raised here is a member of schemas.ApiErrorCode; a
# conversation GET carries the live job (step k/4, elapsed, cost) of its pending message.

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Optional

from fastapi import APIRouter, Query

from .. import storage
from ..api import ApiException
from ..schemas import utc_now_iso
from . import briefs
from .ledger import BudgetExceeded
from .models import (
    AssistantCapabilities,
    AssistantRunSettingsUpdate,
    AssistantRunSettingsView,
    BriefApproveRequest,
    BriefRejectRequest,
    BriefResponse,
    ConversationCreateRequest,
    ConversationMeta,
    ConversationPatchRequest,
    ConversationView,
    JobView,
    MessageAccepted,
    MessageCreateRequest,
)
from .store import ConversationBusy, default_run_settings, read_run_settings, write_run_settings

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService

log = logging.getLogger("empyrean.assistant.routes")

ASSISTANT_PREFIX = "/api/assistant"
RUN_PREFIX = "/api/runs/{run_id}/assistant"
_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]


def unavailable(detail: str = "the assistant is not configured in this process") -> ApiException:
    """503 ``assistant_unavailable`` (raise it)."""
    return ApiException(503, "assistant_unavailable", detail)


def not_implemented(what: str) -> NotImplementedError:
    """Handlers whose engine has not landed raise this (500 internal_error via the middleware)."""
    return NotImplementedError(f"assistant route not implemented yet: {what}")


def budget_exhausted(exc: BudgetExceeded) -> ApiException:
    """409 ``assistant_budget_exhausted`` with the limit and the spend in the detail."""
    view = exc.view
    return ApiException(409, "assistant_budget_exhausted", f"{view.kind} budget of ${view.limit_usd:.2f} for {view.scope} is exhausted (spent ${view.spent_usd:.2f}); raise the limit in the assistant settings")


def build_unavailable_router() -> APIRouter:
    """Catch-all router used when ``create_app`` gets ``assistant=None``."""
    router = APIRouter()

    @router.api_route(ASSISTANT_PREFIX + "/{path:path}", methods=_METHODS, include_in_schema=False)
    def _assistant_unavailable(path: str) -> Any:
        raise unavailable()

    @router.api_route(RUN_PREFIX + "/{path:path}", methods=_METHODS, include_in_schema=False)
    def _run_assistant_unavailable(run_id: str, path: str) -> Any:
        raise unavailable()

    return router


def _settings_view(service: "AssistantService", run_id: str) -> AssistantRunSettingsView:
    try:
        settings = read_run_settings(service.paths, run_id)
    except storage.StorageError as exc:
        raise ApiException(404, "not_found", f"unknown run {run_id}") from exc
    return AssistantRunSettingsView(run_id=run_id, exists=settings is not None, settings=settings or default_run_settings(), spend=service.spend_view(run_id))


def build_core_router(service: "AssistantService") -> APIRouter:
    router = APIRouter()

    def engine() -> Any:
        if service.engine is None:
            raise unavailable("the chat engine did not start; see the server log")
        return service.engine

    @router.get(ASSISTANT_PREFIX + "/capabilities", response_model=AssistantCapabilities)
    def capabilities(run_id: Optional[str] = Query(None)) -> AssistantCapabilities:
        return service.capabilities(run_id)

    @router.get(ASSISTANT_PREFIX + "/conversations", response_model=list[ConversationMeta])
    def list_conversations(run_id: Optional[str] = Query(None), all: bool = Query(False)) -> list[ConversationMeta]:  # noqa: A002
        return service.store.list(run_id, all_scopes=all)

    @router.post(ASSISTANT_PREFIX + "/conversations", response_model=ConversationMeta, status_code=201)
    def create_conversation(body: ConversationCreateRequest) -> ConversationMeta:
        return service.store.create(body.run_id, body.title)

    @router.get(ASSISTANT_PREFIX + "/conversations/{conv_id}", response_model=ConversationView)
    def get_conversation(conv_id: str) -> ConversationView:
        view = service.store.load(conv_id)
        view.job = service.conversation_job(conv_id, view.meta.active_job_id)
        return view

    @router.patch(ASSISTANT_PREFIX + "/conversations/{conv_id}", response_model=ConversationMeta)
    def patch_conversation(conv_id: str, body: ConversationPatchRequest) -> ConversationMeta:
        if body.run_id is not None:
            try:
                storage.find_run_dir(body.run_id)
            except storage.StorageError as exc:
                raise ApiException(404, "not_found", f"unknown run {body.run_id}") from exc

        def mutate(meta: ConversationMeta) -> None:
            if body.title is not None:
                meta.title = body.title
            if body.rebind_to_global:
                meta.run_id = None
            elif body.run_id is not None:
                meta.run_id = body.run_id

        return service.store.update_meta(conv_id, mutate)

    @router.delete(ASSISTANT_PREFIX + "/conversations/{conv_id}")
    def delete_conversation(conv_id: str) -> dict[str, Any]:
        meta = service.store.meta(conv_id)
        job = service.get_job(meta.active_job_id) if meta.active_job_id else None
        if job is not None and job.status in ("queued", "running"):
            raise ApiException(409, "conversation_busy", "a job is running for this conversation; cancel it first")
        service.store.delete(conv_id)
        return {}

    @router.post(ASSISTANT_PREFIX + "/conversations/{conv_id}/messages", response_model=MessageAccepted, status_code=202)
    def post_message(conv_id: str, body: MessageCreateRequest) -> MessageAccepted:
        chip = body.context if body.include_context else None
        try:
            user, assistant, job = engine().start_message(conv_id, body.text, chip, in_reply_to_brief_id=body.in_reply_to_brief_id)
        except ConversationBusy as exc:
            raise ApiException(409, "assistant_busy", str(exc)) from exc
        except BudgetExceeded as exc:
            raise budget_exhausted(exc) from exc
        return MessageAccepted(job_id=job.job_id, message_id=assistant.message_id, user_message_id=user.message_id, conversation_id=conv_id, queue_position=job.queue_position)

    @router.post(ASSISTANT_PREFIX + "/conversations/{conv_id}/jobs/{job_id}/cancel", response_model=JobView)
    def cancel_job(conv_id: str, job_id: str) -> JobView:
        job = service.request_cancel(job_id)
        if job is None:
            raise ApiException(404, "not_found", f"unknown job {job_id}")
        return job

    @router.post(ASSISTANT_PREFIX + "/conversations/{conv_id}/briefs/{brief_id}/approve", response_model=BriefResponse)
    def approve_brief(conv_id: str, brief_id: str, body: BriefApproveRequest) -> BriefResponse:
        try:
            brief = briefs.approve_brief(service, conv_id, brief_id, body.validated_against_turn_id)
        except briefs.BriefNotPending as exc:
            raise ApiException(409, "brief_not_pending", str(exc)) from exc
        return BriefResponse(brief=brief)

    @router.post(ASSISTANT_PREFIX + "/conversations/{conv_id}/briefs/{brief_id}/reject", response_model=BriefResponse)
    def reject_brief(conv_id: str, brief_id: str, body: BriefRejectRequest) -> BriefResponse:
        try:
            brief = briefs.reject_brief(service, conv_id, brief_id, body.reason)
        except briefs.BriefNotPending as exc:
            raise ApiException(409, "brief_not_pending", str(exc)) from exc
        return BriefResponse(brief=brief)

    @router.get(RUN_PREFIX + "/settings", response_model=AssistantRunSettingsView)
    def get_settings(run_id: str) -> AssistantRunSettingsView:
        return _settings_view(service, run_id)

    @router.put(RUN_PREFIX + "/settings", response_model=AssistantRunSettingsView)
    def put_settings(run_id: str, body: AssistantRunSettingsUpdate) -> AssistantRunSettingsView:
        try:
            settings = read_run_settings(service.paths, run_id) or default_run_settings()
        except storage.StorageError as exc:
            raise ApiException(404, "not_found", f"unknown run {run_id}") from exc
        if body.storybook_auto is not None and body.storybook_auto != settings.storybook_auto:
            settings.storybook_auto = body.storybook_auto
            if body.storybook_auto:
                settings.auto_since_turn_id = storage.read_manifest(run_id).current_turn_id
        if body.chat_budget_usd is not None:
            settings.chat_budget_usd = body.chat_budget_usd
        if body.storybook_budget_usd is not None:
            settings.storybook_budget_usd = body.storybook_budget_usd
        settings.updated_at = utc_now_iso()
        write_run_settings(service.paths, run_id, settings)
        _wake_storybook(service, run_id)
        return _settings_view(service, run_id)

    return router


def _wake_storybook(service: "AssistantService", run_id: str) -> None:
    """After a settings change (auto switched on, budget raised) let the storybook job narrate the
    pending auto turns now rather than at the next commit.  Never raises."""
    storybook = getattr(service, "storybook", None)
    if storybook is None or not hasattr(storybook, "wake"):
        return
    try:
        storybook.wake(run_id)
    except Exception:  # noqa: BLE001
        log.exception("storybook wake failed for %s", run_id)


def build_routers(service: Optional["AssistantService"]) -> list[APIRouter]:
    """Everything ``create_app`` includes.  ``None`` -> the 503 fallback router only.  The
    storybook / story / speech routers are built by their modules' ``build_router`` when present."""
    if service is None:
        return [build_unavailable_router()]
    routers = [build_core_router(service)]
    for module_name in ("routes_storybook", "routes_story", "routes_speech"):
        try:
            module = __import__(f"{__package__}.{module_name}", fromlist=["build_router"])  # local: keeps the import graph acyclic
        except ImportError:
            log.exception("assistant router module %s failed to import", module_name)
            continue
        build = getattr(module, "build_router", None)
        if callable(build):
            routers.append(build(service))
    return routers


__all__ = ["ASSISTANT_PREFIX", "RUN_PREFIX", "budget_exhausted", "build_core_router", "build_routers", "build_unavailable_router", "not_implemented", "unavailable"]
