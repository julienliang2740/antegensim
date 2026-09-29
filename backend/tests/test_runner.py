"""
Unit tests for empyrean.runner: the status machine and the turn procedure.

The other modules (world, skills, context, model, storage) are replaced by small
in-test fakes monkeypatched onto the runner module's attributes, so these tests
verify ORCHESTRATION only: which module is called when, what is charged, what is
committed, and how the state machine moves.  Rule arithmetic, packet building and
file layout are covered by the owning teams' tests and the QA end-to-end suite.
"""

from __future__ import annotations

import copy
import re
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Iterator, Optional

import pytest
from pydantic import TypeAdapter, ValidationError

from empyrean import model as real_model
from empyrean import runner
from empyrean import skills as real_skills
from empyrean import storage as real_storage
from empyrean import world as real_world
from empyrean.schemas import (
    ActionOutcome,
    ActionResult,
    Agent,
    AgentCard,
    AgentKnowledge,
    AgentStats,
    BelievedSelf,
    Checkpoint,
    ContextSettings,
    Decision,
    DecisionPacketRecord,
    EventCosts,
    EventDraft,
    FieldChange,
    KnowledgeRecord,
    Manifest,
    MapState,
    ModelCallRecord,
    ModelCapabilities,
    ModelInfo,
    ModelMessage,
    ModelRef,
    ModelRequest,
    ModelResult,
    ModelUsage,
    Notice,
    Point,
    Provenance,
    Region,
    RoundEndOutcome,
    RulesConfig,
    RunCreateRequest,
    RunPresentation,
    RunSummary,
    SchedulerState,
    Situation,
    SkillDefinition,
    SkillExecutionState,
    SkillFrame,
    SkillStepOutcome,
    StagedEdits,
    TurnId,
    TurnRecord,
    WorkingState,
    WorldAction,
    WorldState,
)

WORLD_ACTION = TypeAdapter(WorldAction)
OBSERVE = {"thought": "look around", "action": {"name": "observe", "args": {"point": {"x": 0, "y": 0}, "page": 0}}}
MOVE_UP = {"name": "move", "args": {"direction": "up"}}
PRICES = {"move": 5.0, "observe": 1.0, "query": 1.0, "wait": 0.0, "attack": 0.0}


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeWorld:
    InterventionError = real_world.InterventionError
    WorldError = real_world.WorldError

    def __init__(self) -> None:
        self.actions: list[Any] = []
        self.round_ends = 0

    def compute_initiative(self, w: WorldState) -> list[str]:
        ids = sorted(a.id for a in w.agents.values() if a.alive)
        ids.sort(key=lambda i: -w.agents[i].stats.speed)
        return ids

    def living_agents(self, w: WorldState) -> list[Agent]:
        return [a for a in w.agents.values() if a.alive]

    def entities_at(self, w: WorldState, point: Point, living_only: bool = True) -> list[Any]:
        return [a for a in w.agents.values() if a.position == point and (a.alive or not living_only)]

    def find_entity(self, w: WorldState, entity_id: str) -> Any:
        return w.agents.get(entity_id)

    def apply_action(self, w: WorldState, request: Any) -> ActionOutcome:
        self.actions.append(request)
        agent = w.agents[request.agent_id]
        name = request.action.name
        args = request.action.args.model_dump(mode="json")
        if not agent.alive:
            result = ActionResult(ok=False, reason="dead", round=w.round)
            return ActionOutcome(result=result)
        cost = PRICES.get(name, 1.0) * (0.8 if request.via_skill else 1.0)
        if agent.stats.compute < cost:
            result = ActionResult(ok=False, reason="insufficient_compute", round=w.round)
            agent.last_action = {"name": name, "args": args}
            agent.last_result = result
            return ActionOutcome(result=result, events=[EventDraft(actor=agent.id, kind="action", summary=f"{name} -> insufficient_compute")])
        agent.stats.compute -= cost
        agent.total_compute_spent += cost
        effects: dict[str, Any] = {}
        events: list[EventDraft] = []
        notices: list[Notice] = []
        deaths: list[str] = []
        if name == "move":
            before = agent.position
            agent.position = before.moved(args["direction"])
            effects = {"from": before.model_dump(), "to": agent.position.model_dump()}
        if name == "wait":
            agent.wait_turns_remaining = args["rounds"] - 1
            effects = {"waiting_turns": args["rounds"]}
        if name == "attack":
            target = w.agents[args["target"]]
            target.stats.health -= args["compute_budget"]
            if target.stats.health <= 0:
                target.stats.health = 0
                target.alive = False
                deaths.append(target.id)
                events.append(EventDraft(actor="world", kind="death", summary=f"{target.id} died", details={"entity_id": target.id, "kind": "agent", "cause": "attack", "residue_id": None}))
            notices.append(Notice(agent_id=target.id, kind="damage", provenance=Provenance(source="agent:" + agent.id), text="you were hit", content={"amount": args["compute_budget"], "attacker": agent.id, "health_after": target.stats.health, "cause": "attack"}))
            effects = {"damage": args["compute_budget"], "target": target.id, "target_health_after": target.stats.health, "killed": not target.alive}
        result = ActionResult(ok=True, reason="ok", cost_compute=cost, round=w.round, effects=effects)
        agent.last_action = {"name": name, "args": args}
        agent.last_result = result
        events.insert(0, EventDraft(actor=agent.id, kind="action", summary=f"{name} -> ok", details={"action": {"name": name, "args": args}, "result": result.model_dump(mode="json"), "via_skill": request.via_skill, "skill_name": request.skill_name}, costs=EventCosts(compute=cost)))
        return ActionOutcome(result=result, events=events, notices=notices, deaths=deaths)

    def end_round(self, w: WorldState) -> RoundEndOutcome:
        self.round_ends += 1
        events = []
        for agent in self.living_agents(w):
            paid = min(agent.stats.compute, 1.0)
            agent.stats.compute -= paid
            events.append(EventDraft(actor="world", kind="upkeep", summary=f"{agent.id} paid upkeep", details={"agent_id": agent.id, "paid": paid, "owed": 1.0 - paid}))
        return RoundEndOutcome(events=events)

    def apply_world_intervention(self, w: WorldState, iv: Any) -> list[FieldChange]:
        if iv.type == "set_stat":
            entity = w.agents.get(iv.entity_id)
            if entity is None:
                raise self.InterventionError(f"unknown entity {iv.entity_id}")
            head, _, leaf = iv.field.rpartition(".")
            target = entity.stats if head == "stats" else entity
            before = getattr(target, leaf)
            setattr(target, leaf, iv.value)
            return [FieldChange(path=f"world.agents.{iv.entity_id}.{iv.field}", before=before, after=iv.value)]
        if iv.type == "remove_entity":
            if iv.entity_id not in w.agents:
                raise self.InterventionError(f"unknown entity {iv.entity_id}")
            removed = w.agents.pop(iv.entity_id)
            return [FieldChange(path=f"world.agents.{iv.entity_id}", before=removed.model_dump(mode="json"), after=None)]
        if iv.type == "place_entity":
            entity = iv.entity
            new_id = entity.id or f"a{len(w.agents) + 1:02d}"
            w.agents[new_id] = Agent(id=new_id, name=entity.name, position=entity.position, created_round=w.round)
            return [FieldChange(path=f"world.agents.{new_id}", before=None, after="placed")]
        if iv.type == "update_prices":
            before = w.rules.prices.model_dump()
            w.rules.prices = iv.prices
            return [FieldChange(path="world.rules.prices", before=before, after=iv.prices.model_dump())]
        raise self.WorldError(f"not a world intervention: {iv.type}")

    def replace_world(self, w: WorldState, new_world: WorldState) -> list[str]:
        for name in ("round", "map", "agents", "rules"):
            setattr(w, name, getattr(new_world, name))
        return []

    def validate_world(self, w: WorldState) -> list[str]:
        return []

    def generate_world(self, config: Any, rules: RulesConfig, seed: int, cards: list[AgentCard]) -> WorldState:
        w = WorldState(map=MapState(region=Region(), cells={}), rules=rules)
        for card in cards:
            w.agents[card.id] = Agent(id=card.id, name=card.name, position=card.position, stats=card.stats.model_copy(), persona=card.persona)
        return w

    def world_warnings(self, w: WorldState) -> list[str]:
        return []

    def generate_terrain(self, config: Any, rng: Any) -> MapState:
        return MapState(region=config.region, cells={"0,0": "land"})


class FakeSkills:
    SkillValidationError = real_skills.SkillValidationError
    SkillSyntaxError = real_skills.SkillSyntaxError

    def __init__(self) -> None:
        self.steps: dict[str, list[Any]] = {}  # root skill -> queued step outcomes
        self.seen_ops: list[int] = []  # state.ops_this_turn at each run_until_action call

    def validate_and_build(self, request: Any, existing: dict, count_limit: int, block_limit: int, rules: Any, round_no: int) -> SkillDefinition:
        if request.source == "BAD":
            raise self.SkillValidationError("line 1: bad skill")
        return SkillDefinition(name=request.name, params=request.params, source=request.source, blocks=[], compiled=[], block_count=2, saved_round=round_no)

    def check_delete(self, name: str, existing: dict) -> Optional[str]:
        return None if name in existing else "unknown skill"

    def start_execution(self, name: str, arguments: list, skills: dict, round_no: int) -> SkillExecutionState:
        if name not in skills:
            raise self.SkillValidationError(f"unknown skill {name}")
        return SkillExecutionState(root_skill=name, arguments=arguments, frames=[SkillFrame(skill=name)], started_round=round_no)

    def frames_use(self, state: SkillExecutionState) -> set[str]:
        return {f.skill for f in state.frames}

    def stop_execution(self, state: SkillExecutionState, reason: str) -> SkillExecutionState:
        state.status = "stopped"
        state.last_error = reason
        state.pending_action = None
        return state

    def run_until_action(self, state: SkillExecutionState, skills: dict, rules: Any, env: Any, compute_available: float) -> SkillStepOutcome:
        self.seen_ops.append(state.ops_this_turn)
        queue = self.steps.setdefault(state.root_skill, [])
        step = queue.pop(0) if queue else "finish"
        if isinstance(step, dict):
            action = WORLD_ACTION.validate_python(step)
            state.status = "awaiting_action_result"
            state.pending_action = action
            return SkillStepOutcome(state=state, action=action, ops_used=1, cost_compute=0.01)
        if step == "yield":
            state.last_error = "op_budget_exhausted"
            return SkillStepOutcome(state=state, ops_used=100, cost_compute=1.0)
        if step == "error":
            state.status = "error"
            state.last_error = "line 2: division by zero"
            return SkillStepOutcome(state=state, ops_used=3, cost_compute=0.03, error=state.last_error)
        state.status = "finished"
        return SkillStepOutcome(state=state, ops_used=1, cost_compute=0.01)

    def deliver_result(self, state: SkillExecutionState, result: ActionResult) -> SkillExecutionState:
        state.status = "running"
        state.pending_action = None
        state.actions_executed += 1
        return state


class FakeContext:
    def __init__(self) -> None:
        self.min_compute = 0.5  # packets are affordable at or above this balance
        self.reservation = 2.0

    def new_knowledge(self, agent_id: str, notebook: str = "") -> AgentKnowledge:
        return AgentKnowledge(agent_id=agent_id, notebook=notebook)

    def _add(self, k: AgentKnowledge, kind: str, text: str, content: Optional[dict] = None, read: bool = False, source: str = "world") -> KnowledgeRecord:
        record = KnowledgeRecord(id=f"{k.agent_id}-k{k.next_seq:06d}", agent_id=k.agent_id, round=0, seq=k.next_seq, kind=kind, provenance=Provenance(source=source), text=text, content=content or {}, read=read)
        k.next_seq += 1
        k.records.append(record)
        return record

    def record_run_start(self, k: AgentKnowledge, agent: Agent, round_no: int, turn_id: str) -> KnowledgeRecord:
        return self._add(k, "system", "you were born", {"self": agent.stats.model_dump()})

    def record_notice(self, k: AgentKnowledge, notice: Notice, round_no: int, turn_id: str) -> KnowledgeRecord:
        return self._add(k, notice.kind, notice.text, notice.content, source=notice.provenance.source)

    def record_action_result(self, k: AgentKnowledge, action: dict, result: ActionResult, round_no: int, turn_id: str, via_skill: bool, thought: Optional[str] = None, interpreter_cost: float = 0.0) -> KnowledgeRecord:
        content = {"action": action, "result": result.model_dump(), "via_skill": via_skill, "thought": thought}
        if interpreter_cost > 0:  # disclosed like the real context (INTERFACES section 4.3)
            content["interpreter_charged"] = interpreter_cost
        return self._add(k, "action_result", f"{action['name']} -> {result.reason}", content, read=True, source="own_action")

    def record_system(self, k: AgentKnowledge, text: str, round_no: int, turn_id: str, content: Optional[dict] = None, importance: float = 0.5) -> KnowledgeRecord:
        return self._add(k, "system", text, content)

    def unread_records(self, k: AgentKnowledge) -> list[KnowledgeRecord]:
        return [r for r in k.records if not r.read]

    def mark_read(self, k: AgentKnowledge, ids: list[str]) -> None:
        for r in k.records:
            if r.id in ids:
                r.read = True

    def believed_self(self, k: AgentKnowledge) -> BelievedSelf:
        return BelievedSelf()

    def observed_entities(self, k: AgentKnowledge) -> list:
        return []

    def cognition_cost(self, rates: Any, mind: float, input_tokens: int, output_tokens: int) -> float:
        return mind * (rates.input_rate * input_tokens + rates.generation_rate * output_tokens)

    def validate_settings(self, settings: ContextSettings, capabilities: ModelCapabilities, mind: float = 1.0) -> list[str]:
        if settings.input_token_cap + settings.generation_allowance > capabilities.context_window:
            return ["input_token_cap + generation_allowance exceeds the context window"]
        return []

    def build_situation(self, agent: Agent, k: AgentKnowledge, rules: Any, settings: Any, round_no: int, turn_id: str) -> Situation:
        return Situation(agent_id=agent.id, name=agent.name, round=round_no, turn_id=turn_id, position=agent.position)

    def build_packet(self, agent, k, situation, rules, settings, capabilities, mind, compute_available, overhead_tokens, turn_id, packet_id, round_no) -> DecisionPacketRecord:  # type: ignore[no-untyped-def]
        affordable = compute_available >= self.min_compute
        return DecisionPacketRecord(
            packet_id=packet_id, turn_id=turn_id, round=round_no, agent_id=agent.id, effective_settings=settings, sections=[],
            messages=[ModelMessage(role="system", content="rules"), ModelMessage(role="user", content="body")], situation=situation,
            digest_record_ids=[r.id for r in k.records if not r.read], input_token_estimate=100, overhead_tokens=overhead_tokens,
            generation_allowance=settings.generation_allowance, reservation_compute=self.reservation, affordable=affordable,
            unaffordable_reason=None if affordable else "below the minimum packet",
        )

    def apply_notebook_update(self, k: AgentKnowledge, update: Optional[str], max_tokens: int) -> bool:
        if update is None:
            return False
        k.notebook = update[: max_tokens * 4]
        k.notebook_version += 1
        k.notebook_truncated = len(update) > max_tokens * 4
        return True

    def apply_memory_priorities(self, k: AgentKnowledge, priorities: list) -> list[str]:
        return []

    def apply_knowledge_intervention(self, knowledge: dict, iv: Any, round_no: int, turn_id: str) -> list[FieldChange]:
        if iv.agent_id not in knowledge:
            raise ValueError(f"unknown agent {iv.agent_id}")
        if iv.operation == "replace_notebook":
            before = knowledge[iv.agent_id].notebook
            knowledge[iv.agent_id].notebook = iv.notebook or ""
            return [FieldChange(path=f"knowledge.{iv.agent_id}.notebook", before=before, after=iv.notebook)]
        return []

    def deliver_voice(self, knowledge: dict, ids: list[str], text: str, round_no: int, turn_id: str) -> list[KnowledgeRecord]:
        return [self._add(knowledge[i], "operator_voice", text, {"text": text}, source="unknown") for i in ids if i in knowledge]


class FakeRegistry:
    def __init__(self, keys: tuple[str, ...] = ("fake-heuristic", "fake-scripted")) -> None:
        caps = ModelCapabilities(context_window=100000, max_output_tokens=4000, reports_usage=False)
        self.refs = {k: ModelRef(key=k, provider="fake", model_id=k, capabilities=caps) for k in keys}

    def get(self, key: str) -> ModelRef:
        if key not in self.refs:
            raise real_model.UnknownModelError(key)
        return self.refs[key]

    def keys(self) -> list[str]:
        return list(self.refs)

    def validate_key(self, key: str) -> Optional[str]:
        return None if key in self.refs else f"unknown model {key!r}"

    def validate_agent_key(self, key: str) -> Optional[str]:  # rev 4 (no assistant-only refs here)
        return self.validate_key(key)

    def list_info(self) -> list[ModelInfo]:
        return [ModelInfo(key=r.key, provider=r.provider, model_id=r.model_id, available=True, capabilities=r.capabilities) for r in self.refs.values()]

    def credential_env_names(self) -> set[str]:
        return set()


class FakeModel:
    UnknownModelError = real_model.UnknownModelError

    def __init__(self) -> None:
        self.script: list[dict[str, Any]] = []  # per-call result specs, consumed in order
        self.by_agent: dict[str, list[dict[str, Any]]] = {}  # per-agent specs, used before ``script``
        self.calls: list[ModelRequest] = []
        self.block: Optional[threading.Event] = None  # when set, call_model waits on it
        self.in_call = threading.Event()

    def request_overhead_tokens(self, key: str, registry: Any) -> int:
        return 0

    def redact(self, text: Optional[str], registry: Any = None) -> Optional[str]:
        return text

    def call_model(self, request: ModelRequest, registry: Any, cancel: Optional[threading.Event] = None) -> ModelResult:
        self.calls.append(request)
        self.in_call.set()
        if self.block is not None:
            self.block.wait(5)
        mine = self.by_agent.get(str(request.metadata.get("agent_id")))
        if mine:
            spec = mine.pop(0)
        else:
            spec = self.script.pop(0) if self.script else {"status": "ok", "parsed": OBSERVE}
        status = spec.get("status", "ok")
        parsed = spec.get("parsed")
        return ModelResult(
            request_id=request.request_id, ok=status == "ok" and isinstance(parsed, dict), status=status,
            text=spec.get("text", json.dumps(parsed) if parsed else None), parsed=parsed,
            usage=ModelUsage(input_tokens=1000, output_tokens=100, source="estimate"), provider="fake",
            model_id=request.model_key, latency_ms=1.0, attempts=1, error=spec.get("error"),
            provider_cost_usd=spec.get("cost"),
        )

    def parse_decision(self, result: ModelResult) -> tuple[Optional[Decision], Optional[str]]:
        if result.status != "ok":
            return None, f"status={result.status}"
        if result.parsed is None:
            return None, "not a JSON object"
        try:
            return Decision.model_validate(result.parsed), None
        except ValidationError as exc:
            first = exc.errors()[0]
            return None, f"{'.'.join(str(p) for p in first['loc'])}: {first['msg']}"[:200]


class FakeWriterLock:
    """Mirror of storage.WriterLock: one holder per run id inside this fake store."""

    def __init__(self, store: "FakeStorage", run_id: str) -> None:
        self.store = store
        self.run_id = run_id
        self.held = True

    def release(self) -> None:
        if self.held:
            self.held = False
            self.store.locks.pop(self.run_id, None)


class FakeStorage:
    """In-memory run store mirroring the storage contract the runner relies on."""

    StorageError = real_storage.StorageError
    WriterLock = FakeWriterLock

    def __init__(self) -> None:
        self.runs: dict[str, dict[str, Any]] = {}
        self.locks: dict[str, FakeWriterLock] = {}  # run id -> the lock currently held

    def acquire_writer_lock(self, run_id: str) -> Optional[FakeWriterLock]:
        self._run(run_id)
        if run_id in self.locks:
            return None
        lock = FakeWriterLock(self, run_id)
        self.locks[run_id] = lock
        return lock

    def _run(self, run_id: str) -> dict[str, Any]:
        if run_id not in self.runs:
            raise self.StorageError(f"unknown run {run_id}")
        return self.runs[run_id]

    def run_dir_path(self, world_id: str, run_id: str) -> Optional[str]:
        return f"/fake/worlds/{world_id}/runs/{run_id}"

    def archive_state(self, world_id: str, run_id: str) -> tuple[bool, Optional[str]]:
        return False, None  # no archive markers in the in-memory storage

    def read_run_presentation(self, world_id: str, run_id: str) -> RunPresentation:
        return RunPresentation()  # no display metadata in the in-memory storage

    def code_revision(self) -> str:
        return "test"

    def new_run_id(self, name: str) -> str:
        return f"run_test_{len(self.runs) + 1:04d}"

    def new_world_id(self) -> str:
        return "world_test"

    def create_run(self, request: Any, manifest: Manifest, checkpoint: Checkpoint, assumptions: list) -> Manifest:
        self.runs[manifest.run_id] = {"manifest": manifest, "checkpoints": {checkpoint.turn.turn_id: checkpoint}, "order": [checkpoint.turn.turn_id], "pending": {}, "pending_writes": [], "staged": StagedEdits(), "snapshots": {}, "assumptions": assumptions, "working": None, "working_errors": [], "diff": []}
        return manifest

    def write_checkpoint(self, manifest: Manifest, checkpoint: Checkpoint) -> Manifest:
        r = self._run(manifest.run_id)
        tid = checkpoint.turn.turn_id
        r["checkpoints"][tid] = checkpoint
        if tid in r["order"]:
            r["order"] = r["order"][: r["order"].index(tid)]
        r["order"].append(tid)
        manifest.current_turn_id = tid
        manifest.last_round = checkpoint.turn.round
        manifest.last_turn_index = checkpoint.turn.turn_index
        if checkpoint.events:
            manifest.next_event_seq = max(e.seq for e in checkpoint.events) + 1
        manifest.turn_count += 1
        manifest.living_agent_count = sum(1 for a in checkpoint.world.agents.values() if a.alive)
        manifest.updated_at = "2026-09-25T00:00:00+00:00"
        for record in checkpoint.model_calls:
            r["pending"].pop(record.call_id, None)
        r["manifest"] = manifest
        return manifest

    def write_manifest(self, manifest: Manifest) -> None:
        self._run(manifest.run_id)["manifest"] = manifest

    def read_manifest(self, run_id: str) -> Manifest:
        return self._run(run_id)["manifest"].model_copy(deep=True)

    def write_pending_model_call(self, run_id: str, record: ModelCallRecord) -> None:
        r = self._run(run_id)
        r["pending"][record.call_id] = record.model_copy(deep=True)
        r["pending_writes"].append((record.call_id, record.status))

    def list_pending_model_calls(self, run_id: str) -> list[ModelCallRecord]:
        return list(self._run(run_id)["pending"].values())

    def clear_pending_model_calls(self, run_id: str, call_ids: list[str]) -> None:
        for cid in call_ids:
            self._run(run_id)["pending"].pop(cid, None)

    def recover_run(self, run_id: str) -> real_storage.RecoveryReport:
        report = real_storage.RecoveryReport()
        for record in self._run(run_id)["pending"].values():
            failed = record.model_copy(deep=True)
            failed.status = "failed"
            failed.error = "interrupted (outcome uncertain)"
            report.pending_calls.append(failed)
        return report

    def load_checkpoint(self, run_id: str, turn_id: Optional[str] = None) -> Checkpoint:
        r = self._run(run_id)
        tid = turn_id or r["manifest"].current_turn_id
        if tid not in r["checkpoints"]:
            raise self.StorageError(f"unknown turn {tid}")
        return copy.deepcopy(r["checkpoints"][tid])

    def load_checkpoint_light(self, run_id: str, turn_id: str) -> tuple[Checkpoint, list, list[str]]:
        cp = self.load_checkpoint(run_id, turn_id)
        return cp, [runner.model_call_summary(m) for m in cp.model_calls], [p.packet_id for p in cp.decision_packets]

    def list_runs(self) -> list[RunSummary]:
        return [runner.summary_from_manifest(r["manifest"]) for r in self.runs.values()]

    def read_events(self, run_id: str, since_seq: int = 0, limit: int = 500) -> list[Any]:
        r = self._run(run_id)
        events = [e for tid in r["order"] for e in r["checkpoints"][tid].events if e.seq > since_seq]
        return events[:limit]

    def read_staged_edits(self, run_id: str) -> StagedEdits:
        return self._run(run_id)["staged"]

    def write_staged_edits(self, run_id: str, staged: StagedEdits) -> None:
        self._run(run_id)["staged"] = staged

    def write_staged_snapshot(self, run_id: str, iv_id: str, working: WorkingState) -> str:
        ref = f"staged_snapshots/{iv_id}.json"
        self._run(run_id)["snapshots"][ref] = copy.deepcopy(working)  # a file round-trip never aliases
        return ref

    def read_staged_snapshot(self, run_id: str, ref: str) -> WorkingState:
        try:
            return copy.deepcopy(self._run(run_id)["snapshots"][ref])
        except KeyError as exc:
            raise self.StorageError(f"no snapshot {ref}") from exc

    def delete_staged_snapshot(self, run_id: str, ref: str) -> None:
        self._run(run_id)["snapshots"].pop(ref, None)

    def load_working(self, run_id: str) -> tuple[Optional[WorkingState], list[str]]:
        r = self._run(run_id)
        return r["working"], list(r["working_errors"])

    def diff_working(self, current: Checkpoint, working: WorkingState) -> list[FieldChange]:
        changes = []
        for aid, agent in working.world.agents.items():
            before = current.world.agents.get(aid)
            if before is None or before.stats.compute != agent.stats.compute:
                changes.append(FieldChange(path=f"world.agents.{aid}.stats.compute", before=before.stats.compute if before else None, after=agent.stats.compute))
        return changes

    def apply_working_changes(self, world: WorldState, knowledge: dict, settings: Any, changes: list[FieldChange]):
        """The fake diff only ever emits ``world.agents.<id>.stats.compute`` paths; apply
        those onto copies, with the value found at apply time as ``before``."""
        state = WorkingState(world=copy.deepcopy(world), knowledge=copy.deepcopy(knowledge), settings=settings.model_copy(deep=True))
        applied, problems = [], []
        for change in changes:
            match = re.fullmatch(r"world\.agents\.([A-Za-z0-9]+)\.stats\.compute", change.path)
            agent = state.world.agents.get(match.group(1)) if match else None
            if agent is None:
                problems.append(f"{change.path}: does not exist any more")
                continue
            applied.append(FieldChange(path=change.path, before=agent.stats.compute, after=change.after))
            agent.stats.compute = change.after
        return (None if problems else state), applied, problems

    def read_assumptions(self, run_id: str) -> list:
        return self._run(run_id)["assumptions"]

    def model_call_ids_in_round(self, run_id: str, round_no: int) -> set[str]:
        ids: set[str] = set()
        for cp in self.runs[run_id]["checkpoints"].values():
            if cp.turn.round == round_no:
                ids.update(r.call_id for r in cp.model_calls)
        return ids

    def list_turns(self, run_id: str, from_round: Optional[int] = None, to_round: Optional[int] = None) -> list:
        return list(self._run(run_id)["order"])

    def create_continuation(self, run_id: str, from_turn_id: str, name: Optional[str]) -> Manifest:
        parent = self._run(run_id)
        cp = copy.deepcopy(parent["checkpoints"][from_turn_id])
        manifest = parent["manifest"].model_copy(deep=True)
        manifest.run_id = f"{run_id}_cont"
        manifest.name = name or f"{manifest.name} from {from_turn_id}"
        manifest.current_turn_id = from_turn_id
        manifest.next_event_seq = cp.turn.event_seq_end + 1
        manifest.finished = False
        self.runs[manifest.run_id] = {"manifest": manifest, "checkpoints": {from_turn_id: cp}, "order": [from_turn_id], "pending": {}, "pending_writes": [], "staged": StagedEdits(), "snapshots": {}, "assumptions": [], "working": None, "working_errors": [], "diff": []}
        return manifest


class Fakes:
    def __init__(self) -> None:
        self.world = FakeWorld()
        self.skills = FakeSkills()
        self.context = FakeContext()
        self.model = FakeModel()
        self.storage = FakeStorage()
        self.registry = FakeRegistry()


@pytest.fixture()
def fakes(monkeypatch: pytest.MonkeyPatch) -> Iterator[Fakes]:
    f = Fakes()
    monkeypatch.setattr(runner, "world", f.world)
    monkeypatch.setattr(runner, "skills", f.skills)
    monkeypatch.setattr(runner, "context", f.context)
    monkeypatch.setattr(runner, "model", f.model)
    monkeypatch.setattr(runner, "storage", f.storage)
    # Round decisions (A-SCHED-5) run on one worker here, so the scripted replies are consumed
    # in the round's order; test_round_decisions.py covers the concurrent pool.
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="test-decide")
    monkeypatch.setattr(runner, "decision_pool", lambda: pool)
    yield f
    pool.shutdown(wait=True)


@pytest.fixture()
def manager(fakes: Fakes):
    m = runner.RunManager(fakes.registry)
    yield m
    m.shutdown()


def make_request(n: int = 6, **overrides: Any) -> RunCreateRequest:
    cards = [AgentCard(id=f"a{i:02d}", name=f"Agent{i}", position=Point(x=0, y=0), stats=AgentStats(compute=200, speed=1)) for i in range(1, n + 1)]
    fields: dict[str, Any] = {"name": "test run", "agents": cards, "play_delay_seconds": 0.0}
    fields.update(overrides)
    return RunCreateRequest(**fields)


def create_worker(manager: runner.RunManager, n: int = 6, **overrides: Any) -> runner.RunWorker:
    summary = manager.create_run(make_request(n, **overrides))
    return manager.require(summary.run_id)


def wait_idle(worker: runner.RunWorker, timeout: float = 5.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = worker.status().state
        if state in ("paused", "error", "finished"):
            return state
        time.sleep(0.005)
    raise AssertionError(f"worker did not settle; state={worker.status().state}")


def wait_state(worker: runner.RunWorker, wanted: str, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if worker.status().state == wanted:
            return
        time.sleep(0.005)
    raise AssertionError(f"state {wanted!r} not reached; state={worker.status().state}")


def run_turn(worker: runner.RunWorker) -> Checkpoint:
    worker.submit("run_turn")
    wait_idle(worker)
    return worker.checkpoint


def wait_calls(fakes: Fakes, count: int, timeout: float = 5.0) -> None:
    """Round decisions run on the pool: wait until ``count`` calls were made, then check it is exact."""
    deadline = time.time() + timeout
    while len(fakes.model.calls) < count and time.time() < deadline:
        time.sleep(0.005)
    time.sleep(0.02)
    assert len(fakes.model.calls) == count


def kinds(cp: Checkpoint) -> list[str]:
    return [e.kind for e in cp.events]


# ---------------------------------------------------------------------------
# Creation and status
# ---------------------------------------------------------------------------


def test_create_run_opens_paused_with_init_checkpoint(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    status = worker.status()
    assert status.state == "paused"
    assert status.current_turn_id == TurnId.INIT
    assert status.next_step == "new_round"
    assert status.living_agent_count == 6
    assert worker.checkpoint.events[0].kind == "run_created"
    assert worker.checkpoint.world.rules.cognition.mind_multipliers == {"fake-heuristic": 1.0}
    assert all(store.records[0].kind == "system" for store in worker.checkpoint.knowledge.values())
    assert manager.list_runs()[0].status == "paused"


def test_validate_setup_reports_every_problem_with_paths(manager: runner.RunManager) -> None:
    request = make_request(6)
    cards = list(request.agents)
    cards[1] = cards[1].model_copy(update={"id": "a01"})  # duplicate id
    cards[2] = cards[2].model_copy(update={"name": cards[0].name})  # duplicate name
    cards[3] = cards[3].model_copy(update={"position": Point(x=99, y=0)})
    cards[4] = cards[4].model_copy(update={"stats": AgentStats(health=150, max_health=100), "model_key": "nope"})
    request = request.model_copy(update={"agents": cards, "default_model_key": "fake-heuristic"})
    request.world.initial_plants = {"ghost": 1}
    problems = manager.validate_setup(request)
    paths = {p.path for p in problems}
    assert {"agents[1].id", "agents[2].name", "agents[3].position", "agents[4].stats.health", "agents[4].model_key", "world.initial_plants.ghost"} <= paths
    with pytest.raises(runner.SetupError) as info:
        manager.create_run(request)
    assert info.value.problems


# ---------------------------------------------------------------------------
# Turn procedure
# ---------------------------------------------------------------------------


def test_run_turn_commits_one_agent_turn_and_clears_pending_file(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    cp = run_turn(worker)
    assert cp.turn.turn_id == "r00001_t01_a01"
    assert cp.turn.kind == "agent_turn" and cp.turn.decision_source == "model"
    assert cp.turn.previous_turn_id == TurnId.INIT
    assert kinds(cp) == ["round_started", "turn_started", "model_call_pending", "model_call_completed", "decision", "action"]
    assert cp.turn.model_call_ids == ["mc_r00001_t01_a01_01"]
    assert cp.turn.packet_id == "pk_r00001_t01_a01"
    assert cp.turn.action == {"name": "observe", "args": {"point": {"x": 0, "y": 0}, "page": 0}, "via_skill": False, "skill_name": None}
    assert cp.turn.action_result is not None and cp.turn.action_result.ok
    agent = cp.world.agents["a01"]
    # cognition 0.0002*1000 + 0.001*100 = 0.3, observe 1.0 (the fixture pins the old prices)
    assert agent.stats.compute == pytest.approx(200 - 0.3 - 1.0)
    assert agent.total_cognition_spent == pytest.approx(0.3)
    assert agent.model_call_count == 1
    pending_event = next(e for e in cp.events if e.kind == "model_call_pending")
    assert pending_event.pending is True
    completed = next(e for e in cp.events if e.kind == "model_call_completed")
    assert completed.costs.compute == pytest.approx(0.3) and completed.details["uncharged_compute"] == 0
    # pending file written before the call (status pending), rewritten with the result, removed at commit
    run = fakes.storage.runs[worker.run_id]
    own = [w for w in run["pending_writes"] if w[0] == "mc_r00001_t01_a01_01"]
    assert own[:2] == [("mc_r00001_t01_a01_01", "pending"), ("mc_r00001_t01_a01_01", "completed")]
    # A-SCHED-5: every agent decided at round start; the other five calls wait for their turns
    assert sorted(run["pending"]) == [f"mc_r00001_t0{i}_a0{i}_01" for i in range(2, 7)]
    # the request carried the fake-adapter metadata
    metadata = fakes.model.calls[0].metadata
    assert metadata["agent_id"] == "a01" and metadata["fake_script_index"] == 0 and metadata["fake_options"] == {}
    # the birth record was marked read after the provider answered and the charge was disclosed
    store = cp.knowledge["a01"]
    assert store.records[0].read is True
    assert any(r.content.get("cognition_charged") == pytest.approx(0.3) for r in store.records)
    status = worker.status()
    assert status.state == "paused" and status.next_step == "agent_turn" and status.next_agent_id == "a02"
    assert status.round == 1 and status.turn_index == 1 and status.acting_agent_id == "a01"


def test_overlapping_run_commands_are_rejected_while_waiting_model(manager: runner.RunManager, fakes: Fakes) -> None:
    fakes.model.block = threading.Event()
    worker = create_worker(manager)
    worker.submit("play")
    assert fakes.model.in_call.wait(5)
    wait_state(worker, "waiting_model")
    status = worker.status()
    assert status.pending_model_call is not None and status.pending_model_call.call_id == "mc_r00001_t01_a01_01"
    assert status.active_turn_id == "r00001_t01_a01" and status.acting_agent_id == "a01" and status.play_loop
    assert worker.pending_model_call_view() is not None
    for command in ("run_turn", "play", "step_round"):
        with pytest.raises(runner.RunnerError, match="illegal_command"):
            worker.submit(command)
    worker.submit("pause")
    fakes.model.block.set()
    wait_idle(worker)


def test_pause_requested_becomes_paused_after_the_active_turn_commits(manager: runner.RunManager, fakes: Fakes) -> None:
    fakes.model.block = threading.Event()
    worker = create_worker(manager)
    worker.submit("play")
    assert fakes.model.in_call.wait(5)
    status = worker.submit("pause")
    assert status.state == "pause_requested"
    assert worker.status().current_turn_id == TurnId.INIT  # nothing committed yet
    fakes.model.block.set()
    assert wait_idle(worker) == "paused"
    assert worker.status().current_turn_id == "r00001_t01_a01"  # exactly the active turn committed
    assert worker.status().pending_model_call is None
    assert worker.submit("pause").state == "paused"  # no-op while paused


def test_staged_edit_is_applied_at_the_boundary_with_before_after(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    iv = TypeAdapter(runner.Intervention).validate_python({"type": "set_stat", "entity_id": "a03", "field": "stats.compute", "value": 50})
    staged = worker.stage_intervention(iv)
    assert staged.id == "iv_0001" and worker.status().staged_intervention_count == 1
    assert fakes.storage.runs[worker.run_id]["manifest"].next_intervention_seq == 2
    cp = run_turn(worker)
    assert worker.status().staged_intervention_count == 0
    assert len(cp.turn.interventions) == 1
    record = cp.turn.interventions[0]
    assert record.ok and record.effective_turn_id == cp.turn.turn_id and record.applied_round == 1
    assert record.changes[0].before == 200 and record.changes[0].after == 50
    event = next(e for e in cp.events if e.kind == "intervention")
    assert event.actor == "operator" and event.details["ok"] and event.details["effective_turn_id"] == cp.turn.turn_id
    assert event.details["changes"][0]["before"] == 200 and event.details["intervention"]["id"] == "iv_0001"
    assert cp.world.agents["a03"].stats.compute == 50
    assert fakes.storage.runs[worker.run_id]["staged"].interventions == []
    with pytest.raises(runner.SetupError):
        worker.stage_intervention(TypeAdapter(runner.Intervention).validate_python({"type": "set_stat", "entity_id": "zz", "field": "stats.compute", "value": 1}))


def test_god_mode_context_settings_take_effect_at_the_boundary(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    iv = TypeAdapter(runner.Intervention).validate_python({"type": "update_context_settings", "scope": "a01", "settings": {"generation_allowance": 300}})
    worker.stage_intervention(iv)
    cp = run_turn(worker)
    assert cp.settings.context_overrides["a01"].generation_allowance == 300
    assert cp.settings.effective_context("a01").generation_allowance == 300
    assert fakes.model.calls[0].max_output_tokens == 300  # the packet of the same turn used the new setting
    assert cp.turn.interventions[0].changes[0].path == "settings.context_overrides.a01"
    bad = TypeAdapter(runner.Intervention).validate_python({"type": "update_context_settings", "scope": "run", "settings": {"input_token_cap": 200000}})
    with pytest.raises(runner.SetupError) as info:
        worker.stage_intervention(bad)
    assert info.value.problems[0].path == "settings"


def test_infra_failure_enters_error_uncharged_and_rerun_uses_call_02(manager: runner.RunManager, fakes: Fakes) -> None:
    fakes.model.script = [{"status": "timeout", "error": "deadline exceeded"}]
    worker = create_worker(manager)
    iv = TypeAdapter(runner.Intervention).validate_python({"type": "set_stat", "entity_id": "a02", "field": "stats.compute", "value": 77})
    worker.stage_intervention(iv)
    worker.submit("run_turn")
    assert wait_idle(worker) == "error"
    status = worker.status()
    assert status.last_error == "provider failure: timeout"
    assert status.current_turn_id == TurnId.INIT  # nothing committed
    assert worker.checkpoint.world.agents["a01"].stats.compute == 200  # uncharged
    assert worker.checkpoint.knowledge["a01"].records[0].read is False  # nothing marked read
    run = fakes.storage.runs[worker.run_id]
    assert "mc_r00001_t01_a01_01" in run["pending"]  # the pending file survives until the turn commits
    assert worker.status().staged_intervention_count == 1  # the popped staged edit was put back
    with pytest.raises(runner.RunnerError):
        worker.submit("run_turn")
    assert worker.submit("pause").state == "paused"
    assert worker.status().last_error == "provider failure: timeout"  # persists until the next commit
    cp = run_turn(worker)
    assert cp.turn.turn_id == "r00001_t01_a01"
    assert cp.turn.model_call_ids == ["mc_r00001_t01_a01_01", "mc_r00001_t01_a01_02"]
    failed = next(m for m in cp.model_calls if m.call_id.endswith("_01"))
    assert failed.status == "failed" and failed.charged_compute == 0
    assert [e.kind for e in cp.events if e.details.get("call_id") == "mc_r00001_t01_a01_01"] == ["model_call_pending", "model_call_failed"]
    assert any(e.kind == "error" for e in cp.events)
    failed_event = next(e for e in cp.events if e.kind == "model_call_failed")
    assert failed_event.details["infra"] is True and failed_event.costs.compute == 0
    assert not [c for c in run["pending"] if c.startswith("mc_r00001_t01_a01")]
    assert worker.status().last_error is None
    assert cp.world.agents["a02"].stats.compute == 77 and cp.turn.interventions[0].ok
    assert worker.checkpoint.world.agents["a01"].stats.compute == pytest.approx(200 - 0.3 - 1.0)
    rerun = next(c for c in fakes.model.calls if c.request_id == "mc_r00001_t01_a01_02")  # the round's other calls ran on the pool
    assert rerun.request_id == "mc_r00001_t01_a01_02" and rerun.metadata["fake_script_index"] == 0  # same script index


def test_agent_output_failure_charges_and_applies_no_action(manager: runner.RunManager, fakes: Fakes) -> None:
    fakes.model.script = [{"status": "malformed", "text": "not json"}]
    worker = create_worker(manager)
    cp = run_turn(worker)
    assert cp.turn.decision_source == "model" and cp.turn.action is None and cp.turn.action_result is None
    assert fakes.world.actions == []
    agent = cp.world.agents["a01"]
    assert agent.stats.compute == pytest.approx(200 - 0.3)
    assert agent.model_call_count == 1
    assert agent.last_result is not None and agent.last_result.reason == "invalid_action"
    assert kinds(cp) == ["round_started", "turn_started", "model_call_pending", "model_call_failed", "cognition_charged", "decision_invalid"]
    failed = next(e for e in cp.events if e.kind == "model_call_failed")
    assert failed.details["infra"] is False and failed.costs.compute == pytest.approx(0.3)
    assert cp.model_calls[0].status == "failed" and cp.model_calls[0].charged_compute == pytest.approx(0.3)
    assert any("not a valid decision" in r.text for r in cp.knowledge["a01"].records)
    assert worker.status().state == "paused"


def test_invalid_decision_shape_fails_the_format_gate(manager: runner.RunManager, fakes: Fakes) -> None:
    fakes.model.script = [{"status": "ok", "parsed": {"action": {"name": "fly", "args": {}}}}]
    worker = create_worker(manager)
    cp = run_turn(worker)
    assert any(e.kind == "decision_invalid" for e in cp.events)
    assert cp.turn.action is None and fakes.world.actions == []
    assert cp.world.agents["a01"].stats.compute == pytest.approx(200 - 0.3)


def test_cognition_is_capped_at_the_balance_with_uncharged_recorded(manager: runner.RunManager, fakes: Fakes) -> None:
    fakes.context.min_compute = 0.0
    worker = create_worker(manager)
    iv = TypeAdapter(runner.Intervention).validate_python({"type": "set_stat", "entity_id": "a01", "field": "stats.compute", "value": 0.1})
    worker.stage_intervention(iv)
    cp = run_turn(worker)
    call = cp.model_calls[0]
    assert call.charged_compute == pytest.approx(0.1) and call.uncharged_compute == pytest.approx(0.2)
    completed = next(e for e in cp.events if e.kind == "model_call_completed")
    assert completed.details["uncharged_compute"] == pytest.approx(0.2)
    assert cp.world.agents["a01"].stats.compute >= 0


def test_dead_agent_gets_a_skipped_dead_checkpoint(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    worker.checkpoint.world.agents["a01"].alive = False  # dead before the round: never scheduled
    cp = run_turn(worker)
    assert cp.turn.turn_id == "r00001_t01_a02" and cp.turn.scheduler.order == ["a02", "a03", "a04", "a05", "a06"]
    worker.checkpoint.world.agents["a03"].alive = False  # dies after the order was fixed (A-SCHED-2)
    cp = run_turn(worker)
    assert cp.turn.turn_id == "r00001_t02_a03" and cp.turn.decision_source == "skipped_dead"
    assert cp.turn.action is None
    # A-SCHED-5: a03 decided at round start; the unused call is recorded, never charged
    assert cp.turn.model_call_ids == ["mc_r00001_t02_a03_01"]
    assert kinds(cp) == ["turn_started", "model_call_failed"] and cp.events[0].details == {"decision_source": "skipped_dead"}
    unused = cp.model_calls[0]
    assert unused.status == "failed" and unused.error == runner.DEAD_BEFORE_TURN_MESSAGE and unused.charged_compute == 0
    assert cp.events[1].details["infra"] is False and cp.events[1].costs.compute == 0
    wait_calls(fakes, 5)


def test_unaffordable_packet_is_a_resource_skip(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    worker.checkpoint.world.agents["a01"].stats.compute = 0.1
    cp = run_turn(worker)
    assert cp.turn.decision_source == "skipped_unaffordable"
    assert kinds(cp) == ["round_started", "turn_started", "resource_skip"]
    skip = cp.events[-1]
    assert skip.details["reason"] == "below the minimum packet" and skip.details["compute"] == pytest.approx(0.1)
    assert cp.turn.packet_id == "pk_r00001_t01_a01" and cp.decision_packets[0].affordable is False
    wait_calls(fakes, 5)
    assert [c.metadata["agent_id"] for c in fakes.model.calls] == ["a02", "a03", "a04", "a05", "a06"]  # none for a01
    skip_records = [r for r in cp.knowledge["a01"].records if r.content.get("reason") == "resource_skip"]
    assert len(skip_records) == 1 and "could not afford" in skip_records[0].text
    # knowledge boundary: the exact balance stays in the event/packet, never in the record
    assert "0.5" not in skip_records[0].text and "compute" not in skip_records[0].content
    assert cp.knowledge["a01"].records[0].read is False


def test_wait_turn_consumes_the_turn_without_a_model_call(manager: runner.RunManager, fakes: Fakes) -> None:
    fakes.model.script = [{"status": "ok", "parsed": {"action": {"name": "wait", "args": {"rounds": 2}}}}]
    worker = create_worker(manager, max_rounds=None)
    cp = run_turn(worker)
    assert cp.turn.action is not None and cp.turn.action["name"] == "wait"
    assert cp.world.agents["a01"].wait_turns_remaining == 1
    for _ in range(6):  # a02..a06 then the round end
        run_turn(worker)
    assert worker.checkpoint.turn.turn_id == "r00001_end"
    cp = run_turn(worker)
    assert cp.turn.turn_id == "r00002_t01_a01" and cp.turn.decision_source == "wait"
    assert cp.turn.model_call_ids == [] and cp.world.agents["a01"].wait_turns_remaining == 0
    wait_calls(fakes, 6 + 5)  # round 2 decided at its start, without the waiting a01


def test_step_round_ends_with_the_round_end_checkpoint(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    worker.submit("step_round")
    assert wait_idle(worker) == "paused"
    cp = worker.checkpoint
    assert cp.turn.turn_id == "r00001_end" and cp.turn.kind == "round_end"
    assert cp.turn.scheduler.round_complete is True and cp.turn.previous_turn_id == "r00001_t06_a06"
    assert fakes.world.round_ends == 1
    assert [e.kind for e in cp.events].count("upkeep") == 6 and cp.events[-1].kind == "round_ended"
    assert cp.events[-1].details["living_agents"] == [f"a{i:02d}" for i in range(1, 7)]
    assert cp.world.round == 1
    order = fakes.storage.runs[worker.run_id]["order"]
    assert order == [TurnId.INIT] + [f"r00001_t{i:02d}_a{i:02d}" for i in range(1, 7)] + ["r00001_end"]
    assert worker.status().next_step == "new_round"


def test_play_runs_until_max_rounds_finishes(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager, max_rounds=2)
    worker.submit("play")
    assert wait_idle(worker) == "finished"
    assert worker.checkpoint.turn.turn_id == "r00002_end"
    assert worker.status().finished_reason == "max_rounds"
    assert worker.checkpoint.events[-1].kind == "run_finished"
    assert fakes.storage.runs[worker.run_id]["manifest"].finished is True


def test_finished_run_ignores_commands_until_staged_edits_change_the_condition(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager, max_rounds=1)
    worker.submit("step_round")
    assert wait_idle(worker) == "finished"
    assert worker.submit("pause").state == "finished"  # no-op
    assert worker.submit("run_turn").state == "running"
    assert wait_idle(worker) == "finished"
    assert worker.checkpoint.turn.turn_id == "r00001_end"  # nothing new committed
    iv = TypeAdapter(runner.Intervention).validate_python({"type": "update_run_settings", "max_rounds": 3})
    worker.stage_intervention(iv)
    cp = run_turn(worker)
    assert cp.turn.turn_id == "r00002_t01_a01" and cp.turn.interventions[0].ok
    assert worker.status().state == "paused" and worker.status().finished_reason is None
    assert fakes.storage.runs[worker.run_id]["manifest"].finished is False


def test_all_agents_dead_finishes_the_run(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    for agent in worker.checkpoint.world.agents.values():
        agent.alive = False
    worker.submit("run_turn")
    assert wait_idle(worker) == "finished"
    cp = worker.checkpoint
    assert cp.turn.turn_id == "r00001_end" and cp.turn.kind == "round_end"
    assert cp.events[-1].kind == "run_finished" and cp.events[-1].details["reason"] == "all_dead"
    assert worker.status().finished_reason == "all_dead"


def test_death_during_a_turn_finishes_at_that_commit(manager: runner.RunManager, fakes: Fakes) -> None:
    fakes.model.script = [{"status": "ok", "parsed": {"action": {"name": "attack", "args": {"target": "a01", "compute_budget": 500}}}}]
    worker = create_worker(manager)
    for aid in ("a02", "a03", "a04", "a05", "a06"):
        worker.checkpoint.world.agents[aid].alive = False
    worker.submit("run_turn")
    assert wait_idle(worker) == "finished"
    cp = worker.checkpoint
    assert cp.turn.turn_id == "r00001_t01_a01" and cp.turn.kind == "agent_turn"
    assert cp.events[-1].kind == "run_finished" and cp.events[-1].details["reason"] == "all_dead"
    assert "death" in kinds(cp)
    assert worker.status().living_agent_count == 0


def test_resumed_skill_acts_without_a_model_call_and_charges_the_discount(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    agent = worker.checkpoint.world.agents["a01"]
    agent.skills["feed"] = SkillDefinition(name="feed", params=[], source="move(\"up\")", blocks=[], compiled=[], block_count=2, saved_round=0)
    agent.skill_execution = SkillExecutionState(root_skill="feed", frames=[SkillFrame(skill="feed")], status="running")
    fakes.skills.steps["feed"] = [MOVE_UP]
    cp = run_turn(worker)
    assert cp.turn.decision_source == "skill" and cp.turn.model_call_ids == []
    assert kinds(cp) == ["round_started", "turn_started", "skill_step", "action"]
    assert cp.turn.action == {"name": "move", "args": {"direction": "up"}, "via_skill": True, "skill_name": "feed"}
    assert fakes.world.actions[0].via_skill is True
    agent = cp.world.agents["a01"]
    assert agent.stats.compute == pytest.approx(200 - 0.01 - 4.0)  # interpreter 0.01 + move 5 x 0.8
    assert agent.total_interpreter_spent == pytest.approx(0.01)
    assert agent.skill_execution is not None and agent.skill_execution.status == "running" and agent.skill_execution.actions_executed == 1
    assert agent.position == Point(x=0, y=1)


def test_skill_that_ends_without_an_action_falls_through_to_a_model_decision(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    agent = worker.checkpoint.world.agents["a01"]
    agent.skill_execution = SkillExecutionState(root_skill="feed", frames=[SkillFrame(skill="feed")], status="running")
    fakes.skills.steps["feed"] = ["finish"]
    cp = run_turn(worker)
    assert kinds(cp) == ["round_started", "turn_started", "skill_step", "skill_finished", "model_call_pending", "model_call_completed", "decision", "action"]
    assert cp.turn.decision_source == "model" and cp.turn.model_call_ids == ["mc_r00001_t01_a01_01"]
    assert cp.world.agents["a01"].skill_execution is None  # the direct action replaced the finished execution


def test_skill_error_records_feedback_then_model_decides(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    agent = worker.checkpoint.world.agents["a01"]
    agent.skill_execution = SkillExecutionState(root_skill="feed", frames=[SkillFrame(skill="feed")], status="running")
    fakes.skills.steps["feed"] = ["error"]
    cp = run_turn(worker)
    assert "skill_error" in kinds(cp) and "decision" in kinds(cp)
    assert any("division by zero" in r.text for r in cp.knowledge["a01"].records)


def test_skill_yield_on_op_budget_uses_the_turn(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    agent = worker.checkpoint.world.agents["a01"]
    agent.skill_execution = SkillExecutionState(root_skill="feed", frames=[SkillFrame(skill="feed")], status="running")
    fakes.skills.steps["feed"] = ["yield"]
    cp = run_turn(worker)
    assert kinds(cp) == ["round_started", "turn_started", "skill_step"]
    assert cp.turn.decision_source == "skill" and cp.turn.action is None
    assert cp.world.agents["a01"].stats.compute == pytest.approx(199.0)
    assert cp.world.agents["a01"].skill_execution.status == "running"


def test_run_skill_decision_starts_the_skill_and_saves_skills_first(manager: runner.RunManager, fakes: Fakes) -> None:
    decision = {"save_skills": [{"name": "feed", "params": [], "source": "move(\"up\")"}, {"name": "bad", "params": [], "source": "BAD"}], "delete_skills": ["ghost"], "action": {"name": "run_skill", "args": {"skill": "feed", "arguments": []}}}
    fakes.model.script = [{"status": "ok", "parsed": decision}]
    fakes.skills.steps["feed"] = [MOVE_UP]
    worker = create_worker(manager)
    cp = run_turn(worker)
    assert kinds(cp) == ["round_started", "turn_started", "model_call_pending", "model_call_completed", "decision", "skill_rejected", "skill_saved", "skill_rejected", "skill_started", "skill_step", "action"]
    assert cp.turn.decision_source == "model"
    assert cp.turn.action["via_skill"] is True and cp.turn.action["skill_name"] == "feed"
    agent = cp.world.agents["a01"]
    assert "feed" in agent.skills and "bad" not in agent.skills
    assert agent.skill_execution is not None and agent.skill_execution.root_skill == "feed"
    assert any("ghost" in r.text for r in cp.knowledge["a01"].records)


def test_run_skill_of_unknown_skill_uses_the_turn_without_fee(manager: runner.RunManager, fakes: Fakes) -> None:
    fakes.model.script = [{"status": "ok", "parsed": {"action": {"name": "run_skill", "args": {"skill": "nope", "arguments": []}}}}]
    worker = create_worker(manager)
    cp = run_turn(worker)
    assert cp.events[-1].kind == "skill_error" and cp.turn.action is None
    agent = cp.world.agents["a01"]
    assert agent.last_result is not None and agent.last_result.reason == "invalid_action"
    assert agent.stats.compute == pytest.approx(200 - 0.3)  # only cognition


def test_running_skill_is_interrupted_by_configured_unread_kind(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    worker.checkpoint.world.rules.skills.interrupt_on = ["system"]
    agent = worker.checkpoint.world.agents["a01"]
    agent.skill_execution = SkillExecutionState(root_skill="feed", frames=[SkillFrame(skill="feed")], status="running")
    fakes.skills.steps["feed"] = [MOVE_UP]
    cp = run_turn(worker)
    finished = next(e for e in cp.events if e.kind == "skill_finished")
    assert finished.details["error"] == "interrupted" and finished.details["status"] == "stopped"
    assert cp.turn.decision_source == "model" and cp.turn.model_call_ids
    assert fakes.skills.steps["feed"] == [MOVE_UP]  # the interpreter never ran


def test_removed_scheduled_agent_is_skipped_removed(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    run_turn(worker)  # a01 acted; order fixed
    iv = TypeAdapter(runner.Intervention).validate_python({"type": "remove_entity", "entity_id": "a02"})
    worker.stage_intervention(iv)
    cp = run_turn(worker)
    assert cp.turn.turn_id == "r00001_t02_a02" and cp.turn.decision_source == "skipped_removed"
    assert "a02" not in cp.world.agents and "a02" in cp.knowledge
    assert cp.turn.interventions[0].ok
    cp = run_turn(worker)
    assert cp.turn.turn_id == "r00001_t03_a03" and cp.turn.decision_source == "model"


def test_voice_and_knowledge_interventions_reach_recipients(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    voice = TypeAdapter(runner.Intervention).validate_python({"type": "voice", "recipients": {"mode": "agents", "agent_ids": ["a02", "a03"]}, "text": "beware"})
    edit = TypeAdapter(runner.Intervention).validate_python({"type": "edit_knowledge", "agent_id": "a04", "operation": "replace_notebook", "notebook": "new notes"})
    worker.stage_intervention(voice)
    worker.stage_intervention(edit)
    assert [iv.id for iv in worker.staged()] == ["iv_0001", "iv_0002"]
    worker.unstage("iv_0002")
    worker.stage_intervention(edit)
    cp = run_turn(worker)
    voice_event = next(e for e in cp.events if e.kind == "operator_voice")
    assert voice_event.details["recipients"] == ["a02", "a03"] and voice_event.details["text"] == "beware"
    assert any(r.kind == "operator_voice" and r.text == "beware" for r in cp.knowledge["a02"].records)
    assert not any(r.kind == "operator_voice" for r in cp.knowledge["a01"].records)
    assert cp.knowledge["a04"].notebook == "new notes"
    assert [iv.intervention.id for iv in cp.turn.interventions] == ["iv_0001", "iv_0003"]
    with pytest.raises(runner.NotFoundError):
        worker.unstage("iv_0009")


def test_notices_from_actions_are_routed_to_recipient_knowledge(manager: runner.RunManager, fakes: Fakes) -> None:
    fakes.model.script = [{"status": "ok", "parsed": {"action": {"name": "attack", "args": {"target": "a02", "compute_budget": 10}}}}]
    worker = create_worker(manager)
    cp = run_turn(worker)
    assert any(r.kind == "damage" and r.content["attacker"] == "a01" for r in cp.knowledge["a02"].records)
    assert cp.turn.action_result.effects["target_health_after"] == 90


def test_open_run_carries_interrupted_pending_call_into_the_next_commit(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    run_id = worker.run_id
    # simulate a crash mid-call: a pending file is left behind after the init checkpoint
    request = ModelRequest(request_id="mc_r00001_t01_a01_01", model_key="fake-heuristic", messages=[])
    leftover = ModelCallRecord(call_id="mc_r00001_t01_a01_01", turn_id="r00001_t01_a01", round=1, turn=1, agent_id="a01", purpose="decision", model_key="fake-heuristic", provider="fake", model_id="fake-heuristic", status="pending", started_at="t", request=request)
    fakes.storage.write_pending_model_call(run_id, leftover)
    manager.close_run(run_id)
    with pytest.raises(runner.RunnerError, match="run_not_open"):
        manager.require(run_id)
    worker = manager.open_run(run_id)
    assert manager.open_run(run_id) is worker  # idempotent
    status = worker.status()
    assert status.state == "paused" and status.feed_epoch and status.real_usage.interrupted_calls == 1
    feed = worker.events_since(0, 100)
    assert feed[-1].kind == "model_call_failed" and feed[-1].details["interrupted"] is True and feed[-1].details["infra"] is True
    cp = run_turn(worker)
    assert cp.turn.model_call_ids == ["mc_r00001_t01_a01_01", "mc_r00001_t01_a01_02"]
    assert cp.model_calls[0].status == "failed" and cp.model_calls[0].error == "interrupted (outcome uncertain)"
    assert not [c for c in fakes.storage.runs[run_id]["pending"] if c.startswith("mc_r00001_t01_a01")]
    assert cp.world.agents["a01"].stats.compute == pytest.approx(200 - 0.3 - 1.0)  # charged exactly once


def test_events_since_live_view_and_feed_epoch(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    epoch = worker.status().feed_epoch
    run_turn(worker)
    events = worker.events_since(0, 100)
    seqs = [e.seq for e in events]
    assert seqs == sorted(seqs) and seqs[0] == 1 and worker.status().latest_seq == seqs[-1]
    assert worker.events_since(seqs[-1], 100) == []
    assert [e.seq for e in worker.events_since(2, 3)] == [3, 4, 5]
    view = worker.live_view()
    assert view.live and view.turn.turn_id == "r00001_t01_a01" and view.model_calls[0].call_id == "mc_r00001_t01_a01_01"
    assert view.decision_packet_ids == ["pk_r00001_t01_a01"]
    run_id = worker.run_id
    manager.close_run(run_id)
    reopened = manager.open_run(run_id)
    assert reopened.status().feed_epoch != epoch
    feed = reopened.events_since(0, 100)
    assert [e.seq for e in feed][: len(seqs)] == seqs  # disk fallback covers seqs before the ring
    # A-SCHED-5: closing mid-round cancelled the other agents' round calls; they come back as
    # interrupted: the next turn's is carried at once (its event is in the feed), the other four
    # wait for their own turns (the status ledger already counts all five)
    extra = feed[len(seqs):]
    assert [e.kind for e in extra] == ["model_call_failed"] and extra[0].details["call_id"] == "mc_r00001_t02_a02_01"
    assert reopened.status().real_usage.interrupted_calls == 5


def test_knowledge_and_effective_settings_views(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    view = worker.knowledge("a01")
    assert view.turn_id == TurnId.INIT and view.unread_count == 1
    with pytest.raises(runner.NotFoundError):
        worker.knowledge("zz")
    settings = worker.effective_settings()
    assert set(settings.effective_context) == set(worker.checkpoint.world.agents)
    assert settings.effective_model_key["a01"] == "fake-heuristic"


def test_reload_working_stages_a_file_intervention_only_when_idle(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    run = fakes.storage.runs[worker.run_id]
    run["working_errors"] = ["entities/agents/a01.json: bad json"]
    response = worker.reload_working()
    assert response.ok is False and response.errors == ["entities/agents/a01.json: bad json"]
    run["working_errors"] = []
    cp = worker.checkpoint
    working = WorkingState(world=copy.deepcopy(cp.world), knowledge=copy.deepcopy(cp.knowledge), settings=cp.settings.model_copy(deep=True))
    run["working"] = working
    assert worker.reload_working().staged is None  # no diff
    working.world.agents["a01"].stats.compute = 123
    response = worker.reload_working()
    assert response.ok and response.staged is not None and response.staged.type == "apply_working_files"
    assert response.staged.origin == "file" and response.staged.base_turn_id == TurnId.INIT
    assert response.changes[0].path == "world.agents.a01.stats.compute"
    committed = run_turn(worker)
    record = committed.turn.interventions[0]
    assert record.ok and record.changes[0].before == 200 and record.changes[0].after == 123
    assert committed.world.agents["a01"].stats.compute == pytest.approx(123 - 0.3 - 1.0)
    assert run["snapshots"] == {}  # applied snapshot deleted at commit
    # stale: the base turn moved on
    working.world.agents["a01"].stats.compute = 5
    stale = worker.reload_working().staged
    assert stale is not None
    stale.base_turn_id = TurnId.INIT
    worker._staged[-1] = stale
    committed = run_turn(worker)
    assert committed.turn.interventions[0].ok is False and "stale" in committed.turn.interventions[0].error
    fakes.model.block = threading.Event()
    worker.submit("play")
    assert fakes.model.in_call.wait(5)
    with pytest.raises(runner.RunnerError):
        worker.reload_working()
    worker.submit("pause")
    fakes.model.block.set()
    wait_idle(worker)


def test_model_assignment_and_prices_interventions(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    assign = TypeAdapter(runner.Intervention).validate_python({"type": "update_model_assignment", "scope": "a01", "model_key": "fake-scripted"})
    worker.stage_intervention(assign)
    with pytest.raises(runner.SetupError) as info:
        worker.stage_intervention(TypeAdapter(runner.Intervention).validate_python({"type": "update_model_assignment", "scope": "run", "model_key": "nope"}))
    assert info.value.problems[0].path == "model_key"
    prices = TypeAdapter(runner.Intervention).validate_python({"type": "update_prices", "prices": {"move": 9}})
    worker.stage_intervention(prices)
    cp = run_turn(worker)
    assert cp.settings.model_overrides["a01"] == "fake-scripted"
    assert cp.world.rules.cognition.mind_multipliers["fake-scripted"] == 1.0
    assert cp.world.rules.prices.move == 9
    assert fakes.model.calls[0].model_key == "fake-scripted"
    assert cp.model_calls[0].model_key == "fake-scripted"


def test_host_budget_reached_enters_error_without_charging(manager: runner.RunManager, fakes: Fakes) -> None:
    fakes.model.script = [{"status": "ok", "parsed": OBSERVE, "cost": 0.5}]
    worker = create_worker(manager, real_budget_usd=0.4)
    worker.submit("run_turn")
    assert wait_idle(worker) == "error"
    assert worker.status().last_error == "host budget exhausted"
    assert worker.status().real_usage.provider_cost_usd == pytest.approx(0.5)
    assert worker.checkpoint.world.agents["a01"].stats.compute == 200
    worker.submit("pause")
    assert worker.status().state == "paused"
    worker.submit("play")  # legal again, but the pre-call budget check stops it before any provider call
    assert wait_idle(worker) == "error"
    # the round's six calls started together at round start (the budget was not reached then);
    # the re-run of a01 is stopped by the pre-call check without another call
    assert worker.status().last_error == "host budget exhausted"
    wait_calls(fakes, 6)
    worker.submit("pause")
    worker.stage_intervention(TypeAdapter(runner.Intervention).validate_python({"type": "update_run_settings", "clear_real_budget": True}))
    cp = run_turn(worker)
    assert cp.settings.real_budget_usd is None
    assert cp.turn.model_call_ids == ["mc_r00001_t01_a01_01", "mc_r00001_t01_a01_02"]
    assert cp.model_calls[0].charged_compute == 0 and cp.model_calls[0].uncharged_compute == pytest.approx(0.3)
    assert cp.world.agents["a01"].stats.compute == pytest.approx(200 - 0.3 - 1.0)  # charged once, for the committed call


def test_exception_inside_a_turn_enters_error_and_pause_recovers(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    original = fakes.world.apply_action

    def boom(w: WorldState, request: Any) -> ActionOutcome:
        raise RuntimeError("engine bug")

    fakes.world.apply_action = boom  # type: ignore[assignment]
    worker.submit("run_turn")
    assert wait_idle(worker) == "error"
    assert worker.status().last_error == "RuntimeError: engine bug"
    fakes.world.apply_action = original  # type: ignore[assignment]
    worker.submit("pause")
    cp = run_turn(worker)
    assert cp.turn.turn_id == "r00001_t01_a01"
    error_event = next(e for e in cp.events if e.kind == "error")
    assert "engine bug" in error_event.details["message"] and error_event.details["traceback_excerpt"]
    assert cp.turn.model_call_ids == ["mc_r00001_t01_a01_01", "mc_r00001_t01_a01_02"]  # the first call's usage was carried


def test_continuation_opens_paused_from_the_copied_turn(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    run_turn(worker)
    run_turn(worker)
    summary = manager.create_continuation(worker.run_id, runner.ContinuationRequest(from_turn_id="r00001_t01_a01"))
    assert summary.status == "paused" and summary.current_turn_id == "r00001_t01_a01"
    child = manager.require(summary.run_id)
    cp = run_turn(child)
    assert cp.turn.turn_id == "r00001_t02_a02" and cp.turn.previous_turn_id == "r00001_t01_a01"
    assert worker.checkpoint.turn.turn_id == "r00001_t02_a02"  # the parent is untouched


def test_close_run_stops_the_worker_and_forgets_it(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    status = manager.close_run(worker.run_id)
    assert status.state == "paused"
    assert manager.get(worker.run_id) is None
    with pytest.raises(runner.RunnerError, match="run_not_open"):
        manager.close_run(worker.run_id)
    with pytest.raises(runner.RunnerError, match="run_not_open"):
        worker.submit("run_turn")
    assert manager.get_summary(worker.run_id).status == "paused"


def test_finish_checkpoint_at_a_boundary_never_reuses_its_turn_id(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager, max_rounds=1)
    worker.submit("step_round")
    assert wait_idle(worker) == "finished"
    # a staged edit that does not change the finish condition still gets recorded in its own checkpoint
    voice = TypeAdapter(runner.Intervention).validate_python({"type": "voice", "recipients": {"mode": "broadcast_all"}, "text": "still there?"})
    worker.stage_intervention(voice)
    worker.submit("run_turn")
    assert wait_idle(worker) == "finished"
    cp = worker.checkpoint
    assert cp.turn.turn_id == "r00002_t01_a01" and cp.turn.decision_source == "none"
    assert cp.turn.interventions[0].ok and cp.events[-1].kind == "run_finished"
    assert cp.turn.scheduler.next_index == 1  # the slot was consumed
    # reviving continues with the next slot and chains to the finish checkpoint
    revive = TypeAdapter(runner.Intervention).validate_python({"type": "update_run_settings", "clear_max_rounds": True})
    worker.stage_intervention(revive)
    cp = run_turn(worker)
    assert cp.turn.turn_id == "r00002_t02_a02" and cp.turn.previous_turn_id == "r00002_t01_a01"
    assert cp.turn.decision_source == "model" and worker.status().state == "paused"
    order = fakes.storage.runs[worker.run_id]["order"]
    assert len(order) == len(set(order))


# ---------------------------------------------------------------------------
# Review regressions: boundary order, discarded charges, the ledger, one writer
# ---------------------------------------------------------------------------


def step_round(worker: runner.RunWorker) -> Checkpoint:
    worker.submit("step_round")
    wait_idle(worker)
    return worker.checkpoint


def _boom(w: WorldState, request: Any) -> ActionOutcome:
    raise RuntimeError("engine bug")


def test_staged_edits_apply_before_the_new_round_is_scheduled(manager: runner.RunManager, fakes: Fakes) -> None:
    """Spec "Turn orchestration" step 1: at r{n}_end the staged edits come first, then the
    initiative.  A speed edit staged at the round end decides who opens the next round,
    and everything the boundary produced carries the final turn id."""
    worker = create_worker(manager)
    assert step_round(worker).turn.turn_id == "r00001_end"
    iv = TypeAdapter(runner.Intervention).validate_python({"type": "set_stat", "entity_id": "a06", "field": "stats.speed", "value": 9})
    worker.stage_intervention(iv)
    cp = run_turn(worker)
    assert cp.turn.turn_id == "r00002_t01_a06" and cp.turn.previous_turn_id == "r00001_end"
    assert cp.world.round == 2 and cp.turn.scheduler.order[0] == "a06"
    record = cp.turn.interventions[0]
    assert record.ok and record.effective_turn_id == "r00002_t01_a06" and record.applied_round == 2
    assert {e.turn_id for e in cp.events} == {"r00002_t01_a06"}
    assert kinds(cp)[:3] == ["intervention", "round_started", "turn_started"]
    assert cp.events[0].details["effective_turn_id"] == "r00002_t01_a06"
    assert cp.events[1].details["order"][0] == "a06"
    assert worker.status().state == "paused"


def test_agent_placed_at_the_round_end_acts_in_the_next_round(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    step_round(worker)
    place = TypeAdapter(runner.Intervention).validate_python(
        {"type": "place_entity", "entity": {"kind": "agent", "id": "", "name": "Newcomer", "position": {"x": 0, "y": 0}}}
    )
    worker.stage_intervention(place)
    cp = run_turn(worker)
    assert cp.turn.round == 2 and "a07" in cp.turn.scheduler.order and "a07" in cp.knowledge
    assert next(e for e in cp.events if e.kind == "round_started").details["order"] == cp.turn.scheduler.order


def test_working_snapshot_at_the_round_end_does_not_roll_the_round_back(manager: runner.RunManager, fakes: Fakes) -> None:
    """The reviewed blocker: a reload staged at r{n}_end carries world.round = n; applied
    after the round had started it rolled the round back and re-committed round n's ids."""
    worker = create_worker(manager)
    step_round(worker)
    run = fakes.storage.runs[worker.run_id]
    cp = worker.checkpoint
    working = WorkingState(world=copy.deepcopy(cp.world), knowledge=copy.deepcopy(cp.knowledge), settings=cp.settings.model_copy(deep=True))
    working.world.agents["a01"].stats.compute = 150
    run["working"] = working
    assert worker.reload_working().ok
    cp = run_turn(worker)
    assert cp.turn.turn_id == "r00002_t01_a01" and cp.turn.previous_turn_id == "r00001_end"
    assert cp.world.round == 2 and cp.turn.interventions[0].ok
    assert cp.turn.action_result is not None and cp.turn.action_result.round == 2
    cp = run_turn(worker)
    assert cp.turn.turn_id == "r00002_t02_a02"
    order = run["order"]
    assert len(order) == len(set(order)) and order[-3:] == ["r00001_end", "r00002_t01_a01", "r00002_t02_a02"]


def test_working_snapshot_from_another_round_is_rejected(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    run_turn(worker)
    run = fakes.storage.runs[worker.run_id]
    cp = worker.checkpoint
    working = WorkingState(world=copy.deepcopy(cp.world), knowledge=copy.deepcopy(cp.knowledge), settings=cp.settings.model_copy(deep=True))
    working.world.agents["a01"].stats.compute = 150
    working.world.round = 7
    run["working"] = working
    assert worker.reload_working().ok
    cp = run_turn(worker)
    record = cp.turn.interventions[0]
    assert record.ok is False and "round 7" in (record.error or "")
    assert cp.world.round == 1 and cp.turn.turn_id == "r00001_t02_a02" and worker.status().state == "paused"


def test_failed_turn_after_a_charged_call_discards_the_charge(manager: runner.RunManager, fakes: Fakes) -> None:
    """An exception after a completed, charged call: the charge went to the discarded
    copy, so the carried record is failed/uncharged and no committed event reports it."""
    worker = create_worker(manager)
    original = fakes.world.apply_action
    fakes.world.apply_action = _boom  # type: ignore[assignment]
    worker.submit("run_turn")
    assert wait_idle(worker) == "error"
    assert worker.status().real_usage.calls == 6  # visible while uncommitted: a01's and the round's other five
    fakes.world.apply_action = original  # type: ignore[assignment]
    worker.submit("pause")
    cp = run_turn(worker)
    first, second = cp.model_calls
    assert first.call_id.endswith("_01") and first.status == "failed" and first.error == runner.DISCARDED_CHARGE_MESSAGE
    assert first.charged_compute == 0 and first.uncharged_compute == pytest.approx(0.3)
    assert second.status == "completed" and second.charged_compute == pytest.approx(0.3)
    completed = [e for e in cp.events if e.kind == "model_call_completed"]
    assert [e.details["call_id"] for e in completed] == [second.call_id]
    failed = [e for e in cp.events if e.kind == "model_call_failed"]
    assert len(failed) == 1 and failed[0].details["call_id"] == first.call_id
    assert failed[0].details["infra"] is False and failed[0].costs.compute == 0
    assert not any(e.kind == "cognition_charged" for e in cp.events)
    assert [e.details["call_id"] for e in cp.events if e.kind == "model_call_pending"] == [first.call_id, second.call_id]
    agent = cp.world.agents["a01"]
    charged_by_events = sum(e.costs.compute for e in cp.events if e.kind in ("model_call_completed", "model_call_failed", "cognition_charged"))
    assert charged_by_events == pytest.approx(agent.total_cognition_spent) == pytest.approx(0.3)
    assert sum(r.charged_compute for r in cp.model_calls) == pytest.approx(agent.total_cognition_spent)
    assert next(e for e in cp.events if e.kind == "error").seq > failed[0].seq


def test_uncommitted_usage_is_persisted_only_by_the_commit_that_holds_the_call(manager: runner.RunManager, fakes: Fakes) -> None:
    """Spec persistence: no duplicate usage accounting.  A failed attempt's call is shown
    in the status ledger, never written by staging, and counted once after a reopen."""
    worker = create_worker(manager)
    run_id = worker.run_id
    original = fakes.world.apply_action
    fakes.world.apply_action = _boom  # type: ignore[assignment]
    worker.submit("run_turn")
    assert wait_idle(worker) == "error"
    fakes.world.apply_action = original  # type: ignore[assignment]
    deadline = time.time() + 5
    while worker.status().real_usage.input_tokens < 6000 and time.time() < deadline:
        time.sleep(0.005)  # the round's last calls may still be answering on the pool
    view = worker.status().real_usage
    assert view.calls == 6 and view.input_tokens == 6000  # a01's failed attempt and the round's other five calls
    voice = TypeAdapter(runner.Intervention).validate_python({"type": "voice", "recipients": {"mode": "broadcast_all"}, "text": "hi"})
    worker.stage_intervention(voice)  # persists the manifest
    on_disk = fakes.storage.read_manifest(run_id).real_usage
    assert on_disk.calls == 0 and on_disk.input_tokens == 0
    manager.close_run(run_id)  # the pending file is still there: a restart recovers it
    worker = manager.open_run(run_id)
    view = worker.status().real_usage
    # One rule for both ledger helpers (fix pass): every record counts in ``calls``, an
    # interrupted one ALSO in ``interrupted_calls`` (a subset, as the UI's label reads).
    # all six pending files come back as interrupted: a01's is carried into the next commit, the
    # other five wait for their own turns of the round (A-SCHED-6)
    assert view.calls == 6 and view.interrupted_calls == 6 and view.input_tokens == 6000
    cp = run_turn(worker)
    ledger = fakes.storage.read_manifest(run_id).real_usage
    assert ledger.calls == 2 and ledger.interrupted_calls == 1
    assert ledger.input_tokens == sum(r.result.usage.billed_input_tokens for r in cp.model_calls if r.result) == 2000
    # the committed ledger plus the five interrupted calls and the five new round calls still waiting
    deadline = time.time() + 5
    while worker.status().real_usage.input_tokens < ledger.input_tokens + 10000 and time.time() < deadline:
        time.sleep(0.005)
    live = worker.status().real_usage
    assert live.calls == ledger.calls + 10 and live.interrupted_calls == 6 and live.input_tokens == ledger.input_tokens + 10000
    for _ in range(6):  # the rest of the round: every interrupted call lands in its own turn, once
        run_turn(worker)
    ledger = fakes.storage.read_manifest(run_id).real_usage
    assert ledger.calls == 12 and ledger.interrupted_calls == 6 and worker.status().real_usage == ledger


def test_close_returns_at_once_and_reopen_waits_for_the_last_commit(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    run_id = worker.run_id
    fakes.model.block = threading.Event()
    worker.submit("run_turn")
    assert fakes.model.in_call.wait(5)
    status = manager.close_run(run_id)  # must not wait for the blocked provider call
    assert status.state == "pause_requested"
    with pytest.raises(runner.RunnerError, match="run_not_open"):
        manager.require(run_id)
    opened: dict[str, runner.RunWorker] = {}
    thread = threading.Thread(target=lambda: opened.setdefault("worker", manager.open_run(run_id)))
    thread.start()
    time.sleep(0.05)
    assert thread.is_alive()  # the reopen waits for the closing worker to commit
    fakes.model.block.set()
    thread.join(5)
    assert not thread.is_alive()
    reopened = opened["worker"]
    assert reopened is not worker and reopened.checkpoint.turn.turn_id == "r00001_t01_a01"
    assert reopened.status().state == "paused" and set(fakes.storage.locks) == {run_id}


def test_a_second_manager_cannot_open_an_open_run(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager)
    other = runner.RunManager(fakes.registry)
    try:
        with pytest.raises(runner.RunnerError, match="another process"):
            other.open_run(worker.run_id)
        manager.close_run(worker.run_id)
        assert worker.join(5)  # the lock is released when the worker thread exits
        assert other.open_run(worker.run_id).run_id == worker.run_id
        with pytest.raises(runner.RunnerError, match="another process"):
            manager.open_run(worker.run_id)
    finally:
        other.shutdown()


def test_place_agent_rejected_at_apply_leaves_nothing_behind(manager: runner.RunManager, fakes: Fakes) -> None:
    """A placement valid at staging but invalid after an earlier staged settings edit is
    skipped whole: no agent, no knowledge, no override, and the run keeps going."""
    worker = create_worker(manager)
    raise_cap = TypeAdapter(runner.Intervention).validate_python(
        {"type": "update_context_settings", "scope": "run", "settings": {"input_token_cap": 97000}}
    )
    worker.stage_intervention(raise_cap)
    place = TypeAdapter(runner.Intervention).validate_python(
        {
            "type": "place_entity",
            "entity": {"kind": "agent", "id": "", "name": "Late", "position": {"x": 0, "y": 0}},
            "context_overrides": {"generation_allowance": 4000},
        }
    )
    worker.stage_intervention(place)  # valid against the committed cap
    cp = run_turn(worker)
    assert worker.status().state == "paused"
    first, second = cp.turn.interventions
    assert first.ok and second.ok is False and "context window" in (second.error or "")
    assert set(cp.world.agents) == {f"a{i:02d}" for i in range(1, 7)}
    assert "a07" not in cp.knowledge and "a07" not in cp.settings.context_overrides


def test_running_skill_ignores_the_runners_own_feedback_records(manager: runner.RunManager, fakes: Fakes) -> None:
    """A-SKILL-9 with interrupt_on = [system]: the cognition-charge record of the run_skill
    decision must not interrupt the skill it started; a transfer received (a real arrival
    of kind system) does."""
    fakes.model.script = [{"status": "ok", "parsed": {"action": {"name": "run_skill", "args": {"skill": "feed", "arguments": []}}}}]
    worker = create_worker(manager, max_rounds=None)
    worker.checkpoint.world.rules.skills.interrupt_on = ["system"]
    agent = worker.checkpoint.world.agents["a01"]
    agent.skills["feed"] = SkillDefinition(name="feed", params=[], source="move(\"up\")", blocks=[], compiled=[], block_count=2, saved_round=0)
    fakes.skills.steps["feed"] = [MOVE_UP, MOVE_UP, MOVE_UP]
    cp = step_round(worker)  # a01 starts the skill (model decision) -> its charge record is unread
    a01_records = cp.knowledge["a01"].records
    assert any(r.kind == "system" and "cognition_charged" in r.content and not r.read for r in a01_records)
    cp = run_turn(worker)  # round 2, a01 again
    assert cp.turn.turn_id == "r00002_t01_a01" and cp.turn.decision_source == "skill"
    assert not any(e.kind == "skill_finished" for e in cp.events)
    step_round(worker)
    store = worker.checkpoint.knowledge["a01"]
    fakes.context._add(store, "system", "received 5 compute from a02", {"amount": 5, "resource": "compute", "from": "a02"})
    cp = run_turn(worker)
    finished = next(e for e in cp.events if e.kind == "skill_finished")
    assert finished.details["error"] == "interrupted" and cp.turn.decision_source == "model"


def test_op_cap_spans_a_resumed_and_a_fresh_skill_in_one_turn(manager: runner.RunManager, fakes: Fakes) -> None:
    """Design: at most max_ops_per_turn interpreter steps per agent turn.  A resumed skill
    that ends without an action falls through to a model decision (A-SKILL-11); a fresh
    run_skill in that decision continues from the ops already spent this turn."""
    fakes.model.by_agent["a01"] = [{"status": "ok", "parsed": {"action": {"name": "run_skill", "args": {"skill": "b", "arguments": []}}}}]
    worker = create_worker(manager)
    agent = worker.checkpoint.world.agents["a01"]
    for name in ("a", "b"):
        agent.skills[name] = SkillDefinition(name=name, params=[], source="RETURN 1", blocks=[], compiled=[], block_count=1, saved_round=0)
    agent.skill_execution = SkillExecutionState(root_skill="a", frames=[SkillFrame(skill="a")], status="running")
    fakes.skills.steps["a"] = ["finish"]  # 1 op, no action
    fakes.skills.steps["b"] = [MOVE_UP]
    cp = run_turn(worker)
    assert cp.turn.decision_source == "model" and cp.turn.action is not None
    assert fakes.skills.seen_ops == [0, 1]  # the fresh skill starts where the resumed one stopped


def test_charged_agent_output_failure_reports_the_charge_once(manager: runner.RunManager, fakes: Fakes) -> None:
    fakes.model.script = [{"status": "malformed", "text": "not json"}]
    worker = create_worker(manager)
    cp = run_turn(worker)
    failed = next(e for e in cp.events if e.kind == "model_call_failed")
    audit = next(e for e in cp.events if e.kind == "cognition_charged")
    assert failed.costs.compute == pytest.approx(0.3) and audit.costs.compute == 0
    assert audit.details["charged"] == pytest.approx(0.3) and audit.details["call_id"] == failed.details["call_id"]
    total = sum(e.costs.compute for e in cp.events if e.kind in ("model_call_completed", "model_call_failed", "cognition_charged"))
    assert total == pytest.approx(cp.world.agents["a01"].total_cognition_spent)


def test_action_descriptions_label_scalar_arguments_and_thought_excerpts_end_at_a_word() -> None:
    """Fix pass: no unexplained bare numbers in decision summaries; a default page 0 is left
    out; a cut thought ends at a word boundary with an ellipsis."""
    d = runner._describe_action
    assert d("observe", {"point": {"x": -1, "y": 0}, "page": 0}) == "observe (-1,0)"
    assert d("observe", {"point": {"x": -1, "y": 0}, "page": 2}) == "observe (-1,0) page 2"
    assert d("attack", {"target": "a03", "compute_budget": 5}) == "attack a03 budget 5"
    assert d("recover", {"compute_budget": 10}) == "recover budget 10"
    assert d("wait", {"rounds": 2}) == "wait 2 rounds"
    assert d("transfer", {"recipient": "a02", "resource": "compute", "amount": 10}) == "transfer to a02 compute 10"
    assert d("send", {"recipient": "a02", "message": "hello there"}) == 'send to a02 "hello there"'
    assert d("run_skill", {"skill": "feed", "arguments": [1, "x"]}) == "run_skill feed [1,x]"
    assert d("move", {"direction": "up"}) == "move up"
    assert runner._excerpt("short thought") == "short thought"
    long = "First turn: observe my current position to understand my starting environment and plan"
    cut = runner._excerpt(long)
    assert cut.endswith("…") and len(cut) <= 81 and not cut[:-1].endswith(" ")
    assert cut == "First turn: observe my current position to understand my starting environment…"
    assert runner._excerpt("x" * 100) == "x" * 80 + "…"  # no word boundary: hard cut


def test_status_predicts_the_next_round_order_and_summaries_name_the_run_folder(manager: runner.RunManager, fakes: Fakes) -> None:
    worker = create_worker(manager, n=6)
    status = worker.status()
    assert status.next_step == "new_round"
    assert status.next_round_order is not None and sorted(status.next_round_order) == sorted(worker.checkpoint.world.agents)
    predicted = list(status.next_round_order)
    cp = run_turn(worker)  # the round starts: the real initiative equals the prediction when nothing was staged
    assert cp.turn.scheduler.order == predicted
    assert worker.status().next_round_order is None  # only at a new-round boundary
    assert manager.get_summary(worker.run_id).run_dir == f"/fake/worlds/{worker.manifest.world_id}/runs/{worker.run_id}"


def test_model_call_events_carry_the_provider_cost(manager: runner.RunManager, fakes: Fakes) -> None:
    """The UI tells the operator what the provider billed even when no world compute was
    charged (fix pass): every model_call_completed / model_call_failed event carries
    ``details.provider_cost_usd``."""
    worker = create_worker(manager, n=6)
    run_turn(worker)
    cp = run_turn(worker)
    completed = [e for e in cp.events if e.kind == "model_call_completed"]
    assert completed and all("provider_cost_usd" in e.details and "latency_ms" in e.details for e in completed)
