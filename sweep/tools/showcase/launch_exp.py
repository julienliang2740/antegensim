"""Launch one experiment run as an exact clone of a baseline run's stored setup.

Only the name, seed, max_rounds and real budget change (GET /api/runs/{baseline}/setup is the
original RunCreateRequest). The run is registered in sweep/registry.json under TAG so the sweep
watchdog keeps it playing. At most 4 live runs per backend; experiment backends are :8001 and :8002
(the operator's :8000 service has no `claude` on its PATH).

Usage: launch_exp.py <baseline_run_id> <TAG> "<name>" <seed> <max_rounds> <budget_usd> [port]
"""
import sys, time
sys.path.insert(0, "/home/ubuntu/antegensim/sweep/tools")
import sweep as S

base, tag, name, seed, rounds, budget = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), float(sys.argv[6])
reg = S.read_registry()["runs"]
if tag in reg:
    raise SystemExit(f"{tag} already registered as {reg[tag]['run_id']} ({reg[tag]['status']})")
EXP_BACKENDS = [8001, 8002]
load = {p: sum(1 for r in reg.values() if r["status"] == "running" and r.get("port", 8000) == p) for p in EXP_BACKENDS + [8000]}
if len(sys.argv) > 7:
    port = int(sys.argv[7])
else:
    up = [p for p in EXP_BACKENDS if S.call("GET", "/models", port=p, timeout=10)[0] == 200]
    port = min(up, key=lambda p: (load[p], p))
if load.get(port, 0) >= S.MAX_PER_BACKEND:
    raise SystemExit(f"no free slot: live runs per backend {load}")
c, req = S.call("GET", f"/runs/{base}/setup", port=port, timeout=60)
if c != 200:
    raise SystemExit(f"setup of {base} failed: {c} {str(req)[:300]}")
req.update({"name": name, "seed": seed, "max_rounds": rounds, "real_budget_usd": budget, "play_delay_seconds": 0.0, "world_id": None})
c, v = S.call("POST", "/runs/validate", req, port=port)
if c != 200 or (isinstance(v, dict) and v.get("ok") is False):
    raise SystemExit(f"validate failed {c}: {str(v)[:1500]}")
c, s = S.call("POST", "/runs", req, timeout=120, port=port)
if c != 201:
    raise SystemExit(f"create failed {c}: {str(s)[:1500]}")
rid = s["run_id"]
S.call("POST", f"/runs/{rid}/open", port=port, timeout=120)
c2, _ = S.call("POST", f"/runs/{rid}/commands", {"command": "play"}, port=port)
with S.Registry() as r:
    r["runs"][tag] = {"run_id": rid, "world_id": s.get("world_id"), "name": name, "scenario": f"clone of {base}",
                      "status": "running", "port": port, "agents": len(req["agents"]), "max_rounds": rounds,
                      "launched": time.strftime("%Y-%m-%d %H:%M:%S"), "notes": [f"clone of baseline {base}, seed {seed}"]}
print(f"launched {tag} -> {rid} on :{port} ({name}, seed {seed}, {rounds} rounds, ${budget:g} guard; play {c2})")
