"""Change the fruit rhythm of a live sweep run through god mode (update_plant_rules), e.g. a drought.
Pauses the run (the watchdog is told to leave it alone), stages the intervention, plays again; the
change applies at the next turn boundary and is recorded in that turn. No engine code is touched.

Usage: weather.py <TAG> <mature_fruit_interval> <sapling_fruit_interval> <note ...>
"""
import sys, time
sys.path.insert(0, "/home/ubuntu/antegensim/sweep/tools")
import sweep as S

tag, mature, sapling, note = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), " ".join(sys.argv[4:]) or "weather"
entry = S.read_registry()["runs"][tag]
rid, port = entry["run_id"], entry.get("port", 8000)
with S.Registry() as r:
    r["runs"][tag]["moving"] = True
try:
    S.call("POST", f"/runs/{rid}/commands", {"command": "pause"}, port=port)
    for _ in range(150):
        c, st = S.call("GET", f"/runs/{rid}/status", port=port)
        if isinstance(st, dict) and st.get("state") in ("paused", "error", "finished"):
            break
        time.sleep(2)
    print("paused at", st.get("current_turn_id") if isinstance(st, dict) else st)
    c, rules = S.call("GET", f"/runs/{rid}/rules", port=port)
    rule = rules["plant_species"]["fruit_tree"]
    for stage in rule["stages"]:
        if stage["name"] == "mature":
            stage["fruit_interval_rounds"] = mature
        elif stage["name"] == "sapling":
            stage["fruit_interval_rounds"] = sapling
    c, resp = S.call("POST", f"/runs/{rid}/interventions",
                     {"type": "update_plant_rules", "species": "fruit_tree", "rule": rule, "note": note}, port=port)
    print("staged", c, [i.get("id") for i in resp.get("interventions", [])] if isinstance(resp, dict) else str(resp)[:300])
    if c not in (200, 201):
        raise SystemExit("staging failed")
    c, st = S.call("POST", f"/runs/{rid}/commands", {"command": "play"}, port=port)
    print("play", c, st.get("state") if isinstance(st, dict) else st)
finally:
    with S.Registry() as r:
        r["runs"][tag].pop("moving", None)
        r["runs"][tag]["notes"].append(time.strftime("%H:%M") + f" weather: mature trees fruit every {mature}, saplings every {sapling} ({note})")
