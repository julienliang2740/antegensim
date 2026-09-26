"""
Story Mode routes (rev 4, amended D8).  OWNER: WP3.

    GET  /api/runs/{run_id}/assistant/stories                         -> list[StorySessionSummary]
    POST /api/runs/{run_id}/assistant/stories  StoryCreateRequest     -> StoryView (201; deterministic run card; an author job only when picks/text are given)
    GET  /api/runs/{run_id}/assistant/stories/{story_id}              -> StoryView
    POST /api/runs/{run_id}/assistant/stories/{story_id}/messages StoryMessageRequest -> StoryView (202; 409 assistant_busy while the author works)
    POST /api/runs/{run_id}/assistant/stories/{story_id}/approve  StoryApproveRequest -> StoryView (202; starts the chapter job; 409 brief_not_pending)
    POST /api/runs/{run_id}/assistant/stories/{story_id}/reject   StoryRejectRequest  -> StoryView (409 brief_not_pending)
    POST /api/runs/{run_id}/assistant/stories/{story_id}/cancel                       -> StoryView
    POST /api/runs/{run_id}/assistant/stories/{story_id}/continue StoryContinueRequest -> StoryView (202; {to_turn_id, generate_all, job_budget_usd})
    GET  /api/runs/{run_id}/assistant/stories/{story_id}/chapters/{n}?mark_read=1     -> StoryChapter (moves the reader when mark_read; a pending placeholder until written)
    GET  /api/runs/{run_id}/assistant/stories/{story_id}/export                       -> StoryExport (Markdown)

"Continue story" sends ``{to_turn_id}`` (null = the last committed turn) and extends the plan past
the pinned end turn; "Generate all" sends ``{to_turn_id: null, generate_all: true}`` (end turn
unchanged) and "Raise budget" adds ``job_budget_usd``; all three resume a paused / interrupted /
cancelled story.  Errors: unknown run / story / chapter -> 404 ``not_found``; invalid picks or
turn ids -> 422 ``validation_error``; no approved brief -> 409 ``brief_not_pending``.  ``build_router`` attaches the ``StoryService`` (idempotent; runs its
restart recovery once).
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
from .routes import RUN_PREFIX
from .story import StoryService

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService

STORIES = RUN_PREFIX + "/stories"


# The continue body is ``models.StoryContinueRequest`` (to_turn_id, generate_all, job_budget_usd);
# the old route-local name stays as an alias for callers and tests.
StoryContinueBody = StoryContinueRequest


def build_router(service: "AssistantService") -> APIRouter:
    """The Story Mode router; attaches ``service.story`` when it is not there yet."""
    router = APIRouter()
    story = StoryService.attach(service)

    @router.get(STORIES, response_model=list[StorySessionSummary])
    def list_stories(run_id: str) -> list[StorySessionSummary]:
        return story.list(run_id)

    @router.post(STORIES, response_model=StoryView, status_code=201)
    def create_story(run_id: str, body: Optional[StoryCreateRequest] = None) -> StoryView:
        return story.create(run_id, body)

    @router.get(STORIES + "/{story_id}", response_model=StoryView)
    def get_story(run_id: str, story_id: str) -> StoryView:
        return story.get(run_id, story_id)

    @router.post(STORIES + "/{story_id}/messages", response_model=StoryView, status_code=202)
    def story_message(run_id: str, story_id: str, body: StoryMessageRequest) -> StoryView:
        return story.message(run_id, story_id, body)

    @router.post(STORIES + "/{story_id}/approve", response_model=StoryView, status_code=202)
    def approve_story(run_id: str, story_id: str, body: StoryApproveRequest) -> StoryView:
        return story.approve(run_id, story_id, body)

    @router.post(STORIES + "/{story_id}/reject", response_model=StoryView)
    def reject_story(run_id: str, story_id: str, body: Optional[StoryRejectRequest] = None) -> StoryView:
        return story.reject(run_id, story_id, (body or StoryRejectRequest()).reason)

    @router.post(STORIES + "/{story_id}/cancel", response_model=StoryView)
    def cancel_story(run_id: str, story_id: str) -> StoryView:
        return story.cancel(run_id, story_id)

    @router.post(STORIES + "/{story_id}/continue", response_model=StoryView, status_code=202)
    def continue_story(run_id: str, story_id: str, body: Optional[StoryContinueBody] = None) -> StoryView:
        body = body or StoryContinueBody()
        request = StoryContinueRequest(to_turn_id=body.to_turn_id)
        return story.continue_story(run_id, story_id, request, job_budget_usd=body.job_budget_usd, generate_all=body.generate_all)

    @router.get(STORIES + "/{story_id}/chapters/{n}", response_model=StoryChapter)
    def get_chapter(run_id: str, story_id: str, n: int, mark_read: bool = Query(True)) -> StoryChapter:
        return story.chapter(run_id, story_id, n, mark_read=mark_read)

    @router.get(STORIES + "/{story_id}/export", response_model=StoryExport)
    def export_story(run_id: str, story_id: str) -> StoryExport:
        return story.export_markdown(run_id, story_id)

    return router


__all__ = ["STORIES", "StoryContinueBody", "build_router"]
