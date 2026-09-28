#!/usr/bin/env python3
"""Behaviour counts per phase of one run (e.g. before / during / after a drought).

Usage: phases.py <TAG|run_id> <last_round_of_phase1> [<last_round_of_phase2> ...]
e.g. phases.py S26v1 34 64  -> phases 1-34, 35-64, 65-end
Per phase: rounds, alive at end, mean compute at end, decisions, action mix per agent-round,
eats (fruit absorbs and compute gained), hits / attackers / kills / hunt pairs, messages / senders /
pleas / offers / alliance words / replies, transfers, skills saved / skill runs / via-skill actions,
deaths by cause, invalid decisions, fruit spawned.
"""
import glob, json, re, sys
from collections import Counter, defaultdict

REPO = "/home/ubuntu/antegensim"


def main():
    ref = sys.argv[1]
    cuts = [int(x) for x in sys.argv[2:]]
    reg = json.load(open(f"{REPO}/sweep/registry.json"))["runs"]
    rid = reg[ref]["run_id"] if ref in reg else ref
    rd = glob.glob(f"{REPO}/worlds/*/runs/{rid}")[0]
    ids = {a["id"] for a in json.load(open(f"{rd}/run_request.json"))["agents"]}
    evs = []
    for f in sorted(glob.glob(f"{rd}/turns/*/events.json")):
        try:
            evs += json.load(open(f))
        except Exception:
            pass
    last = max([e["round"] for e in evs if e["kind"] == "round_ended"] or [0])
    bounds, lo = [], 1
    for c in cuts + [max(last, cuts[-1] + 1 if cuts else 1)]:
        bounds.append((lo, c))
        lo = c + 1
    ph = lambda r: next((i for i, (a, b) in enumerate(bounds) if a <= r <= b), None)
    P = [defaultdict(Counter) for _ in bounds]
    hitpairs = [Counter() for _ in bounds]
    attackers = [set() for _ in bounds]
    senders = [set() for _ in bounds]
    msgs = [[] for _ in bounds]
    for e in evs:
        k, d, r, a = e["kind"], e.get("details") or {}, e["round"], e.get("actor")
        i = ph(r)
        if i is None:
            continue
        c = P[i]
        if k == "decision":
            c["n"]["decisions"] += 1
        elif k == "decision_invalid":
            c["n"]["invalid"] += 1
        elif k == "fruit_spawned":
            c["n"]["fruit_spawned"] += 1
        elif k == "damage" and d.get("cause") == "attack":
            t = d.get("target") or d.get("entity_id")
            if t in ids:
                c["n"]["hits"] += 1
                hitpairs[i][(a, t)] += 1
                attackers[i].add(a)
        elif k == "death" and d.get("kind") == "agent":
            c["death"][d.get("cause")] += 1
        elif k == "skill_saved":
            c["n"]["skills_saved"] += 1
        elif k == "skill_started":
            c["n"]["skill_runs"] += 1
        elif k == "action":
            n, res, args = d["action"]["name"], d["result"], d["action"].get("args") or {}
            c["act"][n] += 1
            if d.get("via_skill"):
                c["n"]["via_skill"] += 1
            if not res.get("ok"):
                c["n"]["failed_actions"] += 1
                continue
            if n == "absorb":
                src = str(args.get("source", ""))
                kind = "fruit" if src.startswith("f") else ("agent" if src in ids else src[:1] or "?")
                c["n"][f"absorb_{kind}"] += 1
                if args.get("resource") == "compute":
                    c["n"][f"gained_{kind}"] += round((res.get("effects") or {}).get("gained", 0))
            if n in ("send", "broadcast"):
                m = str(args.get("message", ""))
                msgs[i].append((r, a, args.get("recipient", "*"), m))
                senders[i].add(a)
            if n == "transfer":
                c["n"]["transfers"] += 1
                c["xfer"][f"{a}->{args.get('recipient')} {args.get('amount')} {args.get('resource')}"] += 1
    for i, (lo, hi) in enumerate(bounds):
        # alive and compute at the last end snapshot inside the phase
        ends = [f for f in sorted(glob.glob(f"{rd}/turns/r*_end")) if lo <= int(f.split("/")[-1][1:6]) <= hi]
        alive, comp = 0, []
        if ends:
            for f in glob.glob(f"{ends[-1]}/entities/agents/*.json"):
                s = json.load(open(f))
                if s.get("alive"):
                    alive += 1
                    comp.append(s["stats"].get("compute", 0))
        c, m = P[i], msgs[i]
        nr = max(0, min(hi, last) - lo + 1)
        pleas = sum(1 for x in m if re.search(r"\b(help|critical|urgent|starving|spare|hungry|dying)\b", x[3], re.I))
        offers = sum(1 for x in m if re.search(r"\b(trade|exchange|in return|deal)\b", x[3], re.I))
        ally = sum(1 for x in m if re.search(r"\b(ally|alliance|together|team|cooperat\w*|share|sharing|truce|pact)\b", x[3], re.I))
        threat = sum(1 for x in m if re.search(r"\b(attack|kill|warn|back off|leave|stay away|mine|defend)\b", x[3], re.I))
        replies = len({(m1[1], m1[2]) for m1 in m for m2 in m
                       if m1[2] not in ("*", None) and m2[1] == m1[2] and m2[2] in (m1[1], "*") and 0 <= m2[0] - m1[0] <= 4})
        hunts = [p for p, v in hitpairs[i].items() if v >= 2]
        per = lambda v: f"{v / nr:.2f}/rd" if nr else "-"
        print(f"== phase {i + 1}: rounds {lo}-{min(hi, last)} ({nr} rounds) | alive at end {alive}, mean compute {sum(comp) / len(comp) if comp else 0:.0f}, "
              f"min {min(comp) if comp else 0:.0f}")
        n = c["n"]
        print(f"  decisions {n['decisions']} ({per(n['decisions'])}), invalid {n['invalid']}, failed actions {n['failed_actions']}, fruit spawned {n['fruit_spawned']} ({per(n['fruit_spawned'])})")
        print(f"  eating: fruit absorbs {n['absorb_fruit']} ({per(n['absorb_fruit'])}) gaining {n['gained_fruit']}; corpse/agent absorbs {n['absorb_agent']} gaining {n['gained_agent']}; "
              f"other absorbs {sum(v for k, v in n.items() if k.startswith('absorb_') and k not in ('absorb_fruit', 'absorb_agent'))}")
        print(f"  conflict: hits {n['hits']} by {len(attackers[i])} attackers {sorted(attackers[i])}, hunts {hunts}, deaths {dict(c['death'])}")
        print(f"  talk: {len(m)} msgs ({per(len(m))}) by {len(senders[i])} senders, replies {replies}, pleas {pleas}, offers {offers}, alliance words {ally}, threats {threat}")
        print(f"  transfers {n['transfers']} {dict(c['xfer'])}")
        print(f"  skills: saved {n['skills_saved']}, runs {n['skill_runs']}, via-skill actions {n['via_skill']}")
        tot = sum(c["act"].values()) or 1
        print("  action mix: " + ", ".join(f"{k} {v} ({100 * v / tot:.0f}%)" for k, v in c["act"].most_common(10)))


if __name__ == "__main__":
    main()
