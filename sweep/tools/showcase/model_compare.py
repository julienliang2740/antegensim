#!/usr/bin/env python3
"""Model comparison metrics (manual_lab/2026-09-29_model_comparison.md), read from saved run folders only.

For each run (registry TAG or run id) and an optional round window it reports:
  * adherence: decision attempts (decision + decision_invalid events), invalid decisions and their
    causes (bucketed from the reason and the raw text excerpt), world-rejected actions by reason;
  * price: provider_cost_usd summed over the window's model calls, tokens in / out per call;
  * speed: per-call latency (first-attempt ok calls) and wall-clock seconds per round (round_ended to round_ended);
    gaps over STALL_SECONDS (parking, session limits) are counted as stalls and left out of the total;
  * infra: failed calls that were not the model's fault (rate limits, timeouts, session limits);
  * behaviour: exp_metrics.analyse over the same window plus the action mix and thought length.

Usage:
  model_compare.py run <TAG|run_id> [min_round] [max_round] [--json]
  model_compare.py table <min_round> <max_round> <TAG> ...      one markdown row per run
  model_compare.py invalid <TAG> ... [--examples N]              invalid-decision causes with examples
"""
import glob, json, re, statistics, sys
from collections import Counter
from datetime import datetime

sys.path.insert(0, "/home/ubuntu/antegensim/sweep/tools/showcase")
import exp_metrics as X

STALL_SECONDS = 600


def cause(reason, raw):
    """Bucket one invalid decision by what the model did wrong."""
    r, t = reason or "", raw or ""
    if "truncated" in r:
        return "truncated (output-token cap)"
    if "refus" in r:
        return "refusal"
    if "/action: must have required property 'name'" in r and '"action": {"thought"' in t.replace(" ", "").replace('"action":{"thought"', '"action": {"thought"'):
        return "whole decision nested inside action"
    if "/action: must have required property 'name'" in r:
        return "action object without name/args"
    if re.search(r"additional properties \('(output|value|decision|response|result)'", r):
        return "decision wrapped in an extra key"
    if "must have required property 'action'" in r:
        return "no action field"
    if "not valid JSON" in r or "no JSON" in r or "could not parse" in r.lower() or "json" in r.lower() and "decode" in r.lower():
        return "not JSON / unparseable"
    if "enum" in r or "must be equal to one of" in r or "unknown action" in r.lower():
        return "unknown action name or enum value"
    if "args" in r:
        return "wrong action arguments"
    return "other: " + re.sub(r"\s+", " ", r)[:90]


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def pct(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))]


def calls(rd, lo, hi):
    """Decision model-call records in the round window."""
    out = []
    for f in glob.glob(f"{rd}/turns/*/model_calls/mc_*.json"):
        try:
            c = json.load(open(f))
        except Exception:
            continue
        if c.get("purpose", "decision") != "decision" or not (lo <= c.get("round", 0) <= hi):
            continue
        out.append(c)
    return out


def metrics(ref, lo=1, hi=10**6):
    rid = X.resolve(ref)
    rd = X.run_dir(rid)
    evs = []
    for f in sorted(glob.glob(f"{rd}/turns/*/events.json")):
        try:
            evs += json.load(open(f))
        except Exception:
            pass
    evs = [e for e in evs if lo <= e["round"] <= hi]
    ends = sorted((e["round"], ts(e["timestamp"])) for e in evs if e["kind"] == "round_ended")
    starts = {e["round"]: ts(e["timestamp"]) for e in evs if e["kind"] == "round_started"}
    durs, stalls = [], 0
    for r, t in ends:
        s = starts.get(r)
        if s is None:
            continue
        d = t - s
        if d > STALL_SECONDS:
            stalls += 1
        else:
            durs.append(d)
    decisions = sum(1 for e in evs if e["kind"] == "decision")
    invalid = [e for e in evs if e["kind"] == "decision_invalid"]
    causes = Counter(cause(e["details"].get("reason"), e["details"].get("raw_text_excerpt")) for e in invalid)
    rejected, acts, thoughts = Counter(), Counter(), []
    notebook = priorities = 0
    for e in evs:
        d = e.get("details") or {}
        if e["kind"] == "action":
            acts[d["action"]["name"]] += 1
            if not d["result"].get("ok"):
                rejected[f"{d['action']['name']}:{d['result'].get('reason')}"] += 1
        elif e["kind"] == "decision":
            thoughts.append(len(str(d.get("thought") or "")))
            notebook += bool(d.get("notebook_updated"))
            priorities += bool(d.get("memory_priorities"))
    cs = calls(rd, lo, hi)
    ok = [c for c in cs if (c.get("result") or {}).get("ok")]
    # first-attempt successes only: a retried call's latency includes backoff and rate-limit waits
    lat = [c["result"]["latency_ms"] / 1000 for c in ok if c["result"].get("latency_ms") and c["result"].get("attempts", 1) == 1]
    http429 = sum(sum(1 for x in (c.get("result") or {}).get("attempt_errors") or [] if "429" in str(x)) for c in cs)
    usage = [c["result"].get("usage") or {} for c in cs if c.get("result")]
    infra = Counter()
    for c in cs:
        res = c.get("result") or {}
        if res.get("status") in ("error", "timeout", "rate_limited", "invalid_config") or res.get("error_code") in ("rate_limited", "timeout"):
            err = str(res.get("error") or "")
            infra["session limit" if "session limit" in err else (res.get("error_code") or res.get("status"))] += 1
    retried = sum(1 for c in cs if (c.get("result") or {}).get("attempts", 1) > 1)
    cost = sum(float((c.get("result") or {}).get("provider_cost_usd") or 0) for c in cs)
    beh = X.analyse(rid, max_round=hi if hi < 10**6 else None, min_round=lo if lo > 1 else None)
    rounds = len(ends)
    attempts = decisions + len(invalid)
    return {
        "tag": ref, "rid": rid, "name": beh["name"], "window": (lo, min(hi, beh["rounds"])), "rounds": rounds,
        "attempts": attempts, "invalid": len(invalid), "invalid_rate": len(invalid) / attempts if attempts else 0,
        "causes": dict(causes.most_common()), "rejected": sum(rejected.values()), "rejected_rate": sum(rejected.values()) / max(1, sum(acts.values())),
        "rejected_reasons": dict(rejected.most_common(8)), "cost": cost, "cost_per_round": cost / rounds if rounds else 0,
        "calls": len(cs), "retried": retried, "http429": http429, "infra": dict(infra),
        "in_tok": statistics.mean([u.get("billed_input_tokens", 0) for u in usage]) if usage else 0,
        "out_tok": statistics.mean([u.get("output_tokens", 0) for u in usage]) if usage else 0,
        "lat_p50": pct(lat, 0.5), "lat_p90": pct(lat, 0.9), "lat_mean": statistics.mean(lat) if lat else None,
        "round_s_median": statistics.median(durs) if durs else None, "active_s": sum(durs), "stalls": stalls,
        "actions": dict(acts.most_common()), "thought_chars": statistics.mean(thoughts) if thoughts else 0,
        "notebook_share": notebook / decisions if decisions else 0, "priorities_share": priorities / decisions if decisions else 0,
        "beh": {k: beh[k] for k in ("alive", "deaths", "hits", "attackers", "messages", "senders", "replies", "pleas", "transfers",
                                     "writers", "skills_saved", "skill_runs", "skill_share", "observes", "queries", "moves",
                                     "fruit_eaten", "broke", "think_share", "others_seen", "talk_pairs")} | {"kills": len(beh["kills"])},
    }


def f(x, n=1):
    return "–" if x is None else f"{x:.{n}f}"


def table(lo, hi, refs):
    print("| Run | Window | Rounds | Attempts | Invalid (rate) | Rejected actions | Cost $ | $/round | In / out tok | Latency p50 / p90 s | Round s (median) | Active min | Stalls | HTTP 429 | Infra failures |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in refs:
        m = metrics(r, lo, hi)
        print(f"| {m['tag']} | r{m['window'][0]}-{m['window'][1]} | {m['rounds']} | {m['attempts']} | {m['invalid']} ({m['invalid_rate']:.1%}) | "
              f"{m['rejected']} ({m['rejected_rate']:.1%}) | {m['cost']:.3f} | {m['cost_per_round']:.4f} | {m['in_tok']:.0f} / {m['out_tok']:.0f} | "
              f"{f(m['lat_p50'])} / {f(m['lat_p90'])} | {f(m['round_s_median'], 0)} | {m['active_s'] / 60:.1f} | {m['stalls']} | {m['http429']} | {m['infra'] or '–'} |")


def invalid_report(refs, n_examples):
    for r in refs:
        rid = X.resolve(r)
        rd = X.run_dir(rid)
        ex = {}
        cnt = Counter()
        for fn in sorted(glob.glob(f"{rd}/turns/*/events.json")):
            for e in json.load(open(fn)):
                if e["kind"] != "decision_invalid":
                    continue
                c = cause(e["details"].get("reason"), e["details"].get("raw_text_excerpt"))
                cnt[c] += 1
                ex.setdefault(c, []).append((e["turn_id"], e["details"].get("reason", "")[:260], (e["details"].get("raw_text_excerpt") or "")[:260]))
        print(f"## {r} ({rid}): {sum(cnt.values())} invalid")
        for c, k in cnt.most_common():
            print(f"- {c}: {k}")
            for t, reason, raw in ex[c][:n_examples]:
                print(f"    {t}: {reason}\n      raw: {raw}")


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[0] == "run":
        lo = int(a[2]) if len(a) > 2 and a[2].isdigit() else 1
        hi = int(a[3]) if len(a) > 3 and a[3].isdigit() else 10**6
        print(json.dumps(metrics(a[1], lo, hi), indent=1, default=str))
    elif a[0] == "table":
        table(int(a[1]), int(a[2]), a[3:])
    elif a[0] == "invalid":
        n = int(a[a.index("--examples") + 1]) if "--examples" in a else 2
        invalid_report([x for x in a[1:] if not x.startswith("--") and not x.isdigit()], n)
