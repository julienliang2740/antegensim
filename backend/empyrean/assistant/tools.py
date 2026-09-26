"""
Read-only tools the chat profile may call (rev 4, D3): pure functions over storage / manager
views with compact outputs (digests, not raw files), each capped at
``config.ASSISTANT_TOOL_OUTPUT_MAX_CHARS`` with a truncation note.  Tool failures are returned
as ``{"error": ...}`` so the model can recover.  Runs need not be open for history reads; live
tools report "run not open".  OWNER: WP2 (uses digest.py from WP3 through the module attribute,
so a digest that is not implemented yet degrades to a tool error, never a crash).
"""
# DOCS: tools: list_runs, get_run_status, get_rules_and_settings, list_turns, get_turn_digest,
# get_round_digest, get_trends, get_agent_dossier, search_events, get_model_call,
# get_decision_packet_summary, get_staged_interventions, get_storybook, search_docs, get_defaults,
# get_server_log (get_context was dropped: step 1 is prefetched).  Every result is JSON, capped
# at ASSISTANT_TOOL_OUTPUT_MAX_CHARS with {"truncated": true, "note": ...}.

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Optional

from .. import config, model, storage
from ..runner import RunnerError
from . import digest

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService

log = logging.getLogger("empyrean.assistant.tools")

TOOL_NAMES: tuple[str, ...] = (
    "list_runs",
    "get_run_status",
    "get_rules_and_settings",
    "list_turns",
    "get_turn_digest",
    "get_round_digest",
    "get_trends",
    "get_agent_dossier",
    "search_events",
    "get_model_call",
    "get_decision_packet_summary",
    "get_staged_interventions",
    "get_storybook",
    "search_docs",
    "get_defaults",
    "get_server_log",
)


@dataclass
class ToolResult:
    name: str
    args: dict[str, Any]
    ok: bool
    payload: Any  # JSON-serialisable; {"error": str} when not ok
    summary: str  # one line for the UI
    truncated: bool = False
    sources: list[str] = field(default_factory=list)  # "turns r00003_t02_a05", "docs SYSTEM.md#economy"


class ToolError(Exception):
    """Raised inside a tool body; ``run_tool`` turns it into ``ToolResult(ok=False)``."""


def _s(args: dict[str, Any], key: str, default: Optional[str] = None) -> Optional[str]:
    value = args.get(key, default)
    return None if value is None else str(value)


def _i(args: dict[str, Any], key: str, default: Optional[int], lo: int, hi: int) -> Optional[int]:
    value = args.get(key, default)
    if value is None:
        return None
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def _require_run(args: dict[str, Any]) -> str:
    run_id = _s(args, "run_id")
    if not run_id:
        raise ToolError("run_id is required")
    return run_id


def _jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def cap_payload(payload: Any, max_chars: Optional[int] = None) -> tuple[Any, bool]:
    """Serialise-check the payload; beyond the cap return a partial text with a note."""
    limit = config.ASSISTANT_TOOL_OUTPUT_MAX_CHARS if max_chars is None else max_chars
    text = json.dumps(_jsonable(payload), ensure_ascii=False, sort_keys=True, default=str)
    if len(text) <= limit:
        return _jsonable(payload), False
    keep = max(200, limit - 160)
    return {
        "truncated": True,
        "note": f"output capped at {limit} chars ({len(text)} produced); narrow the query (fewer turns, a round range, a smaller limit)",
        "partial": text[:keep],
    }, True


# ---------------------------------------------------------------------------
# Shared readers (open worker first, disk otherwise)
# ---------------------------------------------------------------------------


def run_status_payload(service: "AssistantService", run_id: str) -> dict[str, Any]:
    """Live status of an open run, or the manifest summary with ``open: false``."""
    worker = service.manager.get(run_id)
    if worker is not None:
        st = worker.status()
        return {
            "open": True,
            "run_id": st.run_id,
            "name": worker.manifest.name,
            "state": st.state,
            "round": st.round,
            "current_turn_id": st.current_turn_id,
            "active_turn_id": st.active_turn_id,
            "next_step": st.next_step,
            "next_agent_id": st.next_agent_id,
            "acting_agent_id": st.acting_agent_id,
            "living_agent_count": st.living_agent_count,
            "staged_intervention_count": st.staged_intervention_count,
            "last_error": st.last_error,
            "finished_reason": st.finished_reason,
            "pending_model_call": st.pending_model_call.model_dump(mode="json") if st.pending_model_call else None,
            "real_usage": st.real_usage.model_dump(mode="json"),
            "default_model_key": worker.manifest.default_model_key,
        }
    summary = service.manager.get_summary(run_id)
    return {
        "open": False,
        "note": "run not open in this process; history reads still work",
        "run_id": summary.run_id,
        "name": summary.name,
        "state": summary.status,
        "round": summary.last_round,
        "current_turn_id": summary.current_turn_id,
        "living_agent_count": summary.living_agent_count,
        "agent_count": summary.agent_count,
        "default_model_key": summary.default_model_key,
        "saved_at": summary.saved_at,
        "parent": summary.parent.model_dump(mode="json") if summary.parent else None,
    }


def committed_checkpoint(service: "AssistantService", run_id: str, turn_id: Optional[str] = None) -> Any:
    """The open worker's committed checkpoint, else ``storage.load_checkpoint`` read-only.
    A ``turn_id`` always reads that checkpoint from disk."""
    if turn_id is None:
        worker = service.manager.get(run_id)
        if worker is not None:
            return worker.checkpoint
    return storage.load_checkpoint(run_id, turn_id)


def current_turn_id(service: "AssistantService", run_id: str) -> str:
    worker = service.manager.get(run_id)
    if worker is not None:
        return worker.status().current_turn_id
    return storage.read_manifest(run_id).current_turn_id


def basic_turn_summary(run_id: str, turn_id: str, *, max_events: int = 40) -> dict[str, Any]:
    """A model-free fallback digest (index entry + event summary lines) used when the WP3 digest
    is unavailable; every value comes from stored records."""
    entries = storage.list_turns(run_id)
    entry = next((e for e in entries if e.turn_id == turn_id), None)
    if entry is None:
        raise ToolError(f"turn {turn_id} is not a committed turn of {run_id}")
    events = storage.read_turn_events(run_id, turn_id)
    lost = entry.decision_source == "model" and entry.ok is False and entry.action_name is None
    return {
        "turn_id": entry.turn_id,
        "kind": entry.kind,
        "round": entry.round,
        "turn_index": entry.turn_index,
        "actor": entry.acting_agent_id,
        "decision_source": entry.decision_source,
        "action": entry.action_name,
        "ok": entry.ok,
        "lost": lost,
        "intervention_count": entry.intervention_count,
        "event_count": entry.event_count,
        "events": [f"[{e.kind}] {e.actor}: {e.summary}" for e in events[:max_events]],
        "events_truncated": max(0, len(events) - max_events),
        "note": "fallback digest (index entry + event lines); thoughts are not included",
    }


# ---------------------------------------------------------------------------
# Tool bodies
# ---------------------------------------------------------------------------


def _list_runs(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    limit = _i(args, "limit", 20, 1, 50) or 20
    archived = _s(args, "archived", "0")
    runs = service.manager.list_runs(archived if archived in ("0", "1", "all") else "0")
    payload = [
        {
            "run_id": r.run_id,
            "name": r.name,
            "status": r.status,
            "last_round": r.last_round,
            "current_turn_id": r.current_turn_id,
            "agent_count": r.agent_count,
            "living_agent_count": r.living_agent_count,
            "default_model_key": r.default_model_key,
            "saved_at": r.saved_at,
            "parent_run_id": r.parent.run_id if r.parent else None,
            "archived": r.archived,
        }
        for r in runs[:limit]
    ]
    return ToolResult("list_runs", args, True, {"runs": payload, "total": len(runs)}, f"{len(runs)} runs", sources=["runs"])


def _get_run_status(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    run_id = _require_run(args)
    payload = run_status_payload(service, run_id)
    return ToolResult("get_run_status", args, True, payload, f"{run_id}: {payload.get('state')} at {payload.get('current_turn_id')}", sources=[f"run {run_id}"])


def _get_rules_and_settings(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    run_id = _require_run(args)
    cp = committed_checkpoint(service, run_id, _s(args, "turn_id"))
    settings = cp.settings
    payload = {
        "turn_id": cp.turn.turn_id,
        "rules": cp.world.rules.model_dump(mode="json"),
        "settings": {
            "default_model_key": settings.default_model_key,
            "model_overrides": settings.model_overrides,
            "max_rounds": settings.max_rounds,
            "play_delay_seconds": settings.play_delay_seconds,
            "real_budget_usd": settings.real_budget_usd,
            "context": settings.context.model_dump(mode="json"),
            "context_override_agents": sorted(settings.context_overrides),
        },
        "map": {"region": cp.world.map.region.model_dump(mode="json")},
    }
    return ToolResult("get_rules_and_settings", args, True, payload, f"rules and settings of {run_id} at {cp.turn.turn_id}", sources=[f"turns {cp.turn.turn_id}"])


def _list_turns(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    run_id = _require_run(args)
    from_round = _i(args, "from_round", None, 0, 10**6)
    to_round = _i(args, "to_round", None, 0, 10**6)
    limit = _i(args, "limit", 60, 1, 200) or 60
    entries = storage.list_turns(run_id, from_round, to_round)
    tail = entries[-limit:]
    payload = {
        "total": len(entries),
        "shown": len(tail),
        "turns": [
            {"turn_id": e.turn_id, "kind": e.kind, "round": e.round, "actor": e.acting_agent_id, "action": e.action_name, "ok": e.ok, "source": e.decision_source, "interventions": e.intervention_count}
            for e in tail
        ],
    }
    return ToolResult("list_turns", args, True, payload, f"{len(entries)} turns ({len(tail)} shown)", sources=[f"turns {run_id}"])


def _get_turn_digest(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    run_id = _require_run(args)
    turn_id = _s(args, "turn_id")
    if not turn_id:
        raise ToolError("turn_id is required")
    if turn_id == "live":
        turn_id = current_turn_id(service, run_id)
    try:
        payload = digest.turn_digest(run_id, turn_id)
    except NotImplementedError:
        payload = basic_turn_summary(run_id, turn_id)
    return ToolResult("get_turn_digest", args, True, payload, f"turn {turn_id}", sources=[f"turns {turn_id}"])


def _get_round_digest(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    run_id = _require_run(args)
    round_no = _i(args, "round", None, 0, 10**6)
    if round_no is None:
        raise ToolError("round is required")
    detail = _s(args, "detail", "normal") or "normal"
    payload = digest.round_digest(run_id, round_no, detail=detail)
    return ToolResult("get_round_digest", args, True, payload, f"round {round_no}", sources=[f"turns round {round_no}"])


def _get_trends(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    run_id = _require_run(args)
    n = _i(args, "last_n_rounds", 5, 1, 50) or 5
    payload = digest.trends(run_id, n)
    return ToolResult("get_trends", args, True, payload, f"trends over {n} rounds", sources=[f"run {run_id}"])


def _get_agent_dossier(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    run_id = _require_run(args)
    agent_id = _s(args, "agent_id")
    if not agent_id:
        raise ToolError("agent_id is required")
    turn_id = _s(args, "turn_id")
    if turn_id == "live":
        turn_id = None
    payload = digest.agent_dossier(run_id, agent_id, turn_id)
    return ToolResult("get_agent_dossier", args, True, payload, f"dossier of {agent_id}", sources=[f"entity {agent_id}"])


SEARCH_EVENTS_MAX_TURNS = 2000  # turns scanned per call (a whole long run fits)
SEARCH_EVENTS_SUMMARY_CHARS = 200


def _search_events(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    """Every matching event of the range is counted (``total_matches``, ``counts_by_kind``,
    ``counts_by_round``); the newest ``limit`` are listed in commit order.  When the list is cut
    (by ``limit`` or to fit the output cap) ``truncated_after`` is the number listed, so the
    model counts from the totals, never from a capped list.  Unknown turn ids are an error
    (they used to widen the range silently)."""
    run_id = _require_run(args)
    kinds_raw = args.get("kinds")
    kinds = {str(k) for k in kinds_raw} if isinstance(kinds_raw, list) else ({str(kinds_raw)} if kinds_raw else set())
    actor = _s(args, "actor")
    text = (_s(args, "text") or "").lower()
    from_turn = _s(args, "from_turn")
    to_turn = _s(args, "to_turn")
    from_round = _i(args, "from_round", None, 0, 10**6)
    to_round = _i(args, "to_round", None, 0, 10**6)
    limit = _i(args, "limit", 30, 1, 50) or 30
    entries = storage.list_turns(run_id)
    ids = [e.turn_id for e in entries]
    for key, value in (("from_turn", from_turn), ("to_turn", to_turn)):
        if value and value not in ids:
            raise ToolError(f"{key} {value!r} is not a committed turn of {run_id}; use from_round/to_round for a round range")
    start = ids.index(from_turn) if from_turn else 0
    end = ids.index(to_turn) + 1 if to_turn else len(ids)
    window = [e for e in entries[start:end] if (from_round is None or e.round >= from_round) and (to_round is None or e.round <= to_round)]
    scan_capped = len(window) > SEARCH_EVENTS_MAX_TURNS
    window = window[-SEARCH_EVENTS_MAX_TURNS:]
    matches: list[dict[str, Any]] = []
    by_kind: dict[str, int] = {}
    by_round: dict[str, int] = {}
    for entry in reversed(window):
        for event in reversed(storage.read_turn_events(run_id, entry.turn_id)):
            if kinds and event.kind not in kinds:
                continue
            if actor and event.actor != actor:
                continue
            if text and text not in (event.summary or "").lower() and text not in json.dumps(event.details, default=str).lower():
                continue
            by_kind[event.kind] = by_kind.get(event.kind, 0) + 1
            by_round[str(event.round)] = by_round.get(str(event.round), 0) + 1
            if len(matches) < limit:
                summary = event.summary or ""
                if len(summary) > SEARCH_EVENTS_SUMMARY_CHARS:
                    summary = summary[: SEARCH_EVENTS_SUMMARY_CHARS - 1] + "…"
                matches.append({"seq": event.seq, "turn_id": event.turn_id, "round": event.round, "actor": event.actor, "kind": event.kind, "summary": summary})
    matches.reverse()
    total = sum(by_kind.values())
    payload: dict[str, Any] = {
        "total_matches": total,
        "counts_by_kind": dict(sorted(by_kind.items())),
        "counts_by_round": dict(sorted(by_round.items(), key=lambda kv: int(kv[0]))),
        "matches": matches,
        "turns_in_range": len(window),
        "rounds": [window[0].round, window[-1].round] if window else None,
        "limit": limit,
    }
    if scan_capped:
        payload["note_scan"] = f"only the newest {SEARCH_EVENTS_MAX_TURNS} turns of the range were scanned; narrow the range"
    # keep the totals: drop the oldest listed matches until the payload fits the output cap
    budget = config.ASSISTANT_TOOL_OUTPUT_MAX_CHARS - 200
    while matches and len(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)) > budget:
        matches.pop(0)
    if len(matches) < total:
        payload["truncated_after"] = len(matches)
        payload["note"] = f"{total} events match; only the newest {len(matches)} are listed. Count with total_matches / counts_by_round, not by counting the list."
    return ToolResult("search_events", args, True, payload, f"{total} events" + (f" ({len(matches)} listed)" if len(matches) < total else ""), sources=[f"turns {t['turn_id']}" for t in matches[-5:]])


def _get_model_call(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    run_id = _require_run(args)
    turn_id = _s(args, "turn_id")
    call_id = _s(args, "call_id")
    if not turn_id:
        raise ToolError("turn_id is required")
    if not call_id:
        cp = committed_checkpoint(service, run_id, None if turn_id == "live" else turn_id)
        ids = cp.turn.model_call_ids
        if not ids:
            raise ToolError(f"turn {turn_id} has no model calls")
        call_id = ids[-1]
    record = service.manager.model_call(run_id, turn_id, call_id)
    result = record.result
    excerpt = None
    if result is not None and result.text:
        excerpt = result.text[:800] + ("…" if len(result.text) > 800 else "")
    payload = {
        "call_id": record.call_id,
        "turn_id": record.turn_id,
        "agent_id": record.agent_id,
        "model_key": record.model_key,
        "status": record.status,
        "error": model.redact(record.error, service.registry),
        "result": None
        if result is None
        else {
            "status": result.status,
            "error": result.error,
            "error_code": result.error_code,
            "attempts": result.attempts,
            "latency_ms": result.latency_ms,
            "usage": result.usage.model_dump(mode="json"),
            "provider_cost_usd": result.provider_cost_usd,
            "stop_reason": result.stop_reason,
            "reply_excerpt": excerpt,
            "parsed": result.parsed,
        },
        "charged_compute": record.charged_compute,
    }
    return ToolResult("get_model_call", args, True, payload, f"model call {call_id}", sources=[f"turns {record.turn_id}"])


def _get_decision_packet_summary(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    run_id = _require_run(args)
    turn_id = _s(args, "turn_id")
    if not turn_id:
        raise ToolError("turn_id is required")
    view = service.manager.turn_view(run_id, turn_id)
    if not view.decision_packet_ids:
        raise ToolError(f"turn {turn_id} has no decision packet")
    packet_id = _s(args, "packet_id") or view.decision_packet_ids[-1]
    packet = service.manager.decision_packet(run_id, turn_id, packet_id)
    payload = {
        "packet_id": packet.packet_id,
        "turn_id": packet.turn_id,
        "agent_id": packet.agent_id,
        "sections": [_jsonable(s) for s in packet.sections][:20],
        "selected_records": len(packet.selected_record_ids),
        "digest_records": len(packet.digest_record_ids),
        "omitted_counts": packet.omitted_counts,
        "input_token_estimate": packet.input_token_estimate,
        "generation_allowance": packet.generation_allowance,
        "affordable": packet.affordable,
        "unaffordable_reason": packet.unaffordable_reason,
        "notebook_version": packet.notebook_version,
    }
    return ToolResult("get_decision_packet_summary", args, True, payload, f"packet {packet_id}", sources=[f"turns {packet.turn_id}"])


def _get_staged_interventions(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    run_id = _require_run(args)
    worker = service.manager.get(run_id)
    staged = worker.staged() if worker is not None else storage.read_staged_edits(run_id).interventions
    payload = {"open": worker is not None, "staged": [_jsonable(iv) for iv in staged]}
    return ToolResult("get_staged_interventions", args, True, payload, f"{len(staged)} staged edits", sources=[f"run {run_id}"])


def _get_storybook(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    run_id = _require_run(args)
    last_n = _i(args, "last_n", 10, 1, 50) or 10
    if service.storybook is not None and hasattr(service.storybook, "view"):
        view = service.storybook.view(run_id, last_n)
        payload = {
            "status": _jsonable(view.status),
            "opening": view.opening.text if view.opening else None,
            "entries": [{"turn_id": e.turn_id, "kind": e.kind, "round": e.round, "text": e.text} for e in view.entries[-last_n:]],
        }
    else:
        folder = service.paths.storybook_entries_dir(run_id)
        entries: list[dict[str, Any]] = []
        opening = None
        if folder.is_dir():
            order = {e.turn_id: i for i, e in enumerate(storage.list_turns(run_id))}
            for path in folder.glob("*.json"):
                try:
                    raw = storage.read_json(path)
                except storage.StorageError:
                    continue
                if path.stem == "opening":
                    opening = raw.get("text") if isinstance(raw, dict) else None
                elif isinstance(raw, dict):
                    entries.append(raw)
            entries.sort(key=lambda e: order.get(str(e.get("turn_id")), 10**9))
        payload = {
            "status": {"note": "storybook service not attached; entries read from disk"},
            "opening": opening,
            "entries": [{"turn_id": e.get("turn_id"), "kind": e.get("kind"), "round": e.get("round"), "text": e.get("text")} for e in entries[-last_n:]],
        }
    return ToolResult("get_storybook", args, True, payload, f"{len(payload['entries'])} storybook entries", sources=[f"storybook {run_id}"])


def _search_docs(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    query = _s(args, "query") or ""
    if not query.strip():
        raise ToolError("query is required")
    limit = _i(args, "limit", 5, 1, 10) or 5
    if service.knowledge is None:
        raise ToolError("documentation is not loaded")
    sections = service.knowledge.search(query, limit=limit)
    payload = {"sections": [{"ref": s.ref, "heading": s.heading, "text": s.text[:2500]} for s in sections]}
    return ToolResult("search_docs", args, True, payload, f"{len(sections)} doc sections", sources=[f"docs {s.ref}" for s in sections])


def _get_defaults(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    count = _i(args, "agent_count", 8, config.MIN_AGENTS, config.MAX_AGENTS) or 8
    request = config.default_run_request(config.operator_default_model_key(service.registry), count)
    payload = {
        "name": request.name,
        "seed": request.seed,
        "default_model_key": request.default_model_key,
        "play_delay_seconds": request.play_delay_seconds,
        "max_rounds": request.max_rounds,
        "real_budget_usd": request.real_budget_usd,
        "world": request.world.model_dump(mode="json"),
        "rules": request.rules.model_dump(mode="json"),
        "context": request.context.model_dump(mode="json"),
        "agents": [{"id": c.id, "name": c.name, "position": c.position.model_dump(mode="json"), "stats": c.stats.model_dump(mode="json"), "model_key": c.model_key} for c in request.agents],
    }
    return ToolResult("get_defaults", args, True, payload, f"defaults for {count} agents", sources=["docs defaults"])


def _get_server_log(service: "AssistantService", args: dict[str, Any]) -> ToolResult:
    tail = _i(args, "tail", 100, 1, 500) or 100
    grep = _s(args, "grep")
    if service.logbuffer is None:
        raise ToolError("server log buffer is not installed")
    lines = service.logbuffer.tail(tail, grep, max_chars=config.SERVER_LOG_TAIL_MAX_CHARS - 200)
    payload = {"lines": lines, "count": len(lines), "grep": grep}
    return ToolResult("get_server_log", args, True, payload, f"{len(lines)} log lines", sources=["server log"])


_TOOLS: dict[str, Callable[["AssistantService", dict[str, Any]], ToolResult]] = {
    "list_runs": _list_runs,
    "get_run_status": _get_run_status,
    "get_rules_and_settings": _get_rules_and_settings,
    "list_turns": _list_turns,
    "get_turn_digest": _get_turn_digest,
    "get_round_digest": _get_round_digest,
    "get_trends": _get_trends,
    "get_agent_dossier": _get_agent_dossier,
    "search_events": _search_events,
    "get_model_call": _get_model_call,
    "get_decision_packet_summary": _get_decision_packet_summary,
    "get_staged_interventions": _get_staged_interventions,
    "get_storybook": _get_storybook,
    "search_docs": _search_docs,
    "get_defaults": _get_defaults,
    "get_server_log": _get_server_log,
}

_RUN = {"run_id": {"type": "string", "description": "run id (run_...)"}}

_CATALOGUE: list[dict[str, Any]] = [
    {"name": "list_runs", "description": "Runs on disk (name, status, rounds, agents, model), newest first. Archived runs are left out unless archived is \"1\" (archived only) or \"all\".", "params": {"limit": {"type": "integer", "default": 20}, "archived": {"type": "string", "default": "0"}}},
    {"name": "get_run_status", "description": "Live status of a run (state, current turn, next step, living agents, staged edits, last error, real spend); 'open: false' with the saved summary when the run is not open.", "params": {**_RUN}},
    {"name": "get_rules_and_settings", "description": "The run's rule numbers (prices, upgrades, plants, death ...) and settings (models, max_rounds, play delay, real budget, context) at the committed turn.", "params": {**_RUN, "turn_id": {"type": "string", "description": "optional committed turn; default current"}}},
    {"name": "list_turns", "description": "Committed turns in order with actor, action name, ok flag and decision source; optional round range; newest 'limit' shown.", "params": {**_RUN, "from_round": {"type": "integer"}, "to_round": {"type": "integer"}, "limit": {"type": "integer", "default": 60}}},
    {"name": "get_turn_digest", "description": "What happened in one turn: actor, decision source, action and result, thought (a belief), events, deaths, messages, whether the turn was lost.", "params": {**_RUN, "turn_id": {"type": "string", "description": "turn id or 'live'"}}},
    {"name": "get_round_digest", "description": "Summary of one round: order, actions by agent, deaths and kills, resources, notable events; counts.lost_turns = turns lost to malformed, refused or failed model replies in that round (absent = 0).", "params": {**_RUN, "round": {"type": "integer"}, "detail": {"type": "string", "enum": ["brief", "normal", "full"], "default": "normal"}}},
    {"name": "get_trends", "description": "Population, compute/essence totals, deaths and messages per round over the last N rounds.", "params": {**_RUN, "last_n_rounds": {"type": "integer", "default": 5}}},
    {"name": "get_agent_dossier", "description": "One agent: operator truth (stats, position, alive, kills) and its own beliefs (notebook, believed self), labelled separately; optional turn.", "params": {**_RUN, "agent_id": {"type": "string"}, "turn_id": {"type": "string"}}},
    {"name": "search_events", "description": "Filter committed events by kinds (death, damage, message_delivered, decision_invalid, model_call_failed, intervention ...), actor, text and a round or turn range. Returns total_matches, counts_by_kind and counts_by_round over the WHOLE range, plus the newest 'limit' matches (truncated_after = how many are listed when cut).", "params": {**_RUN, "kinds": {"type": "array", "items": {"type": "string"}}, "actor": {"type": "string"}, "text": {"type": "string"}, "from_round": {"type": "integer"}, "to_round": {"type": "integer"}, "from_turn": {"type": "string", "description": "an exact committed turn id"}, "to_turn": {"type": "string", "description": "an exact committed turn id"}, "limit": {"type": "integer", "default": 30}}},
    {"name": "get_model_call", "description": "A model call record of a turn: status, error and error code, attempts, usage, cost and an excerpt of the (possibly rejected) reply.", "params": {**_RUN, "turn_id": {"type": "string"}, "call_id": {"type": "string", "description": "optional; default the turn's last call"}}},
    {"name": "get_decision_packet_summary", "description": "What the agent was shown for its decision: packet sections, record counts, omissions, token estimate, affordability.", "params": {**_RUN, "turn_id": {"type": "string"}, "packet_id": {"type": "string"}}},
    {"name": "get_staged_interventions", "description": "God-mode edits staged for the next turn (with origin 'assistant' for approved briefs).", "params": {**_RUN}},
    {"name": "get_storybook", "description": "The run's storybook: status and the last N narrative entries.", "params": {**_RUN, "last_n": {"type": "integer", "default": 10}}},
    {"name": "search_docs", "description": "Search the documentation sections by keywords (how the simulation works, controls, glossary, assistant).", "params": {"query": {"type": "string"}, "limit": {"type": "integer", "default": 5}}},
    {"name": "get_defaults", "description": "The default run request for N agents (world, rules, context, agent cards): the base a create_run overlay merges onto.", "params": {"agent_count": {"type": "integer", "default": 8}}},
    {"name": "get_server_log", "description": "The last lines of the backend log (redacted), optionally filtered by a regex.", "params": {"tail": {"type": "integer", "default": 100}, "grep": {"type": "string"}}},
]


def tool_catalogue() -> list[dict[str, Any]]:
    """[{name, description, params (JSON schema properties)}] in a stable order (part of the system prompt)."""
    return [dict(entry) for entry in _CATALOGUE]


def tool_catalogue_text() -> str:
    """Byte-stable rendering for the system prompt (sorted keys, one tool per block); the engine
    uses ``prompts.tool_catalogue_text(tool_catalogue())`` but this stays for scripts."""
    lines: list[str] = []
    for entry in _CATALOGUE:
        params = json.dumps(entry["params"], sort_keys=True, separators=(",", ":"))
        lines.append(f"- {entry['name']}: {entry['description']}\n  args: {params}")
    return "\n".join(lines)


def run_tool(service: "AssistantService", name: str, args: dict[str, Any]) -> ToolResult:
    """Dispatch one tool call; never raises (errors become ``ToolResult(ok=False)`` with an
    ``{"error": ...}`` payload the model can act on).  Every payload is capped."""
    args = dict(args or {})
    fn = _TOOLS.get(name)
    if fn is None:
        return ToolResult(name, args, False, {"error": f"unknown tool {name!r}; known tools: {', '.join(TOOL_NAMES)}"}, f"unknown tool {name}")
    try:
        result = fn(service, args)
    except ToolError as exc:
        return ToolResult(name, args, False, {"error": str(exc)}, f"{name}: {exc}")
    except NotImplementedError as exc:
        return ToolResult(name, args, False, {"error": f"{name} is not available in this build ({exc})"}, f"{name}: not available")
    except RunnerError as exc:
        message = str(exc)
        if message.startswith("run_not_open"):
            message = "run not open in this process; only history reads work until it is opened"
        return ToolResult(name, args, False, {"error": message}, f"{name}: {message}")
    except storage.StorageError as exc:
        return ToolResult(name, args, False, {"error": model.redact(f"not found: {exc}", service.registry)}, f"{name}: not found")
    except Exception as exc:  # noqa: BLE001 - a tool bug must not kill the step loop
        log.exception("tool %s failed", name)
        return ToolResult(name, args, False, {"error": model.redact(f"{type(exc).__name__}: {exc}", service.registry)}, f"{name}: failed")
    payload, truncated = cap_payload(result.payload)
    result.payload = payload
    result.truncated = truncated
    if truncated:
        result.summary = f"{result.summary} (truncated)"
    return result


__all__ = ["TOOL_NAMES", "ToolError", "ToolResult", "basic_turn_summary", "cap_payload", "committed_checkpoint", "current_turn_id", "run_status_payload", "run_tool", "tool_catalogue", "tool_catalogue_text"]
