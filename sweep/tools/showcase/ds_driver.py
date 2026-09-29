#!/usr/bin/env python3
"""Play the DeepSeek V4 Flash trunks of the 2026-09-29 model comparison inside the deployment's quota.

The Azure deployment allows 125 requests and 125,000 tokens per 60 s; a decision is ~3.2K tokens,
so the token limit binds (~37 calls/min).  The DeepSeek backend (:8003) runs with model concurrency 1
(~25 calls/min, ~65% of the token quota), and only one DeepSeek run plays at a time.  Each trunk is
played to ROUND_LIMIT.  Guard: the first HTTP 429 in the backend log parks the playing run and stops
this driver (a rate-limited run is not allowed to continue).

Usage: ds_driver.py   (logs to sweep/tools/ds_driver.log)
"""
import os, sys, time
sys.path.insert(0, "/home/ubuntu/antegensim/sweep/tools")
import sweep as S

PORT, ROUND_LIMIT = 8003, 15
QUEUE = ["MC-FG-DSV4", "MC-TT-DSV4"]
LOG = open(f"{S.TOOLS}/ds_driver.log", "a")
BACKEND_LOG = f"{S.TOOLS}/backend{PORT}.log"


def say(m):
    LOG.write(time.strftime("%H:%M:%S ") + m + "\n"); LOG.flush()


def new_429s(pos):
    with open(BACKEND_LOG, "rb") as f:
        f.seek(pos)
        chunk = f.read()
    return chunk.count(b" 429 "), pos + len(chunk)


say(f"ds driver start: queue {QUEUE}, to r{ROUND_LIMIT}, concurrency {S.PORT_ENV[PORT]['EMPYREAN_MODEL_CONCURRENCY']}")
for tag in QUEUE:
    rid = S.read_registry()["runs"][tag]["run_id"]
    S.call("POST", f"/runs/{rid}/open", port=PORT, timeout=180)
    c, _ = S.call("POST", f"/runs/{rid}/interventions", {"type": "update_run_settings", "max_rounds": ROUND_LIMIT, "real_budget_usd": 2.0,
                  "play_delay_seconds": 0.0, "note": f"model comparison: DeepSeek within quota, play to round {ROUND_LIMIT}"}, port=PORT)
    pos = os.path.getsize(BACKEND_LOG)
    with S.Registry() as r:
        r["runs"][tag].update({"status": "running", "port": PORT, "max_rounds": ROUND_LIMIT})
        r["runs"][tag]["notes"].append(f"{time.strftime('%H:%M')} resumed within quota: concurrency 1, one run at a time, to r{ROUND_LIMIT}")
    c2, _ = S.call("POST", f"/runs/{rid}/commands", {"command": "play"}, port=PORT)
    say(f"{tag} {rid}: settings {c}, play {c2}")
    while True:
        time.sleep(5)
        n, pos = new_429s(pos)
        if n:
            say(f"{tag}: {n} HTTP 429 seen: parking and stopping")
            S.cmd_park(tag, "HTTP 429 during the within-quota phase")
            raise SystemExit(1)
        if S.read_registry()["runs"][tag]["status"] != "running":
            say(f"{tag}: {S.read_registry()['runs'][tag]['status']}")
            break
say("ds driver done")
