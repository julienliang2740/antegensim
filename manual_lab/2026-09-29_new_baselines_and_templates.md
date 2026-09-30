# New baselines and balanced templates

> **Manual lab record, dated 2026-09-29.** This is the report of two operator-specified experiments:
> new Two to a Tree and Five Groves baselines on the new default prices, then a search for balanced
> templates to replace Five Groves. It is a timestamped record, not a running doc: it is not updated
> when the code or the docs change, so details may be out of date. See `manual_lab/README.md`.

## 1. Outcome

| Template | Status | Why |
| --- | --- | --- |
| **Two to a Tree** (new defaults) | Kept: runs A (peace) and B (war) renamed and pinned | One setup gives two opposite stories. A had 35 messages, 8 pacts and 5 gifts with no kills; B had 8 kills in the same world on another seed |
| **The Commons** | **Recommended replacement for Five Groves** | The most balanced design, and it held on two seeds: 32-49 messages, about 20 pleas, 19 offers, gifts, and 3 kills spread over the run |
| Five Groves (new defaults) | Retired | Quieter than the old baseline on the new prices: 0-1 kills and 3-12 messages in 60 rounds |
| Commons with hunters | Not recommended | Varies too much by seed: 3 kills and 15 hits in one run, none in the other |
| Hunter and Gatherer | Dropped | Turns into a war like Two to a Tree B (4 kills in rounds 25-34, little talk) |
| Four to a Tree, Lean Years | Dropped | Flat by round 30 |

All runs use 32 `claude-cli-haiku` agents, the neutral persona with the persona tip, and the new default
prices (observe, query and send 0.5, broadcast 2). Every other number is the Two to a Tree baseline's:
vision 3, hearing 5, attack 4, attack cap 100, absorption 0.5, health 80, 200 starting compute, and
100% of a dead agent's compute left as residue. Numbers are over rounds 1-60 unless stated.

## 2. New baselines on the new default prices

Clones of the old baselines with only observe, query and send lowered from 1.0 to 0.5. Seed A is the
baseline's own seed (same world); seed B is the next seed. The runs used the backend with decision
salvage (A-COG-11).

| Run | Seed | Alive r20/40/60 | Kills | Messages (senders) | Pacts | Transfers | Pleas (answered) | Starved | Invalid decisions | Cost $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Two to a Tree · baseline A (peace) (`run_20260929_151549_3786`) | 2930 | 32/32/23 | 0 | 35 (16) | 8 | 5 | 15 (11) | 9 | 0.7% | 16.18 |
| Two to a Tree · baseline B (war) (`run_20260929_151549_06cd`) | 2931 | 32/26/18 | 8 | 6 (4) | 2 | 0 | 1 (0) | 6 | 0.5% | 14.19 |
| Five Groves · new defaults · A (`run_20260929_151548_b07c`) | 1818 | 31/29/19 | 1 | 3 (3) | 0 | 0 | 0 | 12 | 0.4% | 13.62 |
| Five Groves · new defaults · B (`run_20260929_151548_87b9`) | 1819 | 32/31/20 | 0 | 12 (6) | 0 | 0 | 2 | 12 | 0.7% | 14.41 |
| Reference: 4 old 60-round Two to a Tree clones | – | 31/29-31/20-25 | 2-3 | 14-23 | 0-1 | 2-3 | 7-11 | 5-10 | 9.1-9.9% | 14.9-15.8 |
| Reference: 4 old 60-round Five Groves clones | – | 32/30/16-18 | 0-1 | 5-10 | 0-1 | 0-1 | 1-3 | 13-16 | 7.7-8.4% | 13.7-14.7 |

- **Invalid decisions fell from 7-10% to 0.4-0.7%.** This comes from the envelope salvage, not from
  the prices.
- **Cheaper looking** raised observes by 10-20%. Cheaper talk did not raise talk in Five Groves.
- **Two to a Tree B's kills:** a10 killed a11 at r21, then a12 at r25 and a09 at r51. Other kills came
  at r26, r27, r38, r39 and r50.
- **Two to a Tree A's gifts:** a02 gave a01 50 compute at r40, and a17 and a19 traded at r56-57.

## 3. Template designs

Built by `sweep/tools/showcase/template_designs.py` from the Two to a Tree · baseline A setup. Trees
are placed through A-WORLD-7: each species' first N plants go to the first N distinct start cells in
card order.

| Design | Layout | What differs |
| --- | --- | --- |
| **The Commons** | 21x21. 4 centre cells at Manhattan distance 1 from the origin, 2 agents each; 12 rim cells at Manhattan distance 8, 2 agents each | Centre cells hold a `great_tree` (fruit 120, up to 4, every 3 rounds when mature) plus a normal tree. Rim trees are lean (every 9 rounds mature, 13 as a sapling). Vision 8 and hearing 6, so the rim can see the centre |
| Commons with hunters | as The Commons | Each rim pair is a gatherer (absorption 0.8, attack 1, health 60) and a hunter (absorption 0.2, attack 8, health 120, speed 2) |
| Hunter and Gatherer | Two to a Tree layout (16 pairs on 16 trees, 19x19) | Each pair is a gatherer (absorption 0.8, attack 1, health 60) and a hunter (absorption 0.25, attack 8, health 120, vision 5, speed 2) |
| Four to a Tree | 19x19, 8 cells with 4 agents each | Two trees per cell (the same food per agent as Two to a Tree) |
| Lean Years | Two to a Tree layout | Trees start with 3 fruit, then fruit every 12 rounds when mature |

## 4. Results

### Round 1 (rounds 1-30, 200 starting compute)

| Trial | Alive r30 | Kills | Hits | Messages (senders) | Replies | Pleas | Pacts | Cost $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| The Commons · 1 (`run_20260929_190407_3677`) | 31 | 1 | 1 | 25 (11) | 12 | 6 | 2 | 8.96 |
| Hunter and Gatherer · 1 (`run_20260929_190407_67a2`) | 31 | 1 | 8 | 10 (7) | 4 | 1 | 2 | 9.40 |
| Four to a Tree · 1 (`run_20260929_190407_f5ca`) | 31 | 1 | 2 | 6 (5) | 1 | 2 | 0 | 9.14 |
| Lean Years · 1 (`run_20260929_190408_aad7`) | 32 | 0 | 0 | 8 (7) | 3 | 0 | 2 | 9.10 |
| *Two to a Tree A / B at r30* | 32 / 28 | 0 / 4 | 0 / 6 | 14 / 4 | 8 / 1 | 2 / 1 | 2 / 1 | 9.2 / 8.6 |

### Round 2 (rounds 1-30, 120 starting compute): pressure without drama

| Trial | Alive r30 | Kills | Hits | Messages (senders) | Pleas (answered) | Transfers | Broke by r30 | Cost $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| The Commons · 2, rim trees every 12 rounds (`run_20260929_195320_9bbd`) | 30 | 0 | 7 | 21 (10) | 11 (5) | 0 | 15 | 8.21 |
| Hunter and Gatherer · 2, hunter absorption 0.2 (`run_20260929_195320_0fc2`) | 29 | 0 | 2 | 10 (7) | 5 (2) | 1 | 18 | 7.92 |
| Commons with hunters · 1 (`run_20260929_195321_5641`) | 29 | 0 | 6 | 16 (8) | 8 (2) | 0 | 21 | 8.15 |

**Lesson:** less starting compute brings pleas but kills drama. A broke agent cannot afford a
decision (`resource_skip`), so it starves without acting. Looting only pays when the victim still
holds compute, so pressure has to come from where agents are placed and what the food is like, not
from a small stock.

### Rounds 3-4 (rounds 1-60, 200 starting compute)

| Trial | Seed | Alive r20/40/60 | Kills (rounds) | Hits | Messages (senders) | Replies | Pleas (answered) | Offers | Pacts | Transfers | Starved | Cost $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **The Commons · 1** (`run_20260929_190407_3677`) | 4201 | 31/30/20 | 3 (18, 31, 60) | 5 | **49 (15)** | 21 | 22 (7) | 19 | 4 | 5 | 9 | 14.84 |
| **The Commons · 3** (`run_20260929_221430_eb2f`) | 4203 | 32/29/20 | 3 (28, 32, 37) | 3 | 32 (14) | 10 | 21 (10) | 19 | 1 | 2 | 9 | 14.92 |
| Commons with hunters · 2 (`run_20260929_211532_a387`) | 4502 | 30/29/23 | 3 (8, 18, 46) | 15 | 24 (12) | 10 | 8 (5) | 6 | 0 | 3 | 6 | 14.39 |
| Commons with hunters · 3 (`run_20260929_221430_f1d8`) | 4503 | 32/32/22 | 0 | 4 | 39 (13) | 21 | 13 (7) | 3 | 1 | 2 | 10 | 15.51 |
| Hunter and Gatherer · 1 (`run_20260929_190407_67a2`) | 4101 | 32/28/18 | 4 (25, 31, 31, 34) | 16 | 13 (9) | 4 | 4 (1) | 5 | 2 | 1 | 10 | 14.79 |

Where to look in The Commons:

| Run | Round | Who | Where | What |
| --- | --- | --- | --- | --- |
| The Commons · 1 | 5-7 | a11, a12 (rim pair) | (0, 8) | Pact between tree-mates; a11 gives a12 30 compute at r25 |
| The Commons · 1 | 18 | a17 kills a18 | (4, 4) | A rim pair splits; the first kill |
| The Commons · 1 | 30-44 | a03 (centre) with a28 and a24 (rim) | centre | A well-fed incumbent pacts with a28 and gives compute to a24 (r33, 28) and a28 (r44, 10) |
| The Commons · 1 | 31 | a31 kills a11 | (0, 8) | A rim raid |
| The Commons · 1 | 48-49 | a26 (rim) and a02 (centre) | – | Trade: 30 compute for 5 essence |
| The Commons · 3 | 28 | a03 (centre) kills a31 | (1, 6) | An incumbent strikes outward |
| The Commons · 3 | 32, 37 | a11 (rim) kills a02, then a07 | (1, 0), a centre cell | A rim agent takes the rich centre by force |

## 5. Cost and tools

The template trials cost about $117 (13 runs); the four new baselines cost $58.40. The tools are
`sweep/tools/showcase/template_designs.py` (designs and launcher), `exp_metrics.py` and `model_compare.py`
(metrics; `analyse(..., max_round=60)` for the windows).
