"""
FastAPI routers of the assistant (rev 4).  ``build_routers(service)`` returns the list
``create_app`` includes: this module's core router (capabilities, conversations, messages, jobs,
briefs, per-run settings) plus ``routes_storybook`` / ``routes_story`` / ``routes_speech``.
With ``service is None`` a single fallback router answers every ``/api/assistant/*`` and
``/api/runs/{run_id}/assistant/*`` path with 503 ``assistant_unavailable``.  Routes are plain
``def`` (thread pool) except the raw-body transcribe route.  Errors use ``api.ApiException``
with codes from ``schemas.ApiErrorCode``.  OWNER: WP2 (handlers marked WP2 land with the engine).

Route table (also in api.py's docstring and docs/INTERFACES.md section 9):

    GET    /api/assistant/capabilities                                  -> AssistantCapabilities
    GET    /api/assistant/conversations?run_id=&all=0                   -> list[ConversationMeta]
    POST   /api/assistant/conversations   ConversationCreateRequest     -> ConversationMeta (201)
    GET    /api/assistant/conversations/{conv_id}                       -> ConversationView
    PATCH  /api/assistant/conversations/{conv_id}  ConversationPatchRequest -> ConversationMeta
    DELETE /api/assistant/conversations/{conv_id}                       -> {} (409 conversation_busy)
    POST   /api/assistant/conversations/{conv_id}/messages MessageCreateRequest -> MessageAccepted (202)
    POST   /api/assistant/conversations/{conv_id}/jobs/{job_id}/cancel  -> JobView
    POST   /api/assistant/conversations/{conv_id}/briefs/{brief_id}/approve BriefApproveRequest -> BriefResponse
    POST   /api/assistant/conversations/{conv_id}/briefs/{brief_id}/reject  BriefRejectRequest  -> BriefResponse
    GET    /api/runs/{run_id}/assistant/settings                        -> AssistantRunSettingsView
    PUT    /api/runs/{run_id}/assistant/settings AssistantRunSettingsUpdate -> AssistantRunSettingsView
    (storybook, story and transcribe routes: see routes_storybook / routes_story / routes_speech)
"""
# DOCS: routes.build_routers(service) is the ONLY hook api.py calls; service=None -> 503 for all
# assistant routes; every error code raised here is a member of schemas.ApiErrorCode.

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

from fastapi import APIRouter, Query

from ..api import ApiException
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

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService

ASSISTANT_PREFIX = "/api/assistant"
RUN_PREFIX = "/api/runs/{run_id}/assistant"
_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]


def unavailable(detail: str = "the assistant is not configured in this process") -> ApiException:
    """503 ``assistant_unavailable`` (raise it)."""
    return ApiException(503, "assistant_unavailable", detail)


def not_implemented(what: str) -> NotImplementedError:
    """Handlers whose engine has not landed raise this (500 internal_error via the middleware)."""
    return NotImplementedError(f"assistant route not implemented yet: {what}")


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


def build_core_router(service: "AssistantService") -> APIRouter:
    router = APIRouter()

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
        return service.store.load(conv_id)

    @router.patch(ASSISTANT_PREFIX + "/conversations/{conv_id}", response_model=ConversationMeta)
    def patch_conversation(conv_id: str, body: ConversationPatchRequest) -> ConversationMeta:
        raise not_implemented("WP2 patch_conversation (rename / rebind)")

    @router.delete(ASSISTANT_PREFIX + "/conversations/{conv_id}")
    def delete_conversation(conv_id: str) -> dict[str, Any]:
        raise not_implemented("WP2 delete_conversation (409 conversation_busy while a job runs)")

    @router.post(ASSISTANT_PREFIX + "/conversations/{conv_id}/messages", response_model=MessageAccepted, status_code=202)
    def post_message(conv_id: str, body: MessageCreateRequest) -> MessageAccepted:
        raise not_implemented("WP2 post_message (engine job on the chat executor)")

    @router.post(ASSISTANT_PREFIX + "/conversations/{conv_id}/jobs/{job_id}/cancel", response_model=JobView)
    def cancel_job(conv_id: str, job_id: str) -> JobView:
        job = service.request_cancel(job_id)
        if job is None:
            raise ApiException(404, "not_found", f"unknown job {job_id}")
        return job

    @router.post(ASSISTANT_PREFIX + "/conversations/{conv_id}/briefs/{brief_id}/approve", response_model=BriefResponse)
    def approve_brief(conv_id: str, brief_id: str, body: BriefApproveRequest) -> BriefResponse:
        raise not_implemented("WP2 approve_brief (CAS pending->executing, revalidate, execute, store effect)")

    @router.post(ASSISTANT_PREFIX + "/conversations/{conv_id}/briefs/{brief_id}/reject", response_model=BriefResponse)
    def reject_brief(conv_id: str, brief_id: str, body: BriefRejectRequest) -> BriefResponse:
        raise not_implemented("WP2 reject_brief")

    @router.get(RUN_PREFIX + "/settings", response_model=AssistantRunSettingsView)
    def get_settings(run_id: str) -> AssistantRunSettingsView:
        raise not_implemented("WP2 get_settings")

    @router.put(RUN_PREFIX + "/settings", response_model=AssistantRunSettingsView)
    def put_settings(run_id: str, body: AssistantRunSettingsUpdate) -> AssistantRunSettingsView:
        raise not_implemented("WP2 put_settings")

    return router


def build_routers(service: Optional["AssistantService"]) -> list[APIRouter]:
    """Everything ``create_app`` includes.  ``None`` -> the 503 fallback router only."""
    if service is None:
        return [build_unavailable_router()]
    from . import routes_speech, routes_story, routes_storybook  # local: keeps the import graph acyclic

    return [
        build_core_router(service),
        routes_storybook.build_router(service),
        routes_story.build_router(service),
        routes_speech.build_router(service),
    ]


__all__ = ["ASSISTANT_PREFIX", "RUN_PREFIX", "build_core_router", "build_routers", "build_unavailable_router", "not_implemented", "unavailable"]
