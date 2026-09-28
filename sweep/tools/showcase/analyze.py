#!/usr/bin/env python3
"""Showcase analysis for one run: per-agent divergence table, economy split and a timeline of notable events.

Usage: analyze.py <TAG|run_id> [--timeline N] [--thoughts AGENT_ID]
Reads the run folder only (no API, no model calls). TAG resolves through sweep/registry.json.
"""
import glob, json, sys
from collections import Counter, defaultdict

REPO = "/home/ubuntu/antegensim"


def resolve(ref):
    reg = json.load(open(f"{REPO}/sweep/registry.json"))["runs"]
    if ref in reg:
        return ref, reg[ref]["run_id"]
    for t, r in reg.items():
        if r["run_id"] == ref:
            return t, ref
    return ref, ref


def main():
    a = sys.argv[1:]
    tag, run_id = resolve(a[0])
    tl_n = int(a[a.index("--timeline") + 1]) if "--timeline" in a else 60
    thoughts_of = a[a.index("--thoughts") + 1] if "--thoughts" in a else None
    rd = glob.glob(f"{REPO}/worlds/*/runs/{run_id}")[0]
    req = json.load(open(f"{rd}/run_request.json"))
    evs = []
    for f in sorted(glob.glob(f"{rd}/turns/*/events.json")):
        try:
            evs += json.load(open(f))
        except Exception:
            pass
    agents = [c["id"] for c in req["agents"]]
    name = {c["id"]: c.get("name", c["id"]) for c in req["agents"]}
    start = {c["id"]: (c["position"]["x"], c["position"]["y"]) for c in req["agents"]}
    start_c = {c["id"]: (c.get("stats") or {}).get("compute") for c in req["agents"]}
    last_round = max([e["round"] for e in evs if e["kind"] == "round_ended"] or [0])
    ends = sorted(glob.glob(f"{rd}/turns/*_end"))
    final = {}
    if ends:
        for f in glob.glob(f"{ends[-1]}/entities/agents/*.json"):
            s = json.load(open(f))
            final[s["id"]] = s

    kinds = defaultdict(Counter)
    via = Counter()
    nacts = Counter()
    cog = Counter()
    act_cost = Counter()
    decisions = Counter()
    skips = Counter()
    invalid = Counter()
    saved = defaultdict(list)
    rejected = Counter()
    started = Counter()
    upgrades = defaultdict(list)
    msgs_out = Counter()
    transfers = []
    hits = []
    absorbs = Counter()
    contested = Counter()
    deaths = {}
    timeline = []
    first_seen = set()

    def note(r, text, key=None):
        if key and key in first_seen:
            return
        if key:
            first_seen.add(key)
        timeline.append((r, text))

    for e in evs:
        k, actor, r, d = e["kind"], e.get("actor"), e["round"], e.get("details") or {}
        if k in ("model_call_completed", "model_call_failed"):
            cog[actor] += float((e.get("costs") or {}).get("compute") or 0)  # the thinking charge rides on the call event
        elif k == "decision":
            decisions[actor] += 1
        elif k == "decision_invalid":
            invalid[actor] += 1
        elif k == "resource_skip":
            skips[actor] += 1
            note(r, f"{actor} can no longer afford to think (first resource_skip)", f"skip{actor}")
        elif k == "skill_saved":
            nm = d.get("name") or d.get("skill") or "?"
            saved[actor].append((r, nm))
            note(r, f"{actor} saved skill '{nm}'" + (f": {str(d.get('source'))[:160]!r}" if d.get("source") else ""), f"save{actor}{nm}")
        elif k == "skill_rejected":
            rejected[actor] += 1
            note(r, f"{actor} skill rejected: {e['summary'][:140]}", f"rej{actor}")
        elif k == "skill_started":
            started[actor] += 1
            note(r, f"{actor} first ran a skill: {e['summary'][:120]}", f"run{actor}")
        elif k == "action":
            an = d["action"]["name"]
            res = d["result"]
            nacts[actor] += 1
            kinds[actor][an] += 1
            act_cost[actor] += float(res.get("cost_compute") or 0)
            if d.get("via_skill"):
                via[actor] += 1
            if an == "absorb" and res.get("ok"):
                absorbs[actor] += 1
            if an == "absorb" and res.get("reason") in ("empty_source", "target_gone"):
                contested[actor] += 1
                note(r, f"{actor} lost a fruit race ({res.get('reason')})", f"cont{actor}")
            if an == "upgrade" and res.get("ok"):
                upgrades[actor].append((r, d["action"]["args"].get("attribute")))
                note(r, f"{actor} upgraded {d['action']['args'].get('attribute')}")
            if an in ("send", "broadcast") and res.get("ok"):
                msgs_out[actor] += 1
                if msgs_out[actor] <= 2:
                    note(r, f"{actor} {an}: {str(d['action']['args'].get('message'))[:180]!r}")
            if an == "transfer" and res.get("ok"):
                args = d["action"]["args"]
                transfers.append((r, actor, args.get("recipient"), args.get("resource"), args.get("amount")))
                note(r, f"{actor} TRANSFER {args.get('amount')} {args.get('resource')} -> {args.get('recipient')}")
        elif k == "damage" and d.get("cause") == "attack":
            hits.append((r, actor, d.get("target") or d.get("entity_id"), d.get("amount")))
            note(r, f"ATTACK {actor} -> {d.get('target') or d.get('entity_id')} ({round(d.get('amount', 0), 1)} dmg)")
        elif k == "death" and d.get("kind") == "agent":
            who = d.get("entity_id") or d.get("agent_id")
            deaths[who] = (r, d.get("cause"))
            note(r, f"DEATH {who} ({d.get('cause')})")

    print(f"# {tag} {req.get('name')} ({run_id}) rounds {last_round}/{req.get('max_rounds')}")
    tot_cog, tot_act = sum(cog.values()), sum(act_cost.values())
    tot_acts = sum(nacts.values())
    print(f"economy: thinking {tot_cog:.0f} compute vs world actions {tot_act:.0f} compute "
          f"({(tot_cog / (tot_cog + tot_act) * 100) if tot_cog + tot_act else 0:.0f}% of spend on thinking); "
          f"actions {tot_acts}, via skill {sum(via.values())} ({(sum(via.values()) / tot_acts * 100) if tot_acts else 0:.0f}%); "
          f"skills saved {sum(len(v) for v in saved.values())} by {len(saved)} agents, rejected {sum(rejected.values())}, runs {sum(started.values())}; "
          f"messages {sum(msgs_out.values())}; transfers {len(transfers)}; hits {len(hits)}; deaths {len(deaths)}")
    print("| agent | start | compute start->now | outcome | decisions | dominant actions | via skill | skills saved (round) | first upgrade | msgs | fruit eaten / lost races | thinking cost |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for aid in agents:
        f = final.get(aid, {})
        st = f.get("stats", {})
        outcome = f"died r{deaths[aid][0]} ({deaths[aid][1]})" if aid in deaths else f"alive h{st.get('health', 0):.0f}"
        dom = ", ".join(f"{k} {v}" for k, v in kinds[aid].most_common(3))
        sk = ", ".join(f"{n} r{r}" for r, n in saved[aid]) or "-"
        fu = f"{upgrades[aid][0][1]} r{upgrades[aid][0][0]}" if upgrades[aid] else "-"
        vs = f"{via[aid]}/{nacts[aid]}"
        print(f"| {aid} {name[aid]} | {start[aid]} | {start_c[aid]}->{st.get('compute', 0):.0f} | {outcome} | {decisions[aid]} "
              f"| {dom} | {vs} | {sk} | {fu} | {msgs_out[aid]} | {absorbs[aid]} / {contested[aid]} | {cog[aid]:.0f} |")
    if transfers:
        print("transfers:", "; ".join(f"r{r} {a}->{b} {amt} {res}" for r, a, b, res, amt in transfers[:20]))
    print(f"timeline (first {tl_n}):")
    for r, t in sorted(timeline, key=lambda x: x[0])[:tl_n]:
        print(f"  r{r}: {t}")
    if thoughts_of:
        print(f"thoughts of {thoughts_of}:")
        for e in evs:
            if e["kind"] == "decision" and e.get("actor") == thoughts_of:
                d = e["details"]
                print(f"  r{e['round']} {d.get('action', {}).get('name')}: {str(d.get('thought'))[:220]}")


if __name__ == "__main__":
    main()
