"""
Storybook routes (rev 4, amended D7).  OWNER: WP3.

    GET  /api/runs/{run_id}/assistant/storybook?last_n=            -> StorybookView (read-only; never enqueues)
    POST /api/runs/{run_id}/assistant/storybook/generate StorybookGenerateRequest -> StorybookGenerateResponse (202)
    POST /api/runs/{run_id}/assistant/storybook/entries/{turn_id}/regenerate  -> StorybookGenerateResponse (202)

Errors: unknown run -> 404 ``not_found`` (StorageError handler in api.py); a turn id that is not
a narratable committed turn of the run -> 422 ``validation_error``.  ``build_router`` attaches the
``StorybookService`` to the AssistantService (idempotent), so the commit fan-in works as soon as
``create_app`` includes the assistant routers.
"""
# DOCS: GET is read-only and reports missing_count + estimate; only POST generate / regenerate (or
# auto for turns after auto_since_turn_id) spends; entries live at <run>/assistant/storybook/entries/.

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Query

from ..api import ApiException
from .models import StorybookGenerateRequest, StorybookGenerateResponse, StorybookView
from .routes import RUN_PREFIX
from .storybook import StorybookService

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService


def build_router(service: "AssistantService") -> APIRouter:
    """The storybook router; attaches ``service.storybook`` when it is not there yet."""
    router = APIRouter()
    storybook = StorybookService.attach(service)

    @router.get(RUN_PREFIX + "/storybook", response_model=StorybookView)
    def get_storybook(run_id: str, last_n: Optional[int] = Query(None, ge=1, le=5000)) -> StorybookView:
        return storybook.view(run_id, last_n)

    @router.post(RUN_PREFIX + "/storybook/generate", response_model=StorybookGenerateResponse, status_code=202)
    def generate_missing(run_id: str, body: Optional[StorybookGenerateRequest] = None) -> StorybookGenerateResponse:
        request = body or StorybookGenerateRequest()
        try:
            return storybook.enqueue(run_id, request.turn_ids, include_opening=request.include_opening, requested=True)
        except ValueError as exc:
            raise ApiException(422, "validation_error", str(exc)) from None

    @router.post(RUN_PREFIX + "/storybook/entries/{turn_id}/regenerate", response_model=StorybookGenerateResponse, status_code=202)
    def regenerate_entry(run_id: str, turn_id: str) -> StorybookGenerateResponse:
        try:
            return storybook.regenerate(run_id, turn_id)
        except ValueError as exc:
            raise ApiException(422, "validation_error", str(exc)) from None

    return router


__all__ = ["build_router"]
