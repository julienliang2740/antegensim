"""Criterion f: context limits and memory-selection settings changed at run creation land in
r00000_init/settings.json; changed in god mode (run scope and one agent scope) they apply
at the next boundary, are logged with the effective turn id and before/after, and appear
in the next turn's settings.json and in the affected agents' next decision packets."""
from __future__ import annotations

import sys

from rlib import (Checks, chain_from_manifest, client, command, create_run, defaults, ensure_server, open_run, read_json,
                  run_dir, stage, step_round, wait_idle)

ck = Checks("f_context_settings")
extra: dict = {}
ensure_server()
c = client()

req = defaults(c, 8)
req.update(name="res-f context settings", play_delay_seconds=0.0)
req["context"]["input_token_cap"] = 5000
req["context"]["recent_history_length"] = 3
req["context"]["weights"] = {"relevance": 2.0, "recency": 0.5, "importance": 1.0}
A = {a["id"]: a for a in req["agents"]}
A["a02"]["context_overrides"] = {"retrieved_memory_limit": 2, "include_skill_source": True}
summary = create_run(c, req)
run_id = summary["run_id"]
rd = run_dir(run_id)
extra["run_id"] = run_id
init_settings = read_json(rd / "turns" / "r00000_init" / "settings.json")
ck.check("creation-time run context lands in r00000_init/settings.json",
         init_settings["context"]["input_token_cap"] == 5000 and init_settings["context"]["recent_history_length"] == 3
         and init_settings["context"]["weights"] == {"relevance": 2.0, "recency": 0.5, "importance": 1.0},
         init_settings["context"])
ck.check("creation-time agent override lands in r00000_init/settings.json",
         {k: v for k, v in (init_settings["context_overrides"].get("a02") or {}).items() if v is not None}
         == {"retrieved_memory_limit": 2, "include_skill_source": True},
         init_settings["context_overrides"])
open_run(c, run_id)
eff = c.get(f"/runs/{run_id}/settings").json()
ck.check("GET settings shows effective per-agent context (a02 merged, a01 run default) and limits",
         eff["effective_context"]["a02"]["retrieved_memory_limit"] == 2 and eff["effective_context"]["a02"]["input_token_cap"] == 5000
         and eff["effective_context"]["a01"]["retrieved_memory_limit"] == 5 and eff.get("limits") is not None,
         {"a01": eff["effective_context"]["a01"], "a02": eff["effective_context"]["a02"], "limits": eff.get("limits")})
# creation-time packets use the settings
step_round(c, run_id)
chain = chain_from_manifest(rd)
t_a02 = next(t for t in chain if t.endswith("_a02"))
pk = read_json(next((rd / "turns" / t_a02 / "decision_packets").glob("*.json")))
ck.check("a02's round-1 packet used the creation-time effective settings",
         pk["effective_settings"]["retrieved_memory_limit"] == 2 and pk["effective_settings"]["input_token_cap"] == 5000
         and pk["effective_settings"]["recent_history_length"] == 3, pk["effective_settings"])

# invalid staged setting is rejected with a path
bad = stage(c, run_id, {"type": "update_context_settings", "scope": "run", "settings": {"input_token_cap": 10}})
ck.check("invalid context setting rejected at staging (422 with problem path)",
         bad.status_code == 422 and bad.json()["error"] == "invalid_intervention" and bad.json()["problems"],
         {"status": bad.status_code, "body": bad.json()})

# god mode: stage run scope + agent scope while paused
before_turn = chain[-1]
r1 = stage(c, run_id, {"type": "update_context_settings", "scope": "run", "note": "QA run scope",
                       "settings": {"recent_history_length": 7, "new_event_digest_limit": 4}})
r2 = stage(c, run_id, {"type": "update_context_settings", "scope": "a02", "note": "QA agent scope",
                       "settings": {"input_token_cap": 4500, "notebook_max_tokens": 200}})
ck.check("both staged (201)", r1.status_code == 201 and r2.status_code == 201,
         [x["id"] for x in r2.json()["staged"]])
cur_settings = read_json(rd / "turns" / before_turn / "settings.json")
ck.check("staging does not touch the committed checkpoint", cur_settings["context"]["recent_history_length"] == 3, before_turn)
command(c, run_id, "run_turn")
st = wait_idle(c, run_id)
T = st["current_turn_id"]
tr = read_json(rd / "turns" / T / "state.json")
evs = read_json(rd / "turns" / T / "events.json")
ivs = tr["interventions"]
iv_events = [e for e in evs if e["kind"] == "intervention"]
extra["effective_turn"] = T
extra["intervention_records"] = ivs
ck.check("both applied at the next boundary with effective_turn_id = that turn and ok",
         len(ivs) == 2 and all(i["effective_turn_id"] == T and i["ok"] for i in ivs)
         and len(iv_events) == 2 and all(e["details"]["effective_turn_id"] == T for e in iv_events),
         [(i["intervention"]["id"], i["effective_turn_id"], i["ok"]) for i in ivs])
chg = {c_["path"]: (c_["before"], c_["after"]) for i in ivs for c_ in i["changes"]}
ck.check("before/after recorded for the run-scope change",
         chg.get("settings.context.recent_history_length") == (3, 7) and chg.get("settings.context.new_event_digest_limit") == (10, 4),
         chg)
a02_change = {k: v for k, v in chg.items() if "a02" in k}
ck.check("before/after recorded for the agent-scope change (override replaced)", bool(a02_change), a02_change)
s_after = read_json(rd / "turns" / T / "settings.json")
ov = {k: v for k, v in (s_after["context_overrides"].get("a02") or {}).items() if v is not None}
ck.check("new values appear in the effective turn's settings.json",
         s_after["context"]["recent_history_length"] == 7 and s_after["context"]["new_event_digest_limit"] == 4
         and ov == {"input_token_cap": 4500, "notebook_max_tokens": 200},
         {"context": {k: s_after["context"][k] for k in ("recent_history_length", "new_event_digest_limit")}, "a02_override": ov})
prev_s = read_json(rd / "turns" / before_turn / "settings.json")
ck.check("the previous turn's settings.json keeps the old values (history shows both)",
         prev_s["context"]["recent_history_length"] == 3, prev_s["context"]["recent_history_length"])
# next packets
step_round(c, run_id)
step_round(c, run_id)
chain = chain_from_manifest(rd)
after = chain[chain.index(T):]
pk_T = list((rd / "turns" / T / "decision_packets").glob("*.json"))
pk_a02 = None
for t in after:
    if t.endswith("_a02"):
        f = list((rd / "turns" / t / "decision_packets").glob("*.json"))
        if f:
            pk_a02 = (t, read_json(f[0])["effective_settings"])
            break
es_T = read_json(pk_T[0])["effective_settings"] if pk_T else None
ck.check("the effective turn's packet uses recent_history_length 7 / digest 4",
         es_T is not None and es_T["recent_history_length"] == 7 and es_T["new_event_digest_limit"] == 4, es_T)
ck.check("a02's next packet uses its new override (4500 / 200) and the run-scope values",
         pk_a02 is not None and pk_a02[1]["input_token_cap"] == 4500 and pk_a02[1]["notebook_max_tokens"] == 200
         and pk_a02[1]["recent_history_length"] == 7 and pk_a02[1]["retrieved_memory_limit"] == 5, pk_a02)
eff2 = c.get(f"/runs/{run_id}/settings").json()
ck.check("GET settings reflects the change", eff2["effective_context"]["a02"]["input_token_cap"] == 4500
         and eff2["settings"]["context"]["recent_history_length"] == 7, eff2["effective_context"]["a02"])
c.post(f"/runs/{run_id}/close")
p = ck.dump(extra)
print("evidence:", p, "ALL OK" if ck.all_ok else "SOME FAILED")
sys.exit(0 if ck.all_ok else 1)
