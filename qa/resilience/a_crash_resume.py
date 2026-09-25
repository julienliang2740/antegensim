"""Criterion a: an 8-agent run pauses, is killed -9 while a turn waits on a model call,
restarts, resumes at the last complete checkpoint and continues without repeating a
committed turn id or event seq and without double counting the usage ledger.

Also runs an uninterrupted reference run (same request, tiny sleep) and compares the
per-turn actions and the final agents, and an extra double-crash on one turn (_01 and
_02 both interrupted, _03 commits).
"""
from __future__ import annotations

import json
import re
import sys
import time

from rlib import (Checks, call_records, chain_from_manifest, client, command, committed_events, create_run,
                  current_pid, defaults, ensure_server, index_entries, kill9, open_run, read_json, run_dir, start_server,
                  status, step_round, wait_for, wait_idle)

SLEEP_MS = 3000
ck = Checks("a_crash_resume")
extra: dict = {}

pid = ensure_server()
c = client()


def make_req(name: str, sleep_ms: int) -> dict:
    req = defaults(c, 8)
    req.update(name=name, seed=1, default_model_key="fake-heuristic", play_delay_seconds=0.0)
    for card in req["agents"]:
        card["fake_options"] = {"sleep_ms": sleep_ms}
    return req


# ---------------- reference run (no crash) ----------------
ref = create_run(c, make_req("res-a reference (no crash)", 1))
ref_id = ref["run_id"]
open_run(c, ref_id)
for _ in range(4):
    step_round(c, ref_id)
ref_st = status(c, ref_id)
c.post(f"/runs/{ref_id}/close")
ref_dir = run_dir(ref_id)
extra["reference_run"] = {"run_id": ref_id, "dir": str(ref_dir), "current_turn_id": ref_st["current_turn_id"]}

# ---------------- crash run ----------------
summary = create_run(c, make_req("res-a crash (kill -9 during waiting_model)", SLEEP_MS))
run_id = summary["run_id"]
rd = run_dir(run_id)
extra["run_id"] = run_id
extra["run_dir"] = str(rd)
st = open_run(c, run_id)
ck.check("new run opens paused", st["state"] == "paused" and st["current_turn_id"] == "r00000_init",
         {k: st[k] for k in ("state", "current_turn_id", "next_step")})

# play for about two rounds
r = command(c, run_id, "play")
ck.check("play accepted", r.status_code == 200, r.json().get("state"))
wait_for(lambda: re.match(r"r0000[2-9]_t0[4-8]", status(c, run_id)["current_turn_id"]), timeout=180, what="round 2 turn 4")
pr = command(c, run_id, "pause")
states_seen = [pr.json()["state"]]
t0 = time.time()
while time.time() - t0 < 30:
    s = status(c, run_id)["state"]
    if s != states_seen[-1]:
        states_seen.append(s)
    if s == "paused":
        break
    time.sleep(0.02)
ck.check("pause after ~2 rounds yields pause_requested then paused",
         states_seen[0] == "pause_requested" and states_seen[-1] == "paused", states_seen)
st = wait_idle(c, run_id)
paused_turn = st["current_turn_id"]
extra["paused_at"] = paused_turn

man_before = read_json(rd / "manifest.json")
idx_before = index_entries(rd)

# start the next turn and kill -9 while it waits on the (slow) fake model
command(c, run_id, "run_turn")


def waiting():
    s = status(c, run_id)
    if s["state"] != "waiting_model" or not s.get("pending_model_call"):
        return None
    cid = s["pending_model_call"]["call_id"]
    f = rd / "working" / "pending_model_calls" / f"{cid}.json"
    return (s, f) if f.exists() else None


st_wait, pending_file = wait_for(waiting, timeout=60, what="waiting_model with pending file")
active_turn = st_wait["active_turn_id"]
call_id = st_wait["pending_model_call"]["call_id"]
pending_rec = read_json(pending_file)
live_before = c.get(f"/runs/{run_id}/events", params={"since": 0, "limit": 5000}).json()
pv = c.get(f"/runs/{run_id}/pending_model_call")
kill_time = time.time()
ck.check("pending call file recorded on disk before the kill",
         pending_rec["status"] == "pending" and pending_rec["call_id"] == call_id and call_id.endswith("_01")
         and pending_file.stat().st_mtime < kill_time and pv.status_code == 200,
         {"file": str(pending_file.relative_to(rd)), "status": pending_rec["status"], "call_id": call_id,
          "turn_id": pending_rec["turn_id"], "has_request": bool(pending_rec.get("request")),
          "GET pending_model_call": pv.status_code})
extra["killed_during"] = {"state": st_wait["state"], "active_turn_id": active_turn, "call_id": call_id,
                          "feed_epoch": st_wait["feed_epoch"], "latest_seq": st_wait["latest_seq"]}

kill9(current_pid() or pid)
ck.check("server killed with SIGKILL while waiting_model", True, {"pid": current_pid(), "state_at_kill": st_wait["state"]})

man_after_kill = read_json(rd / "manifest.json")
partials = [p.name for p in (rd / "turns").iterdir() if p.name.startswith(".partial")]
turn_dirs_after_kill = sorted(p.name for p in (rd / "turns").iterdir() if p.is_dir())
ck.check("on disk after the kill: manifest still at the last complete checkpoint",
         man_after_kill["current_turn_id"] == paused_turn and active_turn not in turn_dirs_after_kill,
         {"manifest.current_turn_id": man_after_kill["current_turn_id"], "partial_dirs": partials,
          "active_turn_dir_exists": active_turn in turn_dirs_after_kill})
uncommitted = [(e["seq"], e["kind"]) for e in live_before["events"] if e["seq"] >= man_after_kill["next_event_seq"]]
extra["uncommitted_events_seen_before_kill"] = uncommitted

# restart and open
pid = start_server()
c = client()
summ = c.get(f"/runs/{run_id}").json()
ck.check("run listed as paused after restart (not open)", summ["status"] == "paused" and summ["current_turn_id"] == paused_turn,
         {k: summ[k] for k in ("status", "current_turn_id")})
st_open = open_run(c, run_id)
man_open = read_json(rd / "manifest.json")
ck.check("resumed session opens paused at the last complete checkpoint",
         st_open["state"] == "paused" and st_open["current_turn_id"] == paused_turn,
         {k: st_open[k] for k in ("state", "current_turn_id", "next_step", "next_agent_id", "feed_epoch", "latest_seq")})
ck.check("feed_epoch changed after restart", st_open["feed_epoch"] != st_wait["feed_epoch"],
         [st_wait["feed_epoch"], st_open["feed_epoch"]])
ck.check("ledger on disk untouched by recovery (usage enters only in the carrying commit)",
         man_open["real_usage"] == man_before["real_usage"],
         {"before_kill": man_before["real_usage"], "after_open": man_open["real_usage"],
          "status.real_usage (manifest + uncommitted)": st_open["real_usage"]})
# ledger rule (INTERFACES 4.5 / 8, runner.add_record_to_ledger == storage.add_call_usage): every
# record counts in calls; an interrupted one (recovered from a pending file) ALSO in
# interrupted_calls, which is therefore a subset of calls
ck.check("RunStatus.real_usage adds exactly the one interrupted call on top (calls +1, interrupted_calls +1)",
         st_open["real_usage"]["calls"] == man_before["real_usage"]["calls"] + 1
         and st_open["real_usage"]["interrupted_calls"] == man_before["real_usage"]["interrupted_calls"] + 1,
         {"manifest_before_kill": man_before["real_usage"], "status_after_open": st_open["real_usage"]})
ev_open = c.get(f"/runs/{run_id}/events", params={"since": man_open["next_event_seq"] - 1, "limit": 100}).json()["events"]
ck.check("recovered pending call surfaced as model_call_failed (infra, interrupted)",
         any(e["kind"] == "model_call_failed" and e["details"].get("call_id") == call_id and e["details"].get("interrupted")
             and e["details"].get("infra") for e in ev_open),
         [(e["seq"], e["kind"], e["summary"]) for e in ev_open])

# re-run the interrupted turn
command(c, run_id, "run_turn")
st = wait_idle(c, run_id)
t_dir = rd / "turns" / active_turn
rec = read_json(t_dir / "state.json")
mcs = read_json(t_dir / "model_calls" / "index.json")
ck.check("the interrupted turn re-runs under the same turn id and commits",
         st["current_turn_id"] == active_turn and rec["previous_turn_id"] == paused_turn, {"committed": st["current_turn_id"]})
ck.check("the re-run uses call id _02 and carries _01 as interrupted (charged 0)",
         rec["model_call_ids"] == [call_id, call_id[:-2] + "02"]
         and mcs[0]["status"] == "failed" and "interrupted" in (mcs[0].get("error") or "") and mcs[0]["charged_compute"] == 0
         and mcs[1]["status"] == "completed",
         {"model_call_ids": rec["model_call_ids"],
          "calls": [(m["call_id"], m["status"], m.get("error"), m["charged_compute"]) for m in mcs]})
pend_left = [p.name for p in (rd / "working" / "pending_model_calls").iterdir()]
ck.check("pending call files cleared by the carrying commit", pend_left == [], pend_left)
man_rerun = read_json(rd / "manifest.json")
ck.check("ledger after the carrying commit = before-kill + 2 records (calls +2, of which interrupted_calls +1)",
         man_rerun["real_usage"]["calls"] == man_before["real_usage"]["calls"] + 2
         and man_rerun["real_usage"]["interrupted_calls"] == man_before["real_usage"]["interrupted_calls"] + 1,
         {"before": man_before["real_usage"], "after": man_rerun["real_usage"]})

# continue to the end of round 4
while status(c, run_id)["current_turn_id"] != "r00004_end":
    st = step_round(c, run_id)
    if st["state"] != "paused":
        break
st = status(c, run_id)
ck.check("continued to r00004_end without error", st["current_turn_id"] == "r00004_end" and st["state"] == "paused",
         {k: st[k] for k in ("state", "current_turn_id", "last_error")})


def verify_chain(rd, label):
    idx = index_entries(rd)
    ids = [e["turn_id"] for e in idx]
    chain = chain_from_manifest(rd)
    dup_ids = sorted({t for t in ids if ids.count(t) > 1})
    ok_idx = ids == chain
    # schedule shape: init, then per round t01..tNN contiguous, then end
    shape_problems = []
    prev_round, prev_ti = 0, 0
    for e in idx[1:]:
        if e["kind"] == "round_end":
            if e["round"] != prev_round:
                shape_problems.append(("end_round_mismatch", e["turn_id"]))
            prev_ti = 0
        else:
            if e["round"] != prev_round:
                if e["round"] != prev_round + 1 or e["turn_index"] != 1:
                    shape_problems.append(("round_start", e["turn_id"]))
                prev_round = e["round"]
            elif e["turn_index"] != prev_ti + 1:
                shape_problems.append(("turn_index_gap", e["turn_id"]))
            prev_ti = e["turn_index"]
    evs = committed_events(rd, chain)
    seqs = [e["seq"] for e in evs]
    dup_seqs = sorted({s for s in seqs if seqs.count(s) > 1})
    increasing = all(b > a for a, b in zip(seqs, seqs[1:]))
    gaps = [(a, b) for a, b in zip(seqs, seqs[1:]) if b != a + 1]
    per_turn_ok = True
    for tid in chain:
        tr = read_json(rd / "turns" / tid / "state.json")
        tev = read_json(rd / "turns" / tid / "events.json")
        if tev and (tr["event_seq_start"] != tev[0]["seq"] or tr["event_seq_end"] != tev[-1]["seq"]):
            per_turn_ok = False
        if any(e["turn_id"] != tid for e in tev):
            per_turn_ok = False
    man = read_json(rd / "manifest.json")
    recs = call_records(rd, chain)
    led = man["real_usage"]
    sum_int = sum(1 for r in recs if "interrupted" in (r.get("error") or ""))
    sum_calls = len(recs)  # ledger rule: every committed record counts in calls (interrupted ones too)
    sum_in = sum((r.get("result") or {}).get("usage", {}).get("billed_input_tokens", 0) for r in recs)
    sum_out = sum((r.get("result") or {}).get("usage", {}).get("output_tokens", 0) for r in recs)
    call_ids = [r["call_id"] for r in recs]
    return {
        "label": label, "turns": len(ids), "first": ids[0], "last": ids[-1],
        "index_equals_manifest_chain": ok_idx, "duplicate_turn_ids": dup_ids, "schedule_shape_problems": shape_problems,
        "events": len(seqs), "duplicate_seqs": dup_seqs, "seqs_strictly_increasing": increasing, "seq_gaps": gaps,
        "turn_seq_ranges_consistent": per_turn_ok, "next_event_seq": man["next_event_seq"], "max_seq": max(seqs),
        "ledger": led, "sum_call_records": {"calls": sum_calls, "interrupted_calls": sum_int, "input_tokens": sum_in,
                                           "output_tokens": sum_out},
        "duplicate_call_ids": sorted({x for x in call_ids if call_ids.count(x) > 1}),
    }


v = verify_chain(rd, "after round 4")
extra["chain_after_round4"] = v
ck.check("turn index chain: no duplicates, no gaps, index == manifest chain",
         v["index_equals_manifest_chain"] and not v["duplicate_turn_ids"] and not v["schedule_shape_problems"],
         {k: v[k] for k in ("turns", "first", "last", "duplicate_turn_ids", "schedule_shape_problems")})
ck.check("committed event seqs unique and strictly increasing; next_event_seq = max + 1",
         not v["duplicate_seqs"] and v["seqs_strictly_increasing"] and v["turn_seq_ranges_consistent"]
         and v["next_event_seq"] == v["max_seq"] + 1,
         {k: v[k] for k in ("events", "duplicate_seqs", "seq_gaps", "next_event_seq", "max_seq")})
ck.check("manifest ledger == sum over committed call records (no double count)",
         v["ledger"]["calls"] == v["sum_call_records"]["calls"]
         and v["ledger"]["interrupted_calls"] == v["sum_call_records"]["interrupted_calls"]
         and v["ledger"]["input_tokens"] == v["sum_call_records"]["input_tokens"]
         and v["ledger"]["output_tokens"] == v["sum_call_records"]["output_tokens"] and not v["duplicate_call_ids"],
         {"ledger": v["ledger"], "records": v["sum_call_records"]})

# compare with the uninterrupted reference
ref_chain = chain_from_manifest(ref_dir)
chain = chain_from_manifest(rd)


def actions(d, ch):
    out = []
    for tid in ch:
        tr = read_json(d / "turns" / tid / "state.json")
        ar = tr.get("action_result") or {}
        out.append((tid, tr["decision_source"], json.dumps(tr.get("action"), sort_keys=True), ar.get("ok"), ar.get("reason"),
                    ar.get("cost_compute")))
    return out


a_crash, a_ref = actions(rd, chain), actions(ref_dir, ref_chain)
diff = [(x, y) for x, y in zip(a_crash, a_ref) if x != y]
ck.check("same turn chain and same per-turn actions/results as the uninterrupted reference run",
         [x[0] for x in a_crash] == [x[0] for x in a_ref] and not diff, {"turns": len(a_crash), "diffs": diff[:5]})
agents_crash = {p.name: read_json(p) for p in (rd / "turns" / "r00004_end" / "entities" / "agents").glob("*.json")}
agents_ref = {p.name: read_json(p) for p in (ref_dir / "turns" / "r00004_end" / "entities" / "agents").glob("*.json")}
agent_diff = {}
for k in agents_ref:
    a, b = agents_crash.get(k), agents_ref[k]
    if a != b:
        agent_diff[k] = {f: (a.get(f), b.get(f)) for f in b if a.get(f) != b.get(f)}
# model_call_count differs by design? check
ck.check("agents at r00004_end identical to the reference (no lost or repeated effect)", not agent_diff,
         agent_diff if agent_diff else "all 8 agent files equal")
ev_crash = [(e["turn_id"], e["kind"], e["summary"]) for e in committed_events(rd, chain)]
ev_ref = [(e["turn_id"], e["kind"], e["summary"]) for e in committed_events(ref_dir, ref_chain)]
only_crash = [x for x in ev_crash if x not in ev_ref]
only_ref = [x for x in ev_ref if x not in ev_crash]
extra["event_summary_diff_vs_reference"] = {"only_in_crash_run": only_crash, "only_in_reference": only_ref}
ck.check("event summaries differ from the reference only by the recovery records of the interrupted turn",
         all(t == active_turn or k == "run_created" for t, k, _ in only_crash)
         and all(t == active_turn or k == "run_created" for t, k, _ in only_ref),
         {"only_in_crash_run": only_crash, "only_in_reference": only_ref})

# ---------------- extra: double crash on one turn ----------------
man_b = read_json(rd / "manifest.json")
command(c, run_id, "run_turn")
st_w, pf = wait_for(waiting, timeout=60, what="waiting_model (double crash 1)")
turn2 = st_w["active_turn_id"]
cid1 = st_w["pending_model_call"]["call_id"]
kill9(current_pid())
pid = start_server()
c = client()
open_run(c, run_id)
command(c, run_id, "run_turn")
st_w2, pf2 = wait_for(waiting, timeout=60, what="waiting_model (double crash 2)")
cid2 = st_w2["pending_model_call"]["call_id"]
pend_files_2 = sorted(p.name for p in (rd / "working" / "pending_model_calls").iterdir())
kill9(current_pid())
pid = start_server()
c = client()
st_o = open_run(c, run_id)
command(c, run_id, "run_turn")
st = wait_idle(c, run_id)
rec2 = read_json(rd / "turns" / turn2 / "state.json")
man_c = read_json(rd / "manifest.json")
ck.check("double crash on one turn: _01 and _02 interrupted, _03 commits under the same turn id",
         st["current_turn_id"] == turn2 and rec2["model_call_ids"] == [cid1, cid1[:-2] + "02", cid1[:-2] + "03"]
         and cid2.endswith("_02"),
         {"turn": turn2, "model_call_ids": rec2["model_call_ids"], "pending_files_before_2nd_kill": pend_files_2})
ck.check("double crash: after the 2nd open RunStatus.real_usage = manifest + the 2 interrupted records (calls +2, interrupted_calls +2)",
         st_o["real_usage"]["calls"] == man_b["real_usage"]["calls"] + 2
         and st_o["real_usage"]["interrupted_calls"] == man_b["real_usage"]["interrupted_calls"] + 2,
         {"manifest_before": man_b["real_usage"], "status_after_2nd_open": st_o["real_usage"]})
ck.check("double crash: ledger grows by exactly 3 records (calls +3, of which interrupted_calls +2)",
         man_c["real_usage"]["calls"] == man_b["real_usage"]["calls"] + 3
         and man_c["real_usage"]["interrupted_calls"] == man_b["real_usage"]["interrupted_calls"] + 2,
         {"before": man_b["real_usage"], "after": man_c["real_usage"], "status_after_2nd_open": st_o["real_usage"]})
v2 = verify_chain(rd, "after double crash")
extra["chain_after_double_crash"] = v2
ck.check("after the double crash the chain/seq/ledger invariants still hold",
         v2["index_equals_manifest_chain"] and not v2["duplicate_turn_ids"] and not v2["duplicate_seqs"]
         and v2["seqs_strictly_increasing"] and v2["ledger"]["calls"] == v2["sum_call_records"]["calls"]
         and v2["ledger"]["interrupted_calls"] == v2["sum_call_records"]["interrupted_calls"]
         and v2["ledger"]["input_tokens"] == v2["sum_call_records"]["input_tokens"]
         and v2["ledger"]["output_tokens"] == v2["sum_call_records"]["output_tokens"] and not v2["duplicate_call_ids"],
         {k: v2[k] for k in ("turns", "last", "duplicate_seqs", "seq_gaps", "ledger", "sum_call_records")})

c.post(f"/runs/{run_id}/close")
p = ck.dump(extra)
print("evidence:", p, "ALL OK" if ck.all_ok else "SOME FAILED")
sys.exit(0 if ck.all_ok else 1)
