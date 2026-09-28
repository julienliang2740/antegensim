#!/usr/bin/env python3
"""Compare fork branches with their source run over the same round window.

Usage: fork_compare.py <source_run_id> <from_round> <to_round> <branch TAG|run_id> ...
For the source and every branch, lists the hits, kills, transfers and answered pleas in rounds
from_round+1..to_round, then says which of the source's attack pairs and kills recur in each branch.
"""
import sys
sys.path.insert(0, "/home/ubuntu/antegensim/sweep/tools/showcase")
from exp_metrics import analyse, fmt_pos, pos_at

src, r0, r1 = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
branches = sys.argv[4:]


def window(m):
    hits = [h for h in m.get("hit_list", []) if r0 < h[0] <= r1]
    kills = [k for k in m["kills"] if r0 < k["round"] <= r1]
    trades = [t for t in m["trades"] if r0 < t[0][0] <= r1]
    gifts = [g for g in m["gifts"] if r0 < g[0] <= r1]
    pleas = [p for p in m["answered_pleas"] if r0 < p[0][0] <= r1]
    msgs = [x for x in m["msgs"] if r0 < x[0] <= r1]
    return hits, kills, trades, gifts, pleas, msgs


base = analyse(src)
bh, bk, bt, bg, bp, bm = window(base)
base_pairs = {(h[2], h[3]) for h in bh}
base_kills = {(k["killer"], k["victim"]) for k in bk}
print(f"SOURCE {base['name']} rounds {r0 + 1}-{r1}: attack pairs {sorted(base_pairs)}, kills {sorted(base_kills)}, "
      f"trades {len(bt)}, gifts {len(bg)}, answered pleas {len(bp)}, messages {len(bm)}")
rows = []
for ref in branches:
    m = analyse(ref)
    h, k, t, g, p, ms = window(m)
    pairs = {(x[2], x[3]) for x in h}
    kills = {(x["killer"], x["victim"]) for x in k}
    same_pairs = pairs & base_pairs
    same_kills = kills & base_kills
    attackers_again = {a for a, _ in base_pairs} & {a for a, _ in pairs}
    rows.append((m, h, k, t, g, p, ms, same_pairs, same_kills, attackers_again))
    print(f"\nBRANCH {m['name']} (reached r{m['rounds']}): {len(h)} hits, {len(k)} kills, {len(t)} trades, {len(g)} gifts, "
          f"{len(p)} answered pleas, {len(ms)} messages")
    print(f"  same attack pairs as the source: {sorted(same_pairs)}; same kills: {sorted(same_kills)}; source attackers attacking again: {sorted(attackers_again)}")
    for x in k:
        print(f"  KILL `{x['turn']}` {x['killer']} -> {x['victim']} at {fmt_pos(x['pos'])} ({'one blow' if x['one_blow'] else 'after a hunt'}): \"{x['thought'][:140]}\"")
    for x in sorted(pairs - base_pairs):
        first = min(y for y in h if (y[2], y[3]) == x)
        print(f"  new attack pair {x[0]} -> {x[1]}, first hit `{first[1]}` at {fmt_pos(pos_at(m['rd'], first[1], x[0]))}")
    for a_, b_ in t:
        print(f"  TRADE `{a_[1]}` / `{b_[1]}` {a_[2]} <-> {a_[3]}")
    for x in g:
        print(f"  GIFT `{x[1]}` {x[2]} -> {x[3]} {x[5]} {x[4]}")
n = len(rows)
if n:
    print(f"\nSUMMARY over {n} branches:")
    for pair in sorted(base_pairs):
        c = sum(1 for r in rows if pair in {(x[2], x[3]) for x in r[1]})
        print(f"  source attack {pair[0]} -> {pair[1]} happened again in {c}/{n} branches")
    for pair in sorted(base_kills):
        c = sum(1 for r in rows if pair in r[8])
        print(f"  source kill {pair[0]} -> {pair[1]} happened again in {c}/{n} branches")
    print(f"  branches with at least one kill: {sum(1 for r in rows if r[2])}/{n}; with any hit: {sum(1 for r in rows if r[1])}/{n}; "
          f"with a trade or gift: {sum(1 for r in rows if r[3] or r[4])}/{n}; with an answered plea: {sum(1 for r in rows if r[5])}/{n}")
