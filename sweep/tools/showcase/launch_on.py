"""Launch one scenario on a chosen backend port with the sweep tool's own functions (sweep.py is not modified)."""
import sys, json, time
sys.path.insert(0, "/home/ubuntu/antegensim/sweep/tools")
import sweep as S

path, port = sys.argv[1], int(sys.argv[2])
sc = S.load_scenario(path)
tag = S.tag_of(path)
assert tag not in S.read_registry()["runs"], f"{tag} already launched"
c, defaults = S.call("GET", f"/defaults?agent_count={min(64, max(6, len(sc['agents'])))}", port=port)
req = S.build_request(sc, defaults)
c, v = S.call("POST", "/runs/validate", req, port=port)
assert c == 200 and not (isinstance(v, dict) and v.get("ok") is False), (c, json.dumps(v)[:2000])
c, s = S.call("POST", "/runs", req, timeout=120, port=port)
assert c == 201, (c, json.dumps(s)[:2000])
rid = s["run_id"]
c1, _ = S.call("POST", f"/runs/{rid}/open", port=port, timeout=120)
c2, st2 = S.call("POST", f"/runs/{rid}/commands", {"command": "play"}, port=port)
with S.Registry() as r:
    r["runs"][tag] = {"run_id": rid, "world_id": s.get("world_id"), "name": sc["name"], "scenario": path, "status": "running",
                      "port": port, "agents": len(sc["agents"]), "max_rounds": sc["max_rounds"],
                      "launched": time.strftime("%Y-%m-%d %H:%M:%S"), "notes": [f"launched on :{port} by launch_on.py (Sonnet key exists only there)"]}
print(f"launched {tag} -> {rid} on :{port} (open {c1}, play {c2})")
