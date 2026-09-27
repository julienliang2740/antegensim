# How Empyrean works, end to end

Audience: operators, developers and the built-in assistant (this file is part of its
knowledge). Every number below is a **shipped default** (the value in `backend/empyrean/config.py`
and `schemas.py`); a run can change almost all of them at creation or through god mode. For the
values in force in a specific run, read that run's Rules tab (`GET /api/runs/{run_id}/rules` and
`/settings`). `docs/ASSUMPTIONS.md` lists every default with its config key. Exact formats are
in `docs/INTERFACES.md`; words are defined in `docs/GLOSSARY.md`; every button is in
`docs/CONTROLS.md`.

## Overview

Empyrean is a local, turn-based artificial-life world in which every agent is a language model.
A run holds 6 to 64 agents (8 prefilled) on a grid. Time advances in **rounds**. At the start of
a round every agent that will think makes its paid **model decision** at the same time: the engine
builds each agent's bounded **decision packet** from what that agent knows at round start and all
the model calls run at once (a round costs about one call's latency, however many agents think).
Then every living agent gets exactly one **turn**, in initiative order (highest speed first): it
either continues a running saved **skill** or uses its round decision, and the world engine checks
the action against the world as it is at that moment and applies exactly one action with its costs.
After the last turn a **round-end** step grows plants, spawns fruit and seeds, charges upkeep and
resolves deaths.

Three resources matter: **compute** (energy: thinking, acting and staying alive all spend it),
**essence** (spent only on upgrades; comes only from residue of the dead and from transfers) and
**health** (0 is death). New compute enters the world only through plants and their fruit.

Every turn is committed to disk as an immutable, readable JSON checkpoint. A run can be paused,
inspected turn by turn (history browsing never calls a model), edited through **god mode**
(changes are staged and applied at the next turn boundary) and branched into a
**continuation** from any saved turn.

The operator drives a run with four commands (Run turn, Play, Pause, Step round). A built-in
**assistant** explains the world and the controls, reads the run's records to answer questions,
proposes actions as **execution briefs** that run only after the operator approves them, writes
a per-turn **storybook**, and turns a run into a chaptered story in **Story Mode**. Speech input
is called **Dictate** (local Whisper).

## The world

* A flat grid of integer points `(x, y)`. Default region −10..10 on both axes (441 points). A
  move that would leave the region fails (`blocked`).
* Terrain per point: **land** (normal), **mountain** (impassable; a move into it fails with
  `blocked`), **water** (walkable at the normal price; plants never grow and seeds never
  germinate there).
* Terrain is generated from the run seed: 4 mountain clusters of about 4 points, 3 water clusters
  of about 5 points, and a clear radius of 2 around the origin (shipped defaults). Same seed and
  setup give the same world. A card that starts on a mountain is moved to the nearest land point
  and the move is reported as a warning on the `run_created` event.
* Unlimited co-location: any number of agents, plants, fruit, seeds and residue can share a point.
  Actions target entities by id, not by position.
* Distances are Manhattan (`|dx| + |dy|`). Directions: `up` = y+1, `down` = y−1, `left` = x−1,
  `right` = x+1.

## Agents

An agent is a card turned into a world entity: id (`a01`..`a12` by default, or any
`^[A-Za-z0-9]{1,16}$` that is not a reserved word), name, model key (the card's own or the run
default), start position, stats, optional persona, starting notebook and starting skills.

Shipped default stats: compute 200, essence 20, essence capacity 100, health 100, max health 100,
attack 1.0, attack cap 50 (the most damage one attack can deal), speed 1, vision range 0, communication range 0, compute absorption 0.20, essence
absorption 0.10, skill count limit 5, skill block limit 100.

With vision and communication range 0, an agent sees and talks only to its own point at the start.
`query` of another agent reveals id, name, kind, position, health, max health, attack, attack cap,
speed and alive, never its compute or essence.

## Rounds and initiative

1. At round start the initiative is fixed once: living agent ids sorted, shuffled with the run's
   single seeded RNG, then stable-sorted by speed (highest first). Speed only sets the order; it
   never grants extra turns or longer moves.
2. Right after, every agent decides at once (A-SCHED-5): each living agent that is not waiting and
   has no running skill (or whose running skill an unread arrival listed in
   `rules.skills.interrupt_on` interrupts) gets its packet built from the world and its knowledge
   as they are now, and all these model calls run together on a process-wide pool
   (`EMPYREAN_MODEL_CONCURRENCY`, shared by every open run). Nobody sees what the others decided.
3. Each living agent then gets one turn, saved as `r{round:05d}_t{index:02d}_{agent_id}`, and its
   round decision resolves there: the action is checked against the world as the faster agents
   left it. Speed therefore resolves conflicts: of two agents after one fruit the faster absorbs it
   and the slower gets `empty_source` or `target_gone`; of two agents attacking each other the
   faster strikes first, and a slower agent killed before its turn never acts. News that arrives
   during the round (messages, damage, transfers) is read at the next round's decision. A running
   skill acts at the agent's turn without a call; if it ends there without an action the agent
   makes a model decision at that moment (A-SKILL-11).
   An agent that died earlier in the round gets a `skipped_dead` turn record; an agent removed by
   the operator gets `skipped_removed`; agents placed during a round act from the next round. The
   round decision of an agent that died or was removed is recorded in that turn as an unused call
   (failed, never charged; A-SCHED-6).
4. After the last turn the round-end step runs and is saved as `r{round:05d}_end`, in this fixed
   order: plant growth (age, stage, energy/essence inflow), fruit spawning, seed spawning,
   germination, residue decay, upkeep and starvation, deaths, cleanup of empty or rotten entities.
5. A run finishes when no agent is alive or `max_rounds` is reached (no limit by default).

Staged god-mode edits are applied at turn boundaries, before the next turn (or round) starts. An
edit applied between two turns of a round voids the round decisions still waiting (each recorded
as an unused call in its agent's turn, never charged) and the rest of the round decides again from
the edited world. Closing a run mid-round (leaving its page) cancels the waiting calls; they come
back as interrupted calls when the run is opened and the rest of the round decides again.

## One agent turn

1. **Continue a skill** if one is running: it runs local logic up to its next world action
   (at most 100 interpreter ops per turn), performs that one action and pauses until the next
   turn. A resumed skill that finishes, stops or errors without an action falls through to a model
   decision in the same turn.
2. **Wait**: an agent that chose `wait(n)` passes this turn without a model call (upkeep still
   applies).
3. **Model decision** otherwise, made at round start together with everyone else's (A-SCHED-5):
   * the engine built the decision packet at round start, within the agent's input token cap and
     within what it could afford; if it cannot afford the minimum packet the turn is skipped
     (`resource_skip`, decision source `skipped_unaffordable`);
   * `model.call_model` sent it at round start, on the shared pool; at the agent's turn the run
     waits for that answer if it is not in yet (the run shows `waiting_model` meanwhile);
   * cognition is charged from the reported (or estimated) tokens;
   * the reply passes the **format gate** (`model.parse_decision`): strict JSON Decision with
     exactly one action. A failing reply loses the turn (`decision_invalid`; cognition is still
     charged);
   * the decision is applied in order: notebook update, memory priorities, deleted skills, saved
     skills, then exactly one world action or `run_skill`.
4. The turn is committed: a new checkpoint directory plus `manifest.json` (the commit point).

Infrastructure failures of a model call (`timeout`, `error`, `invalid_config`) are never charged
to the agent: the run enters the `error` state and the same turn is re-run after **Recover
(pause)**. Agent-output failures (`malformed`, `refusal`, `truncated`) are charged (shipped
default `charge_failed_calls` true) and lose the turn.

## Economy

### Compute

Total compute spent = cognition + world actions + interpreter work + upkeep. Compute never goes
negative.

* **Cognition** (thinking): `mind_multiplier × (0.0002 × input_tokens + 0.001 × output_tokens)`,
  charged after the reply, capped at the balance; any excess is recorded as uncharged. Example: a
  5,000-token packet and a 600-token reply cost 1 + 0.6 = 1.6 compute. The mind multiplier is 1.0
  for every shipped model. The agent learns the charge from a system record.
* **Affordability**: the packet shrinks to what the agent can pay for. The minimum is
  max(1,200 tokens, the mandatory part) of input with a generation allowance halved down to 200
  tokens; below that the turn is skipped.
* **World actions** have prices (table below). A saved skill pays 80% of the compute price.
* **Interpreter work**: 0.01 compute per op when a skill runs.
* **Upkeep**: 1 compute per round at round end. Not paid in full means **starvation**: the agent
  pays what it has and loses 5 health. An agent at 100 health with no compute dies after 20
  rounds.

In-world compute is not money. Real provider spend is a separate ledger on the run
(`Manifest.real_usage`, optional `real_budget_usd` that stops the run when reached). The
assistant's own spend is a third, separate ledger (see "The assistant").

### Essence

Held up to `essence_capacity`, spent only on upgrades. Fruit holds no essence: essence comes only
from absorbing residue (left by dead agents and killed plants) and from transfers. Raising the
capacity adds no essence.

### Health

Damage and starvation reduce it; at 0 (or below `eps`) the agent dies at once. `recover(budget)`
turns compute into health 1:1, only as much as is missing. Raising max health does not heal.

## Actions

Exactly one per turn. Prices are shipped defaults; "in a skill" is 80% of the compute part.

| Action | Effect | Price | In a skill |
| --- | --- | --- | --- |
| `move(direction)` | one step up/down/left/right; mountains and the region edge block | 5 | 4 |
| `observe(point, page)` | terrain and living entities (id, kind, position) at a point within vision range, 40 per page | 1 | 0.8 |
| `query(entity)` | details of one visible entity; `query("self")` returns exact balances, stats, costs and upgrade quotes | 1 | 0.8 |
| `send(recipient, message)` | message to one visible agent within communication range (≤ 256 tokens) | 3 | 2.4 |
| `broadcast(message)` | message to every living agent within communication range (charged even if nobody hears) | 7 | 5.6 |
| `absorb(source, resource)` | take compute or essence from fruit or residue at the same point; keep only the absorption fraction | 3 | 2.4 |
| `transfer(recipient, resource, amount)` | give compute or essence to an agent at the same point | 1 + amount | 0.8 + amount |
| `recover(compute_budget)` | turn compute into health 1:1, only the useful part | the useful budget | 80% of it |
| `attack(target, compute_budget)` | damage = attacker's attack × the full budget, at most the attacker's attack cap, to an agent or plant at the same point | the budget, cut to attack cap ÷ attack | 80% of it |
| `upgrade(attribute)` | one step of a stat (see "Upgrades") | compute + essence | 80% of the compute part |
| `wait(rounds)` | pass this turn and the next rounds − 1 turns | 0 | 0 |
| `run_skill(skill, arguments)` | start a saved skill (runs up to its first action this turn) | the skill's first action | |

### Check order and failure reasons

`world.apply_action` checks, in order: the actor is dead (`dead`, no charge); the quote cannot be
computed (`invalid_argument`, no charge); an upgrade at its hard cap (`at_limit`, attempt fee
only); the action is unaffordable (`insufficient_compute` / `insufficient_essence`, no debit);
the action is illegal (`blocked`, `out_of_range`, `target_gone`, `empty_source`, `at_limit`,
`invalid_argument`: only the **attempt fee** = min(1, price), × 0.8 in a skill, never essence);
otherwise success with the full charge. Every failure still uses the turn. Two more reasons
appear on turn records: `invalid_action` (the reply failed the format gate, or `run_skill` named
an unknown skill) and `skill_error` (a skill runtime error).

Ranges: `absorb`, `transfer` and `attack` need the target at the same point; `observe` and
`query` use vision range; `send` and `broadcast` use communication range. A message recipient sees
the sender's id only if the sender is within the recipient's own vision range; otherwise the
source is "unknown".

### Absorption

`absorb` has no amount. Compute: all available compute in the source is processed, the agent
keeps `compute_absorption` of it (20% shipped) and the rest is destroyed. Example: a 60-compute
fruit yields 12 compute for a 3-compute price (9 net) and is emptied. Essence: only as much as
fills the free capacity is processed at `essence_absorption` (10% shipped); the rest stays in the
residue. An empty source or a full essence capacity fails instead of destroying anything.

## Upgrades

`upgrade(attribute)` buys one step of one of 11 attributes. Price for the n-th previous purchase
of that attribute: `25 × 2ⁿ` compute + `2 × 2ⁿ` essence; `attack` costs `100 × 4ⁿ` compute +
`10 × 4ⁿ` essence, and `attack_cap` is priced the same way (its own `attack_cap_*` rule fields). Steps: essence capacity +20, max health +20, vision range +1, communication
range +1, speed +1, compute absorption +0.05, essence absorption +0.05 (both capped at 1.0),
skill count limit +1, skill block limit +20, attack +0.25, attack cap +25. A stat at its cap fails with
`at_limit`.

## Skills

A skill is a small program an agent saves (in `Decision.save_skills`) and runs later with
`run_skill`. Keywords: `SET`, `IF … ELSE … END`, `REPEAT n … END`, `FOR_EACH x IN list … END`,
`CALL skill(args) INTO name`, `RETURN`, `STOP`; expressions with numbers, strings, booleans,
fields (`result.ok`), points `(x, y)`, arithmetic, comparisons and `AND` / `OR` / `NOT`; `self`
and `here` are always defined. A skill is validated when saved (syntax, arity, literal arguments,
call cycles, block limit, count limit; an invalid skill is rejected) and compiled to nine ops.

At run time a skill performs one world action per turn at 80% of its compute price, runs at most
100 ops per turn at 0.01 compute each, keeps its state across turns in the checkpoint and cannot
read incoming events. With the shipped `interrupt_on = []` a running skill is never interrupted by
messages or damage. While it runs, the agent makes no model calls, so skills save cognition.
Shipped limits: 5 skills of at most 100 blocks, 4,000 characters of source, no recursion.

## Knowledge, memory and the believed self

* Each agent has a private knowledge store of **records** (kinds: observation, query,
  action_result, message, operator_voice, damage, system), each with round, importance, tags and a
  read flag, plus a **notebook** (whole-text replacement, up to 400 tokens shipped) and up to 20
  **memory priorities**.
* Observations are snapshots of the round they were made in. Acting on stale knowledge simply
  fails when the engine re-checks the action.
* Messages, damage and the operator's voice are read at the agent's next decision; receiving them
  costs nothing and does not trigger an extra turn.
* **Believed self**: the packet's view of the agent's own state starts from the run-start record
  or the latest `query(self)` and applies only disclosed changes (own costs and effects, damage,
  transfers received, cognition charges). **Upkeep is not disclosed**, so the belief drifts until
  the next `query(self)`.
* **Decision packet**: a system message (stable rules, persona) and one user message with
  sections skills, notebook, recent history, retrieved memories, situation and decision request.
  Mandatory parts come first; unread event bodies, the notebook, recent history (5 decisions),
  retrieved memories (5, ranked by relevance, recency and importance) and skill source fill the
  rest of the input token cap (6,000 tokens; generation allowance 1,000). Shipped context defaults
  are editable per run and per agent.
* **Decision** (the reply): `thought` (≤ 600 characters), optional `notebook_update`,
  `save_skills`, `delete_skills`, `memory_priorities` (≤ 5) and exactly one `action`.

## Plants

Plants are channels from a source outside the world: every living plant on land receives energy
and essence each round. Default species `fruit_tree`, stages (shipped defaults):

| Stage | From age | Inflow per round | Store limit (energy / essence) | Fruit | Seeds |
| --- | --- | --- | --- | --- | --- |
| sprout | 0 | 2 energy, 0.2 essence | 60 / 10 | none | none |
| sapling | 5 | 6 energy, 0.5 essence | 120 / 25 | every 8 rounds | none |
| mature | 15 | 12 energy, 1.0 essence | 180 / 60 | every 5 rounds | every 20 rounds |

Fruit is a separate entity holding 60 compute (paid from the plant's energy), at most 3 per plant,
never rots by default. Seeds land on a random land point within 1 step, at most 2 alive per plant,
and germinate after 10 rounds into a sprout with 5 essence. A living plant's essence cannot be
absorbed; attacking a plant reduces its essence and at 0 it dies, leaving 50% of its pre-hit
essence as residue (its stored energy is lost). A run starts with 12 mature fruit trees with one
ripe fruit each, the first ones on the agents' start points.

## Deaths and residue

An agent at health ≤ 0 dies at once: a **residue** entity at its point receives 40% of its essence
and 50% of its compute (only if > 0); its balances become 0, a running skill stops, and it stays
on the map with `alive = false` (excluded from observe, targeting and initiative). Residue does not
decay by default; anyone at the point can absorb it. The `death` event names the entity and the
cause (`attack`, `starvation` or `operator`) but not the killer: the killer is the actor of the
same turn's `damage` event against that entity.

## Model calls and the models

Agents use registry keys (README "Models and credentials"): deterministic free fakes
(`fake-heuristic`, `fake-scripted`, `fake-malformed`), the Claude Code CLI (`claude-cli-haiku`,
`claude-cli-haiku-prompted`) and API providers. Every call goes through `model.call_model` and is
recorded in the turn (`model_calls/mc_<turn>_NN.json`: request, raw output, parsed decision,
usage, provider cost, latency). Result statuses: `ok`, `malformed`, `refusal`, `truncated`,
`timeout`, `error`, `invalid_config`. Keys marked `assistant_only` (`claude-cli-sonnet-assistant`,
`claude-cli-haiku-assistant`, `fake-assistant`) are reserved for the assistant and rejected on
agent cards and in god mode.

## Run states and commands

States (`RunState`): `paused`, `running`, `pause_requested`, `turn_active`, `waiting_model`,
`error`, `finished`. A new or resumed run always opens **paused**.

| Command | Allowed in | Effect |
| --- | --- | --- |
| `run_turn` (**Run turn**) | paused, finished | one agent turn (or the round-end step), then pause |
| `play` (**Play**) | paused, finished | turns continuously with `play_delay_seconds` (0.2 shipped) between them |
| `pause` (**Pause**) | any; acts in running, turn_active, waiting_model, error | stop before the next turn; a running turn finishes and is saved first (`pause_requested` then `paused`); in `error` it discards the failed attempt (**Recover (pause)**) |
| `step_round` (**Step round**) | paused, finished | run to the end of the current round, then pause |

A command in any other state is refused with 409 `illegal_command`. Only one backend process may
hold a run open (a file lock); another process can still read its history. Leaving the run page
closes the run after 400 ms.

## Storage layout

Everything lives under `EMPYREAN_WORLDS_DIR` (default `worlds/`, gitignored):

```
worlds/
  _assistant/                              assistant data that belongs to no run
    conversations/<conv_id>/meta.json      title, scope (mutable run_id; null = global), usage
    conversations/<conv_id>/messages.jsonl the transcript (steps, refs, errors)
    conversations/<conv_id>/briefs.json    execution briefs and their lifecycle
    usage.jsonl                            global assistant ledger (one line per model call)
  world_<stamp>_<hex>/runs/run_<stamp>_<hex>/
    manifest.json        commit point: current turn, counters, real-usage ledger, parent
    archive.json         only while the run is archived: {archived_at, note} (hidden from the run list)
    run_request.json     the request the run was created from
    assumptions.json     the assumption table in force at creation
    working/             editable copy of the latest checkpoint (literal god mode)
    staged_snapshots/    snapshots of staged file reloads
    turns/index.jsonl    one line per committed turn
    turns/<turn_id>/     state.json, events.json, world.json, map/rules/settings.json,
                         entities/..., decision_packets/, model_calls/
    assistant/           the assistant's per-run data (never inside turns/)
      settings.json      storybook_auto, auto_since_turn_id, storybook and chat budgets
      usage.jsonl        the run's assistant ledger
      storybook/entries/<turn_id>.json, storybook/entries/opening.json
      stories/<story_id>/story.json, stories/<story_id>/chapters/<NNNN>.json
```

Turn ids: `r00000_init`, `r{round:05d}_t{index:02d}_{agent_id}`, `r{round:05d}_end`. Walk
`turns/index.jsonl`, never a directory listing (lexical order puts `r00001_end` before
`r00001_t01_…`). Checkpoints are never modified after commit; recovery after a crash discards
half-written turns and never touches `assistant/`. Details: `docs/INTERFACES.md` section 5.

Archiving a run (Resume page) only writes `archive.json`: the run leaves the default list
(`GET /api/runs`), shows in the archive view (`?archived=1`), and keeps all of its data; restoring
removes the file. Recovery never touches the marker and continuations do not copy it. Deleting a run
removes its whole folder for good, including its turns, storybook and stories, and then the world
folder if no run is left in it. The backend refuses to delete a run that is open (409
`run_in_use`), so leave a run before deleting it.

## God mode, interventions and continuations

* **Interventions** (typed god-mode edits): `set_stat`, `place_entity`, `remove_entity`,
  `edit_knowledge`, `voice` (the "voice from nowhere": a message whose source is unknown),
  `update_context_settings`, `update_plant_rules`, `update_prices`, `update_model_assignment`,
  `update_run_settings`, and `apply_working_files` (from a `working/` reload). Each is validated
  when staged (422 `invalid_intervention` with problem paths), applied in staging order at the
  next turn boundary of the **live** run (even while a past turn is being viewed), and recorded in
  that turn with before/after values, its origin (`ui`, `file` or `assistant`) and an
  `intervention` or `operator_voice` event. Nobody is charged. Staged edits can be discarded.
* **Literal god mode**: pause, edit JSON files in the run's `working/` folder, then **Reload
  working/ files**. Invalid files are reported and nothing changes; valid changes are staged as
  one `apply_working_files` edit applied as a field diff (A-GOD-1).
* **Continuations**: **Create continuation from turn …** copies a committed turn into a new run
  in the same world (parent recorded, new ledger) and opens it paused. The original run is never
  changed; history cannot be rewritten in place.

## The assistant

A drawer available on every page (docked beside the run page on wide screens). It has four
**profiles** that share one engine, one ledger and one set of read tools: **chat** (the drawer:
help, analysis, command proposals; Sonnet by default), **narrator** (storybook entries; Haiku),
**author** (Story Mode briefs and chapters; Sonnet) and **summarizer** (conversation memory and
story-so-far; Haiku). Details, budgets and routes: `docs/ASSISTANT.md`.

* **Knowledge**: these docs (docs/INDEX.md marks which ones) plus read-only tools over the run's
  records (status, turn and round digests, agent dossiers, events, model calls, staged edits,
  storybook, defaults, the server log). Numbers about a specific run come from its records, never
  from the docs. Agent thoughts are beliefs, not facts.
* **Execution briefs**: the assistant never changes anything itself. It proposes a typed action
  (create a run, run a command for 1-50 rounds, stage interventions, create a continuation, open a
  run, change its own settings); the backend validates it; the card shows deterministically what
  will happen; only **Approve** executes it (once, server-side). Interventions it stages carry
  origin `assistant`.
* **Conversations** are stored under `worlds/_assistant/conversations/` and scoped to a run or to
  the global pages; after an approved "create run" the conversation follows into the new run.
  There is no memory across conversations: the run's records are the memory.
* **Spend** is metered separately from the agents' economy: per-scope chat budget (5 USD shipped),
  per-run storybook budget (2 USD), per-story budget (5 USD), per-message cap (0.75 USD) and a
  global cap (20 USD). Nothing the assistant spends touches `real_usage` or the run budget.

## Storybook and Story Mode

* **Storybook** (the fifth run-page tab): an AI-written narrative with one entry per committed
  turn, round-end entries and an opening entry written at run creation. It is stored beside the
  run, never inside `turns/`, and is labelled "AI-written narrative; the Turn record has the
  facts". Automatic narration is on for new runs unless a paid narrator would narrate an
  all-fake-agent run; existing runs start off; history is only written on request ("Write
  missing"). The deterministic **Turn record** tab is unchanged and remains the source of truth.
* **Story Mode** (entry page choice, `#/story`): pick a run, answer a short interview (genre,
  tone, vividness, point of view, turn range), review a **story brief** (title, premise, style,
  cast, chapter plan with cost and time estimates) and Accept, Change or Cancel. Chapters (one per
  turn by default; quiet turns become short interludes) are written a few ahead of the reader,
  can be generated all at once on request, and export to Markdown.
* **Dictate**: a microphone button in the assistant composers transcribes up to 60 s of speech
  locally (faster-whisper `large-v3-turbo` on the CPU). It never sends the text by itself. It
  needs a secure context (open the UI via `localhost`).

## Common misreadings

* Speed only sets turn order; it gives no extra actions and no longer moves. But because every
  agent decides at round start and the actions resolve in speed order, being faster decides who
  gets a contested fruit, who strikes first, and who escapes before a slower attack resolves.
* Agents decide from the world at round start: a message or an attack from a faster agent in the
  same round is seen at the next round's decision, not the current one.
* Vision and communication range start at 0: agents see and talk only on their own point, and
  `observe` of the own point is the only legal observe at the start.
* Absorbing compute consumes the whole fruit and keeps only the absorption fraction (20%): a
  60-compute fruit gives 12.
* Essence exists only in residue (deaths) and transfers; fruit has none.
* Attack damage uses the full budget even though a skill pays only 80% of it.
* One attack deals at most the attacker's attack cap (50 to start): a budget above attack cap ÷
  attack is cut and only the cut part is charged, so a fresh 100-health agent takes two hits and
  gets a turn in between to flee, recover or strike back. Upgrading the cap costs as much as
  upgrading attack.
* A failed action still uses the turn and costs up to 1 compute (nothing when unaffordable).
* Thinking costs compute every model turn; a running skill avoids model calls.
* Upkeep is hidden from the agent's believed self; `query(self)` gives exact values.
* A running skill ignores messages and damage unless `interrupt_on` is configured.
* `query` of another agent never reveals its compute or essence.
* A message's sender is "unknown" unless the sender is within the recipient's vision.
* Dead agents stay on the map with `alive = false`.
* The `death` event does not name the killer; pair it with the same turn's `damage` event.
* God-mode edits change the live run at its next turn boundary, even while history is shown; only
  a continuation changes "the past".
* `starvation` is its own event kind (health loss after unpaid upkeep), separate from `upkeep`.
* Storybook text and Story Mode chapters are model-written; the Turn record, events and model-call
  records are the facts.
