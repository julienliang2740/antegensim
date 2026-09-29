"""Launch a variant of a baseline: its stored setup (GET /api/runs/{baseline}/setup) plus a patch.

The patch is JSON: {"prices": {...}, "stats": {...every agent...}, "rules": {...deep merge...}}.
Name, seed, max_rounds and budget are set as in launch_exp.py; the run is registered under TAG
for the sweep watchdog. At most 4 live runs per backend.

Usage: launch_variant.py <baseline_run_id> <TAG> "<name>" <seed> <max_rounds> <budget_usd> <port> '<patch json>'
"""
import copy, json, sys, time
sys.path.insert(0, "/home/ubuntu/antegensim/sweep/tools")
import sweep as S

base, tag, name, seed, rounds, budget, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), float(sys.argv[6]), int(sys.argv[7])
patch = json.loads(sys.argv[8]) if len(sys.argv) > 8 else {}
reg = S.read_registry()["runs"]
if tag in reg:
    raise SystemExit(f"{tag} already registered")
if sum(1 for r in reg.values() if r["status"] == "running" and r.get("port") == port) >= S.MAX_PER_BACKEND:
    raise SystemExit(f"no free slot on :{port}")
c, req = S.call("GET", f"/runs/{base}/setup", port=port, timeout=60)
if c != 200:
    raise SystemExit(f"setup failed {c}")
req = S.deep_merge(req, {"rules": patch.get("rules", {})})
req["rules"]["prices"].update(patch.get("prices", {}))
for a in req["agents"]:
    a["stats"] = {**(a.get("stats") or {}), **patch.get("stats", {})}
req.update({"name": name, "seed": seed, "max_rounds": rounds, "real_budget_usd": budget, "play_delay_seconds": 0.0, "world_id": None})
c, v = S.call("POST", "/runs/validate", req, port=port)
if c != 200 or (isinstance(v, dict) and v.get("ok") is False):
    raise SystemExit(f"validate failed {c}: {str(v)[:1200]}")
c, s = S.call("POST", "/runs", req, timeout=120, port=port)
if c != 201:
    raise SystemExit(f"create failed {c}: {str(s)[:800]}")
rid = s["run_id"]
S.call("POST", f"/runs/{rid}/open", port=port, timeout=120)
c2, _ = S.call("POST", f"/runs/{rid}/commands", {"command": "play"}, port=port)
with S.Registry() as r:
    r["runs"][tag] = {"run_id": rid, "world_id": s.get("world_id"), "name": name, "scenario": f"variant of {base}: {json.dumps(patch)}",
                      "status": "running", "port": port, "agents": len(req["agents"]), "max_rounds": rounds,
                      "launched": time.strftime("%Y-%m-%d %H:%M:%S"), "notes": [f"variant of {base}, seed {seed}, patch {json.dumps(patch)}"]}
print(f"launched {tag} -> {rid} on :{port} ({name}; {json.dumps(patch)})")
