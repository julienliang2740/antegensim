"""
Speech route (rev 4, amended D9).  OWNER: WP4.

    POST /api/assistant/transcribe?language=en&run_id=&initial_prompt=  (raw audio body) -> TranscriptionResult

``async def`` on purpose: it checks Content-Length, streams the body with a hard cap
(``config.WHISPER_MAX_AUDIO_BYTES`` -> 413 ``payload_too_large``), then runs
``model.transcribe`` on the speech executor (409 ``assistant_busy`` when its bounded queue is
full; 503 ``assistant_unavailable`` while the model is loading or absent).
"""
# DOCS: raw body (no multipart), 10 MB cap, 60 s clips; the button is called "Dictate".

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Query, Request

from ..schemas import TranscriptionResult
from .routes import ASSISTANT_PREFIX, not_implemented

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService


def build_router(service: "AssistantService") -> APIRouter:
    router = APIRouter()

    @router.post(ASSISTANT_PREFIX + "/transcribe", response_model=TranscriptionResult)
    async def transcribe(
        request: Request,
        language: Optional[str] = Query("en"),
        run_id: Optional[str] = Query(None),
        initial_prompt: Optional[str] = Query(None),
    ) -> TranscriptionResult:
        raise not_implemented("WP4 transcribe")

    return router


__all__ = ["build_router"]
