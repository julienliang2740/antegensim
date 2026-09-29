#!/usr/bin/env python3
"""Drive the 2026-09-29 model comparison: when a trunk (MC-<baseline>-<model>) has finished round
FORK_ROUND, fork it twice (tags <trunk>-A and <trunk>-B) and play each branch to FORK_ROUND + 20.

Usage: mc_driver.py   (runs until every trunk has been forked; logs to sweep/tools/mc_driver.log)
"""
import subprocess, sys, time
sys.path.insert(0, "/home/ubuntu/antegensim/sweep/tools")
import sweep as S

FORK_ROUND, BRANCH_ROUNDS = 25, 20
TRUNKS = {"MC-FG-HAIKU": 10.0, "MC-TT-HAIKU": 10.0, "MC-FG-LUNA": 2.0, "MC-TT-LUNA": 2.0, "MC-FG-DSV4": 2.0, "MC-TT-DSV4": 2.0}
LOG = open(f"{S.TOOLS}/mc_driver.log", "a")


def say(m):
    LOG.write(time.strftime("%H:%M:%S ") + m + "\n"); LOG.flush()


done = set()
say("driver start")
while len(done) < len(TRUNKS):
    reg = S.read_registry()["runs"]
    for tag, budget in TRUNKS.items():
        e = reg[tag]
        if tag in done or e["status"] != "finished":
            continue
        name = e["name"]
        for b in ("A", "B"):
            if f"{tag}-{b}" in reg:
                continue
            out = subprocess.run([f"{S.REPO}/.venv/bin/python", f"{S.TOOLS}/showcase/fork_exp.py", e["run_id"], f"r{FORK_ROUND:05d}_end",
                                  f"{tag}-{b}", f"{name} · fork {b}", str(FORK_ROUND + BRANCH_ROUNDS), str(budget), str(e["port"])],
                                 capture_output=True, text=True)
            say(f"{tag}-{b}: {out.stdout.strip()} {out.stderr.strip()[-300:]}")
        done.add(tag)
    time.sleep(20)
say("driver done")
