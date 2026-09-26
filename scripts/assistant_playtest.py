#!/usr/bin/env python3
"""Ground-truthed playtest of the built-in assistant across model tiers (haiku / sonnet, small opus
arm): builds question sets whose answers are computed from run storage, asks each through the
assistant API, scores automatically and logs cost, latency, steps and format failures per call.
Spends real money: refuses to run unless EMPYREAN_ALLOW_LIVE=1.  Filled in by the verification pass
(see docs/ASSISTANT.md, "Model tier evidence").

Usage: EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/assistant_playtest.py --run RUN_ID --arm haiku|sonnet [...]
"""
# DOCS: verification helper; the only script that calls live assistant models on purpose.
from __future__ import annotations

import os
import sys


def main() -> int:
    if os.environ.get("EMPYREAN_ALLOW_LIVE") != "1":
        print("refusing to run: set EMPYREAN_ALLOW_LIVE=1 to allow live model spend")
        return 2
    print("assistant_playtest: not implemented yet (verification pass pending)")
    return 2


if __name__ == "__main__":
    sys.exit(main())
