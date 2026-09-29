#!/usr/bin/env python3
"""Compare runs on activity and communication over their first N rounds.

Usage: senses_compare.py <N> <label>=<TAG|run_id>[,<TAG>...] ...
Each label is a group (e.g. baseline=FG100A,FG100B ...). Prints per-group means per run.
"""
import statistics, sys
sys.path.insert(0, "/home/ubuntu/antegensim/sweep/tools/showcase")
from exp_metrics import analyse

N = int(sys.argv[1])
cols = [("rounds", lambda m: m["rounds"]),
        ("messages", lambda m: m["messages"]), ("senders", lambda m: m["senders"]), ("talk pairs", lambda m: m["talk_pairs"]),
        ("replies", lambda m: m["replies"]), ("pleas", lambda m: m["pleas"]), ("answered", lambda m: len(m["answered_pleas"])),
        ("offers", lambda m: m["offers"]), ("pacts", lambda m: len(m["pacts"])), ("gifts+trades", lambda m: len(m["gifts"]) + len(m["trades"])),
        ("observes", lambda m: m["observes"]), ("points seen", lambda m: m["points_observed"]), ("others seen", lambda m: m["others_seen"]),
        ("queries", lambda m: m["queries"]), ("moves", lambda m: m["moves"]), ("hits", lambda m: m["hits"]), ("kills", lambda m: len(m["kills"])),
        ("skill writers", lambda m: m["writers"]), ("broke", lambda m: m["broke"]), ("fruit", lambda m: m["fruit_eaten"]),
        ("alive", lambda m: m["alive"].get(N) or m["alive"].get(max(m["alive"]) if m["alive"] else 0)), ("cost $", lambda m: m["cost"])]
print(f"Means per run over rounds 1-{N}")
print("| group | runs | " + " | ".join(c for c, _ in cols) + " |")
print("|" + "---|" * (len(cols) + 2))
for arg in sys.argv[2:]:
    label, refs = arg.split("=", 1)
    ms = [analyse(r, max_round=N) for r in refs.split(",")]
    cells = [f"{statistics.mean(f(m) for m in ms):.1f}" for _, f in cols]
    print(f"| {label} | {len(ms)} | " + " | ".join(cells) + " |")
