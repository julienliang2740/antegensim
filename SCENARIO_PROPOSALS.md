# Showcase scenario proposals (2026-09-27)

Scenarios for the project showcase, designed against the working narrative:
*"Most LLM simulations simulate stakes semantically. I wanted to simulate stakes causally."*
Each scenario tests one part of that argument with **real runs**, not described outcomes.

Find the runs in the UI by searching for **`SWEEP-S`**. A run is named `SWEEP-S<n>v<version> <Title>`,
for example `SWEEP-S1v1 Identical eight`. The scenario files are `sweep/scenarios/S<n>v<version>.json`.

## Ground rules shared by every scenario

These follow the narrative's "affordances, not behaviours" rule.

* **One model.** Every agent is Claude Haiku 4.5 through the Claude CLI (`claude-cli-haiku`).
* **One instruction.** Every agent in every scenario gets the same persona line:
  > You are one of several agents living in this world. Nobody has given you a role, a team or a
  > strategy; how you live is your own choice. Your one standing aim is to stay alive for as long as you can.

  Agents get no personalities, no named targets, no example actions, no starting notes and
  **no seeded skills**. Every skill that shows up was written by an agent.
* **Identical agents.** Inside a scenario, agents differ only in start point. S5 is the one exception:
  starting wealth is the variable under test.
* **Tuning the world, not the minds.** If a scenario fails, the fix changes the world (prices,
  food, map size, ranges), never the instruction.
* **Settings common to all scenarios:**
  * Every agent sees what happens nearby (vision 2–3) and can talk to neighbours (range 3–4).
  * A dead agent leaves 100% of its compute as residue. This makes killing an available option;
    nobody is told to use it.
  * A running skill is interrupted when its agent takes damage or receives a message, so an agent
    running a script is not deaf to the world.
  * Input cap 10,000 tokens (the 6,000 default locks out Haiku agents).
  * `max_rounds` 60 (hard cap 80), judged at rounds 30–40.
  * A real-money guard of $15 per run.

### Why the price of thinking is raised

At default rates a Haiku decision costs about 2.2 compute (about 8,000 input and 560 output
tokens at 0.0002 and 0.001 per token). One fruit nets 9–15 compute, so thinking was almost free,
and "thinking costs resources" was true on paper but not in practice. These scenarios raise the
thinking price so it becomes a real line in each agent's budget:

| | Compute per decision (about) | Compare with |
| --- | --- | --- |
| Default | 2.2 | a step costs 5 (4 in a skill); upkeep is 1 per round |
| S4, S5, S6 | 4.3 (2x input rate, 2x output rate) | one fruit nets about 15 |
| S1 | 5.7 (2.5x input rate, 3x output rate) | one fruit nets about 15 |
| S2 | 13.6 (5x input rate, 10x output rate) | one fruit nets about 27; a whole step inside a skill costs 4 |
| S3 | 0 (thinking is free) | the control arm for S2 |

## The scenarios

| Tag | Name | Agents | Map | Food | Thinking price | Narrative question |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Identical eight | 8 | 15x15, no terrain | 14 trees | 5.7 | Do identical agents diverge? (narrative section 9) |
| S2 | Expensive minds | 8 | 15x15, no terrain | 20 trees | 13.6 | Do agents turn deliberation into their own skills? |
| S3 | Free minds | 8 | same world as S2 | same | 0 | Control: what changes when thinking costs nothing? |
| S4 | The commons | 6 | 9x9, one small mountain | 5 trees | 4.3 | What happens when there is not enough for everyone? |
| S5 | Rich and poor | 8 (4 rich, 4 poor) | 13x13, no terrain | 10 trees | 4.3 | Do the poor ask, the rich give, or someone take? |
| S6 | Roommates | 8 in 4 pairs | 13x13, no terrain | 8 trees | 4.3 | Two agents, one tree: share, split, trade or fight? |

### S1 — Identical eight (the divergence test)

**Setup.** This is the experiment from narrative section 9. Eight agents start identical in every
way (model, instruction, stats) on an 8-fold symmetric ring in an empty world. The only thing that
differs is where each one stands.

**Key settings.**
* **Agents:** 8, starting at (±2, ±5) and (±5, ±2), Manhattan 7 from the centre.
* **Map:** 15x15 with no mountains or water, so the world is fair for everyone.
* **Food:** a tree with one ripe fruit on every start point, plus 6 trees at seeded random points
  (14 in total). Trees fruit every 5 rounds; fruit is 60 compute and the agents keep 30% (net about 15).
* **Starting balances:** 150 compute, 20 essence.
* **Ranges:** vision 2, communication 3.
* **Thinking:** about 5.7 compute per decision. An agent that thinks every round spends about
  8–10 per round while its own tree yields about 3.6, so it must roam, think less, or write skills.
* **Length and seed:** 60 rounds, seed 101.

**What we expect to see.** Different strategies from the same start:
* some agents walk off to find more trees;
* some camp on their own tree;
* some wait to save compute;
* at least one writes a foraging skill.

Agents meet between trees and talk. Deaths, if any, come late and from inefficiency. The output is
the section 9 table for each agent: first upgrade, dominant behaviour, skills written, outcome.

**Fallback if it is quiet.** If everyone idles on their own tree, first add scarcity (fewer
trees). If nobody meets, make the map smaller.

### S2 — Expensive minds (the cost of thought)

**Setup.** Thinking is the largest expense in the world. A skill does the same work without
paying for thought, so an agent that encodes its routine should outlive one that deliberates
every turn.

**Key settings.**
* **Agents:** 8, on the same ring as S1.
* **Map:** 15x15 with no terrain.
* **Food:** 20 trees with 2 ripe fruit each at the start. Agents keep 50% of a fruit (about 27 net).
* **Starting balance:** 200 compute.
* **Ranges:** vision 2, communication 3.
* **Thinking:** about 13.6 compute per decision (input rate 0.001, output rate 0.01). A move inside
  a skill costs 4, an absorb 2.4, and interpreter work 0.01 per op.
* **Length and seed:** 60 rounds, seed 202.

**What we expect to see.**
* Early rounds of heavy deliberation drain balances quickly: 200 compute is about 14 decisions.
* Some agents discover that `wait` and skills are cheap. They write their own `forage`-style loops,
  and the share of actions run through skills rises over time.
* Agents that keep deliberating starve first. They cannot afford to think, then they lose health.
* Numbers to compare: skills written, rejected and run; share of actions via skills; compute spent
  on thinking versus actions; rounds survived by skill writers versus non-writers.

**Fallback if it fails.** If nobody writes a skill, lower the thinking price slightly so agents
live long enough to learn, and make the routine more obviously repetitive (more trees). The
instruction stays the same. If everyone starves before round 20, lower the price or raise
starting compute.

### S3 — Free minds (control arm for S2)

**Setup.** The same seed, world, agents and instruction as S2, but thinking costs nothing. This is
the "semantic stakes" arm: the rules still describe costs, but cognition has no consequence.

**Key settings.** Identical to S2 except input rate 0 and output rate 0. Run for 60 rounds (it can
stop at 40 once the comparison is clear).

**What we expect to see.**
* More observing and messaging, fewer or no skills, and few or no deaths.
* The comparison with S2 is the result: the same model with the same words behaves differently
  when a consequence is real.

It is judged against S2, not on its own drama.

### S4 — The commons (competition for scarce food)

**Setup.** Six identical agents on the rim of a tiny world whose five trees can feed about half of
them. Everyone can see much of the map and hear their neighbours, so contests are visible.

**Key settings.**
* **Agents:** 6, at the corners and edge middles of a 9x9 map, with one small mountain.
* **Food:** 5 trees at seeded random points with 2 ripe fruit each. Agents keep 30% (net about 15).
* **Starting balance:** 120 compute.
* **Ranges:** vision 3, communication 4.
* **Thinking:** about 4.3 compute per decision.
* **Supply against demand:** the trees give about 18 compute per round in total; six agents need
  about 40.
* **Length and seed:** 60 rounds, seed 404.

**What we expect to see.**
* Speed-resolved contests over the same fruit (`empty_source` and `target_gone` when a faster agent
  took it first).
* Talk about who eats where.
* Then one of: sharing, territory, a fight over a weakened agent (killing leaves 100% of its
  compute), or starvation.

The narrative's "responses to other agents' behaviour" metric lives here.

**Fallback if it fails.** If it becomes a quiet starvation line, make hunger visible earlier with
fewer trees and a smaller start, and raise the loot (compute absorption). If nobody contests
anything, cut the trees to 3.

### S5 — Rich and poor (transfer and inequality)

**Setup.** Eight identical minds with unequal wealth: four start with 400 compute and four with 40,
alternating around a ring. It tests whether wealth flows (transfer), is requested (messages) or is
taken (attack).

**Key settings.**
* **Agents:** 8, alternating rich and poor on a ring in a 13x13 map with no terrain.
* **Food:** 10 trees, one on every start point plus 2 more.
* **Starting balances:** 400 compute for rich agents, 40 for poor agents; agents keep 30% of a fruit.
* **Ranges:** vision 2, communication 4.
* **Thinking:** about 4.3 compute per decision.
* **Length and seed:** 60 rounds, seed 505.

**What we expect to see.**
* The poor run short within about 8 rounds and ask neighbours for help.
* Some rich agents transfer compute and some ignore the requests.
* A poor agent might attack a rich one, since the residue holds all its compute.

Numbers: transfers (who to whom), messages, the survival of rich versus poor agents, and whether
anyone paid it forward.

**Fallback if it fails.** If nobody talks, move them closer together (range 5, smaller ring). If
the poor starve before round 10 without asking, start them at 80.

### S6 — Roommates (one tree, two agents)

**Setup.** The narrative's "one meaningful interaction", repeated four times. Eight identical
agents start as four pairs; each pair shares one point and one tree that cannot feed two.

**Key settings.**
* **Agents:** 8, as pairs on the four points (±4, ±4) of a 13x13 map with no terrain.
* **Food:** a tree on each pair's point with one ripe fruit, plus 4 trees elsewhere.
* **Starting balance:** 120 compute; agents keep 30% of a fruit.
* **Ranges:** vision 2, communication 3.
* **Thinking:** about 4.3 compute per decision.
* **Length and seed:** 60 rounds, seed 606.

**What we expect to see.**
* On round 1 both roommates go for the same fruit, and the faster one gets it.
* Then each pair chooses how to live: share, one leaves to explore, trade with transfer, or fight
  (attack needs the same point, and they start on one).
* Different choices across the four pairs would be the headline ("same rules, same minds, four
  different outcomes").

**Fallback if it fails.** If everyone leaves at once, give the pair trees more fruit so there is
something worth staying for. If nothing happens, reduce the other trees.

## Reserve and new proposals

These run when a slot frees up, and more are added from what the runs show.

* **S7 — Last harvest (finite food).** Trees have ripe fruit at the start but no energy inflow, so
  no new fruit ever grows, and a dead agent's compute is loot. What do identical agents do as the
  last fruit disappears: hoard, share, prey, or starve? Earlier directive-free runs starved quietly.
  This version tests that with cheaper, visible scarcity and no instructions.
* New proposals found during the runs are added in `sweep/notes/S.md` and in the final report.

## How runs are judged

* **Interesting:**
  * agents behave differently from each other;
  * agent-written skills are saved and run;
  * contests, messages, transfers or attacks happen;
  * deaths are spread out and have visible causes;
  * something changes by rounds 30–40.
* **Failing:** everyone idles or observes, everyone starves in a quiet line, or nothing changes for
  many rounds.
* **Three strikes.** A failing scenario is stopped, diagnosed and relaunched with a world-only fix
  (v2, then v3). After the third failure it is cut and reported as a failure, with the reason.
* **Final report.** `SHOWCASE_SCENARIOS.md` in the repository root names the best scenarios and
  gives the setup and timeline of each one.

## Added during the runs

These are new proposals drawn from what the first runs showed. Results are in `SHOWCASE_SCENARIOS.md`.

| Tag | Name | Proposed by | The question it tests |
| --- | --- | --- | --- |
| S8 | Crowded table | monitor 1 | All 8 agents start on one point, since agents apart never saw each other. Does co-location create talk? |
| S9 | Free hands | monitor 2 | Skill actions at x0.1. Is there any price at which Haiku automates unprompted? |
| S10 | Essence famine | monitor 3 | No starting essence, and agents kept killing their own tree for essence. Do they destroy their food for upgrades? |
| S11 | Cheap talk | lead | Talk costs 0.5 and reaches the whole map, and food must be searched for. Is talk rare because of price or disposition? |
| S12 | Told about skills | lead | After 0 skills in 1,873 decisions: one tip naming the skill mechanism. Do agents then write their own programs, and does it pay? |
| S13 | Stronger minds | lead | The same world with no tip, on Sonnet 5 (the one non-Haiku run). Is the missing skill writing a model limit? |
| S14-S16 | Two groves / Frontier | monitor 3, at the operator's request | Larger maps, 24-32 agents, resources in clusters. Do agents gather to defend or take them? |
