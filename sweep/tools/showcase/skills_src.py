#!/usr/bin/env python3
"""Print every saved skill of a run (latest end snapshot) as one compact line: agent, name, params, source."""
import glob, json, sys
reg = json.load(open("/home/ubuntu/antegensim/sweep/registry.json"))["runs"]
rid = reg[sys.argv[1]]["run_id"] if sys.argv[1] in reg else sys.argv[1]
rd = glob.glob(f"/home/ubuntu/antegensim/worlds/*/runs/{rid}")[0]
last = sorted(glob.glob(rd + "/turns/r*_end"))[-1]
for f in sorted(glob.glob(last + "/entities/agents/*.json")):
    s = json.load(open(f))
    for n, sk in (s.get("skills") or {}).items():
        src = " | ".join(l.strip() for l in sk.get("source", "").splitlines() if l.strip())
        print(f"{s['id']} {'alive' if s.get('alive') else 'dead'} {n}({', '.join(sk.get('params') or [])}) r{sk.get('saved_round')}: {src[:int(sys.argv[2]) if len(sys.argv) > 2 else 400]}")
