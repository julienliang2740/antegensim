"""Criterion d: malformed model output and invalid actions fail without crashing the
simulation or applying forbidden effects; failures are recorded with the design's fees.

Setup (8 agents): a01, a02 use fake-malformed (invalid JSON / unknown action / valid by
round); a03 uses fake-scripted with impossible actions; a04 (idle) shares a03's point so
the transfer recipient is visible; a05 gets a scheduled 'truncated' reply in round 2;
a08 is far away (unseen attack target).  Every a03 turn is checked against the design's
failure fees: blocked/target_gone/at_limit/invalid_argument = attempt fee min(1, price),
insufficient_* = no debit; format-gate failures = no action at all (cognition only).
"""
from __future__ import annotations

import json
import sys

from rlib import (Checks, chain_from_manifest, client, create_run, defaults, ensure_server, log_offset, log_since,
                  open_run, read_json, run_dir, status, step_round, terrain_map)

ck = Checks("d_invalid")
extra: dict = {}
ensure_server()
c = client()

SEED = 1
cells = terrain_map(c, SEED)
DIRS = {"up": (0, 1), "down": (0, -1), "left": (-1, 0), "right": (1, 0)}
spot = None
for key, t in cells.items():
    if t != "land":
        continue
    x, y = map(int, key.split(","))
    if abs(x) + abs(y) <= 3:
        continue
    for dname, (dx, dy) in DIRS.items():
        if cells.get(f"{x + dx},{y + dy}") == "mountain":
            spot = (x, y, dname)
            break
    if spot:
        break
assert spot, "no land cell next to a mountain"
mx, my, mdir = spot
extra["a03_position"] = {"x": mx, "y": my, "mountain_direction": mdir}

req = defaults(c, 8)
req.update(name="res-d malformed + invalid actions", seed=SEED, play_delay_seconds=0.0)
A = {a["id"]: a for a in req["agents"]}
A["a01"]["model_key"] = "fake-malformed"
A["a02"]["model_key"] = "fake-malformed"
A["a03"]["model_key"] = "fake-scripted"
A["a03"]["position"] = {"x": mx, "y": my}
A["a03"]["stats"]["compute_absorption"] = 1.0  # at its hard cap
A["a04"]["position"] = {"x": mx, "y": my}
A["a04"]["fake_options"] = {"idle": True}
A["a05"]["fake_options"] = {"fail": {"status": "truncated", "rounds": [2]}}
far = next(k for k, t in cells.items() if t == "land" and abs(int(k.split(",")[0]) - mx) + abs(int(k.split(",")[1]) - my) >= 12)
A["a08"]["position"] = {"x": int(far.split(",")[0]), "y": int(far.split(",")[1])}  # far away: unseen by a03
extra["a08_position"] = A["a08"]["position"]
SCRIPT = [
    {"thought": "walk into the mountain", "action": {"name": "move", "args": {"direction": mdir}}},
    {"thought": "give away more than I have", "action": {"name": "transfer", "args": {"recipient": "a04", "resource": "compute", "amount": 100000}}},
    {"thought": "hit someone I cannot see", "action": {"name": "attack", "args": {"target": "a08", "compute_budget": 5}}},
    {"thought": "upgrade past the cap", "action": {"name": "upgrade", "args": {"attribute": "compute_absorption"}}},
    {"thought": "give away more essence than I have", "action": {"name": "transfer", "args": {"recipient": "a04", "resource": "essence", "amount": 500}}},
    {"thought": "eat a fruit that does not exist", "action": {"name": "absorb", "args": {"source": "f9999", "resource": "compute"}}},
    {"thought": "attack myself", "action": {"name": "attack", "args": {"target": "a03", "compute_budget": 3}}},
    {"thought": "negative budget", "action": {"name": "recover", "args": {"compute_budget": -5}}},
    {"thought": "extra key", "action": {"name": "wait", "args": {"rounds": 1}}, "bogus": 1},
    {"thought": "string number", "action": {"name": "transfer", "args": {"recipient": "a04", "resource": "compute", "amount": "10"}}},
]
# expected: (reason, action fee) ; None reason = format gate rejects the whole decision
EXPECT = [("blocked", 1.0), ("insufficient_compute", 0.0), ("target_gone", 1.0), ("at_limit", 1.0),
          ("insufficient_essence", 0.0), ("target_gone", 1.0), ("invalid_argument", 1.0), (None, 0.0), (None, 0.0), (None, 0.0)]
A["a03"]["fake_script"] = SCRIPT

summary = create_run(c, req)
run_id = summary["run_id"]
rd = run_dir(run_id)
extra["run_id"] = run_id
open_run(c, run_id)
off = log_offset()
states = []
for _ in range(len(SCRIPT) + 1):
    st = step_round(c, run_id)
    states.append((st["current_turn_id"], st["state"], st["last_error"]))
    if st["state"] != "paused":
        break
ck.check("run survives every round (never error/crash)", all(s[1] == "paused" and s[2] is None for s in states), states)
log_new = log_since(off)
ck.check("no traceback in the server log", "Traceback" not in log_new and "turn failed" not in log_new,
         [line for line in log_new.splitlines() if "Traceback" in line or "ERROR" in line][:5])

chain = chain_from_manifest(rd)


def agent_at(tid: str, aid: str) -> dict:
    return read_json(rd / "turns" / tid / "entities" / "agents" / f"{aid}.json")


def charged(tid: str) -> float:
    idx = rd / "turns" / tid / "model_calls" / "index.json"
    return sum(m["charged_compute"] for m in read_json(idx)) if idx.exists() else 0.0


rows = []
a03_turns = [t for t in chain if t.endswith("_a03")]
for i, tid in enumerate(a03_turns[: len(SCRIPT)]):
    prev = chain[chain.index(tid) - 1]
    tr = read_json(rd / "turns" / tid / "state.json")
    evs = read_json(rd / "turns" / tid / "events.json")
    before, after = agent_at(prev, "a03"), agent_at(tid, "a03")
    b4, a4 = agent_at(prev, "a04"), agent_at(tid, "a04")
    b8, a8 = agent_at(prev, "a08"), agent_at(tid, "a08")
    ar = tr.get("action_result") or {}
    reason_exp, fee_exp = EXPECT[i]
    cog = charged(tid)
    d_compute = after["stats"]["compute"] - before["stats"]["compute"]
    kinds = [e["kind"] for e in evs]
    row = {"turn": tid, "script": SCRIPT[i]["action"]["name"], "decision_source": tr["decision_source"],
           "action": tr.get("action"), "reason": ar.get("reason"), "cost_compute": ar.get("cost_compute"),
           "cost_essence": ar.get("cost_essence"), "cognition": cog, "d_compute": round(d_compute, 9),
           "d_essence": after["stats"]["essence"] - before["stats"]["essence"],
           "position_same": after["position"] == before["position"],
           "last_result": (after.get("last_result") or {}).get("reason"), "events": kinds}
    if reason_exp is None:
        ok = (tr.get("action") is None and "decision_invalid" in kinds and "action" not in kinds
              and row["last_result"] == "invalid_action" and abs(d_compute + cog) < 1e-9 and row["position_same"]
              and row["d_essence"] == 0)
    else:
        ok = (ar.get("ok") is False and ar.get("reason") == reason_exp and abs(ar.get("cost_compute", -1) - fee_exp) < 1e-9
              and ar.get("cost_essence") == 0 and abs(d_compute - (-fee_exp - cog)) < 1e-9 and row["position_same"]
              and row["d_essence"] == 0)
    # forbidden effects on others
    row["a04_compute_same"] = a4["stats"]["compute"] == b4["stats"]["compute"] and a4["stats"]["essence"] == b4["stats"]["essence"]
    row["a08_health_same"] = a8["stats"]["health"] == b8["stats"]["health"]
    row["a03_abs_same"] = after["stats"]["compute_absorption"] == 1.0 and after.get("upgrade_counts", {}) == before.get("upgrade_counts", {})
    ok = ok and row["a04_compute_same"] and row["a08_health_same"] and row["a03_abs_same"]
    row["ok"] = ok
    rows.append(row)
    ck.check(f"a03 {SCRIPT[i]['thought']!r}: expected {reason_exp or 'format-gate rejection'} fee {fee_exp}", ok,
             {k: row[k] for k in ("turn", "reason", "cost_compute", "cognition", "d_compute", "position_same",
                                  "a04_compute_same", "a08_health_same", "last_result")})
extra["a03_rows"] = rows

# knowledge records the failure for a03 (the agent is told why next turn)
k = c.get(f"/runs/{run_id}/agents/a03/knowledge").json()["knowledge"]["records"]
sys_recs = [r["text"][:120] for r in k if r["kind"] == "system" and ("invalid" in r["text"].lower() or "reply" in r["text"].lower())]
act_recs = [(r["content"].get("result") or {}).get("reason") for r in k if r["kind"] == "action_result"]
ck.check("a03 knowledge holds the failure feedback (action results + invalid reply reasons)",
         {"blocked", "insufficient_compute", "target_gone", "at_limit"} <= set(act_recs) and len(sys_recs) >= 3,
         {"action_result_reasons": act_recs, "system_records": sys_recs[:4]})

# malformed agents: every decision_invalid turn applies no effect beyond cognition
mal_rows = []
for aid in ("a01", "a02"):
    for tid in [t for t in chain if t.endswith("_" + aid)]:
        prev = chain[chain.index(tid) - 1]
        evs = read_json(rd / "turns" / tid / "events.json")
        kinds = [e["kind"] for e in evs]
        tr = read_json(rd / "turns" / tid / "state.json")
        mcs = read_json(rd / "turns" / tid / "model_calls" / "index.json")
        before, after = agent_at(prev, aid), agent_at(tid, aid)
        if "decision_invalid" not in kinds:
            continue
        cog = sum(m["charged_compute"] for m in mcs)
        bs = dict(before["stats"]); as_ = dict(after["stats"])
        bs.pop("compute"); as_.pop("compute")
        ok = (tr.get("action") is None and "action" not in kinds and after["position"] == before["position"] and bs == as_
              and abs((after["stats"]["compute"] - before["stats"]["compute"]) + cog) < 1e-9
              and (after.get("last_result") or {}).get("reason") == "invalid_action")
        inv = next(e for e in evs if e["kind"] == "decision_invalid")
        mal_rows.append({"turn": tid, "result_status": [m.get("result_status") for m in mcs], "charged": cog,
                         "reason": inv["details"].get("reason", "")[:90], "ok": ok})
extra["malformed_rows"] = mal_rows
kinds_seen = {tuple(r["result_status"]) for r in mal_rows}
ck.check("fake-malformed: invalid JSON and unknown action both rejected, no action, only cognition charged",
         len(mal_rows) >= 4 and all(r["ok"] for r in mal_rows) and all(r["charged"] > 0 for r in mal_rows),
         {"turns": len(mal_rows), "result_statuses": sorted(kinds_seen), "sample": mal_rows[:3]})

# truncated reply for a05 in round 2
t5 = [t for t in chain if t.startswith("r00002_") and t.endswith("_a05")]
if t5:
    evs = read_json(rd / "turns" / t5[0] / "events.json")
    mcs = read_json(rd / "turns" / t5[0] / "model_calls" / "index.json")
    tr = read_json(rd / "turns" / t5[0] / "state.json")
    ck.check("truncated reply (a05 round 2) is a failed call with no action", tr.get("action") is None
             and any(m.get("result_status") == "truncated" for m in mcs) and "decision_invalid" in [e["kind"] for e in evs],
             {"turn": t5[0], "calls": [(m["status"], m.get("result_status"), m["charged_compute"]) for m in mcs]})
p = ck.dump(extra)
print("evidence:", p, "ALL OK" if ck.all_ok else "SOME FAILED")
sys.exit(0 if ck.all_ok else 1)
