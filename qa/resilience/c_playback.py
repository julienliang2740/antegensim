"""Criterion c: stored playback needs no model calls.  Browse many historical turns
(turn views, events, knowledge, decision packets, model call records) with the run closed
and then open-and-paused; confirm no model_calls file, event, pending call or ledger change
appears and the server log shows no adapter call ("model call provider=...") meanwhile."""
from __future__ import annotations

import json
import sys

from rlib import (LOG, OUT, Checks, client, create_run, defaults, ensure_server, file_inventory, index_entries, log_offset,
                  log_since, open_run, read_json, run_dir, status, step_round, tree_hashes)

ck = Checks("c_playback")
extra: dict = {}
ensure_server()
c = client()

a_out = OUT / "a_crash_resume.json"
run_id = None
if a_out.exists():
    run_id = json.loads(a_out.read_text()).get("run_id")
if not run_id:
    req = defaults(c, 8)
    req.update(name="res-c playback", play_delay_seconds=0.0)
    run_id = create_run(c, req)["run_id"]
    open_run(c, run_id)
    step_round(c, run_id)
    step_round(c, run_id)
    c.post(f"/runs/{run_id}/close")
rd = run_dir(run_id)
extra["run_id"] = run_id

# prove that the log line we grep for exists when adapters are called
all_log = LOG.read_text(errors="replace")
n_adapter_lines_total = all_log.count("model call provider=")
ck.check("server log records adapter calls as 'model call provider=' (so absence is meaningful)",
         n_adapter_lines_total > 0, {"lines_in_log_so_far": n_adapter_lines_total})

inv0 = file_inventory(rd)
hashes0 = tree_hashes(rd / "turns")
man0 = read_json(rd / "manifest.json")
off = log_offset()
n_mc0 = sum(1 for k in inv0 if "/model_calls/mc_" in k)

idx = index_entries(rd)
picked = [idx[0]["turn_id"], idx[1]["turn_id"], idx[len(idx) // 3]["turn_id"], idx[len(idx) // 2]["turn_id"], idx[-1]["turn_id"]]
picked += [e["turn_id"] for e in idx if e["kind"] == "round_end"][:2]
# the turn with an interrupted call, if any
for e in idx:
    mci = rd / "turns" / e["turn_id"] / "model_calls" / "index.json"
    if mci.exists() and any("interrupted" in (m.get("error") or "") for m in json.loads(mci.read_text())):
        picked.append(e["turn_id"])
        break
picked = list(dict.fromkeys(picked))
extra["turns_viewed"] = picked


def browse(tag: str) -> dict:
    counts = {"turn_views": 0, "turn_events": 0, "knowledge": 0, "packets": 0, "model_calls": 0, "errors": []}
    r = c.get(f"/runs/{run_id}/turns")
    if r.status_code != 200:
        counts["errors"].append(("turns", r.status_code))
    for tid in picked:
        tv = c.get(f"/runs/{run_id}/turns/{tid}")
        if tv.status_code != 200:
            counts["errors"].append((tid, tv.status_code))
            continue
        tv = tv.json()
        counts["turn_views"] += 1
        if tv["live"]:
            counts["errors"].append((tid, "live=true on a history view"))
        if c.get(f"/runs/{run_id}/turns/{tid}/events").status_code == 200:
            counts["turn_events"] += 1
        for aid in list(tv["entities"]["agents"])[:3]:
            k = c.get(f"/runs/{run_id}/turns/{tid}/agents/{aid}/knowledge")
            counts["knowledge"] += k.status_code == 200
        for pk in tv["decision_packet_ids"]:
            p = c.get(f"/runs/{run_id}/turns/{tid}/decision_packets/{pk}")
            counts["packets"] += p.status_code == 200
        for mc in tv["model_calls"]:
            m = c.get(f"/runs/{run_id}/turns/{tid}/model_calls/{mc['call_id']}")
            counts["model_calls"] += m.status_code == 200
    return counts


closed_counts = browse("closed")
extra["browse_closed"] = closed_counts
ck.check("history browsing works with the run closed", not closed_counts["errors"] and closed_counts["turn_views"] == len(picked)
         and closed_counts["packets"] > 0 and closed_counts["model_calls"] > 0, closed_counts)

st = open_run(c, run_id)
latest0 = st["latest_seq"]
open_counts = browse("open")
live = c.get(f"/runs/{run_id}/turns/live")
state = c.get(f"/runs/{run_id}/state")
lk = c.get(f"/runs/{run_id}/agents/a01/knowledge")
extra["browse_open"] = open_counts
ck.check("history + live views work with the run open and paused",
         not open_counts["errors"] and live.status_code == 200 and state.status_code == 200 and lk.status_code == 200
         and live.json()["live"] is True, {"browse": open_counts, "live": live.status_code, "state": state.status_code})
st1 = status(c, run_id)
c.post(f"/runs/{run_id}/close")

inv1 = file_inventory(rd)
hashes1 = tree_hashes(rd / "turns")
man1 = read_json(rd / "manifest.json")
n_mc1 = sum(1 for k in inv1 if "/model_calls/mc_" in k)
new_files = sorted(set(inv1) - set(inv0))
changed_turn_files = sorted(k for k in hashes0 if hashes1.get(k) != hashes0[k])
log_new = log_since(off)
adapter_lines = [line for line in log_new.splitlines() if "model call provider=" in line]
ck.check("no new model_calls files", n_mc1 == n_mc0 and not [f for f in new_files if "model_calls" in f],
         {"before": n_mc0, "after": n_mc1, "new_files": new_files})
ck.check("committed turn files unchanged (events, packets, calls)", not changed_turn_files and hashes1.keys() == hashes0.keys(),
         changed_turn_files[:10])
ck.check("no new events and ledger unchanged", man1["next_event_seq"] == man0["next_event_seq"]
         and man1["real_usage"] == man0["real_usage"] and st1["latest_seq"] == latest0 and man1["current_turn_id"] == man0["current_turn_id"],
         {"next_event_seq": [man0["next_event_seq"], man1["next_event_seq"]], "latest_seq": [latest0, st1["latest_seq"]],
          "real_usage": man1["real_usage"]})
ck.check("server log shows no adapter call during playback", not adapter_lines,
         {"adapter_lines": adapter_lines[:5], "log_bytes_during_playback": len(log_new),
          "GET lines": sum(1 for line in log_new.splitlines() if '"GET /api/runs/' in line)})
pend = list((rd / "working" / "pending_model_calls").iterdir())
ck.check("no pending model call file created", pend == [], [p.name for p in pend])
p = ck.dump(extra)
print("evidence:", p, "ALL OK" if ck.all_ok else "SOME FAILED")
sys.exit(0 if ck.all_ok else 1)
