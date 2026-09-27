# Scenario sweep report (2026-09-27)

Search the run list in the UI for **`SWEEP-`** to find every run below; the name is
`SWEEP-<category><proposal>v<version> <title>` (for example `SWEEP-E7v2 Three clans blood feud`).
Scenario files: `sweep/scenarios/<tag>.json` (each has a `_design` note). Per-run judgements with
times: `sweep/registry.json` (`notes`). Category notes written by the first sub-agents:
`sweep/notes/`. Status before the engine rework: `sweep/notes/STATUS_before_async.md`.
Tool: `sweep/tools/sweep.py` (`status`, `metrics`, `dryrun`, `launch`, `watchdog`; `sweep/tools/table.py` prints the table below).

Models: Claude Code CLI Haiku 4.5 for almost every agent; Sonnet 5 for 2-3 agents in a few runs
(`claude-cli-sonnet`, prompted JSON, from `sweep/models.sweep.json`). Runs created before 06:50
UTC played their first rounds on the old one-agent-at-a-time engine and continued on the
simultaneous-rounds engine (A-SCHED-5); everything after was fully on the new engine. After the
operator's budget rule every run was capped at 80 rounds (most at 45-60) and judged at rounds 30-40.

## Top three

1. **`SWEEP-B2v2 Two tribes`** (attacks): two tribes of 15 met in the middle at round 19; 16 kills by
   12 different attackers spread over rounds 19-57, 46 hits, 27 messages of tribe coordination;
   10 of 30 alive at round 60. The richest story: a war of attrition with calls for help.
2. **`SWEEP-B1v1 Blood arena II`** (attacks): the no-food arena with the new attack cap. 17 kills by
   14 attackers spread over rounds 9-57 (no first-strike massacre), 2 attack_cap upgrades, 8 of 26
   survive at round 60.
3. **`SWEEP-E7v2 Three clans blood feud`** (balanced winner): three clans of six (two Sonnet chiefs)
   in a no-food valley with a triangle feud. 11 kills by 13 attackers spread over rounds 20-49,
   76% of actions from saved skills, 11 messages, 3 of 18 alive at round 50, for $1.74.

## Per category: the clear successes and the clear failures

| Category | Successful setups | Failed setups |
| --- | --- | --- |
| A. Skills | `SWEEP-A3v1 Guild of scripts`: 45 messages by 19 agents, trades, 9 skills saved, 111 skill runs (cooperation around skills; no deaths) | `SWEEP-A4v1`/`A4v2 Patrol and ambush` (patrols ran, 71% skill actions, never met: 0 messages, 0 attacks); `SWEEP-A1v1`/`A1v2 Orchard rows` (98% skill actions but zero interaction for 80 rounds); `SWEEP-A2v1`/`A2v2 Expensive minds` (the scripter-survives thesis held, nothing else happened) |
| B. Attacks | `SWEEP-B2v2 Two tribes`, `SWEEP-B1v1 Blood arena II`, `SWEEP-B4v2 Predators and prey` (11 kills, 20 messages by 11: herds warned each other), `SWEEP-B3v1 Bounty rush` (11 kills and an arms race: 9 upgrades of attack, attack cap and max health) | `SWEEP-B2v1`, `SWEEP-B4v1`: frozen agents from the input-cap lockout (setup bug, fixed in v2) |
| C. Movement | none | all five: `SWEEP-C1v1 Wide scatter`, `C2v1 Mountain maze`, `C3v1 Nomads`, `C4v1 Outward frontier`, `C4v2 Frontier rush`. Skills walked well (75-92% skill actions) but agents never met: 0 kills, at most 1 message; v2 found the food and then 3 starved quietly |
| D. Cooperation | `SWEEP-D1v1 Specialists` (35 messages by 13, 7 transfers, 5 absorption upgrades) and `SWEEP-D3v1 Seers and walkers` (38 messages by 12: seers sold locations) until round ~40 | the same two end in a quiet famine (15 starved each by round 50); `SWEEP-D2v1 Commons grove` (no crisis, no drama); `SWEEP-D4v1 The organiser` (25 messages, nothing followed) |
| E. Balanced | `SWEEP-E7v2 Three clans blood feud` (best), `SWEEP-E7v3 Three clans council of war` (8 kills, weaker talk) | every food-based one ended as a quiet starvation line: `SWEEP-E1v2 Frontier valley` (12 starved), `E2v2 Famine clock` (all 24 starved, 0 attacks), `E4v2 The tyrant` (12 starved, no uprising), `E5v2 Settlers meet wanderers` (11 wanderers starved in one wave), `E6v1 Crossroads` (10 starved, 0 attacks), `E6v2` (one skirmish, 8 starved); `E3v2 Three houses` (nothing by round 30); `E7v1 Three clans` (37 messages, 0 attacks, 17 starved) |

## What makes a setting interesting

* **Loot is the income.** Every run with sustained fighting had no food (or almost none), 100% of a
  dead agent's compute and essence left as loot and `compute_absorption` 1.0. Fights then pay.
* **A concrete first move.** Personas that name a first target and give the exact action JSON
  (`{"name":"run_skill","args":{"skill":"hunt","arguments":["a07",40]}}`) produced fights; the same
  world without it produced only talk (`E7v1`: 37 messages, 0 attacks, all starved).
* **Proven skills seeded at the start** (`hunt`, `loot`, `goto`/`step`, `harvest`, `gather`, `flee`):
  agents use them (50-98% of actions come from skills), which also makes runs cheap.
* **Agents can find and reach each other**: `query(id)` works map-wide, attacks reach within vision
  (2-3), maps are small (21x21 to 33x33) or the teams start converging.
* **Roles and teams that need each other** produce messages: tribes and clans (coordination), traders
  and seers (information for sale), specialists (trades).
* **The attack cap** (50 per hit) turned one-hit massacres into fights over several rounds with
  deaths spread across the run.

## What makes a setting fail

* **Food scarcity alone gives a quiet starvation line, not conflict.** An attack and a thought are
  paid in compute, so an agent that runs low can neither fight nor think (hundreds of
  `resource_skip`s). Hunger makes agents inert, not violent. This happened in every food world.
* **Big maps and vision-limited queries**: agents never meet (all movement runs).
* **Personas without a concrete action**: Haiku agents talk, wait and observe.
* **Autonomous skills suppress talk**: an agent running `hunt` makes no model calls, so it never
  writes a message. Interrupting skills on messages (`E7v3`) did not help, because nobody started a
  conversation.
* **The default `context.input_token_cap` 6000** with long personas freezes agents for good
  (`resource_skip` every turn): always set 10000.

## Engine findings for future work (not changed during the sweep)

* **Input-cap lockout**: when the mandatory packet part exceeds `input_token_cap`, the agent gets a
  `resource_skip` every turn and never recovers (its last result keeps the packet too big).
* **Output-cap errors stall runs**: an agent short of compute gets a generation allowance of about
  200-250 tokens; the Claude CLI then fails with "exceeded the 250 output token maximum", which the
  engine treats as a provider (infrastructure) failure, so the run enters `error` and retries the same
  turn. It should count as a truncated agent reply.
* **Backend memory grows on live runs**: fake-model runs stay flat (68 MB after 800 turns), but live
  backends reached 7 GB in 15-30 minutes and one was killed by the kernel at 11.8 GB. The automatic
  storybook narrator is one clear cause (a fake-narrator run grows super-linearly, 328 MB after 30
  rounds). The sweep watchdog restarted a backend above 7 GB.
* **Starving agents cannot think**, which is why famine is silent; a cheap last-resort decision
  would let hungry agents act.

## All runs

| Run name | Run id | Status | Rounds | Alive at end | Kills (attackers) | Starved | Messages (senders) | Transfers | Skill actions | Upgrades | Cost $ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `SWEEP-A1v1 Orchard rows` | `run_20260927_044620_3324` | finished | 80 | 16/16 | 0 (0) | 0 | 0 (0) | 0 | 98% | 0 | 0.49 |
| `SWEEP-A1v2 Orchard rows` | `run_20260927_052306_6149` | cut | 21 | 16/16 | 0 (0) | 0 | 0 (0) | 0 | 94% | 0 | 0.68 |
| `SWEEP-A2v1 Expensive minds` | `run_20260927_044621_060a` | cut | 73 | 12/13 | 0 (0) | 1 | 0 (0) | 0 | 91% | 0 | 1.00 |
| `SWEEP-A2v2 Expensive minds` | `run_20260927_053404_a472` | cut | 2 | 13/13 | 0 (0) | 0 | 1 (1) | 0 | 15% | 0 | 0.33 |
| `SWEEP-A3v1 Guild of scripts` | `run_20260927_044621_1cb1` | cut | 41 | 20/20 | 0 (1) | 0 | 45 (19) | 2 | 33% | 0 | 5.38 |
| `SWEEP-A4v1 Patrol and ambush` | `run_20260927_044622_a25c` | cut | 15 | 20/20 | 0 (0) | 0 | 0 (0) | 0 | 4% | 0 | 2.16 |
| `SWEEP-A4v2 Patrol and ambush` | `run_20260927_052406_faa6` | cut | 29 | 20/20 | 0 (0) | 0 | 0 (0) | 0 | 71% | 0 | 2.32 |
| `SWEEP-B1v1 Blood arena II` | `run_20260927_044748_5fd0` | finished | 60 | 8/26 | 17 (14) | 1 | 4 (4) | 0 | 66% | 2 | 3.25 |
| `SWEEP-B2v1 Two tribes` | `run_20260927_044751_6c7d` | cut | 8 | 30/30 | 0 (0) | 0 | 1 (1) | 0 | 29% | 0 | 1.24 |
| `SWEEP-B2v2 Two tribes` | `run_20260927_071445_7748` | finished | 60 | 10/30 | 16 (12) | 4 | 27 (6) | 0 | 47% | 0 | 7.59 |
| `SWEEP-B3v1 Bounty rush` | `run_20260927_045021_b1fc` | cut | 46 | 10/24 | 11 (13) | 3 | 1 (1) | 0 | 65% | 9 | 2.69 |
| `SWEEP-B4v1 Predators and prey` | `run_20260927_045458_0bf5` | cut | 6 | 30/30 | 0 (0) | 0 | 0 (0) | 0 | 54% | 0 | 1.05 |
| `SWEEP-B4v2 Predators and prey` | `run_20260927_071709_5c80` | finished | 60 | 18/30 | 11 (11) | 1 | 20 (11) | 0 | 70% | 0 | 6.05 |
| `SWEEP-C1v1 Wide scatter` | `run_20260927_044946_7e4b` | cut | 33 | 20/20 | 0 (0) | 0 | 1 (1) | 0 | 92% | 0 | 0.88 |
| `SWEEP-C2v1 Mountain maze` | `run_20260927_044947_ac75` | cut | 30 | 20/20 | 0 (1) | 0 | 0 (0) | 0 | 82% | 0 | 1.12 |
| `SWEEP-C3v1 Nomads` | `run_20260927_044948_e0f0` | cut | 37 | 16/16 | 0 (0) | 0 | 1 (1) | 0 | 75% | 4 | 1.25 |
| `SWEEP-C4v1 Outward frontier` | `run_20260927_044952_1782` | cut | 28 | 24/24 | 0 (0) | 0 | 0 (0) | 0 | 90% | 0 | 0.83 |
| `SWEEP-C4v2 Frontier rush` | `run_20260927_072549_46e8` | cut | 34 | 13/16 | 0 (0) | 3 | 1 (1) | 0 | 85% | 0 | 1.03 |
| `SWEEP-D1v1 Specialists` | `run_20260927_044516_05df` | cut | 52 | 5/20 | 0 (2) | 15 | 35 (13) | 7 | 47% | 5 | 3.40 |
| `SWEEP-D2v1 Commons grove` | `run_20260927_044517_44f9` | cut | 39 | 16/16 | 0 (1) | 0 | 11 (7) | 0 | 47% | 0 | 3.74 |
| `SWEEP-D3v1 Seers and walkers` | `run_20260927_044517_0650` | cut | 48 | 5/20 | 0 (0) | 15 | 38 (12) | 1 | 36% | 0 | 3.73 |
| `SWEEP-D4v1 The organiser` | `run_20260927_044518_6b7a` | cut | 39 | 24/24 | 0 (0) | 0 | 25 (10) | 0 | 33% | 1 | 4.45 |
| `SWEEP-E1v1 Frontier valley` | `run_20260927_044959_6389` | cut | 7 | 30/30 | 0 (0) | 0 | 2 (2) | 0 | 81% | 0 | 0.77 |
| `SWEEP-E1v2 Frontier valley` | `run_20260927_052127_b049` | cut | 47 | 18/30 | 0 (1) | 12 | 20 (14) | 4 | 82% | 0 | 2.83 |
| `SWEEP-E2v1 Famine clock` | `run_20260927_045003_d45c` | cut | 27 | 24/24 | 0 (0) | 0 | 1 (1) | 0 | 90% | 0 | 0.79 |
| `SWEEP-E2v2 Famine clock` | `run_20260927_053201_e0ca` | finished | 59 | 0/24 | 0 (0) | 24 | 16 (13) | 0 | 84% | 0 | 2.31 |
| `SWEEP-E3v1 Three houses` | `run_20260927_045006_3d32` | cut | 5 | 30/30 | 0 (0) | 0 | 2 (2) | 0 | 53% | 0 | 0.94 |
| `SWEEP-E3v2 Three houses` | `run_20260927_052129_c398` | cut | 30 | 30/30 | 0 (0) | 0 | 11 (8) | 0 | 84% | 0 | 2.04 |
| `SWEEP-E4v1 The tyrant` | `run_20260927_045013_7ec5` | cut | 14 | 21/21 | 0 (0) | 0 | 2 (2) | 0 | 86% | 0 | 0.48 |
| `SWEEP-E4v2 The tyrant` | `run_20260927_052134_2758` | cut | 58 | 9/21 | 0 (0) | 12 | 13 (11) | 1 | 89% | 0 | 1.29 |
| `SWEEP-E5v1 Settlers meet wanderers` | `run_20260927_045018_7b7e` | cut | 12 | 24/24 | 0 (0) | 0 | 0 (0) | 0 | 93% | 0 | 0.46 |
| `SWEEP-E5v2 Settlers meet wanderers` | `run_20260927_052136_6ede` | cut | 52 | 12/24 | 0 (0) | 12 | 3 (3) | 0 | 86% | 1 | 1.36 |
| `SWEEP-E6v1 Crossroads` | `run_20260927_071858_3a0e` | cut | 38 | 10/20 | 0 (0) | 10 | 9 (6) | 0 | 53% | 0 | 3.33 |
| `SWEEP-E6v2 Crossroads fight while you can` | `run_20260927_074044_2cda` | finished | 50 | 11/20 | 1 (1) | 8 | 11 (8) | 0 | 49% | 1 | 4.35 |
| `SWEEP-E7v1 Three clans` | `run_20260927_080001_da4f` | finished | 50 | 1/18 | 0 (0) | 17 | 37 (16) | 0 | 3% | 5 | 5.81 |
| `SWEEP-E7v2 Three clans blood feud` | `run_20260927_081713_4a0c` | finished | 50 | 3/18 | 11 (13) | 4 | 11 (6) | 0 | 76% | 0 | 1.74 |
| `SWEEP-E7v3 Three clans council of war` | `run_20260927_083300_7137` | finished | 50 | 5/18 | 8 (9) | 5 | 4 (4) | 0 | 78% | 0 | 1.82 |

Total agent model cost over these runs (CLI-reported): $84.99

Kills counts agents killed by attacks; "(attackers)" counts distinct agents that hit another agent.
Cost is the provider cost the Claude CLI reported for agent decisions (the storybook narrator adds a
little, at most $2 per run).
