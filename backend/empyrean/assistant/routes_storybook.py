"""
Storybook routes (rev 4, amended D7).  OWNER: WP3.

    GET  /api/runs/{run_id}/assistant/storybook?last_n=            -> StorybookView (read-only; never enqueues)
    POST /api/runs/{run_id}/assistant/storybook/generate StorybookGenerateRequest -> StorybookGenerateResponse (202)
    POST /api/runs/{run_id}/assistant/storybook/entries/{turn_id}/regenerate  -> StorybookGenerateResponse (202)
"""
# DOCS: GET is read-only and reports missing_count + estimate; only POST generate / regenerate (or
# auto for turns after auto_since_turn_id) spends; entries live at <run>/assistant/storybook/entries/.

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Query

from .models import StorybookGenerateRequest, StorybookGenerateResponse, StorybookView
from .routes import RUN_PREFIX, not_implemented

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService


def build_router(service: "AssistantService") -> APIRouter:
    router = APIRouter()

    @router.get(RUN_PREFIX + "/storybook", response_model=StorybookView)
    def get_storybook(run_id: str, last_n: Optional[int] = Query(None, ge=1, le=5000)) -> StorybookView:
        raise not_implemented("WP3 get_storybook")

    @router.post(RUN_PREFIX + "/storybook/generate", response_model=StorybookGenerateResponse, status_code=202)
    def generate_missing(run_id: str, body: Optional[StorybookGenerateRequest] = None) -> StorybookGenerateResponse:
        raise not_implemented("WP3 generate_missing")

    @router.post(RUN_PREFIX + "/storybook/entries/{turn_id}/regenerate", response_model=StorybookGenerateResponse, status_code=202)
    def regenerate_entry(run_id: str, turn_id: str) -> StorybookGenerateResponse:
        raise not_implemented("WP3 regenerate_entry")

    return router


__all__ = ["build_router"]
