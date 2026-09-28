"""Fork a saved run at a committed turn (the product's continuation) and play the branch to a round limit.

The branch copies the source run's state at that turn (world, memories, notebooks, skills, the
seeded random state), so only the models' own sampling differs between branches of one fork point.
Round limit and budget guard are set with an update_run_settings intervention; the branch is
registered in sweep/registry.json under TAG so the sweep watchdog keeps it playing.

Usage: fork_exp.py <source_run_id> <from_turn_id> <TAG> "<name>" <max_rounds> <budget_usd> <port>
"""
import sys, time
sys.path.insert(0, "/home/ubuntu/antegensim/sweep/tools")
import sweep as S

src, turn, tag, name, rounds, budget, port = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]), float(sys.argv[6]), int(sys.argv[7])
if tag in S.read_registry()["runs"]:
    raise SystemExit(f"{tag} already registered")
c, summ = S.call("POST", f"/runs/{src}/continuations", {"from_turn_id": turn, "name": name}, port=port, timeout=300)
if c != 201:
    raise SystemExit(f"continuation failed {c}: {str(summ)[:800]}")
rid = summ["run_id"]
c, st = S.call("GET", f"/runs/{rid}/status", port=port)
if c == 409:
    S.call("POST", f"/runs/{rid}/open", port=port, timeout=180)
c, resp = S.call("POST", f"/runs/{rid}/interventions", {"type": "update_run_settings", "max_rounds": rounds,
                 "real_budget_usd": budget, "play_delay_seconds": 0.0, "note": f"fork experiment: play to round {rounds}"}, port=port)
if c not in (200, 201):
    raise SystemExit(f"settings intervention failed {c}: {str(resp)[:500]}")
c2, _ = S.call("POST", f"/runs/{rid}/commands", {"command": "play"}, port=port)
with S.Registry() as r:
    r["runs"][tag] = {"run_id": rid, "world_id": summ.get("world_id"), "name": name, "scenario": f"fork of {src} at {turn}",
                      "status": "running", "port": port, "agents": 32, "max_rounds": rounds,
                      "launched": time.strftime("%Y-%m-%d %H:%M:%S"), "notes": [f"continuation of {src} from {turn}"]}
print(f"forked {tag} -> {rid} on :{port} from {turn} ({name}, to r{rounds}, ${budget:g}; play {c2})")
