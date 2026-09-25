"""Criterion b: new and resumed sessions open paused; GET /api/defaults gives editable
cards with defaults; run_turn advances exactly one agent turn; play continues; pause
yields pause_requested then paused; step_round stops at r{n}_end."""
from __future__ import annotations

import sys
import time

from rlib import (Checks, client, command, create_run, defaults, ensure_server, index_entries, open_run, run_dir,
                  status, wait_for, wait_idle)

ck = Checks("b_controls")
extra: dict = {}
ensure_server()
c = client()

# defaults for 6..11 cards
counts = {}
for n in (6, 8, 11):
    d = defaults(c, n)
    counts[n] = len(d["agents"])
bad = c.get("/defaults", params={"agent_count": 12})
ck.check("GET /defaults returns 6/8/11 prefilled cards; 12 rejected",
         counts == {6: 6, 8: 8, 11: 11} and bad.status_code == 422, {"counts": counts, "agent_count=12": bad.status_code})
d = defaults(c, 8)
card = d["agents"][0]
filled = all(card.get(k) not in (None, "") for k in ("id", "name", "position", "stats"))
ck.check("cards carry usable defaults (id, name, position, full stats)", filled and len(card["stats"]) == 13,
         {"card0": {k: card[k] for k in ("id", "name", "position")}, "stats": card["stats"]})
ids = [a["id"] for a in d["agents"]]
names = [a["name"] for a in d["agents"]]
ck.check("default cards have unique ids and names", len(set(ids)) == 8 and len(set(names)) == 8, list(zip(ids, names)))

# edit cards: validation reports problems by path; a fixed edit validates and creates
edited = defaults(c, 8)
edited["agents"][2]["stats"]["health"] = 999
edited["agents"][5]["name"] = edited["agents"][1]["name"]
v = c.post("/runs/validate", json=edited).json()
paths = sorted(p["path"] for p in v["problems"])
ck.check("edited invalid cards are reported by path", not v["ok"] and "agents[2].stats.health" in paths and "agents[5].name" in paths,
         v["problems"])
edited = defaults(c, 8)
edited.update(name="res-b controls", play_delay_seconds=0.0)
edited["agents"][0]["name"] = "Edited Aster"
edited["agents"][0]["position"] = {"x": 3, "y": 0}
edited["agents"][0]["stats"]["compute"] = 150
for a in edited["agents"]:
    a["fake_options"] = {"sleep_ms": 400}
v = c.post("/runs/validate", json=edited).json()
ck.check("edited valid cards validate ok", v["ok"], v)
summary = create_run(c, edited)
run_id = summary["run_id"]
extra["run_id"] = run_id
rd = run_dir(run_id)
import json
a01 = json.loads((rd / "turns" / "r00000_init" / "entities" / "agents" / "a01.json").read_text())
ck.check("card edits land in r00000_init", a01["name"] == "Edited Aster" and a01["position"] == {"x": 3, "y": 0}
         and a01["stats"]["compute"] == 150, {k: a01[k] for k in ("name", "position")} | {"compute": a01["stats"]["compute"]})
ck.check("POST /runs summary says paused", summary["status"] == "paused", summary["status"])
st = open_run(c, run_id)
ck.check("new session opens paused", st["state"] == "paused" and st["current_turn_id"] == "r00000_init"
         and st["active_command"] is None, {k: st[k] for k in ("state", "current_turn_id", "next_step", "next_agent_id")})

# run_turn: exactly one agent turn
before = index_entries(rd)
r = command(c, run_id, "run_turn")
ck.check("run_turn accepted while paused", r.status_code == 200, r.json()["state"])
st = wait_idle(c, run_id)
after = index_entries(rd)
new = after[len(before):]
ck.check("run_turn commits exactly one agent turn then pauses",
         len(new) == 1 and new[0]["kind"] == "agent_turn" and new[0]["turn_id"] == "r00001_t01_" + new[0]["acting_agent_id"]
         and st["state"] == "paused" and st["current_turn_id"] == new[0]["turn_id"],
         {"new_turns": [e["turn_id"] for e in new], "state": st["state"]})
# a second run_turn -> t02
r = command(c, run_id, "run_turn")
st = wait_idle(c, run_id)
after2 = index_entries(rd)
ck.check("second run_turn commits exactly the next agent turn", len(after2) == len(after) + 1
         and after2[-1]["turn_id"].startswith("r00001_t02_"), after2[-1]["turn_id"])

# overlapping command rejected
command(c, run_id, "play")
time.sleep(0.1)
ov = command(c, run_id, "run_turn")
ck.check("overlapping run command rejected with 409", ov.status_code == 409 and ov.json()["error"] == "illegal_command",
         {"status": ov.status_code, "body": ov.json()})
# play continues across several turns
n0 = len(index_entries(rd))
wait_for(lambda: len(index_entries(rd)) >= n0 + 3, timeout=60, what="play committing 3 more turns")
st = status(c, run_id)
ck.check("play keeps committing turns without further commands", len(index_entries(rd)) >= n0 + 3 and st["play_loop"],
         {"committed": len(index_entries(rd)) - n0, "state": st["state"], "play_loop": st["play_loop"]})
# pause -> pause_requested then paused
pr = command(c, run_id, "pause")
seen = [pr.json()["state"]]
t0 = time.time()
while time.time() - t0 < 30:
    s = status(c, run_id)["state"]
    if s != seen[-1]:
        seen.append(s)
    if s == "paused":
        break
    time.sleep(0.01)
ck.check("pause yields pause_requested then paused", seen[0] == "pause_requested" and seen[-1] == "paused", seen)
n1 = len(index_entries(rd))
time.sleep(1.5)
ck.check("nothing commits after paused", len(index_entries(rd)) == n1 and status(c, run_id)["state"] == "paused", n1)
pn = command(c, run_id, "pause")
ck.check("pause while paused is a no-op (200, stays paused)", pn.status_code == 200 and pn.json()["state"] == "paused",
         pn.json()["state"])

# step_round stops at r{n}_end
cur = status(c, run_id)
r = command(c, run_id, "step_round")
st = wait_idle(c, run_id)
last = index_entries(rd)[-1]
rnd = int(cur["current_turn_id"][1:6]) if not cur["current_turn_id"].endswith("_end") else int(cur["current_turn_id"][1:6]) + 1
ck.check("step_round stops at r{n}_end", st["current_turn_id"] == f"r{rnd:05d}_end" and last["kind"] == "round_end"
         and st["state"] == "paused", {"from": cur["current_turn_id"], "to": st["current_turn_id"], "next_step": st["next_step"]})
r = command(c, run_id, "step_round")
st = wait_idle(c, run_id)
ck.check("a second step_round runs the next full round and stops at its end", st["current_turn_id"] == f"r{rnd + 1:05d}_end",
         st["current_turn_id"])
# run_turn at a round boundary starts the next round with t01
r = command(c, run_id, "run_turn")
st = wait_idle(c, run_id)
ck.check("run_turn after a round end runs the first agent of the next round",
         st["current_turn_id"].startswith(f"r{rnd + 2:05d}_t01_"), st["current_turn_id"])

# resumed session opens paused (close + reopen)
c.post(f"/runs/{run_id}/close")
time.sleep(0.5)
nopen = c.get(f"/runs/{run_id}/status")
ck.check("routes needing the runner say run_not_open after close", nopen.status_code == 409 and nopen.json()["error"] == "run_not_open",
         nopen.json())
st = open_run(c, run_id)
ck.check("resumed session opens paused at the same committed turn", st["state"] == "paused"
         and st["current_turn_id"] == index_entries(rd)[-1]["turn_id"], {k: st[k] for k in ("state", "current_turn_id")})
# resume while playing: close during play, reopen -> paused
command(c, run_id, "play")
time.sleep(1.0)
c.post(f"/runs/{run_id}/close")
st = open_run(c, run_id)
ck.check("closing during play and reopening gives paused (active turn committed)",
         st["state"] == "paused" and st["current_turn_id"] == index_entries(rd)[-1]["turn_id"],
         {k: st[k] for k in ("state", "current_turn_id")})
c.post(f"/runs/{run_id}/close")
p = ck.dump(extra)
print("evidence:", p, "ALL OK" if ck.all_ok else "SOME FAILED")
sys.exit(0 if ck.all_ok else 1)
