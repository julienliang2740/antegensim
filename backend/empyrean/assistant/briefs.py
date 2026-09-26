"""
Execution briefs (rev 4, amended D6, A-AST-9): validation before the card is shown (never opens a
run), the deterministic setup diff and warnings, the approve path (conversation lock, CAS
pending->executing, revalidation, server-side execution, stored idempotent effect) and the
executors per action, including the step_round sequencer job.  Uses ``runner.command_allowed``
and ``runner.validate_intervention_on``.  OWNER: WP2.

Lifecycle: pending -> executing -> executed | failed; pending -> rejected; pending -> superseded
(a newer brief in the same conversation); invalid (the model's args never typed, even after the
repair step; not approvable).  ``Brief.action`` holds the typed action as a dict,
``Brief.validation`` the problems / warnings / setup diff / validated_against_turn_id,
``Brief.effect`` what execution did (returned by every later approve: idempotent).
"""
# DOCS: approval body {validated_against_turn_id}; run_command briefs are approvable only while
# that run is on screen; create_run opens the new run paused and rebinds the conversation;
# interventions get origin 'assistant' and note 'assistant: <summary>'; step_round x N runs as a
# background sequencer job whose progress lands on brief.effect (rounds_done / rounds_requested).

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Any, Optional

from pydantic import TypeAdapter, ValidationError

from .. import config, model, runner, storage
from ..runner import RunnerError, SetupError
from ..schemas import ApiProblem, ContinuationRequest, Intervention, RunCreateRequest, utc_now_iso
from .models import (
    Brief,
    BriefDraft,
    BriefEffect,
    BriefValidation,
    CreateContinuationAction,
    CreateRunAction,
    OpenRunAction,
    RunCommandAction,
    SetupDiffEntry,
    StageInterventionsAction,
    UpdateAssistantSettingsAction,
    action_from_envelope,
    brief_action_adapter,
)
from .store import default_run_settings, read_run_settings, write_run_settings

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService

log = logging.getLogger("empyrean.assistant.briefs")

SEQUENCER_IDLE_TIMEOUT_SECONDS = 600.0  # a round of a live run may take minutes
_IDLE_STATES = ("paused", "finished", "error")
_intervention_adapter: TypeAdapter[Any] = TypeAdapter(Intervention)


class BriefNotPending(Exception):
    """The brief is not in the status the operation expects (409 ``brief_not_pending``)."""

    def __init__(self, brief: Brief, message: str) -> None:
        super().__init__(message)
        self.brief = brief


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def deep_merge(base: Any, overlay: Any) -> Any:
    """Dicts merge recursively, everything else replaces (shared with scripts/run_sim.py)."""
    if isinstance(base, dict) and isinstance(overlay, dict):
        merged = dict(base)
        for key, value in overlay.items():
            merged[key] = deep_merge(base.get(key), value) if key in base else value
        return merged
    return overlay


def _loc_path(loc: tuple[Any, ...]) -> str:
    path = ""
    for part in loc:
        if isinstance(part, int):
            path += f"[{part}]"
        else:
            path += ("." if path else "") + str(part)
    return path


_UNION_TAGS = frozenset(
    {"create_run", "run_command", "stage_interventions", "create_continuation", "open_run", "update_assistant_settings",
     "set_stat", "place_entity", "remove_entity", "edit_knowledge", "voice", "update_context_settings", "update_plant_rules",
     "update_prices", "update_model_assignment", "update_run_settings", "apply_working_files", "agents", "broadcast_all", "at_point"}
)


def problems_from_validation_error(exc: ValidationError, prefix: str = "") -> list[ApiProblem]:
    """pydantic errors -> ApiProblems with paths like ``interventions[1].entity_id`` (the
    discriminated-union tags pydantic puts in ``loc`` are dropped)."""
    out: list[ApiProblem] = []
    for err in exc.errors():
        loc = tuple(p for p in err.get("loc", ()) if not (isinstance(p, str) and (p.startswith("function-after") or p in _UNION_TAGS)))
        path = _loc_path(loc)
        if prefix:
            path = f"{prefix}.{path}" if path else prefix
        out.append(ApiProblem(path=path, message=str(err.get("msg", "invalid"))))
    return out or [ApiProblem(path=prefix, message="invalid")]


def _flatten(value: Any, path: str, out: dict[str, Any]) -> None:
    if isinstance(value, dict):
        if not value:
            out[path] = value
        for key, item in value.items():
            _flatten(item, f"{path}.{key}" if path else str(key), out)
    elif isinstance(value, list):
        if not value:
            out[path] = value
        for i, item in enumerate(value):
            _flatten(item, f"{path}[{i}]", out)
    else:
        out[path] = value


def _is_fake_key(service: "AssistantService", key: Optional[str]) -> bool:
    if not key:
        return True
    try:
        return service.registry.get(key).provider == "fake"
    except model.UnknownModelError:
        return True


# ---------------------------------------------------------------------------
# create_run merge and diff
# ---------------------------------------------------------------------------


def merge_create_run(service: "AssistantService", name: str, agent_count: int, overlay: dict[str, Any]) -> RunCreateRequest:
    """``config.default_run_request(DEFAULT_MODEL_KEY, agent_count)`` + overlay (dicts merge,
    everything else replaces; agent cards merge by index onto the default cards, extra cards
    are dropped).  Raises ``pydantic.ValidationError`` for a shape problem."""
    base = config.default_run_request(config.DEFAULT_MODEL_KEY, agent_count).model_dump(mode="json")
    overlay = dict(overlay or {})
    cards_overlay = overlay.pop("agents", None)
    merged = deep_merge(base, overlay)
    merged["name"] = name
    if isinstance(cards_overlay, list):
        cards = list(base["agents"])
        for i, card in enumerate(cards_overlay[:agent_count]):
            if isinstance(card, dict):
                cards[i] = deep_merge(cards[i], card)
        merged["agents"] = cards
    elif cards_overlay is not None:
        merged["agents"] = cards_overlay  # a non-list: let validation report it
    return RunCreateRequest.model_validate(merged)


def setup_diff(request: RunCreateRequest) -> list[SetupDiffEntry]:
    """Non-default fields vs ``config.default_run_request`` for the same agent count (paths
    like ``agents[2].stats.attack``, ``rules.prices.move``).  ``name`` is included."""
    default = config.default_run_request(config.DEFAULT_MODEL_KEY, len(request.agents)).model_dump(mode="json")
    current = request.model_dump(mode="json")
    flat_default: dict[str, Any] = {}
    flat_current: dict[str, Any] = {}
    _flatten(default, "", flat_default)
    _flatten(current, "", flat_current)
    out: list[SetupDiffEntry] = []
    for path in sorted(set(flat_default) | set(flat_current)):
        d = flat_default.get(path)
        c = flat_current.get(path)
        if d != c:
            out.append(SetupDiffEntry(path=path, default=d, value=c))
    return out


# ---------------------------------------------------------------------------
# Validation (never opens a run)
# ---------------------------------------------------------------------------


def _checkpoint_for(service: "AssistantService", run_id: str) -> Any:
    worker = service.manager.get(run_id)
    if worker is not None:
        return worker.checkpoint
    return storage.load_checkpoint(run_id)


def _run_state(service: "AssistantService", run_id: str) -> tuple[str, bool, Any]:
    """(state, open, manifest) without opening anything."""
    worker = service.manager.get(run_id)
    if worker is not None:
        return worker.status().state, True, worker.manifest
    manifest = storage.read_manifest(run_id)
    return ("finished" if manifest.finished else "paused"), False, manifest


def _model_warnings(service: "AssistantService", key: Optional[str], *, real_budget: Optional[float], spent: Optional[float]) -> list[str]:
    if _is_fake_key(service, key):
        return []
    lines = [f"Agents use model {key}: a live model, every decision is a paid call."]
    if real_budget is None:
        lines.append("No real_budget_usd is set on the run: nothing stops spend except Pause.")
    if spent is not None:
        lines.append(f"Spent so far on this run: ${spent:.2f}.")
    return lines


def prepared_intervention(iv: Any, summary: str) -> Intervention:
    """The intervention as it will be staged: ids stripped, origin 'assistant', note prefixed."""
    note = f"assistant: {summary.strip()[:200]}" if summary.strip() else "assistant"
    data = iv.model_dump(mode="json")
    data.pop("id", None)
    data.pop("created_at", None)
    data["origin"] = "assistant"
    data["note"] = note
    return _intervention_adapter.validate_python(data)


def validate_brief(service: "AssistantService", draft: BriefDraft, *, run_id_hint: Optional[str]) -> tuple[Optional[Any], BriefValidation]:
    """Envelope -> typed action (or None with the problems) -> deterministic problems, warnings
    (paid model, no budget, spend so far, closed run) and setup diff.  Never opens a run (the
    open worker's committed checkpoint, else ``storage.load_checkpoint`` read-only).  A run_id
    missing from the args is filled from ``run_id_hint`` (the run on screen)."""
    validation = BriefValidation()
    args = dict(draft.action.args)
    if draft.action.type != "create_run" and not args.get("run_id") and run_id_hint:
        args["run_id"] = run_id_hint
    envelope = draft.action.model_copy(update={"args": args})
    try:
        action = action_from_envelope(envelope)
    except ValidationError as exc:
        validation.ok = False
        validation.problems = problems_from_validation_error(exc, "action")
        validation.validated_at = utc_now_iso()
        return None, validation
    problems: list[ApiProblem] = []
    warnings: list[str] = []
    against: Optional[str] = None
    try:
        if isinstance(action, CreateRunAction):
            try:
                request = merge_create_run(service, action.name, action.agent_count, action.overlay)
            except ValidationError as exc:
                problems.extend(problems_from_validation_error(exc, "overlay"))
            else:
                problems.extend(service.manager.validate_setup(request))
                validation.setup_diff = setup_diff(request)
                warnings.extend(_model_warnings(service, request.default_model_key, real_budget=request.real_budget_usd, spent=None))
                for i, card in enumerate(request.agents):
                    if card.model_key and not _is_fake_key(service, card.model_key) and card.model_key != request.default_model_key:
                        warnings.append(f"agents[{i}] ({card.name}) uses live model {card.model_key}.")
        elif isinstance(action, RunCommandAction):
            state, is_open, manifest = _run_state(service, action.run_id)
            against = manifest.current_turn_id
            reason = runner.command_allowed(state, action.command)
            if reason is not None:
                problems.append(ApiProblem(path="command", message=f"{reason} (the run is {state})"))
            if not is_open:
                warnings.append("The run is not open in this process; approval opens it first.")
            if manifest.finished and action.command != "pause":
                warnings.append("The run is finished: a run command applies staged edits and re-checks the finish condition.")
            if action.command in ("play", "run_turn", "step_round"):
                cp = _checkpoint_for(service, action.run_id)
                keys = {cp.settings.default_model_key, *cp.settings.model_overrides.values()}
                paid = sorted(k for k in keys if not _is_fake_key(service, k))
                if paid:
                    warnings.extend(_model_warnings(service, paid[0], real_budget=cp.settings.real_budget_usd, spent=manifest.real_usage.provider_cost_usd))
                    if action.command == "play":
                        warnings.append("play runs until Pause, the finish condition or the real budget; step_round with rounds is bounded.")
        elif isinstance(action, StageInterventionsAction):
            cp = _checkpoint_for(service, action.run_id)
            against = cp.turn.turn_id
            for i, iv in enumerate(action.interventions):
                for p in runner.validate_intervention_on(cp, service.registry, action.run_id, prepared_intervention(iv, draft.summary)):
                    problems.append(ApiProblem(path=f"interventions[{i}].{p.path}" if p.path else f"interventions[{i}]", message=p.message))
                key = getattr(iv, "model_key", None)
                if key and not _is_fake_key(service, key):
                    warnings.append(f"interventions[{i}] assigns live model {key} (paid calls).")
            if service.manager.get(action.run_id) is None:
                warnings.append("The run is not open in this process; approval opens it first.")
        elif isinstance(action, CreateContinuationAction):
            _state, _open, manifest = _run_state(service, action.run_id)
            against = manifest.current_turn_id
            ids = {e.turn_id for e in storage.list_turns(action.run_id)}
            if action.from_turn_id not in ids:
                problems.append(ApiProblem(path="from_turn_id", message=f"{action.from_turn_id} is not a committed turn of {action.run_id}"))
        elif isinstance(action, (OpenRunAction, UpdateAssistantSettingsAction)):
            _state, _open, manifest = _run_state(service, action.run_id)
            against = manifest.current_turn_id
    except storage.StorageError as exc:
        problems.append(ApiProblem(path="run_id", message=model.redact(f"unknown run: {exc}", service.registry) or "unknown run"))
    except RunnerError as exc:
        problems.append(ApiProblem(path="run_id", message=str(exc)))
    validation.problems = problems
    validation.warnings = warnings
    validation.ok = not problems
    validation.validated_against_turn_id = against
    validation.validated_at = utc_now_iso()
    return action, validation


def target_run_of(action: Any) -> Optional[str]:
    return getattr(action, "run_id", None)


# ---------------------------------------------------------------------------
# Approve / reject
# ---------------------------------------------------------------------------


def approve_brief(service: "AssistantService", conv_id: str, brief_id: str, validated_against_turn_id: Optional[str]) -> Brief:
    """Under the conversation lock: CAS pending->executing (``BriefNotPending`` otherwise;
    an already executed brief is returned as is), revalidate against the current committed
    state (new problems -> back to pending with them), execute, store the effect."""
    store = service.store
    with store.lock(conv_id):
        brief = store.brief(conv_id, brief_id)
        if brief.status == "executed" and brief.effect is not None:
            return brief  # idempotent retry
        if brief.status != "pending":
            raise BriefNotPending(brief, f"brief is {brief.status}, not pending")
        if brief.action is None or not brief.validation.ok:
            raise BriefNotPending(brief, "brief has validation problems and cannot be approved")
        moved = store.cas_brief(conv_id, brief_id, "pending", lambda b: setattr(b, "status", "executing"))
        if moved is None:
            raise BriefNotPending(brief, "brief is no longer pending")
        brief = moved
        draft = BriefDraft(
            title=brief.title or "brief",
            summary=brief.summary,
            steps=list(brief.steps)[:12],
            warnings=list(brief.warnings)[:12],
            action={"type": brief.action_raw.get("type", brief.action.get("type")), "args": brief.action_raw.get("args", {})},
        )
        action, validation = validate_brief(service, draft, run_id_hint=brief.target_run_id)
        if action is None or not validation.ok:
            validation.warnings = list(validation.warnings) + ["Revalidated at approval: the run changed since the brief was shown."]

            def back(b: Brief) -> None:
                b.status = "pending"
                b.validation = validation
                b.error = "revalidation found problems; review the brief"

            return store.cas_brief(conv_id, brief_id, "executing", back) or brief
        if validated_against_turn_id and validation.validated_against_turn_id and validated_against_turn_id != validation.validated_against_turn_id:
            validation.warnings = list(validation.warnings) + [
                f"The run advanced from {validated_against_turn_id} to {validation.validated_against_turn_id} before approval; the brief was revalidated against the newer state."
            ]
        brief.validation = validation
        brief.action = action.model_dump(mode="json")
        try:
            effect = execute_action(service, brief)
        except SetupError as exc:
            problems = exc.problems

            def failed_setup(b: Brief) -> None:
                b.status = "failed"
                b.error = "; ".join(f"{p.path}: {p.message}" for p in problems)[:500] or "invalid setup"
                b.validation = validation.model_copy(update={"ok": False, "problems": problems})

            return store.cas_brief(conv_id, brief_id, "executing", failed_setup) or brief
        except Exception as exc:  # noqa: BLE001 - the brief records the failure
            message = model.redact(f"{type(exc).__name__}: {exc}", service.registry) or "execution failed"
            log.warning("brief %s failed: %s", brief_id, message)

            def failed(b: Brief) -> None:
                b.status = "failed"
                b.error = message
                b.validation = validation

            return store.cas_brief(conv_id, brief_id, "executing", failed) or brief

        def done(b: Brief) -> None:
            b.status = "executed"
            b.effect = effect
            b.error = None
            b.validation = validation
            b.action = action.model_dump(mode="json")

        result = store.cas_brief(conv_id, brief_id, "executing", done) or brief
        new_run = effect.run_id if isinstance(action, (CreateRunAction, OpenRunAction, CreateContinuationAction)) else None
        if new_run:
            store.update_meta(conv_id, lambda m: setattr(m, "run_id", new_run))
        return result


def reject_brief(service: "AssistantService", conv_id: str, brief_id: str, reason: str = "") -> Brief:
    """pending -> rejected (``BriefNotPending`` when it is not pending)."""
    store = service.store
    with store.lock(conv_id):
        brief = store.brief(conv_id, brief_id)

        def rejected(b: Brief) -> None:
            b.status = "rejected"
            b.reject_reason = reason[:500]

        moved = store.cas_brief(conv_id, brief_id, "pending", rejected)
        if moved is None:
            raise BriefNotPending(brief, f"brief is {brief.status}, not pending")
        return moved


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------


def _typed(brief: Brief) -> Any:
    if not isinstance(brief.action, dict):
        raise ValueError("brief has no typed action")
    return brief_action_adapter.validate_python(brief.action)


def execute_action(service: "AssistantService", brief: Brief) -> BriefEffect:
    """create_run (opens paused), run_command (+ sequencer job for rounds), stage_interventions
    (origin 'assistant', all-or-nothing), create_continuation, update_assistant_settings;
    open_run is UI-only.  Raises on failure (the caller marks the brief failed)."""
    action = _typed(brief)
    if isinstance(action, CreateRunAction):
        request = merge_create_run(service, action.name, action.agent_count, action.overlay)
        summary = service.manager.create_run(request)
        service.notify_run_created(summary.run_id, request)
        worker = service.manager.get(summary.run_id)
        return BriefEffect(
            run_id=summary.run_id,
            run_summary=summary,
            status=worker.status() if worker is not None else None,
            message=f"Created run {summary.name} ({summary.run_id}), paused at {summary.current_turn_id}; nothing is spent until it is played.",
            executed_at=utc_now_iso(),
        )
    if isinstance(action, RunCommandAction):
        worker = service.manager.get(action.run_id) or service.manager.open_run(action.run_id)
        status = worker.submit(action.command)
        rounds = action.rounds if action.command == "step_round" and action.rounds else None
        effect = BriefEffect(
            run_id=action.run_id,
            status=status,
            rounds_requested=rounds,
            rounds_done=0 if rounds else None,
            message=f"Sent {action.command}" + (f" (round 1/{rounds})" if rounds else "") + f" to {action.run_id}.",
            executed_at=utc_now_iso(),
        )
        if rounds and rounds > 1:
            _start_sequencer(service, brief, rounds)
        return effect
    if isinstance(action, StageInterventionsAction):
        worker = service.manager.get(action.run_id) or service.manager.open_run(action.run_id)
        prepared = [prepared_intervention(iv, brief.summary) for iv in action.interventions]
        cp = worker.checkpoint
        problems: list[ApiProblem] = []
        for i, iv in enumerate(prepared):
            for p in runner.validate_intervention_on(cp, service.registry, action.run_id, iv):
                problems.append(ApiProblem(path=f"interventions[{i}].{p.path}" if p.path else f"interventions[{i}]", message=p.message))
        if problems:
            raise SetupError(problems)
        staged_ids: list[str] = []
        try:
            for iv in prepared:
                staged = worker.stage_intervention(iv)
                staged_ids.append(staged.id or "")
        except Exception:
            for iv_id in staged_ids:
                try:
                    worker.unstage(iv_id)
                except Exception:  # noqa: BLE001 - best effort rollback
                    log.warning("could not unstage %s after a failed brief", iv_id)
            raise
        return BriefEffect(
            run_id=action.run_id,
            status=worker.status(),
            staged_ids=staged_ids,
            message=f"Staged {len(staged_ids)} edit(s) (origin assistant). They apply when the next turn starts.",
            executed_at=utc_now_iso(),
        )
    if isinstance(action, CreateContinuationAction):
        summary = service.manager.create_continuation(action.run_id, ContinuationRequest(from_turn_id=action.from_turn_id, name=action.name))
        worker = service.manager.get(summary.run_id)
        return BriefEffect(
            run_id=summary.run_id,
            run_summary=summary,
            status=worker.status() if worker is not None else None,
            message=f"Created continuation {summary.name} ({summary.run_id}) from {action.from_turn_id}, paused.",
            executed_at=utc_now_iso(),
        )
    if isinstance(action, OpenRunAction):
        summary = service.manager.get_summary(action.run_id)
        return BriefEffect(run_id=action.run_id, run_summary=summary, message=f"Open {summary.name} in the UI.", executed_at=utc_now_iso())
    if isinstance(action, UpdateAssistantSettingsAction):
        settings = read_run_settings(service.paths, action.run_id) or default_run_settings()
        changes: list[str] = []
        if action.storybook_auto is not None and action.storybook_auto != settings.storybook_auto:
            settings.storybook_auto = action.storybook_auto
            if action.storybook_auto:
                settings.auto_since_turn_id = storage.read_manifest(action.run_id).current_turn_id
            changes.append(f"storybook auto {'on' if action.storybook_auto else 'off'}")
        if action.chat_budget_usd is not None:
            settings.chat_budget_usd = action.chat_budget_usd
            changes.append(f"chat budget ${action.chat_budget_usd:.2f}")
        if action.storybook_budget_usd is not None:
            settings.storybook_budget_usd = action.storybook_budget_usd
            changes.append(f"storybook budget ${action.storybook_budget_usd:.2f}")
        settings.updated_at = utc_now_iso()
        write_run_settings(service.paths, action.run_id, settings)
        storybook = getattr(service, "storybook", None)
        if storybook is not None and hasattr(storybook, "wake"):
            try:
                storybook.wake(action.run_id)
            except Exception:  # noqa: BLE001
                log.exception("storybook wake failed for %s", action.run_id)
        return BriefEffect(run_id=action.run_id, message="Updated assistant settings: " + (", ".join(changes) or "nothing changed") + ".", executed_at=utc_now_iso())
    raise ValueError(f"unsupported action {type(action).__name__}")


def _start_sequencer(service: "AssistantService", brief: Brief, rounds: int) -> None:
    """Background job: after each round settles, submit the next ``step_round`` while the round
    actually advanced (a user pause, an error or a finished run stops it); progress lands on the
    brief's effect (``rounds_done``, message 'round k/N') and on the job."""
    run_id = brief.target_run_id or (brief.action or {}).get("run_id")
    job = service.new_job("sequencer", conversation_id=brief.conversation_id, run_id=run_id, max_steps=rounds)
    service.update_job(job.job_id, status="running", started_at=utc_now_iso(), step=1, progress=f"round 1/{rounds}")
    cancel = service.cancel_event(job.job_id)

    def update_effect(done: int, message: str) -> None:
        def mutate(b: Brief) -> None:
            if b.effect is None:
                b.effect = BriefEffect(run_id=run_id)
            b.effect.rounds_done = done
            b.effect.message = message
            worker = service.manager.get(run_id) if run_id else None
            if worker is not None:
                b.effect.status = worker.status()

        try:
            service.store.cas_brief(brief.conversation_id, brief.brief_id, "executed", mutate)
        except storage.StorageError:
            pass

    def wait_idle(worker: Any) -> Any:
        deadline = time.monotonic() + SEQUENCER_IDLE_TIMEOUT_SECONDS
        while time.monotonic() < deadline and not cancel.is_set() and not service.is_shut_down:
            status = worker.status()
            if status.state in _IDLE_STATES and status.active_command is None and not status.play_loop:
                return status
            time.sleep(0.05)
        return worker.status()

    def run() -> None:
        done = 0
        try:
            worker = service.manager.get(run_id) if run_id else None
            if worker is None:
                raise RunnerError("run_not_open")
            for k in range(1, rounds + 1):
                status = wait_idle(worker)
                stopped = cancel.is_set() or service.is_shut_down or status.state == "error" or not status.current_turn_id.endswith("_end")
                if stopped:
                    reason = "cancelled" if cancel.is_set() else ("error" if status.state == "error" else "paused before the round end")
                    update_effect(done, f"Stopped after {done}/{rounds} rounds ({reason}{': ' + status.last_error if status.last_error else ''}).")
                    service.update_job(job.job_id, status="cancelled" if cancel.is_set() else "done", finished_at=utc_now_iso(), progress=f"stopped at round {done}/{rounds}")
                    return
                done = k
                update_effect(done, f"round {done}/{rounds} done." if done < rounds else f"Stepped {rounds} rounds.")
                service.update_job(job.job_id, step=done, progress=f"round {done}/{rounds}")
                if done >= rounds:
                    break
                if status.state == "finished" and status.finished_reason:
                    update_effect(done, f"Run finished after {done}/{rounds} rounds ({status.finished_reason}).")
                    break
                if runner.command_allowed(status.state, "step_round") is not None:
                    update_effect(done, f"Stopped after {done}/{rounds} rounds (run is {status.state}).")
                    break
                worker.submit("step_round")
            service.update_job(job.job_id, status="done", finished_at=utc_now_iso())
        except Exception as exc:  # noqa: BLE001
            message = model.redact(f"{type(exc).__name__}: {exc}", service.registry) or "sequencer failed"
            log.warning("sequencer for brief %s stopped: %s", brief.brief_id, message)
            update_effect(done, f"Stopped after {done}/{rounds} rounds: {message}")
            service.update_job(job.job_id, status="error", error=message, finished_at=utc_now_iso())

    if service.submit("sequencer", run) is None:
        service.update_job(job.job_id, status="interrupted", finished_at=utc_now_iso())


__all__ = [
    "BriefNotPending",
    "approve_brief",
    "deep_merge",
    "execute_action",
    "merge_create_run",
    "prepared_intervention",
    "problems_from_validation_error",
    "reject_brief",
    "setup_diff",
    "target_run_of",
    "validate_brief",
]
