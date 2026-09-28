# TT monitor log (Two to a Tree clones of run_20260928_034839_c3c2)

Queue:
1. TT100A seed 8101, 100 rounds, $25
2. TT100B seed 8102, 100 rounds, $25
3. TT60A seed 8161, 60 rounds, $15
4. TT60B seed 8162, 60 rounds, $15
5. TT60C seed 8163, 60 rounds, $15 (launch when a slot frees)
6. TT60D seed 8164, 60 rounds, $15 (launch when a slot frees)

## Launches
- 2026-09-28 06:07:11 TT100A -> run_20260928_060711_1118 on :8002
- 2026-09-28 06:07:16 TT100B -> run_20260928_060716_d5cd on :8001
- 2026-09-28 06:07:21 TT60A  -> run_20260928_060721_66b3 on :8002
- 2026-09-28 06:07:25 TT60B  -> run_20260928_060725_1bbc on :8001

All 4 initial slots filled. Waiting for one to finish before launching TT60C.

## Status checks

## Errors / parking
- 2026-09-28 07:07:49 TT60A single provider failure at r00044_t20_a14, watchdog auto-resumed (play -> 200) at 07:07:53. No pattern, no action taken.

## Finishes
- 2026-09-28 ~07:35 TT60A finished at r00060_end, living 20, cost $15.367
- 2026-09-28 ~07:35 TT60B finished at r00060_end, living 22, cost $15.124

## Later launches
- 2026-09-28 07:43:34 TT60C -> run_20260928_074334_e857 on :8001 (slot freed by TT60A/B finishing)
- 2026-09-28 07:43:39 TT60D -> run_20260928_074339_cabc on :8002 (slot freed by TT60A/B finishing)

All 6 queued runs now launched: TT100A, TT100B (still running toward 100), TT60A, TT60B (finished), TT60C, TT60D (running).

## Observed but not mine
- TTF1, TTF2, TTF3, TTF4 (port :8003) appeared in the registry with "Two to a Tree · fork at round 14" names. Not part of my queue; not touched.
- TTF3 had a single transient provider failure at 07:56:12, auto-resumed. Not mine, no action.

## Status snapshot ~07:5x (from watchdog.log, before a Bash classifier hiccup)
All of TT100A, TT100B, TT60C, TT60D running clean, no errors logged for them since launch (except the single TT60A error already noted, and that run has since finished).

## Session limit hit — parked at 08:23 UTC
At ~08:22 UTC, watchdog.log showed repeated "provider failure: error" for TT100A, TT100B, TT60C,
TT60D (and other monitors' runs too — systemic, affecting both backends). Checked
pending_model_calls JSON for these runs: error text is
"claude CLI error (success): You've hit your session limit · resets 10:10am (UTC)".
This is the session-limit case from the runbook.

Progress at time of park (approx, from status just before parking):
- TT100A: run_20260928_060711_1118, round ~84, was on :8002
- TT100B: run_20260928_060716_d5cd, round ~84, was on :8001
- TT60C:  run_20260928_074334_e857, round ~23, was on :8001
- TT60D:  run_20260928_074339_cabc, round ~24, was on :8002

Parked all 4 at 08:23 UTC with reason "session limit":
- TT100A park -> close 200
- TT100B park -> close 200
- TT60C park -> close 200
- TT60D park -> close 200

Plan: wait until 10:10 UTC, then resume each on its SAME port:
- TT100A -> resume on :8002
- TT100B -> resume on :8001
- TT60C  -> resume on :8001
- TT60D  -> resume on :8002

## Lead intervened
- Lead raised TT60A/TT60B guard to $20 and TT100A/TT100B guard to $35 via god mode (after TT60A/B
  had already finished, so only TT100A/B affected going forward).
- Lead noted TT60C/TT60D were launched (by me, at 07:43, before lead's message) with the original
  $15 guard; lead said they'd raise those to $20 via god mode too.
- Lead resumed all 4 parked runs themselves (I did not resume any of them). Confirmed in
  watchdog.log: TT100A reopened :8002 at 10:12:35, TT100B reopened :8001 at 10:12:42, TT60C
  reopened :8001 at 10:13:12, TT60D reopened :8002 at 10:13:12 (slightly delayed vs TT100A/B but
  all 4 confirmed running again by 10:13:15).
- All 4 confirmed progressing again as of 10:13 UTC: TT100A r84, TT100B r84, TT60C r23, TT60D r24.

## More finishes
- 2026-09-28 10:29:06 UTC TT100B finished at r00100_end, living 8, cost $17.762
- 2026-09-28 10:24:51 TT60D single transient provider failure at r00030_t17_a20, watchdog auto-resumed at 10:24:54. No pattern, no action taken.
- 2026-09-28 10:36:08 UTC TT100A finished at r00100_end, living 14, cost $21.214

Only TT60C and TT60D remain running (both approaching round 60).

- 2026-09-28 11:08:53 UTC TT60D finished at r00060_end, living 23, cost $14.941 (note: guard was
  raised to $20 by lead but final cost came in under even the original $15).

Only TT60C remains (at r58/60 as of this check).

- 2026-09-28 (checked ~11:1x UTC) TT60C finished at r00060_end, living 25, cost $15.828

## ALL 6 TT RUNS FINISHED

| Tag | Run ID | Rounds reached | Final state | Living | Cost (provider_cost_usd) |
| --- | --- | --- | --- | --- | --- |
| TT100A | run_20260928_060711_1118 | 100 | finished | 14 | $21.214 |
| TT100B | run_20260928_060716_d5cd | 100 | finished | 8 | $17.762 |
| TT60A  | run_20260928_060721_66b3 | 60 | finished | 20 | $15.367 |
| TT60B  | run_20260928_060725_1bbc | 60 | finished | 22 | $15.124 |
| TT60C  | run_20260928_074334_e857 | 60 | finished | 25 | $15.828 |
| TT60D  | run_20260928_074339_cabc | 60 | finished | 23 | $14.941 |

No budget-cap errors on any run. Only anomaly: the systemic session-limit event at 08:23-10:13
UTC (parked all 4 then-live runs, lead resumed them once the limit reset before the scheduled
10:10 UTC wait completed). Two isolated single-occurrence transient provider-failure errors
(TT60A, TT60D), both auto-resumed by the watchdog, no pattern, no action needed.

