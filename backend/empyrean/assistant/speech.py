"""
Speech service side of "Dictate" (rev 4, amended D9).  OWNER: WP4.

Whisper itself is a model call and lives behind the model boundary (``model.transcribe`` /
``model.whisper_status`` / ``model.preload_whisper``; faster_whisper, ctranslate2 and av are
imported only inside model.py).  This module keeps the service side:

* the **speech executor** (``service.executors["speech"]``, one worker) with a **bounded
  queue**: at most ``queue_max`` (``SPEECH_QUEUE_MAX`` = 4) transcriptions queued or running;
  one more raises ``SpeechBusy`` (the route answers 409 ``assistant_busy``);
* the **preload thread** (``start_preload_thread``: a daemon thread named ``whisper-preload``
  calling ``model.preload_whisper``).  Only the served process starts one (``main``), never
  tests; the capability reads ``loading`` while any thread of that name is alive, so a thread
  started by ``main.start_whisper_preload`` counts as well;
* the **capability state** (``capability()`` -> ``SpeechCapability`` {status ready | loading |
  unavailable | disabled, model, reason, max_seconds, max_bytes, language_default}) that
  ``AssistantService.capabilities`` reports and the Dictate button gates on.  It is
  ``model.whisper_status()`` except: ``unavailable`` / ``disabled`` read ``loading`` while a
  preload thread runs (unless speech is switched off), and a model that is
  merely not loaded yet with preload off (whisper status ``disabled`` while
  ``EMPYREAN_WHISPER_MODEL`` is not an off value) reads ``ready`` with ``LAZY_LOAD_REASON``,
  because ``model.transcribe`` loads it on first use; ``disabled`` then means switched off;
* the **initial_prompt builder** (``build_initial_prompt(run_id)``): the run's name and agent
  names (from ``run_request.json``), glossary terms (``docs/GLOSSARY.md`` when present, else a
  built-in list) and control labels, so Whisper spells game vocabulary correctly.

``routes_speech.build_router`` attaches ``SpeechService`` as ``service.speech`` when no other
package has done so (``ensure_speech_service``).
"""
# DOCS: Dictate = local Whisper via model.transcribe on a 1-worker speech executor (max 4 queued
# or running, else 409 assistant_busy); capability ready|loading|unavailable|disabled gates the
# button; initial_prompt = glossary + control labels + run/agent names (names last: Whisper keeps
# the prompt's last ~223 tokens); preload thread "whisper-preload" is started by main only.

from __future__ import annotations

import logging
import re
import threading
import time
from concurrent.futures import Future
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from .. import config, model, storage
from ..schemas import TranscriptionResult
from .models import SpeechCapability, whisper_to_capability

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService

log = logging.getLogger("empyrean.assistant.speech")

SPEECH_QUEUE_MAX = 4  # transcriptions queued or running before 409 assistant_busy
PRELOAD_THREAD_NAME = "whisper-preload"  # same name as main.start_whisper_preload's thread
UI_MAX_SECONDS = max(1, config.WHISPER_MAX_SECONDS - 5)  # the button stops at 60 s; the server allows 65
INITIAL_PROMPT_MAX_CHARS = 800  # Whisper keeps only the prompt's last ~223 tokens anyway
EXPLICIT_PROMPT_MAX_CHARS = 1000
GLOSSARY_FILE = config.REPO_DIR / "docs" / "GLOSSARY.md"

# Game vocabulary used when docs/GLOSSARY.md is absent (entity kinds, world actions, core terms).
BUILTIN_GLOSSARY_TERMS: tuple[str, ...] = (
    "Empyrean",
    "agent",
    "plant",
    "fruit",
    "seed",
    "residue",
    "absorb",
    "transfer",
    "recover",
    "attack",
    "upgrade",
    "observe",
    "query",
    "broadcast",
    "round",
    "turn",
    "round end",
    "checkpoint",
    "continuation",
    "intervention",
    "decision packet",
    "model call",
    "notebook",
    "skill",
    "persona",
    "energy",
    "health",
    "stats",
    "god mode",
    "storybook",
    "Story Mode",
    "Haiku",
    "Sonnet",
    "Opus",
)

# Control labels the user is likely to say (see docs/CONTROLS.md; literal UI labels).
CONTROL_LABELS: tuple[str, ...] = (
    "Run turn",
    "Play",
    "Pause",
    "Step round",
    "Recover (pause)",
    "Return to live",
    "Inspector",
    "Turn record",
    "God mode",
    "Rules",
    "Storybook",
    "Voice from nowhere",
    "Set stat",
    "Place entity",
    "Remove entity",
    "Edit knowledge",
    "Create continuation",
    "New session",
    "Resume session",
    "Validate setup",
    "Create and open",
    "Preview world",
    "Agent view",
)

_GLOSSARY_CACHE: dict[str, object] = {"path": None, "mtime": None, "terms": ()}
_GLOSSARY_LOCK = threading.Lock()


LAZY_LOAD_REASON = "the speech model loads on first use: the first dictation takes about 15 s longer"


def speech_switched_off() -> bool:
    """True when ``EMPYREAN_WHISPER_MODEL`` switches speech off (``model.WHISPER_OFF_VALUES``)."""
    off = getattr(model, "WHISPER_OFF_VALUES", frozenset({"", "off", "none", "disabled", "0"}))
    return (config.WHISPER_MODEL or "").strip().lower() in off


class SpeechBusy(Exception):
    """The speech queue is full (route: 409 ``assistant_busy``)."""


class SpeechUnavailable(Exception):
    """The assistant is shutting down or the executor is gone (route: 503 ``assistant_unavailable``)."""


def glossary_terms(path: Optional[Path] = None) -> tuple[str, ...]:
    """Terms defined in ``docs/GLOSSARY.md`` (bold lead-ins, ``###`` headings, first table
    column), cached by mtime; ``BUILTIN_GLOSSARY_TERMS`` when the file is absent or yields none."""
    target = path if path is not None else GLOSSARY_FILE
    try:
        mtime = target.stat().st_mtime
    except OSError:
        return BUILTIN_GLOSSARY_TERMS
    with _GLOSSARY_LOCK:
        if _GLOSSARY_CACHE["path"] == str(target) and _GLOSSARY_CACHE["mtime"] == mtime:
            return _GLOSSARY_CACHE["terms"]  # type: ignore[return-value]
    try:
        text = target.read_text(encoding="utf-8")
    except OSError:
        return BUILTIN_GLOSSARY_TERMS
    terms = parse_glossary_terms(text) or BUILTIN_GLOSSARY_TERMS
    with _GLOSSARY_LOCK:
        _GLOSSARY_CACHE.update(path=str(target), mtime=mtime, terms=terms)
    return terms


_BOLD_LEAD = re.compile(r"^\s*(?:[-*+]\s+|\d+\.\s+)?\*\*([^*]{1,60})\*\*")
_HEADING = re.compile(r"^\s*#{3,4}\s+(.{1,60}?)\s*#*\s*$")
_TABLE_ROW = re.compile(r"^\s*\|([^|]{1,80})\|")
_TABLE_SEPARATOR = re.compile(r"^[\s:|-]+$")


def parse_glossary_terms(markdown: str) -> tuple[str, ...]:
    """Pure: extract glossary terms from markdown (see ``glossary_terms``); de-duplicated, in
    document order, backticks stripped, "A / B" split into two terms, each at most 40 characters."""
    seen: set[str] = set()
    out: list[str] = []
    header_skipped = False
    for line in markdown.splitlines():
        candidate: Optional[str] = None
        m = _BOLD_LEAD.match(line) or _HEADING.match(line)
        if m:
            candidate = m.group(1)
        else:
            t = _TABLE_ROW.match(line)
            if t and not _TABLE_SEPARATOR.match(line):
                if not header_skipped:
                    header_skipped = True  # the first row of a table is its header
                else:
                    candidate = t.group(1)
            elif not t:
                header_skipped = False
        if candidate is None:
            continue
        cleaned = candidate.replace("`", "").strip().rstrip(":").strip()
        for part in cleaned.split(" / "):  # "Health / max health" -> two terms
            term = part.strip()
            if not term or len(term) > 40 or term.lower() in seen:
                continue
            seen.add(term.lower())
            out.append(term)
    return tuple(out)


def run_names(run_id: str) -> tuple[Optional[str], list[str]]:
    """(run name, agent names) from the run's ``run_request.json``; (None, []) when the run or
    file is unknown or unreadable.  Never raises."""
    try:
        rdir = storage.find_run_dir(run_id)
        data = storage.read_json(rdir / storage.RUN_REQUEST_FILE)
    except Exception:  # noqa: BLE001 - unknown run / unreadable file: no names
        return None, []
    if not isinstance(data, dict):
        return None, []
    name = data.get("name") if isinstance(data.get("name"), str) else None
    agents: list[str] = []
    for card in data.get("agents") or []:
        if isinstance(card, dict) and isinstance(card.get("name"), str) and card["name"].strip():
            if card["name"].strip() not in agents:
                agents.append(card["name"].strip())
    return name, agents


def compose_initial_prompt(
    *,
    run_name: Optional[str],
    agent_names: list[str],
    glossary: tuple[str, ...] | list[str],
    controls: tuple[str, ...] | list[str] = CONTROL_LABELS,
    max_chars: int = INITIAL_PROMPT_MAX_CHARS,
) -> str:
    """Pure: the Whisper ``initial_prompt``.  Order is glossary, controls, then run and agent
    names LAST, because faster-whisper keeps only the prompt's tail; when over ``max_chars``
    glossary terms are dropped first, then control labels, then the prompt is cut from the front."""
    names_part = ""
    if run_name:
        names_part += f" Run: {run_name}."
    if agent_names:
        names_part += " Agents: " + ", ".join(agent_names) + "."
    glossary_list = list(glossary)
    control_list = list(controls)

    def render() -> str:
        parts = ["Empyrean simulation."]
        if glossary_list:
            parts.append("Terms: " + ", ".join(glossary_list) + ".")
        if control_list:
            parts.append("Controls: " + ", ".join(control_list) + ".")
        return (" ".join(parts) + names_part).strip()

    text = render()
    while len(text) > max_chars and glossary_list:
        glossary_list.pop()
        text = render()
    while len(text) > max_chars and control_list:
        control_list.pop()
        text = render()
    if len(text) > max_chars:
        text = text[-max_chars:]
    return text


class SpeechService:
    """Attached as ``service.speech``.  Thread-safe; every method except ``transcribe`` returns
    immediately."""

    def __init__(self, service: "AssistantService", *, queue_max: int = SPEECH_QUEUE_MAX) -> None:
        self.service = service
        self.queue_max = queue_max
        self._lock = threading.Lock()
        self._inflight = 0
        self._preload_thread: Optional[threading.Thread] = None

    # -- capability ----------------------------------------------------------------------

    def preload_running(self) -> bool:
        """True while a Whisper preload thread (ours or main's, both named ``whisper-preload``) is alive."""
        if self._preload_thread is not None and self._preload_thread.is_alive():
            return True
        return any(t.name == PRELOAD_THREAD_NAME and t.is_alive() for t in threading.enumerate())

    def capability(self) -> SpeechCapability:
        """``model.whisper_status()`` as the capability the Dictate button gates on; reported as
        ``loading`` while a preload thread runs and the model is not ready yet.  Never raises."""
        try:
            status = model.whisper_status()
        except Exception as exc:  # noqa: BLE001 - the boundary promises never to raise; be safe anyway
            return SpeechCapability(status="unavailable", model=config.WHISPER_MODEL, reason=f"whisper status failed: {type(exc).__name__}", max_seconds=UI_MAX_SECONDS, max_bytes=config.WHISPER_MAX_AUDIO_BYTES, language_default=config.WHISPER_LANGUAGE_DEFAULT)
        cap = whisper_to_capability(
            status,
            max_seconds=UI_MAX_SECONDS,
            max_bytes=config.WHISPER_MAX_AUDIO_BYTES,
            language_default=config.WHISPER_LANGUAGE_DEFAULT,
        )
        switched_off = speech_switched_off()
        if cap.status in ("unavailable", "disabled") and not switched_off and self.preload_running():
            cap = cap.model_copy(update={"status": "loading", "reason": "the speech model is loading"})
        elif cap.status == "disabled" and not switched_off:
            # Not loaded and no preload started (EMPYREAN_WHISPER_PRELOAD=0): model.transcribe
            # loads it on first use, so Dictate works; only the first clip is slower.
            cap = cap.model_copy(update={"status": "ready", "reason": LAZY_LOAD_REASON})
        return cap

    # -- preload -------------------------------------------------------------------------

    def start_preload_thread(self) -> threading.Thread:
        """Start (once) a daemon thread calling ``model.preload_whisper``; returns it.  Called by
        the served process only (``main``); tests never call it."""
        with self._lock:
            if self._preload_thread is not None and self._preload_thread.is_alive():
                return self._preload_thread
            thread = threading.Thread(target=self._preload, name=PRELOAD_THREAD_NAME, daemon=True)
            self._preload_thread = thread
        thread.start()
        return thread

    @staticmethod
    def _preload() -> None:
        started = time.monotonic()
        try:
            model.preload_whisper()
        except Exception:  # noqa: BLE001 - never kill the process from a preload thread
            log.exception("whisper preload failed")
            return
        log.info("whisper preload finished in %.1f s (%s)", time.monotonic() - started, config.WHISPER_MODEL)

    # -- transcription -------------------------------------------------------------------

    @property
    def inflight(self) -> int:
        """Transcriptions currently queued or running."""
        with self._lock:
            return self._inflight

    def submit(self, audio: bytes, *, language: Optional[str], initial_prompt: Optional[str] = None, run_id: Optional[str] = None) -> "Future[TranscriptionResult]":
        """Queue one transcription on the speech executor.  ``initial_prompt`` wins when given;
        otherwise it is built from ``run_id`` on the worker thread.  Raises ``SpeechBusy`` when
        ``queue_max`` transcriptions are already queued or running, ``SpeechUnavailable`` after
        shutdown."""
        with self._lock:
            if self._inflight >= self.queue_max:
                raise SpeechBusy(f"{self._inflight} transcriptions are already queued; try again in a few seconds")
            self._inflight += 1
        try:
            future = self.service.submit("speech", self._run, audio, language, initial_prompt, run_id)
        except Exception:
            future = None
        if future is None:
            self._release()
            raise SpeechUnavailable("the assistant is shutting down")
        future.add_done_callback(lambda _f: self._release())
        return future

    def transcribe(self, audio: bytes, *, language: Optional[str], initial_prompt: Optional[str], run_id: Optional[str] = None) -> TranscriptionResult:
        """Blocking: ``submit`` and wait for the result (raises ``SpeechBusy`` / ``SpeechUnavailable``)."""
        return self.submit(audio, language=language, initial_prompt=initial_prompt, run_id=run_id).result()

    def _release(self) -> None:
        with self._lock:
            self._inflight = max(0, self._inflight - 1)

    def _run(self, audio: bytes, language: Optional[str], initial_prompt: Optional[str], run_id: Optional[str]) -> TranscriptionResult:
        prompt = initial_prompt[:EXPLICIT_PROMPT_MAX_CHARS] if initial_prompt else self.build_initial_prompt(run_id)
        started = time.monotonic()
        try:
            result = model.transcribe(audio, language=language, initial_prompt=prompt or None)
        except Exception as exc:  # noqa: BLE001 - model.transcribe never raises by contract
            log.exception("model.transcribe raised")
            result = TranscriptionResult(status="error", model=config.WHISPER_MODEL, language=language, error=f"transcription failed: {type(exc).__name__}")
        if result.error:
            result = result.model_copy(update={"error": model.redact(result.error, self.service.registry)})
        # Never log the transcript itself (privacy); only sizes and timings.
        log.info(
            "transcribe status=%s bytes=%d audio_s=%s elapsed_s=%.1f model=%s",
            result.status,
            len(audio),
            f"{result.duration_s:.1f}" if result.duration_s is not None else "?",
            time.monotonic() - started,
            result.model,
        )
        return result

    # -- prompt ------------------------------------------------------------------------------

    def build_initial_prompt(self, run_id: Optional[str]) -> str:
        """Whisper ``initial_prompt`` for a run (``compose_initial_prompt`` over the glossary, the
        control labels and, when ``run_id`` is known, the run and agent names).  Never raises."""
        run_name: Optional[str] = None
        agents: list[str] = []
        if run_id:
            run_name, agents = run_names(run_id)
        return compose_initial_prompt(run_name=run_name, agent_names=agents, glossary=glossary_terms())


def ensure_speech_service(service: "AssistantService") -> SpeechService:
    """Return ``service.speech``, attaching a new ``SpeechService`` when none is attached yet."""
    existing = getattr(service, "speech", None)
    if isinstance(existing, SpeechService):
        return existing
    speech = SpeechService(service)
    service.speech = speech
    return speech


__all__ = [
    "BUILTIN_GLOSSARY_TERMS",
    "CONTROL_LABELS",
    "PRELOAD_THREAD_NAME",
    "SPEECH_QUEUE_MAX",
    "SpeechBusy",
    "SpeechService",
    "SpeechUnavailable",
    "LAZY_LOAD_REASON",
    "compose_initial_prompt",
    "ensure_speech_service",
    "glossary_terms",
    "parse_glossary_terms",
    "run_names",
    "speech_switched_off",
]
