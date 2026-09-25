"""Criterion j (storage): bytes per turn for an 8-agent fake-heuristic run at rounds 1, 4
and 8, a per-file breakdown, an extrapolation to 1000 rounds, and the knowledge-file rule
(INTERFACES section 5 / 13, fix pass): a turn dir holds entities/knowledge/<id>.json only
for the agents whose store changed since the previous committed turn, world.json's
knowledge_files map names for EVERY agent the turn dir holding its current file (sha256 of
its text), and every turn stays loadable through the API (turn view + every agent's
knowledge equal to the file the map points at)."""
from __future__ import annotations

import hashlib
import sys
from collections import defaultdict

from rlib import (Checks, chain_from_manifest, client, create_run, defaults, dir_bytes, ensure_server, knowledge_refs,
                  open_run, read_json, run_dir, step_round)

ROUNDS = 8
ck = Checks("j_storage")
extra: dict = {}
ensure_server()
c = client()
req = defaults(c, 8)
req.update(name="res-j storage 8 rounds", seed=1, play_delay_seconds=0.0)
run_id = create_run(c, req)["run_id"]
rd = run_dir(run_id)
extra["run_id"] = run_id
open_run(c, run_id)
for _ in range(ROUNDS):
    st = step_round(c, run_id)
c.post(f"/runs/{run_id}/close")
ck.check(f"{ROUNDS} rounds committed", st["current_turn_id"] == f"r{ROUNDS:05d}_end", st["current_turn_id"])
chain = chain_from_manifest(rd)


def alloc(d):
    return sum(p.stat().st_blocks * 512 for p in d.rglob("*") if p.is_file())


def nfiles(d):
    return sum(1 for p in d.rglob("*") if p.is_file())


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


per_round = defaultdict(lambda: {"agent_turns": [], "end": None})
parts = defaultdict(lambda: defaultdict(int))
dup_knowledge = defaultdict(lambda: [0, 0])  # round -> [files byte-identical to the previous turn's resolved file, files]
dup_bytes = defaultdict(lambda: [0, 0])      # round -> [bytes identical to previous turn (all files), bytes]
prev = None
for tid in chain:
    d = rd / "turns" / tid
    b = dir_bytes(d)
    r = int(tid[1:6])
    row = {"turn": tid, "bytes": b, "alloc": alloc(d), "files": nfiles(d),
           "knowledge_bytes": dir_bytes(d / "entities" / "knowledge"),
           "knowledge_files": len(list((d / "entities" / "knowledge").glob("*.json")))}
    if "_t" in tid:
        per_round[r]["agent_turns"].append(row)
        for sub in ("entities/knowledge", "entities/agents", "model_calls", "decision_packets"):
            parts[r][sub] += dir_bytes(d / sub)
        for f in ("events.json", "map.json", "rules.json", "settings.json", "state.json", "world.json"):
            parts[r][f] += (d / f).stat().st_size
        for f in ("plants.json", "fruits.json", "seeds.json", "residues.json", "removed.json"):
            parts[r]["entities/(plants,fruits,seeds,residues,removed)"] += (d / "entities" / f).stat().st_size
    elif tid.endswith("_end"):
        per_round[r]["end"] = row
    if prev is not None:
        pd = rd / "turns" / prev
        prev_refs = knowledge_refs(rd, prev) or {}
        for kf in (d / "entities" / "knowledge").glob("*.json"):
            dup_knowledge[r][1] += 1
            ref = prev_refs.get(kf.stem)
            other = (rd / "turns" / ref["turn_id"] / "entities" / "knowledge" / kf.name) if ref else pd / "entities" / "knowledge" / kf.name
            if other.exists() and sha(other) == sha(kf):
                dup_knowledge[r][0] += 1
        for f in d.rglob("*"):
            if f.is_file():
                rel = f.relative_to(d)
                dup_bytes[r][1] += f.stat().st_size
                o = pd / rel
                if o.exists() and o.stat().st_size == f.stat().st_size and sha(o) == sha(f):
                    dup_bytes[r][0] += f.stat().st_size
    prev = tid

init = rd / "turns" / "r00000_init"
table = []
for r in range(1, ROUNDS + 1):
    ats = per_round[r]["agent_turns"]
    mean = sum(x["bytes"] for x in ats) / len(ats)
    mean_alloc = sum(x["alloc"] for x in ats) / len(ats)
    mean_k = sum(x["knowledge_bytes"] for x in ats) / len(ats)
    end = per_round[r]["end"]
    table.append({"round": r, "agent_turns": len(ats), "mean_agent_turn_bytes": round(mean),
                  "mean_agent_turn_alloc_bytes": round(mean_alloc), "mean_knowledge_bytes": round(mean_k),
                  "files_per_turn": ats[0]["files"], "round_end_bytes": end["bytes"],
                  "round_total_bytes": sum(x["bytes"] for x in ats) + end["bytes"],
                  "knowledge_files_identical_to_previous_turn": f"{dup_knowledge[r][0]}/{dup_knowledge[r][1]}",
                  "mean_knowledge_files_per_agent_turn": round(sum(x["knowledge_files"] for x in ats) / len(ats), 2),
                  "bytes_identical_to_previous_turn_pct": round(100 * dup_bytes[r][0] / dup_bytes[r][1], 1),
                  "parts_mean": {k: round(v / len(ats)) for k, v in parts[r].items()}})
extra["init_bytes"] = dir_bytes(init)
extra["per_round"] = table
for r in (1, 4, 8):
    t = table[r - 1]
    print(f"round {r}: mean agent turn {t['mean_agent_turn_bytes']:,} B (alloc {t['mean_agent_turn_alloc_bytes']:,}), "
          f"knowledge {t['mean_knowledge_bytes']:,} B, round end {t['round_end_bytes']:,} B, round total {t['round_total_bytes']:,} B, "
          f"identical-to-previous {t['bytes_identical_to_previous_turn_pct']}%, knowledge files per agent turn {t['mean_knowledge_files_per_agent_turn']} "
          f"(unchanged copies {t['knowledge_files_identical_to_previous_turn']})")

# least-squares fit of round total bytes vs round (rounds 2..8; round 1 has no packets for skills yet)
xs = [t["round"] for t in table]
ys = [t["round_total_bytes"] for t in table]
n = len(xs)
mx, my = sum(xs) / n, sum(ys) / n
slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
icpt = my - slope * mx
R = 1000
total_1000 = sum(icpt + slope * r for r in range(1, R + 1)) + extra["init_bytes"]
per_turn_at_1000 = (icpt + slope * R) / 9
ka = [t["mean_knowledge_bytes"] for t in table]
kslope = (ka[-1] - ka[0]) / (ROUNDS - 1)
extra["fit"] = {"round_total_bytes ~ a + b*round": {"a": round(icpt), "b": round(slope)},
                "extrapolated_total_bytes_1000_rounds": round(total_1000),
                "extrapolated_GB_1000_rounds": round(total_1000 / 1e9, 2),
                "extrapolated_bytes_per_turn_at_round_1000": round(per_turn_at_1000),
                "knowledge_bytes_per_turn_growth_per_round": round(kslope),
                "linear_lower_bound_GB (round-8 rate x 1000)": round(table[-1]["round_total_bytes"] * R / 1e9, 2)}
print("fit:", extra["fit"])
t8 = table[-1]
ck.check("measured bytes per turn at rounds 1, 4, 8", True, {r: table[r - 1]["mean_agent_turn_bytes"] for r in (1, 4, 8)})

# ---- knowledge-file rule (fix pass): only changed stores are written, the map covers every agent ----
map_problems = []   # ("map", ...): the map itself is wrong
rule_problems = []  # ("rule", ...): written/omitted files disagree with "only changed stores"
local_counts = []
prev_refs = None
for i, tid in enumerate(chain):
    d = rd / "turns" / tid
    world_doc = read_json(d / "world.json")
    agents = list(world_doc["agent_order"])
    refs = world_doc.get("knowledge_files")
    local = sorted(p.stem for p in (d / "entities" / "knowledge").glob("*.json"))
    local_counts.append(len(local))
    if not isinstance(refs, dict) or set(refs) != set(agents):
        map_problems.append((tid, "map missing or not covering every agent", sorted(refs or {})))
        prev_refs = refs if isinstance(refs, dict) else None
        continue
    for aid in agents:
        ref = refs[aid]
        target = rd / "turns" / ref["turn_id"] / "entities" / "knowledge" / f"{aid}.json"
        if ref["turn_id"] not in chain[: i + 1]:
            map_problems.append((tid, aid, "points outside the chain / to a later turn", ref["turn_id"]))
        elif not target.exists() or sha(target) != ref["sha256"]:
            map_problems.append((tid, aid, "target missing or hash mismatch", ref["turn_id"]))
        if (aid in local) != (ref["turn_id"] == tid):
            rule_problems.append((tid, aid, "local file presence disagrees with the map", ref["turn_id"]))
        if prev_refs is not None and aid in prev_refs:
            changed = prev_refs[aid]["sha256"] != ref["sha256"]
            if changed and aid not in local:
                rule_problems.append((tid, aid, "changed store not written"))
            if not changed and (aid in local or ref != prev_refs[aid]):
                rule_problems.append((tid, aid, "unchanged store rewritten or re-pointed"))
        elif i > 0 and aid not in local:
            rule_problems.append((tid, aid, "no previous map but file not local"))
    prev_refs = refs
agent_turn_counts = [n for tid, n in zip(chain, local_counts) if "_t" in tid]
extra["knowledge_files_rule"] = {"turns": len(chain), "local_files_per_turn": dict(zip(chain, local_counts)),
                                 "map_problems": map_problems, "rule_problems": rule_problems}
ck.check("every turn's world.json knowledge_files covers every agent and points at an existing file with that sha256 "
         "(the same turn or an earlier committed one)",
         not map_problems,
         {"turns": len(chain), "problems": map_problems[:5]})
ck.check("a turn dir holds knowledge files ONLY for the agents whose store changed since the previous committed turn "
         "(changed -> written, unchanged -> map entry carried over)",
         not rule_problems and not map_problems and min(agent_turn_counts) < 8,
         {"init_local_files": local_counts[0], "agent_turn_local_files_min_mean_max":
          [min(agent_turn_counts), round(sum(agent_turn_counts) / len(agent_turn_counts), 2), max(agent_turn_counts)],
          "problems": rule_problems[:5]})

# ---- every turn stays loadable and inspectable through the API ----
api_problems = []
n_views = n_kn = 0
for tid in chain:
    tv = c.get(f"/runs/{run_id}/turns/{tid}")
    n_views += 1
    if tv.status_code != 200 or tv.json()["turn"]["turn_id"] != tid:
        api_problems.append((tid, "turn view", tv.status_code))
        continue
    refs = knowledge_refs(rd, tid) or {}
    for aid in read_json(rd / "turns" / tid / "world.json")["agent_order"]:
        kv = c.get(f"/runs/{run_id}/turns/{tid}/agents/{aid}/knowledge")
        n_kn += 1
        if kv.status_code != 200:
            api_problems.append((tid, aid, kv.status_code))
            continue
        ref = refs.get(aid, {"turn_id": tid})
        on_disk = read_json(rd / "turns" / ref["turn_id"] / "entities" / "knowledge" / f"{aid}.json")
        if kv.json()["knowledge"] != on_disk:
            api_problems.append((tid, aid, "API knowledge != the file the map points at", ref["turn_id"]))
ck.check("every committed turn loads through the API: turn view 200 and every agent's knowledge == the file the map points at",
         not api_problems, {"turn_views": n_views, "knowledge_views": n_kn, "problems": api_problems[:5]})
p = ck.dump(extra)
print("evidence:", p, "ALL OK" if ck.all_ok else "SOME FAILED")
sys.exit(0 if ck.all_ok else 1)
