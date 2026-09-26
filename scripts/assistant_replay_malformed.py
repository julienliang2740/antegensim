#!/usr/bin/env python3
"""Replay stored malformed claude_cli decision envelopes through the assistant's deterministic
salvage (``empyrean.assistant.calls.salvage``) and report the salvage rate.  No model is called and
nothing is spent.  Filled in by the verification pass (see docs/TEST_PLAN.md, "Assistant release").

Usage: .venv/bin/python scripts/assistant_replay_malformed.py [--worlds-dir DIR]
"""
# DOCS: verification helper; reads worlds/*/runs/*/turns/*/model_calls/mc_*.json only.
from __future__ import annotations

import sys


def main() -> int:
    print("assistant_replay_malformed: not implemented yet (verification pass pending)")
    return 2


if __name__ == "__main__":
    sys.exit(main())
