"""Markdown table of every SWEEP run (not smoke tests) with the key interest metrics."""
# DOCS: prints the markdown results table of every SWEEP run used in sweep/REPORT.md.
import sys
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import sweep
sweep.call = lambda *a, **k: (0, "n/a")
reg = sweep.read_registry()["runs"]
print("| Run name | Run id | Status | Rounds | Alive at end | Kills (attackers) | Starved | Messages (senders) | Transfers | Skill actions | Upgrades | Cost $ |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|")
total = 0.0
for t, e in sorted(reg.items()):
    if t.startswith("Z"):
        continue
    m = sweep.metrics(t, e, 0)
    total += m["provider_cost_usd"]
    dc = m["death_causes"]
    print(f"| `{e['name']}` | `{e['run_id']}` | {e['status']} | {m['round']} | {m['living_now']}/{m['agents']} | {m['kills']} ({m['distinct_attackers']}) | {dc.get('starvation', 0)} | {m['messages_ok']} ({m['distinct_messengers']}) | {m['transfers_ok']} | {int(100 * m['via_skill_share'])}% | {sum(m['upgrades'].values())} | {m['provider_cost_usd']:.2f} |")
print(f"\nTotal agent model cost over these runs (CLI-reported): ${total:.2f}")
