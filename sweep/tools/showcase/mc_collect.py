#!/usr/bin/env python3
"""Collect every number for manual_lab/2026-09-29_model_comparison.md into one JSON (stdout).

Measured: Haiku and GPT-6 Luna trunks (r1-25) and forks (r26-45); DeepSeek V4 Flash trunks as far as
they were played inside the deployment quota.  Extrapolated (DeepSeek only): the full design
(2 trunks x 25 rounds + 4 forks x 20 rounds) from DeepSeek's measured r1-15 per-round numbers scaled
by the growth that Haiku and Luna showed between r1-15 and r16-25 / r26-45 in the same setups.
"""
import json, statistics, sys
sys.path.insert(0, "/home/ubuntu/antegensim/sweep/tools/showcase")
import model_compare as M

MODELS = {"HAIKU": "claude-cli-haiku", "LUNA": "azure-gpt6-luna", "DSV4": "azure-deepseek-v4-flash"}
BASES = {"FG": "Five Groves", "TT": "Two to a Tree"}


def slim(m):
    lat_mean = m["lat_mean"] or 0
    per_round = m["attempts"] / m["rounds"] if m["rounds"] else 0
    return {k: m[k] for k in ("tag", "rid", "name", "window", "rounds", "attempts", "invalid", "invalid_rate", "causes", "rejected",
                               "rejected_rate", "rejected_reasons", "cost", "cost_per_round", "calls", "retried", "http429", "infra",
                               "in_tok", "out_tok", "lat_p50", "lat_p90", "lat_mean", "round_s_median", "active_s", "stalls",
                               "actions", "thought_chars", "notebook_share", "priorities_share", "beh")} | {
        "attempts_per_round": per_round, "model_s_per_round": per_round * lat_mean}


out = {"runs": {}, "windows": {}}
for mk in MODELS:
    for b in BASES:
        trunk = f"MC-{b}-{mk}"
        out["runs"][trunk] = slim(M.metrics(trunk, 1, 25))
        for w in ((1, 15), (16, 25)):
            out["windows"][f"{trunk}:{w[0]}-{w[1]}"] = slim(M.metrics(trunk, *w))
        if mk != "DSV4":
            for f in ("A", "B"):
                out["runs"][f"{trunk}-{f}"] = slim(M.metrics(f"{trunk}-{f}", 26, 45))
# DeepSeek inside the quota only (rounds after the 04:08 restart at concurrency 1; round 5 straddles it)
out["windows"]["MC-FG-DSV4:6-15"] = slim(M.metrics("MC-FG-DSV4", 6, 15))
tt_last = out["runs"]["MC-TT-DSV4"]["rounds"]
if tt_last >= 6:
    out["windows"][f"MC-TT-DSV4:6-{tt_last}"] = slim(M.metrics("MC-TT-DSV4", 6, tt_last))

# growth factors from the fully measured models: per-round cost and tokens, later window / r1-15
growth = {}
for mk in ("HAIKU", "LUNA"):
    for b in BASES:
        base = out["windows"][f"MC-{b}-{mk}:1-15"]
        mid = out["windows"][f"MC-{b}-{mk}:16-25"]
        late = [out["runs"][f"MC-{b}-{mk}-{f}"] for f in ("A", "B")]
        growth[f"{mk}-{b}"] = {
            "cost_16_25": mid["cost_per_round"] / base["cost_per_round"],
            "cost_26_45": statistics.mean(x["cost_per_round"] for x in late) / base["cost_per_round"],
            "in_16_25": mid["in_tok"] / base["in_tok"], "in_26_45": statistics.mean(x["in_tok"] for x in late) / base["in_tok"],
            "calls_26_45": statistics.mean(x["attempts_per_round"] for x in late) / base["attempts_per_round"],
            "inv_26_45_minus_1_25": statistics.mean(x["invalid_rate"] for x in late) - out["runs"][f"MC-{b}-{mk}"]["invalid_rate"],
        }
out["growth"] = growth
g16 = statistics.mean(v["cost_16_25"] for v in growth.values())
g26 = statistics.mean(v["cost_26_45"] for v in growth.values())
lo16, hi16 = min(v["cost_16_25"] for v in growth.values()), max(v["cost_16_25"] for v in growth.values())
lo26, hi26 = min(v["cost_26_45"] for v in growth.values()), max(v["cost_26_45"] for v in growth.values())
fg = out["windows"]["MC-FG-DSV4:1-15"]
tt = out["runs"]["MC-TT-DSV4"]
ds_cpr = (fg["cost"] + tt["cost"]) / (fg["rounds"] + tt["rounds"])  # measured $/round, all DeepSeek rounds
ds_calls = fg["attempts"] + tt["attempts"]
ds_inv = fg["invalid"] + tt["invalid"]
q = out["windows"]["MC-FG-DSV4:6-15"]


def design_cost(cpr, a, b):
    return 2 * cpr * (15 + 10 * a) + 4 * cpr * 20 * b


out["extrapolation"] = {
    "ds_measured_rounds": fg["rounds"] + tt["rounds"], "ds_measured_attempts": ds_calls, "ds_measured_invalid": ds_inv,
    "ds_cost_per_round_r1_15": ds_cpr, "growth_cost_16_25": [g16, lo16, hi16], "growth_cost_26_45": [g26, lo26, hi26],
    "ds_cost_per_round_16_25": ds_cpr * g16, "ds_cost_per_round_26_45": ds_cpr * g26,
    "ds_design_cost": design_cost(ds_cpr, g16, g26), "ds_design_cost_range": [design_cost(ds_cpr, lo16, lo26), design_cost(ds_cpr, hi16, hi26)],
    "ds_invalid_upper95": 3.0 / ds_calls if ds_inv == 0 else None,  # rule of three
    "ds_quota_round_s_median": q["round_s_median"], "ds_quota_tokens_per_round": q["attempts_per_round"] * (q["in_tok"] + q["out_tok"]),
    "ds_model_s_per_round": q["model_s_per_round"],
}
for mk in ("HAIKU", "LUNA"):
    runs = [out["runs"][f"MC-{b}-{mk}"] for b in BASES] + [out["runs"][f"MC-{b}-{mk}-{f}"] for b in BASES for f in "AB"]
    out[f"design_{mk}"] = {"cost": sum(r["cost"] for r in runs), "rounds": sum(r["rounds"] for r in runs),
                           "attempts": sum(r["attempts"] for r in runs), "invalid": sum(r["invalid"] for r in runs),
                           "active_min": sum(r["active_s"] for r in runs) / 60}
print(json.dumps(out, indent=1, default=str))
