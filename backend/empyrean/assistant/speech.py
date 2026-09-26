"""
Speech service side (rev 4, amended D9): the speech executor's bounded queue, the preload thread
``main`` starts when ``config.WHISPER_PRELOAD``, the capability state and the ``initial_prompt``
builder (agent names + glossary + control labels).  Whisper itself runs behind
``model.transcribe`` / ``model.whisper_status`` / ``model.preload_whisper``.  OWNER: WP4.
"""
# DOCS: the feature is called "Dictate"; capability status ready|loading|unavailable|disabled gates
# the button; the route is raw-body with a 10 MB cap.

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Optional

from ..schemas import TranscriptionResult
from .models import SpeechCapability

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService

SPEECH_QUEUE_MAX = 4  # pending transcriptions before 409 assistant_busy


class SpeechService:
    """Attached as ``service.speech``."""

    def __init__(self, service: "AssistantService") -> None:
        self.service = service
        raise NotImplementedError("WP4 SpeechService")

    def capability(self) -> SpeechCapability:
        raise NotImplementedError("WP4 SpeechService.capability")

    def start_preload_thread(self) -> threading.Thread:
        """Daemon thread calling ``model.preload_whisper``; the capability reads ``loading`` meanwhile."""
        raise NotImplementedError("WP4 SpeechService.start_preload_thread")

    def transcribe(self, audio: bytes, *, language: Optional[str], initial_prompt: Optional[str]) -> TranscriptionResult:
        """Run ``model.transcribe`` on the speech executor (raises the busy condition when the
        bounded queue is full; the route maps it to 409 assistant_busy)."""
        raise NotImplementedError("WP4 SpeechService.transcribe")

    def build_initial_prompt(self, run_id: Optional[str]) -> str:
        raise NotImplementedError("WP4 SpeechService.build_initial_prompt")


__all__ = ["SPEECH_QUEUE_MAX", "SpeechService"]
