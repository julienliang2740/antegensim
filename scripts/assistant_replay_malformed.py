#!/usr/bin/env python3
"""Replay stored malformed claude_cli decision envelopes through the assistant's deterministic
salvage (``empyrean.assistant.calls.salvage``) and report the salvage rate.  No model is called and
nothing is spent (verification pass, docs/TEST_PLAN.md "Assistant release").

What it measures
----------------
Every ``worlds/*/runs/*/turns/*/model_calls/mc_*.json`` whose ``provider`` is ``claude_cli`` and
whose ``result.status`` is ``malformed`` is a reply the CLI's own structured-output validator
rejected (``error_max_turns`` with ``--json-schema`` and ``--max-turns 1``).  ``result.text`` holds
what the model actually sent (the rejected StructuredOutput input as JSON) when the record was
written after the transcript capture landed, else ``""``.

For each envelope the script runs ``salvage(parsed=None, text=result.text)`` (exactly what
``calls.call_profile`` does before the engine's repair step) and then asks whether the salvaged
object would have been accepted downstream:

* ``salvaged``: salvage produced a dict (the reply was a JSON object, possibly wrapped);
* ``decision_ok``: that dict validates as a ``schemas.Decision`` (the schema the CLI rejected it
  against), i.e. the CLI verdict was stricter than the engine's gate;
* ``decision_error``: the dict fails ``Decision`` validation: the first pydantic error is
  reported, grouped, so the failure modes are visible.

The report also states what the replay CAN and CANNOT show about the assistant refs' ``max_turns``
2 / ``max_model_requests`` 3 setting (the stored envelopes were produced with ``--max-turns 1``,
where a validator verdict is terminal).

Usage: .venv/bin/python scripts/assistant_replay_malformed.py [--worlds-dir DIR] [--json OUT.json]
"""
# DOCS: verification helper; reads worlds/*/runs/*/turns/*/model_calls/mc_*.json only.
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Optional

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from pydantic import ValidationError  # noqa: E402

from empyrean import config  # noqa: E402
from empyrean.assistant.calls import salvage  # noqa: E402
from empyrean.schemas import Decision  # noqa: E402


def _first_error(exc: ValidationError) -> str:
    errors = exc.errors()
    if not errors:
        return "invalid"
    e = errors[0]
    loc = ".".join(str(p) for p in e.get("loc", ()) if not (isinstance(p, str) and p.startswith("function-")))
    return f"{loc}: {e.get('msg', 'invalid')}"[:160]


def _extra_keys(obj: dict[str, Any]) -> list[str]:
    known = set(Decision.model_fields)
    return sorted(k for k in obj if k not in known)


def experimental_unwrap(obj: dict[str, Any]) -> dict[str, Any]:
    """A rule the current salvage lacks: a single-key object whose value is a dict that itself
    contains the same key (``{"action": {"thought": ..., "action": {...}}}``) is the decision
    wrapped under one of its own field names.  Measured here to size the gain, not shipped."""
    if len(obj) == 1:
        (key, value), = obj.items()
        if isinstance(value, dict) and key in value:
            return dict(value)
    return obj


def replay(worlds_dir: Path) -> dict[str, Any]:
    files = sorted(worlds_dir.glob("*/runs/*/turns/*/model_calls/mc_*.json"))
    rows: list[dict[str, Any]] = []
    for path in files:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        result = record.get("result") or {}
        if record.get("provider") != "claude_cli" or result.get("status") != "malformed":
            continue
        text = result.get("text") or ""
        obj, changed = salvage(None, text if text.strip() else None)
        row: dict[str, Any] = {
            "path": str(path.relative_to(worlds_dir)),
            "run_id": record.get("run_id") or path.parts[-5] if len(path.parts) >= 5 else None,
            "model_id": record.get("model_id"),
            "response_model": result.get("response_model"),
            "has_text": bool(text.strip()),
            "text_chars": len(text),
            "salvaged": isinstance(obj, dict),
            "salvage_changed": changed,
            "decision_ok": False,
            "decision_error": None,
            "extra_keys": [],
            "cost_usd": result.get("provider_cost_usd"),
            "latency_ms": result.get("latency_ms"),
            "cli_verdict": (result.get("error") or "")[:200],
        }
        if isinstance(obj, dict):
            row["extra_keys"] = _extra_keys(obj)
            try:
                Decision.model_validate(obj)
                row["decision_ok"] = True
            except ValidationError as exc:
                row["decision_error"] = _first_error(exc)
            row["decision_ok_experimental"] = row["decision_ok"]
            if not row["decision_ok"]:
                unwrapped = experimental_unwrap(obj)
                if unwrapped is not obj:
                    try:
                        Decision.model_validate(unwrapped)
                        row["decision_ok_experimental"] = True
                    except ValidationError as exc:
                        row["decision_error_experimental"] = _first_error(exc)
        rows.append(row)
    n = len(rows)
    with_text = [r for r in rows if r["has_text"]]
    salvaged = [r for r in rows if r["salvaged"]]
    ok = [r for r in rows if r["decision_ok"]]
    errors = Counter(r["decision_error"] for r in rows if r["salvaged"] and not r["decision_ok"])
    extra = Counter(k for r in salvaged for k in r["extra_keys"])
    by_run = Counter(r["run_id"] for r in rows)
    wasted = sum(float(r["cost_usd"] or 0.0) for r in rows)
    return {
        "worlds_dir": str(worlds_dir),
        "model_call_files": len(files),
        "malformed": n,
        "with_text": len(with_text),
        "without_text": n - len(with_text),
        "salvaged_to_object": len(salvaged),
        "salvage_rate_of_with_text": round(len(salvaged) / len(with_text), 4) if with_text else None,
        "salvage_rate_of_all": round(len(salvaged) / n, 4) if n else None,
        "decision_valid_after_salvage": len(ok),
        "decision_valid_rate_of_salvaged": round(len(ok) / len(salvaged), 4) if salvaged else None,
        "decision_valid_with_experimental_unwrap": sum(1 for r in rows if r.get("decision_ok_experimental")),
        "experimental_errors": Counter(r.get("decision_error_experimental") for r in rows if r["salvaged"] and not r.get("decision_ok_experimental")).most_common(),
        "decision_errors": errors.most_common(),
        "extra_keys_seen": extra.most_common(),
        "by_run": by_run.most_common(),
        "wasted_cost_usd": round(wasted, 4),
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--worlds-dir", default=str(config.WORLDS_DIR))
    parser.add_argument("--json", default=None, help="write the full report (with per-envelope rows) here")
    args = parser.parse_args()
    report = replay(Path(args.worlds_dir))
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=1), encoding="utf-8")
    n = report["malformed"]
    print(f"model call files scanned: {report['model_call_files']}")
    print(f"claude_cli malformed envelopes: {n} (with stored reply text: {report['with_text']}, empty text: {report['without_text']})")
    print(f"salvage -> JSON object: {report['salvaged_to_object']} ({report['salvage_rate_of_with_text']} of those with text; {report['salvage_rate_of_all']} of all)")
    print(f"salvaged objects that validate as a Decision: {report['decision_valid_after_salvage']} ({report['decision_valid_rate_of_salvaged']} of salvaged)")
    print(f"with the experimental same-key unwrap rule ({{'action': {{'action': ...}}}}): {report['decision_valid_with_experimental_unwrap']} of {report['salvaged_to_object']} would validate; remaining: {report['experimental_errors'][:5]}")
    print(f"paid for malformed replies: ${report['wasted_cost_usd']:.4f}")
    print("Decision validation errors after salvage (first error, grouped):")
    for msg, count in report["decision_errors"][:15]:
        print(f"  {count:3d}  {msg}")
    print("Unknown top-level keys in salvaged objects:", report["extra_keys_seen"][:10])
    print("By run:", report["by_run"])
    print()
    print("Reading: the CLI validated these replies with --max-turns 1, so every verdict was terminal and paid.")
    print("The assistant refs use max_turns 2 / max_model_requests 3, which lets one verdict reach the model;")
    print("that path cannot be replayed offline and is measured live by scripts/assistant_playtest.py (ledger")
    print("status 'malformed' + step outcome).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
