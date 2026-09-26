"""
Chat engine (rev 4, amended D3/D4): per user message up to ``config.ASSISTANT_MAX_STEPS`` model
calls on the chat executor; step 1 is prefetched with deterministic context; a tool step runs up
to 3 read tools whose nonce-fenced results feed the next step; the last step gets the restricted
answer|ask schema; malformed JSON goes through ``calls.salvage`` then one repair step; a brief
step is validated by ``briefs`` before it is shown (an action that does not type, or a typed
action with problems the model can fix, gets the one repair step with the problems fenced);
wall clock and message budget are enforced;
the summarizer refreshes the rolling memory after the answer.  OWNER: WP2.

Fake metadata: every chat call carries ``fake_script_index`` = the number of model calls made
so far for this message (0-based) and a per-profile ``fake_reply`` default, merged with
``service.fake_metadata[profile]`` (tests put ``fake_script`` there).  Real providers never see
metadata.
"""
# DOCS: progress line 'step 2/4 · 18 s · $0.03' (refreshed every PROGRESS_TICK_SECONDS while a
# model call runs); answers stamped 'as of turn <id>'; offline fallback answers from docs search
# when no model is available; one repair step after deterministic salvage, or for a brief whose
# typed action has fixable validation problems; only one job per conversation (409 assistant_busy);
# a finished job clears meta.active_job_id under the conversation lock in the same step.

from __future__ import annotations

import logging
import threading
import time
from typing import TYPE_CHECKING, Any, Optional

from pydantic import ValidationError

from .. import config, model, storage
from ..schemas import utc_now_iso
from . import briefs, digest, prompts, tools
from .ledger import BudgetExceeded
from .models import (
    AnswerRef,
    AnswerStep,
    AskStep,
    Brief,
    BriefStep,
    BudgetView,
    ContextChip,
    JobView,
    Message,
    StepRecord,
    ToolCallRecord,
    ToolStep,
    assistant_step_adapter,
    restricted_step_adapter,
    scope_key,
)
from .store import ConversationBusy, new_id

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService

log = logging.getLogger("empyrean.assistant.engine")

FAKE_DEFAULT_ANSWER = {
    "kind": "answer",
    "text": "(fake assistant) I read the context you sent and have nothing further to add.",
    "refs": [],
}
FAKE_DEFAULT_SUMMARY = "(fake summary) The operator asked questions about the simulation and the assistant answered from the run's records."
OFFLINE_LABEL = "Docs search (AI offline)"
MEMORY_RECENT_MESSAGES = 8
LIVE_JOB_STATES = ("queued", "running")
PROGRESS_TICK_SECONDS = 1.0  # job.elapsed_s and the progress line refresh this often during a call


def parse_step(parsed: dict[str, Any], *, restricted: bool) -> Any:
    """``AssistantStep`` / ``RestrictedStep`` validation (raises ``ValidationError``).  Fields of
    other kinds that the model left empty are dropped first (the schema is one flat object)."""
    kind = parsed.get("kind")
    keep = {
        "answer": ("kind", "text", "refs"),
        "tool": ("kind", "calls", "note"),
        "ask": ("kind", "text", "options"),
        "brief": ("kind", "brief"),
    }.get(kind if isinstance(kind, str) else "", None)
    cleaned = {k: v for k, v in parsed.items() if keep is None or k in keep}
    if kind == "tool" and isinstance(cleaned.get("calls"), list) and len(cleaned["calls"]) > config.ASSISTANT_TOOLS_PER_STEP:
        cleaned["calls"] = cleaned["calls"][: config.ASSISTANT_TOOLS_PER_STEP]  # the rest is dropped, never an error
    if keep is not None:
        for key in keep:
            value = cleaned.get(key)
            if key in ("refs", "options") and value is None:
                cleaned.pop(key, None)
            if key == "note" and value is None:
                cleaned.pop(key, None)
    adapter = restricted_step_adapter if restricted else assistant_step_adapter
    return adapter.validate_python(cleaned)


def memory_block(summary: str, recent: list[tuple[str, str]]) -> str:
    """Render the rolling summary plus recent exchanges as a quoted transcript inside the one
    user message (never role-labelled messages the model could mistake for its own turns)."""
    lines: list[str] = []
    if summary.strip():
        lines += ["Summary of the earlier conversation:", summary.strip(), ""]
    if recent:
        lines.append("Recent exchanges (quoted):")
        for role, content in recent:
            label = "Operator" if role == "user" else "Assistant"
            lines.append(f"> {label}: " + content.strip().replace("\n", "\n> "))
    return "\n".join(lines)


def _progress(step: int, max_steps: int, started: float, cost: float, note: str = "") -> str:
    elapsed = time.monotonic() - started
    line = f"step {step}/{max_steps} · {elapsed:.0f} s · ${cost:.2f}"
    return f"{line} · {note}" if note else line


class _ProgressTicker:
    """Refreshes ``job.elapsed_s`` and the progress line every ``PROGRESS_TICK_SECONDS`` while a
    model call blocks the step loop (a daemon thread; stopped and joined before the loop goes on,
    so it never writes after the step's own updates)."""

    def __init__(self, engine: "ChatEngine", conv_id: str, message_id: str, job_id: str, step_no: int, max_steps: int, started: float, cost: float) -> None:
        self._args = (engine, conv_id, message_id, job_id, step_no, max_steps, started, cost)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"assistant-progress-{job_id[:8]}", daemon=True)

    def _run(self) -> None:
        engine, conv_id, message_id, job_id, step_no, max_steps, started, cost = self._args
        while not self._stop.wait(PROGRESS_TICK_SECONDS):
            try:
                engine._push_progress(conv_id, message_id, job_id, None, _progress(step_no, max_steps, started, cost), step_no, cost, started)
            except Exception:  # noqa: BLE001 - a progress write never breaks the step
                log.debug("progress tick failed for %s", job_id, exc_info=True)

    def __enter__(self) -> "_ProgressTicker":
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._stop.set()
        self._thread.join(timeout=5)


class ChatEngine:
    """Attached as ``service.engine``."""

    def __init__(self, service: "AssistantService") -> None:
        self.service = service
        self._system: dict[bool, str] = {}
        self._nonce_factory = prompts.new_nonce

    # -- prompt prefix ----------------------------------------------------------------

    def system_prompt(self, *, restricted: bool) -> str:
        """Byte-stable per (profile, restricted); built once and cached."""
        cached = self._system.get(restricted)
        if cached is not None:
            return cached
        core = self.service.knowledge.core_text() if self.service.knowledge is not None else ""
        text = prompts.system_prompt("chat", knowledge_core=core, tool_catalogue_text=prompts.tool_catalogue_text(tools.tool_catalogue()), restricted=restricted)
        prompts.assert_sizes(text, prompts.step_schema(restricted=restricted))
        self._system[restricted] = text
        return text

    def reset_prompts(self) -> None:
        self._system = {}

    # -- start ------------------------------------------------------------------------------

    def start_message(self, conv_id: str, text: str, context: Optional[ContextChip], *, in_reply_to_brief_id: Optional[str] = None) -> tuple[Message, Message, JobView]:
        """Append the user message and a pending assistant message, create the job, submit
        ``run_message`` to the chat executor.  Raises ``ConversationBusy`` while another job of
        the conversation is queued or running, ``BudgetExceeded`` when the chat or global budget
        would not cover one more call.  Returns (user message, assistant message, job)."""
        service = self.service
        store = service.store
        with store.lock(conv_id):
            meta = store.meta(conv_id)
            if meta.active_job_id:
                job = service.get_job(meta.active_job_id)
                if job is not None and job.status in LIVE_JOB_STATES:
                    raise ConversationBusy(f"a job is already running for this conversation ({job.job_id})")
            for view in (service.chat_budget(meta.run_id), service.global_budget()):
                service.ledger.check_budget(view)
            user = Message(message_id=new_id(), role="user", text=text, context=context, status="done")
            store.append_message(conv_id, user)
            job = service.new_job("chat", conversation_id=conv_id, run_id=meta.run_id, max_steps=config.ASSISTANT_MAX_STEPS)
            assistant = Message(message_id=new_id(), role="assistant", status="pending", job_id=job.job_id, progress="queued")
            store.append_message(conv_id, assistant)
            if in_reply_to_brief_id:
                try:
                    store.cas_brief(conv_id, in_reply_to_brief_id, "pending", lambda b: setattr(b, "error", "waiting for your changes"))
                except storage.StorageError:
                    pass

            def mutate(m: Any) -> None:
                m.active_job_id = job.job_id
                if m.title == "New conversation" and text.strip():
                    m.title = text.strip().splitlines()[0][:60]

            store.update_meta(conv_id, mutate)
        future = service.submit("chat", self.run_message, conv_id, assistant.message_id, job.job_id)
        if future is None:
            self._finish_error(conv_id, assistant.message_id, job.job_id, "the assistant is shutting down", None, status="interrupted")
        return user, assistant, service.get_job(job.job_id) or job

    # -- the step loop -----------------------------------------------------------------------

    def run_message(self, conv_id: str, message_id: str, job_id: str) -> None:
        """The step loop (executor thread).  Never raises; failures land on the message."""
        service = self.service
        store = service.store
        started = time.monotonic()
        try:
            service.update_job(job_id, status="running", started_at=utc_now_iso())
            meta = store.meta(conv_id)
            messages = store.messages(conv_id)
            user = self._user_message_for(messages, message_id)
            text = user.text if user else ""
            chip = user.context if user else None
            store.update_message(conv_id, message_id, lambda m: setattr(m, "status", "running"))
            reason = service.profile_available("chat")
            if reason is not None:
                answer = self.offline_answer(text)
                self._finalize_offline(conv_id, message_id, job_id, answer, reason)
                return
            self._loop(conv_id, message_id, job_id, meta, messages, text, chip, started)
        except Exception as exc:  # noqa: BLE001 - never escapes the executor
            log.exception("chat message %s failed", message_id)
            self._finish_error(conv_id, message_id, job_id, model.redact(f"{type(exc).__name__}: {exc}", service.registry) or "internal error", None)
        finally:
            try:
                store.update_meta(conv_id, lambda m: setattr(m, "active_job_id", None) if m.active_job_id == job_id else None)
            except Exception:  # noqa: BLE001
                pass
            self._maybe_refresh_memory(conv_id)

    def _loop(self, conv_id: str, message_id: str, job_id: str, meta: Any, history: list[Message], text: str, chip: Optional[ContextChip], started: float) -> None:
        service = self.service
        store = service.store
        cancel = service.cancel_event(job_id)
        run_id = meta.run_id or (chip.run_id if chip else None)
        scope = scope_key(meta.run_id)
        nonce = self._nonce_factory()
        prefetched = self.prefetch_context(chip, nonce=nonce)
        memory = self._memory_text(meta, history, message_id)
        retrieved = self._retrieved_text(text, chip)
        chip_text = self._chip_text(chip)
        max_steps = config.ASSISTANT_MAX_STEPS
        deadline = started + config.ASSISTANT_MESSAGE_TIMEOUT_SECONDS
        tool_results: list[str] = []
        sources: list[str] = []
        calls_made = 0
        cost = 0.0
        repaired = False
        step_no = 0
        as_of = self._as_of(chip, run_id)
        while step_no < max_steps:
            step_no += 1
            restricted = step_no >= max_steps
            if cancel.is_set():
                self._finish_error(conv_id, message_id, job_id, "cancelled", "cancelled", status="cancelled", cost=cost)
                return
            if time.monotonic() > deadline:
                self._finish_error(conv_id, message_id, job_id, f"took longer than {config.ASSISTANT_MESSAGE_TIMEOUT_SECONDS:.0f} s; try a narrower question", "timeout", cost=cost)
                return
            record = StepRecord(index=step_no, model_key=service.profile_model_key("chat"), status="pending")
            progress = _progress(step_no, max_steps, started, cost)
            self._push_progress(conv_id, message_id, job_id, record, progress, step_no, cost, started)
            budgets = [
                BudgetView(scope="message", kind="message", limit_usd=config.ASSISTANT_MESSAGE_BUDGET_USD, spent_usd=cost, remaining_usd=max(0.0, config.ASSISTANT_MESSAGE_BUDGET_USD - cost), exhausted=cost >= config.ASSISTANT_MESSAGE_BUDGET_USD),
                service.chat_budget(meta.run_id),
                service.global_budget(),
            ]
            user_block = prompts.user_message(
                context_chip=chip_text, prefetched=prefetched, memory=memory, retrieved=retrieved, tool_results=tool_results, text=text, nonce=nonce
            )
            metadata = {"fake_script_index": calls_made, "fake_reply": FAKE_DEFAULT_ANSWER, **service.fake_metadata.get("chat", {})}
            try:
                with _ProgressTicker(self, conv_id, message_id, job_id, step_no, max_steps, started, cost):
                    result = service.call_profile(
                        "chat",
                        system=self.system_prompt(restricted=restricted),
                        user=user_block,
                        schema=prompts.step_schema(restricted=restricted),
                        scope=scope,
                        cancel=cancel,
                        budgets=budgets,
                        metadata=metadata,
                        job_id=job_id,
                        conversation_id=conv_id,
                        step=step_no,
                    )
            except BudgetExceeded as exc:
                record.status = "error"
                record.error = str(exc)
                record.error_code = "budget_exhausted"
                self._append_step(conv_id, message_id, record)
                self._finish_error(conv_id, message_id, job_id, str(exc), "budget_exhausted", cost=cost)
                return
            calls_made += 1
            cost += result.cost_usd
            record.cost_usd = result.cost_usd
            record.cache_read_tokens = result.result.usage.cache_read_tokens
            record.finished_at = utc_now_iso()
            record.elapsed_ms = result.result.latency_ms
            if result.result.status != "ok" and result.parsed is None:
                record.status = "cancelled" if result.error_code == "cancelled" else "error"
                record.error = result.error
                record.error_code = result.error_code or result.result.status
                will_repair = result.result.status == "malformed" and not repaired and step_no < max_steps
                if will_repair:
                    record.kind = "repair"
                self._append_step(conv_id, message_id, record)
                if result.error_code == "cancelled":
                    self._finish_error(conv_id, message_id, job_id, "cancelled", "cancelled", status="cancelled", cost=cost)
                    return
                if will_repair:
                    repaired = True
                    tool_results.append(prompts.fence(nonce, {"error": "your last reply was not a JSON object of the step schema; reply again with exactly one object"}, label="validation_error"))
                    continue
                self._finish_error(conv_id, message_id, job_id, result.error or f"model call failed ({result.result.status})", result.error_code or result.result.status, cost=cost)
                return
            try:
                step = parse_step(result.parsed or {}, restricted=restricted)
            except ValidationError as exc:
                record.status = "error"
                record.kind = "repair"
                record.error = "step did not match the schema"
                record.error_code = "schema_mismatch"
                self._append_step(conv_id, message_id, record)
                if not repaired and step_no < max_steps:
                    repaired = True
                    problems = [p.model_dump() for p in briefs.problems_from_validation_error(exc)]
                    tool_results.append(prompts.fence(nonce, {"validation_error": problems, "hint": "reply again with exactly one object of the step schema"}, label="validation_error"))
                    continue
                self._finish_error(conv_id, message_id, job_id, "the model's reply did not match the step schema", "schema_mismatch", cost=cost)
                return
            record.status = "ok"
            record.kind = step.kind
            if isinstance(step, ToolStep):
                note = step.note or "reading the run"
                self._push_progress(conv_id, message_id, job_id, None, _progress(step_no, max_steps, started, cost, note), step_no, cost, started)
                for call in step.calls[: config.ASSISTANT_TOOLS_PER_STEP]:
                    outcome = tools.run_tool(service, call.name, call.args)
                    record.tool_calls.append(ToolCallRecord(name=outcome.name, args=outcome.args, ok=outcome.ok, summary=outcome.summary, truncated=outcome.truncated, error=None if outcome.ok else str(outcome.payload.get("error", "failed")) if isinstance(outcome.payload, dict) else None))
                    tool_results.append(prompts.fence(nonce, {"tool": outcome.name, "args": outcome.args, "ok": outcome.ok, "result": outcome.payload}, label=f"tool:{outcome.name}"))
                    if outcome.ok:
                        sources.extend(s for s in outcome.sources if s not in sources)
                self._append_step(conv_id, message_id, record)
                continue
            self._append_step(conv_id, message_id, record)
            if isinstance(step, AnswerStep):
                self._finish_answer(conv_id, message_id, job_id, step, sources, as_of, cost, chip)
                return
            if isinstance(step, AskStep):
                self._finish_ask(conv_id, message_id, job_id, step, cost)
                return
            if isinstance(step, BriefStep):
                hint = (chip.run_id if chip else None) or meta.run_id
                action, validation = briefs.validate_brief(service, step.brief, run_id_hint=hint)
                # one repair: an action that did not type (the next step may be the restricted
                # one), or a typed action with problems the model can fix (only when the next
                # step may still emit a brief)
                untyped = action is None and step_no < max_steps
                fixable = action is not None and briefs.model_can_fix(action, validation) and step_no + 1 < max_steps
                if (untyped or fixable) and not repaired:
                    repaired = True
                    record.kind = "brief-repair"
                    self._append_step(conv_id, message_id, record)
                    hint_text = "fix action.args and send the corrected brief" if action is None else "the brief failed validation: fix these problems in action.args (entity ids, dotted field paths such as stats.health, overlay keys) and send the corrected brief, or answer/ask if it cannot be done"
                    tool_results.append(prompts.fence(nonce, {"brief_validation_problems": [p.model_dump() for p in validation.problems], "rejected_action": step.brief.action.model_dump(mode="json"), "hint": hint_text}, label="validation_error"))
                    continue
                brief = Brief(
                    brief_id=new_id(),
                    conversation_id=conv_id,
                    message_id=message_id,
                    in_reply_to=text,
                    status="pending" if action is not None else "invalid",
                    title=step.brief.title,
                    summary=step.brief.summary,
                    steps=list(step.brief.steps),
                    warnings=list(step.brief.warnings),
                    action=action.model_dump(mode="json") if action is not None else None,
                    action_raw=step.brief.action.model_dump(mode="json"),
                    action_type=step.brief.action.type,
                    target_run_id=briefs.target_run_of(action) if action is not None else (step.brief.action.args.get("run_id") or hint),
                    merged_request=self._merged_request(action),
                    validation=validation,
                )
                store.put_brief(conv_id, brief)
                store.supersede_pending(conv_id, brief.brief_id)
                self._finish_brief(conv_id, message_id, job_id, brief, cost, as_of)
                return
        self._finish_error(conv_id, message_id, job_id, "no answer after the maximum number of steps", "max_steps", cost=cost)

    # -- finishing ------------------------------------------------------------------------------

    def _merged_request(self, action: Any) -> Optional[dict[str, Any]]:
        if action is None or getattr(action, "type", None) != "create_run":
            return None
        try:
            return briefs.merge_create_run(self.service, action.name, action.agent_count, action.overlay).model_dump(mode="json")
        except ValidationError:
            return None

    def _push_progress(self, conv_id: str, message_id: str, job_id: str, record: Optional[StepRecord], progress: str, step_no: int, cost: float, started: float) -> None:
        def mutate(m: Message) -> None:
            m.status = "running"
            m.progress = progress
            m.cost_usd = cost
            if record is not None and not any(s.index == record.index for s in m.steps):
                m.steps.append(record)

        self.service.store.update_message(conv_id, message_id, mutate)
        self.service.update_job(job_id, step=step_no, elapsed_s=round(time.monotonic() - started, 1), cost_usd=cost, progress=progress)

    def _append_step(self, conv_id: str, message_id: str, record: StepRecord) -> None:
        def mutate(m: Message) -> None:
            for i, existing in enumerate(m.steps):
                if existing.index == record.index:
                    m.steps[i] = record
                    return
            m.steps.append(record)

        self.service.store.update_message(conv_id, message_id, mutate)

    def _settle(self, conv_id: str, message_id: str, job_id: str, mutate: Any, *, tolerate_missing: bool = False, **job_changes: Any) -> None:
        """Final message write, ``meta.active_job_id`` cleared and the job's terminal status, all
        under the conversation lock (the GET route composes its view under the same lock), so a
        poll never sees a finished job with a stale active id."""
        store = self.service.store
        with store.lock(conv_id):
            try:
                store.update_message(conv_id, message_id, mutate)
            except storage.StorageError:
                if not tolerate_missing:
                    raise
            try:
                store.update_meta(conv_id, lambda m: setattr(m, "active_job_id", None) if m.active_job_id == job_id else None)
            except storage.StorageError:
                pass
            self.service.update_job(job_id, **job_changes)

    def _finish_answer(self, conv_id: str, message_id: str, job_id: str, step: AnswerStep, sources: list[str], as_of: Optional[str], cost: float, chip: Optional[ContextChip]) -> None:
        text = step.text.strip()
        if as_of and as_of not in text:
            text = f"{text}\n\nAs of turn {as_of}."
        refs = list(step.refs)
        if as_of and not any(r.kind == "turn" and r.id == as_of for r in refs):
            refs.append(AnswerRef(kind="turn", id=as_of, label=as_of))  # the chip adds the kind

        def mutate(m: Message) -> None:
            m.status = "done"
            m.text = text
            m.refs = refs
            m.sources = list(sources)
            m.as_of_turn_id = as_of
            m.progress = None
            m.cost_usd = cost
            m.error = None

        self._settle(conv_id, message_id, job_id, mutate, status="done", finished_at=utc_now_iso(), cost_usd=cost, progress="")

    def _finish_ask(self, conv_id: str, message_id: str, job_id: str, step: AskStep, cost: float) -> None:
        def mutate(m: Message) -> None:
            m.status = "done"
            m.text = step.text.strip()
            m.ask_options = list(step.options)
            m.progress = None
            m.cost_usd = cost

        self._settle(conv_id, message_id, job_id, mutate, status="done", finished_at=utc_now_iso(), cost_usd=cost, progress="")

    def _finish_brief(self, conv_id: str, message_id: str, job_id: str, brief: Brief, cost: float, as_of: Optional[str]) -> None:
        def mutate(m: Message) -> None:
            m.status = "done"
            m.text = brief.summary
            m.brief_id = brief.brief_id
            m.as_of_turn_id = brief.validation.validated_against_turn_id or as_of
            m.progress = None
            m.cost_usd = cost

        self._settle(conv_id, message_id, job_id, mutate, status="done", finished_at=utc_now_iso(), cost_usd=cost, progress="")

    def _finish_error(self, conv_id: str, message_id: str, job_id: str, error: str, error_code: Optional[str], *, status: str = "error", cost: float = 0.0) -> None:
        def mutate(m: Message) -> None:
            m.status = status  # type: ignore[assignment]
            m.error = error
            m.error_code = error_code
            m.progress = None
            m.cost_usd = cost

        job_status = "cancelled" if status == "cancelled" else ("interrupted" if status == "interrupted" else "error")
        self._settle(conv_id, message_id, job_id, mutate, tolerate_missing=True, status=job_status, error=error, error_code=error_code, finished_at=utc_now_iso(), cost_usd=cost, progress="")

    def _finalize_offline(self, conv_id: str, message_id: str, job_id: str, answer: Message, reason: str) -> None:
        def mutate(m: Message) -> None:
            m.status = "done"
            m.text = answer.text
            m.refs = answer.refs
            m.sources = answer.sources
            m.offline = True
            m.progress = None
            m.error = None
            m.error_code = "model_unavailable"
            m.ask_options = []

        self._settle(conv_id, message_id, job_id, mutate, status="done", finished_at=utc_now_iso(), progress="", error=f"model unavailable: {reason}", error_code="model_unavailable")

    # -- context -------------------------------------------------------------------------------

    @staticmethod
    def _user_message_for(messages: list[Message], assistant_id: str) -> Optional[Message]:
        """The user message right before the assistant message ``assistant_id`` (None when the
        assistant message is not in the list)."""
        previous: Optional[Message] = None
        for m in messages:
            if m.message_id == assistant_id:
                return previous
            if m.role == "user":
                previous = m
        return None

    @staticmethod
    def _chip_text(chip: Optional[ContextChip]) -> Optional[str]:
        if chip is None:
            return None
        parts = [f"page: {chip.page}"]
        if chip.run_id:
            parts.append(f"run: {chip.run_name or ''} ({chip.run_id})".replace("  ", " "))
        if chip.run_state:
            parts.append(f"run state: {chip.run_state}")
        if chip.live_turn_id:
            parts.append(f"live turn: {chip.live_turn_id}")
        if chip.shown_turn_id and chip.shown_turn_id != chip.live_turn_id:
            parts.append(f"viewing history turn: {chip.shown_turn_id}")
        if chip.tab:
            parts.append(f"tab: {chip.tab}")
        if chip.selected_entity_id:
            parts.append(f"selected {chip.selected_entity_kind or 'entity'}: {chip.selected_entity_id}")
        if chip.selected_point:
            parts.append(f"selected point: {chip.selected_point}")
        if chip.last_error:
            parts.append(f"last run error: {chip.last_error[:300]}")
        if chip.story_id:
            parts.append(f"story: {chip.story_id}")
        return "; ".join(parts)

    @staticmethod
    def _as_of(chip: Optional[ContextChip], run_id: Optional[str]) -> Optional[str]:
        if chip is not None and (chip.shown_turn_id or chip.live_turn_id):
            return chip.shown_turn_id or chip.live_turn_id
        if run_id:
            try:
                return storage.read_manifest(run_id).current_turn_id
            except storage.StorageError:
                return None
        return None

    def prefetch_context(self, chip: Optional[ContextChip], *, nonce: Optional[str] = None) -> str:
        """Deterministic step-1 context: run status, viewed turn digest, selected entity dossier,
        last round digest, highlights.  Each part is independent (a failing digest becomes a
        note), everything is nonce-fenced (``nonce`` None -> a fresh one)."""
        if chip is None or not chip.run_id:
            return ""
        nonce = nonce or self._nonce_factory()
        run_id = chip.run_id
        blocks: list[str] = []

        def part(name: str, fn: Any) -> None:
            try:
                payload = fn()
            except NotImplementedError:
                payload = {"note": f"{name} is not available in this build"}
            except Exception as exc:  # noqa: BLE001
                payload = {"error": model.redact(f"{type(exc).__name__}: {exc}", self.service.registry)}
            capped, _ = tools.cap_payload(payload, 3000)
            blocks.append(prompts.fence(nonce, capped, label=name))

        part("run_status", lambda: tools.run_status_payload(self.service, run_id))
        turn_id = chip.shown_turn_id or chip.live_turn_id
        if turn_id:
            def viewed() -> Any:
                try:
                    return digest.turn_digest(run_id, turn_id, max_chars=1500)
                except NotImplementedError:
                    return tools.basic_turn_summary(run_id, turn_id, max_events=25)

            part("viewed_turn", viewed)
        if chip.selected_entity_id and (chip.selected_entity_kind in (None, "agent")):
            part("selected_entity", lambda: digest.agent_dossier(run_id, chip.selected_entity_id, chip.shown_turn_id))
        part("last_round", lambda: digest.last_round_digest(run_id))
        part("highlights", lambda: digest.get_highlights(run_id, limit=8))
        return "\n".join(blocks)

    def _memory_text(self, meta: Any, history: list[Message], current_assistant_id: str) -> str:
        """Rolling summary plus the most recent finished exchanges within MEMORY_TOKEN_BUDGET,
        excluding the current user message and the pending assistant message."""
        current_user = self._user_message_for(history, current_assistant_id)
        skip = {current_assistant_id, current_user.message_id if current_user else ""}
        after_summary = True if not meta.summary_through_message_id else False
        recent: list[tuple[str, str]] = []
        for m in history:
            if meta.summary_through_message_id and m.message_id == meta.summary_through_message_id:
                after_summary = True
                continue
            if not after_summary or m.message_id in skip or m.status not in ("done",):
                continue
            body = m.text
            if m.brief_id:
                body = f"[proposed a brief] {body}"
            if body.strip():
                recent.append((m.role, body))
        recent = recent[-MEMORY_RECENT_MESSAGES:]
        budget = config.MEMORY_TOKEN_BUDGET - config.estimate_tokens(meta.summary or "")
        while recent and sum(config.estimate_tokens(c) for _r, c in recent) > max(200, budget):
            recent.pop(0)
        return memory_block(meta.summary or "", recent)

    def _retrieved_text(self, text: str, chip: Optional[ContextChip]) -> str:
        kb = self.service.knowledge
        if kb is None:
            return ""
        query = text
        if chip is not None:
            query += " " + " ".join(filter(None, [chip.tab, chip.page, chip.selected_entity_kind, chip.run_state]))
        try:
            sections = kb.retrieve(query, token_budget=config.KNOWLEDGE_RETRIEVAL_TOKENS)
        except Exception:  # noqa: BLE001
            return ""
        return "\n\n".join(s.render() for s in sections)

    # -- offline and memory --------------------------------------------------------------------

    def offline_answer(self, text: str) -> Message:
        """Docs-search answer labelled 'Docs search (AI offline)' (no model call)."""
        kb = self.service.knowledge
        sections = kb.search(text, limit=3) if kb is not None else []
        if sections:
            body = "\n\n".join(f"**{s.heading}** ({s.ref})\n{s.text.strip()[:1200]}" for s in sections)
            answer = f"{OFFLINE_LABEL}: no assistant model is available, so here are the documentation sections that match your question.\n\n{body}"
        else:
            answer = f"{OFFLINE_LABEL}: no assistant model is available and no documentation section matched your question."
        return Message(
            message_id=new_id(),
            role="assistant",
            text=answer,
            status="done",
            offline=True,
            refs=[AnswerRef(kind="doc", id=s.ref, label=s.heading) for s in sections],
            sources=[f"docs {s.ref}" for s in sections],
        )

    def _maybe_refresh_memory(self, conv_id: str) -> None:
        service = self.service
        if not service.auto_generation_allowed("summarizer"):
            return
        try:
            meta = service.store.meta(conv_id)
            history = service.store.messages(conv_id)
        except storage.StorageError:
            return
        pending = self._unsummarized(meta, history)
        tokens = sum(config.estimate_tokens(m.text) for m in pending)
        if tokens <= config.MEMORY_TOKEN_BUDGET:
            return
        service.submit("chat", self.refresh_memory, conv_id)

    @staticmethod
    def _unsummarized(meta: Any, history: list[Message]) -> list[Message]:
        out: list[Message] = []
        after = not meta.summary_through_message_id
        for m in history:
            if meta.summary_through_message_id and m.message_id == meta.summary_through_message_id:
                after = True
                continue
            if after and m.status == "done" and m.text.strip():
                out.append(m)
        return out

    def refresh_memory(self, conv_id: str) -> None:
        """Summarizer profile (text mode): fold every finished message after
        ``summary_through_message_id`` except the newest few into ``meta.summary``; counts against
        the conversation's chat scope and the global budget.  Never raises."""
        service = self.service
        try:
            meta = service.store.meta(conv_id)
            history = service.store.messages(conv_id)
            pending = self._unsummarized(meta, history)
            keep_recent = 2
            fold = pending[:-keep_recent] if len(pending) > keep_recent else []
            if not fold:
                return
            transcript = memory_block(meta.summary or "", [(m.role, m.text) for m in fold])
            user = (
                "Fold the quoted conversation into a compact summary (at most 250 words, plain text, keep every turn id, "
                "entity id and run id verbatim, note briefs and their outcome).\n\n" + prompts.fence(prompts.new_nonce(), transcript, label="conversation")
            )
            system = prompts.system_prompt("summarizer", knowledge_core="", tool_catalogue_text="")
            metadata = {"fake_reply": FAKE_DEFAULT_SUMMARY, **service.fake_metadata.get("summarizer", {})}
            result = service.call_profile(
                "summarizer",
                system=system,
                user=user,
                text_mode=True,
                scope=scope_key(meta.run_id),
                budgets=[service.chat_budget(meta.run_id), service.global_budget()],
                metadata=metadata,
                conversation_id=conv_id,
            )
            if not result.ok:
                log.info("memory refresh for %s skipped: %s", conv_id, result.result.status)
                return
            last_id = fold[-1].message_id
            summary = result.text.strip()[:4000]

            def mutate(m: Any) -> None:
                m.summary = summary
                m.summary_through_message_id = last_id

            service.store.update_meta(conv_id, mutate)
        except BudgetExceeded:
            log.info("memory refresh for %s skipped: budget", conv_id)
        except Exception:  # noqa: BLE001
            log.exception("memory refresh for %s failed", conv_id)


__all__ = ["ChatEngine", "FAKE_DEFAULT_ANSWER", "FAKE_DEFAULT_SUMMARY", "OFFLINE_LABEL", "parse_step"]
