"""
``AssistantService`` (rev 4): the object ``main.build_app`` constructs and ``create_app`` wires.
Owns the four executors (chat 2, story 1, storybook 1, speech 1), the model registry reference,
the paths / store / ledger, the job table, the profile -> model key map and the commit fan-in
(``on_commit`` is registered with ``RunManager.add_commit_listener``; sub-services register
handlers with ``add_commit_handler``).  ``auto_live_allowed`` gates every unrequested paid
generation (storybook auto, summary refresh): main sets True, tests never do.  OWNER: WP2.
"""
# DOCS: AssistantService(manager, registry=None, worlds_dir=None, auto_live_allowed=False);
# shutdown order in the lifespan: manager.shutdown() -> assistant.shutdown() -> model.kill_inflight().

from __future__ import annotations

import logging
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Optional

from .. import config, model, storage
from ..runner import RunManager
from ..schemas import SCHEMA_VERSION, RunCreateRequest, utc_now_iso
from . import calls, logbuffer
from .knowledge import KnowledgeBase
from .ledger import Ledger, global_aggregate
from .models import (
    GLOBAL_SCOPE,
    PROFILES,
    AssistantCapabilities,
    BudgetView,
    JobKind,
    JobView,
    ProfileCapability,
    SpendView,
    scope_key,
    whisper_to_capability,
)
from .store import AssistantPaths, ConversationStore, new_id, read_run_settings

log = logging.getLogger("empyrean.assistant")

CommitHandler = Callable[[str, str, str, int], None]

PROFILE_KEYS_FROM_CONFIG: dict[str, str] = {
    "chat": config.ASSISTANT_MODEL_CHAT,
    "narrator": config.ASSISTANT_MODEL_NARRATOR,
    "author": config.ASSISTANT_MODEL_AUTHOR,
    "summarizer": config.ASSISTANT_MODEL_SUMMARIZER,
}


class AssistantService:
    """Attributes other packages build against:

    * ``manager`` (RunManager), ``registry`` (ModelRegistry), ``paths`` (AssistantPaths),
      ``store`` (ConversationStore), ``ledger`` (Ledger).
    * ``executors``: ``{"chat": 2 workers, "story": 1, "storybook": 1, "speech": 1}``; submit
      with ``submit(kind, fn, *args)`` (returns None after shutdown instead of raising).
    * ``profile_keys``: profile -> registry key (from config; tests overwrite with fake keys).
    * ``jobs``: ``JobView`` by id (``new_job`` / ``get_job`` / ``update_job``); ``cancel_events``
      by job id (``cancel_event(job_id)``).
    * ``auto_live_allowed``: unrequested generation with a non-fake key runs only when True.
    * ``engine`` (ChatEngine), ``knowledge`` (KnowledgeBase), ``logbuffer`` (RingBufferHandler)
      are attached here; ``storybook`` / ``story`` / ``speech`` attach when WP3/WP4's classes
      construct (None while they raise NotImplementedError); ``add_commit_handler(cb)`` for
      commit fan-in; ``notify_run_created(run_id, request)`` after a brief creates a run.
    * ``fake_metadata``: per-profile metadata for the fake adapter (tests).
    * ``call_profile(...)``: ``calls.call_profile(self, ...)``."""

    def __init__(
        self,
        manager: RunManager,
        registry: Optional[model.ModelRegistry] = None,
        worlds_dir: Optional[Path] = None,
        *,
        auto_live_allowed: bool = False,
    ) -> None:
        self.manager = manager
        self.registry = registry if registry is not None else manager.registry
        self.auto_live_allowed = auto_live_allowed
        self.paths = AssistantPaths(worlds_dir)
        self.store = ConversationStore(self.paths)
        self.ledger = Ledger(self.paths.usage)
        self.profile_keys: dict[str, str] = dict(PROFILE_KEYS_FROM_CONFIG)
        self.executors: dict[str, ThreadPoolExecutor] = {
            "chat": ThreadPoolExecutor(max_workers=2, thread_name_prefix="assistant-chat"),
            "story": ThreadPoolExecutor(max_workers=1, thread_name_prefix="assistant-story"),
            "storybook": ThreadPoolExecutor(max_workers=1, thread_name_prefix="assistant-storybook"),
            "speech": ThreadPoolExecutor(max_workers=1, thread_name_prefix="assistant-speech"),
            "sequencer": ThreadPoolExecutor(max_workers=2, thread_name_prefix="assistant-sequencer"),
        }
        self.jobs: dict[str, JobView] = {}
        self.cancel_events: dict[str, threading.Event] = {}
        self._jobs_lock = threading.Lock()
        self._commit_handlers: list[CommitHandler] = []
        self._handlers_lock = threading.Lock()
        self._shutdown = False
        self.started_at = utc_now_iso()
        # Test hook (fake adapter only, never forwarded to a real provider): per-profile metadata merged
        # into every call, e.g. {"chat": {"fake_script": [...]}, "summarizer": {"fake_reply": "..."}}.
        self.fake_metadata: dict[str, dict[str, Any]] = {}
        # Sub-services (None keeps a route on its 503 path when a package has not landed).
        self.engine: Any = None
        self.knowledge: Any = None
        self.storybook: Any = None
        self.story: Any = None
        self.speech: Any = None
        self.logbuffer: Any = None
        self.recovered_records = 0
        manager.add_commit_listener(self.on_commit)
        self._attach_core()
        self._attach_subservices()

    def _attach_core(self) -> None:
        """Log buffer, knowledge base, chat engine and restart recovery (each failure is logged,
        never fatal: the service still serves capabilities and 503s)."""
        try:
            self.logbuffer = logbuffer.install(self.registry)
        except Exception:  # noqa: BLE001
            log.exception("log ring buffer not installed")
        try:
            self.knowledge = KnowledgeBase()
            self.knowledge.load()
        except Exception:  # noqa: BLE001
            log.exception("knowledge base failed to load")
        try:
            from .engine import ChatEngine

            self.engine = ChatEngine(self)
        except Exception:  # noqa: BLE001
            log.exception("chat engine failed to start")
        try:
            self.recovered_records = self.store.recover_interrupted()
            if self.recovered_records:
                log.info("assistant: %d interrupted records recovered", self.recovered_records)
        except Exception:  # noqa: BLE001
            log.exception("conversation recovery failed")

    def _attach_subservices(self) -> None:
        """Storybook, story and speech services (WP3/WP4) attach themselves when their modules
        are implemented; a NotImplementedError placeholder leaves the attribute None."""
        for name, module_name, class_name in (("storybook", "storybook", "StorybookService"), ("story", "story", "StoryService"), ("speech", "speech", "SpeechService")):
            try:
                module = __import__(f"{__package__}.{module_name}", fromlist=[class_name])
                setattr(self, name, getattr(module, class_name)(self))
            except NotImplementedError:
                setattr(self, name, None)
            except Exception:  # noqa: BLE001
                log.exception("assistant sub-service %s failed to start", name)
                setattr(self, name, None)
        story = self.story
        if story is not None and hasattr(story, "resume_interrupted"):
            try:
                story.resume_interrupted()
            except NotImplementedError:
                pass
            except Exception:  # noqa: BLE001
                log.exception("story resume failed")

    def notify_run_created(self, run_id: str, request: Optional[RunCreateRequest]) -> None:
        """Called after ``manager.create_run`` by the brief executor (and by anyone else creating
        runs through the assistant): lets the storybook write settings.json and the opening."""
        storybook = self.storybook
        if storybook is None or not hasattr(storybook, "on_run_created"):
            return
        try:
            storybook.on_run_created(run_id, request)
        except NotImplementedError:
            pass
        except Exception:  # noqa: BLE001
            log.exception("storybook on_run_created failed for %s", run_id)

    # -- lifecycle -------------------------------------------------------------------

    def shutdown(self) -> None:
        """Called from the API lifespan after ``manager.shutdown()``: every executor
        ``shutdown(wait=False, cancel_futures=True)``, cancel events set.  Idempotent."""
        self._shutdown = True
        for event in list(self.cancel_events.values()):
            event.set()
        for name, executor in self.executors.items():
            try:
                executor.shutdown(wait=False, cancel_futures=True)
            except Exception:  # noqa: BLE001
                log.exception("executor %s did not shut down cleanly", name)
        try:
            self.manager.remove_commit_listener(self.on_commit)
        except Exception:  # noqa: BLE001
            pass

    @property
    def is_shut_down(self) -> bool:
        return self._shutdown

    def submit(self, kind: str, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Optional[Future]:
        """Submit to the named executor; None (never RuntimeError) after shutdown."""
        if self._shutdown:
            return None
        try:
            return self.executors[kind].submit(fn, *args, **kwargs)
        except RuntimeError:
            return None

    # -- commit fan-in -----------------------------------------------------------------

    def add_commit_handler(self, handler: CommitHandler) -> None:
        """Sub-services (storybook) register here; ``on_commit`` fans out to them."""
        with self._handlers_lock:
            if handler not in self._commit_handlers:
                self._commit_handlers.append(handler)

    def on_commit(self, run_id: str, turn_id: str, kind: str, round_no: int) -> None:
        """The manager's commit listener: runs on the worker thread, so it only fans out to
        handlers that set a flag / submit to an executor.  Never raises."""
        if self._shutdown:
            return
        with self._handlers_lock:
            handlers = list(self._commit_handlers)
        for handler in handlers:
            try:
                handler(run_id, turn_id, kind, round_no)
            except Exception:  # noqa: BLE001
                log.exception("assistant commit handler failed for %s %s", run_id, turn_id)

    # -- profiles and models ---------------------------------------------------------------

    def profile_model_key(self, profile: str) -> str:
        try:
            return self.profile_keys[profile]
        except KeyError:
            raise ValueError(f"unknown assistant profile {profile!r}") from None

    def profile_is_fake(self, profile: str) -> bool:
        """True when the profile's key is a fake route (no spend)."""
        key = self.profile_model_key(profile)
        try:
            return self.registry.get(key).provider == "fake"
        except model.UnknownModelError:
            return False

    def profile_available(self, profile: str) -> Optional[str]:
        """None when the profile's key exists and is usable; else the reason."""
        return self.registry.validate_key(self.profile_model_key(profile))

    def auto_generation_allowed(self, profile: str) -> bool:
        """Unrequested generation may run: fake key always; a paid key only with auto_live_allowed."""
        return self.profile_is_fake(profile) or self.auto_live_allowed

    def call_profile(self, profile: str, **kwargs: Any) -> calls.ProfileCallResult:
        """``calls.call_profile(self, profile, ...)``."""
        return calls.call_profile(self, profile, **kwargs)

    # -- budgets -----------------------------------------------------------------------------

    def chat_budget(self, run_id: Optional[str]) -> BudgetView:
        limit = config.ASSISTANT_CHAT_BUDGET_USD
        if run_id is not None:
            try:
                settings = read_run_settings(self.paths, run_id)
            except storage.StorageError:
                settings = None
            if settings is not None:
                limit = settings.chat_budget_usd
        scope = scope_key(run_id)
        # Only the chat profile (and the conversation summariser) draws on the chat budget; the
        # storybook narrator and Story Mode author have their own limits (D12).
        spent = sum(
            line.cost_usd
            for line in self.ledger.lines(scope)
            if line.profile == "chat" or (line.profile == "summarizer" and line.story_id is None)
        )
        return self.ledger.budget_view(scope, "chat", limit, spent)

    def storybook_budget(self, run_id: str) -> BudgetView:
        try:
            settings = read_run_settings(self.paths, run_id)
        except storage.StorageError:
            settings = None
        limit = settings.storybook_budget_usd if settings is not None else config.ASSISTANT_STORYBOOK_BUDGET_USD
        spent = self.ledger.spent(run_id, "narrator")
        return self.ledger.budget_view(run_id, "storybook", limit, spent)

    def global_budget(self) -> BudgetView:
        scopes = [GLOBAL_SCOPE] + self._run_scopes_with_ledgers()
        total = global_aggregate(self.ledger, scopes)
        return self.ledger.budget_view(GLOBAL_SCOPE, "global", config.ASSISTANT_GLOBAL_BUDGET_USD, total.cost_usd)

    def _run_scopes_with_ledgers(self) -> list[str]:
        try:
            root = self.paths.worlds_root()
            return sorted(p.parent.parent.name for p in root.glob("*/runs/*/assistant/usage.jsonl"))
        except OSError:
            return []

    def spend_view(self, run_id: Optional[str]) -> SpendView:
        overall = self.global_budget()
        by_profile = global_aggregate(self.ledger, [GLOBAL_SCOPE] + self._run_scopes_with_ledgers()).by_profile
        return SpendView(
            chat=self.chat_budget(run_id),
            storybook=self.storybook_budget(run_id) if run_id is not None else None,
            overall=overall,
            by_profile=by_profile,
        )

    # -- jobs --------------------------------------------------------------------------------

    def new_job(self, kind: JobKind, *, conversation_id: Optional[str] = None, run_id: Optional[str] = None, story_id: Optional[str] = None, max_steps: int = 0) -> JobView:
        job = JobView(job_id=new_id(), kind=kind, conversation_id=conversation_id, run_id=run_id, story_id=story_id, max_steps=max_steps)
        with self._jobs_lock:
            self.jobs[job.job_id] = job
            self.cancel_events[job.job_id] = threading.Event()
        return job

    def get_job(self, job_id: str) -> Optional[JobView]:
        with self._jobs_lock:
            return self.jobs.get(job_id)

    def update_job(self, job_id: str, **changes: Any) -> Optional[JobView]:
        with self._jobs_lock:
            job = self.jobs.get(job_id)
            if job is None:
                return None
            job = job.model_copy(update=changes)
            self.jobs[job_id] = job
            return job

    def cancel_event(self, job_id: str) -> threading.Event:
        with self._jobs_lock:
            event = self.cancel_events.get(job_id)
            if event is None:
                event = self.cancel_events[job_id] = threading.Event()
            return event

    def request_cancel(self, job_id: str) -> Optional[JobView]:
        """Set the job's cancel event ('stopping after the current step' until the kill lands)."""
        self.cancel_event(job_id).set()
        return self.update_job(job_id, cancel_requested=True)

    def conversation_job(self, conv_id: str, active_job_id: Optional[str]) -> Optional[JobView]:
        """The conversation's active job, else its most recent finished chat job."""
        if active_job_id:
            job = self.get_job(active_job_id)
            if job is not None:
                return job
        with self._jobs_lock:
            jobs = [j for j in self.jobs.values() if j.conversation_id == conv_id and j.kind == "chat"]
        if not jobs:
            return None
        jobs.sort(key=lambda j: (j.finished_at or j.started_at or "", j.job_id))
        return jobs[-1]

    # -- capabilities ----------------------------------------------------------------------------

    def capabilities(self, run_id: Optional[str] = None) -> AssistantCapabilities:
        """GET /api/assistant/capabilities: the assistant models and why one is unavailable, the
        speech state (``model.whisper_status`` or the speech sub-service), budgets."""
        models: list[ProfileCapability] = []
        for profile in PROFILES:
            key = self.profile_model_key(profile)
            reason = self.registry.validate_key(key)
            models.append(ProfileCapability(profile=profile, model_key=key, available=reason is None, fake=self.profile_is_fake(profile), reason=reason))
        if self.speech is not None and hasattr(self.speech, "capability"):
            speech = self.speech.capability()
        else:
            speech = whisper_to_capability(
                model.whisper_status(),
                max_seconds=config.WHISPER_MAX_SECONDS - 5,
                max_bytes=config.WHISPER_MAX_AUDIO_BYTES,
                language_default=config.WHISPER_LANGUAGE_DEFAULT,
            )
        return AssistantCapabilities(
            available=any(m.available for m in models if m.profile == "chat"),
            auto_live_allowed=self.auto_live_allowed,
            models=models,
            speech=speech,
            budgets=self.spend_view(run_id),
            max_steps=config.ASSISTANT_MAX_STEPS,
            message_timeout_seconds=config.ASSISTANT_MESSAGE_TIMEOUT_SECONDS,
            version=SCHEMA_VERSION,
        )


__all__ = ["AssistantService", "CommitHandler", "PROFILE_KEYS_FROM_CONFIG"]
