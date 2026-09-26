"""
Deterministic digests of run history (rev 4): compact, model-free summaries that the read tools,
the storybook narrator and Story Mode all build on.  Everything here is READ-ONLY and computed
from committed storage only:

* ``storage.list_turns`` (commit order; never a directory listing) and ``storage.read_turn_events``;
* ``turns/<id>/state.json`` (TurnRecord) through a narrow cached reader;
* ``turns/<id>/entities/agents/<id>.json`` (authoritative agent state), ``settings.json`` (model
  keys), ``map.json`` / ``entities/plants.json`` (the opening only);
* ``model_calls/index.json`` summaries, and for the agent dossier only, the agent's LAST decision
  packet (believed self) and model-call record (notebook update).

Knowledge files (``entities/knowledge``) are never read here.  A digest never invents intent:
agent thoughts are the agent's own words and are labelled as beliefs, killers come from
``damage`` events (or the attacker's ``effects.killed``), lost / skipped turns are stated as such.
Continuations follow ``manifest.parent``: history before the fork is read from the parent run.

Public API (every function raises ``storage.StorageError`` for an unknown run or turn and
``ValueError`` for a malformed turn id):

* ``turn_digest(run_id, turn_id, *, max_chars)`` - one committed turn (agent turn, round end or init).
* ``round_digest(run_id, round_no, *, detail)`` / ``last_round_digest(run_id)``.
* ``trends(run_id, last_n_rounds)`` - per-round series and first-to-last deltas.
* ``agent_dossier(run_id, agent_id, turn_id)`` - operator truth vs the agent's belief, labelled.
* ``search_events(run_id, *, kinds, actor, text, from_turn_id, to_turn_id, limit)``.
* ``get_highlights(run_id, *, from_turn_id, to_turn_id, limit)`` - salience ranked:
  deaths > attacks > messages > skill saves > upgrades > failed actions.
* ``opening_digest(run_id)`` - setting and cast of the run's first turn (storybook opening).
* ``cast_map(run_id, turn_id)`` - ``[{id, name, alive}]`` at a turn (the narrator's name table).
* Round-end digests carry names next to ids: ``living`` / ``upkeep_short`` are ``[{id, name}]``,
  ``starvation`` is ``[{id, name, health_after}]`` and ``text`` names the survivors.
* ``run_card(run_id)`` - Story Mode step 0; ``timeline(run_id)`` - lineage-aware turn list.
* ``digest_sha(payload)`` - stable short hash of a digest.  OWNER: WP3.
"""
# DOCS: digests are the single source for "what happened" text in tools, storybook and story;
# every number in them comes from stored events / records, never from a model; thoughts are beliefs.

from __future__ import annotations

import hashlib
import json
import threading
from collections import Counter, OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

from .. import storage
from ..schemas import Event, Manifest, TurnId, TurnIndexEntry, TurnRecord
from .models import CastMember, StoryQuickPicks, StoryRunCard

# ---------------------------------------------------------------------------
# Limits (characters) for compact output
# ---------------------------------------------------------------------------

THOUGHT_MAX_CHARS = 600
MESSAGE_MAX_CHARS = 600
SUMMARY_MAX_CHARS = 160
PERSONA_MAX_CHARS = 240
NOTEBOOK_MAX_CHARS = 400
LIVE_TURN_ALIASES = ("live", "latest", "current")

THINKING_KINDS = ("model_call_completed", "model_call_failed", "cognition_charged")
NOTABLE_KINDS = ("error", "decision_invalid", "model_call_failed", "starvation", "skill_error", "skill_rejected", "resource_skip")

# Highlight salience (A-AST: deaths > attacks > messages > skill saves > upgrades > failed actions).
SALIENCE = {
    "death": 100,
    "attack": 80,
    "message": 60,
    "plant_attack": 50,
    "skill_saved": 40,
    "upgrade": 30,
    "failed_action": 20,
    "lost_turn": 15,
}


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _num(value: Any) -> Any:
    """Round floats to 1 decimal for compact output (ints stay ints)."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        rounded = round(value, 1)
        return int(rounded) if rounded == int(rounded) else rounded
    return value


def _clip(text: Any, limit: int) -> str:
    s = " ".join(str(text or "").split()) if limit <= SUMMARY_MAX_CHARS else str(text or "").strip()
    return s if len(s) <= limit else s[: max(0, limit - 1)].rstrip() + "…"


def _compact_json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def digest_sha(payload: Any) -> str:
    """Stable sha256 prefix (16 hex) of a digest (``StorybookEntry.digest_sha``)."""
    return hashlib.sha256(_compact_json(payload).encode("utf-8")).hexdigest()[:16]


def _check_turn_id(turn_id: str) -> str:
    if not isinstance(turn_id, str) or not turn_id or "/" in turn_id or "\\" in turn_id or turn_id.startswith("."):
        raise ValueError(f"bad turn id: {turn_id!r}")
    TurnId.parse(turn_id)  # raises ValueError
    return turn_id


def _is_empty(value: Any, drop_zero: bool) -> bool:
    if value is None or value is False:
        return True
    if isinstance(value, (list, dict, str, tuple)) and not value:
        return True
    return drop_zero and isinstance(value, (int, float)) and not isinstance(value, bool) and value == 0


def _drop_empty(d: dict[str, Any], *, drop_zero: bool = False) -> dict[str, Any]:
    """Drop None / False / empty containers (and zeros with ``drop_zero``); ``ok`` and ``alive``
    are always kept."""
    return {k: v for k, v in d.items() if k in ("ok", "alive") or not _is_empty(v, drop_zero)}


# ---------------------------------------------------------------------------
# Narrow cached readers (committed turn dirs are immutable; the cache key carries the
# state.json mtime so a directory rewritten by recovery is never served stale)
# ---------------------------------------------------------------------------

_CACHE_MAX = 4096
_cache: "OrderedDict[tuple[Any, ...], Any]" = OrderedDict()
_cache_lock = threading.Lock()


def _cached(key: tuple[Any, ...], build: Any) -> Any:
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    value = build()
    with _cache_lock:
        _cache[key] = value
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)
    return value


def clear_cache() -> None:
    """Drop every cached turn (tests; never needed for correctness)."""
    with _cache_lock:
        _cache.clear()


def _turn_dir(rdir: Path, turn_id: str) -> Path:
    return rdir / storage.TURNS_DIR / _check_turn_id(turn_id)


def _stamp(path: Path) -> tuple[int, int]:
    try:
        st = path.stat()
    except OSError:
        raise storage.StorageError(f"{path.parent.name}: turn not found") from None
    return (st.st_mtime_ns, st.st_size)


def _load_record(rdir: Path, turn_id: str) -> TurnRecord:
    path = _turn_dir(rdir, turn_id) / storage.STATE_FILE
    stamp = _stamp(path)
    return _cached(("record", str(rdir), turn_id, stamp), lambda: TurnRecord.model_validate(storage.read_json(path)))


def _load_events(run_id: str, rdir: Path, turn_id: str) -> list[Event]:
    stamp = _stamp(_turn_dir(rdir, turn_id) / storage.STATE_FILE)
    return _cached(("events", str(rdir), turn_id, stamp), lambda: storage.read_turn_events(run_id, turn_id))


def _load_agents(rdir: Path, turn_id: str) -> dict[str, dict[str, Any]]:
    """Raw agent dicts of a turn (``entities/agents/*.json``), in id order."""
    tdir = _turn_dir(rdir, turn_id)
    stamp = _stamp(tdir / storage.STATE_FILE)

    def build() -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        adir = tdir / storage.ENTITIES_DIR / storage.AGENTS_SUBDIR
        if adir.is_dir():
            for path in sorted(adir.glob("*.json")):
                try:
                    data = storage.read_json(path)
                except storage.StorageError:
                    continue
                if isinstance(data, dict) and isinstance(data.get("id"), str):
                    out[data["id"]] = data
        return out

    return _cached(("agents", str(rdir), turn_id, stamp), build)


def _load_settings(rdir: Path, turn_id: str) -> dict[str, Any]:
    tdir = _turn_dir(rdir, turn_id)
    stamp = _stamp(tdir / storage.STATE_FILE)

    def build() -> dict[str, Any]:
        path = tdir / storage.SETTINGS_FILE
        try:
            data = storage.read_json(path)
        except storage.StorageError:
            return {}
        return data if isinstance(data, dict) else {}

    return _cached(("settings", str(rdir), turn_id, stamp), build)


def _load_call_summaries(rdir: Path, turn_id: str) -> list[dict[str, Any]]:
    path = _turn_dir(rdir, turn_id) / storage.MODEL_CALLS_DIR / "index.json"
    try:
        data = storage.read_json(path)
    except storage.StorageError:
        return []
    return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []


def _read_optional_json(path: Path) -> Any:
    try:
        return storage.read_json(path)
    except storage.StorageError:
        return None


# ---------------------------------------------------------------------------
# Lineage-aware timeline (continuations follow manifest.parent)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TurnRef:
    """One committed turn of a run's lineage: ``run_id`` is the run that holds the turn dir."""

    run_id: str
    rdir: Path
    entry: TurnIndexEntry

    @property
    def turn_id(self) -> str:
        """The committed turn id."""
        return self.entry.turn_id

    @property
    def round(self) -> int:
        """The turn's round."""
        return self.entry.round


def _manifest(run_id: str) -> Manifest:
    return storage.read_manifest(run_id)


def timeline(run_id: str, *, include_parent: bool = True, _depth: int = 0) -> list[TurnRef]:
    """Committed turns in commit order.  For a continuation (``manifest.parent``) the parent's
    turns up to and including the fork turn come first (recursively) and the continuation's
    own copy of the fork turn is dropped; ``include_parent=False`` returns only this run's turns."""
    rdir = storage.find_run_dir(run_id)
    manifest = _manifest(run_id)
    own = [TurnRef(run_id, rdir, e) for e in storage.list_turns(run_id)]
    if not include_parent or manifest.parent is None or _depth > 16:
        return own
    try:
        parent_refs = timeline(manifest.parent.run_id, include_parent=True, _depth=_depth + 1)
    except storage.StorageError:
        return own
    fork = manifest.parent.turn_id
    cut = [r for r in parent_refs]
    for i, ref in enumerate(parent_refs):
        if ref.turn_id == fork and ref.run_id == manifest.parent.run_id:
            cut = parent_refs[: i + 1]
            break
    rest = own[1:] if own and own[0].turn_id == fork else own
    return cut + rest


def own_turns(run_id: str) -> list[TurnRef]:
    """This run's committed turns, WITHOUT the copied fork turn of a continuation (what the
    storybook narrates for this run)."""
    manifest = _manifest(run_id)
    own = timeline(run_id, include_parent=False)
    if manifest.parent is not None and own and own[0].turn_id == manifest.parent.turn_id:
        return own[1:]
    return own


def _resolve(run_id: str, turn_id: Optional[str]) -> TurnRef:
    """The TurnRef of ``turn_id`` in the run's lineage (``None``/``live``/``latest`` = the
    run's current committed turn)."""
    if turn_id is None or turn_id in LIVE_TURN_ALIASES:
        turn_id = _manifest(run_id).current_turn_id
    _check_turn_id(turn_id)
    refs = timeline(run_id)
    for ref in reversed(refs):
        if ref.turn_id == turn_id:
            # the continuation's own copy of the fork turn is the same content; prefer this run's dir
            if ref.run_id != run_id:
                own = [r for r in timeline(run_id, include_parent=False) if r.turn_id == turn_id]
                if own:
                    return own[0]
            return ref
    raise storage.StorageError(f"turn {turn_id} is not a committed turn of run {run_id}")


def _range(refs: list[TurnRef], from_turn_id: Optional[str], to_turn_id: Optional[str]) -> list[TurnRef]:
    ids = [r.turn_id for r in refs]
    start = 0
    end = len(refs)
    if from_turn_id is not None:
        if from_turn_id not in ids:
            raise storage.StorageError(f"turn {from_turn_id} is not a committed turn")
        start = ids.index(from_turn_id)
    if to_turn_id is not None and to_turn_id not in LIVE_TURN_ALIASES:
        if to_turn_id not in ids:
            raise storage.StorageError(f"turn {to_turn_id} is not a committed turn")
        end = len(ids) - ids[::-1].index(to_turn_id)
    return refs[start:end]


def _previous_agents(ref: TurnRef, record: TurnRecord, run_id: str) -> dict[str, dict[str, Any]]:
    """Agents of the previous committed turn (for before/after deltas); {} when unknown."""
    prev = record.previous_turn_id
    if not prev:
        return {}
    try:
        return _load_agents(ref.rdir, prev)
    except (storage.StorageError, ValueError):
        pass
    try:
        prev_ref = _resolve(run_id, prev)
        return _load_agents(prev_ref.rdir, prev)
    except (storage.StorageError, ValueError):
        return {}


# ---------------------------------------------------------------------------
# Naming and phrasing (mirrors frontend turnStory.ts so the storybook and Turn record agree)
# ---------------------------------------------------------------------------


class _Namer:
    def __init__(self, agents: dict[str, dict[str, Any]]) -> None:
        self.agents = agents

    def __call__(self, entity_id: Any) -> str:
        if not isinstance(entity_id, str):
            return str(entity_id)
        agent = self.agents.get(entity_id)
        if agent and agent.get("name"):
            return f"{agent['name']} ({entity_id})"
        return entity_id

    def name(self, entity_id: Any) -> Optional[str]:
        """The agent's name, or None for a non-agent / unknown id."""
        agent = self.agents.get(entity_id) if isinstance(entity_id, str) else None
        return agent.get("name") if agent else None


def _point(value: Any) -> str:
    if isinstance(value, dict) and "x" in value and "y" in value:
        return f"({value['x']},{value['y']})"
    return str(value)


def _action_phrase(name: str, args: dict[str, Any], who: _Namer) -> str:
    a = args if isinstance(args, dict) else {}
    phrases = {
        "move": lambda: f"moved {a.get('direction')}",
        "observe": lambda: f"observed {_point(a.get('point'))}",
        "query": lambda: f"queried {who(a.get('entity'))}",
        "send": lambda: f"sent a message to {who(a.get('recipient'))}",
        "broadcast": lambda: "broadcast a message",
        "absorb": lambda: f"absorbed {a.get('resource')} from {who(a.get('source'))}",
        "transfer": lambda: f"transferred {_num(a.get('amount'))} {a.get('resource')} to {who(a.get('recipient'))}",
        "recover": lambda: f"recovered health with a budget of {_num(a.get('compute_budget'))} compute",
        "attack": lambda: f"attacked {who(a.get('target'))} with a budget of {_num(a.get('compute_budget'))} compute",
        "upgrade": lambda: f"upgraded {a.get('attribute')}",
        "wait": lambda: f"waited {_num(a.get('rounds'))} round(s)",
        "run_skill": lambda: f"ran skill {a.get('skill')}",
    }
    fn = phrases.get(name)
    return fn() if fn else f"did {name}"


def _headline_effect(effects: dict[str, Any], who: _Namer) -> Optional[str]:
    e = effects or {}
    if "gained" in e:
        return f"gained {_num(e.get('gained'))} {e.get('resource')}"
    if "damage" in e:
        killed = f", killed {who(e.get('target'))}" if e.get("killed") else ""
        return f"dealt {_num(e.get('damage'))} damage{killed}"
    if "healed" in e:
        return f"healed {_num(e.get('healed'))}"
    if isinstance(e.get("to"), dict):
        return f"now at {_point(e.get('to'))}"
    if "transferred" in e:
        return f"gave {_num(e.get('transferred'))} {e.get('resource')}"
    if "purchased" in e:
        return f"{e.get('purchased')} now {_num(e.get('new_value'))}"
    return None


NO_ACTION = {
    "skipped_unaffordable": "was skipped: it could not afford to think (not enough compute for the minimum decision packet)",
    "skipped_dead": "was skipped: it is dead",
    "skipped_removed": "was skipped: it was removed from the world",
    "wait": "kept waiting (a wait action from an earlier turn)",
    "skill": "continued its skill without a world action",
}


def _decision_problem(events: list[Event]) -> Optional[str]:
    for kind, key in (("decision_invalid", "reason"), ("model_call_failed", "error"), ("resource_skip", "reason")):
        for e in events:
            if e.kind == kind:
                value = e.details.get(key)
                return _clip(value if isinstance(value, str) and value else e.summary, 200)
    return None


def _no_action_phrase(source: str, events: list[Event]) -> str:
    if source == "model":
        if any(e.kind == "decision_invalid" for e in events):
            return "made no valid decision, so nothing happened (the turn was lost)"
        if any(e.kind == "model_call_failed" for e in events):
            return "got no usable answer from its model, so nothing happened (the turn was lost)"
        return "took no action"
    return NO_ACTION.get(source, "took no action")


def _compact_effects(effects: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in (effects or {}).items():
        if key in ("delivered_visible",) and isinstance(value, list):
            out[key] = len(value)
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            out[key] = _num(value)
        elif isinstance(value, (str, bool)) or value is None:
            out[key] = value
        elif isinstance(value, dict) and "x" in value:
            out[key] = [value.get("x"), value.get("y")]
        else:
            out[key] = value
    return out


def _compact_args(name: str, args: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in (args or {}).items():
        if key == "message" and name in ("send", "broadcast"):
            continue  # the text is in the digest's messages[]
        elif isinstance(value, dict) and "x" in value and "y" in value:
            out[key] = [value.get("x"), value.get("y")]
        elif isinstance(value, float):
            out[key] = _num(value)
        else:
            out[key] = value
    return out


# ---------------------------------------------------------------------------
# Per-turn facts shared by digests, highlights, round stats and trends
# ---------------------------------------------------------------------------


def _deaths(events: list[Event], record: TurnRecord) -> list[dict[str, Any]]:
    """Death facts with the killer attributed from the same turn's damage event (or the
    attacker's effects.killed); residue from residue_created."""
    residues = {e.details.get("residue_id"): e.details for e in events if e.kind == "residue_created"}
    out: list[dict[str, Any]] = []
    for e in events:
        if e.kind != "death":
            continue
        victim = e.details.get("entity_id")
        cause = e.details.get("cause")
        by: Optional[str] = None
        if cause == "attack":
            for d in events:
                if d.kind == "damage" and d.details.get("target") == victim and d.actor not in ("world", "operator", "system"):
                    by = d.actor
            if by is None and record.action_result is not None:
                eff = record.action_result.effects or {}
                if eff.get("killed") and eff.get("target") == victim:
                    by = record.acting_agent_id
        item: dict[str, Any] = {"id": victim, "kind": e.details.get("kind"), "cause": cause, "by": by}
        rid = e.details.get("residue_id")
        if rid and rid in residues:
            res = residues[rid]
            item["residue"] = {"id": rid, "compute": _num(res.get("compute")), "essence": _num(res.get("essence"))}
        out.append(item)
    return out


def _messages(record: TurnRecord, events: list[Event]) -> list[dict[str, Any]]:
    action = record.action or {}
    name = action.get("name")
    if name not in ("send", "broadcast"):
        return []
    args = action.get("args") or {}
    text = args.get("message")
    delivered = [e for e in events if e.kind == "message_delivered"]
    recipients: list[str] = []
    for e in delivered:
        recipients.extend(str(r) for r in (e.details.get("recipients") or []))
    item: dict[str, Any] = {
        "from": record.acting_agent_id,
        "to": "broadcast" if name == "broadcast" else [args.get("recipient")],
        "text": _clip(text, MESSAGE_MAX_CHARS) if isinstance(text, str) else "",
        "delivered": bool(record.action_result and record.action_result.ok and (delivered or name == "broadcast")),
    }
    if name == "broadcast":
        item["heard_by"] = recipients
    return [item]


def _costs(events: list[Event], record: TurnRecord) -> dict[str, Any]:
    thinking = sum(e.costs.compute for e in events if e.kind in THINKING_KINDS)
    interpreter = sum(e.costs.compute for e in events if e.kind.startswith("skill_"))
    action = record.action_result.cost_compute if record.action_result is not None else 0.0
    return _drop_empty({"thinking": _num(thinking), "action": _num(action), "interpreter": _num(interpreter)}, drop_zero=True)


def _extras(events: list[Event]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for e in events:
        if e.kind == "decision":
            if e.details.get("notebook_updated"):
                out["notebook_updated"] = True
            if e.details.get("saved_skills"):
                out["saved_skills"] = list(e.details.get("saved_skills") or [])
            if e.details.get("deleted_skills"):
                out["deleted_skills"] = list(e.details.get("deleted_skills") or [])
            if e.details.get("memory_priorities"):
                out["memory_priorities"] = len(e.details.get("memory_priorities") or [])
        elif e.kind == "skill_rejected":
            out.setdefault("rejected_skills", []).append({"name": e.details.get("name"), "error": _clip(e.details.get("error"), 160)})
        elif e.kind == "skill_error":
            out["skill_error"] = _clip(e.details.get("error") or e.summary, 160)
    return out


def _thought(events: list[Event]) -> Optional[str]:
    for e in events:
        if e.kind == "decision":
            thought = e.details.get("thought")
            if isinstance(thought, str) and thought.strip():
                return _clip(thought.strip(), THOUGHT_MAX_CHARS)
    return None


def _operator(events: list[Event]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for e in events:
        if e.kind not in ("intervention", "operator_voice"):
            continue
        iv = e.details.get("intervention") if isinstance(e.details.get("intervention"), dict) else {}
        item: dict[str, Any] = {
            "type": iv.get("type") or ("voice" if e.kind == "operator_voice" else None),
            "ok": e.details.get("ok", True),
            "summary": _clip(e.summary, SUMMARY_MAX_CHARS),
            "changes": len(e.details.get("changes") or []),
            "origin": e.details.get("origin"),
        }
        if e.kind == "operator_voice":
            item["text"] = _clip(e.details.get("text"), 300)
        out.append(_drop_empty(item))
    return out


def _stat_delta(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    bs, as_ = before.get("stats") or {}, after.get("stats") or {}
    for key in ("health", "compute", "essence"):
        b, a = bs.get(key), as_.get(key)
        if isinstance(b, (int, float)) and isinstance(a, (int, float)) and abs(a - b) > 1e-9:
            out[key] = [_num(b), _num(a)]
    bp, ap = before.get("position"), after.get("position")
    if isinstance(bp, dict) and isinstance(ap, dict) and (bp.get("x"), bp.get("y")) != (ap.get("x"), ap.get("y")):
        out["pos"] = [[bp.get("x"), bp.get("y")], [ap.get("x"), ap.get("y")]]
    if before.get("alive") != after.get("alive") and "alive" in before:
        out["alive"] = [before.get("alive"), after.get("alive")]
    for key, value in (after.get("upgrade_counts") or {}).items():
        if (before.get("upgrade_counts") or {}).get(key) != value:
            out.setdefault("upgrades", {})[key] = value
    return out


def _touched_ids(record: TurnRecord, deaths: list[dict[str, Any]], events: list[Event]) -> list[str]:
    ids: list[str] = []
    eff = (record.action_result.effects if record.action_result else {}) or {}
    args = (record.action or {}).get("args") or {}
    for value in (eff.get("target"), eff.get("to") if isinstance(eff.get("to"), str) else None, args.get("recipient"), args.get("target")):
        if isinstance(value, str):
            ids.append(value)
    ids.extend(str(d["id"]) for d in deaths if d.get("id"))
    ids.extend(str(e.details.get("target")) for e in events if e.kind == "damage" and e.details.get("target"))
    seen: list[str] = []
    for i in ids:
        if i not in seen and i != record.acting_agent_id:
            seen.append(i)
    return seen


# ---------------------------------------------------------------------------
# Turn digests
# ---------------------------------------------------------------------------


def turn_digest(run_id: str, turn_id: str, *, max_chars: int = 2000) -> dict[str, Any]:
    """Compact digest of one committed turn (``turn_id`` may be ``live``/``latest`` = the run's
    current committed turn; a pre-fork turn of a continuation is read from the parent run and
    carries ``run_id``).  Agent turn keys (empty ones omitted): ``turn_id, kind, round, turn,
    actor{id,name}, decision_source, thought`` (the agent's own words: a BELIEF, not a fact),
    ``action{name,args,via_skill}, result{ok,reason,cost,effects}, no_action_reason, lost,
    skipped, costs{thinking,action,interpreter}, extras, actor_delta, others[], deaths[{id,kind,
    cause,by,residue}], damage[], messages[{from,to,text,delivered}], operator[], events[]``
    (notable summaries) and ``text`` (one factual English paragraph).  Round-end and init turns
    have their own shapes (see ``_round_end_digest`` / ``_init_digest``).  The compact JSON is
    kept under ``max_chars`` by trimming long fields (then ``truncated: true``)."""
    ref = _resolve(run_id, turn_id)
    digest = _turn_digest_ref(ref, run_id)
    return _fit(digest, max_chars)


def _turn_digest_ref(ref: TurnRef, context_run_id: str) -> dict[str, Any]:
    record = _load_record(ref.rdir, ref.turn_id)
    events = _load_events(ref.run_id, ref.rdir, ref.turn_id)
    agents = _load_agents(ref.rdir, ref.turn_id)
    if record.kind == "round_end":
        digest = _round_end_digest(record, events, agents)
    elif record.kind == "init":
        digest = _init_digest(record, events, agents)
    else:
        digest = _agent_turn_digest(ref, record, events, agents, context_run_id)
    if ref.run_id != context_run_id:
        digest["run_id"] = ref.run_id
    return digest


def _agent_turn_digest(ref: TurnRef, record: TurnRecord, events: list[Event], agents: dict[str, dict[str, Any]], context_run_id: str) -> dict[str, Any]:
    who = _Namer(agents)
    actor_id = record.acting_agent_id or ""
    source = record.decision_source
    thought = _thought(events)
    deaths = _deaths(events, record)
    damage = [
        {"by": e.actor, "target": e.details.get("target"), "amount": _num(e.details.get("amount")), "health_after": _num(e.details.get("health_after")), "cause": e.details.get("cause")}
        for e in events
        if e.kind == "damage"
    ]
    messages = _messages(record, events)
    action = record.action or None
    result = record.action_result
    digest: dict[str, Any] = {
        "turn_id": record.turn_id,
        "kind": record.kind,
        "round": record.round,
        "turn": record.turn_index,
        "actor": {"id": actor_id, "name": who.name(actor_id)},
        "decision_source": source,
        "thought": thought,
    }
    parts: list[str] = []
    if action:
        name = str(action.get("name"))
        args = action.get("args") or {}
        digest["action"] = _drop_empty({"name": name, "args": _compact_args(name, args), "via_skill": action.get("skill_name") if action.get("via_skill") else None})
        phrase = _action_phrase(name, args, who)
        if action.get("via_skill"):
            phrase += f" (via skill {action.get('skill_name')})" if action.get("skill_name") else " (via a skill)"
        sentence = f"{who(actor_id)} {phrase}"
        if name in ("send", "broadcast") and isinstance(args.get("message"), str):
            sentence += f": “{_clip(args.get('message'), 200)}”"
        if result is not None:
            digest["result"] = _drop_empty(
                {
                    "ok": result.ok,
                    "reason": None if result.ok else result.reason,
                    "cost": _drop_empty({"compute": _num(result.cost_compute), "essence": _num(result.cost_essence)}, drop_zero=True),
                    "effects": _compact_effects(result.effects),
                }
            )
            if result.ok:
                effect = _headline_effect(result.effects, who)
                sentence += f" and {effect}" if effect else ""
            else:
                sentence += f", but it failed ({result.reason})"
        parts.append(sentence + ".")
    else:
        phrase = _no_action_phrase(source, events)
        digest["no_action_reason"] = phrase
        problem = _decision_problem(events)
        sentence = f"{who(actor_id)} {phrase}"
        if problem and (source == "model" or source.startswith("skipped")):
            sentence += f" ({problem})"
            digest["problem"] = problem
        parts.append(sentence + ".")
        if source == "model":
            digest["lost"] = True
        if source.startswith("skipped"):
            digest["skipped"] = True
    if thought:
        parts.append(f"Its own stated reasoning (a belief, not a fact): “{_clip(thought, 200)}”")
    for death in deaths:
        victim = who(death["id"])
        if death.get("by"):
            parts.append(f"{victim} died, killed by {who(death['by'])}.")
        else:
            parts.append(f"{victim} died ({death.get('cause')}).")
    operator = _operator(events)
    for op in operator:
        parts.append(f"Operator: {op.get('summary')}.")
    digest["costs"] = _costs(events, record)
    digest["extras"] = _extras(events)
    prev_agents = _previous_agents(ref, record, context_run_id)
    if prev_agents and actor_id in prev_agents and actor_id in agents:
        digest["actor_delta"] = _stat_delta(prev_agents[actor_id], agents[actor_id])
    others = []
    for other in _touched_ids(record, deaths, events):
        if other in prev_agents and other in agents:
            delta = _stat_delta(prev_agents[other], agents[other])
            if delta:
                others.append({"id": other, **delta})
    digest["others"] = others
    digest["deaths"] = deaths
    digest["damage"] = damage
    digest["messages"] = messages
    digest["operator"] = operator
    digest["events"] = [_clip(e.summary, SUMMARY_MAX_CHARS) for e in events if e.kind in NOTABLE_KINDS]
    digest["text"] = " ".join(parts)
    return _drop_empty(digest)


def _named(who: "_Namer", entity_id: str) -> dict[str, Any]:
    """``{id, name}`` (name omitted for an unknown id) so a narrator never has to guess a name."""
    return _drop_empty({"id": entity_id, "name": who.name(entity_id)})


def _round_end_digest(record: TurnRecord, events: list[Event], agents: dict[str, dict[str, Any]]) -> dict[str, Any]:
    who = _Namer(agents)
    growth: dict[str, Any] = {}
    stage_changes: list[dict[str, Any]] = []
    fruit_spawned = seeds = germinated = 0
    removed: Counter[str] = Counter()
    lost_compute = 0.0
    upkeep_short: list[str] = []
    upkeep_paid = 0.0
    starvation: list[dict[str, Any]] = []
    living: Optional[list[str]] = None
    for e in events:
        d = e.details
        if e.kind == "plant_growth":
            if "count" in d:
                growth = {"plants": d.get("count"), "energy_in": _num(d.get("total_energy_inflow")), "essence_in": _num(d.get("total_essence_inflow"))}
            elif d.get("plant_id"):
                stage_changes.append({"plant": d.get("plant_id"), "stage": d.get("stage")})
        elif e.kind == "fruit_spawned":
            fruit_spawned += 1
        elif e.kind == "seed_spawned":
            seeds += 1
        elif e.kind == "germination":
            germinated += 1
        elif e.kind == "fruit_removed":
            removed[str(d.get("reason") or "removed")] += 1
            lost_compute += float(d.get("lost_compute") or 0.0)
        elif e.kind == "upkeep":
            paid = float(d.get("paid") if isinstance(d.get("paid"), (int, float)) else e.costs.compute)
            owed = float(d.get("owed") if isinstance(d.get("owed"), (int, float)) else paid)
            upkeep_paid += paid
            if paid + 1e-9 < owed:
                upkeep_short.append(str(d.get("agent_id") or e.actor))
        elif e.kind == "starvation":
            sid = str(d.get("agent_id") or e.actor)
            starvation.append(_drop_empty({"id": sid, "name": who.name(sid), "health_after": _num(d.get("health_after"))}))
        elif e.kind == "round_ended":
            living = [str(a) for a in (d.get("living_agents") or [])]
    if stage_changes:
        growth["stage_changes"] = stage_changes[:12]
    deaths = _deaths(events, record)
    if living is None:
        living = sorted(a for a, v in agents.items() if v.get("alive"))
    parts = [f"Round {record.round} ended."]
    if growth.get("plants"):
        parts.append(f"{growth['plants']} plants grew (+{growth.get('energy_in')} energy, +{growth.get('essence_in')} essence).")
    if fruit_spawned or seeds or germinated:
        parts.append(f"New fruit: {fruit_spawned}, seeds: {seeds}, germinated: {germinated}.")
    if removed:
        parts.append("Fruit removed: " + ", ".join(f"{n} {r}" for r, n in sorted(removed.items())) + ".")
    parts.append("Every agent paid upkeep." if not upkeep_short else f"Could not pay full upkeep: {', '.join(who(a) for a in upkeep_short)}.")
    for s in starvation:
        parts.append(f"{who(s['id'])} starved (health {s['health_after']}).")
    for death in deaths:
        parts.append(f"{who(death['id'])} died ({death.get('cause')}).")
    parts.append(f"{len(living)} agents alive" + (f": {', '.join(who(a) for a in living)}." if living else "."))
    digest = {
        "turn_id": record.turn_id,
        "kind": "round_end",
        "round": record.round,
        "growth": growth,
        "fruit": _drop_empty({"spawned": fruit_spawned, "removed": dict(removed), "lost_compute": _num(lost_compute)}, drop_zero=True),
        "seeds": seeds or None,
        "germinated": germinated or None,
        "upkeep_paid": _num(upkeep_paid),
        "upkeep_short": [_named(who, a) for a in upkeep_short],
        "starvation": starvation,
        "deaths": deaths,
        "living": [_named(who, a) for a in living],
        "operator": _operator(events),
        "text": " ".join(parts),
    }
    return _drop_empty(digest)


def cast_map(run_id: str, turn_id: Optional[str] = None) -> list[dict[str, Any]]:
    """Every agent of the run as ``[{id, name, alive}]`` at ``turn_id`` (default: the current
    turn), in id order: the narrator's name table, so it never has to invent a name for an id."""
    ref = _resolve(run_id, turn_id)
    agents = _load_agents(ref.rdir, ref.turn_id)
    return [{"id": aid, "name": a.get("name") or aid, "alive": bool(a.get("alive"))} for aid, a in agents.items()]


def _init_digest(record: TurnRecord, events: list[Event], agents: dict[str, dict[str, Any]]) -> dict[str, Any]:
    cast = [{"id": a, "name": v.get("name")} for a, v in agents.items()]
    names = ", ".join(f"{c['name']} ({c['id']})" for c in cast)
    return {
        "turn_id": record.turn_id,
        "kind": "init",
        "round": record.round,
        "cast": cast,
        "text": f"The run began with {len(cast)} agents: {names}.",
    }


def _fit(digest: dict[str, Any], max_chars: int) -> dict[str, Any]:
    """Trim long fields until the compact JSON is under ``max_chars`` (``truncated: true``);
    the last resort keeps only the identifying keys, the outcome and a clipped ``text``."""
    if max_chars <= 0 or len(_compact_json(digest)) <= max_chars:
        return digest
    d = json.loads(_compact_json(digest))
    d["truncated"] = True
    steps = [
        lambda: d.update(thought=_clip(d["thought"], 300)) if d.get("thought") else None,
        lambda: [m.update(text=_clip(m.get("text"), 200)) for m in d.get("messages", [])],
        lambda: d.pop("others", None),
        lambda: d.update(events=d.get("events", [])[:3]) if d.get("events") else None,
        lambda: d.pop("extras", None),
        lambda: d.pop("operator", None),
        lambda: d.update(action={k: v for k, v in d["action"].items() if k != "args"}) if isinstance(d.get("action"), dict) else None,
        lambda: d.update(thought=_clip(d["thought"], 120)) if d.get("thought") else None,
        lambda: [m.update(text=_clip(m.get("text"), 80)) for m in d.get("messages", [])],
        lambda: [d.pop(k, None) for k in ("growth", "fruit", "damage", "actor_delta", "cast", "costs", "events")],
        lambda: d.update(result={"ok": d["result"].get("ok"), "reason": d["result"].get("reason")}) if isinstance(d.get("result"), dict) else None,
        lambda: d.update(text=_clip(d.get("text"), max(80, max_chars // 3))),
    ]
    for step in steps:
        step()
        if len(_compact_json(d)) <= max_chars:
            return d
    keep = ("turn_id", "run_id", "kind", "round", "turn", "actor", "decision_source", "action", "result", "lost", "skipped", "deaths", "living", "truncated")
    core = {k: d[k] for k in keep if k in d}
    budget = max(40, max_chars - len(_compact_json(core)) - 12)
    core["text"] = _clip(d.get("text"), budget)
    return core


# ---------------------------------------------------------------------------
# Rounds
# ---------------------------------------------------------------------------


@dataclass
class _RoundStats:
    actions: Counter
    failed: Counter
    skipped: Counter
    upgrades: Counter
    invalid_decisions: int = 0
    model_failures: int = 0
    lost_turns: int = 0
    messages: int = 0
    broadcasts: int = 0
    attacks: int = 0
    damage_total: float = 0.0
    deaths: int = 0
    kills: int = 0
    skills_saved: int = 0
    skills_rejected: int = 0
    skill_steps: int = 0
    moves: int = 0
    absorbs: int = 0
    interventions: int = 0
    cognition: float = 0.0
    action_compute: float = 0.0
    interpreter: float = 0.0
    upkeep: float = 0.0


def _new_stats() -> _RoundStats:
    return _RoundStats(actions=Counter(), failed=Counter(), skipped=Counter(), upgrades=Counter())


def _accumulate(stats: _RoundStats, record: TurnRecord, events: list[Event]) -> None:
    action = record.action or {}
    name = action.get("name")
    result = record.action_result
    if name:
        stats.actions[str(name)] += 1
        if result is not None and not result.ok:
            stats.failed[str(result.reason)] += 1
        if result is not None and result.ok:
            if name == "send":
                stats.messages += 1
            elif name == "broadcast":
                stats.broadcasts += 1
            elif name == "move":
                stats.moves += 1
            elif name == "absorb":
                stats.absorbs += 1
            elif name == "upgrade":
                stats.upgrades[str((action.get("args") or {}).get("attribute"))] += 1
        if name == "attack":
            stats.attacks += 1
        if result is not None:
            stats.action_compute += result.cost_compute
    elif record.kind == "agent_turn":
        if record.decision_source.startswith("skipped") or record.decision_source == "wait":
            stats.skipped[record.decision_source] += 1
        if record.decision_source == "model":
            stats.lost_turns += 1
    carried_failure = name is not None
    for e in events:
        if e.kind == "decision_invalid":
            stats.invalid_decisions += 1
        elif e.kind == "model_call_failed" and not (carried_failure and "charge discarded" in str(e.details.get("error") or "")):
            stats.model_failures += 1
        elif e.kind == "damage":
            stats.damage_total += float(e.details.get("amount") or 0.0)
        elif e.kind == "death" and e.details.get("kind") == "agent":
            stats.deaths += 1
        elif e.kind == "skill_saved":
            stats.skills_saved += 1
        elif e.kind == "skill_rejected":
            stats.skills_rejected += 1
        elif e.kind == "skill_step":
            stats.skill_steps += 1
        elif e.kind in ("intervention", "operator_voice"):
            stats.interventions += 1
        elif e.kind == "upkeep":
            paid = e.details.get("paid")
            stats.upkeep += float(paid if isinstance(paid, (int, float)) else e.costs.compute)
        if e.kind in THINKING_KINDS:
            stats.cognition += e.costs.compute
        if e.kind.startswith("skill_"):
            stats.interpreter += e.costs.compute
    stats.kills += sum(1 for d in _deaths(events, record) if d.get("by") and d.get("kind") == "agent")


def _stats_dict(stats: _RoundStats) -> dict[str, Any]:
    return _drop_empty(
        drop_zero=True,
        d={
            "actions": dict(stats.actions),
            "failed": dict(stats.failed),
            "skipped": dict(stats.skipped),
            "invalid_decisions": stats.invalid_decisions,
            "model_failures": stats.model_failures,
            "lost_turns": stats.lost_turns,
            "messages": stats.messages,
            "broadcasts": stats.broadcasts,
            "attacks": stats.attacks,
            "damage_total": _num(stats.damage_total),
            "deaths": stats.deaths,
            "kills": stats.kills,
            "skills_saved": stats.skills_saved,
            "skills_rejected": stats.skills_rejected,
            "skill_steps": stats.skill_steps,
            "moves": stats.moves,
            "absorbs": stats.absorbs,
            "upgrades": dict(stats.upgrades),
            "interventions": stats.interventions,
        }
    )


def _agents_row(agents: dict[str, dict[str, Any]], model_keys: Optional[dict[str, str]] = None) -> list[dict[str, Any]]:
    rows = []
    for aid, a in agents.items():
        stats = a.get("stats") or {}
        pos = a.get("position") or {}
        execution = a.get("skill_execution") or {}
        row = {
            "id": aid,
            "name": a.get("name"),
            "alive": bool(a.get("alive")),
            "health": _num(stats.get("health")),
            "compute": _num(stats.get("compute")),
            "essence": _num(stats.get("essence")),
            "pos": [pos.get("x"), pos.get("y")],
            "skills": sorted((a.get("skills") or {}).keys()),
            "running_skill": execution.get("root_skill") if isinstance(execution, dict) else None,
            "death_cause": a.get("death_cause"),
        }
        if model_keys and aid in model_keys:
            row["model"] = model_keys[aid]
        rows.append(_drop_empty(row))
    return rows


def _round_refs(run_id: str, round_no: int) -> list[TurnRef]:
    return [r for r in timeline(run_id) if r.round == round_no and r.entry.kind != "init"]


def round_digest(run_id: str, round_no: int, *, detail: str = "normal") -> dict[str, Any]:
    """Per-round summary: ``round, complete, order, turns[], counts, compute, end, agents,
    highlights, text``.  ``detail``: ``brief`` (turn headlines only, no agents), ``normal``
    (turn text + short thought, agent table) or ``full`` (full turn digests, each <= 1200 chars).
    Crosses into the parent run for rounds before a continuation's fork."""
    if detail not in ("brief", "normal", "full"):
        raise ValueError("detail must be brief, normal or full")
    refs = _round_refs(run_id, round_no)
    if not refs:
        raise storage.StorageError(f"round {round_no} has no committed turns in run {run_id}")
    stats = _new_stats()
    turns: list[dict[str, Any]] = []
    order: list[str] = []
    end: Optional[dict[str, Any]] = None
    for ref in refs:
        record = _load_record(ref.rdir, ref.turn_id)
        events = _load_events(ref.run_id, ref.rdir, ref.turn_id)
        _accumulate(stats, record, events)
        if not order:
            for e in events:
                if e.kind == "round_started":
                    order = [str(x) for x in (e.details.get("order") or [])]
            if not order and record.scheduler.order:
                order = list(record.scheduler.order)
        digest = _turn_digest_ref(ref, run_id)
        if record.kind == "round_end":
            end = digest
            continue
        if detail == "brief":
            turns.append(_drop_empty({"turn_id": ref.turn_id, "actor": record.acting_agent_id, "action": (record.action or {}).get("name"), "ok": record.action_result.ok if record.action_result else None, "text": _clip(digest.get("text"), SUMMARY_MAX_CHARS)}))
        elif detail == "normal":
            turns.append(_drop_empty({"turn_id": ref.turn_id, "text": _clip(digest.get("text"), 320), "thought": _clip(digest.get("thought"), 200) if digest.get("thought") else None}))
        else:
            turns.append(_fit(digest, 1200))
    last = refs[-1]
    out: dict[str, Any] = {
        "round": round_no,
        "complete": end is not None,
        "order": order,
        "turns": turns,
        "counts": _stats_dict(stats),
        "compute": {"cognition": _num(stats.cognition), "actions": _num(stats.action_compute), "interpreter": _num(stats.interpreter), "upkeep": _num(stats.upkeep)},
        "end": end,
    }
    if detail != "brief":
        agents = _load_agents(last.rdir, last.turn_id)
        out["agents"] = _agents_row(agents)
    out["highlights"] = [h["text"] for h in _highlights_over(refs, run_id, limit=5)]
    counts = out["counts"]
    summary = [f"Round {round_no}{'' if end is not None else ' (in progress)'}: {len(turns)} agent turns"]
    if counts.get("attacks"):
        summary.append(f"{counts['attacks']} attacks")
    if counts.get("deaths"):
        summary.append(f"{counts['deaths']} deaths")
    if counts.get("messages") or counts.get("broadcasts"):
        summary.append(f"{counts.get('messages', 0) + counts.get('broadcasts', 0)} messages")
    if counts.get("lost_turns"):
        summary.append(f"{counts['lost_turns']} lost turns")
    out["text"] = ", ".join(summary) + "."
    return _drop_empty(out) | {"complete": end is not None, "round": round_no}


def last_round_digest(run_id: str, *, detail: str = "normal") -> dict[str, Any]:
    """The most recent round with a committed round end (the round in progress when none has
    ended yet); ``{"round": 0, "text": ...}`` before any round was played."""
    refs = timeline(run_id)
    ended = [r.round for r in refs if r.entry.kind == "round_end"]
    if ended:
        return round_digest(run_id, ended[-1], detail=detail)
    rounds = [r.round for r in refs if r.entry.kind == "agent_turn"]
    if rounds:
        return round_digest(run_id, rounds[-1], detail=detail)
    return {"round": 0, "complete": False, "turns": [], "text": "No round has been played yet."}


# ---------------------------------------------------------------------------
# Trends
# ---------------------------------------------------------------------------

TREND_METRICS = (
    "living",
    "deaths",
    "kills",
    "attacks",
    "damage",
    "messages",
    "skills_saved",
    "moves",
    "upgrades",
    "failed_actions",
    "lost_turns",
    "cognition_compute",
    "action_compute",
    "interpreter_compute",
    "upkeep_paid",
    "held_compute",
    "held_essence",
    "mean_health",
)


def trends(run_id: str, last_n_rounds: int = 5) -> dict[str, Any]:
    """Per-round series over the last N rounds (a round still in progress is included and
    named in ``partial_round``): ``{rounds: [..], partial_round, metrics: {name: [values]},
    delta: {name: last - first}, text}``; metrics in ``TREND_METRICS``.  Held compute /
    essence / mean health come from the round's last committed turn's agent files."""
    n = max(1, min(int(last_n_rounds), 200))
    refs = [r for r in timeline(run_id) if r.entry.kind != "init"]
    rounds = sorted({r.round for r in refs})[-n:]
    by_round: dict[int, list[TurnRef]] = {r: [] for r in rounds}
    for ref in refs:
        if ref.round in by_round:
            by_round[ref.round].append(ref)
    metrics: dict[str, list[Any]] = {m: [] for m in TREND_METRICS}
    partial: Optional[int] = None
    for rnd in rounds:
        stats = _new_stats()
        living: Optional[int] = None
        for ref in by_round[rnd]:
            record = _load_record(ref.rdir, ref.turn_id)
            events = _load_events(ref.run_id, ref.rdir, ref.turn_id)
            _accumulate(stats, record, events)
            for e in events:
                if e.kind == "round_ended":
                    living = len(e.details.get("living_agents") or [])
        last = by_round[rnd][-1]
        if last.entry.kind != "round_end":
            partial = rnd
        agents = _load_agents(last.rdir, last.turn_id)
        alive = [a for a in agents.values() if a.get("alive")]
        if living is None:
            living = len(alive)
        held_c = sum(float((a.get("stats") or {}).get("compute") or 0.0) for a in alive)
        held_e = sum(float((a.get("stats") or {}).get("essence") or 0.0) for a in alive)
        mean_h = sum(float((a.get("stats") or {}).get("health") or 0.0) for a in alive) / len(alive) if alive else 0.0
        values = {
            "living": living,
            "deaths": stats.deaths,
            "kills": stats.kills,
            "attacks": stats.attacks,
            "damage": _num(stats.damage_total),
            "messages": stats.messages + stats.broadcasts,
            "skills_saved": stats.skills_saved,
            "moves": stats.moves,
            "upgrades": sum(stats.upgrades.values()),
            "failed_actions": sum(stats.failed.values()),
            "lost_turns": stats.lost_turns,
            "cognition_compute": _num(stats.cognition),
            "action_compute": _num(stats.action_compute),
            "interpreter_compute": _num(stats.interpreter),
            "upkeep_paid": _num(stats.upkeep),
            "held_compute": _num(held_c),
            "held_essence": _num(held_e),
            "mean_health": _num(mean_h),
        }
        for key in TREND_METRICS:
            metrics[key].append(values[key])
    delta = {k: _num(v[-1] - v[0]) for k, v in metrics.items() if v}
    text = "No rounds played yet."
    if rounds:
        text = (
            f"Rounds {rounds[0]}-{rounds[-1]}: living {metrics['living'][0]} -> {metrics['living'][-1]}, "
            f"{sum(metrics['deaths'])} deaths, {sum(metrics['attacks'])} attacks, {sum(metrics['messages'])} messages, "
            f"held compute {metrics['held_compute'][0]} -> {metrics['held_compute'][-1]}."
        )
    return {"rounds": rounds, "partial_round": partial, "metrics": metrics, "delta": delta, "text": text}


# ---------------------------------------------------------------------------
# Highlights and event search
# ---------------------------------------------------------------------------


def _highlights_for_turn(ref: TurnRef, idx: int, who: _Namer, first_senders: set[str]) -> list[tuple[int, int, dict[str, Any]]]:
    record = _load_record(ref.rdir, ref.turn_id)
    events = _load_events(ref.run_id, ref.rdir, ref.turn_id)
    out: list[tuple[int, int, dict[str, Any]]] = []

    def add(kind: str, salience: int, actors: list[str], text: str) -> None:
        out.append((salience, idx, {"turn_id": ref.turn_id, "round": ref.round, "kind": kind, "salience": salience, "actors": [a for a in actors if a], "text": f"{ref.turn_id}: {text}"}))

    deaths = _deaths(events, record)
    dead_ids = {d["id"] for d in deaths}
    for d in deaths:
        if d.get("kind") == "agent":
            text = f"{who(d['id'])} died" + (f", killed by {who(d['by'])}" if d.get("by") else f" ({d.get('cause')})")
            add("death", SALIENCE["death"], [d["id"], d.get("by")], text)
    for e in events:
        if e.kind == "damage" and e.actor not in ("world", "operator", "system"):
            target = e.details.get("target")
            if target in dead_ids:
                continue
            if isinstance(target, str) and target in who.agents:
                add("attack", SALIENCE["attack"], [e.actor, target], f"{who(e.actor)} hit {who(target)} for {_num(e.details.get('amount'))} (health {_num(e.details.get('health_after'))})")
            else:
                add("plant_attack", SALIENCE["plant_attack"], [e.actor], f"{who(e.actor)} hit {target} for {_num(e.details.get('amount'))}")
        elif e.kind == "skill_saved":
            add("skill_saved", SALIENCE["skill_saved"], [e.actor], f"{who(e.actor)} saved skill {e.details.get('name')}")
    for m in _messages(record, events):
        if not m.get("delivered"):
            continue
        sender = str(m.get("from"))
        bonus = 5 if sender not in first_senders else 0
        first_senders.add(sender)
        to = "everyone nearby" if m["to"] == "broadcast" else ", ".join(who(t) for t in m["to"])
        add("message", SALIENCE["message"] + bonus, [sender] + ([] if m["to"] == "broadcast" else list(m["to"])), f"{who(sender)} to {to}: “{_clip(m.get('text'), 120)}”")
    action = record.action or {}
    result = record.action_result
    if action.get("name") == "upgrade" and result is not None and result.ok:
        eff = result.effects or {}
        add("upgrade", SALIENCE["upgrade"], [record.acting_agent_id or ""], f"{who(record.acting_agent_id)} upgraded {eff.get('purchased') or (action.get('args') or {}).get('attribute')} to {_num(eff.get('new_value'))}")
    if action and result is not None and not result.ok:
        add("failed_action", SALIENCE["failed_action"], [record.acting_agent_id or ""], f"{who(record.acting_agent_id)} tried to {action.get('name')} but failed ({result.reason})")
    if not action and record.kind == "agent_turn" and record.decision_source == "model":
        add("lost_turn", SALIENCE["lost_turn"], [record.acting_agent_id or ""], f"{who(record.acting_agent_id)} lost its turn ({_decision_problem(events) or 'no decision'})")
    return out


def _highlights_over(refs: list[TurnRef], run_id: str, *, limit: int) -> list[dict[str, Any]]:
    if not refs:
        return []
    names = _load_agents(refs[-1].rdir, refs[-1].turn_id)
    who = _Namer(names)
    first_senders: set[str] = set()
    scored: list[tuple[int, int, dict[str, Any]]] = []
    for idx, ref in enumerate(refs):
        if ref.entry.kind == "init":
            continue
        scored.extend(_highlights_for_turn(ref, idx, who, first_senders))
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [item for _, _, item in scored[: max(0, limit)]]


def get_highlights(run_id: str, *, from_turn_id: Optional[str] = None, to_turn_id: Optional[str] = None, limit: int = 10) -> list[dict[str, Any]]:
    """Salience-ranked notable events of the run (lineage-aware), highest first, ties in commit
    order: ``[{turn_id, round, kind, salience, actors, text}]``.  Kinds and salience: death
    (agents) 100 > attack 80 > message 60 (+5 for a sender's first message) > plant_attack 50 >
    skill_saved 40 > upgrade 30 > failed_action 20 > lost_turn 15."""
    refs = _range(timeline(run_id), from_turn_id, to_turn_id)
    return _highlights_over(refs, run_id, limit=limit)


def search_events(
    run_id: str,
    *,
    kinds: Optional[Iterable[str]] = None,
    actor: Optional[str] = None,
    text: Optional[str] = None,
    from_turn_id: Optional[str] = None,
    to_turn_id: Optional[str] = None,
    limit: int = 50,
) -> dict[str, Any]:
    """Committed events matching every given filter, in commit order: ``kinds`` (event kinds),
    ``actor`` (exact actor id, or an agent named in details target/recipients/agent_id/entity_id),
    ``text`` (case-insensitive substring of the summary or the JSON details, e.g. message text).
    Returns ``{matches: [{turn_id, seq, kind, actor, summary, details}], total, truncated,
    scanned_turns}``; details are compacted (intervention ``changes`` dropped, strings clipped)."""
    kind_set = {k for k in (kinds or []) if k}
    needle = (text or "").strip().lower()
    limit = max(1, min(int(limit), 500))
    refs = _range(timeline(run_id), from_turn_id, to_turn_id)
    matches: list[dict[str, Any]] = []
    total = 0
    for ref in refs:
        for e in _load_events(ref.run_id, ref.rdir, ref.turn_id):
            if kind_set and e.kind not in kind_set:
                continue
            if actor:
                d = e.details
                involved = {e.actor, d.get("target"), d.get("agent_id"), d.get("entity_id"), *(d.get("recipients") or [])}
                if actor not in involved:
                    continue
            if needle:
                hay = (e.summary + " " + _compact_json(e.details)).lower()
                if needle not in hay:
                    continue
            total += 1
            if len(matches) < limit:
                matches.append({"turn_id": e.turn_id, "seq": e.seq, "kind": e.kind, "actor": e.actor, "summary": _clip(e.summary, 240), "details": _compact_details(e.details)})
    return {"matches": matches, "total": total, "truncated": total > len(matches), "scanned_turns": len(refs)}


def _compact_details(details: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in details.items():
        if key == "changes":
            out["changes"] = len(value or [])
        elif key == "usage" and isinstance(value, dict):
            continue
        elif isinstance(value, str):
            out[key] = _clip(value, 300)
        elif isinstance(value, float):
            out[key] = _num(value)
        elif isinstance(value, dict):
            s = _compact_json(value)
            out[key] = value if len(s) <= 400 else _clip(s, 400)
        else:
            out[key] = value
    return out


# ---------------------------------------------------------------------------
# Agent dossier (operator truth vs the agent's own belief)
# ---------------------------------------------------------------------------


def agent_dossier(run_id: str, agent_id: str, turn_id: Optional[str] = None) -> dict[str, Any]:
    """``{agent_id, as_of_turn_id, truth: {label, ...}, belief: {label, ...}, discrepancies,
    recent: [turn headlines]}``.  ``truth`` is the operator's authoritative state at the turn
    (stats, position, alive, model, skills, upgrades, spend totals, kills, killed_by, last
    action); ``belief`` is what the AGENT said or thought at its last model turn (its thought,
    believed self from the decision packet, notebook update from the model-call record) and may
    be stale or wrong.  Knowledge files are never read."""
    ref = _resolve(run_id, turn_id)
    agents = _load_agents(ref.rdir, ref.turn_id)
    agent = agents.get(agent_id)
    if agent is None:
        raise storage.StorageError(f"agent {agent_id} does not exist at turn {ref.turn_id}")
    settings = _load_settings(ref.rdir, ref.turn_id)
    model_key = (settings.get("model_overrides") or {}).get(agent_id) or settings.get("default_model_key")
    stats = agent.get("stats") or {}
    refs = _range(timeline(run_id), None, ref.turn_id)
    kills: list[dict[str, Any]] = []
    killed_by: Optional[dict[str, Any]] = None
    recent: list[str] = []
    last_model_ref: Optional[TurnRef] = None
    for r in refs:
        if r.entry.kind == "init":
            continue
        record = _load_record(r.rdir, r.turn_id)
        events = _load_events(r.run_id, r.rdir, r.turn_id)
        for d in _deaths(events, record):
            if d.get("by") == agent_id and d.get("kind") == "agent":
                kills.append({"id": d["id"], "turn_id": r.turn_id})
            if d.get("id") == agent_id:
                killed_by = {"by": d.get("by"), "cause": d.get("cause"), "turn_id": r.turn_id}
        if r.entry.acting_agent_id == agent_id:
            if record.decision_source == "model" and record.packet_id:
                last_model_ref = r
    for r in [x for x in refs if x.entry.acting_agent_id == agent_id][-5:]:
        recent.append(_clip(_turn_digest_ref(r, run_id).get("text"), 240))
    pos = agent.get("position") or {}
    truth = _drop_empty(
        {
            "label": f"operator truth: the authoritative state at {ref.turn_id}",
            "name": agent.get("name"),
            "persona": _clip(agent.get("persona"), PERSONA_MAX_CHARS),
            "alive": bool(agent.get("alive")),
            "position": [pos.get("x"), pos.get("y")],
            "model": model_key,
            "stats": {k: _num(v) for k, v in stats.items()},
            "upgrades": agent.get("upgrade_counts") or {},
            "skills": sorted((agent.get("skills") or {}).keys()),
            "running_skill": (agent.get("skill_execution") or {}).get("root_skill") if isinstance(agent.get("skill_execution"), dict) else None,
            "wait_turns_remaining": agent.get("wait_turns_remaining"),
            "spent": {"actions": _num(agent.get("total_compute_spent")), "thinking": _num(agent.get("total_cognition_spent")), "interpreter": _num(agent.get("total_interpreter_spent"))},
            "model_calls": agent.get("model_call_count"),
            "died_round": agent.get("died_round"),
            "death_cause": agent.get("death_cause"),
            "killed_by": killed_by,
            "kills": kills,
            "last_action": agent.get("last_action"),
            "last_result": _drop_empty({"ok": (agent.get("last_result") or {}).get("ok"), "reason": (agent.get("last_result") or {}).get("reason")}) if agent.get("last_result") else None,
        }
    )
    truth["alive"] = bool(agent.get("alive"))
    belief: dict[str, Any] = {"label": "the agent's own view (its words and what its knowledge told it); may be stale or wrong"}
    discrepancies: list[str] = []
    if last_model_ref is not None:
        belief["from_turn_id"] = last_model_ref.turn_id
        events = _load_events(last_model_ref.run_id, last_model_ref.rdir, last_model_ref.turn_id)
        thought = _thought(events)
        if thought:
            belief["last_thought"] = thought
        record = _load_record(last_model_ref.rdir, last_model_ref.turn_id)
        tdir = _turn_dir(last_model_ref.rdir, last_model_ref.turn_id)
        packet = _read_optional_json(tdir / storage.PACKETS_DIR / f"{record.packet_id}.json") if record.packet_id else None
        situation = packet.get("situation") if isinstance(packet, dict) else None
        if isinstance(situation, dict):
            believed = {k: _num(v) for k, v in (situation.get("self_state") or {}).items() if v is not None}
            if isinstance(believed.get("position"), dict):
                believed["position"] = [believed["position"].get("x"), believed["position"].get("y")]
            belief["believed_self"] = believed
            belief["unread_messages"] = situation.get("unread_messages", 0)
            belief["visible_entities"] = len(situation.get("visible_entities") or [])
            for key in ("health", "compute", "essence"):
                b, t = believed.get(key), stats.get(key)
                if isinstance(b, (int, float)) and isinstance(t, (int, float)) and abs(b - t) > 0.5:
                    discrepancies.append(f"{key}: believes {_num(b)}, actually {_num(t)}")
            if believed.get("position") and believed["position"] != [pos.get("x"), pos.get("y")]:
                discrepancies.append(f"position: believes {believed['position']}, actually {[pos.get('x'), pos.get('y')]}")
        for call_id in record.model_call_ids[-1:]:
            call = _read_optional_json(tdir / storage.MODEL_CALLS_DIR / f"{call_id}.json")
            parsed = ((call or {}).get("result") or {}).get("parsed") if isinstance(call, dict) else None
            if isinstance(parsed, dict) and isinstance(parsed.get("notebook_update"), str) and parsed["notebook_update"].strip():
                belief["notebook_update"] = _clip(parsed["notebook_update"], NOTEBOOK_MAX_CHARS)
    else:
        belief["note"] = "no model decision recorded yet"
    return {"agent_id": agent_id, "as_of_turn_id": ref.turn_id, "truth": truth, "belief": belief, "discrepancies": discrepancies, "recent": recent}


# ---------------------------------------------------------------------------
# Opening and Story Mode run card
# ---------------------------------------------------------------------------


def opening_digest(run_id: str) -> dict[str, Any]:
    """The setting at the run's FIRST committed turn (``r00000_init``, or a continuation's
    copied fork turn): ``{run_id, name, turn_id, round, region, terrain{kind: cells}, plants
    {species: n}, fruits, cast[{id, name, persona, pos, health, compute, attack, speed, vision,
    model}], parent{run_id, name, turn_id} | None, text}``."""
    manifest = _manifest(run_id)
    own = timeline(run_id, include_parent=False)
    if not own:
        raise storage.StorageError(f"run {run_id} has no committed turns")
    first = own[0]
    tdir = _turn_dir(first.rdir, first.turn_id)
    agents = _load_agents(first.rdir, first.turn_id)
    settings = _load_settings(first.rdir, first.turn_id)
    overrides = settings.get("model_overrides") or {}
    default_key = settings.get("default_model_key")
    map_doc = _read_optional_json(tdir / storage.MAP_FILE) or {}
    terrain = Counter(str(v) for v in (map_doc.get("cells") or {}).values())
    plants_doc = _read_optional_json(tdir / storage.ENTITIES_DIR / "plants.json") or {}
    fruits_doc = _read_optional_json(tdir / storage.ENTITIES_DIR / "fruits.json") or {}
    plants = Counter(str(p.get("species")) for p in (plants_doc.values() if isinstance(plants_doc, dict) else []) if isinstance(p, dict) and p.get("alive", True))
    cast = []
    for aid, a in agents.items():
        stats = a.get("stats") or {}
        pos = a.get("position") or {}
        cast.append(
            _drop_empty(
                {
                    "id": aid,
                    "name": a.get("name"),
                    "persona": _clip(a.get("persona"), PERSONA_MAX_CHARS),
                    "alive": bool(a.get("alive")),
                    "pos": [pos.get("x"), pos.get("y")],
                    "health": _num(stats.get("health")),
                    "compute": _num(stats.get("compute")),
                    "attack": _num(stats.get("attack")),
                    "speed": stats.get("speed"),
                    "vision": stats.get("vision_range"),
                    "model": overrides.get(aid) or default_key,
                }
            )
        )
        cast[-1]["alive"] = bool(a.get("alive"))
    parent = None
    if manifest.parent is not None:
        try:
            parent_name = _manifest(manifest.parent.run_id).name
        except storage.StorageError:
            parent_name = manifest.parent.run_id
        parent = {"run_id": manifest.parent.run_id, "name": parent_name, "turn_id": manifest.parent.turn_id}
    region = map_doc.get("region") or {}
    alive = sum(1 for c in cast if c.get("alive"))
    text = f"“{manifest.name}”: {len(cast)} agents ({alive} alive) on a map of {sum(terrain.values())} cells"
    if terrain:
        text += " (" + ", ".join(f"{n} {k}" for k, n in terrain.most_common()) + ")"
    text += f", {sum(plants.values())} plants, {len(fruits_doc) if isinstance(fruits_doc, dict) else 0} fruits."
    if parent:
        text += f" It continues “{parent['name']}” from turn {parent['turn_id']}."
    return {
        "run_id": run_id,
        "name": manifest.name,
        "turn_id": first.turn_id,
        "round": first.round,
        "region": region,
        "terrain": dict(terrain),
        "plants": dict(plants),
        "fruits": len(fruits_doc) if isinstance(fruits_doc, dict) else 0,
        "cast": cast,
        "parent": parent,
        "text": text,
    }


def run_card(run_id: str) -> StoryRunCard:
    """Story Mode step 0 (deterministic, no model call): cast with personas, alive state, model
    keys, kills and death turns; rounds, agent turns, agent deaths and attributed kills of THIS
    run (a continuation's parent is named in ``parent``); top highlights; suggested picks."""
    manifest = _manifest(run_id)
    refs = own_turns(run_id)
    everything = timeline(run_id, include_parent=False)
    last = everything[-1] if everything else None
    if last is None:
        raise storage.StorageError(f"run {run_id} has no committed turns")
    agents = _load_agents(last.rdir, last.turn_id)
    settings = _load_settings(last.rdir, last.turn_id)
    overrides = settings.get("model_overrides") or {}
    kills: Counter[str] = Counter()
    died: dict[str, str] = {}
    deaths = 0
    turns = 0
    for ref in refs:
        if ref.entry.kind == "agent_turn":
            turns += 1
        if ref.entry.kind == "init":
            continue
        record = _load_record(ref.rdir, ref.turn_id)
        events = _load_events(ref.run_id, ref.rdir, ref.turn_id)
        for d in _deaths(events, record):
            if d.get("kind") != "agent":
                continue
            deaths += 1
            died[str(d["id"])] = ref.turn_id
            if d.get("by"):
                kills[str(d["by"])] += 1
    cast = [
        CastMember(
            agent_id=aid,
            name=str(a.get("name") or aid),
            persona=_clip(a.get("persona"), PERSONA_MAX_CHARS),
            alive=bool(a.get("alive")),
            model_key=overrides.get(aid) or settings.get("default_model_key"),
            kills=kills.get(aid, 0),
            died_turn_id=died.get(aid),
        )
        for aid, a in agents.items()
    ]
    highlights = [h["text"] for h in _highlights_over(refs, run_id, limit=8)]
    parent = manifest.parent.model_dump() if manifest.parent is not None else None
    return StoryRunCard(
        run_id=run_id,
        name=manifest.name,
        world_id=manifest.world_id,
        cast=cast,
        rounds=max((r.round for r in everything), default=0),
        turns=turns,
        deaths=deaths,
        kills=sum(kills.values()),
        highlights=highlights,
        first_turn_id=everything[0].turn_id,
        last_turn_id=last.turn_id,
        parent=parent,
        suggested=StoryQuickPicks(),
    )


def quiet_turn(ref: TurnRef) -> bool:
    """``is_quiet`` from the turn's record and events only (no agent files; Story Mode plans
    hundreds of turns with it)."""
    record = _load_record(ref.rdir, ref.turn_id)
    events = _load_events(ref.run_id, ref.rdir, ref.turn_id)
    if record.kind == "init":
        return False
    loud = ("death", "damage", "starvation", "intervention", "operator_voice", "skill_saved", "skill_rejected", "message_delivered")
    if any(e.kind in loud for e in events):
        return False
    name = (record.action or {}).get("name")
    if record.kind == "round_end":
        return True
    return name in (None, "observe", "query", "wait", "move", "absorb")


def is_quiet(digest: dict[str, Any]) -> bool:
    """A turn with nothing a reader would miss: no deaths, damage, messages, operator edits,
    skill saves or upgrades, and an action (if any) among observe/query/wait/move/absorb, or a
    skipped/lost turn.  Story Mode turns quiet turns of non-followed agents into interludes."""
    if digest.get("kind") == "round_end":
        return not (digest.get("deaths") or digest.get("starvation") or digest.get("operator"))
    if digest.get("deaths") or digest.get("damage") or digest.get("messages") or digest.get("operator"):
        return False
    extras = digest.get("extras") or {}
    if extras.get("saved_skills") or extras.get("rejected_skills"):
        return False
    action = (digest.get("action") or {}).get("name")
    return action in (None, "observe", "query", "wait", "move", "absorb")


__all__ = [
    "SALIENCE",
    "TREND_METRICS",
    "TurnRef",
    "agent_dossier",
    "cast_map",
    "clear_cache",
    "digest_sha",
    "get_highlights",
    "is_quiet",
    "quiet_turn",
    "last_round_digest",
    "opening_digest",
    "own_turns",
    "round_digest",
    "run_card",
    "search_events",
    "timeline",
    "trends",
    "turn_digest",
]
