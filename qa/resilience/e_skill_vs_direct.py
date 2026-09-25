"""Criterion e: direct and skill actions share rule enforcement.  A fake-scripted agent
saves the design doc's example 1 skill (REPEAT 3 move up, RETURN on failure) and runs it:
three agent turns of moves at 4 compute each (0.8 x 5), then a model decision; a direct
move costs 5.  Also a skill move into a mountain fails with the discounted attempt fee."""
from __future__ import annotations

import sys

from rlib import (Checks, chain_from_manifest, client, create_run, defaults, ensure_server, open_run, read_json, run_dir,
                  step_round, terrain_map)

EXAMPLE1 = """REPEAT 3
    SET movement_result = move("up")
    IF movement_result.ok == false
        RETURN movement_result.reason
    END
END
RETURN "completed"
"""

ck = Checks("e_skill_vs_direct")
extra: dict = {}
ensure_server()
c = client()
SEED = 1
cells = terrain_map(c, SEED)


def t(x, y):
    return cells.get(f"{x},{y}")


# a03: 3 cells up passable, then the cell right of the end passable
start = None
for key, ter in cells.items():
    x, y = map(int, key.split(","))
    if ter == "mountain" or abs(x) + abs(y) < 3:
        continue
    if all(t(x, y + k) in ("land", "water") for k in (1, 2, 3)) and t(x + 1, y + 3) in ("land", "water"):
        start = (x, y)
        break
# a06: land cell whose up neighbour is a mountain (skill move into a mountain)
blocked = None
for key, ter in cells.items():
    x, y = map(int, key.split(","))
    if ter == "land" and t(x, y + 1) == "mountain" and (x, y) != start:
        blocked = (x, y)
        break
extra["a03_start"] = start
extra["a06_start_below_mountain"] = blocked

req = defaults(c, 8)
req.update(name="res-e skill vs direct", seed=SEED, play_delay_seconds=0.0)
A = {a["id"]: a for a in req["agents"]}
for a in req["agents"]:
    a["fake_options"] = {"idle": True}
A["a03"]["model_key"] = "fake-scripted"
A["a03"]["position"] = {"x": start[0], "y": start[1]}
A["a03"]["fake_script"] = [
    {"thought": "save design example 1 and run it", "save_skills": [{"name": "up3", "params": [], "source": EXAMPLE1}],
     "action": {"name": "run_skill", "args": {"skill": "up3", "arguments": []}}},
    {"thought": "now a direct move", "action": {"name": "move", "args": {"direction": "right"}}},
    {"thought": "direct query", "action": {"name": "query", "args": {"entity": "self"}}},
]
A["a06"]["model_key"] = "fake-scripted"
A["a06"]["fake_options"] = None
A["a06"]["position"] = {"x": blocked[0], "y": blocked[1]}
A["a06"]["fake_script"] = [
    {"thought": "run up3 into the mountain", "save_skills": [{"name": "up3", "params": [], "source": EXAMPLE1}],
     "action": {"name": "run_skill", "args": {"skill": "up3", "arguments": []}}},
    {"thought": "direct move into the mountain", "action": {"name": "move", "args": {"direction": "up"}}},
]
summary = create_run(c, req)
run_id = summary["run_id"]
rd = run_dir(run_id)
extra["run_id"] = run_id
open_run(c, run_id)
for _ in range(5):
    st = step_round(c, run_id)
ck.check("5 rounds run", st["current_turn_id"] == "r00005_end" and st["state"] == "paused", st["current_turn_id"])
chain = chain_from_manifest(rd)


def rows_for(aid):
    out = []
    for tid in [x for x in chain if x.endswith("_" + aid)]:
        tr = read_json(rd / "turns" / tid / "state.json")
        evs = read_json(rd / "turns" / tid / "events.json")
        ag = read_json(rd / "turns" / tid / "entities" / "agents" / f"{aid}.json")
        ar = tr.get("action_result") or {}
        act = tr.get("action") or {}
        out.append({"turn": tid, "source": tr["decision_source"], "calls": tr["model_call_ids"], "action": act.get("name"),
                    "args": act.get("args"), "via_skill": act.get("via_skill"), "ok": ar.get("ok"), "reason": ar.get("reason"),
                    "cost": ar.get("cost_compute"), "pos": ag["position"],
                    "skill_events": [(e["kind"], e["details"].get("status"), e["costs"]["compute"]) for e in evs
                                     if e["kind"].startswith("skill_")],
                    "interp_spent": ag["total_interpreter_spent"]})
    return out


r3 = rows_for("a03")
extra["a03_turns"] = r3
x0, y0 = start
ck.check("turn 1: model decision saves example 1 and its first move executes via the skill at 4 compute",
         r3[0]["source"] == "model" and len(r3[0]["calls"]) == 1 and r3[0]["action"] == "move" and r3[0]["via_skill"]
         and r3[0]["cost"] == 4.0 and r3[0]["pos"] == {"x": x0, "y": y0 + 1}
         and "skill_saved" in [k for k, _, _ in r3[0]["skill_events"]],
         r3[0])
ck.check("turns 2 and 3: the skill continues with no model call, each move 4 compute",
         all(r["source"] == "skill" and r["calls"] == [] and r["action"] == "move" and r["via_skill"] and r["cost"] == 4.0
             for r in r3[1:3]) and r3[2]["pos"] == {"x": x0, "y": y0 + 3},
         r3[1:3])
ck.check("turn 4: the skill returns and a model decision follows in the same turn (direct move = 5)",
         r3[3]["source"] == "model" and len(r3[3]["calls"]) == 1 and r3[3]["action"] == "move" and not r3[3]["via_skill"]
         and r3[3]["cost"] == 5.0 and r3[3]["pos"] == {"x": x0 + 1, "y": y0 + 3}
         and any(k == "skill_finished" for k, _, _ in r3[3]["skill_events"]),
         r3[3])
ck.check("exactly 3 agent turns of skill moves (12 compute = 3 x 0.8 x 5), then a direct query costs 1",
         sum(1 for r in r3 if r["via_skill"]) == 3 and sum(r["cost"] for r in r3 if r["via_skill"]) == 12.0
         and r3[4]["action"] == "query" and r3[4]["cost"] == 1.0,
         {"skill_moves": sum(1 for r in r3 if r["via_skill"]), "query": r3[4] if len(r3) > 4 else None})
ck.check("interpreter work is charged separately (0.01 per op), not folded into the action price",
         r3[3]["interp_spent"] > 0 and all(r["cost"] in (4.0, 5.0, 1.0) for r in r3),
         {"total_interpreter_spent": r3[-1]["interp_spent"]})
r6 = rows_for("a06")
extra["a06_turns"] = r6
ck.check("skill move into a mountain: blocked, discounted attempt fee 0.8, position unchanged",
         r6[0]["action"] == "move" and r6[0]["via_skill"] and r6[0]["reason"] == "blocked" and r6[0]["cost"] == 0.8
         and r6[0]["pos"] == {"x": blocked[0], "y": blocked[1]}, r6[0])
ck.check("direct move into a mountain: blocked, attempt fee 1.0, position unchanged",
         any(r["action"] == "move" and not r["via_skill"] and r["reason"] == "blocked" and r["cost"] == 1.0
             and r["pos"] == {"x": blocked[0], "y": blocked[1]} for r in r6), r6[1:3])
c.post(f"/runs/{run_id}/close")
p = ck.dump(extra)
print("evidence:", p, "ALL OK" if ck.all_ok else "SOME FAILED")
sys.exit(0 if ck.all_ok else 1)
