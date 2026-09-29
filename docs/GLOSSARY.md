# Glossary

Every domain term as the code implements it. Audience: operators, developers and the built-in
assistant (part of its always-loaded knowledge). Numbers are shipped defaults; see
`docs/SYSTEM.md` for how the pieces fit and `docs/ASSUMPTIONS.md` for config keys.

## World and entities

* **Empyrean**: the only realm in the prototype; a flat integer grid (default −10..10 on both axes).
* **Point**: a grid coordinate `{x, y}`. Decisions must write it as `{"x": int, "y": int}`; god
  mode and skills also accept `[x, y]` or `"x,y"`.
* **Terrain**: `land`, `mountain` (impassable) or `water` (walkable, nothing grows).
* **Entity**: an `agent`, `plant`, `fruit`, `seed` or `residue`. Ids: agents `a01`.., plants
  `p0001`.., fruit `f0001`.., seeds `s0001`.., residue `res0001`..; ids are never reused.
* **Agent**: a model-driven entity created from an agent card. Stays on the map after death with
  `alive = false`.
* **Agent card**: the setup form entry for one agent (id, name, model, position, stats, persona,
  notebook, initial skills, context overrides). A run has 6 to 64 cards.
* **Persona**: operator-written text injected into the agent's stable rules.
* **Persona tip**: a fixed paragraph appended after the persona when the context setting `persona_tip`
  is on (the default for new runs): repeated routines can be saved as skills that cost no thinking while
  they run, and other agents are options (message, give compute, attack, absorb what the dead leave). It
  names options, never goals. See SYSTEM.md "Agents" and A-KNOW-9.
* **Plant / species**: a stationary source of energy and essence growing through stages
  (`fruit_tree`: sprout, sapling, mature). **Vitality** is a plant's essence.
* **Fruit**: an entity holding compute (60 shipped) spawned by a plant; no essence.
* **Seed**: an entity that germinates into a sprout after a delay (10 rounds shipped).
* **Residue**: what a death leaves: a share of the dead entity's compute and essence, absorbable
  by anyone at the point.
* **Removed**: an entity deleted by the operator (`remove_entity`); listed in `removed.json`.

## Resources and stats

* **Compute**: energy; pays for cognition, actions, interpreter ops and upkeep. Never negative.
* **Essence**: spent on upgrades only; held up to **essence capacity**.
* **Health / max health**: 0 is death.
* **Attack**: damage per unit of attack budget.
* **Attack cap** (`attack_cap`): the most damage one attack can deal (50 to start, +25 per
  upgrade, priced like attack). A larger budget is cut to attack cap ÷ attack and only that is
  charged; a target with more health needs several hits (A-ACT-19).
* **Speed**: initiative order only: the order in which the round's decisions resolve, so the
  faster agent gets a contested fruit or strikes first (A-SCHED-5). Never extra turns.
* **Vision range / communication range**: Manhattan distance for observe/query and send/broadcast
  (0 at the start: own point only).
* **Compute absorption / essence absorption**: the fraction kept when absorbing (0.20 / 0.10).
* **Skill count limit / skill block limit**: how many skills and how many blocks per skill (5 / 100).
* **Upgrade**: buying one step of an attribute with compute and essence; **at_limit** at the cap.
* **Upkeep**: 1 compute per round charged at round end.
* **Starvation**: unpaid upkeep; the agent loses 5 health (event kind `starvation`).
* **Cognition cost**: `mind_multiplier × (0.0002 × input tokens + 0.001 × output tokens)`.
* **Mind multiplier**: per-model factor on cognition (1.0 for every shipped model); snapshotted
  into the run's rules at creation.
* **Uncharged compute**: the part of a cognition cost the agent could not pay.
* **Attempt fee**: what a legal-to-afford but failing action costs: min(1, price), × 0.8 in a skill.
* **Real usage / real budget**: the provider cost of the agents' model calls in USD
  (`Manifest.real_usage`) and the optional per-run limit `real_budget_usd`. Separate from compute
  and from the assistant's spend.

## Time and turns

* **Round**: every agent that thinks decides at round start (all at once), then every living agent
  acts once in initiative order, then the round-end step.
* **Round decision** (A-SCHED-5): an agent's model decision for the round, made at round start
  from the world and its knowledge as they were then; all of a round's model calls run at the
  same time (`EMPYREAN_MODEL_CONCURRENCY`). It resolves at the agent's turn, checked against the
  world as the faster agents left it. An **unused decision** (the agent died or was removed before
  its turn, or an operator edit landed mid-round) is recorded as a failed call, never charged
  (A-SCHED-6).
* **Turn**: one committed step: `init`, `agent_turn` or `round_end`.
* **Turn id**: `r00000_init`, `r{round:05d}_t{index:02d}_{agent}`, `r{round:05d}_end`.
* **Initiative**: the per-round order (sorted ids, seeded shuffle, stable sort by speed).
* **Decision source**: how an agent turn was decided: `model`, `skill`, `wait`,
  `skipped_unaffordable`, `skipped_dead`, `skipped_removed`, `none`.
* **Turn boundary**: the moment between two turns when staged interventions are applied.
* **Checkpoint**: the complete saved state of one turn (`turns/<turn_id>/`), immutable.
* **Commit point**: writing `manifest.json` after the turn directory is in place.
* **Live / history**: the run page follows the latest saved turn (live) or shows an older one
  (history, read-only).

## Actions and results

* **Action**: one of `move`, `observe`, `query`, `send`, `broadcast`, `absorb`, `transfer`,
  `recover`, `attack`, `upgrade`, `wait`, or `run_skill`.
* **Action result**: `{ok, reason, cost_compute, cost_essence, round, data, effects}`.
* **Failure reasons**: `blocked`, `out_of_range`, `insufficient_compute`, `insufficient_essence`,
  `target_gone`, `at_limit`, `empty_source`, `invalid_argument`, `dead`, `invalid_action`,
  `skill_error`; `ok` on success.
* **Via skill**: an action performed by a running skill (80% compute price).

## Minds

* **Decision**: the JSON reply: `thought`, `notebook_update`, `save_skills`, `delete_skills`,
  `memory_priorities`, one `action`.
* **Format gate**: `model.parse_decision`; a reply that fails it loses the turn
  (`decision_invalid`) and is still charged.
* **Salvage**: the deterministic repair of a reply's JSON envelope (unwrap nesting, decode a
  stringified decision, `think` -> `thought`) before the format gate rejects it; no model call
  (`salvage.salvage_json`, `salvage.salvage_decision`, A-COG-11). A salvaged call records
  `salvaged_from`, the original problem.
* **Decision packet**: exactly what the model was given for one decision (`pk_<turn_id>`).
* **Stable rules**: the rules text at the top of every packet.
* **Knowledge record**: one remembered item (`<agent>-k000001`), kinds `observation`, `query`,
  `action_result`, `message`, `operator_voice`, `damage`, `system`.
* **Notebook**: the agent's private free text, replaced whole by `notebook_update`.
* **Memory priorities**: up to 5 record ids per decision the agent marks as important.
* **Digest**: one short line per urgent unread record in the packet.
* **Believed self**: the agent's derived view of its own state (no upkeep); **query(self)** gives
  exact values.
* **Context settings**: input token cap (6,000), generation allowance (1,000), recent history (5),
  notebook size (400 tokens), retrieved memories (5), digest limit (10), retrieval weights,
  include skill source. **Context overrides** set them per agent.
* **Resource skip**: a turn skipped because the agent cannot afford the minimum packet.
* **Skill**: a saved program; **skill execution state** is its call stack, kept across turns.
* **Interpreter op**: one executed skill instruction, 0.01 compute; at most 100 per turn.
* **Model call record**: `mc_<turn>_NN`: request, raw output, parsed decision, usage, cost.
* **Model statuses**: `ok`, `malformed`, `refusal`, `truncated` (agent-output failures, charged)
  and `timeout`, `error`, `invalid_config` (infrastructure failures, never charged; the run
  enters `error`).

## Runs and operator

* **Run**: one simulation with its own folder, manifest and turn history. **World**: the terrain
  and region shared by a run and its continuations.
* **Run state**: `paused`, `running`, `pause_requested`, `turn_active`, `waiting_model`, `error`,
  `finished`.
* **Run command**: `run_turn`, `play`, `pause`, `step_round`.
* **Recover (pause)**: the `pause` command in the `error` state: discard the failed attempt,
  reload the last saved turn.
* **God mode**: operator edits. **Intervention**: one typed god-mode edit; **staged** until the
  next turn boundary; **origin** `ui`, `file` or `assistant`.
* **Voice (from nowhere)**: the god-mode message intervention; recipients hear it from an unknown
  source. Not speech input (that is **Dictate**).
* **Literal god mode / working files**: the editable `working/` copy of the latest checkpoint,
  staged with **Reload working/ files** as `apply_working_files`.
* **Continuation**: a new run started from a saved turn of another run (its **parent**).
* **Assumption**: a documented default for a rule the design leaves open (`A-…` ids).
* **Scenario overlay**: a partial run request deep-merged onto the defaults
  (`scripts/scenarios/*.json`, `run_sim.py --request`, the assistant's create-run brief).

## Map views

* **2D map / 3D view**: the two views of the run page's centre column, chosen with the **Map view**
  switch and remembered per browser. Both draw the viewed turn from the same data; the 3D view's
  code (three.js) loads only when it is chosen.
* **Effect**: one thing the viewed turn did (a move, attack, message, absorb, transfer, death,
  growth, fruit, seed, germination, starvation, operator voice, …), read from the turn's saved
  record and its own events. Both views draw their marks and animations from the effects only.
* **Action mark**: a drawing on the 2D map of an effect of the viewed turn (live: the last saved
  turn): the acting agent's badge with its action glyph (red = failed), a move arrow, rings on the
  entities touched, links, the observed cell, the broadcast reach and printed amounts. The
  **caption** in the first status line says the same in words.
* **Packed cell**: a 2D cell whose occupants do not fit at normal spacing; its dots move closer
  together and it gets a **count badge** (the total occupants, top-right corner). At the largest
  zoom a cell that still does not fit is **over capacity**: it shows as many dots as fit.
* **Group tile**: the one square per occupied cell that the 2D map draws below 24 px cells
  (bigger = more occupants, blue = an agent is there).
* **Action chip**: in the 3D view, the label with an icon over the actor that names the viewed
  turn's action or world event; it stays while that turn is viewed.
* **Layer (3D)**: one board of the 3D view's stack, 3 scene units above the one below it. A run has
  one layer today ("Layer 1 of 1 · World"); the stack is a seam for later.

## Assistant

* **Assistant**: the built-in helper in the drawer; see `docs/ASSISTANT.md`.
* **Profile**: `chat`, `narrator`, `author` or `summarizer`: one engine with different prompts,
  tools, output format and model.
* **Assistant-only model**: a registry key with `options.assistant_only` (hidden from agent
  pickers, rejected on agents).
* **Conversation**: a stored chat thread, scoped to a run or global (`run_id` null).
* **Step**: one model call within the answer to one message (at most 4).
* **Read tool**: a read-only function the chat profile may call (for example `get_turn_digest`).
* **Context chip**: what the user is looking at (page, run, viewed turn, selection), sent with a
  message.
* **Execution brief**: a proposed typed action with deterministic "What will happen" text,
  validation problems and warnings; lifecycle `pending`, `executing`, `executed`, `failed`,
  `rejected`, `superseded`, `invalid`.
* **Approve / Ask for changes / Reject**: the brief buttons. Approve executes once, server-side.
* **Ledger**: the assistant's `usage.jsonl` per scope; **budget**: a spend limit (chat per scope,
  storybook per run, story per job, per message, global).
* **Storybook**: AI-written per-turn narrative of a run (the Storybook tab); **entry**: one turn's
  text; **opening**: the entry written at run creation; **auto**: automatic narration of new
  turns; **Write missing**: explicit catch-up of unwritten turns.
* **Story Mode**: turning a run into a chaptered story: **run card** (deterministic summary),
  **interview**, **story brief**, **chapters**, **interlude** (a short chapter for a quiet turn).
* **Dictate**: speech-to-text input for the assistant composers (local Whisper).
* **Turn record**: the deterministic, fact-based account of a turn in the run page tab of that
  name; unrelated to the storybook.
