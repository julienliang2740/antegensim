"""Compact checkpoint view: one block per tag with totals and the last-10-round activity."""
# DOCS: prints a compact checkpoint view of sweep runs (tags from sweep/registry.json).
import sys, json
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import sweep
reg = sweep.read_registry()["runs"]
for tag in sys.argv[1:]:
    m = sweep.metrics(tag, reg[tag], 3)
    lc = m["living_curve_every5"]
    print(f"== {tag} {m['name'][len('SWEEP-'+tag)+1:]}: r{m['round']}/{m['max_rounds']} living {m['living_now']}/{m['agents']} curve {' '.join(f'{k}:{v}' for k,v in lc.items())}")
    print(f"   deaths {m['death_causes']} rounds {m['death_rounds'][-8:]} | hits {m['attack_hits']} kills {m['kills']} attackers {m['distinct_attackers']} | skill% {int(100*m['via_skill_share'])} runs {m['skill_runs_started']} saved {m['skills_saved']} | msgs {m['messages_ok']} by {m['distinct_messengers']} | transfers {m['transfers_ok']} | upg {m['upgrades']} | skips {m['resource_skips']} | ${m['provider_cost_usd']}")
    print(f"   last10: {m['recent10_rounds_actions']}")
    for s in (m["sample_messages"][-2:] + m["sample_attacks"][-1:]):
        print("   >", s[:170])
