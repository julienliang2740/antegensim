"""
Speech route of "Dictate" (rev 4, amended D9).  OWNER: WP4.

    POST /api/assistant/transcribe?language=en&run_id=&initial_prompt=   (raw audio body) -> TranscriptionResult

* ``async def`` on purpose: the body is raw audio (no multipart; python-multipart is not a
  dependency).  The route checks ``Content-Type`` (audio/webm, audio/ogg, audio/wav (x-wav,
  wave), audio/mp4; codec parameters ignored; else 422 ``validation_error``), rejects a
  ``Content-Length`` above ``config.WHISPER_MAX_AUDIO_BYTES`` before reading anything, and
  streams the body with the same hard cap (chunked uploads too) -> 413 ``payload_too_large``.
  An empty body is 422 ``validation_error``.
* 503 ``assistant_unavailable`` while the speech model is loading, disabled or absent (the
  capability is checked before the body is read) and when ``model.transcribe`` reports
  ``unavailable``.
* The work runs on the speech executor (``SpeechService.submit``; awaited with
  ``asyncio.wrap_future`` so the event loop never blocks); 409 ``assistant_busy`` when the
  bounded queue is full.
* ``language``: a 2-3 letter code (default ``en``) or ``auto`` / empty for detection.
  ``run_id`` feeds the initial prompt (run and agent names); ``initial_prompt`` overrides it.
* A 200 always carries a ``TranscriptionResult``; ``status: "error"`` means this clip could not
  be transcribed (``error`` says why, redacted).  The transcript is never logged.
"""
# DOCS: POST /api/assistant/transcribe takes the raw MediaRecorder blob (Content-Type audio/webm |
# audio/ogg | audio/wav | audio/mp4), cap config.WHISPER_MAX_AUDIO_BYTES (10 MB) -> 413
# payload_too_large; 503 assistant_unavailable unless speech is ready; 409 assistant_busy when 4
# transcriptions are queued; query language (default en, 'auto' detects), run_id, initial_prompt.

from __future__ import annotations

import asyncio
import re
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Query, Request

from .. import config
from ..api import ApiException
from ..schemas import ApiProblem, TranscriptionResult
from .routes import ASSISTANT_PREFIX, unavailable
from .speech import SpeechBusy, SpeechUnavailable, ensure_speech_service

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService

ACCEPTED_AUDIO_TYPES: frozenset[str] = frozenset(
    {"audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave", "audio/mp4", "video/webm"}
)
_LANGUAGE = re.compile(r"^[a-z]{2,3}$")


def _validation(path: str, message: str) -> ApiException:
    return ApiException(422, "validation_error", message, [ApiProblem(path=path, message=message)])


def _too_large(size: Optional[int] = None) -> ApiException:
    cap = config.WHISPER_MAX_AUDIO_BYTES
    got = f" ({size} bytes)" if size is not None else ""
    return ApiException(413, "payload_too_large", f"audio is larger than {cap} bytes{got}; record a shorter clip")


def normalise_language(language: Optional[str]) -> Optional[str]:
    """``None`` for auto-detection ('' / 'auto' / None), else a lower-case 2-3 letter code.
    Raises the 422 ``validation_error`` ApiException for anything else."""
    if language is None:
        return None
    value = language.strip().lower()
    if value in ("", "auto"):
        return None
    if not _LANGUAGE.match(value):
        raise _validation("language", "language must be a 2-3 letter code such as 'en', or 'auto'")
    return value


def media_type(content_type: Optional[str]) -> str:
    """The bare media type of a Content-Type header ('audio/webm;codecs=opus' -> 'audio/webm')."""
    return (content_type or "").split(";", 1)[0].strip().lower()


async def read_capped_body(request: Request, cap: int) -> bytes:
    """Read the raw body, refusing more than ``cap`` bytes: a declared Content-Length above the
    cap is rejected before reading, and the stream is cut as soon as it passes the cap (chunked
    uploads carry no length).  Raises the 413 ``payload_too_large`` ApiException."""
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            length = int(declared)
        except ValueError:
            raise _validation("content-length", "Content-Length is not a number") from None
        if length > cap:
            raise _too_large(length)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > cap:
            raise _too_large()
    return bytes(body)


def build_router(service: "AssistantService") -> APIRouter:
    """The transcribe router; attaches ``SpeechService`` as ``service.speech`` if missing."""
    speech = ensure_speech_service(service)
    router = APIRouter()

    @router.post(ASSISTANT_PREFIX + "/transcribe", response_model=TranscriptionResult)
    async def transcribe(
        request: Request,
        language: Optional[str] = Query("en", max_length=8),
        run_id: Optional[str] = Query(None, max_length=200),
        initial_prompt: Optional[str] = Query(None, max_length=2000),
    ) -> TranscriptionResult:
        kind = media_type(request.headers.get("content-type"))
        if kind not in ACCEPTED_AUDIO_TYPES:
            raise _validation(
                "content-type",
                f"unsupported Content-Type {kind or '(none)'!r}; send audio/webm, audio/ogg, audio/wav or audio/mp4",
            )
        lang = normalise_language(language)
        cap = config.WHISPER_MAX_AUDIO_BYTES
        declared = request.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > cap:
            raise _too_large(int(declared))
        capability = speech.capability()
        if capability.status != "ready":
            reason = capability.reason or ("the speech model is loading" if capability.status == "loading" else "speech recognition is unavailable")
            raise unavailable(f"speech {capability.status}: {reason}")
        audio = await read_capped_body(request, cap)
        if not audio:
            raise _validation("body", "the request body is empty; send the recorded audio")
        try:
            future = speech.submit(audio, language=lang, initial_prompt=initial_prompt or None, run_id=run_id or None)
        except SpeechBusy as exc:
            raise ApiException(409, "assistant_busy", str(exc)) from None
        except SpeechUnavailable as exc:
            raise unavailable(str(exc)) from None
        try:
            result = await asyncio.wrap_future(future)
        except asyncio.CancelledError:
            if future.cancelled():  # executor shut down under us (lifespan), not a client disconnect
                raise unavailable("the assistant is shutting down") from None
            raise
        if result.status == "unavailable":
            raise unavailable(f"speech unavailable: {result.error or 'the speech model is not loaded'}")
        return result

    return router


__all__ = ["ACCEPTED_AUDIO_TYPES", "build_router", "media_type", "normalise_language", "read_capped_body"]
