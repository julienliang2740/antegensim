#!/usr/bin/env python3
"""Ground-truthed playtest of the built-in assistant across model tiers (haiku / sonnet, small opus
arm): builds question sets whose answers are computed from run storage, asks each through the
assistant API, scores automatically and logs cost, latency, steps and format failures per call.
Spends real money: refuses to run anything but ``questions`` unless EMPYREAN_ALLOW_LIVE=1.
Results are written to docs/evidence/assistant_playtest.md by ``report`` and summarised in
docs/ASSISTANT.md "Model tier evidence".

Design (synthesis.md "Testing and verification plan", design_final.md R14)
------------------------------------------------------------------------
* One backend per arm, started by this script on ``--port`` with ``EMPYREAN_WORLDS_DIR`` set to a
  per-arm COPY of the two reference runs (``qa/worlds-playtest/<arm>/``), ``EMPYREAN_WHISPER_PRELOAD=0``,
  the arm's model key in ``EMPYREAN_ASSISTANT_MODEL_CHAT`` / ``_AUTHOR`` / ``_NARRATOR`` and raised
  assistant budgets.  Separate copies keep storybook entries from colliding between arms, keep the
  per-arm ledgers separate (spend accounting = sum of that arm's usage.jsonl files) and keep the
  playtest's spend out of the served backend's global $20 assistant cap.
* ``questions``: deterministic ground truth from the run folders (no engine code): living count at
  a round end, deaths and killers from damage events, an agent's last action as of a round end,
  malformed decisions in a round range from model_calls, rule values from rules.json, what happened
  in a turn; plus help questions answered from the docs.  n = 12 per category, 8 help items.
* ``chat``: every question in a fresh conversation scoped to its run, with the context chip a user
  on the run page would send; scored by expected tokens (all groups present, none forbidden), refs
  present, wall latency, steps, cache reads, cost and format outcome (ledger status per call:
  ``malformed`` = the CLI validator rejected the reply; the step still ``ok`` = salvage recovered
  it; a ``repair`` step = post-salvage failure).
* ``narrator``: storybook entries for 12 turns (+ opening) via POST .../storybook/generate; automatic
  faithfulness check of every entry against the digest the narrator saw (names, numbers, deaths and
  killers, lost turns) and an A/B pairs file for the blind style judgement.
* ``author``: one story brief (interview call) and the 3 lazily generated chapters; faithfulness of
  the chapters against their digests.  ``--briefs-only`` for the opus arm (2 briefs, no chapters).
* ``briefs``: 6 natural-language commands; checks the typed action, validation and the deterministic
  card rendering (qa/render_brief.mjs runs the real frontend describeAction).
* ``report``: the evidence markdown and the tier decisions by the fixed rule.

Usage:
  .venv/bin/python scripts/assistant_playtest.py questions [--arm haiku]        # no spend
  EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/assistant_playtest.py chat --arm haiku --max-spend 3.5
  EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/assistant_playtest.py narrator --arm haiku
  EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/assistant_playtest.py author --arm sonnet
  EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/assistant_playtest.py briefs --arm haiku
  .venv/bin/python scripts/assistant_playtest.py report
"""
# DOCS: verification helper; the only script that calls live assistant models on purpose.
from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import signal
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any, Optional

REPO = Path(__file__).resolve().parents[1]
OUT_DIR = REPO / "qa" / "playtest-out"
EVIDENCE = REPO / "docs" / "evidence"
DEFAULT_WORLDS = REPO / "qa" / "worlds-playtest"
MODELS_FILE = Path(os.environ.get("PLAYTEST_MODELS_FILE", str(REPO / "backend" / "empyrean" / "models.example.json")))
PYTHON = REPO / ".venv" / "bin" / "python"

ARMS = {
    "haiku": "claude-cli-haiku-assistant",
    "sonnet": "claude-cli-sonnet-assistant",
    "opus": "claude-cli-opus-assistant",
}
PREDATORS = "run_20260926_034607_b7c5"
FIGHT = "run_20260926_022058_ec4a"

NUMBER_WORDS = {0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve"}
ACTION_SYNONYMS = {
    "move": ["move", "moved", "moving", "walk", "stepped", "travel"],
    "observe": ["observe", "observed", "observing", "look", "scanned", "survey", "scout", "inspect"],
    "query": ["query", "queried", "querying", "asked about", "looked up", "check", "inspect"],
    "absorb": ["absorb", "absorbed", "absorbing", "drain", "harvest", "fed", "ate"],
    "attack": ["attack", "attacked", "attacking", "struck", "strike", "hit"],
    "upgrade": ["upgrade", "upgraded", "upgrading", "bought", "improv", "raised its", "increas"],
    "recover": ["recover", "recovered", "heal", "healed", "restor"],
    "send": ["send", "sent", "message", "messaged", "told"],
    "broadcast": ["broadcast", "announced", "message"],
    "wait": ["wait", "waited", "rested", "idle", "nothing"],
    "transfer": ["transfer", "gave", "handed"],
    "run_skill": ["skill", "ran its", "executed"],
    "save_skill": ["skill", "saved"],
}
LOST_TOKENS = ["lost", "malformed", "no action", "garbled", "did not act", "took no action", "invalid", "no valid decision", "unusable", "failed to produce", "no usable", "nothing happened", "wasn't valid", "was not valid", "rejected", "schema"]
UNAFFORDABLE_TOKENS = ["unaffordable", "afford", "skipped", "not enough compute", "too little compute", "could not think", "couldn't think", "insufficient compute"]
STARVATION_TOKENS = ["starv", "upkeep", "no one", "nobody", "not killed", "no killer", "wasn't killed", "was not killed", "no agent killed", "not attacked", "hunger"]


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _run_dir(worlds: Path, run_id: str) -> Path:
    matches = [p for p in worlds.glob(f"*/runs/{run_id}") if (p / "manifest.json").is_file()]
    if len(matches) != 1:
        raise SystemExit(f"run {run_id} not found exactly once under {worlds}: {matches}")
    return matches[0]


def _index(rdir: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in (rdir / "turns" / "index.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]


def _agents_at(rdir: Path, turn_id: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for path in sorted((rdir / "turns" / turn_id / "entities" / "agents").glob("*.json")):
        data = _read_json(path)
        out[data["id"]] = data
    return out


def _events(rdir: Path, turn_id: str) -> list[dict[str, Any]]:
    return _read_json(rdir / "turns" / turn_id / "events.json")


def _model_call_statuses(rdir: Path, turn_id: str) -> list[str]:
    folder = rdir / "turns" / turn_id / "model_calls"
    if not folder.is_dir():
        return []
    return [(_read_json(p).get("result") or {}).get("status") for p in sorted(folder.glob("mc_*.json"))]


def _strip_ids(text: str) -> str:
    text = re.sub(r"r\d{5}(_t\d{2}_a\d{2}|_end|_init)", " ", text)
    text = re.sub(r"(run|world)_\d{8}_\d{6}_[0-9a-f]{4}", " ", text)
    text = re.sub(r"\b[apfrs]\d{2,4}\b", " ", text)  # entity ids
    return text


def number_present(text: str, value: Any) -> bool:
    """A number appears as a whole token in the id-stripped text (5 or 5.0 or 'five')."""
    stripped = _strip_ids(text).lower()
    try:
        f = float(value)
    except (TypeError, ValueError):
        return str(value).lower() in stripped
    forms = {f"{f:g}"}
    if f == int(f):
        forms.add(str(int(f)))
        forms.add(f"{int(f)}.0")
        if int(f) in NUMBER_WORDS:
            forms.add(NUMBER_WORDS[int(f)])
    for form in forms:
        if re.search(rf"(?<![\d.\w]){re.escape(form)}(?![\d]|\.\d)", stripped):
            return True
    return False


NUMERIC_FIRST_CATEGORIES = ("alive_count", "malformed_count", "rule_value")


def first_number(text: str) -> Optional[float]:
    """The first number the answer states, after removing ids, 'round N' / 'rounds A to B' /
    'turn N' phrases and markdown emphasis (the number a reader takes as the answer)."""
    stripped = _strip_ids(text)
    stripped = re.sub(r"\brounds?\s+\d+(\s*(to|-|\u2013|through|and)\s*\d+)?", " ", stripped, flags=re.IGNORECASE)
    stripped = re.sub(r"\bturns?\s+\d+", " ", stripped, flags=re.IGNORECASE)
    stripped = stripped.replace("*", " ")
    words = {w: n for n, w in NUMBER_WORDS.items() if n != 1}  # "one fruit carries 20": 'one' is an article here
    for tok in re.finditer(r"(?<![\w.])(-?\d+(?:\.\d+)?|" + "|".join(words) + r")(?![\w])", stripped, flags=re.IGNORECASE):
        raw = tok.group(1).lower()
        return float(words[raw]) if raw in words else float(raw)
    return None


def strict_number_correct(text: str, value: Any) -> bool:
    got = first_number(text)
    try:
        return got is not None and abs(got - float(value)) < 1e-9
    except (TypeError, ValueError):
        return False


def token_present(text: str, token: str) -> bool:
    if token.startswith("#"):
        return number_present(text, token[1:])
    return token.lower() in text.lower()


def score(text: str, expect: list[list[str]], forbid: Optional[list[str]] = None) -> tuple[bool, list[str]]:
    """All groups satisfied (each group: any token; '#N' means the number N) and no forbidden token."""
    missing = [" | ".join(group) for group in expect if not any(token_present(text, t) for t in group)]
    hit_forbidden = [t for t in (forbid or []) if token_present(text, t)]
    return (not missing and not hit_forbidden), missing + [f"forbidden: {t}" for t in hit_forbidden]


def pct(a: int, b: int) -> str:
    return f"{100.0 * a / b:.0f}%" if b else "n/a"


def percentile(values: list[float], p: float) -> Optional[float]:
    if not values:
        return None
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round(p * (len(s) - 1)))))
    return s[k]


# ---------------------------------------------------------------------------
# Ground truth: question sets
# ---------------------------------------------------------------------------


def _names(rdir: Path, current: str) -> dict[str, str]:
    return {aid: a.get("name") or aid for aid, a in _agents_at(rdir, current).items()}


def _display(names: dict[str, str], aid: str) -> str:
    return f"{names.get(aid, aid)} ({aid})"


def q_alive_count(worlds: Path, run_id: str, rounds: list[int]) -> list[dict[str, Any]]:
    rdir = _run_dir(worlds, run_id)
    manifest = _read_json(rdir / "manifest.json")
    out = []
    for n in rounds:
        tid = f"r{n:05d}_end"
        alive = [a for a, v in _agents_at(rdir, tid).items() if v.get("alive")]
        out.append(
            {
                "category": "alive_count",
                "run_id": run_id,
                "text": f"How many agents were still alive at the end of round {n}?",
                "chip": {"page": "run", "run_id": run_id, "run_name": manifest["name"], "live_turn_id": manifest["current_turn_id"], "shown_turn_id": manifest["current_turn_id"], "tab": "inspect", "run_state": "paused"},
                "truth": {"alive": len(alive), "ids": alive, "turn_id": tid},
                "expect": [[f"#{len(alive)}"]],
            }
        )
    return out


def q_deaths(worlds: Path, run_id: str, limit: int) -> list[dict[str, Any]]:
    rdir = _run_dir(worlds, run_id)
    manifest = _read_json(rdir / "manifest.json")
    names = _names(rdir, manifest["current_turn_id"])
    out = []
    for entry in _index(rdir):
        if len(out) >= limit:
            break
        events = _events(rdir, entry["turn_id"])
        for e in events:
            if e["kind"] != "death" or e["details"].get("kind") != "agent":
                continue
            victim = e["details"]["entity_id"]
            cause = e["details"].get("cause")
            killers = [d["actor"] for d in events if d["kind"] == "damage" and d["details"].get("target") == victim and d["actor"] not in ("world", "operator", "system")]
            killer = killers[-1] if killers else None
            chip = {"page": "run", "run_id": run_id, "run_name": manifest["name"], "live_turn_id": manifest["current_turn_id"], "shown_turn_id": manifest["current_turn_id"], "tab": "inspect", "run_state": "paused"}
            if killer:
                expect = [[names[killer], killer]]
                forbid = [n for a, n in names.items() if a not in (killer, victim)] if False else []
                text = f"Who killed {_display(names, victim)}?"
                truth = {"victim": victim, "killer": killer, "cause": cause, "turn_id": entry["turn_id"], "round": entry["round"]}
            else:
                expect = [STARVATION_TOKENS, [f"#{entry['round']}"]]
                forbid = ["killed by " + n for a, n in names.items() if a != victim]
                text = f"How did {_display(names, victim)} die, and in which round?"
                truth = {"victim": victim, "killer": None, "cause": cause, "turn_id": entry["turn_id"], "round": entry["round"]}
            out.append({"category": "deaths", "run_id": run_id, "text": text, "chip": chip, "truth": truth, "expect": expect, "forbid": forbid})
    return out


def q_last_action(worlds: Path, run_id: str, rounds: list[int], want_lost: int) -> list[dict[str, Any]]:
    rdir = _run_dir(worlds, run_id)
    manifest = _read_json(rdir / "manifest.json")
    names = _names(rdir, manifest["current_turn_id"])
    index = _index(rdir)
    out = []
    lost_used = 0
    rng = random.Random(7)
    for n in rounds:
        turns = [e for e in index if e["round"] == n and e["kind"] == "agent_turn"]
        if not turns:
            continue
        lost = [e for e in turns if e["decision_source"] == "model" and e["action_name"] is None]
        acted = [e for e in turns if e["action_name"]]
        pick = None
        if lost and lost_used < want_lost:
            pick = rng.choice(lost)
            lost_used += 1
        elif acted:
            pick = rng.choice(acted)
        if pick is None:
            continue
        aid = pick["acting_agent_id"]
        tid = f"r{n:05d}_end"
        chip = {"page": "run", "run_id": run_id, "run_name": manifest["name"], "live_turn_id": manifest["current_turn_id"], "shown_turn_id": tid, "tab": "turn", "run_state": "paused"}
        if pick["action_name"]:
            expect = [ACTION_SYNONYMS.get(pick["action_name"], [pick["action_name"]])]
            truth = {"agent": aid, "turn_id": pick["turn_id"], "action": pick["action_name"], "ok": pick.get("ok")}
        else:
            expect = [LOST_TOKENS]
            truth = {"agent": aid, "turn_id": pick["turn_id"], "action": None, "lost": True}
        out.append(
            {
                "category": "last_action",
                "run_id": run_id,
                "text": f"What was {_display(names, aid)}'s last action as of the turn I am viewing ({tid})?",
                "chip": chip,
                "truth": truth,
                "expect": expect,
            }
        )
    return out


def q_malformed(worlds: Path, run_id: str, ranges: list[tuple[int, int]]) -> list[dict[str, Any]]:
    rdir = _run_dir(worlds, run_id)
    manifest = _read_json(rdir / "manifest.json")
    index = _index(rdir)
    out = []
    for a, b in ranges:
        count = 0
        for e in index:
            if e["kind"] == "agent_turn" and a <= e["round"] <= b and e["decision_source"] == "model" and e["action_name"] is None:
                if "malformed" in _model_call_statuses(rdir, e["turn_id"]):
                    count += 1
        out.append(
            {
                "category": "malformed_count",
                "run_id": run_id,
                "text": f"How many agent turns were lost because the model's reply was malformed in rounds {a} to {b} (inclusive)? Give the count.",
                "chip": {"page": "run", "run_id": run_id, "run_name": manifest["name"], "live_turn_id": manifest["current_turn_id"], "shown_turn_id": manifest["current_turn_id"], "tab": "record", "run_state": "paused"},
                "truth": {"from": a, "to": b, "malformed": count},
                "expect": [[f"#{count}"]],
            }
        )
    return out


RULE_QUESTIONS = [
    ("prices.move", "In this run, how much compute does a move cost?"),
    ("prices.observe", "In this run, what is the price of an observe action?"),
    ("prices.send", "In this run, how much does sending a message (send) cost?"),
    ("prices.broadcast", "In this run, what does a broadcast cost?"),
    ("prices.absorb", "In this run, what is the price of absorb?"),
    ("upkeep.compute_per_round", "In this run, how much compute does each agent pay as upkeep per round?"),
    ("upkeep.starvation_health_loss", "In this run, how much health does an agent lose when it starves?"),
    ("upgrades.standard_base_compute", "In this run, what is the base compute cost of a standard upgrade?"),
    ("upgrades.attack_base_compute", "In this run, what is the base compute cost of an attack upgrade?"),
    ("upgrades.increments.max_health", "In this run, by how much does one max_health upgrade raise max health?"),
    ("plant_species.*.fruit_energy", "In this run, how much compute (energy) does one fruit carry?"),
    ("messages.max_message_tokens", "In this run, what is the maximum message length in tokens?"),
    ("skills.action_discount", "In this run, what is the skill action discount factor?"),
    ("death.compute_residue_fraction", "In this run, what fraction of a dead agent's compute becomes residue?"),
]


def _rule_value(rules: dict[str, Any], path: str) -> Any:
    node: Any = rules
    for part in path.split("."):
        if part == "*":
            node = next(iter(node.values()))
        else:
            node = node[part]
    return node


def q_rules(worlds: Path, run_id: str, paths: list[str]) -> list[dict[str, Any]]:
    rdir = _run_dir(worlds, run_id)
    manifest = _read_json(rdir / "manifest.json")
    rules = _read_json(rdir / "turns" / manifest["current_turn_id"] / "rules.json")
    out = []
    for path, text in RULE_QUESTIONS:
        if path not in paths:
            continue
        value = _rule_value(rules, path)
        out.append(
            {
                "category": "rule_value",
                "run_id": run_id,
                "text": text,
                "chip": {"page": "run", "run_id": run_id, "run_name": manifest["name"], "live_turn_id": manifest["current_turn_id"], "shown_turn_id": manifest["current_turn_id"], "tab": "rules", "run_state": "paused"},
                "truth": {"path": path, "value": value},
                "expect": [[f"#{value}"]],
            }
        )
    return out


def q_turn_summary(worlds: Path, run_id: str, turn_ids: list[str]) -> list[dict[str, Any]]:
    rdir = _run_dir(worlds, run_id)
    manifest = _read_json(rdir / "manifest.json")
    names = _names(rdir, manifest["current_turn_id"])
    index = {e["turn_id"]: e for e in _index(rdir)}
    out = []
    for tid in turn_ids:
        entry = index[tid]
        events = _events(rdir, tid)
        aid = entry["acting_agent_id"]
        expect: list[list[str]] = [[names[aid], aid]]
        truth: dict[str, Any] = {"turn_id": tid, "agent": aid, "decision_source": entry["decision_source"], "action": entry["action_name"], "ok": entry.get("ok")}
        forbid: list[str] = []
        if entry["action_name"]:
            expect.append(ACTION_SYNONYMS.get(entry["action_name"], [entry["action_name"]]))
            if entry.get("ok") is False:
                expect.append(["fail", "could not", "couldn't", "unsuccessful", "did not succeed", "blocked", "gone", "missed", "nothing to", "no longer", "wasn't there", "not there", "unable", "but"])
                truth["reason"] = next((e["details"].get("result", {}).get("reason") for e in events if e["kind"] == "action"), None)
        elif entry["decision_source"] == "model":
            expect.append(LOST_TOKENS)
        elif entry["decision_source"] == "skipped_unaffordable":
            expect.append(UNAFFORDABLE_TOKENS)
        deaths = [e for e in events if e["kind"] == "death" and e["details"].get("kind") == "agent"]
        for d in deaths:
            victim = d["details"]["entity_id"]
            expect.append([names[victim], victim])
            expect.append(["died", "death", "kill", "dead", "slain", "fell", "perished"])
            truth["death"] = victim
        damage = [e for e in events if e["kind"] == "damage"]
        if damage and not deaths:
            expect.append(["damage", "hit", "struck", "wound", "health", "attack"])
            truth["damage_targets"] = [e["details"].get("target") for e in damage]
        out.append(
            {
                "category": "turn_summary",
                "run_id": run_id,
                "text": "What happened in the turn I am viewing? Two or three sentences.",
                "chip": {"page": "run", "run_id": run_id, "run_name": manifest["name"], "live_turn_id": manifest["current_turn_id"], "shown_turn_id": tid, "tab": "record", "run_state": "paused"},
                "truth": truth,
                "expect": expect,
                "forbid": forbid,
            }
        )
    return out


HELP_QUESTIONS = [
    ("How many agents can a run have?", [["#6"], ["#12"]]),
    ("What does the Step round button do?", [["round"], ["pause", "stops", "then stop"]]),
    ("How can I change what happened in the past of a run?", [["continuation"]]),
    ("What does Recover (pause) do when a run is in the error state?", [["discard", "failed attempt", "last saved", "reload", "re-run", "back to", "paused"]]),
    ("What is upkeep, and what happens when an agent cannot pay it?", [["upkeep"], ["starv"], ["health"]]),
    ("What does the Write missing button in the Storybook tab do?", [["entr", "narrat", "storybook", "turns"], ["cost", "money", "paid", "$", "spend", "budget"]]),
    ("What does the Dictate button do with my speech?", [["transcri", "speech", "whisper", "record", "text"], ["insert", "composer", "never sent", "not sent", "never gets sent", "does not send", "doesn't send", "review", "edit it", "given back"]]),
    ("What are the three resources an agent has, and which one means death at zero?", [["compute"], ["essence"], ["health"]]),
]


def q_help() -> list[dict[str, Any]]:
    return [
        {"category": "help", "run_id": None, "text": text, "chip": {"page": "entry"}, "truth": {"docs": True}, "expect": expect}
        for text, expect in HELP_QUESTIONS
    ]


def _pick_turns(worlds: Path, run_id: str, wanted: dict[str, int]) -> list[str]:
    """Turn ids for the turn_summary category: deaths, attacks, failed actions, lost, unaffordable, upgrades."""
    rdir = _run_dir(worlds, run_id)
    index = _index(rdir)
    buckets: dict[str, list[str]] = {k: [] for k in wanted}
    for e in index:
        if e["kind"] != "agent_turn":
            continue
        events = _events(rdir, e["turn_id"])
        kinds = {x["kind"] for x in events}
        if "death" in kinds and any(x["details"].get("kind") == "agent" for x in events if x["kind"] == "death"):
            buckets.setdefault("death", []).append(e["turn_id"])
        elif "damage" in kinds:
            buckets.setdefault("attack", []).append(e["turn_id"])
        elif e["decision_source"] == "skipped_unaffordable":
            buckets.setdefault("unaffordable", []).append(e["turn_id"])
        elif e["decision_source"] == "model" and e["action_name"] is None:
            buckets.setdefault("lost", []).append(e["turn_id"])
        elif e["action_name"] and e.get("ok") is False:
            buckets.setdefault("failed", []).append(e["turn_id"])
        elif e["action_name"] == "upgrade":
            buckets.setdefault("upgrade", []).append(e["turn_id"])
        elif e["action_name"] == "recover":
            buckets.setdefault("recover", []).append(e["turn_id"])
    rng = random.Random(11)
    out: list[str] = []
    for kind, n in wanted.items():
        pool = buckets.get(kind, [])
        rng.shuffle(pool)
        out.extend(pool[:n])
    return out


def build_questions(worlds: Path) -> list[dict[str, Any]]:
    """The fixed question set (identical across arms)."""
    qs: list[dict[str, Any]] = []
    qs += q_alive_count(worlds, PREDATORS, [3, 8, 13, 19, 20])
    qs += q_alive_count(worlds, FIGHT, [10, 22, 23, 24, 27, 29, 30])
    qs += q_deaths(worlds, PREDATORS, 4)
    qs += q_deaths(worlds, FIGHT, 8)
    qs += q_last_action(worlds, PREDATORS, [2, 5, 9, 12, 16, 19], want_lost=2)
    qs += q_last_action(worlds, FIGHT, [3, 7, 14, 20, 25, 29], want_lost=1)
    qs += q_malformed(worlds, PREDATORS, [(1, 3), (4, 6), (7, 10), (11, 15), (16, 20), (1, 20)])
    qs += q_malformed(worlds, FIGHT, [(1, 5), (6, 10), (11, 15), (16, 20), (21, 25), (26, 30)])
    qs += q_rules(worlds, PREDATORS, ["prices.move", "prices.send", "prices.broadcast", "upkeep.compute_per_round", "upkeep.starvation_health_loss", "upgrades.attack_base_compute", "plant_species.*.fruit_energy"])
    qs += q_rules(worlds, FIGHT, ["prices.observe", "prices.absorb", "upgrades.standard_base_compute", "upgrades.increments.max_health", "messages.max_message_tokens"])
    qs += q_turn_summary(worlds, PREDATORS, _pick_turns(worlds, PREDATORS, {"death": 3, "attack": 2, "lost": 2, "failed": 1}))
    qs += q_turn_summary(worlds, FIGHT, _pick_turns(worlds, FIGHT, {"unaffordable": 2, "upgrade": 1, "recover": 1}))
    qs += q_help()
    for i, q in enumerate(qs, 1):
        q["id"] = f"q{i:03d}"
    return qs


# ---------------------------------------------------------------------------
# Backend lifecycle and HTTP
# ---------------------------------------------------------------------------


class Backend:
    """A backend process for one arm (started with the arm's env, stopped on exit)."""

    def __init__(self, arm: str, worlds: Path, port: int, *, chat: Optional[str] = None, author: Optional[str] = None, narrator: Optional[str] = None) -> None:
        key = ARMS[arm]
        self.port = port
        self.base = f"http://127.0.0.1:{port}"
        self.log = OUT_DIR / f"backend_{arm}_{port}.log"
        env = dict(os.environ)
        env.update(
            {
                "EMPYREAN_API_PORT": str(port),
                "EMPYREAN_WORLDS_DIR": str(worlds),
                "EMPYREAN_WHISPER_PRELOAD": "0",
                "EMPYREAN_MODELS_FILE": str(MODELS_FILE),
                "EMPYREAN_ASSISTANT_MODEL_CHAT": chat or key,
                "EMPYREAN_ASSISTANT_MODEL_AUTHOR": author or key,
                "EMPYREAN_ASSISTANT_MODEL_NARRATOR": narrator or key,
                "EMPYREAN_ASSISTANT_MODEL_SUMMARIZER": "claude-cli-haiku-assistant",
                "EMPYREAN_ASSISTANT_CHAT_BUDGET_USD": "40",
                "EMPYREAN_ASSISTANT_STORYBOOK_BUDGET_USD": "5",
                "EMPYREAN_ASSISTANT_STORY_BUDGET_USD": "5",
                "EMPYREAN_ASSISTANT_GLOBAL_BUDGET_USD": "60",
            }
        )
        env.pop("EMPYREAN_ALLOW_LIVE", None)
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        self._log = open(self.log, "ab")
        self.proc = subprocess.Popen([str(PYTHON), "-m", "empyrean.main"], cwd=str(REPO / "backend"), env=env, stdout=self._log, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                status, _ = self.request("GET", "/api/health")
                if status == 200:
                    return
            except Exception:  # noqa: BLE001
                pass
            if self.proc.poll() is not None:
                raise SystemExit(f"backend exited early; see {self.log}")
            time.sleep(0.5)
        raise SystemExit(f"backend did not answer on {self.base}; see {self.log}")

    def stop(self) -> None:
        if self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
        self._log.close()

    def request(self, method: str, path: str, body: Any = None, timeout: float = 60) -> tuple[int, Any]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                return exc.code, json.loads(raw)
            except ValueError:
                return exc.code, {"error": raw.decode(errors="replace")}


def ledger_lines(worlds: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for path in list(worlds.glob("*/runs/*/assistant/usage.jsonl")) + [worlds / "_assistant" / "usage.jsonl"]:
        if path.is_file():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    out.append(json.loads(line))
    return out


def arm_spend(worlds: Path) -> float:
    return round(sum(float(l.get("cost_usd") or 0.0) for l in ledger_lines(worlds)), 4)


def calls_for(lines: list[dict[str, Any]], *, job_id: Optional[str] = None, story_id: Optional[str] = None, conversation_id: Optional[str] = None) -> list[dict[str, Any]]:
    out = []
    for l in lines:
        if job_id and l.get("job_id") != job_id:
            continue
        if story_id and l.get("story_id") != story_id:
            continue
        if conversation_id and l.get("conversation_id") != conversation_id:
            continue
        out.append(
            {
                "ts": l.get("ts"),
                "profile": l.get("profile"),
                "model_key": l.get("model_key"),
                "response_model": l.get("response_model"),
                "status": l.get("status"),
                "error_code": l.get("error_code"),
                "cost_usd": l.get("cost_usd"),
                "latency_ms": l.get("latency_ms"),
                "attempts": l.get("attempts"),
                "step": l.get("step"),
                "batch_size": l.get("batch_size"),
                "input_tokens": (l.get("usage") or {}).get("billed_input_tokens"),
                "cache_read_tokens": (l.get("usage") or {}).get("cache_read_tokens"),
                "cache_creation_tokens": (l.get("usage") or {}).get("cache_creation_tokens"),
                "output_tokens": (l.get("usage") or {}).get("output_tokens"),
            }
        )
    return out


def require_live() -> None:
    if os.environ.get("EMPYREAN_ALLOW_LIVE") != "1":
        raise SystemExit("refusing to run: set EMPYREAN_ALLOW_LIVE=1 to allow live model spend")


def save(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def load(path: Path, default: Any) -> Any:
    return _read_json(path) if path.is_file() else default


# ---------------------------------------------------------------------------
# chat arm
# ---------------------------------------------------------------------------


def ask(backend: Backend, run_id: Optional[str], text: str, chip: dict[str, Any], *, timeout: float = 150) -> dict[str, Any]:
    status, conv = backend.request("POST", "/api/assistant/conversations", {"run_id": run_id, "title": text[:60]})
    if status != 201:
        return {"http": status, "error": conv}
    cid = conv["conversation_id"]
    t0 = time.monotonic()
    status, acc = backend.request("POST", f"/api/assistant/conversations/{cid}/messages", {"text": text, "context": chip, "include_context": True})
    if status != 202:
        return {"http": status, "error": acc, "conversation_id": cid}
    view: Any = None
    progress_seen: list[str] = []
    while time.monotonic() - t0 < timeout:
        time.sleep(0.7)
        _s, view = backend.request("GET", f"/api/assistant/conversations/{cid}")
        job = (view or {}).get("job") or {}
        msgs = (view or {}).get("messages") or []
        last = msgs[-1] if msgs else {}
        line = f"{time.monotonic() - t0:.1f}s job.elapsed_s={job.get('elapsed_s')} progress={last.get('progress') or job.get('progress')!r}"
        if not progress_seen or progress_seen[-1].split(" ", 1)[1] != line.split(" ", 1)[1]:
            progress_seen.append(line)
        if (job.get("job_id") == acc["job_id"] and job.get("status") not in ("queued", "running")) or last.get("status") in ("done", "error", "cancelled", "interrupted"):
            break
    wall = time.monotonic() - t0
    msgs = (view or {}).get("messages") or []
    answer = next((m for m in msgs if m.get("message_id") == acc["message_id"]), msgs[-1] if msgs else {})
    brief = next((b for b in (view or {}).get("briefs") or [] if b.get("brief_id") == answer.get("brief_id")), None)
    return {"conversation_id": cid, "job_id": acc["job_id"], "wall_s": round(wall, 1), "message": answer, "brief": brief, "job": (view or {}).get("job"), "progress_seen": progress_seen}


def summarise_message(res: dict[str, Any], lines: list[dict[str, Any]]) -> dict[str, Any]:
    m = res.get("message") or {}
    steps = m.get("steps") or []
    calls = calls_for(lines, job_id=res.get("job_id"))
    auto_label = f"turn {m.get('as_of_turn_id')}" if m.get("as_of_turn_id") else None
    model_refs = [r for r in (m.get("refs") or []) if not (auto_label and r.get("kind") == "turn" and r.get("label") == auto_label)]
    return {
        "status": m.get("status"),
        "error_code": m.get("error_code"),
        "error": m.get("error"),
        "text": m.get("text") or "",
        "refs": m.get("refs") or [],
        "model_refs": len(model_refs),
        "sources": m.get("sources") or [],
        "as_of": m.get("as_of_turn_id"),
        "cost_usd": round(float(m.get("cost_usd") or 0.0), 4),
        "wall_s": res.get("wall_s"),
        "steps": len(steps),
        "step_kinds": [s.get("kind") for s in steps],
        "tools": [t.get("name") for s in steps for t in (s.get("tool_calls") or [])],
        "step_elapsed_s": [round((s.get("elapsed_ms") or 0) / 1000, 1) for s in steps],
        "step_cache_reads": [s.get("cache_read_tokens") for s in steps],
        "repair_steps": sum(1 for s in steps if s.get("kind") in ("repair", "brief-repair") or s.get("error_code") == "schema_mismatch"),
        "cli_malformed_calls": sum(1 for c in calls if c["status"] == "malformed"),
        "calls": calls,
        "brief": res.get("brief"),
        "progress_seen": res.get("progress_seen") or [],
    }


def run_chat(args: argparse.Namespace) -> None:
    require_live()
    worlds = Path(args.worlds_dir or (DEFAULT_WORLDS / args.arm))
    questions = build_questions(worlds)
    if args.categories:
        questions = [q for q in questions if q["category"] in args.categories]
    if args.limit:
        questions = questions[: args.limit]
    out_path = OUT_DIR / f"chat_{args.arm}.json"
    results = load(out_path, {"arm": args.arm, "model_key": ARMS[args.arm], "worlds_dir": str(worlds), "items": []})
    done_ids = {r["id"] for r in results["items"]}
    todo = [q for q in questions if q["id"] not in done_ids]
    print(f"[{args.arm}] {len(todo)} questions to ask ({len(done_ids)} already done); spend so far ${arm_spend(worlds):.4f}; cap ${args.max_spend:.2f}")
    if not todo:
        return
    backend = Backend(args.arm, worlds, args.port)
    try:
        for q in todo:
            spent = arm_spend(worlds)
            if spent >= args.max_spend:
                print(f"[{args.arm}] spend cap reached (${spent:.4f} >= ${args.max_spend:.2f}); stopping")
                break
            res = ask(backend, q["run_id"], q["text"], q["chip"])
            lines = ledger_lines(worlds)
            summary = summarise_message(res, lines)
            ok, missing = score(summary["text"], q["expect"], q.get("forbid"))
            item = {**{k: q[k] for k in ("id", "category", "run_id", "text", "truth", "expect")}, "forbid": q.get("forbid", []), "chip": q["chip"], "correct": ok and summary["status"] == "done", "missing": missing, **summary}
            results["items"].append(item)
            results["spend_usd"] = arm_spend(worlds)
            save(out_path, results)
            flag = "OK " if item["correct"] else "MISS"
            print(f"  {q['id']} {q['category']:15s} {flag} {summary['wall_s']:5.1f}s steps={summary['steps']} ${summary['cost_usd']:.3f} malformed={summary['cli_malformed_calls']} repair={summary['repair_steps']} refs={summary['model_refs']} | {summary['text'][:110].replace(chr(10), ' ')}")
            if not item["correct"]:
                print(f"       expected {q['expect']} truth={q['truth']} missing={missing}")
    finally:
        backend.stop()
    print(f"[{args.arm}] done; arm spend ${arm_spend(worlds):.4f}")


# ---------------------------------------------------------------------------
# Faithfulness checks (narrator, author)
# ---------------------------------------------------------------------------

KILL_WORDS = re.compile(r"\b(killed|slew|slain|slaying|finished off|struck down|cut down|murdered|felled|took .{0,20} life)\b", re.IGNORECASE)
LOST_WORDS = re.compile(r"(lost|garbled|malformed|no action|failed to act|skipped|could not|couldn't|unable|silent|froze|frozen|paralys|nothing happened|did not act|didn't act|invalid|error|unread|indecipher|incoherent|no decision|hesitat|stalled|faltered|misfire|jumbled|scrambled|blank|empty|afford|halted|inaction|without acting|never came|came to nothing|wasted|squandered)", re.IGNORECASE)


def _flatten_strings(value: Any, out: list[str]) -> None:
    if isinstance(value, dict):
        for v in value.values():
            _flatten_strings(v, out)
    elif isinstance(value, list):
        for v in value:
            _flatten_strings(v, out)
    elif isinstance(value, (str, int, float)) and not isinstance(value, bool):
        out.append(str(value))


def _digest_numbers(digest: Any) -> set[str]:
    strings: list[str] = []
    _flatten_strings(digest, strings)
    nums: set[str] = set()
    for s in strings:
        for tok in re.findall(r"-?\d+(?:\.\d+)?", s):
            f = float(tok)
            nums.add(f"{f:g}")
            nums.add(f"{round(f):d}")
            nums.add(f"{f:.1f}")
            nums.add(f"{f:.2f}")
    return nums


def check_faithfulness(text: str, digest: Any, names: dict[str, str], *, allowed_names: Optional[set[str]] = None) -> dict[str, Any]:
    """Names, numbers, deaths/killers and lost turns of ``text`` against ``digest`` (the payload the
    model was given).  ``allowed_names``: names legitimately available from other context (the
    cast of an opening, the previous entries)."""
    digest_json = json.dumps(digest, ensure_ascii=False)
    digest_lower = digest_json.lower()
    problems: list[str] = []
    mentioned = {aid: name for aid, name in names.items() if re.search(rf"\b{re.escape(name)}\b", text, re.IGNORECASE)}
    for aid, name in mentioned.items():
        if name.lower() not in digest_lower and aid.lower() not in digest_lower and not (allowed_names and name in allowed_names):
            problems.append(f"name not in digest: {name} ({aid})")
    numbers = _digest_numbers(digest)
    stripped = re.sub(r"r\d{5}(_t\d{2}_a\d{2}|_end|_init)", " ", text)
    for tok in re.findall(r"(?<![\w.])-?\d+(?:\.\d+)?(?![\w])", stripped):
        f = float(tok)
        if f"{f:g}" not in numbers and f"{round(f):d}" not in numbers and f"{f:.1f}" not in numbers:
            problems.append(f"number not in digest: {tok}")
    digests = digest if isinstance(digest, list) else [digest]
    deaths = [d for dg in digests if isinstance(dg, dict) and isinstance(dg.get("deaths"), list) for d in dg["deaths"] if isinstance(d, dict)]
    damage = [x for dg in digests if isinstance(dg, dict) and isinstance(dg.get("damage"), list) for x in dg["damage"]]
    if not deaths and any(isinstance(dg, dict) and isinstance(dg.get("deaths"), int) and dg["deaths"] > 0 for dg in digests):
        damage = damage or [{"card": True}]  # a run card with deaths: kill words are legitimate
    for d in deaths:
        victim = names.get(d.get("id"), d.get("id"))
        if victim and not re.search(rf"\b{re.escape(str(victim))}\b", text, re.IGNORECASE) and str(d.get("id")) not in text:
            problems.append(f"death not told: {victim}")
        if d.get("by"):
            killer = names.get(d["by"], d["by"])
            if not re.search(rf"\b{re.escape(str(killer))}\b", text, re.IGNORECASE):
                problems.append(f"killer not named: {killer} -> {victim}")
        elif d.get("cause") == "starvation":
            for aid, name in names.items():
                if re.search(rf"{re.escape(name)}\W{{0,3}}(had )?(killed|slew|finished|struck down) \w{{0,12}}\W{{0,3}}{re.escape(str(victim))}", text, re.IGNORECASE):
                    problems.append(f"starvation death attributed to {name}")
    if KILL_WORDS.search(text) and not deaths and not damage:
        problems.append("kill words without any death/damage in the digest")
    lost = [dg for dg in digests if isinstance(dg, dict) and (dg.get("lost") or dg.get("skipped") or dg.get("problem") or dg.get("no_action_reason"))]
    if lost and not LOST_WORDS.search(text):
        problems.append("lost/skipped turn not told as such")
    # Invented names: a capitalised word that is not a cast name, not in the digest, not at a
    # sentence start and not a known common word (an entry naming survivors "Nyx, Iris and Thalos"
    # when the digest lists a04/a06/a07 is the case this catches).
    known = {n.lower() for n in names.values()} | {n.lower() for n in (allowed_names or set())}
    for m in re.finditer(r"(?<![.!?\n\"“]\s)(?<!^)\b([A-Z][a-z]{2,})\b", text):
        word = m.group(1)
        if word.lower() in known or word.lower() in digest_lower or word in PROPER_NOUN_STOPLIST:
            continue
        problems.append(f"unknown name (not in cast or digest): {word}")
    return {"ok": not problems, "problems": problems, "names_mentioned": sorted(mentioned.values())}


PROPER_NOUN_STOPLIST = set(
    "The A An And But Or Nor For Yet So If When While Where What Who Whom Whose Which How Why Then Than That This These Those There Here "
    "Round Rounds Turn Turns Empyrean Storybook Arena Chapter Opening Interlude Compute Essence Health Attack Speed Vision Query Observe Absorb Move Upgrade "
    "Aster Eos Boreas Cyrene Damaris Ferrin Galene Halcyon Iole Jarek Kallias Lysandra "
    "Its Their Her His She He They Its One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve None Nothing Every Each All Both Some Any "
    "Before After During Until Once Now Still Yet Again Only Even Just Meanwhile Elsewhere Instead Later Earlier Soon Already Never Always Perhaps "
    "Reasoning Believing Hoping Fearing Knowing Seeing Thinking Blind Hungry Wary Silent Dead Alive Lost Prey Hunter Hunters Predator Predators "
    "North South East West Left Right Up Down Land Water Mountain Fruit Plant Seed Residue Upkeep Starvation Damage Death".split()
)


def import_digest(worlds: Path) -> Any:
    """``empyrean.assistant.digest`` bound to ``worlds`` (set before the first import)."""
    os.environ["EMPYREAN_WORLDS_DIR"] = str(worlds)
    sys.path.insert(0, str(REPO / "backend"))
    from empyrean.assistant import digest  # noqa: PLC0415

    return digest


# ---------------------------------------------------------------------------
# narrator arm
# ---------------------------------------------------------------------------

NARRATOR_TURNS = [f"r00003_t{i:02d}_a{a:02d}" for i, a in [(1, 1), (2, 5), (3, 7), (4, 3), (5, 4), (6, 6), (7, 8), (8, 2)]] + ["r00003_end", "r00019_t01_a01", "r00019_t02_a05", "r00019_end"]


def run_narrator(args: argparse.Namespace) -> None:
    require_live()
    worlds = Path(args.worlds_dir or (DEFAULT_WORLDS / args.arm))
    run_id = PREDATORS
    rdir = _run_dir(worlds, run_id)
    names = _names(rdir, _read_json(rdir / "manifest.json")["current_turn_id"])
    out_path = OUT_DIR / f"narrator_{args.arm}.json"
    spent_before = arm_spend(worlds)
    backend = Backend(args.arm, worlds, args.port)
    t0 = time.monotonic()
    try:
        status, resp = backend.request("POST", f"/api/runs/{run_id}/assistant/storybook/generate", {"turn_ids": NARRATOR_TURNS, "include_opening": True})
        print(f"[{args.arm}] generate -> {status} queued={resp.get('queued') if isinstance(resp, dict) else resp}")
        job_id = resp.get("job_id") if isinstance(resp, dict) else None
        view: Any = None
        while time.monotonic() - t0 < 600:
            time.sleep(2)
            _s, view = backend.request("GET", f"/api/runs/{run_id}/assistant/storybook")
            st = view["status"]
            print(f"   {time.monotonic() - t0:5.0f}s entries={st['entry_count']} pending={st['pending_count']} in_flight={st['in_flight']} spend=${st['spend']['spent_usd']:.4f} err={st.get('last_error')}")
            if not st["in_flight"] and st["pending_count"] == 0:
                break
        wall = time.monotonic() - t0
    finally:
        backend.stop()
    digest = import_digest(worlds)
    entries = {e["turn_id"]: e for e in view["entries"]}
    if view.get("opening"):
        entries["opening"] = view["opening"]
    results = []
    for tid in ["opening"] + NARRATOR_TURNS:
        entry = entries.get(tid)
        if entry is None:
            results.append({"turn_id": tid, "written": False})
            continue
        if tid == "opening":
            dg = digest.opening_digest(run_id)
            check = check_faithfulness(entry["text"], dg, names)
        else:
            dg = digest.turn_digest(run_id, tid, max_chars=1500)
            check = check_faithfulness(entry["text"], dg, names)
        results.append({"turn_id": tid, "written": True, "kind": entry["kind"], "text": entry["text"], "batch_id": entry.get("batch_id"), "cost_usd": entry.get("cost_usd"), "response_model": entry.get("response_model"), "digest_text": dg.get("text"), "faithful": check["ok"], "problems": check["problems"], "sentences": len(re.findall(r"[.!?](\s|$)", entry["text"]))})
    lines = ledger_lines(worlds)
    calls = [c for c in calls_for(lines, job_id=job_id)] if job_id else [c for c in calls_for(lines) if c["profile"] == "narrator"]
    data = {
        "arm": args.arm,
        "model_key": ARMS[args.arm],
        "run_id": run_id,
        "turn_ids": NARRATOR_TURNS,
        "wall_s": round(wall, 1),
        "spend_usd": round(arm_spend(worlds) - spent_before, 4),
        "calls": calls,
        "entries": results,
        "written": sum(1 for r in results if r["written"]),
        "faithful": sum(1 for r in results if r.get("faithful")),
        "status": view["status"],
    }
    save(out_path, data)
    print(f"[{args.arm}] narrator: {data['written']}/{len(results)} entries written, {data['faithful']} faithful, {len(calls)} calls, ${data['spend_usd']:.4f}, {wall:.0f} s")
    for r in results:
        if r.get("written") and not r["faithful"]:
            print(f"   {r['turn_id']}: {r['problems']}")


def write_ab_pairs(args: argparse.Namespace) -> None:
    """Blind A/B file: 10 turns, entry texts from both arms in random order (seeded); the judge
    writes 'A' or 'B' per pair into ab_judgements.json; ``report`` unblinds."""
    a = load(OUT_DIR / "narrator_haiku.json", None)
    b = load(OUT_DIR / "narrator_sonnet.json", None)
    if not a or not b:
        raise SystemExit("both narrator arms must have run first")
    ea = {e["turn_id"]: e for e in a["entries"] if e.get("written")}
    eb = {e["turn_id"]: e for e in b["entries"] if e.get("written")}
    common = [t for t in ["opening"] + NARRATOR_TURNS if t in ea and t in eb][:10]
    rng = random.Random(2026)
    pairs = []
    for tid in common:
        flip = rng.random() < 0.5
        left, right = (("sonnet", eb[tid]["text"]), ("haiku", ea[tid]["text"])) if flip else (("haiku", ea[tid]["text"]), ("sonnet", eb[tid]["text"]))
        pairs.append({"turn_id": tid, "digest_text": ea[tid].get("digest_text"), "A": left[1], "B": right[1], "_key": {"A": left[0], "B": right[0]}})
    blind = [{k: v for k, v in p.items() if k != "_key"} for p in pairs]
    save(OUT_DIR / "ab_pairs_blind.json", blind)
    save(OUT_DIR / "ab_pairs_key.json", [{"turn_id": p["turn_id"], **p["_key"]} for p in pairs])
    print(f"wrote {len(pairs)} blind pairs to {OUT_DIR / 'ab_pairs_blind.json'}; judge them into {OUT_DIR / 'ab_judgements.json'} as [{{turn_id, choice: 'A'|'B'|'tie', note}}]")


# ---------------------------------------------------------------------------
# author arm
# ---------------------------------------------------------------------------


def _wait_story(backend: Backend, run_id: str, story_id: str, until: Any, timeout: float = 600) -> dict[str, Any]:
    t0 = time.monotonic()
    view: Any = None
    while time.monotonic() - t0 < timeout:
        time.sleep(2)
        _s, view = backend.request("GET", f"/api/runs/{run_id}/assistant/stories/{story_id}")
        if until(view):
            return view
        s = view["session"]
        j = view.get("job") or {}
        print(f"   {time.monotonic() - t0:5.0f}s status={s['status']} chapters={s['chapters_done']}/{s['chapters_total']} job={j.get('status')} {j.get('progress', '')} spent=${s['spent_usd']:.4f} err={s.get('error')}")
    return view


def run_author(args: argparse.Namespace) -> None:
    require_live()
    worlds = Path(args.worlds_dir or (DEFAULT_WORLDS / args.arm))
    run_id = PREDATORS
    rdir = _run_dir(worlds, run_id)
    names = _names(rdir, _read_json(rdir / "manifest.json")["current_turn_id"])
    out_path = OUT_DIR / f"author_{args.arm}.json"
    spent_before = arm_spend(worlds)
    backend = Backend(args.arm, worlds, args.port)
    data: dict[str, Any] = {"arm": args.arm, "model_key": ARMS[args.arm], "run_id": run_id, "briefs": [], "chapters": []}
    try:
        picks = {"genre": "chronicle", "tone": "measured", "vividness": 3, "pov": "chronicler", "unit": "turn", "language": "en", "from_turn_id": None, "to_turn_id": "r00003_end"}
        t0 = time.monotonic()
        status, view = backend.request("POST", f"/api/runs/{run_id}/assistant/stories", {"picks": picks, "text": "Just write it: a tight chronicle of the hunt in the first three rounds."})
        print(f"[{args.arm}] create story -> {status}")
        story_id = view["session"]["story_id"]
        view = _wait_story(backend, run_id, story_id, lambda v: v["session"]["status"] in ("brief_pending", "error") or (v["session"]["status"] == "interviewing" and (v.get("job") or {}).get("status") in ("done", "error", None) and len(v["session"]["messages"]) >= 2))
        brief_wall = time.monotonic() - t0
        session = view["session"]
        brief = session.get("brief")
        lines = ledger_lines(worlds)
        calls = [c for c in calls_for(lines, story_id=story_id) if c["profile"] == "author"]
        brief_record = {
            "kind": "story_brief",
            "wall_s": round(brief_wall, 1),
            "status": session["status"],
            "messages": [{"role": m["role"], "text": m["text"][:400], "status": m.get("status"), "options": m.get("ask_options")} for m in session["messages"]],
            "brief": {k: brief[k] for k in ("title", "premise", "style_guide", "cast_map", "faithful", "embellished", "job_budget_usd", "estimate_turn", "estimate_round")} if brief else None,
            "chapter_plan_len": len(brief["chapter_plan"]) if brief else None,
            "calls": calls,
            "cli_malformed_calls": sum(1 for c in calls if c["status"] == "malformed"),
            "attempts": len(calls),
        }
        if brief:
            card = view.get("run_card") or {}
            cast_ids = {c["agent_id"] for c in card.get("cast", [])}
            mapped = {c["agent_id"] for c in brief["cast_map"]}
            brief_record["cast_map_covers_cast"] = cast_ids <= mapped
            brief_record["cast_map_unknown_ids"] = sorted(mapped - cast_ids)
            brief_record["premise_check"] = check_faithfulness(brief["premise"] + " " + brief["title"], card, names)
        data["briefs"].append(brief_record)
        if brief and args.change_message:
            status, view = backend.request("POST", f"/api/runs/{run_id}/assistant/stories/{story_id}/messages", {"text": args.change_message})
            t1 = time.monotonic()
            view = _wait_story(backend, run_id, story_id, lambda v: v["session"]["status"] in ("brief_pending", "error") or ((v.get("job") or {}).get("status") in ("done", "error") and v["session"]["status"] != "interviewing"))
            session = view["session"]
            brief2 = session.get("brief")
            lines = ledger_lines(worlds)
            calls2 = [c for c in calls_for(lines, story_id=story_id) if c["profile"] == "author" and c not in calls]
            rec2 = {"kind": "story_brief_change", "wall_s": round(time.monotonic() - t1, 1), "status": session["status"], "brief": {k: brief2[k] for k in ("title", "premise", "style_guide", "cast_map", "faithful", "embellished")} if brief2 else None, "calls": calls2, "cli_malformed_calls": sum(1 for c in calls2 if c["status"] == "malformed"), "attempts": len(calls2), "superseded": len(session.get("superseded_briefs") or [])}
            if brief2:
                rec2["premise_check"] = check_faithfulness(brief2["premise"] + " " + brief2["title"], view.get("run_card") or {}, names)
            data["briefs"].append(rec2)
            brief = brief2
        if brief and not args.briefs_only:
            t2 = time.monotonic()
            status, view = backend.request("POST", f"/api/runs/{run_id}/assistant/stories/{story_id}/approve", {"brief_id": brief["brief_id"], "unit": "turn", "generate_all": False})
            print(f"[{args.arm}] approve -> {status}")
            view = _wait_story(backend, run_id, story_id, lambda v: v["session"]["chapters_done"] >= 3 and (v.get("job") is None or v["job"]["status"] not in ("queued", "running")) or v["session"]["status"] in ("error", "paused", "complete"))
            chapters_wall = time.monotonic() - t2
            backend.request("POST", f"/api/runs/{run_id}/assistant/stories/{story_id}/cancel")
            digest = import_digest(worlds)
            lines = ledger_lines(worlds)
            for ch in view["chapters"][:3]:
                if ch["kind"] == "opening":
                    dg = digest.opening_digest(run_id)
                    allowed = set(names.values())
                else:
                    dg = [digest.turn_digest(run_id, t, max_chars=1500) for t in ch["turn_ids"]]
                    allowed = set()
                check = check_faithfulness(ch["text"], dg, names, allowed_names=allowed)
                data["chapters"].append({"number": ch["number"], "kind": ch["kind"], "title": ch["title"], "turn_ids": ch["turn_ids"], "words": len(ch["text"].split()), "text": ch["text"], "digest_text": " ".join(d.get("text", "") for d in (dg if isinstance(dg, list) else [dg])), "cost_usd": ch.get("cost_usd"), "response_model": ch.get("response_model"), "faithful": check["ok"], "problems": check["problems"]})
            data["chapter_calls"] = [c for c in calls_for(lines, story_id=story_id) if c["profile"] == "author" and c not in calls]
            data["chapters_wall_s"] = round(chapters_wall, 1)
            _s, export = backend.request("GET", f"/api/runs/{run_id}/assistant/stories/{story_id}/export")
            data["export_chars"] = len((export or {}).get("markdown") or "")
        data["story_id"] = story_id
        data["final_status"] = view["session"]["status"]
    finally:
        backend.stop()
    data["spend_usd"] = round(arm_spend(worlds) - spent_before, 4)
    save(out_path, data)
    print(f"[{args.arm}] author: briefs={len(data['briefs'])} chapters={len(data['chapters'])} faithful={sum(1 for c in data['chapters'] if c['faithful'])} ${data['spend_usd']:.4f}")
    for b in data["briefs"]:
        print(f"   brief {b['status']} {b['wall_s']}s attempts={b['attempts']} malformed={b['cli_malformed_calls']} title={(b.get('brief') or {}).get('title')!r}")
    for c in data["chapters"]:
        print(f"   ch{c['number']} {c['kind']:9s} {c['words']:4d} words faithful={c['faithful']} {c['problems']}")


# ---------------------------------------------------------------------------
# briefs arm
# ---------------------------------------------------------------------------

BRIEF_COMMANDS = [
    {
        "id": "b1_create_arena",
        "text": "Set up a small arena from this vibe: six desperate hunters in a cramped pit, low on food, itching for a fight. Keep it cheap: fake agents.",
        "expect_type": "create_run",
        "check": lambda action, brief: action.get("agent_count") == 6 and brief["validation"]["ok"] and len(brief["validation"].get("setup_diff") or []) > 1,
        "approve": True,
    },
    {
        "id": "b2_step_rounds",
        "text": "Step 2 rounds.",
        "expect_type": "run_command",
        "check": lambda action, brief: action.get("command") == "step_round" and action.get("rounds") == 2 and action.get("run_id") == PREDATORS and brief["validation"]["ok"] and any("live" in w.lower() or "paid" in w.lower() for w in brief["validation"].get("warnings") or []),
        "approve": False,
    },
    {
        "id": "b3_set_health",
        "text": "Set Eos's health to 5.",
        "expect_type": "stage_interventions",
        "check": lambda action, brief: len(action.get("interventions") or []) == 1 and action["interventions"][0].get("type") == "set_stat" and action["interventions"][0].get("entity_id") == "a05" and action["interventions"][0].get("field", "").endswith("health") and float(action["interventions"][0].get("value")) == 5 and brief["validation"]["ok"],
        "approve": True,
    },
    {
        "id": "b4_voice",
        "text": "Stage a voice from nowhere to all agents saying: The rains come tomorrow.",
        "expect_type": "stage_interventions",
        "check": lambda action, brief: len(action.get("interventions") or []) == 1 and action["interventions"][0].get("type") == "voice" and (action["interventions"][0].get("recipients") or {}).get("mode") == "broadcast_all" and "rains come tomorrow" in action["interventions"][0].get("text", "").lower() and brief["validation"]["ok"],
        "approve": True,
    },
    {
        "id": "b5_continuation",
        "text": "Create a continuation from the end of round 10 named 'fork ten'.",
        "expect_type": "create_continuation",
        "check": lambda action, brief: action.get("from_turn_id") == "r00010_end" and (action.get("name") or "").lower().strip("'\"") == "fork ten" and action.get("run_id") == PREDATORS and brief["validation"]["ok"],
        "approve": False,
    },
    {
        "id": "b6_refuse_or_clarify",
        "text": "Rewrite round 3 so that Boreas survives.",
        "expect_type": None,  # an answer / ask, or a create_continuation brief; never an edit of the past
        "check": None,
        "approve": False,
    },
]


def render_briefs(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    node = shutil.which("node")
    if node is None:
        return [{"lines": [], "approve_label": "", "error": "node not found"} for _ in items]
    proc = subprocess.run([node, str(REPO / "qa" / "render_brief.mjs")], input=json.dumps(items).encode(), capture_output=True, cwd=str(REPO), timeout=120)
    if proc.returncode != 0:
        return [{"lines": [], "approve_label": "", "error": proc.stderr.decode(errors="replace")[-400:]} for _ in items]
    return json.loads(proc.stdout.decode())


def run_briefs(args: argparse.Namespace) -> None:
    require_live()
    worlds = Path(args.worlds_dir or (DEFAULT_WORLDS / args.arm))
    run_id = PREDATORS
    rdir = _run_dir(worlds, run_id)
    manifest = _read_json(rdir / "manifest.json")
    chip = {"page": "run", "run_id": run_id, "run_name": manifest["name"], "live_turn_id": manifest["current_turn_id"], "shown_turn_id": manifest["current_turn_id"], "tab": "god", "run_state": "paused"}
    out_path = OUT_DIR / f"briefs_{args.arm}.json"
    data = load(out_path, {"arm": args.arm, "model_key": ARMS[args.arm], "run_id": run_id, "items": []})
    done = {i["id"] for i in data["items"]}
    commands = [c for c in BRIEF_COMMANDS if c["id"] not in done]
    if args.only:
        commands = [c for c in commands if c["id"] in args.only]
    if not commands:
        print("nothing to do")
        return
    spent_before = arm_spend(worlds)
    backend = Backend(args.arm, worlds, args.port)
    try:
        for cmd in commands:
            res = ask(backend, run_id, cmd["text"], chip)
            lines = ledger_lines(worlds)
            summary = summarise_message(res, lines)
            brief = summary.get("brief")
            action = (brief or {}).get("action") or {}
            action_type = (brief or {}).get("action_type")
            if cmd["expect_type"] is None:
                passed = summary["status"] == "done" and (brief is None or action_type == "create_continuation")
                verdict = "answer/ask" if brief is None else f"brief {action_type}"
            else:
                passed = bool(brief) and action_type == cmd["expect_type"] and brief.get("status") == "pending" and bool(cmd["check"](action, brief)) if brief else False
                verdict = f"brief {action_type} ({(brief or {}).get('status')})" if brief else f"no brief ({summary['step_kinds']})"
            item: dict[str, Any] = {"id": cmd["id"], "text": cmd["text"], "expect_type": cmd["expect_type"], "passed": passed, "verdict": verdict, **{k: summary[k] for k in ("status", "error_code", "text", "cost_usd", "wall_s", "steps", "step_kinds", "tools", "repair_steps", "cli_malformed_calls", "calls", "step_cache_reads")}}
            if brief:
                item["brief"] = {k: brief.get(k) for k in ("brief_id", "status", "title", "summary", "steps", "warnings", "action", "action_raw", "action_type", "target_run_id")}
                item["validation"] = brief.get("validation")
                rendered = render_briefs([{"action": brief.get("action"), "run_names": {run_id: manifest["name"]}, "on_screen_run_id": run_id, "run_state": "paused"}])[0]
                item["rendered"] = rendered
                if passed and cmd["approve"]:
                    st, resp = backend.request("POST", f"/api/assistant/conversations/{res['conversation_id']}/briefs/{brief['brief_id']}/approve", {"validated_against_turn_id": brief["validation"].get("validated_against_turn_id")})
                    eff = (resp or {}).get("brief") or {}
                    item["approve"] = {"http": st, "status": eff.get("status"), "effect": eff.get("effect"), "error": eff.get("error")}
            data["items"].append(item)
            data["spend_usd"] = round(arm_spend(worlds) - spent_before, 4)
            save(out_path, data)
            print(f"  {cmd['id']:22s} {'PASS' if passed else 'FAIL'} {summary['wall_s']:5.1f}s steps={summary['steps']} ${summary['cost_usd']:.3f} malformed={summary['cli_malformed_calls']} repair={summary['repair_steps']} -> {verdict}")
            if brief:
                print(f"       action={json.dumps(brief.get('action'))[:300]}")
                print(f"       rendered={item.get('rendered', {}).get('lines')} problems={[p.get('message') for p in (brief.get('validation') or {}).get('problems', [])]}")
                if item.get("approve"):
                    print(f"       approve={item['approve']['http']} {item['approve']['status']} {(item['approve'].get('effect') or {}).get('message')}")
            else:
                print(f"       text={summary['text'][:200]!r}")
    finally:
        backend.stop()
    print(f"[{args.arm}] briefs done; spend ${data.get('spend_usd', 0):.4f}")


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------

CATEGORY_GROUPS = {
    "Help and controls questions": ["help"],
    "Run analysis (state, entity, turns, trends)": ["alive_count", "deaths", "last_action", "rule_value", "turn_summary"],
    "Log interpretation (errors, rejected replies)": ["malformed_count"],
}


def _chat_stats(items: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(items)
    correct = sum(1 for i in items if i["correct"])
    walls = [float(i["wall_s"]) for i in items if i.get("wall_s") is not None]
    calls = [c for i in items for c in i["calls"]]
    malformed = sum(1 for c in calls if c["status"] == "malformed")
    repairs = sum(i["repair_steps"] for i in items)
    errors = sum(1 for i in items if i["status"] != "done")
    cost = sum(i["cost_usd"] for i in items)
    cache_zero_late = sum(1 for i in items for k, v in enumerate(i["step_cache_reads"]) if k >= 1 and not v)
    return {
        "n": n,
        "correct": correct,
        "accuracy": round(100.0 * correct / n, 1) if n else None,
        "with_refs": sum(1 for i in items if i["model_refs"] > 0),
        "p50_s": percentile(walls, 0.5),
        "p90_s": percentile(walls, 0.9),
        "mean_steps": round(statistics.mean(i["steps"] for i in items), 2) if items else None,
        "multi_step": sum(1 for i in items if i["steps"] > 1),
        "calls": len(calls),
        "cli_malformed": malformed,
        "repair_steps": repairs,
        "post_salvage_failures": repairs,
        "errors": errors,
        "cost_usd": round(cost, 4),
        "cost_per_question": round(cost / n, 4) if n else None,
        "late_steps_without_cache_read": cache_zero_late,
    }


def _md_table(headers: list[str], rows: list[list[Any]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    for row in rows:
        out.append("| " + " | ".join("" if v is None else str(v) for v in row) + " |")
    return "\n".join(out)


def _fmt(v: Any, digits: int = 1) -> str:
    if v is None:
        return "n/a"
    if isinstance(v, float):
        return f"{v:.{digits}f}"
    return str(v)


def decide(arms: dict[str, dict[str, Any]], *, slo_key: str, slo: float, order: tuple[str, ...] = ("haiku", "sonnet", "opus")) -> tuple[str, str]:
    """Cheapest tier with accuracy >= 90, within 5 points of the best, post-salvage format failure
    < 2% of calls, latency percentile under the SLO.  Returns (tier, reasoning)."""
    present = {k: v for k, v in arms.items() if v and v.get("n")}
    if not present:
        return "n/a", "no data"
    best = max(v["accuracy"] for v in present.values())
    for tier in order:
        s = present.get(tier)
        if not s:
            continue
        reasons = []
        if s["accuracy"] < 90:
            reasons.append(f"accuracy {s['accuracy']:.0f}% < 90%")
        if s["accuracy"] < best - 5:
            reasons.append(f"{best - s['accuracy']:.0f} points below the best")
        fmt_rate = 100.0 * s["post_salvage_failures"] / max(1, s["calls"])
        if fmt_rate >= 2:
            reasons.append(f"post-salvage format failures {fmt_rate:.1f}% >= 2%")
        lat = s.get(slo_key)
        if lat is not None and lat > slo:
            reasons.append(f"{slo_key} {lat:.1f} s > {slo:.0f} s SLO")
        if not reasons:
            return tier, f"{tier}: accuracy {s['accuracy']:.0f}% (best {best:.0f}%), format failures {fmt_rate:.1f}%, {slo_key} {_fmt(lat)} s"
    fallback = max(present, key=lambda k: (present[k]["accuracy"], -order.index(k) if k in order else 0))
    return fallback, f"no tier met every criterion; {fallback} has the best accuracy ({present[fallback]['accuracy']:.0f}%)"


def rescore(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Re-apply the scoring rules to stored answers: token groups for every category, plus the
    strict first-number rule for the numeric categories (the number the answer states first must
    be the truth; a correct digit elsewhere in the text does not count)."""
    current = {q["id"]: q for q in load(OUT_DIR / "questions.json", [])}
    out = []
    for i in items:
        q = current.get(i["id"])
        i = {**i, "expect": q["expect"] if q else i["expect"], "question": q["text"] if q else i.get("question", "")}
        ok, missing = score(i.get("text") or "", i["expect"], i.get("forbid"))
        strict = True
        if i["category"] in NUMERIC_FIRST_CATEGORIES:
            value = i["expect"][0][0][1:]
            strict = strict_number_correct(i.get("text") or "", value)
            if not strict:
                missing = missing + [f"first number stated {first_number(i.get('text') or '')!r} != {value}"]
        out.append({**i, "lenient_correct": bool(ok and i.get("status") == "done"), "correct": bool(ok and strict and i.get("status") == "done"), "missing": missing})
    return out


def run_report(args: argparse.Namespace) -> None:
    chat = {arm: load(OUT_DIR / f"chat_{arm}.json", None) for arm in ("haiku", "sonnet")}
    for arm, d in chat.items():
        if d:
            d["items"] = rescore(d["items"])
    narrator = {arm: load(OUT_DIR / f"narrator_{arm}.json", None) for arm in ("haiku", "sonnet")}
    author = {arm: load(OUT_DIR / f"author_{arm}.json", None) for arm in ("haiku", "sonnet", "opus")}
    briefs = {arm: load(OUT_DIR / f"briefs_{arm}.json", None) for arm in ("haiku", "sonnet", "opus")}
    judgements = load(OUT_DIR / "ab_judgements.json", [])
    key = {p["turn_id"]: p for p in load(OUT_DIR / "ab_pairs_key.json", [])}
    replay = load(Path(args.replay_json), None) if args.replay_json else None

    lines: list[str] = ["# Assistant playtest: model tiers per capability", ""]
    lines.append(f"Run on 2026-09-26 with the Claude Code CLI ({_cli_version()}) through the assistant API of a backend started per arm by `scripts/assistant_playtest.py` (worlds copies under `qa/worlds-playtest/<arm>/`, `EMPYREAN_WHISPER_PRELOAD=0`, thinking off: `CLI_MAX_THINKING_TOKENS=0`). Raw per-call logs: `qa/playtest-out/*.json` (summarised in `docs/evidence/assistant_playtest_calls.jsonl`). Reference runs: `{PREDATORS}` (arena-predators 8, 20 rounds, 155 turns, 3 kills + 1 starvation) and `{FIGHT}` (arena-fight 12, 30 rounds, 338 turns, 10 starvation deaths, 22 unaffordable turns).")
    lines.append("")
    lines.append("## Decision rule (fixed in advance)")
    lines.append("")
    lines.append("Cheapest tier with factual accuracy >= 90% and within 5 points of the best tier, post-salvage format failure < 2% of calls, and latency within the SLO (help p50 <= 12 s, run analysis p90 <= 25 s). A CLI `malformed` status counts as a format failure only when deterministic salvage did not recover a valid step (a `repair` step or a `schema_mismatch` error).")
    lines.append("")

    # ---- chat
    lines.append("## Chat arms (ground-truthed questions)")
    lines.append("")
    lines.append("Every question runs in a fresh conversation scoped to its run with the context chip of a user on the run page (the viewed turn where the question says so). Scoring: every expected token group present (numbers as digits or words, action names via synonym lists, starvation/lost-turn vocabularies), no forbidden token, message status `done`. `refs` counts answers with at least one model-supplied reference besides the automatic as-of turn.")
    lines.append("")
    per_cat_rows = []
    group_stats: dict[str, dict[str, Any]] = {}
    cats = ["alive_count", "deaths", "last_action", "malformed_count", "rule_value", "turn_summary", "help"]
    for cat in cats:
        row: list[Any] = [cat]
        for arm in ("haiku", "sonnet"):
            items = [i for i in ((chat[arm] or {}).get("items") or []) if i["category"] == cat]
            s = _chat_stats(items) if items else None
            row.append(f"{s['correct']}/{s['n']} ({s['accuracy']:.0f}%)" if s else "n/a")
            row.append(f"p50 {_fmt(s['p50_s'])} / p90 {_fmt(s['p90_s'])}" if s else "n/a")
            row.append(f"{s['mean_steps']:.2f}" if s else "n/a")
            row.append(f"${s['cost_per_question']:.3f}" if s else "n/a")
        per_cat_rows.append(row)
    lines.append(_md_table(["category", "haiku correct", "haiku latency s", "haiku steps", "haiku $/q", "sonnet correct", "sonnet latency s", "sonnet steps", "sonnet $/q"], per_cat_rows))
    lines.append("")
    arm_rows = []
    for arm in ("haiku", "sonnet"):
        items = (chat[arm] or {}).get("items") or []
        if not items:
            continue
        s = _chat_stats(items)
        arm_rows.append([arm, ARMS[arm], s["n"], f"{s['correct']} ({s['accuracy']:.0f}%)", s["with_refs"], f"{_fmt(s['p50_s'])} / {_fmt(s['p90_s'])}", s["multi_step"], s["calls"], s["cli_malformed"], s["post_salvage_failures"], s["errors"], f"${s['cost_usd']:.2f}", f"${s['cost_per_question']:.3f}", s["late_steps_without_cache_read"]])
    lines.append(_md_table(["arm", "model key", "questions", "correct", "with refs", "p50 / p90 s", "multi-step", "calls", "CLI malformed", "post-salvage failures", "errors", "spend", "$/question", "late steps w/o cache read"], arm_rows))
    lines.append("")
    for group, group_cats in CATEGORY_GROUPS.items():
        stats = {}
        for arm in ("haiku", "sonnet"):
            items = [i for i in ((chat[arm] or {}).get("items") or []) if i["category"] in group_cats]
            stats[arm] = _chat_stats(items) if items else None
        group_stats[group] = stats
    lines.append("### Misses")
    lines.append("")
    for arm in ("haiku", "sonnet"):
        misses = [i for i in ((chat[arm] or {}).get("items") or []) if not i["correct"]]
        lines.append(f"**{arm}** ({len(misses)} misses):")
        lines.append("")
        for i in misses:
            lines.append(f"- `{i['id']}` {i['category']}: \"{i.get('question', '')}\" -> truth `{json.dumps(i['truth'])}`; missing {i['missing']}; status {i['status']}{' ' + str(i.get('error_code')) if i.get('error_code') else ''}; answer: {i['text_answer'] if 'text_answer' in i else (i.get('text') or '')[:300].replace(chr(10), ' ')!r}")
        lines.append("")

    # ---- narrator
    lines.append("## Narrator arm (storybook entries)")
    lines.append("")
    lines.append(f"`POST .../storybook/generate` for 12 turns of `{PREDATORS}` (round 3 in full, its round end, the round-19 kill turn, the round-19 end with a starvation death) plus the opening; backlog > 2, so the narrator got batched calls (one `## <turn_id>` section per turn). Faithfulness is checked automatically against the digest the narrator was given: every cast name mentioned must appear in the digest, every number in the entry must appear in the digest, deaths must be told and killers named (starvation never attributed to an agent), kill vocabulary without any death/damage in the digest is an invention, lost turns must be told as such, and any capitalised word that is neither a cast name, nor in the digest, nor a common word is an invented name (`recheck` re-applies the checks to stored entries).")
    lines.append("")
    nrows = []
    for arm in ("haiku", "sonnet"):
        d = narrator[arm]
        if not d:
            continue
        calls = d["calls"]
        lat = [c["latency_ms"] / 1000 for c in calls if c.get("latency_ms")]
        nrows.append([arm, d["model_key"], f"{d['written']}/{len(d['entries'])}", f"{d['faithful']}/{d['written']}", len(calls), [c["batch_size"] for c in calls], sum(1 for c in calls if c["status"] != "ok"), f"{_fmt(min(lat) if lat else None)}-{_fmt(max(lat) if lat else None)}", f"${d['spend_usd']:.3f}", f"${d['spend_usd'] / max(1, d['written']):.4f}", d["wall_s"]])
    lines.append(_md_table(["arm", "model key", "entries written", "faithful", "calls", "batch sizes", "failed calls", "call latency s", "spend", "$/entry", "wall s"], nrows))
    lines.append("")
    for arm in ("haiku", "sonnet"):
        d = narrator[arm]
        if not d:
            continue
        probs = [(e["turn_id"], e["problems"]) for e in d["entries"] if e.get("written") and not e["faithful"]]
        lines.append(f"**{arm}** faithfulness problems: " + ("; ".join(f"`{t}`: {p}" for t, p in probs) if probs else "none"))
        lines.append("")
    if judgements:
        tally = Counter()
        for j in judgements:
            k = key.get(j["turn_id"])
            choice = j.get("choice")
            tally[k[choice] if k and choice in ("A", "B") else "tie"] += 1
        lines.append(f"Blind A/B style judgement (10 pairs, random A/B order, judged before unblinding): sonnet preferred {tally.get('sonnet', 0)}, haiku preferred {tally.get('haiku', 0)}, ties {tally.get('tie', 0)}. Notes per pair are in `qa/playtest-out/ab_judgements.json`.")
        lines.append("")

    # ---- author
    lines.append("## Author arm (story brief and chapters)")
    lines.append("")
    arows = []
    for arm in ("haiku", "sonnet", "opus"):
        d = author[arm]
        if not d:
            continue
        for b in d["briefs"]:
            lat = [c["latency_ms"] / 1000 for c in b["calls"] if c.get("latency_ms")]
            arows.append([arm, b["kind"], b["status"], b["attempts"], b["cli_malformed_calls"], f"{_fmt(sum(lat))}", f"${sum(c['cost_usd'] or 0 for c in b['calls']):.3f}", (b.get("brief") or {}).get("title"), "yes" if b.get("cast_map_covers_cast") else ("n/a" if b.get("cast_map_covers_cast") is None else "no"), "ok" if (b.get("premise_check") or {}).get("ok") else ((b.get("premise_check") or {}).get("problems") or "n/a")])
    lines.append(_md_table(["arm", "call", "status", "author calls", "CLI malformed", "latency s", "cost", "title", "cast map covers cast", "premise vs run card"], arows))
    lines.append("")
    crows = []
    for arm in ("haiku", "sonnet"):
        d = author[arm]
        if not d:
            continue
        for c in d["chapters"]:
            crows.append([arm, c["number"], c["kind"], c["words"], "yes" if c["faithful"] else "; ".join(c["problems"]), f"${c['cost_usd'] or 0:.3f}", c["response_model"]])
    lines.append(_md_table(["arm", "chapter", "kind", "words", "faithful", "cost", "served model"], crows))
    lines.append("")
    for arm in ("haiku", "sonnet"):
        d = author[arm]
        if d and d.get("chapter_calls"):
            lat = [c["latency_ms"] / 1000 for c in d["chapter_calls"]]
            lines.append(f"{arm} chapter calls: {len(lat)}, latency {_fmt(min(lat))}-{_fmt(max(lat))} s, ${sum(c['cost_usd'] or 0 for c in d['chapter_calls']):.3f}; chapters 1-3 written {d.get('chapters_wall_s')} s after Accept.")
    lines.append("")

    # ---- briefs
    lines.append("## Briefs arm (natural-language commands)")
    lines.append("")
    lines.append(f"Six commands in run-scoped conversations on `{PREDATORS}` (chip: run page, God mode tab, paused at r00020_end). A command passes when the brief carries the expected typed action with the expected arguments, validates (`validation.ok`), and the card renders deterministically from the typed action (`qa/render_brief.mjs` runs the frontend's `describeAction`). Approved: the arena creation (fake default model, nothing spent) and the two interventions (staged on the copy).")
    lines.append("")
    brows = []
    for arm in ("haiku", "sonnet", "opus"):
        d = briefs[arm]
        if not d:
            continue
        for i in d["items"]:
            brows.append([arm, i["id"], "PASS" if i["passed"] else "FAIL", i["verdict"], i["steps"], i["cli_malformed_calls"], i["repair_steps"], _fmt(i["wall_s"]), f"${i['cost_usd']:.3f}", (i.get("approve") or {}).get("status") or "", " / ".join(i.get("rendered", {}).get("lines") or [])[:160]])
    lines.append(_md_table(["arm", "command", "result", "outcome", "steps", "CLI malformed", "repair", "wall s", "cost", "approved", "card (deterministic lines)"], brows))
    lines.append("")

    # ---- replay
    if replay:
        lines.append("## Replay of stored malformed envelopes (no spend)")
        lines.append("")
        lines.append(f"`scripts/assistant_replay_malformed.py`: {replay['malformed']} claude_cli decision replies rejected by the CLI validator under `worlds/` ({replay['with_text']} with the rejected payload stored, {replay['without_text']} recorded before payload capture existed). Salvage turns {replay['salvaged_to_object']} of the {replay['with_text']} payloads into a JSON object; {replay['decision_valid_after_salvage']} of those validate as a Decision (all of them `{{\"output\": \"<json>\"}}` wrappers the CLI validator refused). The remaining failures: {replay['decision_errors'][:3]}. Paid for malformed replies: ${replay['wasted_cost_usd']:.2f}.")
        lines.append("")

    # ---- decisions
    lines.append("## Tier decisions")
    lines.append("")
    decisions: dict[str, tuple[str, str]] = {}
    for group, stats in group_stats.items():
        slo_key, slo = ("p50_s", 12.0) if group.startswith("Help") else ("p90_s", 25.0)
        decisions[group] = decide(stats, slo_key=slo_key, slo=slo)
    drows = []
    for group, stats in group_stats.items():
        row = [group]
        for arm in ("haiku", "sonnet"):
            s = stats.get(arm)
            row.append(f"{s['accuracy']:.0f}% acc, p50 {_fmt(s['p50_s'])} / p90 {_fmt(s['p90_s'])} s, {s['post_salvage_failures']}/{s['calls']} format fail, ${s['cost_per_question']:.3f}/q" if s else "n/a")
        row.append(decisions[group][0])
        row.append(decisions[group][1])
        drows.append(row)
    lines.append(_md_table(["capability", "haiku", "sonnet", "decision", "why"], drows))
    lines.append("")

    # ---- spend
    lines.append("## Spend")
    lines.append("")
    total = 0.0
    srows = []
    for arm in ("haiku", "sonnet", "opus"):
        wd = DEFAULT_WORLDS / arm
        if wd.is_dir():
            spend = arm_spend(wd)
            total += spend
            by_profile = Counter()
            for l in ledger_lines(wd):
                by_profile[l.get("profile")] += float(l.get("cost_usd") or 0.0)
            srows.append([arm, len(ledger_lines(wd)), f"${spend:.4f}", ", ".join(f"{p} ${c:.3f}" for p, c in sorted(by_profile.items()))])
    srows.append(["total", "", f"${total:.4f}", "hard cap USD 22"])
    lines.append(_md_table(["arm", "ledger lines", "spend (CLI-reported total_cost_usd)", "by profile"], srows))
    lines.append("")
    lines.append(FINDINGS.rstrip())
    lines.append("")
    (EVIDENCE / "assistant_playtest.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    # compact per-call log
    with (EVIDENCE / "assistant_playtest_calls.jsonl").open("w", encoding="utf-8") as fh:
        for arm in ("haiku", "sonnet", "opus"):
            wd = DEFAULT_WORLDS / arm
            if wd.is_dir():
                for l in ledger_lines(wd):
                    fh.write(json.dumps({"arm": arm, **{k: l.get(k) for k in ("ts", "profile", "model_key", "response_model", "status", "error_code", "cost_usd", "latency_ms", "attempts", "step", "batch_size", "job_id")}, "usage": l.get("usage")}, ensure_ascii=False) + "\n")
    save(OUT_DIR / "decisions.json", {g: {"tier": d[0], "why": d[1]} for g, d in decisions.items()})
    print("\n".join(lines[-40:]))
    print(f"\nwrote {EVIDENCE / 'assistant_playtest.md'}; total spend ${total:.4f}")


FINDINGS = """## Findings

1. **Questions (help, run analysis): Haiku matches Sonnet.** 74/80 vs 73/80 overall, 97% each on run
   analysis, 100% each on help; Haiku answers in p50 6.3 s / p90 9.2 s against 11.3 / 22.5 s, at a
   third of the cost. Haiku reaches for a tool more readily (45 multi-step messages vs 44, but 1.0
   steps on turn summaries and deaths, where the prefetched digest already holds the answer).
2. **Sonnet's wrong answers were visible self-corrections.** Both alive-count misses state a wrong
   count first and reason towards the right one inside the answer ("... wait, a08 died that same
   round-end"). Thinking is off for the CLI (`CLI_MAX_THINKING_TOKENS=0`); a small thinking budget
   for chat steps is the variable to try before promoting Sonnet for analysis.
3. **Log interpretation fails on both tiers for a tooling reason.** "How many turns were lost to
   malformed replies in rounds A-B" needs a count over up to 60 turns; `search_events` output is
   capped at 6,000 characters and reports "capped" without a total, so the model either guesses,
   asks, or burns its three tool steps on the same query (Sonnet p90 37 s). `get_round_digest`
   already carries `lost_turns`; returning a match count from `search_events` (and pointing the
   prompt at the round digest for counting) should lift this category above 90% on Haiku.
4. **Briefs: the prompt, not the tier, loses the set_stat case.** Every tier wrote
   `{"field": "health"}`; the intervention needs the dotted path `stats.health` (validation says
   "unknown field path 'health'", the card renders `set a05.health = 5`, and it cannot be approved).
   One line in the chat rules fixes it. Haiku's arena overlay also carried unknown keys
   (`rules.cognition.mind_multiplier`, an empty `world.initial_plants`), which validation caught;
   Sonnet fetched `get_defaults` first and produced a valid overlay. The engine's repair step fires
   only when the action fails to type, not on validation problems: a brief-repair for `problems`
   would give Haiku a second chance at the same cost as Sonnet's first attempt.
5. **Refusal / clarification works on every tier.** "Rewrite round 3 so that Boreas survives" got an
   ask with options (Haiku), an explanation that turns are immutable plus a continuation proposal
   (Sonnet) and a create_continuation brief from r00002_end (Opus); no tier proposed editing the past.
6. **Narrator: both tiers invented survivor names in the round-end entry.** The round-19 end digest
   lists the living agents as ids only (`living: [a04, a05, a06, a07]`, "4 agents alive") and the
   narrator rules say "refer to agents by name": Haiku wrote "Eos, Verdant, Sage, and Cascade",
   Sonnet "Nyx, Eos, Iris, and Thalos". The first automated check missed it (it only tested cast
   names that were mentioned); the invented-name check added afterwards catches it, and a screenshot
   of the Storybook tab shows the Sonnet entry (`playtest-01-storybook-tab-sonnet-entries.png`).
   This is a digest defect (WP3: the round-end digest should carry names for `living`,
   `upkeep_short` and `starvation`, or the narrator prompt a cast map), not a tier difference.
   After re-checking: Haiku 12/13 faithful at $0.0011 per entry; Sonnet 11/13 (the other flag
   names Aster in Boreas's skipped-dead turn from the continuity context: true, but not in that
   turn's digest). The blind A/B preferred Sonnet 8:2 for style (Haiku slipped into present tense
   once and copied digest sentences verbatim twice). Batching worked: one 9-turn call per round, a
   missed section re-queued singly in 2 s.
7. **Author: every tier produced a valid story brief on the first call**, including Opus's
   revision after a "Change" message. Chapters cost $0.003-0.017 each (well under the $0.04
   estimate in `story.py`) because the first three chapters of this range are an opening and two
   interludes.
8. **Format reliability supports the hybrid design.** Constrained JSON where code consumes the
   output: 4 CLI `malformed` replies in 271 chat calls, 1 salvaged deterministically, 2 repaired in
   one step, 1 terminal (Haiku, restricted last step); text mode: 0 failures in 20 narrator/chapter
   calls; story-brief JSON: 0 in 4. The cache assertion held on every late step (no zero cache
   reads). Offline, the salvage rule that is missing is the same-key unwrap
   (`{"action": {"action": ...}}`): 49 of the 83 stored malformed decision payloads.
9. **Known issues confirmed.** (a) The progress line is written once per step (`elapsed_s` and
   "step k/4 · N s" change only when a step starts), so the first step shows "0 s" until it ends
   (code path `engine._push_progress`). (b) `tests/test_assistant_api.py::test_plain_answer_with_refs_and_progress`
   failed 2 of 18 runs here: the engine marks the job `done` before the `finally` block clears
   `meta.active_job_id`, so a GET between the two writes sees a stale id (harmless for the UI, which
   checks the job status). (c) `oxlint` reports 10 warnings: 6 `react/set-state-in-effect` in
   `AssistantDrawer.tsx`, 1 in `RunPage.tsx`, 3 `only-export-components`.

## Recommendations

* `digest.py` round-end digest: names next to ids in `living`, `upkeep_short`, `starvation`
  (or a cast map in the narrator prompt); re-run `narrator` for both arms afterwards.
* Keep `claude-cli-sonnet-assistant` as the chat default for now (briefs); add a `chat_answers`
  sub-profile on Haiku once the log-interpretation tool fix lands, and re-run
  `scripts/assistant_playtest.py chat` (the question set is deterministic).
* `prompts.py` chat rules: "set_stat.field is a dotted path inside the entity record, for example
  `stats.health`"; `tools.py` `search_events`: return `total_matches` when capped.
* `calls.py` `_salvage_once`: add the same-key unwrap rule (handoff note to WP2).
* Narrator stays Haiku; expose the narrator key in the spend popover as an option for users who
  want Sonnet prose at 3.5x the cost.
* Opus: no measurable gain on briefs or story briefs in this sample; not worth a default anywhere.
"""


def run_recheck() -> None:
    """Re-run ``check_faithfulness`` over the stored narrator entries and chapters of every arm
    (each arm's worlds copy holds the digests), rewriting the ``faithful`` / ``problems`` fields."""
    for arm in ("haiku", "sonnet", "opus"):
        worlds = DEFAULT_WORLDS / arm
        if not worlds.is_dir():
            continue
        # digest is bound to one worlds dir per process: run per arm in a subprocess
        code = (
            "import json,sys; sys.argv=['x']; import importlib.util; spec=importlib.util.spec_from_file_location('pt', %r); pt=importlib.util.module_from_spec(spec); spec.loader.exec_module(pt); "
            "pt._recheck_arm(%r)" % (str(Path(__file__).resolve()), arm)
        )
        subprocess.run([str(PYTHON), "-c", code], check=True, cwd=str(REPO))


def _recheck_arm(arm: str) -> None:
    worlds = DEFAULT_WORLDS / arm
    digest = import_digest(worlds)
    rdir = _run_dir(worlds, PREDATORS)
    names = _names(rdir, _read_json(rdir / "manifest.json")["current_turn_id"])
    npath = OUT_DIR / f"narrator_{arm}.json"
    if npath.is_file():
        d = load(npath, None)
        for e in d["entries"]:
            if not e.get("written"):
                continue
            dg = digest.opening_digest(PREDATORS) if e["turn_id"] == "opening" else digest.turn_digest(PREDATORS, e["turn_id"], max_chars=1500)
            check = check_faithfulness(e["text"], dg, names)
            e["faithful"], e["problems"] = check["ok"], check["problems"]
        d["faithful"] = sum(1 for e in d["entries"] if e.get("faithful"))
        save(npath, d)
        print(f"[{arm}] narrator: {d['faithful']}/{d['written']} faithful; problems: {[(e['turn_id'], e['problems']) for e in d['entries'] if e.get('written') and not e['faithful']]}")
    apath = OUT_DIR / f"author_{arm}.json"
    if apath.is_file():
        d = load(apath, None)
        for c in d.get("chapters", []):
            if c["kind"] == "opening":
                dg, allowed = digest.opening_digest(PREDATORS), set(names.values())
            else:
                dg, allowed = [digest.turn_digest(PREDATORS, t, max_chars=1500) for t in c["turn_ids"]], set()
            check = check_faithfulness(c["text"], dg, names, allowed_names=allowed)
            c["faithful"], c["problems"] = check["ok"], check["problems"]
        save(apath, d)
        print(f"[{arm}] chapters: {[(c['number'], c['faithful'], c['problems']) for c in d.get('chapters', [])]}")


def _cli_version() -> str:
    try:
        return subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=20).stdout.strip().splitlines()[0]
    except Exception:  # noqa: BLE001
        return "unknown version"


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="ground-truthed assistant playtest")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--arm", choices=list(ARMS), default="haiku")
        p.add_argument("--worlds-dir", default=None, help="default qa/worlds-playtest/<arm>")
        p.add_argument("--port", type=int, default=8021)

    p = sub.add_parser("questions", help="print the ground-truth question set (no spend)")
    common(p)
    p = sub.add_parser("chat")
    common(p)
    p.add_argument("--max-spend", type=float, default=4.0, help="stop the arm when its ledger reaches this (USD)")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--categories", nargs="*", default=None)
    p = sub.add_parser("narrator")
    common(p)
    p = sub.add_parser("ab-pairs", help="write the blind A/B pairs from both narrator arms")
    p = sub.add_parser("author")
    common(p)
    p.add_argument("--briefs-only", action="store_true")
    p.add_argument("--change-message", default=None, help="send this as a Change to get a second brief")
    p = sub.add_parser("briefs")
    common(p)
    p.add_argument("--only", nargs="*", default=None)
    p = sub.add_parser("recheck", help="recompute the faithfulness checks of stored narrator/author results (no spend)")
    p = sub.add_parser("report")
    p.add_argument("--replay-json", default=None)
    args = parser.parse_args()

    if args.cmd == "questions":
        worlds = Path(args.worlds_dir or (DEFAULT_WORLDS / args.arm))
        qs = build_questions(worlds)
        counts = Counter(q["category"] for q in qs)
        for q in qs:
            print(f"{q['id']} {q['category']:15s} {q['run_id'] or '-':28s} {q['text']}\n      truth={json.dumps(q['truth'])} expect={q['expect']}")
        print(dict(counts), "total", len(qs))
        save(OUT_DIR / "questions.json", qs)
        return 0
    if args.cmd == "chat":
        run_chat(args)
    elif args.cmd == "narrator":
        run_narrator(args)
    elif args.cmd == "ab-pairs":
        write_ab_pairs(args)
    elif args.cmd == "author":
        run_author(args)
    elif args.cmd == "briefs":
        run_briefs(args)
    elif args.cmd == "recheck":
        run_recheck()
    elif args.cmd == "report":
        run_report(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
