"""
Story Mode routes (rev 4, amended D8).  OWNER: WP3.

    GET  /api/runs/{run_id}/assistant/stories                         -> list[StorySessionSummary]
    POST /api/runs/{run_id}/assistant/stories  StoryCreateRequest     -> StoryView (201; deterministic run card + first author job)
    GET  /api/runs/{run_id}/assistant/stories/{story_id}              -> StoryView
    POST /api/runs/{run_id}/assistant/stories/{story_id}/messages StoryMessageRequest -> StoryView (202)
    POST /api/runs/{run_id}/assistant/stories/{story_id}/approve  StoryApproveRequest -> StoryView (202; starts the chapter job)
    POST /api/runs/{run_id}/assistant/stories/{story_id}/reject   StoryRejectRequest  -> StoryView
    POST /api/runs/{run_id}/assistant/stories/{story_id}/cancel                       -> StoryView
    POST /api/runs/{run_id}/assistant/stories/{story_id}/continue StoryContinueRequest -> StoryView (202)
    GET  /api/runs/{run_id}/assistant/stories/{story_id}/chapters/{n}?mark_read=1     -> StoryChapter (moves the reader; lazy generation 3 ahead)
    GET  /api/runs/{run_id}/assistant/stories/{story_id}/export                       -> StoryExport (Markdown)
"""
# DOCS: chapters are generated lazily 3 ahead of the reader unless generate_all; the story job
# holds the single story executor; queue position is reported on JobView.

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Query

from .models import (
    StoryApproveRequest,
    StoryChapter,
    StoryContinueRequest,
    StoryCreateRequest,
    StoryExport,
    StoryMessageRequest,
    StoryRejectRequest,
    StorySessionSummary,
    StoryView,
)
from .routes import RUN_PREFIX, not_implemented

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService

STORIES = RUN_PREFIX + "/stories"


def build_router(service: "AssistantService") -> APIRouter:
    router = APIRouter()

    @router.get(STORIES, response_model=list[StorySessionSummary])
    def list_stories(run_id: str) -> list[StorySessionSummary]:
        raise not_implemented("WP3 list_stories")

    @router.post(STORIES, response_model=StoryView, status_code=201)
    def create_story(run_id: str, body: Optional[StoryCreateRequest] = None) -> StoryView:
        raise not_implemented("WP3 create_story")

    @router.get(STORIES + "/{story_id}", response_model=StoryView)
    def get_story(run_id: str, story_id: str) -> StoryView:
        raise not_implemented("WP3 get_story")

    @router.post(STORIES + "/{story_id}/messages", response_model=StoryView, status_code=202)
    def story_message(run_id: str, story_id: str, body: StoryMessageRequest) -> StoryView:
        raise not_implemented("WP3 story_message")

    @router.post(STORIES + "/{story_id}/approve", response_model=StoryView, status_code=202)
    def approve_story(run_id: str, story_id: str, body: StoryApproveRequest) -> StoryView:
        raise not_implemented("WP3 approve_story")

    @router.post(STORIES + "/{story_id}/reject", response_model=StoryView)
    def reject_story(run_id: str, story_id: str, body: Optional[StoryRejectRequest] = None) -> StoryView:
        raise not_implemented("WP3 reject_story")

    @router.post(STORIES + "/{story_id}/cancel", response_model=StoryView)
    def cancel_story(run_id: str, story_id: str) -> StoryView:
        raise not_implemented("WP3 cancel_story")

    @router.post(STORIES + "/{story_id}/continue", response_model=StoryView, status_code=202)
    def continue_story(run_id: str, story_id: str, body: Optional[StoryContinueRequest] = None) -> StoryView:
        raise not_implemented("WP3 continue_story")

    @router.get(STORIES + "/{story_id}/chapters/{n}", response_model=StoryChapter)
    def get_chapter(run_id: str, story_id: str, n: int, mark_read: bool = Query(True)) -> StoryChapter:
        raise not_implemented("WP3 get_chapter")

    @router.get(STORIES + "/{story_id}/export", response_model=StoryExport)
    def export_story(run_id: str, story_id: str) -> StoryExport:
        raise not_implemented("WP3 export_story")

    return router


__all__ = ["STORIES", "build_router"]
