"""
Story Mode (rev 4, amended D8): deterministic step-0 run card, the author interview, the story
brief (Accept / Change / Cancel), the lazy chapter job (3 ahead of the reader, or generate all),
the every-5-chapters summarizer refresh, pin/continue over a running run and Markdown export.
Sessions persist at ``<run>/assistant/stories/<story_id>/``.  OWNER: WP3.
"""
# DOCS: one chapter per turn by default (per round one click away); quiet turns become short
# interludes; chapters are text mode; the reader opens after chapter 1.

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from .models import (
    StoryApproveRequest,
    StoryChapter,
    StoryContinueRequest,
    StoryCreateRequest,
    StoryExport,
    StoryMessageRequest,
    StoryRunCard,
    StorySessionSummary,
    StoryView,
)

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService


class StoryService:
    """Attached as ``service.story``; runs on the single story executor."""

    def __init__(self, service: "AssistantService") -> None:
        self.service = service
        raise NotImplementedError("WP3 StoryService")

    def run_card(self, run_id: str) -> StoryRunCard:
        raise NotImplementedError("WP3 StoryService.run_card")

    def list(self, run_id: str) -> list[StorySessionSummary]:
        raise NotImplementedError("WP3 StoryService.list")

    def create(self, run_id: str, request: Optional[StoryCreateRequest]) -> StoryView:
        raise NotImplementedError("WP3 StoryService.create")

    def get(self, run_id: str, story_id: str) -> StoryView:
        raise NotImplementedError("WP3 StoryService.get")

    def message(self, run_id: str, story_id: str, request: StoryMessageRequest) -> StoryView:
        raise NotImplementedError("WP3 StoryService.message")

    def approve(self, run_id: str, story_id: str, request: StoryApproveRequest) -> StoryView:
        raise NotImplementedError("WP3 StoryService.approve")

    def reject(self, run_id: str, story_id: str, reason: str = "") -> StoryView:
        raise NotImplementedError("WP3 StoryService.reject")

    def cancel(self, run_id: str, story_id: str) -> StoryView:
        raise NotImplementedError("WP3 StoryService.cancel")

    def continue_story(self, run_id: str, story_id: str, request: Optional[StoryContinueRequest]) -> StoryView:
        raise NotImplementedError("WP3 StoryService.continue_story")

    def chapter(self, run_id: str, story_id: str, number: int, *, mark_read: bool = True) -> StoryChapter:
        raise NotImplementedError("WP3 StoryService.chapter")

    def export_markdown(self, run_id: str, story_id: str) -> StoryExport:
        raise NotImplementedError("WP3 StoryService.export_markdown")

    def resume_interrupted(self) -> int:
        """On service start: running jobs -> interrupted, resumable from the first missing chapter."""
        raise NotImplementedError("WP3 StoryService.resume_interrupted")


__all__ = ["StoryService"]
