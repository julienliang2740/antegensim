#!/usr/bin/env python3
"""Interaction ("story") metrics for one or more runs: attacks between agents, kills, hunts, retaliations,
message replies, trade offers, transfers, skill writers and how they fared.

Usage: story.py <TAG|run_id> [...] [--events]
"""
import glob, json, re, sys
from collections import Counter, defaultdict

REPO = "/home/ubuntu/antegensim"


def resolve(ref):
    reg = json.load(open(f"{REPO}/sweep/registry.json"))["runs"]
    return (ref, reg[ref]["run_id"]) if ref in reg else (ref, ref)


def story(ref, show_events=False):
    tag, rid = resolve(ref)
    rd = glob.glob(f"{REPO}/worlds/*/runs/{rid}")[0]
    req = json.load(open(f"{rd}/run_request.json"))
    ids = {a["id"] for a in req["agents"]}
    models = Counter(a.get("model_key") for a in req["agents"])
    evs = []
    for f in sorted(glob.glob(f"{rd}/turns/*/events.json")):
        try:
            evs += json.load(open(f))
        except Exception:
            pass
    last = max([e["round"] for e in evs if e["kind"] == "round_ended"] or [0])
    hits, msgs, transfers, deaths, writers = [], [], [], {}, defaultdict(list)
    via, acts = Counter(), Counter()
    for e in evs:
        k, d, r, a = e["kind"], e.get("details") or {}, e["round"], e.get("actor")
        if k == "damage" and d.get("cause") == "attack":
            t = d.get("target") or d.get("entity_id")
            if t in ids:
                hits.append((r, a, t, round(d.get("amount", 0))))
        elif k == "action":
            n, res = d["action"]["name"], d["result"]
            acts[a] += 1
            if d.get("via_skill"):
                via[a] += 1
            if n in ("send", "broadcast") and res.get("ok"):
                args = d["action"]["args"]
                msgs.append((r, a, args.get("recipient", "*"), str(args.get("message", ""))))
            if n == "transfer" and res.get("ok"):
                args = d["action"]["args"]
                transfers.append((r, a, args.get("recipient"), args.get("resource"), args.get("amount")))
        elif k == "death" and d.get("kind") == "agent":
            deaths[d.get("entity_id") or d.get("agent_id")] = (r, d.get("cause"))
        elif k == "skill_saved":
            writers[a].append((r, d.get("name")))
    # derived
    pair_hits = Counter((a, t) for _, a, t, _ in hits)
    hunts = [p for p, c in pair_hits.items() if c >= 2]
    retaliations = sorted({(t, a) for (r1, a, t, _) in hits for (r2, a2, t2, _) in hits if a2 == t and t2 == a and 0 < r2 - r1 <= 6})
    replies = sorted({(m1[1], m1[2]) for m1 in msgs for m2 in msgs
                      if m1[2] not in ("*", None) and m2[1] == m1[2] and m2[2] in (m1[1], "*") and 0 <= m2[0] - m1[0] <= 4})
    bcast_answers = sorted({(m1[1], m2[1]) for m1 in msgs if m1[2] == "*" for m2 in msgs
                            if m2[2] == m1[1] and 0 < m2[0] - m1[0] <= 4})
    offers = [m for m in msgs if re.search(r"\b(trade|exchange|in return|deal)\b", m[3], re.I)]
    pleas = [m for m in msgs if re.search(r"\b(help|critical|urgent|starving|spare)\b", m[3], re.I)]
    kills = [(v, r) for v, (r, c) in deaths.items() if c == "attack"]
    ends = sorted(glob.glob(f"{rd}/turns/*_end"))
    final = {}
    if ends:
        for f in glob.glob(f"{ends[-1]}/entities/agents/*.json"):
            s = json.load(open(f))
            final[s["id"]] = s["stats"].get("compute", 0) if s.get("alive") else None
    w_alive = [final.get(a) for a in writers if final.get(a) is not None]
    nw = [final.get(a) for a in ids if a not in writers]
    nw_alive = [x for x in nw if x is not None]
    total_acts = sum(acts.values())
    score = (5 * len(kills) + 3 * len(retaliations) + 4 * len(transfers) + 2 * (len(replies) + len(bcast_answers))
             + len({a for _, a, _, _ in hits}) + len(writers) + 0.5 * len(msgs))
    print(f"# {tag} {req.get('name')} r{last}/{req.get('max_rounds')} models {dict(models)} alive {sum(1 for v in final.values() if v is not None)}/{len(ids)}  STORY SCORE {score:.1f}")
    print(f"  conflict: {len(hits)} hits on agents by {len({a for _, a, _, _ in hits})} attackers, kills {len(kills)} {kills}, hunts {hunts}, retaliations {retaliations}")
    print(f"  talk: {len(msgs)} messages by {len({m[1] for m in msgs})} senders, direct replies {replies}, broadcast answers {bcast_answers}, pleas {len(pleas)}, trade offers {len(offers)}")
    print(f"  transfers: {transfers}")
    print(f"  skills: {sum(len(v) for v in writers.values())} saved by {len(writers)} writers, via-skill {sum(via.values())}/{total_acts} actions; "
          f"writers alive {len(w_alive)}/{len(writers)} mean compute {sum(w_alive) / len(w_alive) if w_alive else 0:.0f}; "
          f"non-writers alive {len(nw_alive)}/{len(nw)} mean compute {sum(nw_alive) / len(nw_alive) if nw_alive else 0:.0f}")
    dr = sorted(r for r, _ in deaths.values())
    print(f"  deaths: {len(deaths)} {dict(Counter(c for _, c in deaths.values()))} rounds {dr[:1]}..{dr[-1:]}")
    if show_events:
        for r, a, t, amt in hits:
            print(f"    r{r} HIT {a}->{t} {amt}")
        for r, a, t, m in msgs:
            print(f"    r{r} MSG {a}->{t}: {m[:160]}")


if __name__ == "__main__":
    args = [x for x in sys.argv[1:] if not x.startswith("--")]
    for ref in args:
        story(ref, "--events" in sys.argv)
