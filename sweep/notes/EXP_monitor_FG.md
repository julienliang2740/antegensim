# FG monitor log

Baseline: run_20260927_221309_cc43. Rule: at most 4 FG runs live at once.

## Launch queue
1. FG100B - 7102, 100 rounds, backend 30
2. FG60A - 7161, 60 rounds, backend 20
3. FG60B - 7162, 60 rounds, backend 20
4. FG60C - 7163, 60 rounds, backend 20 (launch when a slot frees)
5. FG60D - 7164, 60 rounds, backend 20 (launch when next slot frees)

## Log

- 2026-09-28 06:06: FG100A already live at start (run_20260928_060618_0cd6, :8001, running, r00003 living 32).
- 2026-09-28 06:07: launched FG100B -> run_20260928_060751_d161 on :8002 (seed 7102, 100 rounds, $30 guard).
- 2026-09-28 06:08: launched FG60A -> run_20260928_060835_f750 on :8001 (seed 7161, 60 rounds, $20 guard).
- 2026-09-28 06:08: launched FG60B -> run_20260928_060858_01a1 on :8002 (seed 7162, 60 rounds, $20 guard).
- 4 slots now full: FG100A, FG100B, FG60A, FG60B all running. FG60C, FG60D queued, waiting for a slot to free.
- 06:49: FG100B error #1 at r00031_t13_a05 (provider failure: error), watchdog auto-resumed (play -> 200) immediately. Single transient error, no pattern. No action taken.
- Noted: FGF1-FGF4 ("Five Groves · fork at round 17") appeared on :8003, matching "FG" prefix in status/wait output but NOT launched by me and not in my queue. Leaving them alone, not counting them against my 4-slot budget.
- 07:36: FG60A and FG60B both finished at round 60 (run_20260928_060835_f750 living 16; run_20260928_060858_01a1 living 18). Two slots freed.
- 07:36: launched FG60C -> run_20260928_073632_b792 on :8001 (seed 7163, 60 rounds, $20 guard).
- 07:36: launched FG60D -> run_20260928_073641_831d on :8002 (seed 7164, 60 rounds, $20 guard).
- All 6 FG runs now launched: FG100A, FG100B, FG60A(done), FG60B(done), FG60C, FG60D. Waiting for remaining 4 (FG100A, FG100B, FG60C, FG60D) to finish.
- 08:24 UTC: watchdog log showed repeated "provider failure: error" (10-11 in a row) across FG100A, FG100B, FG60C, FG60D (and other monitors' tags too). Checked pending_model_calls JSON for run_20260928_073641_831d (FG60D): error_code "rate_limited", text "You've hit your session limit · resets 10:10am (UTC)". This is the session-limit case.
- 08:25 UTC: parked all 4 live runs per instructions: FG100A (:8001), FG100B (:8002), FG60C (:8001), FG60D (:8002). Waiting until reset time 10:10am UTC, then will resume each on its SAME port.
- 10:12-10:13 UTC: team lead resumed all 4 runs directly (FG100A :8001, FG100B :8002, FG60C :8001, FG60D :8002) - confirmed via watchdog.log "reopened" lines and status showing turn_active/waiting_model with no errors. I did not resume them myself (lead beat me to it). Continuing to monitor toward completion.
- 10:30 UTC: FG100B finished at r00100_end (run_20260928_060751_d161, living 15). FG100A at r96/100, FG60C at r40/60, FG60D at r37/60.
- 10:40 UTC: FG100A finished at r00100_end (run_20260928_060618_0cd6, living 16). Remaining: FG60C (r43/60), FG60D (r42/60).
- ~11:05 UTC: FG60C and FG60D both finished at r00060_end. ALL 6 FG RUNS FINISHED.

## Final summary

| Tag | Run id | Rounds reached | Final state | Living | Cost (provider_cost_usd) |
| --- | --- | --- | --- | --- | --- |
| FG100A | run_20260928_060618_0cd6 | 100 | finished | 16 | $21.747 |
| FG100B | run_20260928_060751_d161 | 100 | finished | 15 | $16.888 |
| FG60A | run_20260928_060835_f750 | 60 | finished | 16 | $13.738 |
| FG60B | run_20260928_060858_01a1 | 60 | finished | 18 | $14.386 |
| FG60C | run_20260928_073632_b792 | 60 | finished | 17 | $14.686 |
| FG60D | run_20260928_073641_831d | 60 | finished | 17 | $14.426 |

Errors/parking: one Claude CLI session-limit event (resets 10:10am UTC) hit all 4 then-live FG runs (FG100A, FG100B, FG60C, FG60D) around 08:24 UTC. Parked all 4 at 08:25 UTC. Team lead resumed all 4 on their same ports at 10:12-10:13 UTC (I did not resume them myself). No budget errors seen on any FG run. One earlier isolated transient "provider failure: error" on FG100B (06:49) and FG60D (10:20), each auto-resumed by the watchdog within seconds, no pattern.
