#!/usr/bin/env python3
"""
Headless Empyrean driver (QA).

Creates a run from ``GET /api/defaults``, advances it round by round with the
``step_round`` command and prints a plain-text summary of what happened.  It
drives the real backend in-process (RunManager + FastAPI app through
``fastapi.testclient.TestClient``), so no HTTP server is needed and every step
goes through the same API routes the browser uses (docs/INTERFACES.md
section 9).  Run data is written to ``--worlds-dir`` in the normal folder
layout, so a finished run can be opened afterwards with "Resume session".

Usage (from the repository root):

    .venv/bin/python scripts/run_sim.py                          # 8 fake-heuristic agents, 3 rounds, seed 1
    .venv/bin/python scripts/run_sim.py --model fake-malformed --rounds 5 --worlds-dir /tmp/worlds
    EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/run_sim.py --model claude-cli-haiku --live-check
    .venv/bin/python scripts/run_sim.py --request scripts/scenarios/arena_fight.json --assistant

Safety against accidental spend: any model whose provider is not ``fake``
is refused unless the environment variable ``EMPYREAN_ALLOW_LIVE=1`` is set.
``--live-check`` runs exactly ONE agent turn (at most one decision, i.e. one
model call plus its bounded retries) and prints that call's record: status,
usage, provider cost and the ratio of billed input tokens to the packet
estimate (INTERFACES section 13 expects <= 1.5 for claude_cli).

Exit status: 0 on success; 1 on any exception, a run that ends in the
``error`` state, or a failed live check; 2 when the model is refused or
unknown.  The script never prints credential values and never reads .env
itself (``empyrean.config`` loads it).

``--assistant`` builds the in-process ``AssistantService`` and passes it to
``create_app`` (as ``main.build_app`` does), so the run gets its storybook
settings, opening entry and per-turn entries while it plays, and the summary
prints the storybook status.  Automatic generation with a paid narrator model is
allowed only when ``EMPYREAN_ALLOW_LIVE=1`` is also set (``auto_live_allowed``);
otherwise only a fake narrator (``EMPYREAN_ASSISTANT_MODEL_NARRATOR=fake-assistant``)
writes entries.  Without ``--assistant`` the assistant routes answer 503.
"""
# DOCS: --agents accepts config.MIN_AGENTS..MAX_AGENTS (6-64); --request overlays use the shared
# deep_merge of empyrean.assistant.briefs; --assistant never spends without EMPYREAN_ALLOW_LIVE=1.

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from collections import Counter
from pathlib import Path
from typing import Any, Optional

REPO_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_DIR / "backend"

ALLOW_LIVE_ENV = "EMPYREAN_ALLOW_LIVE"
LIVE_BILLING_RATIO_LIMIT = 1.5  # INTERFACES section 13: billed input <= 1.5 x packet estimate
IDLE_STATES = ("paused", "error", "finished")
# Mirrors config.MIN_AGENTS / MAX_AGENTS (config is imported only after --worlds-dir is applied;
# a test keeps these equal).
MIN_AGENTS = 6
MAX_AGENTS = 64


# ---------------------------------------------------------------------------
# Arguments and safety guard
# ---------------------------------------------------------------------------


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run an Empyrean simulation headless and print a summary.")
    parser.add_argument("--model", default="fake-heuristic", help="registry model key for every agent (default fake-heuristic)")
    parser.add_argument("--agents", type=int, default=8, help=f"number of agent cards, {MIN_AGENTS}-{MAX_AGENTS} (default 8)")
    parser.add_argument("--rounds", type=int, default=3, help="rounds to run with step_round (default 3)")
    parser.add_argument("--seed", type=int, default=1, help="world seed (default 1)")
    parser.add_argument("--worlds-dir", default=None, help="where run folders are written (default: EMPYREAN_WORLDS_DIR or repo worlds/)")
    parser.add_argument("--name", default=None, help="run name (default 'headless <model> seed <seed>')")
    parser.add_argument("--request", help="JSON file overlaid on GET /defaults: world/rules/context are deep-merged, "
                        "other keys (agents, name, seed, ...) replace the default")
    parser.add_argument(
        "--assistant",
        action="store_true",
        help="run the assistant service in-process (storybook while the run plays; paid narration only with EMPYREAN_ALLOW_LIVE=1)",
    )
    parser.add_argument(
        "--live-check",
        action="store_true",
        help="run exactly one agent turn and report its model call (usage, cost, billed/estimate ratio)",
    )
    parser.add_argument("--timeout", type=float, default=900.0, help="seconds to wait for one command to finish (default 900)")
    args = parser.parse_args(argv)
    if not MIN_AGENTS <= args.agents <= MAX_AGENTS:
        parser.error(f"--agents must be between {MIN_AGENTS} and {MAX_AGENTS}")
    if args.rounds < 1:
        parser.error("--rounds must be at least 1")
    return args


def live_refusal(provider: str) -> Optional[str]:
    """A reason to refuse, or None.  Non-fake providers spend real money or quota."""
    if provider == "fake":
        return None
    if os.environ.get(ALLOW_LIVE_ENV) == "1":
        return None
    return (
        f"refusing to run a live model (provider '{provider}') without {ALLOW_LIVE_ENV}=1; "
        f"set it explicitly to accept real usage costs"
    )


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------


class Api:
    """JSON calls against the in-process app; raises RuntimeError on unexpected status."""

    def __init__(self, client: Any) -> None:
        self.client = client

    def get(self, path: str, **params: Any) -> Any:
        response = self.client.get("/api" + path, params=params or None)
        if response.status_code != 200:
            raise RuntimeError(f"GET {path} -> {response.status_code}: {response.text[:1000]}")
        return response.json()

    def post(self, path: str, body: Any = None, expect: int = 200) -> Any:
        response = self.client.post("/api" + path, json=body)
        if response.status_code != expect:
            raise RuntimeError(f"POST {path} -> {response.status_code}: {response.text[:2000]}")
        return response.json()

    def command(self, run_id: str, command: str, timeout: float) -> dict[str, Any]:
        """Submit a run command and wait until no command drives the worker."""
        self.post(f"/runs/{run_id}/commands", {"command": command})
        deadline = time.monotonic() + timeout
        while True:
            status = self.get(f"/runs/{run_id}/status")
            if status["state"] in IDLE_STATES and not status.get("active_command") and not status.get("play_loop"):
                return status
            if time.monotonic() > deadline:
                raise RuntimeError(f"{command} did not finish within {timeout}s (state {status['state']})")
            time.sleep(0.05)


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------


def deep_merge(base: dict, overlay: dict) -> dict:
    """Recursively merge overlay into a copy of base (dicts merge, everything else replaces).
    Delegates to the shared helper the assistant's create-run briefs use."""
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))
    from empyrean.assistant.briefs import deep_merge as shared_deep_merge

    return shared_deep_merge(base, overlay)


def fmt(value: Optional[float], digits: int = 3) -> str:
    return "-" if value is None else f"{value:.{digits}f}"


def dir_bytes(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def tree_lines(path: Path, indent: str = "  ") -> list[str]:
    """Plain-text tree of a directory with file sizes (directories first)."""
    lines = []
    entries = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name))
    for entry in entries:
        if entry.is_dir():
            lines.append(f"{indent}{entry.name}/  ({dir_bytes(entry):,} B)")
            lines.extend(tree_lines(entry, indent + "  "))
        else:
            lines.append(f"{indent}{entry.name}  {entry.stat().st_size:,} B")
    return lines


def collect_turns(api: Api, run_id: str) -> list[dict[str, Any]]:
    """TurnView of every committed turn (events + model call summaries)."""
    return [api.get(f"/runs/{run_id}/turns/{row['turn_id']}") for row in api.get(f"/runs/{run_id}/turns")]


def print_summary(api: Api, run_id: str, run_dir: Path, status: dict[str, Any]) -> None:
    live = api.get(f"/runs/{run_id}/state")
    settings = live["settings"]
    views = collect_turns(api, run_id)
    events = [event for view in views for event in view["events"]]
    calls = [call for view in views for call in view["model_calls"]]

    print()
    print("=" * 78)
    print(f"Run {run_id}  ({status['state']}, current turn {status['current_turn_id']}, round {status['round']})")
    print("=" * 78)

    print("\nAgents")
    header = f"  {'id':<5} {'name':<10} {'model':<18} {'alive':<5} {'health':>8} {'compute':>10} {'essence':>8} {'pos':>9} {'skills':>6}"
    print(header)
    for agent_id, agent in live["entities"]["agents"].items():
        model_key = settings["model_overrides"].get(agent_id, settings["default_model_key"])
        pos = f"({agent['position']['x']},{agent['position']['y']})"
        stats = agent["stats"]
        print(
            f"  {agent_id:<5} {agent['name'][:10]:<10} {model_key[:18]:<18} {str(agent['alive']):<5} "
            f"{fmt(stats['health'], 1):>8} {fmt(stats['compute']):>10} {fmt(stats['essence'], 2):>8} {pos:>9} {len(agent['skills']):>6}"
        )

    actions = [e for e in events if e["kind"] == "action"]
    by_kind = Counter(e["details"]["action"]["name"] for e in actions)
    by_result = Counter("ok" if e["details"]["result"]["ok"] else e["details"]["result"]["reason"] for e in actions)
    via_skill = sum(1 for e in actions if e["details"].get("via_skill"))
    print(f"\nActions: {len(actions)} ({via_skill} via skill)")
    print("  by kind:   " + (", ".join(f"{k} {n}" for k, n in sorted(by_kind.items())) or "none"))
    print("  by result: " + (", ".join(f"{k} {n}" for k, n in sorted(by_result.items())) or "none"))
    other = Counter(
        e["kind"] for e in events if e["kind"] in ("decision_invalid", "resource_skip", "skill_saved", "skill_rejected", "skill_error")
    )
    if other:
        print("  other:     " + ", ".join(f"{k} {n}" for k, n in sorted(other.items())))

    call_status = Counter(f"{c['status']}/{c.get('result_status') or '-'}" for c in calls)
    print(f"\nModel calls: {len(calls)}")
    print("  by status (record/result): " + (", ".join(f"{k} {n}" for k, n in sorted(call_status.items())) or "none"))
    print(f"  tokens in {sum(c['input_tokens'] for c in calls):,}, out {sum(c['output_tokens'] for c in calls):,}")
    latencies = [c["latency_ms"] for c in calls]
    if latencies:
        print(f"  latency ms: mean {sum(latencies) / len(latencies):.1f}, max {max(latencies):.1f}")

    agents = live["entities"]["agents"].values()
    cognition = sum(a["total_cognition_spent"] for a in agents)
    action_compute = sum(a["total_compute_spent"] for a in agents)
    interpreter = sum(a["total_interpreter_spent"] for a in agents)
    uncharged = sum(c.get("uncharged_compute", 0.0) for c in calls)
    upkeep_paid = sum(e["details"].get("paid", 0.0) for e in events if e["kind"] == "upkeep")
    print("\nCompute charged (world units)")
    print(f"  cognition {fmt(cognition)} (uncharged overdraft {fmt(uncharged)}), actions {fmt(action_compute)}, "
          f"interpreter {fmt(interpreter)}, upkeep paid {fmt(upkeep_paid)}")
    usage = status.get("real_usage", {})
    print(f"Real provider usage: calls {usage.get('calls', 0)} (interrupted {usage.get('interrupted_calls', 0)}), "
          f"billed in {usage.get('input_tokens', 0):,}, out {usage.get('output_tokens', 0):,}, "
          f"cost ${usage.get('provider_cost_usd', 0.0):.4f}")

    deaths = [e for e in events if e["kind"] == "death"]
    print(f"\nDeaths: {len(deaths)}")
    for event in deaths:
        details = event["details"]
        print(f"  r{event['round']} {details.get('entity_id')} ({details.get('kind')}) cause {details.get('cause')}")
    entities = live["entities"]
    living_plants = sum(1 for p in entities["plants"].values() if p["alive"])
    fruit_compute = sum(f["available_compute"] for f in entities["fruits"].values())
    print(f"World: plants {living_plants} living / {len(entities['plants'])}, fruit {len(entities['fruits'])} "
          f"(compute {fmt(fruit_compute, 1)}), seeds {len(entities['seeds'])}, residues {len(entities['residues'])}")

    turns_dir = run_dir / "turns"
    sizes = {d.name: dir_bytes(d) for d in sorted(turns_dir.iterdir()) if d.is_dir() and not d.name.startswith(".")}
    agent_sizes = [n for name, n in sizes.items() if "_t" in name]
    end_sizes = [n for name, n in sizes.items() if name.endswith("_end")]
    print(f"\nStorage: run folder {run_dir}")
    print(f"  total {dir_bytes(run_dir):,} B; {len(sizes)} turn dirs, {sum(sizes.values()):,} B")
    if agent_sizes:
        print(f"  bytes per agent turn: mean {sum(agent_sizes) // len(agent_sizes):,}, max {max(agent_sizes):,}")
    if end_sizes:
        print(f"  bytes per round-end turn: mean {sum(end_sizes) // len(end_sizes):,}")

    sample = next(
        (v["turn"]["turn_id"] for v in reversed(views) if v["turn"]["model_call_ids"]),
        views[-1]["turn"]["turn_id"],
    )
    sample_dir = turns_dir / sample
    print(f"\nTree of turns/{sample}/  ({dir_bytes(sample_dir):,} B)")
    for line in tree_lines(sample_dir):
        print(line)


def live_check_report(api: Api, run_id: str) -> bool:
    """Print the single committed agent turn's model call(s); True when the check passes."""
    views = collect_turns(api, run_id)
    turn = next((v for v in reversed(views) if v["turn"]["kind"] == "agent_turn"), None)
    if turn is None or not turn["turn"]["model_call_ids"]:
        print("live check: the committed turn made no model call (skill, wait or unaffordable)")
        return False
    turn_id = turn["turn"]["turn_id"]
    packet = None
    if turn["turn"]["packet_id"]:
        packet = api.get(f"/runs/{run_id}/turns/{turn_id}/decision_packets/{turn['turn']['packet_id']}")
    passed = True
    print(f"\nLive check: turn {turn_id} ({turn['turn']['acting_agent_id']})")
    for call_id in turn["turn"]["model_call_ids"]:
        record = api.get(f"/runs/{run_id}/turns/{turn_id}/model_calls/{call_id}")
        result = record.get("result") or {}
        usage = result.get("usage") or {}
        print(f"  {call_id}: record {record['status']}, result {result.get('status')}, provider {record['provider']}, "
              f"model {record['model_id']} (served {result.get('response_model')}), attempts {result.get('attempts')}, "
              f"latency {fmt(result.get('latency_ms'), 0)} ms")
        print(f"    usage ({usage.get('source')}): input {usage.get('input_tokens')}, cache read {usage.get('cache_read_tokens')}, "
              f"cache write {usage.get('cache_creation_tokens')}, output {usage.get('output_tokens')}, billed input {usage.get('billed_input_tokens')}; "
              f"provider cost {result.get('provider_cost_usd')}; charged compute {fmt(record.get('charged_compute'))}")
        if record["status"] != "completed" or result.get("status") != "ok":
            print(f"    FAIL: the call did not return a usable decision ({result.get('error') or record.get('error')})")
            passed = False
        if packet and usage.get("billed_input_tokens"):
            ratio = usage["billed_input_tokens"] / max(1, packet["input_token_estimate"])
            verdict = "ok" if ratio <= LIVE_BILLING_RATIO_LIMIT else "FAIL"
            print(f"    billed input / packet estimate = {usage['billed_input_tokens']} / {packet['input_token_estimate']} = {ratio:.2f} ({verdict}, limit {LIVE_BILLING_RATIO_LIMIT})")
            passed = passed and ratio <= LIVE_BILLING_RATIO_LIMIT
    return passed


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run(args: argparse.Namespace) -> int:
    if args.worlds_dir:
        os.environ["EMPYREAN_WORLDS_DIR"] = str(Path(args.worlds_dir).resolve())
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))

    from empyrean import config  # loads .env before anything reads os.environ

    if args.worlds_dir:
        config.WORLDS_DIR = Path(args.worlds_dir).resolve()
    config.WORLDS_DIR.mkdir(parents=True, exist_ok=True)

    from fastapi.testclient import TestClient

    from empyrean import storage
    from empyrean.api import create_app
    from empyrean.model import UnknownModelError, load_registry
    from empyrean.runner import RunManager

    registry = load_registry()
    try:
        ref = registry.get(args.model)
    except UnknownModelError:
        print(f"unknown model key '{args.model}'; known: {', '.join(registry.keys())}", file=sys.stderr)
        return 2
    refusal = live_refusal(ref.provider)
    if refusal:
        print(refusal, file=sys.stderr)
        return 2
    problem = registry.validate_key(args.model)
    if problem:
        print(problem, file=sys.stderr)
        return 2

    name = args.name or f"headless {args.model} seed {args.seed}"
    print(f"Empyrean headless run: model {args.model} (provider {ref.provider}), {args.agents} agents, "
          f"{'1 turn (live check)' if args.live_check else f'{args.rounds} rounds'}, seed {args.seed}")
    print(f"worlds dir {config.WORLDS_DIR}")

    manager = RunManager(registry)
    assistant = None
    if args.assistant:
        from empyrean.assistant import AssistantService

        allow_live = os.environ.get(ALLOW_LIVE_ENV) == "1"
        assistant = AssistantService(manager, registry, auto_live_allowed=allow_live)
        narrator = assistant.profile_model_key("narrator")
        print(f"assistant: in-process, narrator {narrator}"
              + ("" if allow_live or assistant.profile_is_fake("narrator") else
                 f" (paid: automatic narration stays off without {ALLOW_LIVE_ENV}=1)"))
    try:
        with TestClient(create_app(manager, assistant)) as client:
            api = Api(client)
            request = api.get("/defaults", agent_count=args.agents)
            request.update(name=name, seed=args.seed, default_model_key=args.model, play_delay_seconds=0.0)
            if args.request:
                overlay = json.loads(Path(args.request).read_text(encoding="utf-8"))
                for key, value in overlay.items():
                    if key in ("world", "rules", "context") and isinstance(value, dict):
                        request[key] = deep_merge(request.get(key) or {}, value)
                    else:
                        request[key] = value
                print(f"scenario overlay {args.request}: {len(request['agents'])} agents")
            summary = api.post("/runs", request, expect=201)
            run_id = summary["run_id"]
            if assistant is not None:
                from empyrean.schemas import RunCreateRequest

                assistant.notify_run_created(run_id, RunCreateRequest.model_validate(request))
            api.post(f"/runs/{run_id}/open")
            print(f"created {run_id} in {summary['world_id']}")

            started = time.monotonic()
            if args.live_check:
                status = api.command(run_id, "run_turn", args.timeout)
            else:
                status = api.get(f"/runs/{run_id}/status")
                for round_no in range(1, args.rounds + 1):
                    status = api.command(run_id, "step_round", args.timeout)
                    print(f"  round {round_no}: state {status['state']}, turn {status['current_turn_id']}, "
                          f"living {status['living_agent_count']}, {time.monotonic() - started:.1f}s", flush=True)
                    if status["state"] != "paused":
                        break

            run_dir = storage.find_run_dir(run_id)
            print_summary(api, run_id, run_dir, status)
            if assistant is not None:
                print_storybook(client, run_id)
            exit_code = 0
            if status["state"] == "error":
                print(f"\nRUN ERROR: {status.get('last_error')}", file=sys.stderr)
                exit_code = 1
            if args.live_check and not live_check_report(api, run_id):
                exit_code = 1
            api.post(f"/runs/{run_id}/close")
            return exit_code
    finally:
        manager.shutdown()


def print_storybook(client: Any, run_id: str, wait_seconds: float = 30.0) -> None:
    """Wait briefly for queued narration, then print the storybook status (``--assistant``)."""
    deadline = time.monotonic() + wait_seconds
    while True:
        response = client.get(f"/api/runs/{run_id}/assistant/storybook")
        if response.status_code != 200:
            print(f"\nstorybook: unavailable ({response.status_code}: {response.text[:200]})")
            return
        view = response.json()
        status = view.get("status", {})
        if not status.get("in_flight") and not status.get("pending_count") or time.monotonic() > deadline:
            break
        time.sleep(0.5)
    print(f"\nstorybook: auto {status.get('auto_state')}, {status.get('entry_count')} entries, "
          f"opening {'yes' if status.get('has_opening') else 'no'}, missing {status.get('missing_count')}, "
          f"spent ${(status.get('spend') or {}).get('spent_usd', 0):.4f}")
    if status.get("notice") or status.get("last_error"):
        print(f"  {status.get('notice') or ''} {status.get('last_error') or ''}".rstrip())


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    try:
        return run(args)
    except Exception:  # any failure is a non-zero exit with the traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
