"""
Simulation runner: one authoritative worker thread per open run.
OWNER: engine/storage team.

Owns
----
* The status machine ``paused | running | pause_requested | turn_active |
  waiting_model | error | finished`` and the commands ``run_turn | play |
  pause | step_round`` (docs/INTERFACES.md section 3, spec "Sessions and run
  controls").
* Turn orchestration exactly as documented in docs/INTERFACES.md section 8:
  apply staged edits at the boundary BEFORE a new round's initiative is
  established (spec "Turn orchestration" step 1), pick the
  next scheduled agent, resume a skill or build a packet and call
  ``model.call_model``, run the format gate, process skill saves/deletes and
  the notebook, execute exactly one world action through ``world.apply_action``,
  deliver notices and feedback to ``context``, then commit through ``storage``.
* Round-end processing (``world.end_round``) as its own committed checkpoint.
* Assigning event sequence numbers, turn ids, packet ids, call ids and
  intervention ids.
* Recording the pending model call BEFORE the call and rewriting it with the
  result right after; carrying interrupted/failed call records into the next
  committed turn; the run-level real-usage ledger and the real budget check
  (design "Compute metering": reservation, charge measured usage, release).
  A call's usage enters ``manifest.real_usage`` only in the commit that holds
  its record (the ledger on disk always equals the sum over the committed
  records; ``RunStatus.real_usage`` adds the uncommitted records on top), so
  staging or reloading while a call is uncommitted, and a later recovery of its
  pending file, can never count it twice (spec "avoid duplicate usage
  accounting").
* Reservation and charging of cognition cost (and ``uncharged_compute``).
* Staging interventions (in memory under the lock, persisted to
  ``staged_edits.json``), the working/ reload, effective settings views.
* An in-memory ring buffer of recent events for the live feed.
* Commit listeners (rev 4): ``RunManager.add_commit_listener(cb)`` registers
  ``cb(run_id, turn_id, kind, round)``; the worker calls the manager's fan-out at
  the very end of ``_commit`` (after the checkpoint swap and ``_work = None``),
  on the worker thread, wrapped in try/except so a listener can never fail or
  un-commit a turn.  Listeners only set a flag or submit to an executor.  The
  init turn and a continuation's first turn never pass through ``_commit``.
* Pure helpers other modules reuse without a worker (rev 4):
  ``command_allowed(state, command)`` (the submit rule) and
  ``validate_intervention_on(checkpoint, registry, run_id, iv)`` (the staging
  validation, against any committed checkpoint, so an assistant brief can be
  validated without opening the run).

Must not
--------
* Contain rule arithmetic (prices, damage, growth): that is world.py.
* Build packets, rank memories or derive believed self state: context.py.
* Call provider SDKs: only model.py.
* Write files except through storage.py.
* Run two turns concurrently for one run, or let API threads mutate state.

Copy strategy and threading contract
------------------------------------
``RunWorker`` owns a single worker thread that pops commands from a queue.
The worker always works on a DEEP COPY of ``self.checkpoint`` taken at turn
start; commit swaps the reference under ``self._lock``.  The committed object
is never mutated, so API threads take the reference under the lock and
serialise outside it.  A failed turn's partial effects are discarded with the
copy.  API threads call only ``submit``, ``status``, ``live_view``,
``events_since``, ``pending_model_call_view``, ``stage_intervention``,
``staged``, ``unstage``, ``reload_working``, ``effective_settings``,
``knowledge`` and ``close``.  Illegal commands raise ``RunnerError``.

Two locks: ``self._lock`` (an RLock) guards every in-memory field that API
threads read and is only ever held briefly; ``self._io_lock`` serialises the
few file writes that the worker (commit) and API threads (staging, reload)
share, so the manifest's intervention counter is never lost to a race.

Error state
-----------
Any exception inside a turn, a provider failure after retries (A-COG-5), or
the real budget being reached (A-COG-7) puts the run in ``error`` with
``last_error`` and an ``error`` event (traceback excerpt redacted, a few
lines).  ``pause`` from ``error`` -> ``paused``: the working copy is
discarded and the next turn restarts from the last committed checkpoint
(same turn id, model call ids continue numbering).  ``last_error`` stays in
``RunStatus`` until the next successful commit.  Staged edits that the failed
attempt had already popped are put back so the operator's edits survive.
A call the failed attempt had already charged was charged on the discarded
copy only: its carried record is rewritten to ``failed`` with the measured
cost as ``uncharged_compute`` and its completed/charged events are replaced
by one ``model_call_failed`` (costs 0), so the committed history never reports
cognition the agent did not pay.
"""

from __future__ import annotations

import copy
import json
import logging
import math
import queue
import random
import threading
import traceback
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from . import config, context, model, skills, storage, world
from .schemas import (
    INFRA_STATUSES,
    ActionRequest,
    ActionResult,
    Agent,
    AgentCard,
    AgentKnowledgeView,
    ApiProblem,
    ApplyWorkingFilesIntervention,
    Checkpoint,
    ContextLimits,
    ContinuationRequest,
    DecisionPacketRecord,
    EffectiveSettingsView,
    EntitiesView,
    Event,
    EventCosts,
    FieldChange,
    Intervention,
    InterventionRecord,
    KnowledgeRecord,
    Manifest,
    MapState,
    ModelCallRecord,
    ModelCallSummary,
    ModelRequest,
    ModelResult,
    ParentRef,
    PendingModelCall,
    PendingModelCallView,
    RealUsageLedger,
    ReloadResponse,
    RunCommand,
    RunCreateRequest,
    RunSettings,
    RunStatus,
    RunSummary,
    SchedulerState,
    SkillEnv,
    SkillExecutionState,
    StagedEdits,
    TurnId,
    TurnRecord,
    TurnView,
    WorldPreviewRequest,
    WorldState,
    decision_json_schema,
    utc_now_iso,
)

log = logging.getLogger("empyrean.runner")

PROVIDER_FAILURE_PREFIX = "provider failure: "
HOST_BUDGET_MESSAGE = "host budget exhausted"
INTERRUPTED_MESSAGE = "interrupted (outcome uncertain)"
DISCARDED_CHARGE_MESSAGE = "turn failed after the call; charge discarded"
UNSERIALIZABLE_REPLY_NOTE = "reply dropped: it could not be stored"
TRACEBACK_EXCERPT_LINES = 5

# Content keys that only the runner's own feedback records carry (cognition charge,
# op-budget yields, skill rejections, invalid decisions, ...).  Such "system" records are
# disclosures about the agent's own last decision, not arrivals, so they never count for
# the A-SKILL-9 interrupt check (only messages, damage, voice and transfers received do).
RUNNER_FEEDBACK_CONTENT_KEYS: tuple[str, ...] = ("cognition_charged", "reason", "skill")

# Event kinds of a failed attempt that are carried into the re-run of the same turn id
# (INTERFACES section 8 "Recovery": the call record and its events; the error event).
CARRIED_EVENT_KINDS: tuple[str, ...] = (
    "model_call_pending",
    "model_call_completed",
    "model_call_failed",
    "cognition_charged",
    "error",
)
WORLD_INTERVENTION_TYPES: tuple[str, ...] = (
    "set_stat",
    "place_entity",
    "remove_entity",
    "update_plant_rules",
    "update_prices",
)
RUN_COMMANDS: tuple[str, ...] = ("run_turn", "play", "step_round")
IDLE_STATES: tuple[str, ...] = ("paused", "finished", "error")


class RunnerError(Exception):
    """Illegal command for the current state, unknown run, or run not open."""


class NotFoundError(Exception):
    """A run-scoped object (agent, staged intervention, call) does not exist (404)."""


class SetupError(Exception):
    """Invalid run setup or intervention; ``problems`` carries every problem with a path."""

    def __init__(self, problems: list[ApiProblem]) -> None:
        super().__init__("; ".join(f"{p.path}: {p.message}" for p in problems) or "invalid")
        self.problems = problems


class _TurnFailure(Exception):
    """A turn ended in the ``error`` state for a documented reason (provider failure,
    host budget); no traceback excerpt is recorded for these."""


class _InterventionRejected(Exception):
    """An intervention could not be applied at the boundary; recorded with ok=False."""


# ---------------------------------------------------------------------------
# Small pure helpers
# ---------------------------------------------------------------------------


def _call_index(call_id: str) -> int:
    """The ``n`` of ``mc_{turn_id}_{n:02d}`` (0 when unparsable)."""
    tail = call_id.rsplit("_", 1)[-1]
    return int(tail) if tail.isdigit() else 0


def _fmt(value: float) -> str:
    """Compact deterministic number for event summaries."""
    return f"{value:.4g}"


def add_record_to_ledger(ledger: RealUsageLedger, record: ModelCallRecord, interrupted: bool = False) -> None:
    """Add one call record's real usage to ``ledger`` in place.  Every record counts in
    ``calls`` (every request the provider may have billed); an interrupted record (a
    pending call recovered on open) ALSO counts in ``interrupted_calls``, which is
    therefore a subset of ``calls`` — the same rule as ``storage.add_call_usage``, so the
    UI's "N calls (M interrupted)" reads as it says.  Billed input/output tokens and the
    reported provider cost are added always.  Called exactly once per record, in the
    commit that holds it."""
    ledger.calls += 1
    if interrupted:
        ledger.interrupted_calls += 1
    result = record.result
    if result is not None:
        ledger.input_tokens += result.usage.billed_input_tokens
        ledger.output_tokens += result.usage.output_tokens
        ledger.provider_cost_usd += result.provider_cost_usd or 0.0


def boundary_of(round_no: int, order: list[str], next_index: int) -> tuple[str, Optional[int], Optional[str], str]:
    """``(kind, turn_index, agent_id, turn_id)`` of the boundary at scheduler position
    ``next_index``: the next scheduled agent's turn, or the round-end turn when every
    slot of the round is used (INTERFACES section 3 turn ids)."""
    if next_index < len(order):
        agent_id = order[next_index]
        return "agent_turn", next_index + 1, agent_id, TurnId.agent_turn(round_no, next_index + 1, agent_id)
    return "round_end", None, None, TurnId.round_end(round_no)


def is_runner_feedback(record: KnowledgeRecord) -> bool:
    """A system record the runner wrote about the agent's own last decision (see
    ``RUNNER_FEEDBACK_CONTENT_KEYS``); excluded from the A-SKILL-9 interrupt check."""
    return record.kind == "system" and any(key in record.content for key in RUNNER_FEEDBACK_CONTENT_KEYS)


def _json_serializable(record: ModelCallRecord) -> bool:
    """True when storage could write the record (valid JSON, UTF-8, bounded nesting)."""
    try:
        json.dumps(record.model_dump(mode="json"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, RecursionError, UnicodeEncodeError):
        return False
    return True


# Scalar decision arguments are labelled by key in summaries so a bare number never
# appears unexplained ("attack a03 budget 5", "recover budget 10", "wait 2 rounds").
_ARG_LABELS: dict[str, str] = {
    "compute_budget": "budget {}",
    "rounds": "{} rounds",
    "recipient": "to {}",
    "page": "page {}",
    "amount": "{}",
}
THOUGHT_EXCERPT_CHARS = 80


def _describe_action(name: str, args: dict[str, Any]) -> str:
    """One deterministic phrase for summaries, e.g. ``observe (0,1)``, ``move up``,
    ``attack a03 budget 5``.  Points print as ``(x,y)``, messages quoted and cut, lists in
    brackets; scalar arguments are labelled by key (``_ARG_LABELS``) and a default
    ``page 0`` is left out."""
    parts: list[str] = []
    for key, value in args.items():
        if isinstance(value, dict) and set(value) == {"x", "y"}:
            parts.append(f"({value['x']},{value['y']})")
        elif isinstance(value, str) and key in ("message",):
            parts.append(f'"{value[:30]}"')
        elif isinstance(value, list):
            parts.append("[" + ",".join(str(v) for v in value) + "]")
        elif key == "page" and value == 0:
            continue
        else:
            parts.append(_ARG_LABELS.get(key, "{}").format(value))
    return f"{name} {' '.join(parts)}".strip()


def _excerpt(text: str, limit: int = THOUGHT_EXCERPT_CHARS) -> str:
    """The first ``limit`` characters of ``text`` cut at a word boundary, with an ellipsis
    when anything was left out (summaries quote the agent's thought)."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    if space >= limit // 2:
        cut = cut[:space]
    return cut.rstrip() + "…"


def model_call_summary(record: ModelCallRecord) -> ModelCallSummary:
    """The index entry a turn view shows for one call (no request body)."""
    result = record.result
    return ModelCallSummary(
        call_id=record.call_id,
        agent_id=record.agent_id,
        model_key=record.model_key,
        provider=record.provider,
        model_id=record.model_id,
        response_model=result.response_model if result else None,
        status=record.status,
        result_status=result.status if result else None,
        input_tokens=result.usage.billed_input_tokens if result else 0,
        output_tokens=result.usage.output_tokens if result else 0,
        latency_ms=result.latency_ms if result else 0.0,
        attempts=result.attempts if result else 1,
        charged_compute=record.charged_compute,
        uncharged_compute=record.uncharged_compute,
        packet_id=record.packet_id,
        error=record.error,
        provider_cost_usd=result.provider_cost_usd if result else None,
        reasoning_tokens=result.usage.reasoning_tokens if result else 0,
    )


def entities_view(state: WorldState) -> EntitiesView:
    return EntitiesView(
        agents=state.agents,
        plants=state.plants,
        fruits=state.fruits,
        seeds=state.seeds,
        residues=state.residues,
        removed=state.removed,
    )


def turn_view(
    checkpoint: Checkpoint,
    summaries: list[ModelCallSummary],
    packet_ids: list[str],
    parent: Optional[ParentRef],
    live: bool,
    extra_events: Optional[list[Event]] = None,
) -> TurnView:
    """Assemble the ``TurnView`` of a checkpoint (live or historical)."""
    events = list(checkpoint.events)
    if extra_events:
        events.extend(extra_events)
    return TurnView(
        live=live,
        turn=checkpoint.turn,
        map=checkpoint.world.map,
        entities=entities_view(checkpoint.world),
        rules=checkpoint.world.rules,
        settings=checkpoint.settings,
        events=events,
        model_calls=summaries,
        decision_packet_ids=packet_ids,
        parent=parent,
    )


# How long DELETE /api/runs/{id} waits for a closed worker that is still finishing its last turn
# (a paused run's worker exits in milliseconds) before answering 409 run_in_use.
DELETE_CLOSING_WAIT_SECONDS = 5.0


def summary_from_manifest(manifest: Manifest, status: Optional[str] = None) -> RunSummary:
    """``RunSummary`` for a manifest; ``status`` overlays the live state of an open run."""
    if status is None:
        status = "finished" if manifest.finished else "paused"
    archived, archived_at = storage.archive_state(manifest.world_id, manifest.run_id)
    return RunSummary(
        world_id=manifest.world_id,
        run_id=manifest.run_id,
        name=manifest.name,
        current_turn_id=manifest.current_turn_id,
        last_round=manifest.last_round,
        last_turn_index=manifest.last_turn_index,
        saved_at=manifest.updated_at,
        agent_count=manifest.agent_count,
        living_agent_count=manifest.living_agent_count,
        status=status,  # type: ignore[arg-type]
        parent=manifest.parent,
        default_model_key=manifest.default_model_key,
        run_dir=storage.run_dir_path(manifest.world_id, manifest.run_id),
        archived=archived,
        archived_at=archived_at,
    )


def next_step_of(checkpoint: Checkpoint) -> tuple[str, Optional[str]]:
    """What the next ``run_turn`` does from a committed checkpoint: ``(next_step, next_agent_id)``."""
    scheduler = checkpoint.turn.scheduler
    if scheduler.round_complete:
        return "new_round", None
    if scheduler.next_index < len(scheduler.order):
        return "agent_turn", scheduler.order[scheduler.next_index]
    return "round_end", None


def assign_card_ids(cards: list[AgentCard]) -> list[AgentCard]:
    """Cards with every ``id`` filled: a missing id becomes the lowest unused ``aNN``
    (the same rule world.generate_world uses), so the runner can attach skills,
    knowledge and settings to the agents it created."""
    used = {card.id for card in cards if card.id}
    out: list[AgentCard] = []
    n = 1
    for card in cards:
        if card.id:
            out.append(card)
            continue
        while f"a{n:02d}" in used:
            n += 1
        new_id = f"a{n:02d}"
        used.add(new_id)
        out.append(card.model_copy(update={"id": new_id}))
    return out


@dataclass
class _TurnWork:
    """Everything one turn attempt accumulates on its deep copy before commit."""

    cp: Checkpoint
    turn_id: str = ""
    kind: str = "agent_turn"
    round: int = 0
    turn_index: Optional[int] = None
    agent_id: Optional[str] = None
    decision_source: str = "none"
    packet_id: Optional[str] = None
    action: Optional[dict[str, Any]] = None
    action_result: Optional[ActionResult] = None
    events: list[Event] = field(default_factory=list)
    model_calls: list[ModelCallRecord] = field(default_factory=list)
    packets: list[DecisionPacketRecord] = field(default_factory=list)
    interventions: list[InterventionRecord] = field(default_factory=list)
    popped_staged: list[Intervention] = field(default_factory=list)
    snapshots_to_delete: list[str] = field(default_factory=list)
    finished_reason: Optional[str] = None  # set when the run is finished after this commit
    ops_this_turn: int = 0  # interpreter ops already spent in this agent turn (A-SKILL-13 cap across skill runs)

    @property
    def world(self) -> WorldState:
        return self.cp.world

    @property
    def scheduler(self) -> SchedulerState:
        return self.cp.turn.scheduler


# ---------------------------------------------------------------------------
# RunWorker
# ---------------------------------------------------------------------------


class RunWorker:
    """Authoritative worker for one open run."""

    def __init__(
        self,
        manifest: Manifest,
        checkpoint: Checkpoint,
        registry: model.ModelRegistry,
        writer_lock: Optional[storage.WriterLock] = None,
        on_commit: Optional[Callable[[str, str, str, int], None]] = None,
    ) -> None:
        self.manifest = manifest
        self.checkpoint = checkpoint  # last committed checkpoint (what API threads read)
        self.registry = registry
        self._writer_lock = writer_lock  # released when the worker thread exits (one active writer)
        self._on_commit = on_commit  # (run_id, turn_id, kind, round) after every commit; never raises out
        self._lock = threading.RLock()
        self._io_lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._queue: queue.Queue[Optional[str]] = queue.Queue()
        self._state: str = "finished" if manifest.finished else "paused"
        self._active_command: Optional[str] = None
        self._pause_flag = False
        self._wake = threading.Event()
        self._last_error: Optional[str] = None
        self._feed_epoch = ""
        self._events: deque[Event] = deque(maxlen=config.EVENT_RING_BUFFER_SIZE)
        self._next_seq = manifest.next_event_seq
        self._staged: list[Intervention] = []
        self._carried_calls: list[ModelCallRecord] = []
        self._carried_events: list[Event] = []
        self._interrupted_call_ids: set[str] = set()  # recovered pending calls (ledger: interrupted_calls)
        self._pending: Optional[tuple[ModelCallRecord, Optional[DecisionPacketRecord]]] = None
        self._active: Optional[tuple[str, int, Optional[int], Optional[str]]] = None
        self._work: Optional[_TurnWork] = None
        self._code_revision = ""
        self._last_commit_kind: Optional[str] = None
        self._closed = False
        self._stopped = False
        # The initiative the next round would get from the committed world as it is
        # (computed on a private copy at commit time, never on the shared checkpoint):
        # a prediction shown in RunStatus.next_round_order; staged edits can change it.
        self._next_round_order: Optional[list[str]] = self._predict_next_round(checkpoint)

    @property
    def run_id(self) -> str:
        return self.manifest.run_id

    @staticmethod
    def _predict_next_round(checkpoint: Checkpoint) -> Optional[list[str]]:
        """The order ``compute_initiative`` would give the next round from ``checkpoint``'s
        world as it is, or None when the next step is not a new round.  Works on a deep
        copy so the committed checkpoint (read by API threads) is never touched."""
        if not checkpoint.turn.scheduler.round_complete:
            return None
        try:
            return list(world.compute_initiative(copy.deepcopy(checkpoint.world)))
        except Exception:  # noqa: BLE001 - a prediction must never break status
            return None

    # -- lifecycle ---------------------------------------------------------

    def start(self, pending_calls: list[ModelCallRecord]) -> None:
        """Start the worker thread in state ``paused`` with a fresh ``feed_epoch``.  The
        interrupted pending call records from ``storage.recover_run`` become
        ``model_call_failed`` events (details.infra=true, interrupted=true, no charge) and
        are carried, with those events, into the next committed turn (INTERFACES section 8
        "Recovery"); their real usage reaches ``manifest.real_usage`` (as
        ``interrupted_calls``) in that commit and is shown in ``RunStatus`` meanwhile."""
        self._feed_epoch = uuid.uuid4().hex[:12]
        self._code_revision = storage.code_revision()
        self._staged = list(storage.read_staged_edits(self.run_id).interventions)
        for record in pending_calls:
            record.status = "failed"
            record.error = record.error or INTERRUPTED_MESSAGE
            record.charged_compute = 0.0
            record.finished_at = record.finished_at or utc_now_iso()
            result = record.result
            usage = result.usage.model_dump(mode="json") if result else {}
            self._interrupted_call_ids.add(record.call_id)
            event = self._new_event(
                turn_id=record.turn_id,
                round_no=record.round,
                turn=record.turn,
                actor=record.agent_id,
                kind="model_call_failed",
                summary=f"{record.agent_id} call {record.call_id} to {record.model_key} was interrupted (outcome uncertain)",
                details={
                    "call_id": record.call_id,
                    "status": result.status if result else "interrupted",
                    "usage": usage,
                    "latency_ms": result.latency_ms if result else 0.0,
                    "attempts": result.attempts if result else 0,
                    "provider_cost_usd": result.provider_cost_usd if result else None,
                    "error": record.error,
                    "infra": True,
                    "interrupted": True,
                },
            )
            self._carried_calls.append(record)
            self._carried_events.append(event)
        self._thread = threading.Thread(target=self._loop, name=f"empyrean-{self.run_id}", daemon=True)
        self._thread.start()

    def stop(self, wait: bool = True) -> None:
        """Request pause and tell the thread to exit once the current command settles
        (an active turn still finishes and commits).  With ``wait`` the caller blocks
        until the thread has exited; without it the thread settles the state and
        releases the writer lock on its own (``join`` waits for that)."""
        with self._lock:
            self._closed = True
            if self._state in ("running", "turn_active", "waiting_model"):
                self._pause_flag = True
                self._state = "pause_requested"
            self._wake.set()
        self._queue.put(None)
        thread = self._thread
        if thread is None or not thread.is_alive():
            self._settle_stopped()
            return
        if wait and threading.current_thread() is not thread:
            thread.join()

    def join(self, timeout: Optional[float] = None) -> bool:
        """Wait until the worker thread has exited (after ``stop``); True when it has."""
        thread = self._thread
        if thread is None or threading.current_thread() is thread:
            return True
        thread.join(timeout)
        return not thread.is_alive()

    def _settle_stopped(self) -> None:
        """The thread is gone: settle the visible state and release the writer lock."""
        with self._lock:
            if self._stopped:
                return
            self._stopped = True
            if self._state not in ("finished", "error"):
                self._state = "paused"
            self._active_command = None
            self._pause_flag = False
            lock = self._writer_lock
            self._writer_lock = None
        if lock is not None:
            try:
                lock.release()
            except OSError:
                log.exception("could not release the writer lock of run %s", self.run_id)

    def close(self) -> RunStatus:
        """Stop without waiting and drop the worker from the manager (POST /close): the
        request returns at once while the worker finishes its active turn, commits and
        exits; the run must be reopened before further commands (``RunManager.open_run``
        waits for the exiting worker)."""
        self.stop(wait=False)
        return self.status()

    # -- commands (API threads) ---------------------------------------------

    def submit(self, command: RunCommand) -> RunStatus:
        """Transitions (RunnerError "illegal_command" otherwise):
          run_turn:   paused/finished -> running (one turn) -> paused
          play:       paused/finished -> running (loop until pause/finished/error)
          step_round: paused/finished -> running (loop until the round_end checkpoint) -> paused
          pause:      running/turn_active/waiting_model -> pause_requested (turn finishes and
                      commits, then paused); error -> paused (working copy discarded);
                      paused/finished -> no-op
        In ``finished`` a run command applies staged edits and re-checks the finish
        condition (A-SCHED-3).  Returns the status right after the transition."""
        with self._lock:
            if self._closed:
                raise RunnerError("run_not_open")
            state = self._state
            if command == "pause":
                if state in ("running", "turn_active", "waiting_model"):
                    self._pause_flag = True
                    self._state = "pause_requested"
                    self._wake.set()
                elif state == "error":
                    # The working copy was already dropped when the error was recorded.
                    self._state = "paused"
                    self._active_command = None
                    self._work = None
                # paused / finished / pause_requested: no-op
                return self._status_locked()
            reason = command_allowed(state, command)
            if reason is not None:
                raise RunnerError(reason)
            self._state = "running"
            self._active_command = command
            self._pause_flag = False
            self._wake.clear()
            self._queue.put(command)
            return self._status_locked()

    def status(self) -> RunStatus:
        """See ``schemas.RunStatus``: in-progress turn while active, ``next_step``,
        ``active_command``, ``feed_epoch``, ``real_usage``."""
        with self._lock:
            return self._status_locked()

    def _status_locked(self) -> RunStatus:
        cp = self.checkpoint
        manifest = self.manifest
        next_step, next_agent = next_step_of(cp)
        if self._active is not None and self._state in ("turn_active", "waiting_model", "pause_requested"):
            active_turn_id, round_no, turn_index, acting = self._active
        else:
            active_turn_id = None
            round_no, turn_index, acting = cp.turn.round, cp.turn.turn_index, cp.turn.acting_agent_id
        pending = None
        if self._pending is not None:
            record = self._pending[0]
            pending = PendingModelCall(
                call_id=record.call_id, agent_id=record.agent_id, model_key=record.model_key, started_at=record.started_at
            )
        return RunStatus(
            run_id=manifest.run_id,
            world_id=manifest.world_id,
            state=self._state,  # type: ignore[arg-type]
            round=round_no,
            turn_index=turn_index,
            acting_agent_id=acting,
            next_agent_id=next_agent,
            next_step=next_step,  # type: ignore[arg-type]
            current_turn_id=cp.turn.turn_id,
            active_turn_id=active_turn_id,
            active_command=self._active_command,  # type: ignore[arg-type]
            last_error=self._last_error,
            pending_model_call=pending,
            staged_intervention_count=len(self._staged),
            latest_seq=self._next_seq - 1,
            feed_epoch=self._feed_epoch,
            living_agent_count=sum(1 for a in cp.world.agents.values() if a.alive),
            finished_reason=manifest.finished_reason,
            play_loop=self._active_command in ("play", "step_round") and self._state not in IDLE_STATES,
            real_usage=self._ledger_view_locked(),
            next_round_order=self._next_round_order if next_step == "new_round" else None,
        )

    def _uncommitted_calls_locked(self) -> list[ModelCallRecord]:
        """Call records not yet in a committed checkpoint: the carried ones (a failed or
        interrupted attempt) and those of the turn in progress, each once."""
        records: dict[str, ModelCallRecord] = {r.call_id: r for r in self._carried_calls}
        work = self._work
        if work is not None:
            records.update({r.call_id: r for r in work.model_calls})
        return list(records.values())

    def _ledger_view_locked(self) -> RealUsageLedger:
        """``manifest.real_usage`` (committed calls only) plus the uncommitted records, so
        the operator sees every billed call while nothing is ever persisted twice."""
        ledger = self.manifest.real_usage.model_copy(deep=True)
        for record in self._uncommitted_calls_locked():
            add_record_to_ledger(ledger, record, record.call_id in self._interrupted_call_ids)
        return ledger

    def live_view(self) -> TurnView:
        """``TurnView(live=True, ...)`` for the last committed checkpoint plus the in-memory
        events emitted since (pending model call etc.)."""
        with self._lock:
            cp = self.checkpoint
            since = cp.turn.event_seq_end
            extra = [e for e in self._events if e.seq > since]
            parent = self.manifest.parent
        return turn_view(
            cp,
            [model_call_summary(r) for r in cp.model_calls],
            [p.packet_id for p in cp.decision_packets],
            parent,
            live=True,
            extra_events=extra,
        )

    def events_since(self, since_seq: int, limit: int) -> list[Event]:
        """Events with seq > since_seq from the ring buffer (config.EVENT_RING_BUFFER_SIZE);
        falls back to storage for older seqs."""
        limit = max(1, limit)
        with self._lock:
            ring = list(self._events)
        oldest = ring[0].seq if ring else self._next_seq
        if since_seq + 1 < oldest:
            older = storage.read_events(self.run_id, since_seq, limit)
            last = older[-1].seq if older else since_seq
            merged = older + [e for e in ring if e.seq > last]
            return merged[:limit]
        return [e for e in ring if e.seq > since_seq][:limit]

    def pending_model_call_view(self) -> Optional[PendingModelCallView]:
        """The in-flight call record and packet while ``waiting_model``; None otherwise."""
        with self._lock:
            if self._pending is None:
                return None
            record, packet = self._pending
            return PendingModelCallView(record=record.model_copy(deep=True), packet=packet)

    def effective_settings(self) -> EffectiveSettingsView:
        with self._lock:
            cp = self.checkpoint
        settings = cp.settings
        ids = list(cp.world.agents)
        return EffectiveSettingsView(
            settings=settings,
            effective_context={aid: settings.effective_context(aid) for aid in ids},
            effective_model_key={aid: settings.effective_model_key(aid) for aid in ids},
            limits=ContextLimits(
                min_packet_input_tokens=config.MIN_PACKET_INPUT_TOKENS,
                min_generation_tokens=config.MIN_GENERATION_TOKENS,
            ),
        )

    def knowledge(self, agent_id: str) -> AgentKnowledgeView:
        """Live knowledge of one agent from the committed checkpoint, with
        ``context.believed_self``."""
        with self._lock:
            cp = self.checkpoint
        store = cp.knowledge.get(agent_id)
        if store is None:
            raise NotFoundError(f"no knowledge store for agent {agent_id}")
        return AgentKnowledgeView(
            turn_id=cp.turn.turn_id,
            knowledge=store,
            unread_count=len(context.unread_records(store)),
            believed_self=context.believed_self(store),
            observed_entities=context.observed_entities(store),
        )

    def model_call(self, call_id: str) -> ModelCallRecord:
        """A call record of the committed checkpoint or the in-flight call."""
        with self._lock:
            candidates = list(self.checkpoint.model_calls)
            if self._pending is not None:
                candidates.append(self._pending[0])
        for record in candidates:
            if record.call_id == call_id:
                return record
        raise NotFoundError(f"model call {call_id} not in the live turn")

    def decision_packet(self, packet_id: str) -> DecisionPacketRecord:
        with self._lock:
            candidates = list(self.checkpoint.decision_packets)
            if self._pending is not None and self._pending[1] is not None:
                candidates.append(self._pending[1])
        for packet in candidates:
            if packet.packet_id == packet_id:
                return packet
        raise NotFoundError(f"decision packet {packet_id} not in the live turn")

    # -- staging (API threads) ----------------------------------------------

    def stage_intervention(self, intervention: Intervention) -> Intervention:
        """Validate fully (entity ids exist for set_stat/remove; model keys exist and are
        available; scope agent exists; context settings valid for the agent's effective
        model via ``context.validate_settings``; place_entity terrain rules; plant rule name)
        -> SetupError(problems) on failure.  Assign ``id`` (``iv_{seq:04d}`` from
        ``manifest.next_intervention_seq``) and ``created_at``, append under ``self._lock``
        and persist ``staged_edits.json``.  Allowed in any state; applied at the next
        turn boundary."""
        problems = self.validate_intervention(intervention)
        if problems:
            raise SetupError(problems)
        with self._io_lock:
            with self._lock:
                seq = self.manifest.next_intervention_seq
                self.manifest.next_intervention_seq = seq + 1
                staged = intervention.model_copy(update={"id": f"iv_{seq:04d}", "created_at": utc_now_iso()})
                self._staged.append(staged)
                manifest_copy = self.manifest.model_copy(deep=True)
                staged_copy = list(self._staged)
            storage.write_manifest(manifest_copy)
            storage.write_staged_edits(self.run_id, StagedEdits(interventions=staged_copy))
        return staged

    def staged(self) -> list[Intervention]:
        with self._lock:
            return list(self._staged)

    def unstage(self, intervention_id: str) -> None:
        """Remove a staged intervention (and its staged snapshot, if any)."""
        with self._io_lock:
            with self._lock:
                match = [iv for iv in self._staged if iv.id == intervention_id]
                if not match:
                    raise NotFoundError(f"no staged intervention {intervention_id}")
                self._staged = [iv for iv in self._staged if iv.id != intervention_id]
                staged_copy = list(self._staged)
            storage.write_staged_edits(self.run_id, StagedEdits(interventions=staged_copy))
            removed = match[0]
            if removed.type == "apply_working_files":
                try:
                    storage.delete_staged_snapshot(self.run_id, removed.snapshot_ref)
                except Exception:  # noqa: BLE001 - best effort cleanup
                    log.warning("could not delete staged snapshot %s", removed.snapshot_ref)

    def reload_working(self) -> ReloadResponse:
        """Allowed only while paused/error/finished (RunnerError otherwise).  storage.load_working
        -> on errors return them (nothing staged); otherwise diff against the committed
        checkpoint, write the snapshot (storage.write_staged_snapshot) and stage ONE
        ``apply_working_files`` intervention (origin "file", ``base_turn_id`` = committed
        turn) carrying the changes; an empty diff stages nothing."""
        with self._lock:
            if self._state not in IDLE_STATES:
                raise RunnerError(f"illegal_command: working/reload while {self._state}")
            committed = self.checkpoint
        with self._io_lock:
            working, errors = storage.load_working(self.run_id)
            if working is None or errors:
                return ReloadResponse(ok=False, errors=list(errors))
            errors = self._settings_errors(working.settings, list(working.world.agents), working.world.rules)
            if errors:
                return ReloadResponse(ok=False, errors=errors)
            changes = storage.diff_working(committed, working)
            if not changes:
                return ReloadResponse(ok=True, changes=[], staged=None)
            with self._lock:
                seq = self.manifest.next_intervention_seq
                self.manifest.next_intervention_seq = seq + 1
                manifest_copy = self.manifest.model_copy(deep=True)
            iv_id = f"iv_{seq:04d}"
            storage.write_manifest(manifest_copy)
            ref = storage.write_staged_snapshot(self.run_id, iv_id, working)
            intervention = ApplyWorkingFilesIntervention(
                type="apply_working_files",
                id=iv_id,
                origin="file",
                created_at=utc_now_iso(),
                base_turn_id=committed.turn.turn_id,
                snapshot_ref=ref,
                changes=changes,
            )
            with self._lock:
                self._staged.append(intervention)
                staged_copy = list(self._staged)
            storage.write_staged_edits(self.run_id, StagedEdits(interventions=staged_copy))
        return ReloadResponse(ok=True, changes=changes, staged=intervention)

    # -- validation helpers (pure over a checkpoint) -------------------------

    def _settings_errors(self, settings: RunSettings, agent_ids: list[str], rules: Any) -> list[str]:
        """Every agent's effective context settings checked against its effective model
        (``context.validate_settings``); messages are prefixed with the agent id."""
        return _settings_errors(self.registry, settings, agent_ids, rules)

    def validate_intervention(self, iv: Intervention) -> list[ApiProblem]:
        """Staging validation against the committed checkpoint (INTERFACES section 10).
        Delegates to the pure ``validate_intervention_on`` with this worker's committed
        checkpoint (rev 4), so briefs can run the same check on a closed run."""
        with self._lock:
            cp = self.checkpoint
        return validate_intervention_on(cp, self.registry, self.run_id, iv)

    # -- worker thread internals --------------------------------------------

    def _set_state(self, state: str) -> None:
        """Worker-side transition; a pending pause request keeps ``pause_requested`` visible
        (section 3: pause while running/turn_active/waiting_model -> pause_requested)."""
        with self._lock:
            if self._pause_flag and state in ("running", "turn_active", "waiting_model"):
                self._state = "pause_requested"
            else:
                self._state = state

    def _new_event(
        self,
        turn_id: str,
        round_no: int,
        turn: Optional[int],
        actor: str,
        kind: str,
        summary: str,
        details: Optional[dict[str, Any]] = None,
        costs: Optional[EventCosts] = None,
        pending: bool = False,
    ) -> Event:
        """Assign the next seq under the lock and push the event to the live ring buffer."""
        with self._lock:
            seq = self._next_seq
            self._next_seq += 1
            event = Event(
                seq=seq,
                turn_id=turn_id,
                round=round_no,
                turn=turn,
                actor=actor,
                kind=kind,  # type: ignore[arg-type]
                summary=summary,
                details=details or {},
                costs=costs or EventCosts(),
                pending=pending,
            )
            self._events.append(event)
        return event

    def _emit(
        self,
        work: _TurnWork,
        actor: str,
        kind: str,
        summary: str,
        details: Optional[dict[str, Any]] = None,
        costs: Optional[EventCosts] = None,
        pending: bool = False,
    ) -> Event:
        event = self._new_event(work.turn_id, work.round, work.turn_index, actor, kind, summary, details, costs, pending)
        work.events.append(event)
        return event

    def _loop(self) -> None:
        """Pop commands; for run_turn run ``_turn`` once; for play/step_round repeat
        ``_turn`` (sleeping ``settings.play_delay_seconds`` between turns) until a pause
        request, finish, error, or (step_round) a round_end commit.  Every exception inside
        a turn puts the run in ``error`` (see module docstring); the last committed
        checkpoint stays valid."""
        try:
            while True:
                command = self._queue.get()
                if command is None:
                    break
                try:
                    self._drive(command)
                except Exception:  # noqa: BLE001 - never let the worker thread die silently
                    log.exception("worker loop failure for run %s", self.run_id)
                    with self._lock:
                        self._state = "error"
                        self._last_error = self._last_error or "worker loop failure"
                        self._active_command = None
        finally:
            self._settle_stopped()

    def _drive(self, command: str) -> None:
        """Run one command to completion, settling the state when it ends."""
        while True:
            outcome = self._run_one()
            if outcome != "committed":
                break  # paused / finished / error: state already settled
            with self._lock:
                pause = self._pause_flag or self._closed
                round_end = self._last_commit_kind == "round_end"
                delay = self.checkpoint.settings.play_delay_seconds
            if command == "run_turn" or pause or (command == "step_round" and round_end):
                break
            self._set_state("running")
            if delay > 0:
                self._wake.wait(delay)
        with self._lock:
            if self._state in ("running", "turn_active", "waiting_model", "pause_requested"):
                self._state = "paused"
            self._active_command = None
            self._pause_flag = False
            self._wake.clear()
            self._active = None

    def _run_one(self) -> str:
        """``_turn`` guarded by the error handler.  Returns committed | paused | finished | error."""
        try:
            outcome = self._turn()
        except Exception as exc:  # noqa: BLE001 - every failure inside a turn -> error state
            self._enter_error(exc)
            return "error"
        if outcome == "finished":
            with self._lock:
                self._state = "finished"
        elif outcome == "paused":
            with self._lock:
                self._state = "paused"
        return outcome

    def _enter_error(self, exc: BaseException) -> None:
        """Record the failure (redacted), carry the attempt's call records and their events
        into the next attempt of the same turn id, restore popped staged edits, drop the
        working copy and enter ``error``."""
        message = str(exc) if isinstance(exc, _TurnFailure) else f"{type(exc).__name__}: {exc}"
        message = self._redact(message)
        excerpt = ""
        if not isinstance(exc, _TurnFailure):
            lines = traceback.format_exc().strip().splitlines()
            excerpt = self._redact("\n".join(lines[-TRACEBACK_EXCERPT_LINES:]))
            log.exception("turn failed for run %s", self.run_id)
        else:
            log.error("run %s entered error: %s", self.run_id, message)
        work = self._work
        if work is not None:
            carried_calls, carried_events = self._discard_attempt(work)
            error_event = self._emit(
                work, "system", "error", f"turn {work.turn_id} failed: {message}", {"message": message, "traceback_excerpt": excerpt}
            )
            carried_events.append(error_event)
        else:
            cp = self.checkpoint
            error_event = self._new_event(cp.turn.turn_id, cp.turn.round, cp.turn.turn_index, "system", "error", f"failed: {message}", {"message": message, "traceback_excerpt": excerpt})
            carried_events = [error_event]
            carried_calls = []
        with self._lock:
            self._carried_calls = carried_calls
            self._carried_events = carried_events
            if work is not None and work.popped_staged:
                self._staged = list(work.popped_staged) + self._staged
                staged_copy = list(self._staged)
            else:
                staged_copy = None
            self._state = "error"
            self._last_error = message
            self._active_command = None
            self._pause_flag = False
            self._pending = None
            self._work = None
        if staged_copy is not None:
            try:
                with self._io_lock:
                    storage.write_staged_edits(self.run_id, StagedEdits(interventions=staged_copy))
            except Exception:  # noqa: BLE001
                log.exception("could not restore staged edits after a failed turn")

    def _discard_attempt(self, work: _TurnWork) -> tuple[list[ModelCallRecord], list[Event]]:
        """What a failed attempt carries into the re-run of the same turn id: its call
        records and their pending/failed events.  A call the attempt had answered and
        charged was charged on the copy that is now discarded, so the agent never paid:
        the record becomes ``failed`` (charged 0, the measured cost as
        ``uncharged_compute``, error ``DISCARDED_CHARGE_MESSAGE``) and its
        model_call_completed / model_call_failed / cognition_charged events are replaced
        by one ``model_call_failed`` (``infra`` false, costs 0).  A record storage could
        not write (an unstorable reply) is stripped to its metadata so the re-run can
        commit."""
        discarded: set[str] = set()
        for record in work.model_calls:
            if record.status == "completed" or record.charged_compute > 0:
                record.uncharged_compute = record.charged_compute + record.uncharged_compute
                record.charged_compute = 0.0
                record.status = "failed"
                record.error = DISCARDED_CHARGE_MESSAGE
                discarded.add(record.call_id)
            if not _json_serializable(record):
                if record.result is not None:
                    record.result = record.result.model_copy(update={"parsed": None, "text": None})
                record.error = f"{record.error or 'failed'} ({UNSERIALIZABLE_REPLY_NOTE})"
        settled_kinds = ("model_call_completed", "model_call_failed", "cognition_charged")
        events = [
            e
            for e in work.events
            if e.kind in CARRIED_EVENT_KINDS and not (e.kind in settled_kinds and e.details.get("call_id") in discarded)
        ]
        for record in work.model_calls:
            if record.call_id not in discarded:
                continue
            result = record.result
            events.append(
                self._new_event(
                    work.turn_id,
                    work.round,
                    work.turn_index,
                    record.agent_id,
                    "model_call_failed",
                    f"{record.agent_id} call {record.call_id} to {record.model_key} was answered but the turn failed afterwards; "
                    "its charge was discarded",
                    {
                        "call_id": record.call_id,
                        "status": result.status if result else "failed",
                        "usage": result.usage.model_dump(mode="json") if result else {},
                        "latency_ms": result.latency_ms if result else 0.0,
                        "attempts": result.attempts if result else 0,
                        "provider_cost_usd": result.provider_cost_usd if result else None,
                        "error": DISCARDED_CHARGE_MESSAGE,
                        "infra": False,
                    },
                )
            )
        return list(work.model_calls), events

    def _redact(self, text: str) -> str:
        try:
            return model.redact(text, self.registry) or ""
        except Exception:  # noqa: BLE001 - redaction must never fail the error path
            return text[: config.ERROR_TEXT_MAX_CHARS]

    # -- the turn procedure (INTERFACES section 8) -----------------------------

    def _turn(self) -> str:
        """One boundary + one checkpoint on a deep copy.  See docs/INTERFACES.md section 8.
        Returns "paused" (pause honoured before starting), "finished", or "committed".

        Order at the boundary (spec "Turn orchestration" step 1): staged edits are applied
        first, the finish condition is checked, and only then does a new round start
        (round counter, initiative from the run RNG, ``round_started``).  So an agent
        placed while paused at ``r{n}_end`` acts in round n+1, a speed edit changes that
        round's order, and a working-file snapshot (taken at ``r{n}_end``, round n) can
        never roll a started round back.  A new round's turn id names the first agent
        of the initiative, which is only known after the edits: the boundary is stamped
        with a provisional id from a peek at the initiative (the run RNG is restored
        afterwards) and re-stamped by ``_start_round`` in the rare case the edits change
        who goes first."""
        with self._lock:
            if self._pause_flag or self._closed:
                return "paused"
            committed = self.checkpoint
            already_finished = self.manifest.finished
            staged_waiting = bool(self._staged)
        if already_finished and not staged_waiting:
            return "finished"  # A-SCHED-3: nothing to apply, the condition still holds
        work = _TurnWork(cp=copy.deepcopy(committed))
        self._work = work
        self._set_state("turn_active")
        w = work.world
        scheduler = work.scheduler
        new_round = scheduler.round_complete
        if new_round:
            work.round = w.round + 1
            self._stamp_boundary(work, self._peek_initiative(w), 0)
        else:
            work.round = w.round
            self._stamp_boundary(work, list(scheduler.order), scheduler.next_index)
        removed_agent = work.kind == "agent_turn" and work.agent_id not in w.agents  # A-SCHED-4
        self._apply_staged_edits(work)
        self._carry_into(work)
        reason = self._finish_reason(work)
        if reason is not None and already_finished and not work.interventions:
            self._work = None
            return "finished"
        if new_round:
            self._start_round(work)
        if reason is not None:
            work.finished_reason = reason
            # The boundary id is consumed by this final checkpoint so a later revival
            # (A-SCHED-3) never re-uses a committed turn id (INTERFACES section 8, pinned).
            if work.kind == "agent_turn":
                work.decision_source = "none"
                scheduler.next_index += 1
            else:
                scheduler.round_complete = True
            self._emit(work, "system", "run_finished", f"run finished: {reason}", {"reason": reason})
            self._commit(work)
            return "finished"
        if work.kind == "round_end":
            self._round_end(work)
        else:
            scheduler.next_index += 1
            if removed_agent or work.agent_id not in w.agents:
                self._skipped_turn(work, "skipped_removed", f"{work.agent_id} was removed by the operator; turn skipped")
            else:
                self._agent_turn(work)
        return "finished" if work.finished_reason else "committed"

    def _stamp_boundary(self, work: _TurnWork, order: list[str], next_index: int) -> None:
        """Set the boundary's kind / turn index / agent / turn id for ``work.round`` and
        publish it as the active turn."""
        work.kind, work.turn_index, work.agent_id, work.turn_id = boundary_of(work.round, order, next_index)
        with self._lock:
            self._active = (work.turn_id, work.round, work.turn_index, work.agent_id)

    @staticmethod
    def _peek_initiative(w: WorldState) -> list[str]:
        """The initiative the round would get from the world as it is now, without
        consuming the run RNG (its state is put back), so the real order computed after
        the staged edits is the same one when the edits change nothing (determinism)."""
        saved = w.rng_state
        order = list(world.compute_initiative(w))
        w.rng_state = saved
        return order

    def _start_round(self, work: _TurnWork) -> None:
        """Start round ``work.round`` on the edited world: bump the world round, fix the
        initiative (A-SCHED-1, consuming the run RNG once), re-stamp the boundary when the
        first scheduled agent changed, and emit ``round_started``."""
        w = work.world
        scheduler = work.scheduler
        w.round += 1
        work.round = w.round
        scheduler.round = w.round
        scheduler.order = list(world.compute_initiative(w))
        scheduler.next_index = 0
        scheduler.round_complete = False
        provisional = work.turn_id
        self._stamp_boundary(work, scheduler.order, 0)
        if work.turn_id != provisional:
            self._restamp(work, provisional, work.turn_id)
        self._emit(
            work,
            "world",
            "round_started",
            f"round {w.round} begins: {' '.join(scheduler.order) or 'no living agents'}",
            {"round": w.round, "order": list(scheduler.order)},
        )

    @staticmethod
    def _restamp(work: _TurnWork, old_id: str, new_id: str) -> None:
        """Move what the boundary produced under a provisional turn id (intervention
        events and records) to the final id.  Knowledge records carry no turn id."""
        for event in work.events:
            if event.turn_id == old_id:
                event.turn_id = new_id
                if event.details.get("effective_turn_id") == old_id:
                    event.details["effective_turn_id"] = new_id
        for record in work.interventions:
            if record.effective_turn_id == old_id:
                record.effective_turn_id = new_id

    def _finish_reason(self, work: _TurnWork) -> Optional[str]:
        """A-SCHED-3: no living agents, or ``max_rounds`` reached at a round boundary
        (evaluated before a new round starts: with ``round_complete`` the world round is
        the round just completed)."""
        w = work.world
        if not world.living_agents(w):
            return "all_dead"
        max_rounds = work.cp.settings.max_rounds
        if max_rounds is not None and (w.round > max_rounds or (work.scheduler.round_complete and w.round >= max_rounds)):
            return "max_rounds"
        return None

    def _carry_into(self, work: _TurnWork) -> None:
        """Recovered / failed call records and their events join this turn's checkpoint."""
        with self._lock:
            calls = list(self._carried_calls)
            events = list(self._carried_events)
        work.model_calls.extend(calls)
        work.events.extend(events)

    def _skipped_turn(self, work: _TurnWork, source: str, summary: str) -> None:
        work.decision_source = source
        self._emit(work, work.agent_id or "world", "turn_started", summary, {"decision_source": source})
        self._commit(work)

    def _round_end(self, work: _TurnWork) -> None:
        """world.end_round as its own checkpoint ``r{n}_end`` (design "Turns speed": after all
        turns in a round advance plants, settle upkeep and starvation, resolve deaths)."""
        w = work.world
        outcome = world.end_round(w)
        self._apply_outcome(work, outcome)
        if not any(e.kind == "round_ended" for e in outcome.events):
            living = [a.id for a in world.living_agents(w)]
            self._emit(
                work,
                "world",
                "round_ended",
                f"round {w.round} ended: {len(living)} living agents, {len(outcome.deaths)} deaths",
                {"round": w.round, "living_agents": living, "deaths": list(outcome.deaths)},
            )
        work.scheduler.round_complete = True
        reason = self._finish_reason(work)
        if reason is not None:
            work.finished_reason = reason
            self._emit(work, "system", "run_finished", f"run finished: {reason}", {"reason": reason})
        self._commit(work)

    def _apply_outcome(self, work: _TurnWork, outcome: Any) -> None:
        """Assign seqs to the world's event drafts and route notices to the recipients'
        knowledge stores (world.py never touches knowledge)."""
        for draft in outcome.events:
            self._emit(work, draft.actor, draft.kind, draft.summary, dict(draft.details), draft.costs)
        for notice in outcome.notices:
            store = work.cp.knowledge.get(notice.agent_id)
            if store is None:
                store = context.new_knowledge(notice.agent_id)
                work.cp.knowledge[notice.agent_id] = store
            context.record_notice(store, notice, work.world.round, work.turn_id)

    def _agent_turn(self, work: _TurnWork) -> None:
        """Spec "Turn orchestration" steps 2-5 for one scheduled agent."""
        w = work.world
        agent_id = work.agent_id or ""
        agent = w.agents[agent_id]
        label = f"{agent.name} ({agent_id})"
        if not agent.alive:
            self._skipped_turn(work, "skipped_dead", f"{label} is dead; turn {work.turn_index} of round {w.round} skipped")
            return
        if agent.wait_turns_remaining > 0:
            agent.wait_turns_remaining -= 1
            self._skipped_turn(work, "wait", f"{label} is waiting ({agent.wait_turns_remaining} more turns)")
            return
        self._emit(work, agent_id, "turn_started", f"{label} begins turn {work.turn_index} of round {w.round}")
        store = work.cp.knowledge.get(agent_id)
        if store is None:
            store = context.new_knowledge(agent_id)
            work.cp.knowledge[agent_id] = store
        execution = agent.skill_execution
        if execution is not None and execution.status == "running":
            # A-SKILL-9: only unread ARRIVALS interrupt (messages, damage, voice, transfers
            # received); the runner's own feedback records about the agent's last decision
            # (cognition charge, op-budget yield, ...) are created unread but are not news.
            interrupt_on = set(w.rules.skills.interrupt_on)
            unread_kinds = {r.kind for r in context.unread_records(store) if not is_runner_feedback(r)}
            if interrupt_on & unread_kinds:
                agent.skill_execution = skills.stop_execution(execution, "interrupted")  # A-SKILL-9
                self._emit(
                    work,
                    agent_id,
                    "skill_finished",
                    f"{agent_id} skill {execution.root_skill} interrupted by new {', '.join(sorted(interrupt_on & unread_kinds))}",
                    {"skill": execution.root_skill, "ops": 0, "cost": 0.0, "status": "stopped", "error": "interrupted"},
                )
            else:
                work.decision_source = "skill"
                if self._skill_step(work, agent_id, execution, thought=None, fresh=False):
                    self._finish_agent_turn(work)
                    return
                # A-SKILL-11: the skill ended without an action; a model decision follows in this turn
        work.decision_source = "model"
        self._model_decision(work, agent_id)
        self._finish_agent_turn(work)

    def _finish_agent_turn(self, work: _TurnWork) -> None:
        reason = self._finish_reason(work)
        if reason == "all_dead":
            work.finished_reason = reason
            self._emit(work, "system", "run_finished", f"run finished: {reason}", {"reason": reason})
        self._commit(work)

    # -- skills ----------------------------------------------------------------

    def _skill_step(self, work: _TurnWork, agent_id: str, state: SkillExecutionState, thought: Optional[str], fresh: bool) -> bool:
        """Run the interpreter until an action / yield / end and settle the interpreter cost
        (design "Turns speed": 0.01 per op, 100 ops per turn).  Returns True when the turn
        is consumed.  A resumed skill that ends without an action returns False so the
        caller continues into a model decision (A-SKILL-11); a fresh ``run_skill`` that ends
        without an action uses the turn."""
        w = work.world
        agent = w.agents[agent_id]
        store = work.cp.knowledge[agent_id]
        # The op cap is per AGENT TURN (design "Turns speed": at most max_ops_per_turn steps
        # before yielding): a fresh run_skill after a resumed skill ended without an action
        # (A-SKILL-11) continues from the ops that skill already spent this turn.
        state.ops_this_turn = work.ops_this_turn
        env = SkillEnv(agent_id=agent_id, here=agent.position, round=w.round)
        outcome = skills.run_until_action(state, agent.skills, w.rules.skills, env, agent.stats.compute)
        work.ops_this_turn += max(0, outcome.ops_used)
        state = outcome.state
        agent.skill_execution = state
        cost = min(max(outcome.cost_compute, 0.0), agent.stats.compute)
        agent.stats.compute -= cost
        agent.total_interpreter_spent += cost
        root = state.root_skill
        self._emit(
            work,
            agent_id,
            "skill_step",
            f"{agent_id} skill {root} ran {outcome.ops_used} ops ({state.status})",
            {"skill": root, "ops": outcome.ops_used, "cost": cost, "status": state.status, "error": outcome.error},
            EventCosts(compute=cost),
        )
        if outcome.action is not None:
            request = ActionRequest(agent_id=agent_id, action=outcome.action, via_skill=True, skill_name=root)
            result = self._execute_world_action(work, request, thought, interpreter_cost=cost)
            agent = w.agents[agent_id]
            if agent.skill_execution is not None and agent.skill_execution.status == "awaiting_action_result":
                agent.skill_execution = skills.deliver_result(agent.skill_execution, result)
            return True
        if outcome.invalid_action is not None:
            invalid = outcome.invalid_action
            action = {"name": invalid.name, "args": dict(invalid.args)}
            self._emit(
                work,
                agent_id,
                "action",
                f"{agent_id} {_describe_action(invalid.name, invalid.args)} -> invalid_argument ({invalid.error})",
                {"action": action, "result": invalid.result.model_dump(mode="json"), "via_skill": True, "skill_name": root},
            )
            agent.last_action = action
            agent.last_result = invalid.result
            context.record_action_result(
                store, {**action, "skill_name": root}, invalid.result, w.round, work.turn_id, True, thought, interpreter_cost=cost
            )
            work.action = {**action, "via_skill": True, "skill_name": root}
            work.action_result = invalid.result
            return True
        if state.status == "running":  # op budget exhausted: yield (A-SKILL-2)
            context.record_system(
                store,
                f"skill {root} used its {outcome.ops_used} operation budget this turn without reaching an action; it resumes next turn",
                w.round,
                work.turn_id,
                {"skill": root, "reason": "op_budget_exhausted", "interpreter_charged": cost},
            )
            return True
        if state.status == "error":
            self._emit(
                work,
                agent_id,
                "skill_error",
                f"{agent_id} skill {root} failed: {state.last_error}",
                {"skill": root, "ops": outcome.ops_used, "cost": cost, "status": "error", "error": state.last_error},
            )
            agent.last_result = ActionResult(ok=False, reason="skill_error", round=w.round, data={"error": state.last_error or ""})
            context.record_system(
                store,
                f"skill {root} failed: {state.last_error}",
                w.round,
                work.turn_id,
                {"skill": root, "error": state.last_error, "interpreter_charged": cost},
            )
        else:
            self._emit(
                work,
                agent_id,
                "skill_finished",
                f"{agent_id} skill {root} {state.status}" + (f" ({state.last_error})" if state.last_error else ""),
                {"skill": root, "ops": outcome.ops_used, "cost": cost, "status": state.status, "error": state.last_error, "return_value": state.return_value},
            )
        return fresh

    def _stop_if_uses(self, work: _TurnWork, agent: Agent, name: str) -> None:
        """Saving or deleting a skill named in the running frames stops the execution (A-SKILL-6)."""
        execution = agent.skill_execution
        if execution is None or execution.status != "running" or name not in skills.frames_use(execution):
            return
        agent.skill_execution = skills.stop_execution(execution, "skill_modified")
        self._emit(
            work,
            agent.id,
            "skill_finished",
            f"{agent.id} skill {execution.root_skill} stopped: {name} was modified",
            {"skill": execution.root_skill, "ops": 0, "cost": 0.0, "status": "stopped", "error": "skill_modified"},
        )

    def _execute_world_action(
        self, work: _TurnWork, request: ActionRequest, thought: Optional[str], interpreter_cost: float = 0.0
    ) -> ActionResult:
        """Exactly one world action through ``world.apply_action`` (same rule path for direct
        and skill actions; the discount is the world's business), then the actor's own
        record (disclosing the interpreter cost of the step that reached the action, so the
        believed compute does not drift by it, A-KNOW-6) and the notices to other agents."""
        w = work.world
        outcome = world.apply_action(w, request)
        result = outcome.result
        action = {"name": request.action.name, "args": request.action.args.model_dump(mode="json")}
        if request.via_skill and request.skill_name:
            action["skill_name"] = request.skill_name
        store = work.cp.knowledge[request.agent_id]
        context.record_action_result(
            store, action, result, w.round, work.turn_id, request.via_skill, thought, interpreter_cost=interpreter_cost
        )
        self._apply_outcome(work, outcome)
        work.action = {**action, "via_skill": request.via_skill, "skill_name": request.skill_name}
        work.action_result = result
        return result

    # -- model decision ----------------------------------------------------------

    def _next_call_id(self, work: _TurnWork) -> str:
        """``mc_{turn_id}_{n:02d}``; ``n`` continues past ids already used for this turn id
        (carried failed/interrupted records), so a re-run gets ``_02``."""
        used = [_call_index(r.call_id) for r in work.model_calls if r.turn_id == work.turn_id]
        return f"mc_{work.turn_id}_{(max(used) + 1 if used else 1):02d}"

    def _budget_reached(self, work: _TurnWork) -> bool:
        """A-COG-7: the run's real provider cost (committed ledger plus the uncommitted
        records of this turn: carried and just answered) reached ``settings.real_budget_usd``."""
        budget = work.cp.settings.real_budget_usd
        if budget is None:
            return False
        with self._lock:
            spent = self.manifest.real_usage.provider_cost_usd
        spent += sum((r.result.provider_cost_usd or 0.0) for r in work.model_calls if r.result is not None)
        return spent > 0 and spent >= budget

    def _model_decision(self, work: _TurnWork, agent_id: str) -> None:
        """Packet -> pending record -> call -> charge -> format gate -> decision."""
        w = work.world
        agent = w.agents[agent_id]
        store = work.cp.knowledge[agent_id]
        settings = work.cp.settings
        model_key = settings.effective_model_key(agent_id)
        effective = settings.effective_context(agent_id)
        ref = self.registry.get(model_key)
        mind = w.rules.cognition.multiplier_for(model_key)
        overhead = model.request_overhead_tokens(model_key, self.registry)
        situation = context.build_situation(agent, store, w.rules, effective, w.round, work.turn_id)
        packet_id = f"pk_{work.turn_id}"
        packet = context.build_packet(
            agent, store, situation, w.rules, effective, ref.capabilities, mind, agent.stats.compute, overhead, work.turn_id, packet_id, w.round
        )
        work.packets.append(packet)
        work.packet_id = packet_id
        if not packet.affordable:
            reason = packet.unaffordable_reason or "packet unaffordable"
            self._emit(
                work,
                agent_id,
                "resource_skip",
                f"{agent_id} cannot afford to think ({reason}); turn skipped",
                {"reason": reason, "compute": agent.stats.compute, "minimum_needed": packet.reservation_compute},
            )
            # Knowledge boundary: the packet's unaffordable_reason and the event carry the
            # exact balance for the operator; the agent's own record must not (a free
            # query(self) otherwise, INTERFACES 4.3).
            context.record_system(
                store,
                f"you could not afford the minimum decision packet in round {w.round}; the turn was skipped",
                w.round,
                work.turn_id,
                {"reason": "resource_skip"},
            )
            work.decision_source = "skipped_unaffordable"
            return
        if self._budget_reached(work):
            raise _TurnFailure(HOST_BUDGET_MESSAGE)
        call_id = self._next_call_id(work)
        request = ModelRequest(
            request_id=call_id,
            model_key=model_key,
            messages=list(packet.messages),
            response_schema=decision_json_schema(),
            max_output_tokens=packet.generation_allowance or effective.generation_allowance,
            timeout_seconds=config.MODEL_TIMEOUT_SECONDS,
            max_retries=config.MODEL_MAX_RETRIES,
            purpose="decision",
            metadata={
                "agent_id": agent_id,
                "turn_id": work.turn_id,
                "round": w.round,
                "situation": situation.model_dump(mode="json"),
                "fake_script": settings.fake_scripts.get(agent_id),
                "fake_script_index": agent.model_call_count,
                "fake_options": settings.fake_options.get(agent_id, {}),
            },
        )
        record = ModelCallRecord(
            call_id=call_id,
            turn_id=work.turn_id,
            round=w.round,
            turn=work.turn_index,
            agent_id=agent_id,
            purpose="decision",
            model_key=model_key,
            provider=ref.provider,
            model_id=ref.model_id,
            ref_snapshot=ref,
            status="pending",
            started_at=utc_now_iso(),
            request=request,
            packet_id=packet_id,
            reservation_compute=packet.reservation_compute,
            mind_multiplier=mind,
        )
        storage.write_pending_model_call(self.run_id, record)
        work.model_calls.append(record)
        self._emit(
            work,
            agent_id,
            "model_call_pending",
            f"{agent_id} waiting for {model_key} ({ref.provider}/{ref.model_id})",
            {"call_id": call_id, "model_key": model_key, "provider": ref.provider, "model_id": ref.model_id, "reservation_compute": packet.reservation_compute},
            pending=True,
        )
        with self._lock:
            self._pending = (record, packet)
        self._set_state("waiting_model")
        try:
            result = model.call_model(request, self.registry)
        finally:
            with self._lock:
                self._pending = None
            self._set_state("turn_active")
        record.result = result
        record.finished_at = utc_now_iso()
        record.status = "completed" if result.status == "ok" else "failed"
        record.error = result.error if result.status != "ok" else None
        if record.status == "failed" and not record.error:
            record.error = f"status={result.status}"
        storage.write_pending_model_call(self.run_id, record)
        # The real usage stays on the record until the commit that holds it adds it to the
        # ledger (see the module docstring); the status view already shows it.
        if result.status in INFRA_STATUSES:  # A-COG-5: never charged, nothing marked read
            self._emit(
                work,
                agent_id,
                "model_call_failed",
                f"{agent_id} got no answer from {model_key}: {result.status}",
                {
                    "call_id": call_id,
                    "status": result.status,
                    "usage": result.usage.model_dump(mode="json"),
                    "latency_ms": result.latency_ms,
                    "attempts": result.attempts,
                    "provider_cost_usd": result.provider_cost_usd,
                    "error": result.error,
                    "infra": True,
                },
            )
            raise _TurnFailure(f"{PROVIDER_FAILURE_PREFIX}{result.status}")
        if self._budget_reached(work):
            # The measured usage is recorded (uncharged: this attempt is discarded) and carried.
            self._settle_cognition(work, agent_id, record, result, allow_charge=False)
            raise _TurnFailure(HOST_BUDGET_MESSAGE)
        agent.model_call_count += 1
        context.mark_read(store, list(packet.digest_record_ids))  # A-KNOW-5
        self._settle_cognition(work, agent_id, record, result, allow_charge=True)
        decision, reason = model.parse_decision(result)
        if decision is None:
            reason = (reason or "invalid decision")[:200]
            self._emit(
                work,
                agent_id,
                "decision_invalid",
                f"{agent_id} produced an invalid decision: {reason}",
                {"reason": reason, "raw_text_excerpt": (result.text or "")[:200]},
            )
            context.record_system(
                store,
                f"your last reply was not a valid decision ({reason}); the turn was lost",
                w.round,
                work.turn_id,
                {"reason": "decision_invalid", "detail": reason},
            )
            agent.last_result = ActionResult(ok=False, reason="invalid_action", round=w.round, data={"error": reason})
            return
        self._apply_decision(work, agent_id, decision)

    def _settle_cognition(self, work: _TurnWork, agent_id: str, record: ModelCallRecord, result: ModelResult, allow_charge: bool) -> tuple[float, float]:
        """Design "Compute metering" step 3: charge measured usage (the reservation was never
        deducted); ``charged = min(cost, balance)``, the rest is ``uncharged_compute``
        (A-COG-6).  Agent-output failures are charged only with ``charge_failed_calls``
        (A-COG-3).  Emits model_call_completed / model_call_failed (+ cognition_charged for a
        charged failure) and discloses the charge as a system record (A-KNOW-6)."""
        w = work.world
        agent = w.agents[agent_id]
        store = work.cp.knowledge[agent_id]
        rates = w.rules.cognition
        usage = result.usage
        billed_input = usage.billed_input_tokens
        if usage.source == "estimate":
            billed_input = math.ceil(billed_input * rates.usage_estimate_safety_factor)
        cost = context.cognition_cost(rates, record.mind_multiplier, billed_input, usage.output_tokens)
        chargeable = allow_charge and (result.status == "ok" or rates.charge_failed_calls)
        charged = max(0.0, min(cost, agent.stats.compute)) if chargeable else 0.0
        uncharged = max(0.0, cost - charged)
        if charged > 0:
            agent.stats.compute -= charged
            agent.total_cognition_spent += charged
        record.charged_compute = charged
        record.uncharged_compute = uncharged
        common = {
            "call_id": record.call_id,
            "status": result.status,
            "usage": usage.model_dump(mode="json"),
            "latency_ms": result.latency_ms,
            "attempts": result.attempts,
            "provider_cost_usd": result.provider_cost_usd,
        }
        if result.status == "ok":
            self._emit(
                work,
                agent_id,
                "model_call_completed",
                f"{agent_id} got a decision from {record.model_key} (in {usage.billed_input_tokens} / out {usage.output_tokens} tokens)",
                {**common, "response_model": result.response_model, "uncharged_compute": uncharged},
                EventCosts(compute=charged),
            )
        else:
            self._emit(
                work,
                agent_id,
                "model_call_failed",
                f"{agent_id} got no usable decision from {record.model_key}: {result.status}",
                {**common, "error": result.error, "infra": False},
                EventCosts(compute=charged),
            )
            if charged > 0:
                # The charge is on the model_call_failed event above (INTERFACES section 7);
                # this audit event repeats it in details only, so summing event costs never
                # counts one charge twice.
                self._emit(
                    work,
                    agent_id,
                    "cognition_charged",
                    f"{agent_id} charged {_fmt(charged)} compute for a {result.status} reply",
                    {
                        "call_id": record.call_id,
                        "input_tokens": usage.billed_input_tokens,
                        "output_tokens": usage.output_tokens,
                        "mind_multiplier": record.mind_multiplier,
                        "charged": charged,
                        "uncharged": uncharged,
                    },
                )
        if allow_charge and cost > 0:
            text = f"your last decision cost {_fmt(charged)} compute"
            if uncharged > 0:
                text += f" ({_fmt(uncharged)} more could not be charged: balance exhausted)"
            context.record_system(
                store,
                text,
                w.round,
                work.turn_id,
                {"cognition_charged": charged, "uncharged": uncharged, "call_id": record.call_id},
                importance=0.2,
            )
        return charged, uncharged

    def _apply_decision(self, work: _TurnWork, agent_id: str, decision: Any) -> None:
        """Event decision; notebook; priorities; delete_skills then save_skills in list order
        (A-SKILL-6); then exactly one action (run_skill or a world action)."""
        w = work.world
        agent = w.agents[agent_id]
        store = work.cp.knowledge[agent_id]
        effective = work.cp.settings.effective_context(agent_id)
        action_dump = decision.action.model_dump(mode="json")
        thought = decision.thought or ""
        self._emit(
            work,
            agent_id,
            "decision",
            f"{agent_id} decides: {_describe_action(action_dump['name'], action_dump['args'])}" + (f' — "{_excerpt(thought)}"' if thought else ""),
            {
                "thought": thought,
                "action": action_dump,
                "notebook_updated": decision.notebook_update is not None,
                "saved_skills": [s.name for s in decision.save_skills],
                "deleted_skills": list(decision.delete_skills),
                "memory_priorities": [p.model_dump(mode="json") for p in decision.memory_priorities],
            },
        )
        if context.apply_notebook_update(store, decision.notebook_update, effective.notebook_max_tokens) and store.notebook_truncated:
            context.record_system(
                store,
                f"your notebook update was longer than {effective.notebook_max_tokens} tokens and was cut",
                w.round,
                work.turn_id,
                {"reason": "notebook_truncated", "limit": effective.notebook_max_tokens},
            )
        if decision.memory_priorities:
            context.apply_memory_priorities(store, list(decision.memory_priorities))
        for name in decision.delete_skills:
            error = skills.check_delete(name, agent.skills)
            if error:
                self._emit(work, agent_id, "skill_rejected", f"{agent_id} could not delete skill {name}: {error}", {"name": name, "error": error})
                context.record_system(store, f"skill {name} was not deleted: {error}", w.round, work.turn_id, {"skill": name, "error": error})
                continue
            self._stop_if_uses(work, agent, name)
            del agent.skills[name]
            self._emit(work, agent_id, "skill_deleted", f"{agent_id} deleted skill {name}", {"name": name})
        for request in decision.save_skills:
            try:
                definition = skills.validate_and_build(
                    request, agent.skills, agent.stats.skill_count_limit, agent.stats.skill_block_limit, w.rules.skills, w.round
                )
            except (skills.SkillValidationError, skills.SkillSyntaxError) as exc:
                error = str(exc)
                self._emit(work, agent_id, "skill_rejected", f"{agent_id} skill {request.name} rejected: {error}", {"name": request.name, "error": error})
                context.record_system(store, f"skill {request.name} was rejected: {error}", w.round, work.turn_id, {"skill": request.name, "error": error})
                continue
            self._stop_if_uses(work, agent, request.name)
            agent.skills[request.name] = definition
            self._emit(
                work,
                agent_id,
                "skill_saved",
                f"{agent_id} saved skill {request.name} ({definition.block_count} blocks)",
                {"name": request.name, "block_count": definition.block_count},
            )
        action = decision.action
        if action.name == "run_skill":
            args = action.args
            try:
                state = skills.start_execution(args.skill, list(args.arguments), agent.skills, w.round)
            except (skills.SkillValidationError, KeyError, ValueError) as exc:
                error = str(exc)
                self._emit(
                    work,
                    agent_id,
                    "skill_error",
                    f"{agent_id} could not run skill {args.skill}: {error}",
                    {"skill": args.skill, "ops": 0, "cost": 0.0, "status": "error", "error": error},
                )
                context.record_system(store, f"run_skill {args.skill} failed: {error}", w.round, work.turn_id, {"skill": args.skill, "error": error})
                agent.last_action = action_dump
                agent.last_result = ActionResult(ok=False, reason="invalid_action", round=w.round, data={"error": error})
                return
            agent.skill_execution = state
            self._emit(
                work,
                agent_id,
                "skill_started",
                f"{agent_id} starts skill {args.skill}",
                {"skill": args.skill, "ops": 0, "cost": 0.0, "status": "running"},
            )
            self._skill_step(work, agent_id, state, thought=thought, fresh=True)
            return
        agent.skill_execution = None
        self._execute_world_action(work, ActionRequest(agent_id=agent_id, action=action, via_skill=False), thought)

    # -- commit ------------------------------------------------------------------

    def _commit(self, work: _TurnWork) -> None:
        """Build the checkpoint, ``storage.write_checkpoint`` (which clears the committed
        call ids' pending files), swap ``self.checkpoint`` under the lock, clear ``last_error``."""
        cp = work.cp
        events = sorted(work.events, key=lambda e: e.seq)
        scheduler = work.scheduler
        record = TurnRecord(
            turn_id=work.turn_id,
            kind=work.kind,  # type: ignore[arg-type]
            round=work.round,
            turn_index=work.turn_index,
            acting_agent_id=work.agent_id,
            previous_turn_id=self.checkpoint.turn.turn_id,
            scheduler=SchedulerState(
                round=scheduler.round, order=list(scheduler.order), next_index=scheduler.next_index, round_complete=scheduler.round_complete
            ),
            decision_source=work.decision_source,  # type: ignore[arg-type]
            packet_id=work.packet_id,
            model_call_ids=[r.call_id for r in work.model_calls],
            action=work.action,
            action_result=work.action_result,
            interventions=list(work.interventions),
            event_seq_start=events[0].seq if events else 0,
            event_seq_end=events[-1].seq if events else 0,
            code_revision=self._code_revision,
        )
        checkpoint = Checkpoint(
            turn=record,
            world=cp.world,
            knowledge=cp.knowledge,
            settings=cp.settings,
            events=events,
            model_calls=list(work.model_calls),
            decision_packets=list(work.packets),
        )
        with self._io_lock:
            with self._lock:
                # A copy: a failed write must leave the in-memory manifest (finished flags,
                # ledger) exactly as committed.
                manifest = self.manifest.model_copy(deep=True)
                interrupted_ids = set(self._interrupted_call_ids)
            manifest.finished = work.finished_reason is not None
            manifest.finished_reason = work.finished_reason
            for call in work.model_calls:  # every uncommitted record enters the ledger here, once
                add_record_to_ledger(manifest.real_usage, call, call.call_id in interrupted_ids)
            new_manifest = storage.write_checkpoint(manifest, checkpoint)
            prediction = self._predict_next_round(checkpoint)
            with self._lock:
                new_manifest.next_intervention_seq = max(new_manifest.next_intervention_seq, self.manifest.next_intervention_seq)
                self.manifest = new_manifest
                self.checkpoint = checkpoint
                self._next_round_order = prediction
                self._last_error = None
                self._carried_calls = []
                self._carried_events = []
                self._last_commit_kind = work.kind
                self._active = None
            for ref in work.snapshots_to_delete:
                try:
                    storage.delete_staged_snapshot(self.run_id, ref)
                except Exception:  # noqa: BLE001 - best effort cleanup
                    log.warning("could not delete applied snapshot %s", ref)
        self._work = None
        # rev 4: the committed turn is final; tell listeners (outside both locks, on this
        # thread).  Nothing a listener does can affect the commit.
        if self._on_commit is not None:
            try:
                self._on_commit(self.run_id, work.turn_id, work.kind, work.round)
            except Exception:  # noqa: BLE001 - a listener bug must never look like a failed turn
                log.exception("commit listener failed for %s %s", self.run_id, work.turn_id)

    # -- interventions at the boundary (INTERFACES section 10) --------------------

    def _apply_staged_edits(self, work: _TurnWork) -> None:
        """Pop the staged list atomically under the lock and route each intervention:
        world.apply_world_intervention for set_stat / place_entity / remove_entity /
        update_plant_rules / update_prices (a placed agent also gets a knowledge store with
        ``context.record_run_start`` and its model/context assignment in settings);
        context.apply_knowledge_intervention for edit_knowledge; context.deliver_voice for
        voice (recipients resolved: agents list, all living agents, or living agents at a
        point); settings for update_context_settings (replace/merge per schema docstring),
        update_model_assignment (mind multiplier snapshot; re-validate every affected
        agent's context settings; reject whole on failure) and update_run_settings;
        the recorded field diff applied onto the current boundary state for
        apply_working_files (stale base_turn_id -> ok=False; earlier staged edits
        survive, see _apply_working_files).  Each produces an
        InterventionRecord and an "intervention" (or "operator_voice") event with
        before/after; a failing intervention is recorded with ok=False and skipped.
        Afterwards every agent's effective settings are validated once more.
        Nobody is charged (spec "God mode": both editing paths record before/after values,
        origin and effective boundary)."""
        with self._lock:
            staged = list(self._staged)
            self._staged = []
        if not staged:
            return
        work.popped_staged = staged
        try:
            with self._io_lock:
                storage.write_staged_edits(self.run_id, StagedEdits(interventions=[]))
        except Exception:  # noqa: BLE001 - the in-memory list is authoritative; disk is repaired at the next write
            log.exception("could not clear staged_edits.json")
        w = work.world
        # Records and knowledge entries carry the round of the turn the edits take effect
        # in (``work.round``: at a new-round boundary the round about to start, while the
        # world's own counter still reads the completed round until the round starts).
        for iv in staged:
            record = InterventionRecord(intervention=iv, effective_turn_id=work.turn_id, applied_round=work.round, ok=True)
            recipients: list[str] = []
            try:
                if iv.type == "voice":
                    recipients = self._voice_recipients(work, iv)
                    delivered = context.deliver_voice(work.cp.knowledge, recipients, iv.text, work.round, work.turn_id)
                    record.changes = [FieldChange(path=f"knowledge.{r.agent_id}.records[{r.id}]", before=None, after=r.model_dump(mode="json")) for r in delivered]
                else:
                    record.changes = self._apply_intervention(work, iv)
            except (_InterventionRejected, world.InterventionError, world.WorldError, ValueError, KeyError) as exc:
                record.ok = False
                record.error = self._redact(str(exc))
                if iv.type == "apply_working_files":
                    work.snapshots_to_delete.append(iv.snapshot_ref)
            work.interventions.append(record)
            details = {
                "intervention": iv.model_dump(mode="json"),
                "ok": record.ok,
                "error": record.error,
                "changes": [c.model_dump(mode="json") for c in record.changes],
                "origin": iv.origin,
                "effective_turn_id": work.turn_id,
            }
            outcome = "ok" if record.ok else f"failed ({record.error})"
            if iv.type == "voice" and record.ok:
                details.update({"recipients": recipients, "text": iv.text})
                self._emit(work, "operator", "operator_voice", f"operator voice to {', '.join(recipients) or 'nobody'}: \"{iv.text[:60]}\"", details)
            else:
                self._emit(work, "operator", "intervention", f"operator {iv.id or ''} {iv.type} -> {outcome}, {len(record.changes)} changes", details)
            if iv.type == "set_stat" and record.ok:
                # Cause before effect in the feed: the intervention event first, then the
                # death / residue events it produced (fix pass).
                self._emit_operator_deaths(work, record.changes)
        errors = self._settings_errors(work.cp.settings, list(w.agents), w.rules)
        if errors:
            raise _TurnFailure("invalid effective context settings after interventions: " + "; ".join(errors))

    def _emit_operator_deaths(self, work: _TurnWork, changes: list[FieldChange]) -> None:
        """A set_stat that leaves a living agent at health <= 0 is resolved by world.py as
        ``kill_agent(cause="operator")`` (A-DEATH-6), but ``apply_world_intervention`` returns
        only FieldChanges.  Emit the ``death`` (and ``residue_created``) events from those
        changes so the feed and the history show the death like any other (INTERFACES
        section 7).  No damage notice: the agent is dead and takes no further decision."""
        w = work.world
        residues = [c for c in changes if c.path.startswith("world.residues.") and c.before is None and c.after]
        for change in changes:
            parts = change.path.split(".")
            if len(parts) != 4 or parts[:2] != ["world", "agents"] or parts[3] != "alive":
                continue
            if change.before is not True or change.after is not False:
                continue
            agent_id = parts[2]
            residue = next((r for r in residues if (r.after or {}).get("source_id") == agent_id), None)
            residue_id = (residue.after or {}).get("id") if residue is not None else None
            agent = w.agents.get(agent_id)
            label = f"{agent.name} ({agent_id})" if agent is not None else agent_id
            self._emit(
                work,
                "world",
                "death",
                f"{label} died (operator)" + (f", residue {residue_id}" if residue_id else ""),
                {"entity_id": agent_id, "kind": "agent", "cause": "operator", "residue_id": residue_id},
            )
            if residue is not None and residue.after:
                after = residue.after
                self._emit(
                    work,
                    "world",
                    "residue_created",
                    f"residue {after.get('id')} left by {agent_id}: {after.get('available_compute', 0)} compute, "
                    f"{after.get('available_essence', 0)} essence",
                    {
                        "residue_id": after.get("id"),
                        "source_id": agent_id,
                        "compute": after.get("available_compute", 0),
                        "essence": after.get("available_essence", 0),
                        "position": after.get("position"),
                    },
                )

    def _voice_recipients(self, work: _TurnWork, iv: Any) -> list[str]:
        w = work.world
        mode = iv.recipients.mode
        if mode == "agents":
            missing = [a for a in iv.recipients.agent_ids if a not in w.agents and a not in work.cp.knowledge]
            if missing:
                raise _InterventionRejected(f"unknown agents: {', '.join(missing)}")
            return list(iv.recipients.agent_ids)
        if mode == "broadcast_all":
            return [a.id for a in world.living_agents(w)]
        return [e.id for e in world.entities_at(w, iv.recipients.point, True) if e.kind == "agent"]

    def _apply_intervention(self, work: _TurnWork, iv: Any) -> list[FieldChange]:
        """Route one non-voice intervention; raises on failure (nothing applied)."""
        w = work.world
        kind = iv.type
        if kind in WORLD_INTERVENTION_TYPES:
            if kind == "place_entity" and iv.entity.kind == "agent":
                return self._place_agent(work, iv)
            return list(world.apply_world_intervention(w, iv))
        if kind == "edit_knowledge":
            return list(context.apply_knowledge_intervention(work.cp.knowledge, iv, work.round, work.turn_id))
        if kind == "update_context_settings":
            trial = work.cp.settings.model_copy(deep=True)
            affected = self._merge_context_settings(trial, iv, w)
            errors = self._settings_errors(trial, affected, w.rules)
            if errors:
                raise _InterventionRejected("; ".join(errors))
            changes = self._settings_diff(work.cp.settings, trial)
            work.cp.settings = trial
            return changes
        if kind == "update_model_assignment":
            trial = work.cp.settings.model_copy(deep=True)
            trial_rules = w.rules.model_copy(deep=True)
            affected, changes = self._assign_model(trial, trial_rules, iv, w)
            errors = self._settings_errors(trial, affected, trial_rules)
            if errors:
                raise _InterventionRejected("; ".join(errors))
            changes = self._settings_diff(work.cp.settings, trial) + changes
            work.cp.settings = trial
            w.rules = trial_rules
            return changes
        if kind == "update_run_settings":
            trial = work.cp.settings.model_copy(deep=True)
            if iv.clear_max_rounds:
                trial.max_rounds = None
            elif iv.max_rounds is not None:
                trial.max_rounds = iv.max_rounds
            if iv.clear_real_budget:
                trial.real_budget_usd = None
            elif iv.real_budget_usd is not None:
                trial.real_budget_usd = iv.real_budget_usd
            if iv.play_delay_seconds is not None:
                trial.play_delay_seconds = iv.play_delay_seconds
            changes = self._settings_diff(work.cp.settings, trial)
            work.cp.settings = trial
            return changes
        if kind == "apply_working_files":
            return self._apply_working_files(work, iv)
        raise _InterventionRejected(f"unknown intervention type {kind}")

    @staticmethod
    def _settings_diff(before: RunSettings, after: RunSettings) -> list[FieldChange]:
        """Top-level-key diff of two RunSettings dumps, paths ``settings.<key>``."""
        b = before.model_dump(mode="json")
        a = after.model_dump(mode="json")
        changes: list[FieldChange] = []
        for key in a:
            if key in ("context", "context_overrides", "model_overrides") and isinstance(a[key], dict):
                for sub in set(a[key]) | set(b.get(key, {})):
                    if a[key].get(sub) != b.get(key, {}).get(sub):
                        changes.append(FieldChange(path=f"settings.{key}.{sub}", before=b.get(key, {}).get(sub), after=a[key].get(sub)))
            elif a[key] != b.get(key):
                changes.append(FieldChange(path=f"settings.{key}", before=b.get(key), after=a[key]))
        return changes

    @staticmethod
    def _merge_context_settings(settings: RunSettings, iv: Any, w: WorldState) -> list[str]:
        """scope run: merge non-None fields into ``settings.context``; scope agent: REPLACE the
        override (all-None deletes it).  Returns the affected agent ids."""
        if iv.scope == "run":
            settings.context = iv.settings.apply_to(settings.context)
            return list(w.agents)
        if iv.scope not in w.agents:
            raise _InterventionRejected(f"unknown agent scope {iv.scope!r}")
        if iv.settings.is_empty():
            settings.context_overrides.pop(iv.scope, None)
        else:
            settings.context_overrides[iv.scope] = iv.settings
        return [iv.scope]

    def _assign_model(self, settings: RunSettings, rules: Any, iv: Any, w: WorldState) -> tuple[list[str], list[FieldChange]]:
        """Run default or per-agent model override; the key must exist, be available and not be
        assistant-only; a missing mind multiplier is snapshotted from the registry (FieldChange)."""
        return _assign_model(self.registry, settings, rules, iv, w)

    def _place_agent(self, work: _TurnWork, iv: Any) -> list[FieldChange]:
        """place_entity for an agent: world placement, then a knowledge store with the birth
        disclosure and the model/context assignment in RunSettings (never on the Agent).
        The model key and the effective context settings are validated against the
        settings AS THEY ARE at this boundary (an earlier staged edit may have changed
        them) BEFORE anything is placed, so a rejected placement leaves the world,
        knowledge and settings untouched (INTERFACES section 10: a failing intervention
        is recorded with ok=False and skipped)."""
        w = work.world
        settings = work.cp.settings
        if iv.model_key is not None:
            error = self.registry.validate_agent_key(iv.model_key)
            if error:
                raise _InterventionRejected(f"model {iv.model_key!r}: {error}")
        key = iv.model_key or settings.default_model_key
        try:
            ref = self.registry.get(key)
        except model.UnknownModelError:
            raise _InterventionRejected(f"unknown model {key!r}") from None
        overrides = iv.context_overrides if iv.context_overrides is not None and not iv.context_overrides.is_empty() else None
        try:
            effective = overrides.apply_to(settings.context) if overrides is not None else settings.context
        except Exception as exc:  # noqa: BLE001 - pydantic error on the merged settings
            raise _InterventionRejected(f"invalid context override ({exc})") from None
        mind = w.rules.cognition.mind_multipliers.get(key, ref.mind_multiplier)
        errors = context.validate_settings(effective, ref.capabilities, mind)
        if errors:
            raise _InterventionRejected("; ".join(errors))
        before_ids = set(w.agents)
        changes = list(world.apply_world_intervention(w, iv))
        for agent_id in [a for a in w.agents if a not in before_ids]:
            agent = w.agents[agent_id]
            store = context.new_knowledge(agent_id)
            context.record_run_start(store, agent, work.round, work.turn_id)
            work.cp.knowledge[agent_id] = store
            changes.append(FieldChange(path=f"knowledge.{agent_id}", before=None, after="created"))
            if iv.model_key is not None:
                settings.model_overrides[agent_id] = iv.model_key
                changes.append(FieldChange(path=f"settings.model_overrides.{agent_id}", before=None, after=iv.model_key))
                if iv.model_key not in w.rules.cognition.mind_multipliers:
                    value = self.registry.get(iv.model_key).mind_multiplier
                    w.rules.cognition.mind_multipliers[iv.model_key] = value
                    changes.append(FieldChange(path=f"rules.cognition.mind_multipliers.{iv.model_key}", before=None, after=value))
            if iv.context_overrides is not None and not iv.context_overrides.is_empty():
                settings.context_overrides[agent_id] = iv.context_overrides
                changes.append(FieldChange(path=f"settings.context_overrides.{agent_id}", before=None, after=iv.context_overrides.model_dump(mode="json")))
            errors = self._settings_errors(settings, [agent_id], w.rules)
            if errors:
                raise _InterventionRejected("; ".join(errors))
        return changes

    def _apply_working_files(self, work: _TurnWork, iv: Any) -> list[FieldChange]:
        """Apply the reload's recorded field diff (``iv.changes``, taken against the committed
        turn ``base_turn_id``) onto the boundary state AS IT IS NOW, i.e. after every staged
        edit applied before it (A-GOD-1; INTERFACES section 10).  Earlier UI edits therefore
        survive whatever the staging order; a field changed by both keeps this diff's value.
        The result is validated as a whole (``storage.apply_working_changes``: schema, cross
        references, ``validate_world``; then the effective context settings) and nothing is
        applied when anything fails (ok=False with the problems).  Stale ``base_turn_id`` ->
        "stale" (ok=False).  The returned changes carry the value each field really had at
        apply time as ``before``.  The staged snapshot is only a record of what was reloaded."""
        committed = self.checkpoint.turn.turn_id
        if iv.base_turn_id != committed:
            raise _InterventionRejected(f"stale: committed turn is {committed}")
        # A different round would move simulation time (turn ids, action rounds) out of the
        # chain: refused both from the diff and from the snapshot it was taken from.
        edited_round = next((c.after for c in iv.changes if c.path == "world.round"), None)
        if edited_round is None:
            try:
                snapshot = storage.read_staged_snapshot(self.run_id, iv.snapshot_ref)
            except storage.StorageError as exc:
                raise _InterventionRejected(f"staged snapshot unreadable: {exc}") from None
            if snapshot.world.round != work.world.round:
                edited_round = snapshot.world.round
        if edited_round is not None and edited_round != work.world.round:
            raise _InterventionRejected(
                f"invalid world: round {edited_round} differs from the committed round {work.world.round} "
                "(the round counter cannot be edited)"
            )
        new_state, applied, problems = storage.apply_working_changes(work.world, work.cp.knowledge, work.cp.settings, list(iv.changes))
        if new_state is None or problems:
            raise _InterventionRejected("cannot apply the file edit onto the current state: " + "; ".join(problems))
        errors = self._settings_errors(new_state.settings, list(new_state.world.agents), new_state.world.rules)
        if errors:
            raise _InterventionRejected("invalid settings: " + "; ".join(errors))
        errors = world.replace_world(work.world, new_state.world)
        if errors:
            raise _InterventionRejected("invalid world: " + "; ".join(errors))
        work.cp.knowledge.clear()
        work.cp.knowledge.update(new_state.knowledge)
        work.cp.settings = new_state.settings
        work.snapshots_to_delete.append(iv.snapshot_ref)
        return applied


# ---------------------------------------------------------------------------
# RunManager
# ---------------------------------------------------------------------------


def command_allowed(state: str, command: str) -> Optional[str]:
    """The ``RunWorker.submit`` rule as a pure function (rev 4; shared with assistant brief
    validation).  ``None`` when ``command`` may be submitted in ``state``, else the exact
    ``RunnerError`` message: ``pause`` is always allowed (a no-op outside running states);
    ``run_turn`` / ``play`` / ``step_round`` only from ``paused`` or ``finished``; anything
    else is an unknown command.  It does not know whether the run is open."""
    if command == "pause":
        return None
    if command not in RUN_COMMANDS:
        return f"illegal_command: unknown command {command!r}"
    if state not in ("paused", "finished"):
        return f"illegal_command: {command} while {state}"
    return None


def _settings_errors(registry: model.ModelRegistry, settings: RunSettings, agent_ids: list[str], rules: Any) -> list[str]:
    """Every agent's effective context settings checked against its effective model
    (``context.validate_settings``); messages are prefixed with the agent id."""
    errors: list[str] = []
    for agent_id in agent_ids:
        key = settings.effective_model_key(agent_id)
        try:
            ref = registry.get(key)
        except model.UnknownModelError:
            errors.append(f"{agent_id}: unknown model {key!r}")
            continue
        try:
            effective = settings.effective_context(agent_id)
        except Exception as exc:  # noqa: BLE001 - pydantic error on a bad override
            errors.append(f"{agent_id}: invalid context override ({exc})")
            continue
        for message in context.validate_settings(effective, ref.capabilities, rules.cognition.multiplier_for(key)):
            errors.append(f"{agent_id}: {message}")
    return errors


def _assign_model(registry: model.ModelRegistry, settings: RunSettings, rules: Any, iv: Any, w: WorldState) -> tuple[list[str], list[FieldChange]]:
    """Run default or per-agent model override; the key must exist, be available and not be
    assistant-only (``validate_agent_key``); a missing mind multiplier is snapshotted from the
    registry (FieldChange).  Mutates ``settings`` / ``rules`` (callers pass trial copies when
    validating)."""
    changes: list[FieldChange] = []
    if iv.model_key is not None:
        error = registry.validate_agent_key(iv.model_key)
        if error:
            raise _InterventionRejected(f"model {iv.model_key!r}: {error}")
    if iv.scope == "run":
        if iv.model_key is None:
            raise _InterventionRejected("model_key: the run default cannot be cleared")
        settings.default_model_key = iv.model_key
        affected = [a for a in w.agents if a not in settings.model_overrides]
    else:
        if iv.scope not in w.agents:
            raise _InterventionRejected(f"unknown agent scope {iv.scope!r}")
        if iv.model_key is None:
            settings.model_overrides.pop(iv.scope, None)
        else:
            settings.model_overrides[iv.scope] = iv.model_key
        affected = [iv.scope]
    if iv.model_key is not None and iv.model_key not in rules.cognition.mind_multipliers:
        value = registry.get(iv.model_key).mind_multiplier
        rules.cognition.mind_multipliers[iv.model_key] = value
        changes.append(FieldChange(path=f"rules.cognition.mind_multipliers.{iv.model_key}", before=None, after=value))
    return affected, changes


def validate_intervention_on(cp: Checkpoint, registry: model.ModelRegistry, run_id: str, iv: Intervention) -> list[ApiProblem]:
    """Staging validation of ``iv`` against the committed checkpoint ``cp`` (INTERFACES section
    10), as a pure function (rev 4): nothing is opened, locked or written.  World and knowledge
    interventions are dry-run on a deep copy so the exact apply rule decides; settings
    interventions are checked with ``context.validate_settings``; a ``place_entity`` /
    ``update_model_assignment`` model key must pass ``registry.validate_agent_key``.
    ``run_id`` is needed only to look up an ``apply_working_files`` snapshot.  Empty = valid."""
    w = cp.world
    settings = cp.settings
    problems: list[ApiProblem] = []

    def problem(path: str, message: str) -> None:
        problems.append(ApiProblem(path=path, message=message))

    kind = iv.type
    if kind in WORLD_INTERVENTION_TYPES:
        if kind == "place_entity" and iv.entity.kind == "agent":
            if iv.model_key is not None:
                err = registry.validate_agent_key(iv.model_key)
                if err:
                    problem("model_key", err)
            if iv.context_overrides is not None and not iv.context_overrides.is_empty() and not problems:
                key = iv.model_key or settings.default_model_key
                try:
                    ref = registry.get(key)
                    effective = iv.context_overrides.apply_to(settings.context)
                    for message in context.validate_settings(effective, ref.capabilities, w.rules.cognition.multiplier_for(key)):
                        problem("context_overrides", message)
                except Exception as exc:  # noqa: BLE001
                    problem("context_overrides", str(exc))
        try:
            world.apply_world_intervention(copy.deepcopy(w), iv)
        except Exception as exc:  # noqa: BLE001 - InterventionError, WorldError, pydantic
            problem("entity_id" if kind in ("set_stat", "remove_entity") else "", str(exc))
    elif kind == "edit_knowledge":
        if iv.agent_id not in cp.knowledge:
            problem("agent_id", f"unknown agent {iv.agent_id}")
        else:
            try:
                context.apply_knowledge_intervention(copy.deepcopy(cp.knowledge), iv, w.round, cp.turn.turn_id)
            except Exception as exc:  # noqa: BLE001
                problem("", str(exc))
    elif kind == "voice":
        if iv.recipients.mode == "agents":
            for i, agent_id in enumerate(iv.recipients.agent_ids):
                if agent_id not in w.agents and agent_id not in cp.knowledge:
                    problem(f"recipients.agent_ids[{i}]", f"unknown agent {agent_id}")
            if not iv.recipients.agent_ids:
                problem("recipients.agent_ids", "at least one recipient")
        if not iv.text.strip():
            problem("text", "voice text is empty")
    elif kind == "update_context_settings":
        trial = settings.model_copy(deep=True)
        try:
            affected = RunWorker._merge_context_settings(trial, iv, w)
        except _InterventionRejected as exc:
            problem("scope", str(exc))
        else:
            for message in _settings_errors(registry, trial, affected, w.rules):
                problem("settings", message)
    elif kind == "update_model_assignment":
        trial = settings.model_copy(deep=True)
        trial_rules = w.rules.model_copy(deep=True)
        try:
            affected, _ = _assign_model(registry, trial, trial_rules, iv, w)
        except _InterventionRejected as exc:
            problem("model_key" if "model" in str(exc) else "scope", str(exc))
        else:
            for message in _settings_errors(registry, trial, affected, trial_rules):
                problem("settings", message)
    elif kind == "apply_working_files":
        if iv.base_turn_id != cp.turn.turn_id:
            problem("base_turn_id", f"stale: committed turn is {cp.turn.turn_id}")
        try:
            storage.read_staged_snapshot(run_id, iv.snapshot_ref)
        except Exception as exc:  # noqa: BLE001
            problem("snapshot_ref", str(exc))
    # update_run_settings: every bound is a schema constraint already
    return problems


def _context_problem(prefix: str, message: str) -> tuple[str, str]:
    """``context.validate_settings`` reports ``"<field path>: <message>"``; turn that into an
    ApiProblem path under ``prefix`` (``context.generation_allowance``,
    ``agents[2].context_overrides.weights``) so the UI can point at the field.  A message
    without a field prefix stays on ``prefix``."""
    field, sep, rest = message.partition(": ")
    if sep and field and " " not in field and rest:
        return f"{prefix}.{field}", rest
    return prefix, message


class RunManager:
    """Registry of open runs; one RunWorker per run id.  Owned by api.py's app state.
    Every open worker holds its run's writer lock (``storage.acquire_writer_lock``), so
    one run has one active writer across processes (spec "Sessions and run controls");
    a second opener gets ``RunnerError("illegal_command: ...")`` (409)."""

    def __init__(self, registry: model.ModelRegistry) -> None:
        self.registry = registry
        self._workers: dict[str, RunWorker] = {}
        self._closing: dict[str, RunWorker] = {}  # closed workers still finishing their last turn
        self._lock = threading.Lock()
        self._open_lock = threading.Lock()  # serialises open_run so a concurrent second open is idempotent
        self._commit_listeners: list[Callable[[str, str, str, int], None]] = []  # rev 4; read at call time

    # -- commit listeners (rev 4) -------------------------------------------------

    def add_commit_listener(self, callback: Callable[[str, str, str, int], None]) -> None:
        """Register ``callback(run_id, turn_id, kind, round)`` for every turn any worker of this
        manager commits from now on (``kind`` is ``agent_turn`` | ``round_end``; the init turn
        and a continuation's first turn are not commits).  Called on the worker thread right
        after the commit is final; it must return quickly and only set a flag or submit to an
        executor.  Exceptions are logged and swallowed; ``RuntimeError`` (an executor that was
        shut down) is dropped silently."""
        with self._lock:
            if callback not in self._commit_listeners:
                self._commit_listeners.append(callback)

    def remove_commit_listener(self, callback: Callable[[str, str, str, int], None]) -> None:
        with self._lock:
            if callback in self._commit_listeners:
                self._commit_listeners.remove(callback)

    def _fan_out_commit(self, run_id: str, turn_id: str, kind: str, round_no: int) -> None:
        """The single ``on_commit`` every worker gets: snapshots the listener list at call time
        and isolates each listener's failure."""
        with self._lock:
            listeners = list(self._commit_listeners)
        for callback in listeners:
            try:
                callback(run_id, turn_id, kind, round_no)
            except RuntimeError as exc:  # an executor after shutdown: expected during process exit
                log.debug("commit listener dropped (%s) for %s %s", exc, run_id, turn_id)
            except Exception:  # noqa: BLE001
                log.exception("commit listener %r failed for %s %s", callback, run_id, turn_id)

    # -- setup -------------------------------------------------------------------

    def validate_setup(self, request: RunCreateRequest) -> list[ApiProblem]:
        """Every semantic problem at once (INTERFACES section 9 "Setup validation"), with
        paths like ``agents[2].position`` or ``context.generation_allowance``.  Empty = valid."""
        problems: list[ApiProblem] = []

        def problem(path: str, message: str) -> None:
            problems.append(ApiProblem(path=path, message=message))

        cards = request.agents
        if not config.MIN_AGENTS <= len(cards) <= config.MAX_AGENTS:
            problem("agents", f"{config.MIN_AGENTS} to {config.MAX_AGENTS} agent cards are required")
        if isinstance(request.seed, bool) or not isinstance(request.seed, int):
            problem("seed", "seed must be an integer")
        default_error = self.registry.validate_agent_key(request.default_model_key)
        if default_error:
            problem("default_model_key", default_error)
        rules = request.rules
        for species, count in request.world.initial_plants.items():
            if species not in rules.plant_species:
                problem(f"world.initial_plants.{species}", f"unknown plant species {species!r}")
            if count < 0:
                problem(f"world.initial_plants.{species}", "count must be >= 0")
        if not default_error:
            ref = self.registry.get(request.default_model_key)
            for message in context.validate_settings(request.context, ref.capabilities, ref.mind_multiplier):
                problem(*_context_problem("context", message))
        filled = assign_card_ids(cards)
        seen_ids: dict[str, int] = {}
        seen_names: dict[str, int] = {}
        region = request.world.region
        for i, card in enumerate(filled):
            path = f"agents[{i}]"
            assert card.id is not None
            if card.id in seen_ids:
                problem(f"{path}.id", f"duplicate id {card.id!r} (also agents[{seen_ids[card.id]}])")
            seen_ids.setdefault(card.id, i)
            if card.name in seen_names:
                problem(f"{path}.name", f"duplicate name {card.name!r} (also agents[{seen_names[card.name]}])")
            seen_names.setdefault(card.name, i)
            if not region.contains(card.position):
                problem(f"{path}.position", f"({card.position.x},{card.position.y}) is outside the region")
            stats = card.stats
            for name, value in stats.model_dump().items():
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    continue
                if not math.isfinite(value) or value < 0:
                    problem(f"{path}.stats.{name}", "must be a finite number >= 0")
            if stats.health > stats.max_health:
                problem(f"{path}.stats.health", "health exceeds max_health")
            if stats.essence > stats.essence_capacity:
                problem(f"{path}.stats.essence", "essence exceeds essence_capacity")
            key = card.model_key or request.default_model_key
            card_error = self.registry.validate_agent_key(card.model_key) if card.model_key else default_error
            if card.model_key and card_error:
                problem(f"{path}.model_key", card_error)
            if not card_error:
                ref = self.registry.get(key)
                try:
                    effective = card.context_overrides.apply_to(request.context) if card.context_overrides else request.context
                except Exception as exc:  # noqa: BLE001 - pydantic error on the merged settings
                    problem(f"{path}.context_overrides", str(exc))
                else:
                    for message in context.validate_settings(effective, ref.capabilities, ref.mind_multiplier):
                        problem(*_context_problem(f"{path}.context_overrides", message))
            existing: dict[str, Any] = {}
            for j, skill_request in enumerate(card.initial_skills):
                try:
                    definition = skills.validate_and_build(
                        skill_request, existing, stats.skill_count_limit, stats.skill_block_limit, rules.skills, 0
                    )
                    existing[definition.name] = definition
                except Exception as exc:  # noqa: BLE001 - SkillValidationError / SkillSyntaxError
                    problem(f"{path}.initial_skills[{j}]", str(exc))
        return problems

    def create_run(self, request: RunCreateRequest) -> RunSummary:
        """``validate_setup`` -> SetupError(problems) if any.  Then: snapshot mind multipliers
        into ``rules.cognition.mind_multipliers`` for every model key used; copy card
        model_key / context_overrides into RunSettings; compile initial skills; generate the
        world (A-WORLD-6 moves reported as run_created warnings); create knowledge stores
        with ``context.record_run_start``; build the r00000_init checkpoint (events:
        run_created); save it with ``assumptions.json``; open the worker paused; return the
        summary."""
        problems = self.validate_setup(request)
        if problems:
            raise SetupError(problems)
        cards = assign_card_ids(request.agents)
        rules = request.rules.model_copy(deep=True)
        for key in {request.default_model_key, *[c.model_key for c in cards if c.model_key]}:
            rules.cognition.mind_multipliers[key] = self.registry.get(key).mind_multiplier
        settings = RunSettings(
            context=request.context.model_copy(deep=True),
            context_overrides={c.id: c.context_overrides for c in cards if c.id and c.context_overrides and not c.context_overrides.is_empty()},
            default_model_key=request.default_model_key,
            model_overrides={c.id: c.model_key for c in cards if c.id and c.model_key},
            max_rounds=request.max_rounds,
            play_delay_seconds=request.play_delay_seconds,
            real_budget_usd=request.real_budget_usd,
            fake_scripts={c.id: list(c.fake_script) for c in cards if c.id and c.fake_script is not None},
            fake_options={c.id: dict(c.fake_options) for c in cards if c.id and c.fake_options is not None},
        )
        state = world.generate_world(request.world, rules, request.seed, cards)
        warnings = list(world.world_warnings(state))
        knowledge = {}
        for card in cards:
            assert card.id is not None
            agent = state.agents[card.id]
            existing: dict[str, Any] = {}
            for skill_request in card.initial_skills:
                definition = skills.validate_and_build(
                    skill_request, existing, agent.stats.skill_count_limit, agent.stats.skill_block_limit, rules.skills, 0
                )
                existing[definition.name] = definition
            agent.skills = existing
            store = context.new_knowledge(card.id, card.notebook)
            context.record_run_start(store, agent, 0, TurnId.INIT)
            knowledge[card.id] = store
        world_id = request.world_id or storage.new_world_id()
        run_id = storage.new_run_id(request.name)
        now = utc_now_iso()
        revision = storage.code_revision()
        agent_ids = [c.id for c in cards if c.id]
        event = Event(
            seq=1,
            turn_id=TurnId.INIT,
            round=0,
            turn=None,
            actor="system",
            kind="run_created",
            summary=f"run {request.name!r} created with {len(agent_ids)} agents (seed {request.seed})",
            details={"run_id": run_id, "world_id": world_id, "agent_ids": agent_ids, "seed": request.seed, "warnings": warnings},
        )
        turn = TurnRecord(
            turn_id=TurnId.INIT,
            kind="init",
            round=0,
            scheduler=SchedulerState(round=0, order=[], next_index=0, round_complete=True),
            event_seq_start=1,
            event_seq_end=1,
            code_revision=revision,
        )
        checkpoint = Checkpoint(turn=turn, world=state, knowledge=knowledge, settings=settings, events=[event])
        manifest = Manifest(
            world_id=world_id,
            run_id=run_id,
            name=request.name,
            created_at=now,
            updated_at=now,
            seed=request.seed,
            code_revision=revision,
            current_turn_id=TurnId.INIT,
            last_round=0,
            last_turn_index=None,
            next_event_seq=2,
            next_intervention_seq=1,
            agent_count=len(agent_ids),
            living_agent_count=sum(1 for a in state.agents.values() if a.alive),
            default_model_key=request.default_model_key,
        )
        manifest = storage.create_run(request, manifest, checkpoint, config.assumption_entries())
        lock = storage.acquire_writer_lock(run_id)
        if lock is None:  # the id is fresh; only a foreign opener racing on the new dir could hold it
            raise RunnerError(f"illegal_command: run {run_id} is open in another process")
        worker = RunWorker(manifest, checkpoint, self.registry, writer_lock=lock, on_commit=self._fan_out_commit)
        try:
            worker.start([])
        except BaseException:
            lock.release()
            raise
        with self._lock:
            self._workers[run_id] = worker
        return summary_from_manifest(worker.manifest, worker.status().state)

    def preview_world(self, request: WorldPreviewRequest) -> MapState:
        """Terrain for a seed + world config (world.generate_terrain), no run created."""
        return world.generate_terrain(request.world, random.Random(request.seed))

    # -- open / close -------------------------------------------------------------

    def open_run(self, run_id: str) -> RunWorker:
        """Take the run's writer lock, ``storage.recover_run``, load the latest complete
        checkpoint and start a paused worker with the leftover pending call records
        (idempotent while open).  A worker of this run that was closed and is still
        finishing its last turn is waited for first.  ``RunnerError`` (409
        ``illegal_command``) when another process holds the run open."""
        worker = self.get(run_id)
        if worker is not None:
            return worker
        self._wait_for_closing(run_id)
        with self._open_lock:
            worker = self.get(run_id)
            if worker is not None:
                return worker
            lock = storage.acquire_writer_lock(run_id)
            if lock is None:
                raise RunnerError(f"illegal_command: run {run_id} is open in another process")
            try:
                report = storage.recover_run(run_id)
                for warning in getattr(report, "warnings", []):
                    log.warning("recovery of %s: %s", run_id, warning)
                manifest = storage.read_manifest(run_id)
                checkpoint = storage.load_checkpoint(run_id)
                worker = RunWorker(manifest, checkpoint, self.registry, writer_lock=lock, on_commit=self._fan_out_commit)
                worker.start(list(report.pending_calls))
            except BaseException:
                lock.release()
                raise
            with self._lock:
                self._workers[run_id] = worker
        return worker

    def _wait_for_closing(self, run_id: str) -> None:
        """Join a closed worker of this run (POST /close returns before the worker's active
        turn has committed) so the reopened worker starts from that commit."""
        with self._lock:
            closing = self._closing.pop(run_id, None)
        if closing is not None:
            closing.join()

    def close_run(self, run_id: str) -> RunStatus:
        """Pause, tell the worker to stop and forget it; returns at once (the worker finishes
        an active turn on its own).  RunnerError("run_not_open") when not open."""
        with self._lock:
            worker = self._workers.pop(run_id, None)
        if worker is None:
            raise RunnerError("run_not_open")
        status = worker.close()
        with self._lock:
            self._closing[run_id] = worker
        return status

    def get(self, run_id: str) -> Optional[RunWorker]:
        with self._lock:
            return self._workers.get(run_id)

    def require(self, run_id: str) -> RunWorker:
        """get() or RunnerError("run_not_open")."""
        worker = self.get(run_id)
        if worker is None:
            raise RunnerError("run_not_open")
        return worker

    def shutdown(self) -> None:
        """Stop every worker and wait for all of them (including closed ones still
        finishing a turn) so the process exits with every run committed and unlocked."""
        with self._lock:
            workers = list(self._workers.values())
            closing = list(self._closing.values())
            self._workers.clear()
            self._closing.clear()
        for worker in workers:
            try:
                worker.stop()
            except Exception:  # noqa: BLE001
                log.exception("could not stop worker %s", worker.run_id)
        for worker in closing:
            worker.join()

    # -- listing and history (thin storage wrappers, live overlay) ------------------

    def models_info(self) -> list[Any]:
        return self.registry.list_info()

    def list_runs(self, archived: str = "0") -> list[RunSummary]:
        """storage.list_runs() filtered by ``archived`` ("0" active only, the default; "1"
        archived only; "all") with live status overlaid for open runs."""
        summaries = storage.list_runs()
        if archived == "0":
            summaries = [s for s in summaries if not s.archived]
        elif archived == "1":
            summaries = [s for s in summaries if s.archived]
        with self._lock:
            workers = dict(self._workers)
        out: list[RunSummary] = []
        for summary in summaries:
            worker = workers.get(summary.run_id)
            if worker is not None:
                out.append(summary_from_manifest(worker.manifest, worker.status().state))
            else:
                out.append(summary)
        return out

    def archive_run(self, run_id: str) -> RunSummary:
        """Write the run's archive marker (idempotent) and return its summary.  An open run
        stays open; archiving only hides it from the default list."""
        storage.archive_run(run_id)
        return self.get_summary(run_id)

    def unarchive_run(self, run_id: str) -> RunSummary:
        """Remove the run's archive marker (idempotent) and return its summary."""
        storage.unarchive_run(run_id)
        return self.get_summary(run_id)

    def delete_run(self, run_id: str) -> list[str]:
        """Remove a closed run's folder for good (``storage.delete_run``).  ``RunInUseError``
        when this process has the run open, or a worker anywhere still holds its writer lock (a
        closed worker finishing its last turn, another backend process).  Holds the open lock
        so no concurrent ``open_run`` of this process can start in between."""
        with self._open_lock:
            if self.get(run_id) is not None:
                raise storage.RunInUseError(f"run {run_id} is open in this backend; leave it (Back to sessions) before deleting")
            with self._lock:
                closing = self._closing.get(run_id)
            if closing is not None and not closing.join(DELETE_CLOSING_WAIT_SECONDS):
                raise storage.RunInUseError(f"run {run_id} is still finishing its last turn; try again when it has stopped")
            removed = storage.delete_run(run_id)
            with self._lock:
                self._closing.pop(run_id, None)
        return removed

    def get_summary(self, run_id: str) -> RunSummary:
        worker = self.get(run_id)
        if worker is not None:
            return summary_from_manifest(worker.manifest, worker.status().state)
        return summary_from_manifest(storage.read_manifest(run_id))

    def run_assumptions(self, run_id: str) -> list[Any]:
        return storage.read_assumptions(run_id)

    def list_turns(self, run_id: str, from_round: Optional[int] = None, to_round: Optional[int] = None) -> list[Any]:
        return storage.list_turns(run_id, from_round, to_round)

    def turn_view(self, run_id: str, turn_id: str) -> TurnView:
        """``live`` -> the open runner's committed checkpoint; otherwise the disk checkpoint."""
        if turn_id == "live":
            return self.require(run_id).live_view()
        checkpoint, summaries, packet_ids = storage.load_checkpoint_light(run_id, turn_id)
        worker = self.get(run_id)
        parent = worker.manifest.parent if worker is not None else storage.read_manifest(run_id).parent
        return turn_view(checkpoint, summaries, packet_ids, parent, live=False)

    def turn_events(self, run_id: str, turn_id: str) -> list[Event]:
        if turn_id == "live":
            return self.require(run_id).live_view().events
        return storage.read_turn_events(run_id, turn_id)

    def turn_knowledge(self, run_id: str, turn_id: str, agent_id: str) -> AgentKnowledgeView:
        if turn_id == "live":
            return self.require(run_id).knowledge(agent_id)
        store = storage.read_knowledge(run_id, turn_id, agent_id)
        return AgentKnowledgeView(
            turn_id=turn_id,
            knowledge=store,
            unread_count=len(context.unread_records(store)),
            believed_self=context.believed_self(store),
            observed_entities=context.observed_entities(store),
        )

    def model_call(self, run_id: str, turn_id: str, call_id: str) -> ModelCallRecord:
        if turn_id == "live":
            return self.require(run_id).model_call(call_id)
        return storage.read_model_call(run_id, turn_id, call_id)

    def decision_packet(self, run_id: str, turn_id: str, packet_id: str) -> DecisionPacketRecord:
        if turn_id == "live":
            return self.require(run_id).decision_packet(packet_id)
        return storage.read_decision_packet(run_id, turn_id, packet_id)

    def create_continuation(self, run_id: str, request: ContinuationRequest) -> RunSummary:
        """storage.create_continuation then open the new run paused."""
        manifest = storage.create_continuation(run_id, request.from_turn_id, request.name)
        worker = self.open_run(manifest.run_id)
        return summary_from_manifest(worker.manifest, worker.status().state)
