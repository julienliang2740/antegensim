"""The remaining completion-criteria bullets at API level (the UI side is the browser QA's):
live logs arrive while a turn is in progress with readable summaries and a clear status;
every occupant of a point is inspectable across rounds and plant rules are visible;
each decision packet is bounded and built only from the agent's own records, with older
memories retrieved without refreshing observations."""
from __future__ import annotations

import json
import sys
import time

from rlib import (OUT, Checks, chain_from_manifest, client, command, create_run, defaults, ensure_server, open_run,
                  read_json, read_knowledge_file, run_dir, status, wait_idle)

ck = Checks("k_other_bullets")
extra: dict = {}
ensure_server()
c = client()

# ---- live logs -------------------------------------------------------------
req = defaults(c, 8)
req.update(name="res-k live feed", play_delay_seconds=0.0)
for a in req["agents"]:
    a["fake_options"] = {"sleep_ms": 400}
run_id = create_run(c, req)["run_id"]
rd = run_dir(run_id)
st = open_run(c, run_id)
cursor = max(0, st["latest_seq"])
command(c, run_id, "play")
polls, states, pending_seen_before_commit = [], set(), []
t0 = time.time()
while time.time() - t0 < 5:
    r = c.get(f"/runs/{run_id}/events", params={"since": cursor}).json()
    evs = r["events"]
    states.add(r["status"]["state"])
    if evs:
        polls.append([(e["seq"], e["kind"], e["actor"], e["summary"]) for e in evs])
        man = read_json(rd / "manifest.json")
        for e in evs:
            if e["kind"] == "model_call_pending" and e["seq"] >= man["next_event_seq"]:
                pending_seen_before_commit.append(e["seq"])
        cursor = evs[-1]["seq"]
    time.sleep(0.2)
command(c, run_id, "pause")
wait_idle(c, run_id)
all_ev = [e for p in polls for e in p]
extra["live_polls"] = len(polls)
extra["live_sample"] = [f"[{e[1]}] {e[2]}: {e[3]}" for e in all_ev[:12]]
ck.check("events stream in over many polls while playing (not only at commit)", len(polls) >= 5 and len(pending_seen_before_commit) >= 2,
         {"polls_with_events": len(polls), "uncommitted model_call_pending seen": pending_seen_before_commit[:5]})
ck.check("status reports the active state while the feed updates", {"waiting_model"} <= states or {"turn_active"} <= states,
         sorted(states))
no_actor = sorted({e[1] for e in all_ev if e[2] not in e[3] and e[2] not in ("world", "system", "operator")})
extra["kinds_whose_summary_omits_the_actor"] = no_actor
ck.check("each event is one non-empty readable line with an actor field (feed prints actor + summary)",
         all(e[3] and "\n" not in e[3] and e[2] for e in all_ev),
         {"sample": extra["live_sample"][:6], "kinds whose summary text omits the actor id": no_actor})
seqs = [e[0] for e in all_ev]
ck.check("feed seqs strictly increasing across polls", all(b > a for a, b in zip(seqs, seqs[1:])), seqs[:10])
c.post(f"/runs/{run_id}/close")

# ---- point inspection across rounds + plant rules (8-round run from j) -----
j = json.loads((OUT / "j_storage.json").read_text())
jid = j["run_id"]
jd = run_dir(jid)
chain = chain_from_manifest(jd)
rows = []
for rnd in (1, 4, 8):
    tid = f"r{rnd:05d}_end"
    tv = c.get(f"/runs/{jid}/turns/{tid}").json()
    occ = tv["map"]["occupants"]
    key, ids = max(occ.items(), key=lambda kv: len(kv[1]))
    ents = {}
    for kind in ("agents", "plants", "fruits", "seeds", "residues"):
        for eid, e in tv["entities"][kind].items():
            ents[eid] = e
    x, y = map(int, key.split(","))
    at_point = sorted(eid for eid, e in ents.items() if (e["position"]["x"], e["position"]["y"]) == (x, y))
    rows.append({"turn": tid, "point": key, "occupants": sorted(ids), "entities_at_point": at_point,
                 "all_inspectable": all(i in ents for i in ids)})
extra["crowded_points"] = rows
ck.check("the most crowded point at rounds 1/4/8 lists every co-located entity and each is inspectable",
         all(r["occupants"] == r["entities_at_point"] and r["all_inspectable"] and len(r["occupants"]) >= 2 for r in rows), rows)
rules = c.get(f"/runs/{jid}/turns/r00008_end").json()["rules"]
ck.check("plant rules are served with every turn view", "fruit_tree" in rules["plant_species"]
         and rules["plant_species"]["fruit_tree"]["stages"], list(rules["plant_species"]))

# ---- bounded, permitted context; older memories retrieved -------------------
viol, n_packets, retrieved_old, refresh_problems = [], 0, 0, []
for tid in chain:
    for f in (jd / "turns" / tid / "decision_packets").glob("*.json"):
        pk = read_json(f)
        n_packets += 1
        aid = pk["agent_id"]
        cap = pk["effective_settings"]["input_token_cap"]
        foreign = [r for r in pk["selected_record_ids"] if not r.startswith(f"{aid}-k")]
        if pk["input_token_estimate"] > cap or foreign:
            viol.append((tid, pk["input_token_estimate"], cap, foreign[:3]))
        kn = {r["id"]: r for r in read_knowledge_file(jd, pk["turn_id"], aid)["records"]}
        sec = next((s for s in pk["sections"] if s["name"] == "retrieved_memories"), None)
        if sec and any(kn.get(r, {}).get("round", pk["round"]) < pk["round"] - 1 for r in sec["record_ids"]):
            retrieved_old += 1
        sit = pk["situation"]
        if sit.get("observed_round") is not None:
            obs = [r for r in kn.values() if r["kind"] == "observation" and r["round"] <= pk["round"]]
            if sit["observed_round"] > pk["round"] or not any(r["round"] == sit["observed_round"] for r in obs):
                refresh_problems.append((tid, sit["observed_round"]))
ck.check("every packet stays within its input_token_cap and holds only the agent's own records", not viol and n_packets > 30,
         {"packets": n_packets, "violations": viol[:5]})
ck.check("older memories (>1 round old) are retrieved into later packets", retrieved_old > 0, {"packets_with_old_retrieved": retrieved_old})
ck.check("situation.observed_round is the round of a real earlier observation (no free refresh)", not refresh_problems,
         refresh_problems[:5])
p = ck.dump(extra)
print("evidence:", p, "ALL OK" if ck.all_ok else "SOME FAILED")
sys.exit(0 if ck.all_ok else 1)
