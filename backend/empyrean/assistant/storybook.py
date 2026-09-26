"""
Storybook generation (rev 4, amended D7): a coalescing per-run job (at most one in flight per
run) narrates missing eligible turns in commit order, batched up to ``config.STORYBOOK_BATCH_MAX``
turns per text-mode narrator call when the backlog is > ``STORYBOOK_BATCH_THRESHOLD``; auto covers
only turns after ``auto_since_turn_id``; catch-up is explicit; the per-run storybook budget pauses
auto with a visible notice; a non-blocking flock guards against a second process.  OWNER: WP3.
"""
# DOCS: entries/<turn_id>.json is the sole source of truth (opening.json for the opening); one
# '## <turn_id>' section per turn in batched replies, parsed deterministically, missing ones re-queued singly.

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from ..schemas import RunCreateRequest
from .models import (
    StorybookEntry,
    StorybookEstimate,
    StorybookGenerateResponse,
    StorybookStatus,
    StorybookView,
)

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService


def default_auto(service: "AssistantService", request: RunCreateRequest) -> bool:
    """A-AST-1: ``config.STORYBOOK_AUTO`` on/off, or (auto) ON unless the narrator is a paid key
    AND every agent model in ``request`` is fake."""
    raise NotImplementedError("WP3 storybook.default_auto")


def parse_batched(text: str, turn_ids: list[str]) -> dict[str, str]:
    """Split a batched narrator reply into ``{turn_id: entry text}`` by its ``## <turn_id>``
    headings; turns without a section are absent from the result (re-queued singly)."""
    raise NotImplementedError("WP3 storybook.parse_batched")


class StorybookService:
    """Attached as ``service.storybook``; registers ``on_commit`` with
    ``service.add_commit_handler``."""

    def __init__(self, service: "AssistantService") -> None:
        self.service = service
        raise NotImplementedError("WP3 StorybookService")

    def on_commit(self, run_id: str, turn_id: str, kind: str, round_no: int) -> None:
        """Mark the run dirty and wake its coalescing job (never blocks the worker thread)."""
        raise NotImplementedError("WP3 StorybookService.on_commit")

    def on_run_created(self, run_id: str, request: RunCreateRequest) -> None:
        """Write settings.json (default_auto) and enqueue the opening entry."""
        raise NotImplementedError("WP3 StorybookService.on_run_created")

    def status(self, run_id: str) -> StorybookStatus:
        raise NotImplementedError("WP3 StorybookService.status")

    def view(self, run_id: str, last_n: Optional[int] = None) -> StorybookView:
        raise NotImplementedError("WP3 StorybookService.view")

    def missing(self, run_id: str) -> list[str]:
        """Committed turn ids without an entry, in commit order."""
        raise NotImplementedError("WP3 StorybookService.missing")

    def estimate(self, run_id: str, turn_ids: list[str]) -> StorybookEstimate:
        raise NotImplementedError("WP3 StorybookService.estimate")

    def enqueue(self, run_id: str, turn_ids: Optional[list[str]] = None, *, include_opening: bool = True, requested: bool = True) -> StorybookGenerateResponse:
        """Explicit generation (``requested=True`` bypasses ``auto_generation_allowed``)."""
        raise NotImplementedError("WP3 StorybookService.enqueue")

    def regenerate(self, run_id: str, turn_id: str) -> StorybookGenerateResponse:
        raise NotImplementedError("WP3 StorybookService.regenerate")

    def read_entry(self, run_id: str, turn_id: str) -> Optional[StorybookEntry]:
        raise NotImplementedError("WP3 StorybookService.read_entry")

    def continuation_opening(self, run_id: str) -> Optional[str]:
        """'Previously, in <parent>...' from the parent's entries up to from_turn_id."""
        raise NotImplementedError("WP3 StorybookService.continuation_opening")


__all__ = ["StorybookService", "default_auto", "parse_batched"]
