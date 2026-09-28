# Showcase scenarios: final results (2026-09-28)

* **Finding the runs:** search the UI's run list for **`SWEEP-S`**. Every run below can be re-run
  exactly with **Clone setup** on the Resume page.
* **Models:** every agent is Claude Haiku 4.5. The one exception is `SWEEP-S13v1`, a deliberate
  Sonnet probe.
* **Instructions:** every agent gets the same one-line persona.
* **The persona tip:** the runs marked "tip" also get the persona tip, which is now an engine setting
  (see "Changes made"). It names the options (skills, message, give compute, attack, loot) and never a
  goal.

## Flagship scenarios for the presentation

| Use it for | Run | What happens |
| --- | --- | --- |
| **The thesis: causal stakes** | **`SWEEP-S2v1 Expensive minds`** vs **`SWEEP-S3v1 Free minds`** | Same world, same agents, same words; only the price of thinking differs. **All 8 starved by round 45 against 8 of 8 alive.** Every death follows an agent becoming unable to afford a thought. |
| **Agents write their own skills** | **`SWEEP-S12v1 Told about skills`** (companion `SWEEP-S13v1 Stronger minds`) | The 4 skill writers ate the same fruit as the 4 non-writers and ended with **2.2x the compute**, thanks to about 35% lower thinking bills. Sonnet (S13) found skills with no hint at all. |
| **The showpiece: interaction and conflict** | **`SWEEP-S18v1 Frontier replica B`** (tip), rounds 5-35 | The richest run. 2 hunts ending in kills, **a victim killing its attacker with one blow**, a completed trade (40 compute for 10 essence), a plea that gets an answer, 18 messages, 4 skill writers. |
| **It recurs, over 100 rounds** | **`SWEEP-S28v2 Frontier, lean and talkative`** (tip) | Finished 100 rounds. 3 kills spread over rounds 8, 43 and 57 (one a hunt that ends in looting the victim), a trade, 2 peace pacts, 4 skill writers. |
| **Pairs, betrayal, a serial killer** | **`SWEEP-S29v2 One tree, two mouths`** (tip) | 16 pairs, each sharing one tree. Some pairs make peace pacts; **a03 kills its own partner at round 15, then two more agents at rounds 41 and 45**; a07 kills its partner at round 26. 4 kills in all, and 10 survivors after 100 rounds. |
| **Hunger changes behaviour** | **`SWEEP-S26v2 Frontier drought`** (tip) + **`SWEEP-S30v1 Frontier, lean years`** (tip) | In S26v2 the operator halves the food mid-run through god mode. **Messages rose tenfold (pleas, trade offers, a completed trade), then stopped completely when the rains came.** Deaths lag the drought by about 30 rounds. S30v1 cycles drought, rain and drought: a mutual hunt ends in a kill, 11 pleas, a free gift of 25 compute. |

**The one-line pitch across them:**
* Make consequences real, and thinking becomes 60-85% of an agent's budget.
* Agents who automate routines outlive agents who deliberate.
* Named options give crowded agents a social life: pleas, trades, hunts and revenge.
* Hunger changes how much they talk.

## Changes made

1. **Persona tip switch (commit `a1d82d4`).**
   * **New session:** the Agents section has **Add the tip to every persona**, **on by default**. The
     "?" next to it explains the tip is there so agents do interesting things, and to switch it off only
     on purpose. **Show the tip text** shows the exact words.
   * **Where it lives:** the setting is `context.persona_tip` / `persona_tip_text`. A card can override
     it, god mode can switch it mid-run, **Clone setup** copies it, and the Rules tab shows it.
   * **Old runs:** they read it as off, so their prompts never change.
   * **Docs:** documented in SYSTEM (the exact text), ASSUMPTIONS A-KNOW-9, CONTROLS, README, GLOSSARY,
     INTERFACES, LIMITATIONS, TEST_PLAN / TEST_EVIDENCE, CODE_MAP and the instructions page.
   * **Tests:** 718 backend tests pass. In the browser check, the New session step verifies the switch
     is on by default. 9 older browser-check steps still fail because the board-layout commits moved the
     run rail, as recorded in TEST_EVIDENCE.
2. **Sweep tooling.**
   * Round cap raised from 80 to 100 (`sweep/tools/sweep.py`).
   * `sweep/BRIEF.md` updated: use the tip setting instead of persona text.
   * All earlier scenario files pin `persona_tip: false` so they reproduce what ran.
   * The analysis and god-mode helpers are now in `sweep/tools/showcase/`:
     * `story.py`: the interaction scoreboard;
     * `analyze.py`: the per-agent table;
     * `weather.py`: droughts and rain through god mode;
     * `launch_on.py`, `branch_words_removed.py`, `phases.py`, `skills_src.py`.
3. **Cleanup.** 48 quiet, failed, middling or superseded runs were deleted through the product's delete API;
   their verdicts stay in `sweep/notes/` and `sweep/registry.json`. 14 runs remain.

## Scenarios left (14 runs)

| Run | Role | Result |
| --- | --- | --- |
| `SWEEP-S2v1 Expensive minds`, `SWEEP-S3v1 Free minds` | thesis A/B | 0/8 against 8/8 alive |
| `SWEEP-S12v1 Told about skills`, `SWEEP-S13v1 Stronger minds` | skills | writers 2.2x richer; Sonnet writes skills unprompted |
| `SWEEP-S18v1 Frontier replica B` | showpiece | score 53: 2 kills, a counter-kill, a trade, an answered plea |
| `SWEEP-S28v2 Frontier, lean and talkative` | recurrence over 100 rounds | score 45.5: 3 kills, a trade |
| `SWEEP-S29v2 One tree, two mouths` | pairs and betrayal | score 40.5: 4 kills, 3 peace pacts |
| `SWEEP-S30v1 Frontier, lean years` | drought cycles | score 41.5: a mutual hunt and kill, 11 pleas, a gift |
| `SWEEP-S26v2 Frontier drought` | hunger A/B by phase | score 32: tenfold talk in the drought |
| `SWEEP-S16v3 Frontier` | first run of the flagship world | score 21: a hunt and kill, retaliation, 5 skill writers |
| `SWEEP-S14v2 Frontier, plain` | control without the tip | 0 messages, 0 skills, 0 attacks on agents |
| `SWEEP-B1v1 Blood arena II`, `SWEEP-B2v2 Two tribes`, `SWEEP-E7v2 Three clans blood feud` | earlier sweep, directive personas | wars with 11-17 kills |

## Scenarios created in this round

| Scenario | Versions | Best | Verdict |
| --- | --- | --- | --- |
| S24 Frontier long A | v1-v3 | v3 23.5 (deleted) | fail: quiet starvation by round 46-90; contracts but no violence |
| S25 Frontier long B | v1-v3 | v3 17 (deleted) | fail: one negotiation, then starvation |
| S26 Frontier drought | v1-v2 | **v2 32** (kept) | success on its question (hunger makes agents talk, not fight) |
| S27 Citadel siege | v1-v3 | 20.5 (deleted) | fail: camps never found the citadel, or fought among themselves |
| S28 Frontier, lean and talkative | v1-v2 | **v2 45.5** (kept) | success: fragile bodies plus cheap thinking plus scarcer fruit |
| S29 One tree, two mouths (spicy-1's idea) | v1-v2 | **v2 40.5** (kept) | success: pacts, betrayal, a serial killer |
| S30 Frontier, lean years (spicy-2's idea) | v1 | **41.5** (kept) | success: drought cycles, a mutual hunt, pleas and a gift |
| S31 Frontier warlords (spicy-3's idea) | v1-v2 | 12.5 (deleted) | fail: the strong agents never attacked |
| S17-S20 (finished after last night's parking) | | S18 53 | S18 final; S17 added a plea answered with a gift; S19 deleted |

## Recurring behaviours

These are counts across the 9 kept tip runs: S16v1, S16v3, S17, S18, S20, S26v2, S28v2, S29v2, S30v1.

| Behaviour | Count |
| --- | --- |
| Kills | **13** (in 6 different runs) |
| Hunts (repeated hits on one target) | 8 |
| Retaliations | 3, including 2 victims who killed their attacker |
| Transfers | 9 (completed trades and pure gifts) |
| Direct replies or broadcast answers | 36 |
| Messages | 120 |
| Agents who wrote and ran their own skills | **35** |

Skill writers end richer in every run where both groups survive, for example S29v2 (mean 506 compute
against 282) and S28v2 (532 against 398).

## What the runs taught (for questions)

* **The tip is a nudge, and we say so.**
  * **Without it, nothing social:** the same crowded world with only the plain persona gave nothing
    social (`S14v2`). A permission sentence, a greedier goal and a few Sonnet agents did not change that.
  * **With it:** the agents use the named options. Every choice of whom, when and how much is still
    their own.
* **Variance is large.** Identical prompts give story scores from about 5 to 53 across seeds. So the
  showcase uses several runs, and counts repeated behaviours instead of relying on one lucky run.
* **The rhythm of these worlds:** interaction peaks in rounds 5-40, then a starvation wave around rounds
  40-60 thins the population. Broke agents cannot afford to think, so they cannot beg or fight either.
* **Hunger makes agents talk, not fight.** Drought multiplied messages about tenfold; violence came from
  competition at a shared tree, usually when the attacker could still afford it.

## Cost

* **This round:** about $300 in CLI-reported cost for the 22 runs of this round, including S17-S20's
  earlier rounds.
  * **API key** (since about 03:00 UTC): roughly $70.
  * **Subscription:** the rest.
* **Per run:** the most expensive single run was S26v2 at $21.50. Every other run stayed under $19.
* **Overall:** about $59 for the first showcase round, $85 for the original sweep, and about $65 for the
  earlier cluster runs.

## Where everything is

* **Scenario files:** `sweep/scenarios/S*.json`. Each has a `_design` note; the tip-era files set
  `context.persona_tip`.
* **Notes with full timelines:**
  * `sweep/notes/S24_S25.md` (S24, S25, S29)
  * `sweep/notes/S26_S28.md` (S26, S28, S30)
  * `sweep/notes/S27.md` (S27, S31, and the finished S17-S20)
  * `sweep/notes/S11_S12_S13.md`, `S1_S6.md`, `S2_S3.md`, `S4_S5.md`, `S7.md`
* **Proposals:** `SCENARIO_PROPOSALS.md`.
