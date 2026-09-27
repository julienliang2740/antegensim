# Configurable assumptions

Every gameplay rule the design document leaves open (or marks as a suggestion) that the
implementation must nevertheless settle, plus the settled defaults of the built-in assistant
(A-AST-*). Each has a config key, the chosen default, and a
citation. The registry of record is `config.ASSUMPTIONS` in `backend/empyrean/config.py`; it is
written once per run to `assumptions.json` and served read-only by `GET /api/assumptions`
(defaults) and `GET /api/runs/{run_id}/assumptions` (as recorded). It is NOT part of
`rules.json`: changing a default means changing the config value (or editing the named rule
key in god mode), not the code.

Citations: **D** = `llm_world_running_design.md` v0.7, **S** = `llm_world_technical_spec.md` v0.5.

The ids in the tables below equal the keys of `config.ASSUMPTIONS` (checked by
`scripts/check_docs.py`); add or remove both in the same commit. The values are shipped
defaults; a run's own values are on its Rules tab.

## Death and residue

| ID | Rule | Config key | Default | Citation |
| --- | --- | --- | --- | --- |
| A-DEATH-1 | Fraction of held essence that becomes residue at agent death | `rules.death.essence_residue_fraction` | 0.4 | D "Agent death and essence residue" (fraction "still undecided"; 40% illustrative) |
| A-DEATH-2 | Fraction of held compute that becomes residue at agent death | `rules.death.compute_residue_fraction` | 0.5 | D "Residue and extraction" ("Compute residue policy ... parameters to settle") |
| A-DEATH-3 | Residue decay per round (fraction) | `rules.death.residue_decay_per_round` | 0.0 (persists) | D "Residue and extraction" (persistence/decay open) |
| A-DEATH-4 | Plant residue essence at death = pre-hit living essence × fraction | `rules.plant_species.<name>.essence_residue_fraction` | 0.5 | D "Conflict injury and extraction" plant compatibility suggestion |
| A-DEATH-5 | Plant stored energy at death becoming residue compute | `rules.plant_species.<name>.energy_residue_fraction` | 0.0 (lost) | D "Residue and extraction" (plant energy at death unspecified) |
| A-DEATH-6 | Dead agents/plants stay in the world (`alive=false`, balances and health 0, position kept); excluded from observe, targeting and initiative (actions → `target_gone`); residue created only when compute or essence > eps; an operator edit leaving a living agent at health ≤ 0 resolves `kill_agent(cause="operator")` at the boundary | engine rule | as stated | D "Agent death" (resolved once); S "God mode" (valid state), "Display" (after-death) |

## Cognition and metering

| ID | Rule | Config key | Default | Citation |
| --- | --- | --- | --- | --- |
| A-COG-1 | Conversion rates: cost = mind × (input_rate × input + generation_rate × output) | `rules.cognition.input_rate / generation_rate / default_mind_multiplier` | 0.0002 / 0.001 / 1.0 | D "Compute metering"; open decision 1 |
| A-COG-2 | Minimum packet before an agent is skipped for the turn | `config.MIN_PACKET_INPUT_TOKENS` / `MIN_GENERATION_TOKENS` | 1200 / 200 tokens | S "Budget delivery and inspection" |
| A-COG-3 | Agent-output failures (malformed/refusal/truncated) charge reported usage; safety factor applies only to estimated usage | `rules.cognition.charge_failed_calls` / `usage_estimate_safety_factor` | true / 1.0 | D "Compute metering" implementation note |
| A-COG-4 | Token estimate heuristic (single definition `config.estimate_tokens`) | `config.TOKEN_CHARS_PER_TOKEN` | ceil(len/4) | lead decision |
| A-COG-5 | Infrastructure failures (timeout/error/invalid_config after retries): `model_call_failed` with `infra=true`, no charge, no agent turn committed; run enters `error`; pause recovers and the same turn is re-run | runner rule | as stated | S "Two distinct validation gates"; D "Compute metering" caution |
| A-COG-6 | Cognition above the balance is charged up to the balance; the rest is recorded as `uncharged_compute` | runner rule | as stated | D "Compute metering" |
| A-COG-7 | Real-expense ceiling: "reached" when the ledger's `provider_cost_usd` > 0 and ≥ the budget (a fake run with budget 0 never trips), checked before each call and again after it; a post-call trip records the measured usage uncharged and carries the call record into the re-run; the run enters `error` ("host budget exhausted") | `settings.real_budget_usd` | null (no limit) | D "Compute metering" caution |
| A-COG-8 | Provider schema/tool overhead (`model.request_overhead_tokens`) counts in the mandatory packet size and the reservation | runner/context rule | as stated | S "Budget delivery" ("Count instructions and schemas too") |
| A-COG-9 | claude_cli: model requests the CLI may spend on one decision. The CLI cannot force the StructuredOutput tool choice; when the model's first response is text only it re-prompts once and its envelope sums both requests' usage and cost. Up to this many requests the reply is accepted, charged in full and noted in `attempt_errors`; more is an infrastructure `error`. Live evidence: 1 of 22 Haiku decisions; rejecting it halted the run with a valid decision in hand. No delivery hint is added to the system prompt: a "call StructuredOutput with the JSON object as its input" line made Haiku wrap the decision under an `input` key (24 of 24 decisions malformed) | `config.CLI_MAX_MODEL_REQUESTS` / registry `options.max_model_requests` | 2 | D "Compute metering" ("Charge measured usage after the call"; retries need "an experiment-wide accounting policy") |
| A-COG-10 | claude_cli: `MAX_THINKING_TOKENS` for the subprocess. 0 turns extended thinking off; live it took 40-70% of the output tokens (668 of a 968-token reply under the 1000-token allowance), competing with notebook and skill text and doubling latency. The `thought` field stays the agent's paid reasoning. `null` keeps the CLI default | `config.CLI_MAX_THINKING_TOKENS` / registry `options.max_thinking_tokens` | 0 | D "Compute metering" (generated tokens include "any separately reported reasoning usage"); S "Budget delivery" |
| A-ECON-2 | Reservation: reserve = cost(input cap, generation allowance) bounded by balance; charge actual after the call; nothing is deducted up front | runner rule | as stated | D "Compute metering" suggested enforcement |

## Actions and ranges

| ID | Rule | Config key | Default | Citation |
| --- | --- | --- | --- | --- |
| A-ACT-1 | absorb/transfer/attack require the same point; observe/query use vision range; send/broadcast use communication range (Manhattan) | `rules.ranges.*` | all true | D "Action blocks" suggested range defaults |
| A-ACT-2 | Moving outside the generated region is always refused (entities stay inside the region); the flag only picks the reason: true → `blocked` (like a mountain), false → `out_of_range` | `rules.ranges.outside_region_is_blocked` | true | D "Spawned terrain and passage" (generation deferred) |
| A-ACT-3 | Message size limit measured as ceil(len/chars_per_token); longer or empty messages fail with `invalid_argument` and the attempt fee | `rules.messages.max_message_tokens` / `chars_per_token` | 256 / 4 | D "Action blocks" suggested message limit |
| A-ACT-4 | observe page size; a page past the end is ok with an empty list; `generate_world` copies the value to `WorldState.observation_page_size`, which the run keeps (editable in god mode) | `world.max_entities_per_observation_page` | 40 | D "Observe query and action feedback" (pagination allowed) |
| A-ACT-5 | Public fields when querying another agent | `world.public_entity_data` | id, name, position, health, max_health, attack, attack_cap, speed, alive | D query table "Visibility choice" |
| A-ACT-6 | Transfer recipients | engine rule | living, visible agents at the same point only | D "Action blocks" (plants excluded) |
| A-ACT-7 | `wait(n)` consumes this turn and the next n−1 turns; no model call while waiting; events still accumulate | engine rule | as stated | D "Turns speed and skill execution" |
| A-ACT-8 | Attack on a dead/absent/unseen target → `target_gone`, attempt fee min(1, budget) | engine rule | as stated | D "Conflict injury" |
| A-ACT-9 | Failed attempt fee cap (both direct and skill mode; × discount in a skill) | `rules.accounting.failure_fee_cap` | 1.0 | D "Failure and resource handling" (min(1, price)) |
| A-ACT-10 | Recovery conversion | `rules.recovery.health_per_compute` | 1.0 | D "Health damage and recovery" (suggested) |
| A-ACT-11 | Upkeep and starvation | `rules.upkeep.compute_per_round` / `starvation_health_loss` | 1 / 5 | D "Health damage and recovery" (suggested) |
| A-ACT-12 | Broadcast with no recipient in range still succeeds and charges 7 | engine rule | as stated | D "Action blocks" (fan-out follows range) |
| A-ACT-13 | A skill action whose evaluated arguments fail validation receives `ActionResult(ok=false, reason="invalid_argument", cost 0)`; the turn is used, no world call, no fee | interpreter rule | as stated | D "Failure and resource handling"; "Imperative blocks" |
| A-ACT-14 | Visibility first: entity-targeted actions return `target_gone` for any id that is not a living, present entity the caller can see; `out_of_range` only for point arguments and visible entities not at the required distance | engine rule | as stated | D "Observe query and action feedback" ("knowing an old ID does not bypass range") |
| A-ACT-15 | `send` requires the recipient visible AND within communication range (else `target_gone`); `broadcast` reaches everyone in range but reports only `delivered_to_visible`, no total count | engine rule | as stated | D "Coordinates vision and communication" |
| A-ACT-16 | Self-target or wrong entity kind → `invalid_argument` with the attempt fee; absorb checks `empty_source` before `at_limit` | engine rule | as stated | D "Action blocks"; "Absorption efficiency" |
| A-ACT-17 | Accounting epsilon: amounts < eps are empty; absorption stats rounded to 9 decimals and clamped; essence gained = min(raw × eff, free capacity) | `rules.accounting.eps` | 1e-9 | D "Absorption efficiency" ("precise resource accounting") |
| A-ACT-19 | Damage cap per attack: damage = min(attack × budget, attack_cap); a budget above attack_cap ÷ attack is cut and only the cut part is charged (× skill discount); upgradable +25 for `attack_cap_base_compute` × `attack_cap_growth`ⁿ compute + `attack_cap_base_essence` × `attack_cap_growth`ⁿ essence | `stats.attack_cap`, `rules.upgrades.attack_cap_*` | 50 damage; 100 × 4ⁿ + 10 × 4ⁿ; +25 | Operator request 2026-09-27: several exchanges per fight instead of one decisive blow |
| A-ACT-18 | Upgrade at a hard cap: quote shows the formula price, `next_value` = current, `allowed=false`; `at_limit` charges only the attempt fee when affordable, else `insufficient_compute` with no debit | engine rule | as stated | D "Upgradeable attributes and prices" |

## Skills and interpreter

| ID | Rule | Config key | Default | Citation |
| --- | --- | --- | --- | --- |
| A-SKILL-1 | Action calls only as a whole `SET` right-hand side or a bare statement | parser rule | enforced at save | D "Imperative blocks" (examples) |
| A-SKILL-2 | Op budget exhausted before an action: turn consumed, skill resumes next turn | `rules.skills.max_ops_per_turn` | 100 | D interpreter suggestion |
| A-SKILL-3 | Source length bound and the longest string a skill may build with `+` (parser nesting depths of 32 levels are host limits in skills.py, not rules) | `rules.skills.max_source_chars` / `max_string_chars` | 4000 / 4096 | D per-skill block limit (chars are not blocks) |
| A-SKILL-4 | Block counting: statements 1 each; each operator/field access/coord/action call 1; literals, names, ELSE, END 0; CALL 1 in the caller (design example 2 = 48) | `skills.count_blocks` | as stated | D "Minimal agent stats" |
| A-SKILL-5 | A model decision is only taken when no skill is running (or after an interrupt stopped it); `run_skill` never finds a running skill; finished/stopped/error records are replaced | runner rule | as stated | D "Turns speed and skill execution" |
| A-SKILL-6 | Decision processing order: delete_skills, save_skills in list order (each save sees earlier saves), then action; saving or deleting a skill in a running execution's frames stops it | runner rule | as stated | lead decision |
| A-SKILL-7 | Interpreter cost per op and discount | `rules.skills.interpreter_cost_per_op` / `action_discount` | 0.01 / 0.8 | D interpreter suggestion; "Saved skill compute discount" |
| A-SKILL-8 | Recursion rejected at save; call depth limit when enabled | `rules.skills.allow_recursion` / `max_call_depth` | false / 16 | D interpreter suggestion |
| A-SKILL-9 | Knowledge kinds whose unread arrival interrupts a running skill at its resume boundary (`stopped`, "interrupted"); the agent then takes a model decision that turn. Checked at round start with every decision (A-SCHED-5), so an arrival during the round interrupts at the next round | `rules.skills.interrupt_on` | [] (off) | S "Purpose and scope"; D "Observe query and action feedback" |
| A-SKILL-10 | Skills cannot read received events; only `self` and `here` are implicit; data reaches a skill through `run_skill` arguments and action results | interpreter rule | deferred | D "Imperative blocks" ("supplied events") |
| A-SKILL-11 | A skill that ends on a resumed turn without reaching an action emits its event (ops charged) and the agent continues into a model decision in the SAME turn, made at that moment from the world as it is (not a round-start decision); a `run_skill` from a model decision that ends without an action uses the turn | runner rule | as stated | D "Turns speed" ("five moves ... five turns") |
| A-SKILL-12 | `REPEAT` accepts an integer-valued number ≥ 0 (0 = no iterations) up to `max_repeat_count`; literal action arguments are validated at save time | `rules.skills.max_repeat_count` | 10000 | D "Failure and resource handling"; "Imperative blocks" |
| A-SKILL-13 | Op accounting: 1 per executed instruction + 1 per evaluated operator/field/coord node; literals, variables and the action-call node free; when AND/OR short-circuits, neither the right operand nor the AND/OR node is counted (`IF a.ok == true AND b > 1` with `a.ok` false = 1 + 2 = 3 ops; fully evaluated 5, its static maximum); an instruction whose static cost would exceed the budget is not started | interpreter rule | as stated | D interpreter suggestion |
| A-SKILL-14 | Deleting a skill another skill CALLs is rejected ("referenced by X"); re-saving re-checks callers' arity; run_skill/CALL arity exact; `run_skill` of an unknown skill → `skill_error`, no action, no fee, turn used | interpreter/runner rule | as stated | D "Imperative blocks"; S "Persistence requirement" |

## Plants

| ID | Rule | Config key | Default | Citation |
| --- | --- | --- | --- | --- |
| A-PLANT-1 | Stages by age: sprout (0), sapling (5), mature (15); inflow 2/6/12 energy and 0.2/0.5/1.0 essence per round; essence caps 10/25/60; energy caps 60/120/180 | `rules.plant_species.fruit_tree.stages` | as stated | D "Growth leaves fruit and seeds" (stages open) |
| A-PLANT-2 | Fruit is funded from the plant's energy store: spawns when interval elapsed, energy ≥ fruit_energy, live fruit < max_fruit; deducts fruit_energy | engine rule | as stated | D "Plants as channels" suggested first policy |
| A-PLANT-3 | Fruit energy | `rules.plant_species.fruit_tree.fruit_energy` | 60 | D open decision "Do low absorption yields support survival?" |
| A-PLANT-4 | Seeds: mature plants drop one every `seed_interval_rounds` within `seed_dispersal_radius` on land; germinate after `seed_germination_delay_rounds`; `max_seeds_alive` cap per plant; initial plant essence supplied by the source | `rules.plant_species.fruit_tree.*` | 20 / 1 / 10 / 2 / 5.0 | D seed suggestion |
| A-PLANT-5 | Attacks reduce living essence; lethal at ≤ 0; residue from pre-hit essence | engine rule | as stated | D plant compatibility suggestion |
| A-PLANT-6 | Fruit persists until absorbed; with N > 0 removed at age ≥ N (lost compute recorded) | `rules.plant_species.fruit_tree.fruit_decay_rounds` | 0 | D (ripening/regrowth open) |
| A-PLANT-7 | Initial plants placed at the mature stage (schema default equals config) | `world.initial_plant_stage` | 2 | D "Minimum prototype" |
| A-PLANT-8 | Mature plants keep producing fruit and seeds | stage rules | yes | D "Growth leaves fruit and seeds" suggestion |
| A-PLANT-9 | No total world source budget; more plants = more inflow | (none) | unlimited | D suggested first policy |
| A-PLANT-10 | Plants on non-land cells are skipped by growth/inflow/fruit/seed steps; placing a plant or seed on non-land is rejected; a seed on non-land at germination stays dormant | engine rule | as stated | D "Spawned terrain and passage"; "Plants as channels" |
| A-PLANT-11 | Plant energy store cap per stage; inflow above it is not admitted; `total_source_*` record only admitted inflow | `rules.plant_species.<name>.stages[*].max_energy` | 60/120/180 | D "Plants as channels" ("Individual resource stores also have limits") |
| A-PLANT-12 | Counters incremented in step 1; spawn when counter ≥ interval and conditions hold, then reset; blocked spawns keep the counter; `max_fruit`/`max_seeds_alive` per plant | engine rule | as stated | D "Growth leaves fruit and seeds" |
| A-PLANT-13 | Ripe fruit on each initial plant at round 0 (capped by the species `max_fruit`), funded by the source and counted in `total_fruit_produced` / `total_source_energy`; `rounds_since_fruit` stays 0. Without it initial plants start with an empty energy store and the first fruit appears at round 5 (12 energy/round, 60 per fruit, 5-round interval), so no live run shorter than that can exercise absorption. 0 restores the old behaviour | `world.initial_plant_fruit` | 1 | D "Minimum prototype" ("Verify a basic loop: observe a point, query fruit, absorb compute"); "Plants as channels" |

## World generation and scheduling

| ID | Rule | Config key | Default | Citation |
| --- | --- | --- | --- | --- |
| A-WORLD-1 | Region | `world.region` | −10..10 both axes | D "Minimum prototype" |
| A-WORLD-2 | Terrain: seeded clusters, mostly land | `world.terrain` | 4 mountain clusters ×4, 3 water clusters ×5, origin radius 2 clear | D "Spawned terrain" (generation deferred) |
| A-WORLD-3 | Initial plants | `world.initial_plants` | `{"fruit_tree": 12}` on land cells (see A-WORLD-7 for placement) | D "Minimum prototype" |
| A-WORLD-7 | The first initial plants of each species are placed on the agents' final start cells (one per distinct land cell, card order, no rng draw); the rest on uniformly chosen land cells. With vision_range 0 an agent sees only its own cell; in two live worlds (seeds 1 and 3) the nearest uniformly placed plant was 5 steps from the start cluster in an unknown direction, so fruit was unfindable. `false` restores uniform placement | `world.plants_at_agent_starts` | true | D "Minimum prototype" (basic loop verification); "Coordinates vision and communication" |
| A-WORLD-4 | Agent start positions | `config.DEFAULT_AGENT_POSITIONS` | the first 12 cards within Manhattan radius 2 of origin; cards 13-64 on the next rings (radius 3-6) | S "New session" |
| A-WORLD-5 | No terrain occlusion: vision and communication use pure Manhattan distance | engine rule | as stated | D "Spawned terrain" deferred note |
| A-WORLD-6 | A card position on a mountain is moved to the nearest land cell (reported as a `run_created` warning); `POST /api/world/preview` shows terrain beforehand | engine rule | as stated | S "New session" |
| A-SCHED-1 | Initiative: single run RNG (`world.rng_state`); living ids sorted, shuffled, stable-sorted by −speed once at round start | engine rule | as stated | D "Turns speed and skill execution" |
| A-SCHED-2 | Agents dying mid-round keep a `skipped_dead` turn record; their round-start decision (A-SCHED-5) is recorded there as an unused call (failed, never charged) | runner rule | as stated | S "Turn orchestration" step 2 |
| A-SCHED-3 | Run finishes when no living agents remain or `max_rounds` reached; a run command in `finished` applies staged edits and re-checks | `settings.max_rounds` | null (no limit) | S "Sessions and run controls" |
| A-SCHED-4 | A scheduled id removed by an intervention gets a `skipped_removed` turn record; agents placed mid-round join at the next round | runner rule | as stated | S "God mode" |
| A-SCHED-5 | Decisions are simultaneous: at round start every living agent that will think (not waiting, no running skill unless an unread arrival interrupts it) gets its packet from the world and its knowledge as they are then, and all model calls run at once on a process-wide pool; the turns then resolve one by one in initiative order, each action checked against the world as it is at that turn, so speed decides who gets a contested fruit or strikes first | runner rule (pool size `EMPYREAN_MODEL_CONCURRENCY`) | simultaneous (pool 16) | Operator request 2026-09-27; D "Turns speed and skill execution" |
| A-SCHED-6 | A round decision that is never used (agent dead or removed before its turn; every waiting decision when an operator edit lands at a boundary after the decisions were made, after which the rest of the round decides again; calls cancelled by closing mid-round come back as interrupted) is cancelled, recorded as a failed call, charged 0, in the agent's own turn of the round after its `turn_started` (or the round end / final checkpoint) | runner rule | as stated | S "avoid duplicate usage accounting"; INTERFACES section 7 |
| A-ECON-1 | Round-end order: plants → fruit → seeds → germination → residue decay → upkeep/starvation → deaths → cleanup | engine rule | as stated | D "Turns speed and skill execution" |

## Knowledge and context

| ID | Rule | Config key | Default | Citation |
| --- | --- | --- | --- | --- |
| A-KNOW-1 | Importance rule table | `context.importance_of` | damage/death 1.0; resource change ≥ 10 compute or any essence 0.7; failed action 0.5; message 0.6; operator voice 0.8; observation/query 0.3; other 0.2 | S "How selection works" step 3 |
| A-KNOW-2 | Relevance = shared tags (entity ids, points, action names, plan words) / 5 capped at 1; recency = 1/(1+age) | `context.rank_memories` | as stated | S "How selection works" step 3 |
| A-KNOW-3 | Message sender visible only if the recipient can see the sender's point; otherwise "unknown" | engine rule | as stated | D "Coordinates vision and communication" |
| A-KNOW-4 | Context defaults | `context.*` | cap 6000, allowance 1000, history 5, notebook 400, retrieved 5, digest 10, weights 1/1/1 | S "Budget delivery and inspection" |
| A-KNOW-5 | The runner marks a packet's `digest_record_ids` read only after the provider returned a response; never after infrastructure failures or an unaffordable packet | context/runner rule | as stated | S "Budget delivery and inspection" |
| A-KNOW-6 | Self state in the packet is derived from knowledge only: run-start record (card values), latest `query(self)`, then disclosed deltas (own action costs/effects, damage/starvation `health_after`, transfers received, the previous decision's disclosed cognition charge, the interpreter cost disclosed on skill action / skill-step records); upkeep not disclosed unless starving; labelled "as of round N"; the believed position (`BelievedSelf.position`) comes from the run-start record, move effects and `query(self)` only | `context.believed_self` | as stated | S "Knowledge boundary" |
| A-KNOW-7 | `Decision.memory_priorities`: ≤ 5 per decision, ≤ 20 kept per agent, adds min(0.3, 0.3 × priority) to importance | context rule | as stated | S "How selection works" step 3 |
| A-KNOW-8 | Mandatory packet = stable rules + skill catalogue (no source) + core situation (believed self, last result, digest header + one ≤ 40-token line per urgent unread record) + decision request + model overhead; then unread bodies, notebook, history, memories, skill source | context rule | as stated | S "How selection works" step 1 |

## God mode

| ID | Rule | Config key | Default | Citation |
| --- | --- | --- | --- | --- |
| A-GOD-1 | Staged edits are applied at the boundary in staging order, each as a delta onto the state at that moment. A `working/` reload is staged as the field diff of the files against the committed turn and applied AS THAT DIFF (never a wholesale replacement), so UI edits staged before or after it (voice, placements, stat changes, settings) all survive; a field changed by both keeps the value of the edit staged later; a file change whose parent no longer exists (its entity was removed by an earlier staged edit) or a result failing validation (schema, cross-file references, `validate_world`, effective context settings) rejects the whole file edit (`ok=false` with the paths and reasons, nothing of it applied; the other edits still apply); the record's before values are the values found at apply time | runner rule (`storage.apply_working_changes`) | as stated | S "God mode and direct file editing" (both paths "record before/after values, origin and effective boundary"; invalid files "leave the last valid state available"); fix-pass finding (a reload staged after UI edits silently undid them) |

## Assistant (rev 4)

The assistant's defaults are not world rules (they never change a run's `rules.json`), but they
are settled choices with a rationale, so they are registered like the rest. Budgets and models are
environment-overridable (README "Backend options"); `docs/ASSISTANT.md` explains each in context.

| ID | Rule | Config key | Default | Citation |
| --- | --- | --- | --- | --- |
| A-AST-1 | Storybook automatic narration: a new run's `storybook_auto` is ON unless the narrator is a paid key AND every agent model in the run is fake; runs without `assistant/settings.json` (created before the assistant) are OFF; auto covers only turns committed after `auto_since_turn_id` plus the opening entry; history catch-up only on request ("Write missing"); auto pauses with a notice at the run's storybook budget | `config.STORYBOOK_AUTO` (`EMPYREAN_STORYBOOK_AUTO` on/off/auto), `<run>/assistant/settings.json` | `auto` (the rule) | User requirement 5; measured Haiku CLI cost USD 0.0081 and 7.3 s per call |
| A-AST-2 | Separate assistant budgets and ledger: chat per scope, storybook per run, story per job, per message, global; each call checks spent + USD 0.05 against every applicable limit and settles the reported cost (or a list-price estimate); `usage.jsonl` per scope; never written to `Manifest.real_usage` | `config.ASSISTANT_CHAT_BUDGET_USD` / `ASSISTANT_STORYBOOK_BUDGET_USD` / `ASSISTANT_STORY_BUDGET_USD` / `ASSISTANT_MESSAGE_BUDGET_USD` / `ASSISTANT_GLOBAL_BUDGET_USD`, `ASSISTANT_CALL_COST_ESTIMATE_USD` | 5.0 / 2.0 / 5.0 / 0.75 / 20.0 USD; estimate 0.05 | D "Compute metering" (agents' economy separate) |
| A-AST-3 | Storybook batching: one coalescing job per run; a backlog > 2 turns is narrated up to 12 turns (one round) per call with one `## <turn_id>` section per turn (missing sections re-queued singly); ≤ 2 singly; background profiles share one slot while a CLI run plays and pause 60 s after a rate limit; a file lock stops a second process | `config.STORYBOOK_BATCH_MAX`, `STORYBOOK_BATCH_THRESHOLD`, `ASSISTANT_BACKGROUND_PAUSE_SECONDS` | 12 / 2 / 60 s | Measured ~3k-token fixed prefix per narrator call |
| A-AST-4 | Structured output only where code consumes it (chat step, interview, story brief); every schema < 16 KB; brief `action` = `{type, args}` with `args` validated server-side; deterministic salvage, then at most one repair step; assistant refs run with `max_turns` 2, `max_model_requests` 3 | `config.ASSISTANT_SCHEMA_MAX_BYTES`, registry `options` | 16 KB; 2 / 3 | Measured 13.5% malformed live Haiku schema calls; typed action schema 35,634 chars |
| A-AST-5 | Text-mode profiles: narrator entries, chapters and both summaries use `ModelRequest.response_format = "text"`; chat steps, interview and the story brief stay JSON | `ModelRequest.response_format` | as stated | Design D2 as amended |
| A-AST-6 | Dictate: local faster-whisper `large-v3-turbo`, int8 on the CPU with min(8, cores) threads, one speech worker with a bounded queue, preloaded by the served backend only; 60 s recording cap (65 s server side), 10 MB body cap, language `en`; initial prompt from run/agent names, glossary and control labels | `config.WHISPER_MODEL` (`EMPYREAN_WHISPER_MODEL`), `WHISPER_PRELOAD` (`EMPYREAN_WHISPER_PRELOAD`), `WHISPER_MAX_SECONDS`, `WHISPER_MAX_AUDIO_BYTES`, `WHISPER_CPU_THREADS`, `WHISPER_LANGUAGE_DEFAULT` | `large-v3-turbo`, preload on, 65 s, 10,000,000 bytes, en | User requirement 9; measured 7.2 s (large-v3-turbo) vs 5.5-6 s (medium) for an 11 s clip |
| A-AST-7 | Chat step loop: at most 4 model calls per message, step 1 prefetched with deterministic context, up to 3 read tools per step, the last step restricted to answer/ask, 90 s wall clock per message, byte-stable system prompt < 96 KiB | `config.ASSISTANT_MAX_STEPS`, `ASSISTANT_TOOLS_PER_STEP`, `ASSISTANT_MESSAGE_TIMEOUT_SECONDS`, `ASSISTANT_SYSTEM_PROMPT_MAX_BYTES` | 4 / 3 / 90 s / 96 KiB | Live records: cache reads dominate after step 1; CLI steps take 7-20 s |
| A-AST-8 | Assistant-only model refs (`options.assistant_only`) are hidden from `GET /api/models` unless `?include_assistant=1` and rejected by `ModelRegistry.validate_agent_key` in setup, card model keys, `place_entity` and model assignment | `models.example.json` `options.assistant_only` | `claude-cli-sonnet-assistant` (cap USD 0.25), `claude-cli-haiku-assistant` (USD 0.08), `fake-assistant` | Setup and interventions previously checked `validate_key` only |
| A-AST-9 | Execution briefs: typed actions validated before they are shown (no run is opened), approve with CAS pending → executing, revalidation and one stored, idempotent effect; staged edits get origin `assistant` and note `assistant: <summary>`; `apply_working_files` is never proposed; a play is never chained into a create-run | `assistant/briefs.py` rule | as stated | User requirement 2; S "God mode" (record origin) |
| A-AST-10 | Conversations live under `<worlds>/_assistant/conversations/<conv_id>/` with a mutable `run_id` scope; after an approved create-run or open-run the conversation follows the new run; interrupted work is marked on restart; no memory across conversations | `config.ASSISTANT_GLOBAL_DIR_NAME`, `config.MEMORY_TOKEN_BUDGET` | `_assistant`; memory 3,000 tokens | User requirement 4 |

## Deliberately not implemented (design says deferred)

Construction, persistent networks, fields, agent birth action, mountain crossing, price
modification, leaves with function, natural plant spawning beyond seeds, embedding-based
retrieval, mid-turn checkpoints, an `events` variable inside skills, terrain occlusion.
