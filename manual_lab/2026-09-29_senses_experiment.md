# Does easier communication and seeing make runs more active? (2026-09-29)

> **Manual lab record, dated 2026-09-29.** Experiment on cheaper and wider talking and looking, as specified by the operator. Its recommendation changed the default prices the same day (A-ECON-3). This is a timestamped record, not a running doc: it is
> not updated when the code or the docs change, so details may be out of date. See `manual_lab/README.md`.

**Question.** If talking and looking cost less compute, or reach farther, do agents interact more? Every
option still costs something.

**Method.**
* Each variant is a clone of one of the two baselines (Five Groves or Two to a Tree) with one lever
  changed, run for 40 rounds, which is where most of the action happens.
* Variants reuse the seeds of the baseline experiment's 45-round runs, so the start state and the
  first rounds' turn order match.
* Comparison: the 9 baseline experiment runs per world, cut to their first 40 rounds.
* A fork test separates the effect of price from chance.
* 19 runs in total, $213 as reported by the CLI.

Search the run list for **"senses"**, **"talk"** or **"hearing"** to find the runs.

## Levers tested

| Variant | observe / query | send / broadcast | vision / hearing |
| --- | --- | --- | --- |
| Baseline (both worlds) | 1 / 1 | 1 / 2 | 3 / 5 |
| Cheap senses | 0.25 / 0.25 | 0.25 / 0.5 | 3 / 5 |
| Cheap talk only | 1 / 1 | 0.25 / 0.5 | 3 / 5 |
| Half-price talk | 1 / 1 | 0.5 / 1 | 3 / 5 |
| Far senses | 1 / 1 | 1 / 2 | **5 / 10** |
| Wide hearing only | 1 / 1 | 1 / 2 | 3 / **10** |
| Cheap + far | 0.25 / 0.25 | 0.25 / 0.5 | 5 / 10 |
| Five Groves: cheap talk + cheap thinking | 1 / 1 | 0.25 / 0.5 | 3 / 5, with thinking about 2.2 per decision instead of 4.3 |

The shipped defaults are send 3 and broadcast 7. Both baselines already use 1 and 2.

## Results (means per run, rounds 1-40)

| World · variant | Runs | Messages | Senders | Replies | Pleas (answered) | Gifts + trades | Observes | Hits | Kills |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Two to a Tree · baseline** | 9 | 10.6 | 6.9 | 3.1 | 6.0 (1.8) | 0.6 | 507 | 4.4 | 2.3 |
| Two to a Tree · cheap senses | 3 | 17.3 | 8.3 | 7.0 | 7.3 (3.3) | 2.0 | 537 | 2.7 | 1.3 |
| Two to a Tree · cheap talk only | 1 | 7 | 5 | 3 | 2 (1) | 0 | 530 | 2 | 2 |
| Two to a Tree · half-price talk | 1 | **29** | **14** | **14** | 13 (4) | 0 | 522 | 2 | 1 |
| **Two to a Tree · all cheaper-talk runs pooled** | **5** | **17.6** | 8.8 | **7.6** | 7.4 (3.0) | **1.2** | 531 | **2.6** | **1.6** |
| Two to a Tree · wide hearing only | 1 | 4 | 4 | 1 | 1 (0) | 0 | 526 | 5 | 4 |
| Two to a Tree · far senses | 2 | 8.0 | 6.0 | 2.0 | 3.5 (0.5) | 0 | 509 | 5.5 | 3.0 |
| Two to a Tree · cheap + far | 2 | 3.5 | 2.5 | 1.0 | 1.5 (0.5) | 0 | 514 | **7.0** | 2.5 |
| **Five Groves · baseline** | 9 | 5.1 | 4.0 | 1.4 | 1.4 (0.4) | 0.3 | 524 | 1.6 | 0.6 |
| Five Groves · cheap senses | 2 | 4.0 | 3.0 | 1.5 | 0.5 (0.5) | 0.5 | 505 | 6.0 | 0.5 |
| Five Groves · far senses | 1 | 5 | 5 | 1 | 2 (2) | 1 | 536 | 1 | 0 |
| Five Groves · cheap + far | 2 | 5.0 | 4.0 | 1.0 | 1.5 (0) | 1.0 | 530 | 0 | 0 |
| Five Groves · cheap talk + cheap thinking | 2 | 4.5 | 2.5 | 1.5 | 2.5 (2.0) | 0.5 | 556 | 1.5 | 0.5 |

**The fork test (price against chance).** `Two to a Tree · cheap senses · r1` was branched at the end
of round 15. One future kept the cheap prices; in the other, god mode restored the baseline prices.
Messages in rounds 16-35:

| Future | Messages | Replies | Gifts | Kills |
| --- | --- | --- | --- | --- |
| Original run (cheap) | 17 | 5 | 2 | 2 |
| Fork, cheap prices kept | 3 | 0 | 1 | 1 |
| Fork, baseline prices restored | 9 | 3 | 2 | 3 |

From an identical state with identical prices, one future had 17 messages and the other 3.

## What this shows

1. **Cheaper talk nudges Two to a Tree toward talk and away from violence.** Pooled over the 5
   cheaper-talk runs against the 9 baselines:
   * messages up 66% (17.6 vs 10.6);
   * replies up 2.5x (7.6 vs 3.1);
   * answered pleas up 1.7x;
   * gifts and trades doubled;
   * hits down 40% and kills down 30%.

   The spread is wide (7-29 messages against the baseline's 8-23), and the fork test shows how much
   one conversation starting or not can swing a run. So treat this as a consistent tilt, not a
   guarantee. Five runs are too few to rule out luck; the replies and help numbers are the more robust
   signals.
2. **Cheaper looking does nothing.**
   * Observations stay at about 500-560 per run at every price.
   * A decision already costs 2-4 compute in thinking, so observe at 1 or 0.25 hardly changes the
     total.
   * Agents look at one point per action, mostly their own, so looking is limited by the one-point
     rule, not by price.
3. **Wider vision or hearing makes runs more violent, not more talkative.**
   * In this engine an attack reaches any agent the attacker can see, so vision 5 also means attack
     range 5.
   * Far-senses variants had the most hits (5.5-7 vs 4.4) and the fewest messages (3.5-8).
   * Wider hearing alone (range 10) also gave only 4 messages.
4. **Five Groves does not respond to any of these levers.**
   * Messages stay at 4-5 per run whatever the price, even with thinking halved.
   * Its agents mostly never meet anyone outside their own grove, and the groves are 7 steps apart.
     Layout decides how much agents talk: Two to a Tree, where agents start in pairs, talks twice as
     much at the same prices.
   * Cheaper thinking did keep Five Groves agents solvent: 2.5 went broke by round 40, against 10.7.

## Recommended adjustments to defaults

**Prices** (all changes to shipped defaults):
* **Talk: `send` 3 → 0.5, `broadcast` 7 → 1.** The shipped prices are 6-7x what even the baselines used.
  Every talk run in these experiments used 1/2 or less, and cheaper talk tilts agents toward
  conversation and help. Half-price talk (0.5/1) gave the single most talkative run, and it is far from
  free.
* **Leave `observe` and `query` at 1.** Cutting them had no measurable effect; the one-point rule is the
  limit, not the price.
* **Do not raise `vision_range` or `communication_range` to encourage talk.** Wider vision arms agents,
  and wider hearing did not help.

**Engine changes** (not made; code changes, so your call):
* **Let `observe` return every point within vision in one action**, or add an area-scan action. This
  is the change that would actually make seeing easier. Right now looking is one point per action, and
  price cannot fix that.
* **Give attacks their own range** (for example `attack_range`), separate from vision. Better sight
  could then help coordination without also making agents deadlier.

**Scenario design** (bigger than any price): talk comes from agents who meet. Pairs or crowds sharing
a point (Two to a Tree) talk twice as much as spread-out groves (Five Groves) at the same prices.

## Runs that show the points

| Point | Run | Where to look |
| --- | --- | --- |
| Cheap talk, lots of talk and help | `Two to a Tree · half-price talk · r3` (29 messages, 14 replies) | a03 ↔ a04 opening exchange at (-2,-6), `r00006_t29_a04` → `r00007_t12_a03` → `r00008_t27_a04`. Two broke agents plan together at (6,2): plea `r00029_t09_a21`, reply `r00033_t03_a23`, "reconvening at R38 as planned" `r00038_t05_a21` |
| Cheap senses, talkative | `Two to a Tree · cheap senses · r1` (27 messages, 11 replies) | Partner negotiation at (-6,6): `r00011_t07_a25` "Clarify your intentions: cooperation, neutrality, or conflict?" and a26's reply in round 12 |
| Same state, different futures | `Two to a Tree · cheap senses · fork r15 · kept cheap` (3 messages) vs `· prices restored` (9) vs the original r1 (17) | rounds 16-35 |
| Far senses turns violent | `Two to a Tree · cheap + far senses · r1` (3 kills, the most hits) | a11 kills a12 `r00028_t29_a11` at (3,-2); a21 kills a17 `r00037_t29_a21` at (2,2); a01 kills a06 `r00038_t10_a01` at (2,-6) |
| Five Groves unchanged by price | `Five Groves · cheap senses · r1/r2`, `Five Groves · cheap talk + cheap thinking · r3a/r3b` | 1-8 messages, same as the baseline |
