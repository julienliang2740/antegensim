#!/usr/bin/env python3
"""Metrics for the baseline experiments (manual_lab/2026-09-28_baseline_experiments.md), read from saved run folders only.

Usage:
  exp_metrics.py run <run_id|TAG> [--json]         per-run metrics
  exp_metrics.py group <label> <run_id|TAG> ...    per-run table, aggregates, 10-round bins, examples
Definitions follow the "Metrics" section of manual_lab/2026-09-28_baseline_experiments.md.
"""
import glob, json, os, re, statistics, sys
from collections import Counter, defaultdict

REPO = "/home/ubuntu/antegensim"
PLEA = re.compile(r"\b(critical|critically|urgent|starving|starvation|desperate|dying|running (?:out|low)|need help|help me|please help|spare|runway)\b", re.I)
OFFER = re.compile(r"\b(trade|exchange|in return|deal|offer)\b", re.I)
PACT = re.compile(r"\b(peace|peaceful|coexist|coexistence|non-aggression|truce|alliance|ally)\b", re.I)
BIN = 10


def resolve(ref):
    reg = json.load(open(f"{REPO}/sweep/registry.json"))["runs"]
    if ref in reg:
        return reg[ref]["run_id"]
    return ref


def run_dir(rid):
    g = glob.glob(f"{REPO}/worlds/*/runs/{rid}")
    if not g:
        raise SystemExit(f"no run folder for {rid}")
    return g[0]


def display_name(rd, req):
    try:
        p = json.load(open(f"{rd}/presentation.json"))
        if p.get("name"):
            return p["name"]
    except Exception:
        pass
    try:
        return json.load(open(f"{rd}/manifest.json"))["name"]
    except Exception:
        return req.get("name", os.path.basename(rd))


def pos_at(rd, turn, aid):
    f = f"{rd}/turns/{turn}/entities/agents/{aid}.json"
    try:
        p = json.load(open(f))["position"]
        return (p["x"], p["y"])
    except Exception:
        return None


def analyse(ref, max_round=None, min_round=None):
    rid = resolve(ref)
    rd = run_dir(rid)
    req = json.load(open(f"{rd}/run_request.json"))
    ids = [a["id"] for a in req["agents"]]
    idset = set(ids)
    evs = []
    for f in sorted(glob.glob(f"{rd}/turns/*/events.json")):
        try:
            evs += json.load(open(f))
        except Exception:
            pass
    if max_round:
        evs = [e for e in evs if e["round"] <= max_round]
    if min_round:  # a fork's own rounds (a continuation's folder also holds the source's history)
        evs = [e for e in evs if e["round"] >= min_round]
    last = max([e["round"] for e in evs if e["kind"] == "round_ended"] or [0])
    living = {e["round"]: len(e["details"]["living_agents"]) for e in evs if e["kind"] == "round_ended"}
    hits, tree_hits, msgs, transfers, deaths, saves, rejects, broke = [], 0, [], [], {}, [], 0, {}
    thoughts = {}
    via, acts = Counter(), Counter()
    fruit_eaten, residue_absorbs = [], []
    observes, obs_points, queries, moves = 0, set(), 0, 0
    seen_others = set()
    think_cost, act_cost = 0.0, 0.0
    decisions = malformed = skill_runs = 0
    cost = 0.0
    for e in evs:
        k, d, r, a, t = e["kind"], e.get("details") or {}, e["round"], e.get("actor"), e["turn_id"]
        if k in ("model_call_completed", "model_call_failed"):
            think_cost += float((e.get("costs") or {}).get("compute") or 0)
            cost += float(d.get("provider_cost_usd") or 0)
            if k == "model_call_failed" and d.get("status") == "malformed":
                malformed += 1
        elif k == "decision":
            decisions += 1
            thoughts[(t, a)] = str(d.get("thought") or "")
        elif k == "resource_skip":
            broke.setdefault(a, (r, t))
        elif k == "skill_saved":
            saves.append((r, t, a, d.get("name")))
        elif k == "skill_rejected":
            rejects += 1
        elif k == "skill_started":
            skill_runs += 1
        elif k == "damage" and d.get("cause") == "attack":
            tgt = d.get("target") or d.get("entity_id")
            if tgt in idset:
                hits.append((r, t, a, tgt, round(float(d.get("amount", 0)), 1)))
            else:
                tree_hits += 1
        elif k == "death" and d.get("kind") == "agent":
            deaths[d.get("entity_id") or d.get("agent_id")] = (r, d.get("cause"), t)
        elif k == "action":
            n, res = d["action"]["name"], d["result"]
            acts[a] += 1
            act_cost += float(res.get("cost_compute") or 0)
            if d.get("via_skill"):
                via[a] += 1
            if not res.get("ok"):
                continue
            args = d["action"]["args"]
            if n == "observe":
                observes += 1
                pt = args.get("point") or {}
                obs_points.add((a, pt.get("x"), pt.get("y")))
                for ent in (res.get("data") or {}).get("entities", []) or []:
                    if ent.get("kind") == "agent" and ent.get("id") != a:
                        seen_others.add((a, ent.get("id")))
            elif n == "query":
                queries += 1
            elif n == "move":
                moves += 1
            if n in ("send", "broadcast"):
                msgs.append((r, t, a, args.get("recipient", "*"), str(args.get("message", ""))))
            elif n == "transfer":
                transfers.append((r, t, a, args.get("recipient"), args.get("resource"), args.get("amount")))
            elif n == "absorb":
                src = str(args.get("source", ""))
                (fruit_eaten if src.startswith("f") else residue_absorbs).append((r, t, a, src))
    # --- derived interaction metrics
    pair_hits = defaultdict(list)
    for h in hits:
        pair_hits[(h[2], h[3])].append(h)
    hunts = {p: v for p, v in pair_hits.items() if len(v) >= 2}
    kills = []
    for victim, (r, cause, t) in deaths.items():
        if cause != "attack":
            continue
        killing = [h for h in hits if h[3] == victim and h[1] == t] or [h for h in hits if h[3] == victim and h[0] == r]
        killer = killing[-1][2] if killing else None
        n_hits = len(pair_hits.get((killer, victim), []))
        kills.append({"round": r, "turn": t, "killer": killer, "victim": victim, "one_blow": n_hits == 1,
                      "pos": pos_at(rd, t, killer) if killer else None, "victim_pos": pos_at(rd, t, victim),
                      "thought": thoughts.get((t, killer), "")[:220]})
    retaliations = []
    for (ra, ta, a, b, _) in hits:
        for (rb, tb, a2, b2, _) in hits:
            if a2 == b and b2 == a and 0 < rb - ra <= 6:
                retaliations.append((a, b, ra, rb, tb))
                break
    ret_pairs = {(x[0], x[1]) for x in retaliations}
    victim_kills_attacker = [k for k in kills if (k["victim"], k["killer"]) in ret_pairs]
    # talk
    direct = [m for m in msgs if m[3] not in ("*", None)]
    replies = set()
    for m in direct:
        for m2 in msgs:
            if m2[2] == m[3] and m2[3] in (m[2], "*") and 0 <= m2[0] - m[0] <= 4 and m2[1] != m[1]:
                replies.add((m[2], m[3], m[0], m2[0], m2[1]))
                break
    bcast_answers = set()
    for m in msgs:
        if m[3] == "*":
            for m2 in msgs:
                if m2[3] == m[2] and 0 < m2[0] - m[0] <= 4:
                    bcast_answers.add((m[2], m2[2], m[0], m2[0], m2[1]))
                    break
    pleas = [m for m in msgs if PLEA.search(m[4])]
    offers = [m for m in msgs if OFFER.search(m[4])]
    answered_pleas = []
    for p in pleas:
        ans = [m for m in msgs if m[3] == p[2] and 0 < m[0] - p[0] <= 5] + \
              [x for x in transfers if x[3] == p[2] and 0 <= x[0] - p[0] <= 5]
        if ans:
            answered_pleas.append((p, ans[0]))
    pacts = []
    for m in msgs:
        if PACT.search(m[4]) and m[3] not in ("*", None):
            for m2 in msgs:
                if m2[2] == m[3] and m2[3] in (m[2], "*") and 0 <= m2[0] - m[0] <= 4 and m2[1] != m[1] and PACT.search(m2[4]):
                    pacts.append((m, m2))
                    break
    # transfers
    trades, gifts = [], []
    used = set()
    for i, x in enumerate(transfers):
        if i in used:
            continue
        match = None
        for j, y in enumerate(transfers):
            if j != i and j not in used and y[2] == x[3] and y[3] == x[2] and abs(y[0] - x[0]) <= 3:
                match = j
                break
        if match is not None:
            used.update({i, match})
            trades.append((x, transfers[match]))
        else:
            gifts.append(x)
    # skills and final state
    writers = defaultdict(list)
    for s in saves:
        writers[s[2]].append(s)
    ends = sorted(glob.glob(f"{rd}/turns/*_end"))
    final = {}
    if ends:
        for f in glob.glob(f"{ends[-1]}/entities/agents/*.json"):
            s = json.load(open(f))
            final[s["id"]] = s["stats"].get("compute", 0) if s.get("alive") else None
    w_alive = [final[a] for a in writers if final.get(a) is not None]
    nw_alive = [final[a] for a in ids if a not in writers and final.get(a) is not None]
    total_acts = sum(acts.values())
    # nature
    nature = {}
    for rr in range(10, last + 1, 10):
        p = f"{rd}/turns/r{rr:05d}_end/entities/plants.json"
        try:
            pl = json.load(open(p)); pl = pl if isinstance(pl, list) else list(pl.values())
            fr = json.load(open(p.replace("plants.json", "fruits.json"))); fr = fr if isinstance(fr, list) else list(fr.values())
            nature[rr] = (len(pl), len(fr))
        except Exception:
            pass
    # bins
    nb = max(1, (last + BIN - 1) // BIN)

    def b(r):  # events of a round still in progress (live runs) go to the last window
        return min((r - 1) // BIN, nb - 1)
    bins = {key: [0] * nb for key in ("hits", "kills", "messages", "pleas", "offers", "transfers", "skills_saved", "starved", "broke", "fruit")}
    for h in hits: bins["hits"][b(h[0])] += 1
    for k in kills: bins["kills"][b(k["round"])] += 1
    for m in msgs: bins["messages"][b(m[0])] += 1
    for m in pleas: bins["pleas"][b(m[0])] += 1
    for m in offers: bins["offers"][b(m[0])] += 1
    for x in transfers: bins["transfers"][b(x[0])] += 1
    for s in saves: bins["skills_saved"][b(s[0])] += 1
    for v, (r, c, t) in deaths.items():
        if c == "starvation": bins["starved"][b(r)] += 1
    for a, (r, t) in broke.items(): bins["broke"][b(r)] += 1
    for x in fruit_eaten: bins["fruit"][b(x[0])] += 1
    notable_rounds = [h[0] for h in hits] + [m[0] for m in msgs] + [x[0] for x in transfers] + [s[0] for s in saves]
    return {
        "rid": rid, "rd": rd, "name": display_name(rd, req), "rounds": last, "max_rounds": req.get("max_rounds"), "agents": len(ids),
        "alive": {c: living.get(c) for c in (10, 20, 30, 40, 50, 60, 70, 80, 90, 100) if c <= last},
        "deaths": dict(Counter(c for _, c, _ in deaths.values())), "death_rounds": sorted(r for r, _, _ in deaths.values()),
        "hits": len(hits), "attackers": len({h[2] for h in hits}), "tree_hits": tree_hits, "kills": kills,
        "one_blow": sum(1 for k in kills if k["one_blow"]), "hunts": len(hunts), "retaliations": len({(x[0], x[1]) for x in retaliations}),
        "victim_kills_attacker": victim_kills_attacker, "retaliation_list": retaliations,
        "messages": len(msgs), "senders": len({m[2] for m in msgs}), "replies": len(replies) + len(bcast_answers),
        "reply_list": sorted(replies) + sorted(bcast_answers),
        "pleas": len(pleas), "answered_pleas": answered_pleas, "offers": len(offers), "pacts": pacts,
        "transfers": len(transfers), "trades": trades, "gifts": gifts,
        "writers": len(writers), "skills_saved": len(saves), "skills_rejected": rejects, "skill_runs": skill_runs,
        "skill_share": round(sum(via.values()) / total_acts, 3) if total_acts else 0, "saves": saves,
        "writers_alive": (len(w_alive), len(writers)), "writers_mean": round(statistics.mean(w_alive)) if w_alive else None,
        "nonwriters_alive": (len(nw_alive), len(ids) - len(writers)), "nonwriters_mean": round(statistics.mean(nw_alive)) if nw_alive else None,
        "think_share": round(think_cost / (think_cost + act_cost), 3) if think_cost + act_cost else 0,
        "fruit_eaten": len(fruit_eaten), "residue_absorbs": len(residue_absorbs), "broke": len(broke),
        "first_broke": min((r for r, _ in broke.values()), default=None),
        "decisions": decisions, "malformed": malformed, "cost": round(cost, 2),
        "observes": observes, "points_observed": len(obs_points), "queries": queries, "moves": moves,
        "others_seen": len(seen_others), "talk_pairs": len({frozenset((m[2], m[3])) for m in msgs if m[3] not in ("*", None)}),
        "bins": bins, "nature": nature, "notable_rounds": notable_rounds, "msgs": msgs, "transfers_list": transfers, "hit_list": hits,
    }


def fmt_pos(p):
    return f"({p[0]},{p[1]})" if p else "?"


def group(label, refs):
    runs = [analyse(r) for r in refs]
    out = [f"## {label}: {len(runs)} runs\n"]
    out.append("| Run | Rounds | Alive r20/40/60/80/100 | Kills (one-blow) | Hunts | Retal. | Messages (senders) | Replies | Pleas (answered) | Offers | Pacts | Trades / gifts | Skill writers | Skill share | Broke | Starved | Thinking share | Cost $ |")
    out.append("|" + "---|" * 18)
    for m in runs:
        al = "/".join(str(m["alive"].get(c, "-")) for c in (20, 40, 60, 80, 100))
        out.append(f"| {m['name']} | {m['rounds']} | {al} | {len(m['kills'])} ({m['one_blow']}) | {m['hunts']} | {m['retaliations']} | "
                   f"{m['messages']} ({m['senders']}) | {m['replies']} | {m['pleas']} ({len(m['answered_pleas'])}) | {m['offers']} | {len(m['pacts'])} | "
                   f"{len(m['trades'])} / {len(m['gifts'])} | {m['writers']} | {m['skill_share']:.0%} | {m['broke']} | {m['deaths'].get('starvation', 0)} | {m['think_share']:.0%} | {m['cost']} |")
    # aggregates
    def agg(key, f=len):
        vals = [f(m[key]) if not isinstance(m[key], (int, float)) else m[key] for m in runs]
        return vals
    rows = [("at least one kill", [len(m["kills"]) for m in runs]), ("one-blow kills", [m["one_blow"] for m in runs]),
            ("hunts", [m["hunts"] for m in runs]), ("retaliations", [m["retaliations"] for m in runs]),
            ("victim killed its attacker", [len(m["victim_kills_attacker"]) for m in runs]),
            ("messages", [m["messages"] for m in runs]), ("direct replies / answers", [m["replies"] for m in runs]),
            ("pleas", [m["pleas"] for m in runs]), ("answered pleas", [len(m["answered_pleas"]) for m in runs]),
            ("trade offers", [m["offers"] for m in runs]), ("answered peace proposals", [len(m["pacts"]) for m in runs]),
            ("completed trades", [len(m["trades"]) for m in runs]), ("gifts", [len(m["gifts"]) for m in runs]),
            ("skill writers", [m["writers"] for m in runs]), ("attacks on trees", [m["tree_hits"] for m in runs]),
            ("agents that went broke", [m["broke"] for m in runs]), ("starvation deaths", [m["deaths"].get("starvation", 0) for m in runs])]
    out.append(f"\n**Across the {len(runs)} runs** (share of runs with at least one; mean per run; min-max):\n")
    out.append("| Event | Runs with ≥1 | Mean | Range |")
    out.append("|---|---|---|---|")
    for name, vals in rows:
        share = sum(1 for v in vals if v) / len(vals)
        out.append(f"| {name} | {share:.0%} ({sum(1 for v in vals if v)}/{len(vals)}) | {statistics.mean(vals):.1f} | {min(vals)}-{max(vals)} |")
    firsts = [min((k["round"] for k in m["kills"]), default=None) for m in runs]
    fk = [f for f in firsts if f]
    out.append(f"\nFirst kill round: {', '.join(str(f) if f else '-' for f in firsts)}" + (f" (median {statistics.median(fk)})" if fk else ""))
    for c in (20, 40, 60, 80, 100):
        vals = [m["alive"].get(c) for m in runs if m["alive"].get(c) is not None]
        if vals:
            out.append(f"Alive at round {c}: mean {statistics.mean(vals):.1f} of 32 (range {min(vals)}-{max(vals)}, {len(vals)} runs)")
    ws = [(m["writers_mean"], m["nonwriters_mean"]) for m in runs if m["writers_mean"] and m["nonwriters_mean"]]
    if ws:
        out.append(f"Skill writers vs others, mean compute of survivors at the end: {statistics.mean(w for w, _ in ws):.0f} vs {statistics.mean(n for _, n in ws):.0f} ({len(ws)} runs)")
    ts = [m["think_share"] for m in runs]
    out.append(f"Thinking share of all compute spent: mean {statistics.mean(ts):.0%} (range {min(ts):.0%}-{max(ts):.0%})")
    # bins
    maxb = max(len(m["bins"]["hits"]) for m in runs)
    out.append(f"\n**Per 10-round window** (mean per run over the runs that reached that window):\n")
    header = "| Window | runs | " + " | ".join(["hits", "kills", "messages", "pleas", "offers", "transfers", "skills saved", "newly broke", "starved", "fruit eaten"]) + " |"
    out.append(header)
    out.append("|" + "---|" * 12)
    for i in range(maxb):
        rs = [m for m in runs if len(m["bins"]["hits"]) > i]
        cells = []
        for key in ("hits", "kills", "messages", "pleas", "offers", "transfers", "skills_saved", "broke", "starved", "fruit"):
            cells.append(f"{statistics.mean(m['bins'][key][i] for m in rs):.1f}")
        out.append(f"| {i * BIN + 1}-{(i + 1) * BIN} | {len(rs)} | " + " | ".join(cells) + " |")
    # where the meat is: cumulative share of notable events by round, over runs that reached 60+
    for horizon in (60, 100):
        rs = [m for m in runs if m["rounds"] >= horizon]
        if not rs:
            continue
        allr = [r for m in rs for r in m["notable_rounds"] if r <= horizon]
        kills_r = [k["round"] for m in rs for k in m["kills"] if k["round"] <= horizon]
        if allr:
            cum = " · ".join(f"by r{c}: {sum(1 for r in allr if r <= c) / len(allr):.0%}" for c in (10, 20, 30, 40, 50, 60, 80) if c <= horizon)
            out.append(f"\nNotable events (hits, messages, transfers, skills) in rounds 1-{horizon}, cumulative ({len(rs)} runs): {cum}")
        if kills_r:
            cum = " · ".join(f"by r{c}: {sum(1 for r in kills_r if r <= c) / len(kills_r):.0%}" for c in (20, 30, 40, 50, 60, 80) if c <= horizon)
            out.append(f"Kills in rounds 1-{horizon}, cumulative: {cum} (n={len(kills_r)})")
    # nature
    nat = defaultdict(list)
    for m in runs:
        for r, v in m["nature"].items():
            nat[r].append(v)
    if nat:
        out.append("\n**Nature** (mean over runs): " + " · ".join(f"r{r}: {statistics.mean(v[0] for v in vals):.0f} trees, {statistics.mean(v[1] for v in vals):.0f} ripe fruit" for r, vals in sorted(nat.items())))
    # examples
    out.append("\n**Examples** (run · turn · agents · map point):\n")
    for m in runs:
        for k in m["kills"]:
            tag = "one blow" if k["one_blow"] else "after a hunt"
            vk = " — victim kills its attacker" if k in m["victim_kills_attacker"] else ""
            out.append(f"- KILL ({tag}{vk}): `{m['name']}` · `{k['turn']}` · {k['killer']} kills {k['victim']} · killer at {fmt_pos(k['pos'])}, victim at {fmt_pos(k['victim_pos'])} · \"{k['thought'][:160]}\"")
    for m in runs:
        for x, y in m["trades"]:
            out.append(f"- TRADE: `{m['name']}` · `{x[1]}` then `{y[1]}` · {x[2]} gives {x[5]} {x[4]} to {x[3]}, {y[2]} gives back {y[5]} {y[4]} · at {fmt_pos(pos_at(m['rd'], x[1], x[2]))}")
        for g in m["gifts"]:
            out.append(f"- GIFT: `{m['name']}` · `{g[1]}` · {g[2]} gives {g[5]} {g[4]} to {g[3]} · at {fmt_pos(pos_at(m['rd'], g[1], g[2]))}")
        for p, a in m["answered_pleas"][:3]:
            out.append(f"- ANSWERED PLEA: `{m['name']}` · plea `{p[1]}` ({p[2]} → {p[3]}: \"{p[4][:90]}\") · answer `{a[1]}` by {a[2]} · at {fmt_pos(pos_at(m['rd'], p[1], p[2]))}")
        for x, y in m["pacts"][:3]:
            out.append(f"- PEACE PROPOSAL ANSWERED: `{m['name']}` · `{x[1]}` {x[2]} → {x[3]}, reply `{y[1]}` · at {fmt_pos(pos_at(m['rd'], x[1], x[2]))} · \"{x[4][:90]}\"")
        for s in m["saves"][:3]:
            out.append(f"- SKILL: `{m['name']}` · `{s[1]}` · {s[2]} saves `{s[3]}` · at {fmt_pos(pos_at(m['rd'], s[1], s[2]))}")
    return "\n".join(out), runs


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[0] == "run":
        m = analyse(a[1])
        slim = {k: v for k, v in m.items() if k not in ("msgs", "transfers_list", "notable_rounds", "rd")}
        print(json.dumps(slim, indent=1, default=str)[:6000])
    elif a[0] == "group":
        text, _ = group(a[1], a[2:])
        print(text)
