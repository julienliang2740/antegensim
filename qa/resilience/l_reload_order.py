"""Criterion h (extra, fix pass A-GOD-1): a working/ reload and UI god-mode edits staged for the
same boundary all survive, in either staging order.  Staged edits apply in staging order and the
file edit is a field diff onto the state at that moment (INTERFACES section 10 "Staging order is
application order"): a field both edited keeps the later-staged value, every other edit stays,
and each record shows the value it really replaced.  A file change whose target an earlier
staged edit removed fails the WHOLE file edit (ok=false, path + reason, nothing of it applied).

Runs against a real backend process over HTTP after one committed round (base turn
r00001_end), with fake-heuristic agents.  Independent of backend/tests/test_e2e_godmode.py."""
from __future__ import annotations

import json
import sys

from rlib import (Checks, client, command, create_run, defaults, ensure_server, open_run, run_dir, stage, step_round,
                  wait_idle)

ck = Checks("l_reload_order")
extra: dict = {"runs": {}}
ensure_server()
c = client()


def new_run(name: str) -> tuple[str, object]:
    req = defaults(c, 8)
    req.update(name=name, seed=1, play_delay_seconds=0.0)
    run_id = create_run(c, req)["run_id"]
    open_run(c, run_id)
    st = step_round(c, run_id)
    assert st["current_turn_id"] == "r00001_end", st
    return run_id, run_dir(run_id)


def live_view(run_id: str) -> dict:
    return c.get(f"/runs/{run_id}/state").json()


def free_land_far(view: dict, min_distance: int = 6) -> tuple[int, int]:
    cells, occ = view["map"]["cells"], view["map"].get("occupants", {})
    agents = [(a["position"]["x"], a["position"]["y"]) for a in view["entities"]["agents"].values()]
    cands = sorted((abs(x) + abs(y), x, y) for x, y in (tuple(map(int, k.split(","))) for k in cells)
                   if cells[f"{x},{y}"] == "land" and not occ.get(f"{x},{y}"))
    for _, x, y in cands:
        if all(abs(x - ax) + abs(y - ay) >= min_distance for ax, ay in agents):
            return x, y
    raise AssertionError("no free land cell far from the agents")


def reload_with(rd, edits: dict) -> dict:
    """edits: working-relative path -> function(json) -> None.  Returns the reload response."""
    for rel, fn in edits.items():
        p = rd / "working" / rel
        data = json.loads(p.read_text())
        fn(data)
        p.write_text(json.dumps(data, indent=2))
    return c.post(f"/runs/{rd.name}/working/reload").json()


def attacked(view: dict, target: str) -> bool:
    return any(e["kind"] == "action" and (e["details"].get("action") or {}).get("name") == "attack"
               and ((e["details"].get("action") or {}).get("args") or {}).get("target") == target for e in view["events"])


for order in ("ui_then_file", "file_then_ui"):
    run_id, rd = new_run(f"res-l reload order {order}")
    view0 = live_view(run_id)
    plant_id = sorted(view0["entities"]["plants"])[0]
    plant_energy0 = view0["entities"]["plants"][plant_id]["energy"]
    a05_health0 = view0["entities"]["agents"]["a05"]["stats"]["health"]
    fx, fy = free_land_far(view0)
    voice_text = f"RELOAD-ORDER-{order}"

    def stage_ui():
        rs = [stage(c, run_id, {"type": "voice", "recipients": {"mode": "agents", "agent_ids": ["a01"]}, "text": voice_text}),
              stage(c, run_id, {"type": "place_entity", "entity": {"kind": "fruit", "id": "", "position": {"x": fx, "y": fy},
                                                                   "available_compute": 33, "available_essence": 0}}),
              stage(c, run_id, {"type": "set_stat", "entity_id": "a05", "field": "stats.health", "value": 50}),
              stage(c, run_id, {"type": "update_context_settings", "scope": "run", "settings": {"recent_history_length": 4}})]
        assert all(r.status_code == 201 for r in rs), [r.text[:300] for r in rs]

    def do_reload():
        rr = reload_with(rd, {"entities/agents/a05.json": lambda d: d["stats"].__setitem__("health", 77.0),
                              "entities/plants.json": lambda d: d[plant_id].__setitem__("energy", 42.0)})
        assert rr["ok"], rr
        return rr

    if order == "ui_then_file":
        stage_ui()
        rr = do_reload()
    else:
        rr = do_reload()
        stage_ui()
    staged_types = [iv["type"] for iv in c.get(f"/runs/{run_id}/interventions").json()["staged"]]
    command(c, run_id, "run_turn")
    st = wait_idle(c, run_id)
    T = st["current_turn_id"]
    tv = c.get(f"/runs/{run_id}/turns/{T}").json()
    recs = tv["turn"]["interventions"]
    rec_summary = [(r["intervention"]["type"], r["ok"], r.get("error")) for r in recs]
    kn = c.get(f"/runs/{run_id}/turns/{T}/agents/a01/knowledge").json()["knowledge"]["records"]
    voice_recs = [r for r in kn if r["kind"] == "operator_voice" and voice_text in r["text"]]
    placed = [f for f in tv["entities"]["fruits"].values() if f["available_compute"] == 33
              and (f["position"]["x"], f["position"]["y"]) == (fx, fy)]
    file_rec = next(r for r in recs if r["intervention"]["type"] == "apply_working_files")
    stat_rec = next(r for r in recs if r["intervention"]["type"] == "set_stat")
    fch = {ch["path"]: (ch["before"], ch["after"]) for ch in file_rec["changes"]}
    sch = {ch["path"]: (ch["before"], ch["after"]) for ch in stat_rec["changes"]}
    a05_health = tv["entities"]["agents"]["a05"]["stats"]["health"]
    plant_energy = tv["entities"]["plants"][plant_id]["energy"]
    expected_health = 77.0 if order == "ui_then_file" else 50.0
    hp = "world.agents.a05.stats.health"
    if order == "ui_then_file":
        replaced_ok = sch.get(hp) == (a05_health0, 50) and fch.get(hp) == (50, 77.0)
    else:
        replaced_ok = fch.get(hp) == (a05_health0, 77.0) and sch.get(hp) == (77.0, 50)
    extra["runs"][order] = {"run_id": run_id, "turn": T, "staged_order": staged_types, "records": rec_summary,
                            "file_changes": fch, "set_stat_changes": sch, "a05_health": a05_health,
                            "plant_energy": plant_energy, "reload_changes": rr["changes"]}
    ck.check(f"{order}: all 5 staged edits applied ok at the boundary, in staging order",
             len(recs) == 5 and all(ok for _, ok, _ in rec_summary) and [t for t, _, _ in rec_summary] == staged_types
             and c.get(f"/runs/{run_id}/interventions").json()["staged"] == [],
             {"boundary": T, "staged_order": staged_types, "records": rec_summary})
    ck.check(f"{order}: every UI edit survived the reload (voice in a01's knowledge, placed fruit on the map, run setting)",
             len(voice_recs) == 1 and len(placed) == 1 and placed[0]["id"] in tv["map"]["occupants"].get(f"{fx},{fy}", [])
             and tv["settings"]["context"]["recent_history_length"] == 4,
             {"voice_records": len(voice_recs), "placed": [p["id"] for p in placed], "point": f"{fx},{fy}",
              "recent_history_length": tv["settings"]["context"]["recent_history_length"]})
    ck.check(f"{order}: the file edit applied too; the field both edited keeps the later-staged value; records show what they replaced",
             plant_energy == 42.0 and (a05_health == expected_health or attacked(tv, "a05")) and replaced_ok,
             {"plant_energy": [plant_energy0, plant_energy], "a05_health": a05_health, "expected": expected_health,
              "file_change": fch.get(hp), "set_stat_change": sch.get(hp)})
    c.post(f"/runs/{run_id}/close")

# ---- a file change whose target an earlier staged edit removed: the whole file edit fails ----
run_id, rd = new_run("res-l reload conflict")
view0 = live_view(run_id)
fruit_id = sorted(view0["entities"]["fruits"])[0]
a05_health0 = view0["entities"]["agents"]["a05"]["stats"]["health"]
r = stage(c, run_id, {"type": "remove_entity", "entity_id": fruit_id})
assert r.status_code == 201, r.text
rr = reload_with(rd, {"entities/fruits.json": lambda d: d[fruit_id].__setitem__("available_compute", 12.5),
                      "entities/agents/a05.json": lambda d: d["stats"].__setitem__("health", 77.0)})
command(c, run_id, "run_turn")
st = wait_idle(c, run_id)
T = st["current_turn_id"]
tv = c.get(f"/runs/{run_id}/turns/{T}").json()
recs = tv["turn"]["interventions"]
file_rec = next((x for x in recs if x["intervention"]["type"] == "apply_working_files"), None)
rm_rec = next((x for x in recs if x["intervention"]["type"] == "remove_entity"), None)
snap = file_rec["intervention"].get("snapshot_ref") if file_rec else None
extra["conflict"] = {"run_id": run_id, "turn": T, "reload_ok": rr["ok"], "reload_changes": rr["changes"],
                     "records": [(x["intervention"]["type"], x["ok"], x.get("error")) for x in recs]}
ck.check("conflict: reload accepted (ok, 2 changes), then at the boundary remove_entity ok and the file edit ok=false naming the path",
         rr["ok"] and len(rr["changes"]) == 2 and rm_rec and rm_rec["ok"] and file_rec and file_rec["ok"] is False
         and f"world.fruits.{fruit_id}" in (file_rec.get("error") or "") and st["state"] == "paused",
         {"records": extra["conflict"]["records"], "state": st["state"]})
ck.check("conflict: nothing of the failed file edit applied (a05 health unchanged), the removal stands, snapshot cleaned up",
         (tv["entities"]["agents"]["a05"]["stats"]["health"] == a05_health0 or attacked(tv, "a05"))
         and fruit_id not in tv["entities"]["fruits"] and fruit_id in tv["entities"]["removed"]
         and (snap is None or not (rd / snap).exists()) and c.get(f"/runs/{run_id}/interventions").json()["staged"] == [],
         {"a05_health": [a05_health0, tv["entities"]["agents"]["a05"]["stats"]["health"]], "fruit_removed": fruit_id in tv["entities"]["removed"],
          "snapshot_ref": snap, "snapshot_exists": bool(snap and (rd / snap).exists())})
c.post(f"/runs/{run_id}/close")
p = ck.dump(extra)
print("evidence:", p, "ALL OK" if ck.all_ok else "SOME FAILED")
sys.exit(0 if ck.all_ok else 1)
