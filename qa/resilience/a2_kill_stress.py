"""Extra for criterion a: repeated kill -9 at random moments of continuous play (any state:
turn_active, waiting_model, committing), restart, open, and check the storage invariants
after every restart; finally compare every committed turn with an uninterrupted
reference run of the same request (deterministic fakes)."""
from __future__ import annotations

import json
import random
import sys
import time

from rlib import (Checks, call_records, chain_from_manifest, client, command, committed_events, create_run, current_pid,
                  defaults, ensure_server, index_entries, kill9, open_run, read_json, run_dir, start_server, status,
                  step_round, wait_idle)

N = int(sys.argv[1]) if len(sys.argv) > 1 else 12
ck = Checks("a2_kill_stress")
extra: dict = {"cycles": []}
ensure_server()
c = client()
rng = random.Random(7)


def req_for(name, sleep_ms):
    req = defaults(c, 8)
    req.update(name=name, seed=1, play_delay_seconds=0.0)
    for a in req["agents"]:
        a["fake_options"] = {"sleep_ms": sleep_ms}
    return req


run_id = create_run(c, req_for("res-a2 kill stress", 150))["run_id"]
rd = run_dir(run_id)
extra["run_id"] = run_id


def invariants():
    idx = [e["turn_id"] for e in index_entries(rd)]
    chain = chain_from_manifest(rd)
    evs = committed_events(rd, chain)
    seqs = [e["seq"] for e in evs]
    man = read_json(rd / "manifest.json")
    recs = call_records(rd, chain)
    n_int = sum(1 for r in recs if "interrupted" in (r.get("error") or ""))
    leftovers = sorted(p.name for p in (rd / "turns").iterdir() if p.is_dir() and p.name not in chain)
    return {
        "current": man["current_turn_id"], "turns": len(chain),
        "index_eq_chain": idx == chain, "dup_turns": len(idx) != len(set(idx)),
        # a kill between the manifest write (commit point) and the index append leaves the index one
        # entry behind; recover_run rebuilds it on open (INTERFACES 4.5), so allow exactly that lag
        "index_lags_by_one": idx == chain[:-1], "index_len": len(idx),
        "seq_ok": all(b > a for a, b in zip(seqs, seqs[1:])) and len(seqs) == len(set(seqs)),
        "next_seq_ok": man["next_event_seq"] == (max(seqs) + 1 if seqs else 1),
        # ledger rule (INTERFACES 4.5 / 8): every committed record counts in calls, an interrupted
        # one ALSO in interrupted_calls; the persisted ledger is the sum over the committed records
        "ledger_ok": man["real_usage"]["calls"] == len(recs)
        and man["real_usage"]["interrupted_calls"] == n_int
        and man["real_usage"]["input_tokens"] == sum(((r.get("result") or {}).get("usage") or {}).get("billed_input_tokens", 0) for r in recs)
        and man["real_usage"]["output_tokens"] == sum(((r.get("result") or {}).get("usage") or {}).get("output_tokens", 0) for r in recs),
        "ledger": man["real_usage"], "records": len(recs),
        "dup_call_ids": len({r["call_id"] for r in recs}) != len(recs),
        "unreachable_dirs": leftovers,
        "interrupted_calls": n_int,
    }


pid = current_pid()
for i in range(N):
    st = open_run(c, run_id)
    opened_ok = st["state"] == "paused" and st["current_turn_id"] == read_json(rd / "manifest.json")["current_turn_id"]
    inv_open = invariants()
    command(c, run_id, "play")
    time.sleep(rng.uniform(0.2, 2.5))
    try:
        s_kill = status(c, run_id)["state"]
    except Exception as exc:  # noqa: BLE001
        s_kill = f"? {exc}"
    pend = sorted(p.name for p in (rd / "working" / "pending_model_calls").iterdir())
    kill9(current_pid())
    pid = start_server()
    c = client()
    inv = invariants()
    cyc = {"cycle": i, "state_at_kill": s_kill, "pending_files_at_kill": pend, "opened_paused_at_manifest_turn": opened_ok,
           "after_kill": inv}
    extra["cycles"].append(cyc)
    good = opened_ok and inv_open["index_eq_chain"] and (inv["index_eq_chain"] or inv["index_lags_by_one"]) \
        and not inv["dup_turns"] and inv["seq_ok"] \
        and inv["next_seq_ok"] and inv["ledger_ok"] and not inv["dup_call_ids"]
    ck.check(f"cycle {i}: kill during {s_kill} at {inv['current']}", good,
             {k: inv[k] for k in ("current", "turns", "index_len", "index_eq_chain", "index_lags_by_one", "seq_ok", "ledger_ok",
                                  "records", "interrupted_calls", "unreachable_dirs")} | {"index_ok_after_next_open": inv_open["index_eq_chain"]})

# finish: reopen, finish the round, check everything and compare with a reference
open_run(c, run_id)
after_open = invariants()
ck.check("after the last restart+open no unreachable/partial turn dirs remain", not after_open["unreachable_dirs"],
         after_open["unreachable_dirs"])
st = step_round(c, run_id)
c.post(f"/runs/{run_id}/close")
final = invariants()
ck.check("final chain/seq/ledger invariants", final["index_eq_chain"] and not final["dup_turns"] and final["seq_ok"]
         and final["ledger_ok"] and not final["dup_call_ids"], final)
last = final["current"]

ref_id = create_run(c, req_for("res-a2 reference", 1))["run_id"]
ref = run_dir(ref_id)
open_run(c, ref_id)
while status(c, ref_id)["current_turn_id"] != last:
    command(c, ref_id, "run_turn")
    wait_idle(c, ref_id)
c.post(f"/runs/{ref_id}/close")
extra["reference_run_id"] = ref_id


def acts(d):
    out = []
    for t in chain_from_manifest(d):
        tr = read_json(d / "turns" / t / "state.json")
        ar = tr.get("action_result") or {}
        out.append((t, tr["decision_source"], json.dumps(tr.get("action"), sort_keys=True), ar.get("ok"), ar.get("reason")))
    return out


A, B = acts(rd), acts(ref)
diffs = [(x, y) for x, y in zip(A, B) if x != y]
ag_a = {p.name: read_json(p) for p in (rd / "turns" / last / "entities" / "agents").glob("*.json")}
ag_b = {p.name: read_json(p) for p in (ref / "turns" / last / "entities" / "agents").glob("*.json")}
ck.check(f"{len(A)} committed turns identical to the uninterrupted reference (turn ids, actions, results, final agents)",
         [a[0] for a in A] == [b[0] for b in B] and not diffs and ag_a == ag_b,
         {"turns": len(A), "diffs": diffs[:3], "agents_equal": ag_a == ag_b})
p = ck.dump(extra)
print("evidence:", p, "ALL OK" if ck.all_ok else "SOME FAILED")
sys.exit(0 if ck.all_ok else 1)
