"""Branch a run at a committed turn (product continuation), strip the tip from every persona through
literal god mode (edit working/ agent files, POST working/reload), register the branch in the sweep
registry and play it. Uses only public API routes and run files; no engine code is changed.

Usage: branch_words_removed.py <SOURCE_TAG> <from_turn_id> <NEW_TAG> "<title>" <port>
"""
import glob, json, sys, time
sys.path.insert(0, "/home/ubuntu/antegensim/sweep/tools")
import sweep as S

PLAIN = ("You are one of several agents living in this world. Nobody has given you a role, a team or a strategy; "
         "how you live is your own choice. Your one standing aim is to stay alive for as long as you can.")

src_tag, from_turn, tag, title, port = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
src = S.read_registry()["runs"][src_tag]
assert tag not in S.read_registry()["runs"], f"{tag} exists"
name = f"SWEEP-{tag} {title}"
c, summ = S.call("POST", f"/runs/{src['run_id']}/continuations", {"from_turn_id": from_turn, "name": name}, port=port, timeout=180)
assert c == 201, (c, str(summ)[:1500])
rid = summ["run_id"]
print("continuation", rid)
c, st = S.call("POST", f"/runs/{rid}/open", port=port, timeout=180)
print("open", c, st.get("state") if isinstance(st, dict) else st)
rd = glob.glob(f"/home/ubuntu/antegensim/worlds/*/runs/{rid}")[0]
n = 0
for f in sorted(glob.glob(f"{rd}/working/entities/agents/*.json")):
    d = json.load(open(f))
    if d.get("persona") != PLAIN:
        d["persona"] = PLAIN
        json.dump(d, open(f, "w"), indent=1)
        n += 1
print("personas rewritten", n)
c, rr = S.call("POST", f"/runs/{rid}/working/reload", port=port, timeout=120)
print("reload", c, json.dumps(rr)[:600] if not isinstance(rr, str) else rr[:600])
assert c == 200 and isinstance(rr, dict) and rr.get("ok"), "reload failed"
with S.Registry() as r:
    r["runs"][tag] = {"run_id": rid, "world_id": summ.get("world_id"), "name": name, "scenario": f"continuation of {src_tag} at {from_turn}",
                      "status": "running", "port": port, "agents": src["agents"], "max_rounds": src["max_rounds"],
                      "launched": time.strftime("%Y-%m-%d %H:%M:%S"),
                      "notes": [f"continuation of {src_tag} ({src['run_id']}) at {from_turn}; tip removed from all {n} personas via working/ reload"]}
c, st = S.call("POST", f"/runs/{rid}/commands", {"command": "play"}, port=port)
print("play", c, st.get("state") if isinstance(st, dict) else st)
