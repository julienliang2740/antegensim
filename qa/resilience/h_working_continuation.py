"""Criterion h: working/ file edits + reload produce a recorded intervention applied before
the next turn; a continuation from a historical turn starts from the copied checkpoint
and preserves the parent's original future (later turn dirs untouched)."""
from __future__ import annotations

import json
import sys

from rlib import (Checks, chain_from_manifest, client, command, create_run, defaults, ensure_server, index_entries,
                  knowledge_file, open_run, read_json, run_dir, status, step_round, tree_hashes, wait_idle)

ck = Checks("h_working_continuation")
extra: dict = {}
ensure_server()
c = client()
req = defaults(c, 8)
req.update(name="res-h working edit + continuation", play_delay_seconds=0.0)
summary = create_run(c, req)
run_id = summary["run_id"]
rd = run_dir(run_id)
extra["run_id"] = run_id
open_run(c, run_id)
step_round(c, run_id)
step_round(c, run_id)
base_turn = status(c, run_id)["current_turn_id"]
W = rd / "working"
ck.check("working/ mirrors the committed turn (BASE_TURN) and has a README", (W / "BASE_TURN").read_text().strip() == base_turn
         and (W / "README.txt").exists(), {"BASE_TURN": (W / "BASE_TURN").read_text().strip(), "committed": base_turn})

# invalid edits first: reported, nothing staged
a02p = W / "entities" / "agents" / "a02.json"
a03p = W / "entities" / "agents" / "a03.json"
plants_path = W / "entities" / "plants.json"
orig = {q: q.read_text() for q in (a02p, a03p, plants_path)}
bad = json.loads(orig[a02p])
bad["stats"]["health"] = 500  # > max_health
invalid_cases = {}
# 1) one semantic error only
a02p.write_text(json.dumps(bad, indent=2))
rr = c.post(f"/runs/{run_id}/working/reload").json()
invalid_cases["a02 health 500"] = rr["errors"]
ok1 = rr["ok"] is False and any("a02" in e for e in rr["errors"])
# 2) two broken JSON files
a02p.write_text(orig[a02p])
a03p.write_text(orig[a03p].replace("{", "{{", 1))
plants_path.write_text(orig[plants_path].replace("{", "{{", 1))
rr = c.post(f"/runs/{run_id}/working/reload").json()
invalid_cases["a03.json + plants.json broken JSON"] = rr["errors"]
ok2 = rr["ok"] is False and any("a03.json" in e for e in rr["errors"]) and any("plants.json" in e for e in rr["errors"])
# 3) one broken JSON file + one semantic error in another file
a03p.write_text(orig[a03p])
a02p.write_text(json.dumps(bad, indent=2))
rr = c.post(f"/runs/{run_id}/working/reload").json()
invalid_cases["plants.json broken + a02 health 500"] = rr["errors"]
ok3 = rr["ok"] is False and len(rr["errors"]) >= 1
extra["invalid_reload_cases"] = invalid_cases
staged = c.get(f"/runs/{run_id}/interventions").json()["staged"]
ck.check("invalid working files: reload ok=false with file-path problems, nothing staged, committed turn unchanged",
         ok1 and ok2 and ok3 and staged == [] and status(c, run_id)["current_turn_id"] == base_turn,
         {"cases": invalid_cases, "staged": staged})
for q, txt in orig.items():
    q.write_text(txt)

# valid edits: a01 compute, one plant's energy, and a settings value
a01p = W / "entities" / "agents" / "a01.json"
a01 = json.loads(a01p.read_text())
old_compute = a01["stats"]["compute"]
a01["stats"]["compute"] = 777.25
a01p.write_text(json.dumps(a01, indent=2))
plants = json.loads(plants_path.read_text())
pid = next(iter(plants))
old_energy = plants[pid]["energy"]
plants[pid]["energy"] = 42.0
plants_path.write_text(json.dumps(plants, indent=2))
sp = W / "settings.json"
settings = json.loads(sp.read_text())
settings["context"]["retrieved_memory_limit"] = 9
sp.write_text(json.dumps(settings, indent=2))
rr = c.post(f"/runs/{run_id}/working/reload").json()
paths = {ch["path"]: (ch["before"], ch["after"]) for ch in rr["changes"]}
extra["reload_changes"] = paths
ck.check("valid edits: reload ok with before/after for each edited field and a staged apply_working_files",
         rr["ok"] and paths.get("world.agents.a01.stats.compute") == (old_compute, 777.25)
         and any(k.endswith(f"{pid}.energy") and v == (old_energy, 42.0) for k, v in paths.items())
         and any(k.endswith("retrieved_memory_limit") and v[1] == 9 for k, v in paths.items())
         and rr["staged"]["type"] == "apply_working_files" and rr["staged"]["base_turn_id"] == base_turn,
         {"changes": paths, "staged_id": (rr.get("staged") or {}).get("id")})
ck.check("committed checkpoint untouched until the next turn", read_json(rd / "turns" / base_turn / "entities" / "agents" / "a01.json")["stats"]["compute"] == old_compute,
         old_compute)
command(c, run_id, "run_turn")
st = wait_idle(c, run_id)
T = st["current_turn_id"]
tr = read_json(rd / "turns" / T / "state.json")
ivr = [i for i in tr["interventions"] if i["intervention"]["type"] == "apply_working_files"]
a01_T = read_json(rd / "turns" / T / "entities" / "agents" / "a01.json")
plant_T = read_json(rd / "turns" / T / "entities" / "plants.json")[pid]
set_T = read_json(rd / "turns" / T / "settings.json")
ev_T = [e for e in read_json(rd / "turns" / T / "events.json") if e["kind"] == "intervention"]
acted = tr["acting_agent_id"]
ck.check("applied at the next turn: recorded intervention (ok, effective turn, before/after) + intervention event",
         len(ivr) == 1 and ivr[0]["ok"] and ivr[0]["effective_turn_id"] == T and ivr[0]["changes"] and len(ev_T) == 1,
         {"turn": T, "ok": ivr[0]["ok"] if ivr else None, "n_changes": len(ivr[0]["changes"]) if ivr else 0,
          "event": ev_T[0]["summary"] if ev_T else None})
ck.check("edited values are live in that turn's checkpoint",
         (a01_T["stats"]["compute"] == 777.25 or acted == "a01") and set_T["context"]["retrieved_memory_limit"] == 9,
         {"a01.compute": a01_T["stats"]["compute"], "acting": acted, "plant_energy": plant_T["energy"],
          "retrieved_memory_limit": set_T["context"]["retrieved_memory_limit"]})
# give the parent a future beyond the edit (so the continuation has later turns to preserve)
command(c, run_id, "run_turn")
wait_idle(c, run_id)
step_round(c, run_id)
step_round(c, run_id)
c.post(f"/runs/{run_id}/close")

# ---------- continuation from a historical turn (before the edit) ----------
H = "r00001_end"
parent_hashes = tree_hashes(rd / "turns")
parent_manifest = (rd / "manifest.json").read_text()
parent_index = (rd / "turns" / "index.jsonl").read_text()
later = [e["turn_id"] for e in index_entries(rd)]
later = later[later.index(H) + 1:]
r = c.post(f"/runs/{run_id}/continuations", json={"from_turn_id": H, "name": "res-h continuation from r00001_end"})
ck.check("POST continuations returns 201 with a new run id", r.status_code == 201, r.json())
cont = r.json()
cid = cont["run_id"]
cd = run_dir(cid)
extra["continuation_run_id"] = cid
cm = read_json(cd / "manifest.json")
h_state = read_json(rd / "turns" / H / "state.json")
ck.check("continuation manifest: parent ref, current turn = H, next_event_seq continues after H",
         cm["parent"] == {"world_id": cont["world_id"], "run_id": run_id, "turn_id": H} and cm["current_turn_id"] == H
         and cm["next_event_seq"] == h_state["event_seq_end"] + 1 and cm["world_id"] == read_json(rd / "manifest.json")["world_id"]
         and cm["real_usage"]["calls"] == 0,
         {"parent": cm["parent"], "current": cm["current_turn_id"], "next_event_seq": cm["next_event_seq"],
          "H.event_seq_end": h_state["event_seq_end"], "real_usage": cm["real_usage"]})
# INTERFACES 4.5 / 5 / 11: the continuation copies the RESOLVED checkpoint H: every file of the
# parent's turns/H is copied, every agent's knowledge file is written into the copy (the parent's
# turn dir may only reference unchanged stores in earlier turns via world.json knowledge_files)
# and the copy's knowledge_files map points at the copy itself with the same hashes.
ch_hashes = tree_hashes(cd / "turns" / H)
ph = tree_hashes(rd / "turns" / H)
KN = "entities/knowledge/"
same_other = sorted(k for k in ph if not k.startswith(KN) and k != "world.json" and ch_hashes.get(k) == ph[k])
diff_other = sorted(k for k in set(ph) | set(ch_hashes)
                    if not k.startswith(KN) and k != "world.json" and ch_hashes.get(k) != ph.get(k))
p_world = read_json(rd / "turns" / H / "world.json")
c_world = read_json(cd / "turns" / H / "world.json")
p_refs = p_world.pop("knowledge_files", None) or {}
c_refs = c_world.pop("knowledge_files", None) or {}
agent_ids = list(p_world["agent_order"])
kn_problems = []
for aid in agent_ids:
    src = knowledge_file(rd, H, aid)  # the parent's resolved file
    dst = cd / "turns" / H / "entities" / "knowledge" / f"{aid}.json"
    if not dst.exists():
        kn_problems.append((aid, "missing in the copy"))
    elif dst.read_bytes() != src.read_bytes():
        kn_problems.append((aid, "differs from the parent's resolved file " + str(src.relative_to(rd))))
    ref = c_refs.get(aid) or {}
    if ref.get("turn_id") != H or (p_refs and ref.get("sha256") != p_refs.get(aid, {}).get("sha256")):
        kn_problems.append((aid, "knowledge_files entry", ref, p_refs.get(aid)))
parent_local_kn = sorted(k for k in ph if k.startswith(KN))
extra["continuation_copy"] = {"parent_H_local_knowledge_files": parent_local_kn, "agents": agent_ids,
                              "identical_other_files": len(same_other)}
ck.check("continuation's first checkpoint is the parent's resolved turns/H: other files byte-identical, world.json equal "
         "apart from knowledge_files, every agent's knowledge file present and equal to the parent's resolved file, map -> H",
         not diff_other and c_world == p_world and not kn_problems and set(c_refs) == set(agent_ids),
         {"identical_other_files": len(same_other), "different_other_files": diff_other,
          "world_scalars_equal": c_world == p_world, "parent_H_local_knowledge": f"{len(parent_local_kn)}/{len(agent_ids)}",
          "copy_knowledge_files": sum(1 for k in ch_hashes if k.startswith(KN)), "problems": kn_problems[:5]})
kv_diff = []
for aid in agent_ids:
    a = c.get(f"/runs/{run_id}/turns/{H}/agents/{aid}/knowledge")
    b = c.get(f"/runs/{cid}/turns/{H}/agents/{aid}/knowledge")
    if a.status_code != 200 or b.status_code != 200 or a.json()["knowledge"] != b.json()["knowledge"]:
        kv_diff.append((aid, a.status_code, b.status_code))
tv_p = c.get(f"/runs/{run_id}/turns/{H}").json()
tv_c = c.get(f"/runs/{cid}/turns/{H}").json()
tv_keys_diff = sorted(k for k in tv_p if k not in ("parent",) and tv_p.get(k) != tv_c.get(k))
ck.check("through the API, H in the continuation equals H in the parent (turn view apart from parent, every agent's knowledge)",
         not kv_diff and not tv_keys_diff, {"knowledge_differences": kv_diff, "turn_view_keys_differing": tv_keys_diff})
ck.check("continuation contains only H in its turns/", sorted(p.name for p in (cd / "turns").iterdir() if p.is_dir()) == [H]
         and [e["turn_id"] for e in index_entries(cd)] == [H], [p.name for p in (cd / "turns").iterdir()])
st = open_run(c, cid)
ck.check("continuation opens paused at H", st["state"] == "paused" and st["current_turn_id"] == H, {k: st[k] for k in ("state", "current_turn_id")})
tv = c.get(f"/runs/{cid}/turns/{H}").json()
ck.check("turn view of H in the continuation carries the parent reference", tv["parent"] == cm["parent"], tv["parent"])
step_round(c, cid)
step_round(c, cid)
cc = chain_from_manifest(cd)
first_new = cc[1]
fn_state = read_json(cd / "turns" / first_new / "state.json")
fn_events = read_json(cd / "turns" / first_new / "events.json")
a01_new = read_json(cd / "turns" / first_new / "entities" / "agents" / "a01.json")
ck.check("the continuation's first new turn follows H (previous_turn_id) and seqs continue from H",
         fn_state["previous_turn_id"] == H and fn_events[0]["seq"] == h_state["event_seq_end"] + 1,
         {"first_new": first_new, "previous": fn_state["previous_turn_id"], "first_seq": fn_events[0]["seq"]})
ck.check("the continuation starts from the copied checkpoint, not the parent's edited future (a01 compute != 777.25)",
         all(read_json(cd / "turns" / t / "entities" / "agents" / "a01.json")["stats"]["compute"] != 777.25 for t in cc)
         and read_json(cd / "turns" / cc[-1] / "settings.json")["context"]["retrieved_memory_limit"] == 5,
         {"a01.compute at first new turn": a01_new["stats"]["compute"]})
parent_hashes_after = tree_hashes(rd / "turns")
changed = sorted(k for k in parent_hashes if parent_hashes_after.get(k) != parent_hashes[k])
added = sorted(set(parent_hashes_after) - set(parent_hashes))
ck.check("parent's original future preserved: every parent turn file unchanged, index and manifest unchanged",
         not changed and not added and (rd / "manifest.json").read_text() == parent_manifest
         and (rd / "turns" / "index.jsonl").read_text() == parent_index and all((rd / "turns" / t).is_dir() for t in later),
         {"parent_later_turns_kept": len(later), "changed_files": changed[:5], "added_files": added[:5]})
# deterministic fakes: the continuation re-plays the same next turn ids as the parent did
pc = chain_from_manifest(rd)
ck.check("continuation's new turn ids match the parent's next ids (same scheduler state copied)",
         cc[1:4] == pc[pc.index(H) + 1: pc.index(H) + 4], {"continuation": cc[1:4], "parent": pc[pc.index(H) + 1: pc.index(H) + 4]})
c.post(f"/runs/{cid}/close")
p = ck.dump(extra)
print("evidence:", p, "ALL OK" if ck.all_ok else "SOME FAILED")
sys.exit(0 if ck.all_ok else 1)
