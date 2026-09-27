# Empyrean prototype — interface contract (revision 4)

This is the contract the backend, the frontend and the tests code against: ids, the run state
machine, module contracts, the storage layout, the decision JSON, events, the API, interventions,
continuations, fake models and the testing contract. It was written for the original four-team
build (engine/storage, models/context/skills, frontend, QA) and is kept current: every change to
a contract updates this file in the same commit (CLAUDE.md "Docs rule" and "Change control"),
and `scripts/check_docs.py` checks the API table (section 9) against the served routes.

Revision 3 was the integration pass of the first build (marked "rev 3"). Revision 4 adds the
built-in assistant (marked "rev 4"): the `backend/empyrean/assistant/` package, its routes, its
storage beside each run and in `<worlds>/_assistant/`, text-mode and speech calls in `model.py`,
and the change-control rules that replaced the frozen-file process (section 14). How the pieces
work together is in `docs/SYSTEM.md`; where they live is in `docs/CODE_MAP.md`.

Authoritative requirements: `llm_world_technical_spec.md` (spec) and
`llm_world_running_design.md` (design). Configurable open rules are listed in
`docs/ASSUMPTIONS.md` and registered in `config.ASSUMPTIONS` (A-… ids below
refer to it).

## 1. Ownership

| Path | Owner | Notes |
| --- | --- | --- |
| `backend/empyrean/schemas.py` | change-controlled (CLAUDE.md) | all shared Pydantic models |
| `backend/empyrean/config.py` | change-controlled (CLAUDE.md) | defaults, `.env` loading, `estimate_tokens`, ASSUMPTIONS registry |
| `backend/empyrean/world.py` | engine/storage | world truth and rules |
| `backend/empyrean/storage.py` | engine/storage | files, checkpoints, recovery, continuations |
| `backend/empyrean/runner.py` | engine/storage | worker thread, status machine, orchestration |
| `backend/empyrean/api.py` | engine/storage | routes only; no logic |
| `backend/empyrean/main.py` | architect (complete) | entry point |
| `backend/empyrean/model.py` | models/context/skills | the only model boundary |
| `backend/empyrean/context.py` | models/context/skills | knowledge, believed self, packets, settings validation |
| `backend/empyrean/skills.py` | models/context/skills | parser, compiler, interpreter |
| `backend/empyrean/models.example.json` | models/context/skills | registry entries (no secrets) |
| `backend/empyrean/assistant/` (package) | assistant (rev 4): WP2 engine/briefs/store/routes, WP3 digest/storybook/story, WP4 speech | all assistant models live in `assistant/models.py`, never in `schemas.py`; every model call goes through `assistant/calls.py` -> `model.call_model` |
| `backend/tests/conftest.py` | architect (QA may add fixtures) | |
| `backend/tests/test_*.py` | QA (each team adds its own unit tests too) | |
| `frontend/src/api/types.ts`, `client.ts`, `frontend/vite.config.ts` | change-controlled (CLAUDE.md) | rev 4: `types.ts` gained the assistant `ApiErrorCode`s, `ModelInfo.assistant_only`, `InterventionOrigin 'assistant'`, `TranscriptionResult`; `client.ts` exports `request`/`API_BASE` and `listModels(includeAssistant)`; assistant/story types live in `api/assistantTypes.ts` / `api/storyTypes.ts` |
| `frontend/src/**` (everything else) | frontend | |
| `docs/*.md`, `README.md`, `CLAUDE.md` | whoever changes the behaviour, in the same commit | `docs/INDEX.md` lists every doc; `scripts/check_docs.py` checks them against the code |
| `scripts/check_docs.py`, `backend/tests/test_docs_consistency.py` | docs regime | the docs consistency checker and its pytest wrapper |

Team-level unit tests live next to the team's module name: `tests/test_world.py`,
`tests/test_storage.py`, `tests/test_runner.py`, `tests/test_skills.py`,
`tests/test_context.py`, `tests/test_model.py`, `tests/test_api.py`. QA owns
`tests/test_e2e_*.py` and browser checks.

## 2. Repository layout

```
antegensim/
  CLAUDE.md            coding practice for people and agents (commands, rules, docs rule)
  backend/
    empyrean/          package (see ownership); assistant/ is the rev-4 subpackage
    tests/             pytest (cd backend && ../.venv/bin/pytest -q)
    requirements.txt
  frontend/            Vite + React 19 + TypeScript 6 (npm run dev / build)
    vite.config.ts     dev server proxies /api -> http://127.0.0.1:8000
    src/api/types.ts   mirror of schemas.py
    src/api/client.ts  typed fetch wrappers (core routes) and the shared request() helper
    src/api/assistant.ts, story.ts, assistantSpeech.ts   assistant route wrappers (rev 4)
  scripts/             run_sim.py (headless driver), check_docs.py (docs checker), scenarios/
  qa/                  browser_check.mjs (Playwright), assistant_fake_server.py (QA backend on fake
                       assistant keys), render_brief.mjs, resilience/ (crash and restart scenarios)
  worlds/              run data (gitignored); worlds/_assistant/ holds global assistant data
  docs/                INDEX.md lists every document (this file, SYSTEM, GLOSSARY, CONTROLS,
                       ASSISTANT, ASSUMPTIONS, CODE_MAP, TEST_PLAN, TEST_EVIDENCE, LIMITATIONS),
                       evidence/, sample_run/
  .env                 local credentials (gitignored; loaded by empyrean.config)   .env.example placeholders
```

Backend: `cd backend && ../.venv/bin/python -m empyrean.main` serves
`http://127.0.0.1:8000`. Frontend: `cd frontend && npm run dev` serves
`http://localhost:5173` (or 5174) and calls `VITE_API_BASE` (default `""`, same
origin through the Vite proxy; CORS also allows both ports for a direct base).

Frontend toolchain facts: `verbatimModuleSyntax` (use `import type`),
`erasableSyntaxOnly` (no `enum`, no parameter properties), `noUnusedLocals`.

## 3. Fixed identifiers and semantics

| Item | Rule |
| --- | --- |
| Turn ids | `r00000_init`; agent turns `r{round:05d}_t{turn:02d}_{agent_id}` (turn index is 1-based within the round); round end `r{round:05d}_end`. Use `schemas.TurnId`. |
| Entity ids | agents `a01..a12` (or card-provided, `^[A-Za-z0-9]{1,16}$`, never a `RESERVED_AGENT_IDS` word), plants `p0001`, fruit `f0001`, seeds `s0001`, residue `res0001`; `world.new_entity_id` allocates and never reuses an id (including `world.removed`). |
| Run / world ids | `run_{YYYYmmdd_HHMMSS}_{4hex}`, `world_{YYYYmmdd_HHMMSS}_{4hex}`; run ids are globally unique so routes take `run_id` only. |
| Knowledge record ids | `{agent_id}-k{seq:06d}` |
| Packet ids | `pk_{turn_id}` (one packet per turn at most) |
| Model call ids | `mc_{turn_id}_{n:02d}`; `n` continues past ids already used for that turn id (a re-run after an error or interruption gets `_02`). |
| Intervention ids | `iv_{seq:04d}` from `manifest.next_intervention_seq` (persisted; staged ids included). |
| Event seq | integer, monotonically increasing inside one worker process, starting at 1; committed history may contain gaps (a failed turn's uncommitted events); `manifest.next_event_seq` = max committed seq + 1. A restarted worker may reissue uncommitted seqs; `RunStatus.feed_epoch` changes so clients reset. |
| Points | `{"x": int, "y": int}`; map keys are `"x,y"`. Inputs also accept `[x, y]`. The decision format gate is stricter (fix pass): an observe point in a model reply must be an object whose `x`/`y` are plain integers (no lists, strings or booleans, section 6). |
| Directions | up (0,+1), down (0,−1), left (−1,0), right (+1,0) |
| Money | floats; keep fractions, never round, except the absorption fractions (9 decimals, clamped to the cap) and integer stats (`INTEGER_STATS`, cast to `int`). Amounts < `rules.accounting.eps` are empty. |
| Time | `world.round` starts at 0 (initial checkpoint); the first agent round is 1. |
| JSON keys | always the Python attribute name (no aliases): `IfBlock.else_body`. |

### Status machine (`RunState`)

```
paused ──run_turn/play/step_round──▶ running ──(turn starts)──▶ turn_active ──(model call)──▶ waiting_model
  ▲                                    │  ▲                          │                             │
  │                                    │  └────(turn committed; play loop continues)◀──────────────┘
  └──(turn committed; single turn, round end for step_round, or pause requested)──┘

pause while running/turn_active/waiting_model ──▶ pause_requested ──(turn commits)──▶ paused
exception inside a turn, provider failure after retries (A-COG-5), real budget reached (A-COG-7)
    ──▶ error   (pause ──▶ paused: working copy discarded, last committed checkpoint reloaded,
                 the same turn id is re-run; other commands are 409 illegal_command)
all agents dead or max_rounds reached ──▶ finished (run commands apply staged edits and re-check
                 the condition, A-SCHED-3; pause is a no-op)
```

`RunStatus.state` is what the UI shows; `active_command` says which command drives the
worker; `next_step` says what the next `run_turn` does (`agent_turn` | `round_end` |
`new_round`); `pending_model_call` is set exactly while `waiting_model`; `last_error`
persists until the next successful commit. `round`/`turn_index`/`acting_agent_id`
describe the in-progress turn while active, otherwise the last committed turn.

Commands: `run_turn` = one agent turn (or the round-end step if the round is complete) then
pause. `play` = loop (sleeping `settings.play_delay_seconds` between turns). `step_round` =
loop until the `r{n}_end` checkpoint commits. `pause` = stop before the next turn; an active
turn finishes and commits. Overlapping run commands are rejected with 409. `POST /close`
requests a pause, tells the worker to stop and forgets it; the request returns at once while an
active turn still finishes and commits (the UI closes a run when leaving it). A later `open` of
the same run waits for that worker to exit. One active writer per run (fix pass): every open
worker holds `storage.acquire_writer_lock`; `open` of a run held by another process is 409
`illegal_command` ("open in another process").

## 4. Module contracts

### 4.1 `world.py` (engine/storage)

Owns world truth and every rule. Returns `ActionOutcome`/`RoundEndOutcome` containing
`EventDraft` and `Notice` lists; never assigns seq/turn ids, never does I/O, never reads
config constants (all numbers come from `world.rules`, including `messages.chars_per_token`
and `accounting.eps`).

```python
generate_terrain(config: WorldConfig, rng) -> MapState              # also used by /api/world/preview
generate_world(config, rules, seed, agents: list[AgentCard]) -> WorldState   # copies config.max_entities_per_observation_page to world.observation_page_size (rev 3)
world_warnings(world) -> list[str]                                  # copy of world.warnings (card moved off a mountain, ...); reading never clears them (rev 3)
new_entity_id(world, kind) -> str
get_rng(world) -> random.Random ; save_rng(world, rng) -> None      # THE single run RNG
terrain_at(world, point) -> Terrain | None
find_entity(world, entity_id) -> Entity | None                      # dead or alive
entities_at(world, point, living_only=True) -> list[Entity]
rebuild_occupants(world) -> None                                    # every entity, dead included
living_agents(world) -> list[Agent]
can_see(world, agent, point) -> bool          # manhattan <= vision_range (no occlusion, A-WORLD-5)
can_reach(world, agent, point) -> bool        # manhattan <= communication_range
visible_target(world, agent, entity_id) -> Entity | None   # living, present, within vision (A-ACT-14)
compute_initiative(world) -> list[str]        # sorted ids, rng.shuffle, stable sort by -speed
message_tokens(rules, text) -> int            # ceil(len / chars_per_token)
quote_action(world, agent, action, via_skill) -> ActionQuote
upgrade_quotes(world, agent, via_skill) -> dict[str, dict]
self_query_data(world, agent, via_skill) -> dict
public_entity_data(world, viewer, entity, round_no) -> dict   # agent: id, name, kind, position, health, max_health, attack, attack_cap, speed, alive, round
effective_attack_budget(agent, compute_budget) -> float       # the budget cut to attack_cap / attack (A-ACT-19)
attack_damage(agent, compute_budget) -> float                 # min(attack * budget, attack_cap)
apply_action(world, request: ActionRequest) -> ActionOutcome
kill_agent(world, agent_id, cause) -> ActionOutcome
kill_plant(world, plant_id, cause, pre_hit_essence) -> ActionOutcome
end_round(world) -> RoundEndOutcome
apply_world_intervention(world, intervention) -> list[FieldChange]   # raises InterventionError
replace_world(world, new_world) -> list[str]
validate_world(world) -> list[str]
```

Errors: gameplay failures are results, not exceptions. `WorldError` = programming error.
`InterventionError` = invalid intervention (nothing changed).

Pinned in rev 3:

* `WorldState.observation_page_size` (A-ACT-4) and `WorldState.warnings` are stored fields:
  the page size a run was created with survives even though `WorldConfig` is not stored,
  and generation warnings survive copies and reloads (they also appear in `run_created`).
* `apply_world_intervention` returns only `list[FieldChange]`. A `set_stat` that leaves a
  living agent at health ≤ 0 resolves `kill_agent(cause="operator")` inside world.py and
  reports it as changes (`world.agents.<id>.alive` true→false, `world.residues.<id>` added);
  the **runner** emits the `death` / `residue_created` events from those changes. No damage
  notice is produced for an operator kill (the agent takes no further decision).
* `round_ended` is emitted by `world.end_round` as its LAST event (actor `world`, details
  `{round, living_agents, deaths}`); the runner only emits one itself when the outcome has
  none. Never two per round.
* `RangeRules`: a move outside the region is always refused (every entity must stay inside
  the region); `outside_region_is_blocked` only picks the reason (True → `blocked`, False →
  `out_of_range`). `observe_uses_vision_range` / `query_uses_vision_range` False means no
  range check; `*_requires_same_point` False means any visible target qualifies.
* Extra public names in world.py: `ID_FORMATS`, `KIND_TO_DICT`, `ENTITY_DICTS`,
  `FRACTION_STATS`, `FRACTION_DECIMALS`, and the exceptions `WorldError` / `InterventionError`.
* The action event summary is `<name> <args summary> -> ok|reason[: detail] (cost X)` without
  the actor prefix (the feed prints `{actor} {summary}`); the sample in section 5 shows the
  actor inside the summary only for readability.
* A dead agent cannot be revived through `set_stat` (health > 0 on a dead agent fails
  `validate_world`, and `alive` false→true is an `InterventionError`: death is resolved once,
  A-DEATH-6); revival is `remove_entity` + `place_entity` with a new id.
* Plant source accounting (fix pass): a plant's initial essence is recorded in
  `total_source_essence` when it is generated, germinated or placed (a placed plant's given
  essence/energy count as source inflow unless the entity carries explicit totals); a placed
  plant, or a `set_stat` of `stage_index`, settles `age_rounds` to the stage's `min_age_rounds`
  (and `size`) whenever the age implies another stage, so round end keeps the operator's stage.

#### Quotes and charges

`ActionQuote.compute`/`essence` = the action **charge** (for transfer: the fee only).
`required_compute`/`required_essence` = charge + outgoing transfer amount; affordability
uses these. `ActionResult.cost_compute`/`cost_essence`, the action event's `costs` and
`agent.total_compute_spent` report the **charge** only; a transferred amount appears only
in `effects.transferred`. Example: a skill transfer of 10 compute leaves the sender at
−10.8, the recipient at +10, `cost_compute = 0.8`.

Effective compute price inside a skill = `normal × rules.skills.action_discount`; essence
prices and transferred amounts are never discounted. Attempt fee (both modes) =
`min(rules.accounting.failure_fee_cap, base_compute) × (action_discount if via_skill else 1)`;
for recover/attack `base_compute` is the nominal budget (recover: the useful amount).

#### Action semantics (all eleven)

Check order in `apply_action` (first failure wins):

1. actor alive → `dead` (no charge)
2. arguments that make the quote uncomputable (non-finite numbers) → `invalid_argument`, **no charge**
3. upgrade only: `quote.allowed` False → `at_limit` with the attempt fee if the fee is affordable, else `insufficient_compute` with no debit (A-ACT-18)
4. `required_compute`/`required_essence` unaffordable → `insufficient_compute` / `insufficient_essence`, **no debit**
5. legality (table below) → **attempt fee only**, no essence
6. success → debit the charge, move any transferred amount, apply effects, `reason="ok"`

Visibility first (A-ACT-14): every entity argument is resolved with `visible_target`; a
None result is `target_gone` (id unknown, dead, removed, or simply not visible). `out_of_range`
is used only for point arguments (observe) and for a visible entity that is not at the
required distance (e.g. visible at distance 1 but attack/absorb/transfer need the same
point). `target == actor` and wrong-kind targets → `invalid_argument` (fee) (A-ACT-16).

| Action | Args | Normal price | Legality checks (reason, in order) | `data` on success | `effects` on success |
| --- | --- | --- | --- | --- | --- |
| move | direction | 5 | destination inside region and not mountain (`blocked`) | `{}` | `{"from": P, "to": P}` |
| observe | point, page=0 | 1 | page ≥ 0 (`invalid_argument`); point within vision (`out_of_range`) | `{point, terrain, entities:[{id,kind,position}], observed_round, page, page_size, total_entities, has_more}`; living entities only; a page past the end → ok, empty list, `has_more=false`; a point within vision but outside the region → ok, `terrain: null`, no entities | `{}` |
| query | entity | 1 | `"self"` or the caller's own id → self-query (never `out_of_range`); else `visible_target` (`target_gone`) | self: `self_query_data` (includes `quote_mode`); other: `public_entity_data` | `{}` |
| send | recipient, message | 3 | message non-empty and ≤ `max_message_tokens` (`invalid_argument`); recipient ≠ self (`invalid_argument`); recipient a living agent the sender can see (`target_gone`) within communication range (`out_of_range`) (A-ACT-15) | `{"delivered_to": id}` | `{"delivered": 1}`; Notice(kind=message) to recipient with `sender_visible = can_see(recipient, sender.position)` |
| broadcast | message | 7 | message non-empty and ≤ limit (`invalid_argument`) | `{"delivered_to_visible": [ids]}` (recipients the sender can see; may be empty; still ok) | `{"delivered_visible": n}`; Notice per living agent (not self) within communication range, visible or not |
| absorb | source, resource | 3 | source a visible fruit/residue (`target_gone`); fruit/residue kind (`invalid_argument`); same point (`out_of_range`); available ≥ eps (`empty_source`); essence: free capacity ≥ eps (`at_limit`) | `{}` | `{"processed": raw, "gained": g, "lost": raw−g, "source": id, "resource": r}`; compute: process all, `g = raw × eff`; essence: `raw = min(available, free / eff)`, `g = min(raw × eff, free)`; source remainder < eps → 0 |
| transfer | recipient, resource, amount | 1 (fee) | recipient ≠ self (`invalid_argument`); a visible living agent (`target_gone`) at the same point (`out_of_range`); essence recipient capacity ≥ amount (`at_limit`) | `{}` | `{"transferred": amount, "resource": r, "to": id}`; Notice(kind=system, `content.amount/resource/from`) to recipient "received X compute from <id or unknown>" (sender id only if the recipient can see the sender) |
| recover | compute_budget | useful = min(budget, missing health / health_per_compute); 0 at full health (ok no-op) | — | `{}` | `{"healed": h, "health": new}` |
| attack | target, compute_budget | `effective_attack_budget` = budget cut to `attack_cap / attack` when `attack × budget > attack_cap` (A-ACT-19; charged ×0.8 in skill; damage uses the nominal budget, capped) | target ≠ self (`invalid_argument`); a visible living agent or plant (`target_gone`); agent/plant kind (`invalid_argument`); same point when `ranges.attack_requires_same_point`, else within vision (`out_of_range`) | `{}` | `{"damage": d, "target": id, "target_health_after": v, "killed": bool, "capped": bool, "attack_cap": c}`; agent target: Notice(kind=damage) with attacker id if visible else unknown; lethal → `kill_agent`/`kill_plant` |
| upgrade | attribute | quote (compute + essence) | see step 3 | `{"attribute", "new_value", "purchase_count"}` | `{"purchased": attribute, "new_value": v, "compute": c, "essence": e}` |
| wait | rounds | 0 | rounds ≥ 1 | `{}` | `{"waiting_turns": rounds}`; sets `wait_turns_remaining = rounds − 1` (this turn is the first) |

`ActionResult.round` is `world.round`. `data` and `effects` are `{}` when nothing applies.
Every successful/failed action updates `agent.last_action` (`{"name","args"}`) and
`agent.last_result`, adds the charge to `total_compute_spent`, and produces one
`EventDraft(kind="action", actor=agent_id, summary="<name> <args summary> -> ok|reason",
details={"action":..., "result":..., "via_skill":..., "skill_name":...}, costs=charge)`.

`upgrade_quotes`: `{base_compute, skill_compute, compute, essence, next_value, allowed}` per
attribute (price `standard_base × standard_growth^n`; `attack` uses `attack_base_* × attack_growth^n`,
`attack_cap` uses `attack_cap_base_* × attack_cap_growth^n`; defaults 100 × 4ⁿ compute + 10 × 4ⁿ
essence for both); at a cap the formula price is shown, `next_value` = current value, `allowed=false`.
A purchase sets `min(cap, value + increment)` (`int` for `INTEGER_STATS`; absorption rounded
to 9 decimals). `self_query_data` adds `quote_mode` so a stored quote is never mistaken for
the other mode's price.

Damage rule: `damage = min(attacker.stats.attack × compute_budget, attacker.stats.attack_cap)`
(`world.attack_damage`; A-ACT-19). Only `effective_attack_budget` is charged, so committing more than
`attack_cap / attack` costs nothing extra; `capped` says the cut happened. Agent death when health ≤ 0
(A-DEATH-6): health clamped to 0, residue essence = essence × `death.essence_residue_fraction`,
residue compute = compute × `death.compute_residue_fraction` (residue created only when
either > eps; `death.residue_id` null otherwise), balances → 0, `alive=False`, skill stopped
(`"operator"`/`"death"` reason), record kept with its position. Plant death when essence ≤ 0:
residue essence = pre-hit essence × species `essence_residue_fraction`. Dead entities are
excluded from `entities_at(living_only=True)`, observe listings, `visible_target` and
initiative, but stay in `map.occupants` flagged `alive=false`. Entities that leave the dicts
(consumed fruit/residue, germinated seeds, operator removals) are recorded in
`world.removed`.

#### Round end (`end_round`) — fixed order

Plants whose cell is not land are skipped in steps 1–3 (A-PLANT-10, listed in the summary).

1. plants: age +1, stage by age, `rounds_since_fruit/seed += 1`, `energy = min(stage.max_energy, energy + inflow)`, `essence = min(stage.max_essence, essence + inflow)`; `total_source_*` count only admitted inflow (event `plant_growth` on stage change; one summary event per round with totals and skipped plants)
2. fruit spawning (`fruit_spawned`; counter ≥ interval, energy ≥ fruit_energy, live fruit < max_fruit; reset counter; blocked keeps it), 3. seed spawning (`seed_spawned`; per-plant `max_seeds_alive`; land cell within dispersal radius from the run RNG), 4. germination (`germination`; on land only, else dormant),
5. residue decay, 6. upkeep (`upkeep` per agent with `paid`/`owed`; `starvation` with health loss +
damage Notice `health_after` when unpaid; deaths via `kill_agent(cause="starvation")`), 7. cleanup
(`fruit_removed` for `available_compute < eps` or age ≥ `fruit_decay_rounds > 0`, with lost
compute; empty residues), then `rebuild_occupants`. `world.round` is not incremented here.

### 4.2 `skills.py` (models/context/skills)

```python
tokenize(source) -> list[list[(type, text, line)]]
parse_skill(source) -> list[Block]                      # SkillSyntaxError(line, message)
count_blocks(blocks) -> int
compile_skill(blocks) -> list[Instruction]
find_action_calls(blocks) -> list[(line, action_name)]
validate_and_build(request, existing, skill_count_limit, skill_block_limit, rules, round_no) -> SkillDefinition   # SkillValidationError
check_delete(name, existing) -> str | None              # "referenced by X" (A-SKILL-14)
start_execution(skill_name, arguments, skills, round_no) -> SkillExecutionState   # exact arity
frames_use(state) -> set[str] ; stop_execution(state, reason) -> SkillExecutionState
run_until_action(state, skills, rules, env: SkillEnv, compute_available) -> SkillStepOutcome
deliver_result(state, result) -> SkillExecutionState
evaluate(expr, frame_vars, env, counter) -> value        # SkillRuntimeError
skill_catalogue(skills, include_source, source_for=None) -> str
```

#### Text grammar (EBNF)

```
program     = { statement } ;
statement   = set | bare_action | if | repeat | for_each | call | return | stop ;
set         = "SET" NAME "=" expr NEWLINE ;
bare_action = action_call NEWLINE ;
if          = "IF" expr NEWLINE { statement } [ "ELSE" NEWLINE { statement } ] "END" NEWLINE ;
repeat      = "REPEAT" expr NEWLINE { statement } "END" NEWLINE ;
for_each    = "FOR_EACH" NAME "IN" expr NEWLINE { statement } "END" NEWLINE ;
call        = "CALL" NAME "(" [ expr { "," expr } ] ")" [ "INTO" NAME ] NEWLINE ;
return      = "RETURN" [ expr ] NEWLINE ;
stop        = "STOP" NEWLINE ;

expr        = or_expr ;
or_expr     = and_expr { "OR" and_expr } ;
and_expr    = not_expr { "AND" not_expr } ;
not_expr    = "NOT" not_expr | comparison ;
comparison  = additive [ ( "==" | "!=" | "<" | "<=" | ">" | ">=" ) additive ] ;
additive    = term { ( "+" | "-" ) term } ;
term        = unary { ( "*" | "/" ) unary } ;
unary       = "-" unary | postfix ;
postfix     = primary { "." NAME } ;
primary     = NUMBER | STRING | "true" | "false" | "null" | NAME
            | action_call | coord | "(" expr ")" ;
coord       = "(" expr "," expr ")" ;
action_call = ACTION "(" [ expr { "," expr } ] ")" ;
ACTION      = "move" | "observe" | "query" | "send" | "broadcast" | "absorb"
            | "transfer" | "recover" | "attack" | "upgrade" | "wait" ;
NAME        = /[A-Za-z_][A-Za-z0-9_]*/ ;  NUMBER = /[0-9]+(\.[0-9]+)?/ (unsigned) ;  STRING = "..." (no newlines; \" and \\ escapes)
```

Comments start with `#`. Keywords are uppercase; `true/false/null` lowercase. Indentation is
ignored. `self` and `here` are reserved names: `self` → the agent's own id (string; a self-query
in world.py), `here` → `{"x":..,"y":..}`. Reserved names, keywords and action names cannot be
assigned to, used as params, loop variables, `INTO` targets or skill names. **An `action_call`
may appear only as the entire right-hand side of `SET` or as a bare statement** (A-SKILL-1).
Arity: move 1, observe 1–2 (point[, page]), query 1, send 2, broadcast 1, absorb 2, transfer 3,
recover 1, attack 2, upgrade 1, wait 1. Literal arguments are checked at save time
(A-SKILL-12); computed arguments at runtime (A-ACT-13).

Block counting (A-SKILL-4): each statement 1; each binary/unary op, field access, coord and action
call 1; literals, names, ELSE, END 0. `CALL` counts 1 in the caller. Design example 2 = 48 blocks.

Save-time checks (rev 3, the complete list): source length (`max_source_chars`), syntax, params
and names (reserved words), action arity (observe 1–2) and placement (A-SKILL-1), literal
arguments (A-SKILL-12), literal `REPEAT` counts (whole number 0..`max_repeat_count`), a literal
cannot be a `FOR_EACH` list, literal id/message arguments must be strings, an empty skill ("the
skill has no statements"), `CALL` target existence and exact arity, recursion cycles, the block
limit, the count limit (overwriting an existing name is always allowed), and callers' arity on
re-save (`check_delete` for deletes). Host limits that are not rules: nesting deeper than 32
blocks or 32 expression levels is a syntax error; integers above 2**53 continue as floats;
`rules.skills.max_string_chars` (4096) bounds `+` on strings at runtime.

#### Values

JSON values only: number, string, boolean, null, list, record (dict). Coordinates are records
`{"x","y"}`. Action results are stored as the `ActionResult` dict (`result.ok`,
`result.data.entities`, …). Comparisons: `==`/`!=` structural and type-strict (a boolean never
equals a number; `3 == 3.0` is true); `< <= > >=` numbers only; `+` numbers or strings; `- * /`
numbers; `/` by zero → runtime error; missing field/variable → runtime error; `AND`/`OR`/`NOT`
on booleans (non-boolean → runtime error), **`AND`/`OR` short-circuit left to right**: `IF r.ok ==
true AND r.data.compute > 5` is safe when `r` failed (`data = {}`). No implicit truthiness.

#### Compiled instruction set

`Instruction.op`: `set(var, expr)`, `eval(expr)`, `jump(target)`, `jump_if_false(expr, target)`,
`loop_start(loop_kind, expr, var, target=exit pc)`, `loop_next(target=loop_start pc)`, `call(skill,
args, var)`, `return(expr?)`, `stop`. Layouts:

```
IF c ... ELSE ... END        REPEAT n ... END              FOR_EACH v IN l ... END
 0 jump_if_false c -> 3       0 loop_start repeat n -> 3    0 loop_start for_each l var=v -> 3
 1 <then>                     1 <body>                      1 <body>
 2 jump -> 4                  2 loop_next -> 0              2 loop_next -> 0
 3 <else>                     3 ...                         3 ...
 4 ...

IF c ... END (no ELSE)
 0 jump_if_false c -> 2       (no jump instruction)
 1 <then>
 2 ...
```

`loop_start` evaluates its expression once (REPEAT: integer-valued ≥ 0, ≤ `max_repeat_count`,
else runtime error), pushes a `LoopState` (repeat: `remaining=n`; for_each: `items=snapshot`,
`index=0`) and, if the loop has zero iterations, jumps to `target`; otherwise enters the body
(for_each binds `var` to `items[0]`). `loop_next` decrements/advances; if more iterations remain
it jumps to `start_pc + 1` (rebinding the var), else pops the loop and continues at the loop's
exit `target`. `call` pushes a new frame with params bound (missing skill or depth >
`max_call_depth` → runtime error); `return` pops the frame and stores the value into the
caller's `return_into` var (or finishes the root skill with `return_value`); `stop` ends
everything with status `stopped`.

Op accounting (A-SKILL-13): 1 op per executed instruction + 1 per evaluated operator, field
access or coord node; literals, variable reads and the action-call node are free. When `AND`/`OR`
short-circuits, neither the right operand nor the `AND`/`OR` node itself is counted (so a
short-circuited condition costs less than its static maximum, which is what a fully evaluated
one costs). Before each instruction its maximum static cost is computed;
if `ops_this_turn + cost > max_ops_per_turn` the instruction is not started and the step
yields (status `running`, `last_error="op_budget_exhausted"`, no action this turn); the check
is always `>=`-safe (never an equality test). If the accumulated op cost would exceed
`compute_available` → status `error`, `last_error="insufficient_compute"`. `cost_compute =
ops_used × interpreter_cost_per_op` (unrounded); the runner charges it (event `skill_step`,
`agent.total_interpreter_spent`).

Worked numbers: `move("up")` as a bare statement = 2 blocks (statement + action call) and 1
op when executed (the action-call node is free); `SET r = observe(here)` = 2 blocks, 1 op;
`IF a.ok == true AND b > 1` = 1 + (field, ==, AND, >) = 5 blocks and, when `a.ok` is false,
1 + 2 = 3 ops (the right operand and the AND node are skipped); fully evaluated it costs 5 ops.
A single statement whose static cost exceeds `max_ops_per_turn` is a runtime error (it could
never run), not an endless yield. Terminal states: `finished`/`stopped` clear the frames,
`error` keeps them for inspection.

#### Resumable state

`SkillExecutionState` is stored on `Agent.skill_execution` between turns. Lifecycle per turn:
`ops_this_turn = 0` → `run_until_action` → if `action`: runner executes it →
`deliver_result(state, result)` → state persists in the checkpoint; if `invalid_action`: the
interpreter already stored the synthetic result, the runner records the event and uses the
turn. On the next turn, if `skill_execution.status == "running"` the runner resumes without a
model call (unless an unread record of a kind in `rules.skills.interrupt_on` exists: the
execution is stopped with `"interrupted"` and the agent takes a model decision, A-SKILL-9).
`finished`/`stopped`/`error` states are kept on the agent for inspection until the next
decision replaces them (`skill_execution` is set to None when the agent takes a direct action).

Save/delete rules (A-SKILL-6, A-SKILL-14): `delete_skills` first (`check_delete`; deleting a
skill that another skill CALLs is rejected), then `save_skills` in list order against the
growing dict (list callees before callers; re-saving a callee re-checks callers' arity), then
the action. Saving or deleting a skill named in `frames_use(skill_execution)` stops the
execution (`"skill_modified"`). `run_skill` with an unknown name or wrong arity → event
`skill_error`, system knowledge record, `last_result = ActionResult(ok=False,
reason="invalid_action", cost 0)`, no fee, turn used.

### 4.3 `context.py` (models/context/skills)

```python
new_knowledge(agent_id, notebook="") -> AgentKnowledge
add_record(knowledge, round_no, kind, provenance, text, content=None, tags=None, importance=None, read=False) -> KnowledgeRecord
record_run_start(knowledge, agent, round_no, turn_id) -> KnowledgeRecord     # birth disclosure (A-KNOW-6)
record_notice(knowledge, notice, round_no, turn_id) -> KnowledgeRecord
record_action_result(knowledge, action, result, round_no, turn_id, via_skill, thought=None) -> KnowledgeRecord
record_system(knowledge, text, round_no, turn_id, content=None, importance=0.5) -> KnowledgeRecord
importance_of(kind, content) -> float
unread_records(knowledge) -> list[KnowledgeRecord] ; unread_counts(knowledge) -> dict ; mark_read(knowledge, ids)
latest_observation_here(knowledge, position) -> KnowledgeRecord | None
latest_self_query(knowledge) -> KnowledgeRecord | None
believed_self(knowledge) -> BelievedSelf
observed_entities(knowledge) -> list[ObservedEntity]      # fix pass: UI agent view (see "Observed entities")
render_record(record) -> str
apply_notebook_update(knowledge, update, max_tokens) -> bool
apply_memory_priorities(knowledge, priorities) -> list[str]        # ignored ids
cognition_cost(rates, mind_multiplier, input_tokens, output_tokens) -> float
validate_settings(settings, capabilities, mind_multiplier=1.0) -> list[str]
build_situation(agent, knowledge, rules, settings, round_no, turn_id) -> Situation      # pure
stable_rules_text(rules, agent, settings, mind_multiplier) -> str
skills_section_text(agent, settings, situation) -> str
rank_memories(records, situation, notebook, settings, current_round, priorities=None) -> list[(record, score)]
build_packet(agent, knowledge, situation, rules, settings, capabilities, mind_multiplier,
             compute_available, overhead_tokens, turn_id, packet_id, round_no) -> DecisionPacketRecord   # pure
decision_request_text(situation, settings) -> str
apply_knowledge_intervention(knowledge_by_agent, intervention, round_no, turn_id) -> list[FieldChange]
deliver_voice(knowledge_by_agent, recipient_ids, text, round_no, turn_id) -> list[KnowledgeRecord]
```

`config.estimate_tokens` is the only token heuristic (context and model import it).

Additional public helpers (rev 3): `build_model_request(packet, model_key, request_id,
fake_script=None, fake_script_index=0, fake_options=None) -> ModelRequest` (messages, the raw
decision schema, `max_output_tokens = packet.generation_allowance`, config timeout/retries and
the section 12 metadata); `settings_problems(settings, capabilities, mind_multiplier) ->
[(path, message)]` (the tuple form of `validate_settings`; prefix the path with `context.` or
`agents[i].context_overrides.` for `ApiProblem`); `affordable_input_tokens`, `believed_position`,
`digest_line`, `truncate_to_tokens`, `make_tags`, `situation_keys`, `situation_core_lines`,
`execution_summary`, `describe_action` / `describe_outcome`, `dedupe_key`.
`record_action_result(..., interpreter_cost=0.0)` stores a skill action's interpreter cost as
`content["interpreter_charged"]` (see believed self).

#### KnowledgeRecord kinds

| kind | produced by | content | read flag |
| --- | --- | --- | --- |
| observation | own `observe` | `{"action", "result", "via_skill", "thought"}` (`result.data.point/entities/observed_round`) | read at creation |
| query | own `query` | same | read at creation |
| action_result | any other own action, incl. synthetic invalid_action / skill_error results | same | read at creation |
| message | send/broadcast from another agent | `{"text", "sender": id or null, "sender_visible", "broadcast": bool}` | unread until packeted |
| operator_voice | god-mode voice | `{"text"}`; provenance source `unknown` | unread |
| damage | attack / starvation / death | `{"amount", "attacker": id or null, "health_after", "cause"}` | unread |
| system | run start (`content.self`), transfers received (`amount`, `resource`, `from`), decision_invalid / skill errors / resource skips / notebook truncation, cognition charge of the previous decision (`cognition_charged`) | `{"text", ...}` | unread |

Provenance: `own_action` (with `action`), `agent:<id>` (when the sender was visible), `unknown`
(unseen sender or operator voice), `world` (upkeep/starvation/system), `operator` (knowledge edits).

System-record content keys that context reads back (rev 3): `{"cognition_charged": x}` (the
disclosed charge of the previous decision, importance 0.2); transfer received `{"amount",
"resource", "from"}`; skill rejection / runtime error `{"skill": name, "error": text}` (the next
packet shows that skill's source and `Situation.skill_last_error`; the runner's op-budget yield
record `{"skill", "reason"}` carries no `error` key on purpose); `{"interpreter_charged": x}` on
skill-step system records and on skill action records. For a skill action the runner passes
`{"name", "args", "skill_name"}` so the record reads "Via skill <name>: ...". Exactly one damage
notice per damaging event: a lethal attack yields one notice with `health_after` 0; there is no
separate "death" notice kind.

`render_record`: `[{id} r{round} {kind} {source}] {text}` so the agent can cite ids in
`memory_priorities`; message/voice bodies are one JSON string literal; operator voice renders as
`[{id} r{round} voice, source unknown] "…"`.

#### Believed self (A-KNOW-6)

The packet never shows authoritative balances. `believed_self` starts from the newest of the
run-start record and a successful `query(self)`, then applies later disclosed deltas in seq
order: own action `cost_compute`/`cost_essence`; effects `healed`, `gained`, `transferred`,
`purchased`/`new_value`, `health`; damage/starvation `health_after`; transfer-received
`amount`; `cognition_charged` system records; `interpreter_charged` on skill action and
skill-step system records (rev 3; a skill that ends without an action discloses nothing, so at
most `max_ops_per_turn × interpreter_cost_per_op` per such turn can drift). Upkeep is never
applied (the agent knows the rate from the stable rules and may `query(self)`). The situation
labels the values "as of round N (derived, may be stale)" or "(from query, round N)". The runner
discloses each decision's cognition charge as a system record before the next packet.
`BelievedSelf.position` (rev 3) is the believed position: run-start record, successful move
`effects.to` or `query(self)`; an operator move is not disclosed, so it may be stale (the fake
adapter may then observe the wrong point and get `out_of_range`). `SituationEntity.queried_round`
(rev 3) says which round the `available_*`/`alive` values were queried in; the situation renders
it as `[last query in round N: ...]`.

#### Observed entities (UI agent view, fix pass)

`observed_entities(knowledge)` derives, from the agent's own SUCCESSFUL observe and non-self
query records only, every entity it has seen: `ObservedEntity {id, kind, position,
observed_round, source ("observation" | "query"), alive (only a query says so, else null),
record_id}`, the NEWEST sighting per id (highest observed round, then record seq), the agent
itself left out, sorted by id. `position` is where the agent last saw the entity (the
observation point or the queried position), never the authoritative one: an entity that moved
or died since is still reported where and as it was last seen. Served as
`AgentKnowledgeView.observed_entities` (both knowledge routes) so the UI's agent view can filter
the map and the occupant list to what the agent has observed (each entity drawn at its
last-seen position, the agent itself at `believed_self.position`) without parsing record text.

#### Decision packet assembly and ordering

`messages = [system: stable_rules, user: body]` where body sections appear in this order, each
under a labelled heading:

1. `stable_rules` (system, cacheable): identity (id, name, persona if set), action list with
   normal and skill prices, the failure reasons, cognition rates and this agent's mind
   multiplier, upkeep and interpreter cost, the skill language summary, the output JSON
   description (section 6) with the effective notebook limit and the observe page/`has_more`
   rule, rules of the game in ~25 lines. Never goals or personality unless `persona`. Nothing
   that changes from turn to turn.
2. `skills` (working memory): the skill catalogue (source for every skill only when
   `include_skill_source`; otherwise only for the skill that errored/was rejected last turn),
   execution state summary.
3. `notebook`: "Your notebook (version N)" — the agent's own text; a truncation note when
   `notebook_truncated`.
4. `recent_history`: last `recent_history_length` own action records (oldest first), each as
   `render_record` lines with the thought, labelled with round and "via skill" when applicable.
5. `retrieved_memories`: up to `retrieved_memory_limit` older records by rank, oldest first,
   labelled `[memory from round N]`; observation records carry `observed_round`.
6. `situation`: round, position, terrain (from the latest observation here or "unknown"),
   believed self with its label, latest observation of the current point (or "you have not
   observed this point"), last action + result, unread digest (header with counts by kind; one
   ≤ 40-token line per urgent record; full bodies as budget allows, urgent kinds first:
   damage, operator_voice, message, system; overflow line "N more unread not shown"), skill
   execution state summary.
7. `decision_request`: respond with one JSON object of the Decision schema; exactly one action.

Budget algorithm (`build_packet`, A-KNOW-8):

```
gen = settings.generation_allowance ; mind = mind_multiplier ; rates = rules.cognition
affordable_input(gen) = unlimited if rates.input_rate == 0 else
                        floor((compute_available / mind - rates.generation_rate * gen) / rates.input_rate)
while affordable_input(gen) < MIN_PACKET_INPUT_TOKENS and gen > MIN_GENERATION_TOKENS: gen = max(MIN_GENERATION_TOKENS, gen // 2)
input_cap = min(settings.input_token_cap, capabilities.context_window - gen)     # after any change to gen
budget = min(input_cap, affordable_input(gen))
mandatory = tokens(stable_rules) + tokens(skills catalogue without source) + tokens(core situation)
            + tokens(decision_request) + overhead_tokens
if budget < MIN_PACKET_INPUT_TOKENS or mandatory > budget: affordable=False, reason, return
fill in order while it fits: full unread bodies (urgent first) -> notebook -> recent_history
   -> retrieved_memories -> skill source   (each candidate added only if it fits; else omitted "budget")
input_token_estimate = tokens(messages) + overhead_tokens
reservation_compute = cognition_cost(rates, mind, input_token_estimate, gen)
```

Test: an agent flooded with 50 maximum-length messages still gets an affordable packet under
the default cap.

Refinements pinned in rev 3: (a) the generation allowance is halved while affordable input <
`max(MIN_PACKET_INPUT_TOKENS, mandatory)`, not only below the minimum; (b) with `input_rate == 0`
the generation allowance itself must still be fundable (`generation_rate × gen × mind ≤
compute_available`), else the packet is unaffordable; (c) at most `new_event_digest_limit` unread
records are presented per packet, the rest are `unread_overflow` and paged into later packets
(they stay unread); (d) routine unread records (cognition charges, run start) get no mandatory
digest line and are omitted with reason `budget` when their body does not fit; (e) retrieval
excludes unread records, the recent window, the latest observation of the current point and
cognition-charge records. A record shown only as a digest line is still marked read. The
minimum packet at defaults is ~2,500 tokens (stable rules ~1,900), so the mandatory part, not
`MIN_PACKET_INPUT_TOKENS`, is the real floor; the cheapest decision costs ~0.7 compute.
`DecisionPacketRecord.unaffordable_reason` contains the exact balance and is operator-facing:
never copy it into knowledge. The runner's resource-skip record reads "you could not afford the
minimum decision packet in round N; the turn was skipped" with content `{"reason": "resource_skip"}`
(no balance); the exact reason stays on the `resource_skip` event and the packet record.

Selection audit: every rendered record id goes to `selected_record_ids` and its section's
`record_ids`; unread records shown (body or digest line) go to `digest_record_ids`; `omitted`
lists individually only unread records not shown, recent-window records cut, and the top
`2 × retrieved_memory_limit` ranked candidates (with `score`); `omitted_counts` counts every
omission by reason (`budget`, `duplicate` = same kind + tags + text hash as an included record,
`low_rank`, `unread_overflow`). `build_packet` never mutates knowledge: the runner calls
`mark_read(digest_record_ids)` only after the provider answered (A-KNOW-5).

`validate_settings` is used by run creation, staging, apply and working reload (section 9).

### 4.4 `model.py` (models/context/skills)

```python
class ModelRegistry: get(key) -> ModelRef (UnknownModelError) ; keys() ; info(key) ; list_info() ; validate_key(key) -> str | None ; credential_env_names()
load_registry(path=config.MODELS_FILE) -> ModelRegistry
redact(text, registry=None) -> str | None
estimate_usage(request, output_text) -> ModelUsage
extract_json_object(text) -> dict | None            # json.loads(parse_constant=reject): no NaN/Infinity
parse_decision(result) -> (Decision | None, reason | None)
request_overhead_tokens(model_key, registry) -> int
is_retryable(status, http_status) -> bool
adapter_for(ref) -> Adapter
call_model(request: ModelRequest, registry) -> ModelResult      # never raises
```

`ModelRequest.metadata` always contains: `agent_id`, `turn_id`, `round`, `situation` (a
`Situation` dump), `fake_script` (list or null), `fake_script_index` (int) and `fake_options`
(dict) — see section 12. **Metadata is never forwarded to a provider.** `response_schema` is
the raw `schemas.decision_json_schema()`; each adapter owns its transform (OpenAI family:
oneOf→anyOf, no discriminator/maxLength/default, all properties required+nullable, typed
`arguments.items`, `strict` per `ref.options.strict_schema`; Anthropic: forced tool
`input_schema`; claude_cli: `--json-schema`; Bedrock: textual instructions + extraction) and
reports the resulting input overhead through `request_overhead_tokens` (A-COG-8). The textual
decision description of section 6 is ALWAYS part of the stable rules, native schema or not (rev
3: live runs showed Haiku nesting the decision inside `action` in 3 of 5 first tries when given
only the native schema; with the description it succeeded). When no native schema is sent the
adapter also appends `model.JSON_ONLY_INSTRUCTION` to the system prompt; Bedrock never sends a
native schema and embeds the compact schema in that instruction when its entry declares
`supports_json_schema`. OpenAI family: `json_schema` whenever `capabilities.supports_json_schema`
(`strict` from `options.strict_schema`; under strict mode `run_skill` arguments are scalars,
null or `{x, y}` points), `json_object` only for json-mode-only routes.
`request_overhead_tokens` = transformed schema tokens + the route's fixed overhead
(`config.MODEL_FIXED_OVERHEAD_TOKENS`, per-entry `options.overhead_tokens`) when a native
mechanism is used, else the JSON-only instruction tokens + fixed overhead.
`max_output_tokens` is the packet's (possibly reduced) generation allowance; `timeout_seconds`
(per attempt) and `max_retries` come from `config.MODEL_TIMEOUT_SECONDS` /
`config.MODEL_MAX_RETRIES`; the overall deadline is `timeout × (retries + 1)`.

Usage normalisation (no double counting; table on `schemas.ModelUsage`): OpenAI-compatible
`input = prompt_tokens − cached_tokens`, `cache_read = cached_tokens`, `output =
completion_tokens` (reasoning informational only); Anthropic/claude_cli `input_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`; Bedrock
`inputTokens`, `cacheReadInputTokens`, `cacheWriteInputTokens`, `outputTokens`.
`billed_input_tokens = input + cache_read + cache_creation`; usage is summed across attempts;
`source="estimate"` (from `estimate_usage`) when the provider reports nothing. The runner
applies `usage_estimate_safety_factor` only when `source == "estimate"`.

Result statuses: agent-output `ok` (parsed dict present), `malformed` (text but no JSON
object, or a JSON object that cannot be stored: a string with a lone UTF-16 surrogate, or
nesting deeper than `model.MAX_REPLY_NESTING` = 32 levels — `model.reply_problem`; `parsed` is
then None and `ModelResult.text` is always valid UTF-8, lone surrogates replaced by U+FFFD),
`refusal`, `truncated` (stop reason length); infrastructure `timeout`, `error`,
`invalid_config` (unknown key, missing credentials, unknown provider, unsupported capability,
`max_output_tokens` above the model's limit, 401/403/404, schema/param 400s — for every
adapter, claude_cli's `api_error_status` included). `capabilities.supports_system_prompt =
false` has a validated fallback in every adapter: the system text is folded into the first
user turn under "SYSTEM INSTRUCTIONS:" and no system message is sent (`model._split_messages`). Retries apply
only to `is_retryable` failures (timeouts, connection errors, 408, 429, 5xx, 529) with backoff
`config.RETRY_BACKOFF_SECONDS` and Retry-After up to `config.RETRY_AFTER_MAX_SECONDS`; never to
agent-output statuses. `attempts` and `attempt_errors` (redacted) record the history;
`response_model` records the model actually served; `provider_cost_usd` the reported cost.

Registry file: `{"models": [ModelRef...]}`; `${VAR}` placeholders in `endpoint`/`deployment`/
`api_version`/`region` are resolved from the environment at load time (unresolved → the ref is
unavailable with `missing_credentials` naming the var). `registry.get(key)` returns the entry
as written (placeholders intact; safe as `ref_snapshot`), `registry.resolved(key)` the copy the
adapters use, `registry.missing_requirements(key)` the names of what is missing. Fake refs are
always present. Bedrock with an empty `credential_env` uses the boto3 default chain and
`Config(retries={"total_max_attempts": 1})` (botocore's `max_attempts` would allow two).
`ModelRef.mind_multiplier` is only the initial value snapshotted into
`rules.cognition.mind_multipliers` at run creation. Forced `tool_choice` returns HTTP 400 on some
newer Claude models; set `options.tool_choice = "auto"` for those routes.

claude_cli adapter (hardened, measured with Claude Code 2.1.282): `claude -p --model <id>
--output-format stream-json --verbose --tools "" --strict-mcp-config --setting-sources ""
--no-session-persistence --disable-slash-commands --max-turns <config.CLI_MAX_TURNS = 1>
--system-prompt <system message> [--json-schema <schema>] [--max-budget-usd <options>]`, user
body on stdin, fresh empty temp cwd outside the repo, env = `config.CLAUDE_CLI_ENV_ALLOWLIST`
minus every credential env name, `EMPYREAN_*` and `CLAUDECODE`, plus
`CLAUDE_CODE_MAX_OUTPUT_TOKENS = request.max_output_tokens`; process group killed on timeout
(reaped within `config.CLI_KILL_GRACE_SECONDS`), plus `MAX_THINKING_TOKENS =
config.CLI_MAX_THINKING_TOKENS` (default 0: extended thinking off, A-COG-10; `null` keeps the
CLI default; per entry `options.max_thinking_tokens`). Result mapping (rev 3, fix pass):
`is_error` → `error`; with `--json-schema` a single valid reply reports `num_turns == 2` (the
StructuredOutput call counts as a turn), so the number of billed model requests is `num_turns −
1`; `usage.iterations` lists only the last request and cannot count them. The CLI cannot force
the StructuredOutput tool choice: when the first response is text only it re-prompts once and
the envelope sums both requests' usage and cost. Up to `config.CLI_MAX_MODEL_REQUESTS` (= 2,
A-COG-9; per entry `options.max_model_requests`) requests the reply is ACCEPTED, charged for the
summed usage, and `attempt_errors` carries the note "claude CLI re-prompted the model: N model
requests billed for this reply"; more than that is the infrastructure status `error`. Subtype
`error_max_turns` after a rejected StructuredOutput call is the agent-output status `malformed`
(charged; the turn is lost) rather than an infrastructure error. The stream's final `result`
event is the same envelope `--output-format json` prints; the earlier `assistant` / `user`
events expose what the envelope hides, so on a rejection `result.text` holds the JSON the model
actually passed to StructuredOutput, `result.error` is "structured output did not match the
decision schema: <the validator's message>" and `attempt_errors` carries the model's prose
before the tool call ("model prose before the structured reply: …"); `total_cost_usd` →
`provider_cost_usd`; `modelUsage` keys → `response_model`. Never `--bare`. The registry ships a
prompt-guided entry (`claude-cli-haiku-prompted`, no `--json-schema`) that bills about half the
tokens and avoids the malformed case.

Logging: provider, model id, status, latency, token counts only. Never message contents or
keys. Every stored error string passes through `redact`.

#### rev 4 additions (assistant)

```python
call_model(request, registry=None, *, cancel: threading.Event | None = None) -> ModelResult
kill_inflight() -> int                     # kill every live CLI process group (lifespan + atexit)
inflight_count() -> int
transcribe(audio: bytes, *, language=None, initial_prompt=None) -> TranscriptionResult   # never raises
whisper_status() -> WhisperStatus ; preload_whisper() -> None ; whisper_model_cached(name=None) -> bool
structured_output_names(purpose) -> (tool, description, schema_name)
ModelRegistry.is_assistant_only(key) ; ModelRegistry.validate_agent_key(key) -> str | None
```

* **Text response mode.** `ModelRequest.response_format="text"`: no adapter sends a JSON-only
  instruction, native schema, forced tool or `json_object` mode, even when `response_schema` is
  set. The claude_cli fallback system prompt is `CLI_TEXT_SYSTEM_PROMPT` instead of the JSON one.
  Replies are classified by `_text_status`: refusal / truncated as before (text kept), empty or
  whitespace-only → `malformed`, anything else → `ok` with `parsed=None`; `ok` = status ok and
  non-empty text. `request_overhead_tokens(key, registry, response_format="text")` counts only the
  route's fixed overhead. JSON mode is unchanged.
* **fake-assistant** (a default fake ref with `options.assistant_only`) is schema-agnostic: it
  returns `metadata["fake_script"][metadata["fake_script_index"]]` when that index exists, else
  `metadata["fake_reply"]`, else `invalid_config`. In JSON mode a dict is `ok` with `parsed`; a
  string is classified like a real reply (prose → `malformed` + `schema_mismatch`, a JSON object
  string → `ok`). In text mode a string is the text and a dict its JSON text. Every fake mode
  shares the text-mode behaviour; `fake_options.sleep_ms` waits on the cancel event;
  `fake_options.fail.error_code` is copied onto the scheduled failure; `fake_options.cost_usd` is
  reported as `provider_cost_usd` on each attempt.
* **`ModelResult.error_code`** (None when ok or unclassified): `budget_exceeded` (CLI subtype
  `error_max_budget_usd`), `rate_limited` (HTTP 429/529), `schema_mismatch` (a JSON-mode
  `malformed` reply, including the CLI validator's `error_max_turns`), `cancelled`, `timeout`,
  `not_logged_in` (claude_cli 401 or "not logged in" / "please run /login" / "invalid api key" /
  "oauth token expired" / "authentication_error" in the result or stderr), `cli_missing` (no
  `claude` on PATH, in the pre-flight with `attempts` 0 and in the adapter).
* **Cancellation.** The event is checked before every attempt; set before the first attempt the
  result is `error` / `cancelled` with `attempts` 0; set during a retry backoff the retry is
  abandoned. The claude_cli adapter polls `communicate()` in `CLI_CANCEL_POLL_SECONDS` (0.5 s)
  slices when an event is passed and on cancel SIGKILLs the process group: status `error` /
  `cancelled`, never retried, cost unknown (callers price their reservation). Without an event the
  adapter behaves as before.
* **In-flight registry.** Every live CLI subprocess is registered; `kill_inflight()` kills their
  process groups, returns the count and never raises. An interrupted call returns `error` /
  `cancelled` ("... killed at shutdown") and is not retried.
* **`provider_cost_usd` is summed** over the attempts that reported a cost (None when none did);
  it used to be the final attempt only. This also changes the agents' ledger: a retried CLI call
  now charges every billed attempt to `Manifest.real_usage` and `real_budget_usd`.
* **argv cap.** The claude_cli adapter refuses any argv string over `config.CLI_ARGV_MAX_BYTES`
  (100,000 bytes, UTF-8; covers the system prompt and `--json-schema`) as `invalid_config` before
  any process starts.
* **Purpose-named structured output.** Only purpose `decision` uses `submit_decision` / schema
  name `decision`; other purposes use the forced tool `submit_response` and an OpenAI
  `json_schema` name of `summary` / `assistant_reply` / `narrative` / `response`.
* **Local speech (Whisper).** `transcribe` decodes the raw container bytes (webm/opus, wav, flac,
  ...) with `faster_whisper.decode_audio` (PyAV, no ffmpeg binary) at 16 kHz and runs
  `WhisperModel(config.WHISPER_MODEL, device="cpu", compute_type="int8",
  cpu_threads=config.WHISPER_CPU_THREADS)`: one model per process, loaded on first use or by
  `preload_whisper()` (main only), inference serialised, `vad_filter=True`, `beam_size=5`,
  `language` normalised ("en-US" → "en"; None/""/"auto" → detect), `initial_prompt` stripped.
  Statuses: `ok` (text may be "" when no speech was heard; `language` and `duration_s` filled),
  `error` (empty or non-bytes input, over `WHISPER_MAX_AUDIO_BYTES`, undecodable, no samples, over
  `WHISPER_MAX_SECONDS`, an inference exception), `unavailable` (switched off, package missing,
  load failed). `whisper_status()` reports `ready` / `loading` / `unavailable` (with a reason) /
  `disabled` (`EMPYREAN_WHISPER_MODEL` off/none/"" or nothing loaded yet and no load started).
  Logs record model, status, audio seconds and latency, never the transcript. `faster_whisper`
  (and through it `ctranslate2` and `av`) is imported only inside `model.py`, lazily;
  `test_e2e_boundaries.py` enforces it with a recursive scan and a positive assertion.


### 4.5 `storage.py` (engine/storage)

```python
worlds_root() ; run_dir(world_id, run_id) ; find_run_dir(run_id)
atomic_write_json(path, data, fsync=True) ; read_json(path)
add_call_usage(ledger, record, interrupted=False) -> RealUsageLedger   # pure ledger helper (rev 3); one rule with runner.add_record_to_ledger (fix pass): every record counts in `calls`, an interrupted one ALSO in `interrupted_calls` (a subset)
new_run_id(name) ; new_world_id() ; code_revision()
list_runs() -> list[RunSummary] ; read_manifest(run_id) ; write_manifest(manifest)   # list_runs returns archived runs too (RunSummary.archived)
read_archive_marker(rdir) -> RunArchiveMarker | None ; archive_state(world_id, run_id) -> (archived, archived_at)
archive_run(run_id, note="") -> RunArchiveMarker ; unarchive_run(run_id)   # write / remove <run>/archive.json (idempotent)
delete_run(run_id) -> [removed folders]   # writer lock (RunInUseError when held), manifest first, then the run folder; runs/ and the world folder only when left empty
create_run(request, manifest, checkpoint, assumptions) -> Manifest
write_checkpoint(manifest, checkpoint) -> Manifest
recover_run(run_id) -> RecoveryReport
load_checkpoint(run_id, turn_id=None) -> Checkpoint ; load_checkpoint_light(run_id, turn_id) -> (Checkpoint, [ModelCallSummary], [packet ids])
list_turns(run_id, from_round=None, to_round=None) -> list[TurnIndexEntry]
read_events(run_id, since_seq, limit) ; read_turn_events(run_id, turn_id)
read_model_call(run_id, turn_id, call_id) ; read_decision_packet(run_id, turn_id, packet_id) ; read_knowledge(run_id, turn_id, agent_id) ; read_assumptions(run_id)
refresh_working(run_id, checkpoint) ; read_base_turn(run_id) ; load_working(run_id) -> (WorkingState | None, errors) ; diff_working(current, working) -> list[FieldChange]
check_working_state(world, knowledge, settings) -> errors   # stage 2 of load_working (cross-file references, rebuild_occupants, validate_world mapped to files); PARSE_STAGE_HINT ends a stage-1 error list
apply_working_changes(world, knowledge, settings, changes) -> (WorkingState | None, applied, problems)   # fix pass: a diff_working result applied onto the CURRENT state and validated as a whole (A-GOD-1); inputs untouched
write_staged_snapshot(run_id, iv_id, working) -> ref ; read_staged_snapshot(run_id, ref) ; delete_staged_snapshot(run_id, ref)
read_staged_edits(run_id) ; write_staged_edits(run_id, staged)
write_pending_model_call(run_id, record) ; list_pending_model_calls(run_id) ; clear_pending_model_calls(run_id, call_ids)
create_continuation(run_id, from_turn_id, name) -> Manifest
acquire_writer_lock(run_id) -> WriterLock | None      # flock on runs/<id>/.writer.lock; None when held elsewhere (fix pass)
working_readme_text() -> str
```

Commit protocol (`write_checkpoint`): (1) write the turn into `turns/.partial_{turn_id}/`,
remove any stale `turns/{turn_id}`, `os.replace` the partial dir; (2) write `manifest.json`
atomically — **the commit point**; (3) append to `turns/index.jsonl`; (4) refresh `working/`
(entity dirs replaced wholesale; `staged_edits.json` and `pending_model_calls/` untouched) and
write `working/BASE_TURN`; (5) delete the pending-call files whose call ids are in the
committed turn. `recover_run` (on open) keeps only the chain from `manifest.current_turn_id`
through `previous_turn_id`, deletes `.partial_*`/unreachable dirs, rebuilds a stale index or
working copy (reported), and returns leftover pending records for the runner. `list_runs`
skips run dirs without a manifest. The pending file is rewritten with the result as soon as
`call_model` returns.

Pinned in rev 3: `RecoveryReport` has `cleared_pending_calls: list[str]` (pending files of calls
a committed turn already holds, deleted rather than returned so usage is never counted twice)
and `changed_anything()`. Turn files are fsynced before the manifest when
`config.FSYNC_TURN_FILES` (env `EMPYREAN_FSYNC`, default on; `EMPYREAN_FSYNC_WORKERS` threads);
the manifest, pending-call files, staged edits and snapshots are always fsynced. After the first
commit `write_checkpoint` requires `turn.previous_turn_id == manifest.current_turn_id`, refuses
ANY already committed turn id (current or older: committed history is never replaced; a
never-committed leftover directory of that id is), and re-reads `manifest.json` to refuse a
commit when the chain head on disk is not the caller's (another writer); the runner always
passes the manifest returned by the latest `write_checkpoint` (an older copy would cut
committed turns off the chain). `manifest.real_usage` on disk is always the sum over the
committed call records: the runner adds a record's usage only in the commit that holds it
(fix pass; `RunStatus.real_usage` adds the uncommitted records on top). So while a run sits in
`error` after a billed-but-failed call, the manifest under-reports real spend by exactly the
records in `working/pending_model_calls/` (the status view already includes them); a reopen
carries those records and the next commit adds them. Ledger rule (fix pass, both helpers):
`calls` counts EVERY committed record, `interrupted_calls` those recovered from a pending file
(a subset), so the UI's "N calls (M interrupted)" reads as written. `code_revision()`
returns `<short sha>` for a clean tree, `<sha>+dirty.<source hash>` when `git status` reports
changes or untracked files, and `<config.CODE_REVISION>+src.<source hash>` without git. Read paths
never write and may run from API threads during a commit; `recover_run` writes and runs only in
`open_run`. `read_events(run_id, since_seq, limit)` returns the OLDEST `limit` committed events
with seq > since_seq. JSON style: indent 2, schema field order, id-keyed maps in the world's
insertion order (the engine iterates those dicts; sorting would change event order after a
reopen). `create_continuation` also copies `run_request.json` and starts a fresh usage ledger.

## 5. Storage layout with examples

```
worlds/world_20260925_101500_ab12/runs/run_20260925_101500_cd34/
  manifest.json                       # commit point
  .writer.lock                        # flock held by the one open worker (one active writer)
  archive.json                        # RunArchiveMarker, only while the run is archived (Resume page)
  run_request.json                    # the RunCreateRequest used (reference only)
  assumptions.json                    # [AssumptionEntry] recorded at creation
  staged_snapshots/iv_0003.json       # WorkingState of a staged apply_working_files
  working/
    README.txt  BASE_TURN
    world.json  map.json  rules.json  settings.json
    entities/agents/a01.json ...  entities/knowledge/a01.json ...
    entities/plants.json  entities/fruits.json  entities/seeds.json  entities/residues.json
    entities/removed.json
    staged_edits.json
    pending_model_calls/            # empty except during a model call / until its turn commits
  turns/
    index.jsonl                     # append-only TurnIndexEntry lines
    r00000_init/
      state.json  world.json  map.json  rules.json  settings.json  events.json
      entities/ (same as working/entities)
      model_calls/index.json  decision_packets/   (empty)
    r00001_t01_a03/
      state.json  world.json  map.json  rules.json  settings.json  events.json
      entities/...
      model_calls/index.json  model_calls/mc_r00001_t01_a03_01.json
      decision_packets/pk_r00001_t01_a03.json
    r00001_t02_a01/ ...
    r00001_end/ ...
```

`manifest.json`

```json
{
  "schema_version": "0.1.0",
  "world_id": "world_20260925_101500_ab12",
  "run_id": "run_20260925_101500_cd34",
  "name": "First fake run",
  "created_at": "2026-09-25T10:15:00+00:00",
  "updated_at": "2026-09-25T10:16:42+00:00",
  "seed": 1,
  "parent": null,
  "code_revision": "a11e51b",
  "current_turn_id": "r00001_t02_a01",
  "last_round": 1,
  "last_turn_index": 2,
  "next_event_seq": 41,
  "next_intervention_seq": 1,
  "agent_count": 8,
  "living_agent_count": 8,
  "default_model_key": "fake-heuristic",
  "finished": false,
  "finished_reason": null,
  "turn_count": 3,
  "real_usage": {"calls": 2, "interrupted_calls": 0, "input_tokens": 2840, "output_tokens": 122, "provider_cost_usd": 0.0}
}
```

`turns/r00001_t01_a03/state.json` (TurnRecord)

```json
{
  "schema_version": "0.1.0",
  "turn_id": "r00001_t01_a03",
  "kind": "agent_turn",
  "round": 1,
  "turn_index": 1,
  "acting_agent_id": "a03",
  "previous_turn_id": "r00000_init",
  "scheduler": {"round": 1, "order": ["a03", "a01", "a05", "a02", "a04", "a06", "a07", "a08"], "next_index": 1, "round_complete": false},
  "decision_source": "model",
  "packet_id": "pk_r00001_t01_a03",
  "model_call_ids": ["mc_r00001_t01_a03_01"],
  "action": {"name": "observe", "args": {"point": {"x": 0, "y": 1}, "page": 0}, "via_skill": false, "skill_name": null},
  "action_result": {"ok": true, "reason": "ok", "cost_compute": 1.0, "cost_essence": 0.0, "round": 1,
                    "data": {"point": {"x": 0, "y": 1}, "terrain": "land", "entities": [{"id": "a03", "kind": "agent", "position": {"x": 0, "y": 1}}, {"id": "p0004", "kind": "plant", "position": {"x": 0, "y": 1}}, {"id": "f0002", "kind": "fruit", "position": {"x": 0, "y": 1}}], "observed_round": 1, "page": 0, "page_size": 40, "total_entities": 3, "has_more": false},
                    "effects": {}},
  "interventions": [],
  "event_seq_start": 12,
  "event_seq_end": 16,
  "code_revision": "a11e51b",
  "saved_at": "2026-09-25T10:15:31+00:00"
}
```

`events.json` (excerpt; no `checkpoint_saved` — the UI detects commits through
`status.current_turn_id`)

```json
[
  {"seq": 12, "turn_id": "r00001_t01_a03", "round": 1, "turn": 1, "actor": "a03", "kind": "turn_started", "summary": "Cyrene (a03) begins turn 1 of round 1", "details": {}, "costs": {"compute": 0, "essence": 0}, "pending": false, "timestamp": "..."},
  {"seq": 13, "turn_id": "r00001_t01_a03", "round": 1, "turn": 1, "actor": "a03", "kind": "model_call_pending", "summary": "a03 waiting for fake-heuristic (fake/fake-heuristic)", "details": {"call_id": "mc_r00001_t01_a03_01", "model_key": "fake-heuristic", "provider": "fake", "model_id": "fake-heuristic", "reservation_compute": 2.2}, "costs": {"compute": 0, "essence": 0}, "pending": true, "timestamp": "..."},
  {"seq": 14, "turn_id": "r00001_t01_a03", "round": 1, "turn": 1, "actor": "a03", "kind": "model_call_completed", "summary": "a03 got a decision from fake-heuristic (in 1420 / out 61 tokens)", "details": {"call_id": "mc_r00001_t01_a03_01", "status": "ok", "usage": {}, "latency_ms": 1.2, "attempts": 1, "response_model": null, "uncharged_compute": 0.0}, "costs": {"compute": 0.345, "essence": 0}, "pending": false, "timestamp": "..."},
  {"seq": 15, "turn_id": "r00001_t01_a03", "round": 1, "turn": 1, "actor": "a03", "kind": "decision", "summary": "a03 decides: observe (0,1) — \"Look around first\"", "details": {"thought": "Look around first", "action": {"name": "observe", "args": {"point": {"x": 0, "y": 1}, "page": 0}}, "notebook_updated": false, "saved_skills": [], "deleted_skills": [], "memory_priorities": []}, "costs": {"compute": 0, "essence": 0}, "pending": false, "timestamp": "..."},
  {"seq": 16, "turn_id": "r00001_t01_a03", "round": 1, "turn": 1, "actor": "a03", "kind": "action", "summary": "a03 observe (0,1) -> ok: land, 3 entities (cost 1)", "details": {"action": {}, "result": {}, "via_skill": false, "skill_name": null}, "costs": {"compute": 1, "essence": 0}, "pending": false, "timestamp": "..."}
]
```

`entities/agents/a03.json` is an `Agent`; `entities/knowledge/a03.json` an `AgentKnowledge`;
`entities/plants.json` is `{"p0001": Plant, ...}` (same for fruits/seeds/residues);
`entities/removed.json` is `{id: RemovedEntity}`; `world.json` (rev 3) holds the `WorldState`
scalars (`round`, `next_entity_seq`, `rng_state`, `observation_page_size`, `warnings`) plus
`agent_order` (the ids in `world.agents` insertion order, because one file per agent loses it and
the engine emits per-agent events in dict order) and, in turn dirs only (fix pass),
`knowledge_files` = `{agent_id: {"turn_id", "sha256"}}`: a turn dir holds
`entities/knowledge/<id>.json` ONLY for the agents whose store changed since the previous
committed turn, and the map names, for every agent, the turn dir that holds its current file
(the hash is of that file's text). `load_checkpoint`, `read_knowledge` and the history API
resolve through the map, so every turn stays loadable and inspectable; `working/` and a
continuation's copied first turn always hold every file (no map in `working/world.json`);
runs written before the map read the same way. Measured (8 fake agents, seed 1, 8 rounds):
mean agent-turn dir 128 KB → 309 KB from round 1 to 8 before, 107 KB → 147 KB after; the
1000-round extrapolation fell from ~118 GB to ~32 GB (what remains per turn is the acting
agent's own growing file plus the constant call/packet/map files); `map.json` a `MapState` with `occupants`;
`rules.json` a `RulesConfig`; `settings.json` a `RunSettings`; `model_calls/*.json` a
`ModelCallRecord`; `model_calls/index.json` a list of `ModelCallSummary`;
`decision_packets/*.json` a `DecisionPacketRecord`; `staged_edits.json` a `StagedEdits`.

`archive.json` (`RunArchiveMarker`, present only while the run is archived):
`{"archived_at": "2026-09-26T10:00:00+00:00", "note": ""}`. It is written by
`POST /api/runs/{run_id}/archive` and removed by `.../unarchive`; it lives outside `turns/` and
`working/`, recovery never touches it, and a continuation does not copy it (the child run starts
active). A marker that cannot be read is logged and the run is listed as active.
`DELETE /api/runs/{run_id}` removes the whole run folder (manifest first, so a half-finished removal
is never listed), then `runs/` and the world folder only if they are left empty.

`working/README.txt` explains: pause the run, edit any file here, then `POST /api/runs/{id}/working/reload`
(or the "Reload working files" button); invalid files are reported and nothing changes; the
validated changes are staged as a `file` intervention and applied at the next turn boundary
(only if the run is still at the same committed turn); staged edits apply in staging order and
the file edit is a field-by-field diff onto the state at that moment, so UI edits staged before
or after it survive, a field changed by both keeps the later-staged value, and a file change
that can no longer be applied or would leave the state invalid fails the whole file edit
(recorded with the reason, nothing of it applied); every commit overwrites `working/`
with the new checkpoint, so edit while paused; `rules.json` does not contain the assumptions
table (edit the rule keys instead).

Assistant data (rev 4). Nothing of the assistant lives inside `turns/`: checkpoints stay
immutable, history browsing stays model-free, crash recovery never touches `assistant/`, and a
continuation does not copy it. Every file is written with `storage.atomic_write_json` (JSON) or
appended line by line under a lock (`*.jsonl`).

```
worlds/
  _assistant/                                   # config.ASSISTANT_GLOBAL_DIR_NAME
    usage.jsonl                                 # LedgerLine per call of the global scope
    conversations/<conv_id>/                    # conv_id = uuid4 hex
      meta.json                                 # ConversationMeta (run_id: null = global scope; mutable)
      messages.jsonl                            # Message lines (steps, refs, sources, errors)
      briefs.json                               # [Brief] with validation and effect
  world_.../runs/run_.../assistant/
    settings.json                               # AssistantRunSettings {storybook_auto, auto_since_turn_id,
                                                #   storybook_budget_usd, chat_budget_usd, updated_at}
    usage.jsonl                                 # LedgerLine per call of this run's scope
    .storybook.lock                             # non-blocking flock of the storybook job
    storybook/entries/opening.json              # StorybookEntry kind "opening"
    storybook/entries/r00001_t01_a03.json       # StorybookEntry kind "turn" (r00001_end.json: "round_end")
    stories/<story_id>/story.json               # StorySession (brief, picks, cast sheet, story so far)
    stories/<story_id>/chapters/0001.json       # StoryChapter
```

A run without `assistant/settings.json` (every run created before rev 4) has storybook auto off.
The entry files are the sole source of truth of the storybook (no index file); the ledger's
aggregates are computed from `usage.jsonl` on read.

## 6. Decision JSON (exactly as the LLM sees it)

The system prompt includes this description verbatim (values are examples; the notebook
limit is filled from the effective settings):

```json
{
  "thought": "optional: one or two sentences of reasoning (max 600 chars)",
  "notebook_update": "optional: replaces your whole notebook (max ~400 tokens, longer text is cut); omit or null to keep it",
  "save_skills": [{"name": "feed", "params": [], "source": "SET obs = observe(here)\nRETURN obs"}],
  "delete_skills": ["old_skill"],
  "memory_priorities": [{"record_id": "a03-k000012", "priority": 0.8}],
  "action": {"name": "observe", "args": {"point": {"x": 0, "y": 0}, "page": 0}}
}
```

`action` is exactly one of:

```
{"name":"move","args":{"direction":"up"|"down"|"left"|"right"}}
{"name":"observe","args":{"point":{"x":0,"y":0},"page":0}}          (page optional; result has has_more)
{"name":"query","args":{"entity":"self"|"<entity id>"}}
{"name":"send","args":{"recipient":"<agent id>","message":"..."}}
{"name":"broadcast","args":{"message":"..."}}
{"name":"absorb","args":{"source":"<fruit or residue id>","resource":"compute"|"essence"}}
{"name":"transfer","args":{"recipient":"<agent id>","resource":"compute"|"essence","amount":10}}
{"name":"recover","args":{"compute_budget":10}}
{"name":"attack","args":{"target":"<agent or plant id>","compute_budget":5}}
{"name":"upgrade","args":{"attribute":"vision_range"}}     (one of the eleven attribute names)
{"name":"wait","args":{"rounds":1}}
{"name":"run_skill","args":{"skill":"feed","arguments":[]}}
```

Rules told to the agent: exactly one action per turn; saving/deleting skills is free of the
action slot but the cognition to write them is paid; list a skill before the skills that CALL
it; `run_skill` executes the saved skill from its first world action this turn and continues
on later turns without asking you again until it returns, stops or errors; numbers must be
plain numbers (not strings or booleans), `rounds` and `page` integers; unknown keys or action
names make the whole reply invalid and the turn is lost (you are told why next turn).
Format gate = `Decision.model_validate(result.parsed)` (`extra="forbid"`, strict), preceded by
`model.parse_decision`'s own checks: no non-finite number, storable (`reply_problem`), and an
observe `point` that is an object with plain-integer `x`/`y` (the engine's `Point` coercions —
`[x, y]`, `"x,y"`, numeric strings, booleans — are for skills and the API, not for replies).

## 7. Events

Shape: `{seq, turn_id, round, turn, actor, kind, summary, details, costs{compute, essence}, pending, timestamp}`.
Events are immutable; `pending` is true only on `model_call_pending` and never flipped: the UI
resolves it when a `model_call_completed`/`model_call_failed` with the same `details.call_id`
arrives or the turn commits. `summary` is one readable line naming who did what and the
result — no latency numbers (QA compares summaries between runs); the live feed prints it as
`[r{round} t{turn}] {actor} {summary}`. Required `details` keys per kind:

| kind | actor | details |
| --- | --- | --- |
| run_created | system | `{run_id, world_id, agent_ids, seed, warnings: [..]}` |
| round_started | world | `{round, order}` |
| turn_started | agent | `{decision_source?}` (`skipped_dead` / `skipped_removed` / `wait` turns emit only this) |
| model_call_pending | agent | `{call_id, model_key, provider, model_id, reservation_compute}`; `pending=true` |
| model_call_completed | agent | `{call_id, status, usage, latency_ms, attempts, provider_cost_usd, response_model, uncharged_compute}`; `costs.compute` = charged cognition (`provider_cost_usd` = the reported cost or null, fix pass: the feed shows latency, USD and `usage.reasoning_tokens` as a detail line, never in the summary) |
| model_call_failed | agent | `{call_id, status, usage, latency_ms, attempts, provider_cost_usd, error, infra: bool, interrupted?: true}`; `costs.compute` = charged (0 when `infra`; the provider may still have billed the call: `provider_cost_usd` says what, and the UI never claims the attempt was free). Also emitted (`infra` false, costs 0, error "turn failed after the call; charge discarded", `status` = the reply's status) for a call that was answered but whose turn then failed: its charge went to the discarded working copy, so the carried record is `failed` with the cost as `uncharged_compute` and its completed/charged events are dropped |
| cognition_charged | agent | `{call_id, input_tokens, output_tokens, mind_multiplier, charged, uncharged}`; emitted only when an agent-output failure was charged, as an audit record: its `costs` are ZERO (the charge is already on the `model_call_failed` event; `details.charged` repeats it), so summing event costs never counts one charge twice (fix pass) |
| resource_skip | agent | `{reason, compute, minimum_needed}` |
| decision | agent | `{thought, action, notebook_updated, saved_skills, deleted_skills, memory_priorities}` |
| decision_invalid | agent | `{reason, raw_text_excerpt}` |
| skill_saved / skill_rejected / skill_deleted | agent | `{name, block_count?, error?}` |
| skill_started / skill_step / skill_finished / skill_error | agent | `{skill, ops, cost, status, error?, return_value?}` (`skill_finished` with status `stopped` and `error: "interrupted"` for interrupts) |
| action | agent | `{action:{name,args}, result: ActionResult, via_skill, skill_name}`; `costs` = charge |
| message_delivered | sender | `{recipients: [ids], broadcast, sender_visible_to: {id: bool}}` |
| damage | attacker or world | `{target, amount, health_after, cause}` |
| death | world | `{entity_id, kind, cause, residue_id}` (`residue_id` null when nothing remained) |
| residue_created | world | `{residue_id, source_id, compute, essence, position}` |
| plant_growth | world | `{plant_id, stage, size, energy, essence}` or `{count, total_energy_inflow, total_essence_inflow, skipped_non_land: [ids]}` |
| fruit_spawned / fruit_removed / seed_spawned / germination | world | `{plant_id, entity_id, position, ...}` (`fruit_removed`: `lost_compute`, `reason`) |
| upkeep | world | `{agent_id, paid, owed}` |
| starvation | world | `{agent_id, health_loss, health_after}`: its own kind (rev 4 doc correction; the code always emitted it separately), emitted after the `upkeep` event of an agent that could not pay in full; a resulting death follows as `death` with cause `starvation` |
| round_ended | world | `{round, living_agents, deaths}` |
| intervention | operator | `{intervention: Intervention, ok, error, changes: [FieldChange], origin, effective_turn_id}` |
| operator_voice | operator | `{recipients, text}` (the text is also in each recipient's knowledge) |
| run_finished | system | `{reason}` |
| error | system | `{message, traceback_excerpt}` (both redacted; excerpt ≤ 5 lines) |

## 8. Turn procedure (runner)

```
_turn():
  work = deepcopy(committed checkpoint); status = turn_active
  if pause_requested: status = paused; return
  stamp the boundary turn id (fix pass: the spec's step 1 order — edits, then initiative):
     if scheduler.round_complete: round = world.round + 1; provisional order = compute_initiative on the world AS IS
        (the run RNG state is put back); id = r{round}_t01_{order[0]} (or r{round}_end with no living agents)
     else: if next_index >= len(order): round-end turn (id r{round}_end) else agent = order[next_index]; turn_index = next_index + 1; id = r{round}_t{turn_index}_{agent}
  apply staged edits (effective_turn_id = that id, applied_round = round) -> InterventionRecords + events; re-validate every agent's effective settings
     (an apply_working_files snapshot must carry the committed world.round; a failing intervention is skipped whole, nothing placed;
      cause before effect: the intervention event is emitted FIRST, then the death / residue_created events a set_stat kill produced)
  carry any recovered/failed call records and their events for this turn id into work.model_calls / events
  check finish: no living agents (or max_rounds reached at a round boundary, evaluated BEFORE the new round starts)
  if scheduler.round_complete: start the round: world.round += 1, order = world.compute_initiative (the RNG consumed once), next_index = 0,
     round_complete = False; if the first agent differs from the provisional one re-stamp the events/records; event round_started
  if finished: commit a final checkpoint under the boundary id if needed (agent-turn kind, slot consumed — pinned below), status = finished, event run_finished; return
  if round-end turn: outcome = world.end_round(world); route notices; events; scheduler.round_complete = True; commit; return
  next_index += 1; a scheduled id no longer in world.agents commits a skipped_removed checkpoint (A-SCHED-4)
  agent turn:
     event turn_started
     if not agent.alive: decision_source = skipped_dead; commit; return
     if agent.wait_turns_remaining > 0: wait_turns_remaining -= 1; decision_source = wait; commit; return
     resumed = False
     if agent.skill_execution and agent.skill_execution.status == "running":
          if any unread record kind in rules.skills.interrupt_on (the runner's own feedback records — content keys
             cognition_charged / reason / skill — never count, only arrivals do): skills.stop_execution(state, "interrupted"); event skill_finished; (fall through to a model decision)
          else:
            resumed = True; decision_source = skill; outcome = skills.run_until_action(...) with state.ops_this_turn seeded from the ops already spent this agent turn (the cap is per turn, a fresh run_skill after a fall-through continues the count); charge interpreter cost (total_interpreter_spent); event skill_step
            if outcome.action: execute it (via_skill=True) -> world.apply_action; deliver_result; record_action_result; commit; return
            if outcome.invalid_action: event action (result invalid_argument, cost 0); last_action/last_result; record_action_result; commit; return
            if state.status == "running" (op budget yield): event skill_step; action_result = None; commit; return
            else (finished/stopped/error): event skill_finished/skill_error; on error: last_result = ActionResult(ok=False, reason="skill_error"), system knowledge record; then CONTINUE into a model decision in this same turn (A-SKILL-11)
     packet: situation = context.build_situation(...); settings = effective; capabilities = registry; overhead = model.request_overhead_tokens
          packet = context.build_packet(..., compute_available=agent.stats.compute, overhead_tokens=overhead); store packet record
          if not packet.affordable: event resource_skip (exact reason and balance); balance-free system knowledge record; decision_source = skipped_unaffordable; commit; return
     model call: record = ModelCallRecord(status=pending, ref_snapshot) -> storage.write_pending_model_call; event model_call_pending; status = waiting_model
          result = model.call_model(request, registry); status = turn_active; rewrite the pending file with the result
          if settings.real_budget_usd reached (committed ledger + this turn's uncommitted records) -> error "host budget exhausted" (the call record and events are carried); the ledger itself is updated at commit
          if result.status in INFRA_STATUSES: event model_call_failed(infra=true); NO charge; NO mark_read; run -> error (last_error "provider failure: <status>"); return   (A-COG-5)
          agent.model_call_count += 1; context.mark_read(packet.digest_record_ids)   (A-KNOW-5)
          charge cognition: cost = cognition_cost(rates, mind, usage.billed_input_tokens × (safety factor if estimate), usage.output_tokens); charged = min(cost, balance); uncharged = cost - charged; record both; events model_call_completed (or model_call_failed for malformed/refusal/truncated, charged when charge_failed_calls)
          system knowledge record "your last decision cost X compute" (cognition_charged)
          decision, reason = model.parse_decision(result)
          if decision is None: event decision_invalid; system knowledge record (reason ≤ 200 chars); last_result = ActionResult(ok=False, reason="invalid_action"); decision_source = model; no action; commit; return
     event decision; apply notebook update (truncation -> system record); apply memory priorities
     for name in delete_skills: check_delete -> delete (stop execution if in frames) and event skill_deleted, or event skill_rejected + system record
     for req in save_skills (list order): skills.validate_and_build -> agent.skills[name] (event skill_saved; stop execution if in frames) or event skill_rejected + system record
     action:
        run_skill -> start_execution (unknown/arity -> event skill_error, system record, last_result invalid_action, no fee, turn used); agent.skill_execution = state; outcome = run_until_action; as above, except a fresh run_skill that ends without an action USES the turn (no second model call)
        world action -> agent.skill_execution = None; ActionRequest(via_skill=False) -> world.apply_action
     record_action_result (with thought) for the actor; route outcome.notices to context.record_notice; append events; process deaths
     commit
```

Commit = build `Checkpoint(turn=TurnRecord, world, knowledge, settings, events[this turn incl. carried],
model_calls[this turn incl. carried], decision_packets[this turn])` → add every record in
`model_calls` to a COPY of the manifest's `real_usage` (every record in `calls`; interrupted ones
ALSO in `interrupted_calls`)
→ `storage.write_checkpoint` → swap the committed checkpoint and manifest under the lock →
clear `last_error`. Nothing outside a commit ever changes the persisted ledger.

Cognition reservation: `reservation_compute` from the packet is not deducted; it only bounds the
packet. Actual usage is charged after the call (`agent.stats.compute -= charged`, never below 0;
`total_cognition_spent += charged`; the gap is `uncharged_compute`, A-COG-6). With
`charge_failed_calls` true, agent-output failures with reported or estimated usage are charged
too; infrastructure failures never are.

Pinned in rev 3:

* Finish detected at an AGENT-turn boundary (the finished-state re-check after staged edits that
  do not revive the run): the checkpoint takes that boundary's turn id with kind `agent_turn`,
  `decision_source: "none"`, and the scheduler slot is consumed (the id is never reused; a
  revived run continues with the next slot, so that agent skips one turn). At a round-end
  boundary it is kind `round_end` with `round_complete = True`. There is no terminal `TurnKind`.
* Host budget (A-COG-7): "reached" when `real_usage.provider_cost_usd > 0` and `>=
  settings.real_budget_usd` (a fake run with budget 0 never trips); checked before each call and
  again after it. A post-call trip records the measured usage uncharged and carries the call
  record into the re-run.
* `ModelCallRecord.status` is `completed` only for `result.status == "ok"`; malformed / refusal /
  truncated records are `failed` with `result_status` set. `agent.model_call_count` increments
  only on agent-output statuses (so `fake_script_index` repeats after an infrastructure failure).
* `turn_started` carries `details.decision_source` only for skipped_dead / skipped_removed / wait
  turns; the `decision` event lists the REQUESTED save/delete names and `skill_saved` /
  `skill_rejected` / `skill_deleted` say what happened; a separate `cognition_charged` event is
  emitted only when an agent-output failure was charged.
* `RunnerError` messages starting with `run_not_open` map to 409 `run_not_open`; every other
  `RunnerError` to 409 `illegal_command`; `runner.NotFoundError` / `storage.StorageError` to 404.

Recovery on open (`RunManager.open_run`): `storage.recover_run` → leftover pending records become
`ModelCallRecord(status="failed", error="interrupted (outcome uncertain)", charged 0)` with a
`model_call_failed` event (`infra: true, interrupted: true`); their usage is added to
`manifest.real_usage` (`interrupted_calls`). The worker keeps them and carries them into the
next committed turn (same turn id re-run; the new call gets the next index). The turn is
re-run from the last complete checkpoint, so no committed action is repeated. Recovery from
`error` inside a process works the same way (the failed attempt's call record and `error`
event are carried; a call the attempt had answered and charged is carried as `failed`,
charged 0, the measured cost as `uncharged_compute`, with a `model_call_failed` event in place
of its completed/charged events — the charge was applied to the discarded copy only). Their
usage enters `manifest.real_usage` in the carrying commit, never before, so a stage/reload
between the failure and the commit, or a later crash and reopen, cannot count it twice.

## 9. API

Base `/api`. All bodies JSON (except the raw audio body of `POST /assistant/transcribe`).
Errors return `ApiError {error: ApiErrorCode, detail, problems}` (section "Rules" in `api.py`):
404 `not_found`; 409 `run_not_open` / `illegal_command`; 422 `invalid_setup` /
`invalid_intervention` / `validation_error` / `unknown_model` with `problems[{path, message}]`
(paths like `agents[2].position`); 413 `payload_too_large`; 500 `internal_error` (with CORS
headers). Assistant routes (rev 4) add 503 `assistant_unavailable` (no `AssistantService` in this
process, or no usable model), 409 `assistant_busy` (a bounded queue is full),
409 `brief_not_pending`, 409 `assistant_budget_exhausted`, 409 `conversation_busy`. The run archive
adds 409 `run_in_use` (`DELETE /runs/{run_id}` of a run that is open in this backend, whose writer
lock another process or a closing worker holds, or that has a queued or running story, storybook or
sequencer job). The UI reopens the run once on `run_not_open`.

This table, the route table in the `api.py` docstring and the request calls in
`frontend/src/api/*.ts` must list exactly the routes the app serves; `scripts/check_docs.py`
compares all four (path parameters are compared by position, query strings are ignored).

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/health` | | `{ok, version}` |
| GET | `/defaults?agent_count=8` | | `RunCreateRequest` (6–12 prefilled cards; `default_model_key` is the operator default `EMPYREAN_DEFAULT_MODEL`, `claude-cli-haiku` unless unavailable, then `fake-heuristic`) |
| GET | `/models?include_assistant=0&include_test=0` | | `ModelInfo[]` (assistant-only refs hidden unless `include_assistant=1`; the test doubles `fake-scripted` and `fake-malformed` hidden unless `include_test=1`; `ModelInfo.test_only`) |
| GET | `/assumptions` | | `AssumptionsView` |
| POST | `/world/preview` | `WorldPreviewRequest` | `MapState` |
| GET | `/runs?archived=0\|1\|all` | | `RunSummary[]` (default `0`: active runs only; `1` the archive; `all` both) |
| POST | `/runs` | `RunCreateRequest` | `RunSummary` (201) |
| POST | `/runs/validate` | `RunCreateRequest` | `RunValidationResponse` |
| POST | `/runs/{run_id}/open` | | `RunStatus` |
| POST | `/runs/{run_id}/close` | | `RunStatus` |
| GET | `/runs/{run_id}` | | `RunSummary` |
| DELETE | `/runs/{run_id}` | | 204, no body (the run folder is removed for good; 409 `run_in_use` while open; 404 unknown) |
| POST | `/runs/{run_id}/archive` | | `RunSummary` (writes `archive.json`; idempotent, keeps the first `archived_at`) |
| POST | `/runs/{run_id}/unarchive` | | `RunSummary` (removes `archive.json`; idempotent) |
| GET | `/runs/{run_id}/assumptions` | | `AssumptionsView` |
| GET | `/runs/{run_id}/status` | | `RunStatus` |
| POST | `/runs/{run_id}/commands` | `CommandRequest` | `RunStatus` |
| GET | `/runs/{run_id}/events?since&limit` | | `EventsResponse` |
| GET | `/runs/{run_id}/state` | | `TurnView` (live) |
| GET | `/runs/{run_id}/pending_model_call` | | `PendingModelCallView` (404 when none) |
| GET | `/runs/{run_id}/turns?from_round&to_round` | | `TurnIndexEntry[]` |
| GET | `/runs/{run_id}/turns/{turn_id}` | | `TurnView` |
| GET | `/runs/{run_id}/turns/{turn_id}/events` | | `Event[]` |
| GET | `/runs/{run_id}/turns/{turn_id}/agents/{agent_id}/knowledge` | | `AgentKnowledgeView` |
| GET | `/runs/{run_id}/turns/{turn_id}/model_calls/{call_id}` | | `ModelCallRecord` |
| GET | `/runs/{run_id}/turns/{turn_id}/decision_packets/{packet_id}` | | `DecisionPacketRecord` |
| GET | `/runs/{run_id}/agents/{agent_id}/knowledge` | | `AgentKnowledgeView` (live) |
| GET | `/runs/{run_id}/settings` | | `EffectiveSettingsView` |
| GET | `/runs/{run_id}/rules` | | `RulesConfig` |
| GET | `/runs/{run_id}/interventions` | | `StagedInterventionsResponse` |
| POST | `/runs/{run_id}/interventions` | `Intervention` | `StagedInterventionsResponse` (201) |
| DELETE | `/runs/{run_id}/interventions/{iv_id}` | | `StagedInterventionsResponse` |
| POST | `/runs/{run_id}/working/reload` | | `ReloadResponse` |
| POST | `/runs/{run_id}/continuations` | `ContinuationRequest` | `RunSummary` (201) |

Assistant routes (rev 4; `backend/empyrean/assistant/routes*.py`, request and response models in
`backend/empyrean/assistant/models.py`, mirrored in `frontend/src/api/assistantTypes.ts` and
`storyTypes.ts`). An app built without an `AssistantService` (tests, `scripts/run_sim.py`)
answers every one of them 503 `assistant_unavailable`. None of them opens a run except an
approved brief that executes a run action.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/assistant/capabilities?run_id=` | | `AssistantCapabilities` |
| GET | `/assistant/conversations?run_id=&all=0` | | `ConversationMeta[]` |
| POST | `/assistant/conversations` | `ConversationCreateRequest` | `ConversationMeta` (201) |
| GET | `/assistant/conversations/{conv_id}` | | `ConversationView` |
| PATCH | `/assistant/conversations/{conv_id}` | `ConversationPatchRequest` | `ConversationMeta` |
| DELETE | `/assistant/conversations/{conv_id}` | | `{}` (409 `conversation_busy` while a job runs) |
| POST | `/assistant/conversations/{conv_id}/messages` | `MessageCreateRequest` | `MessageAccepted` (202, `{job_id}`) |
| POST | `/assistant/conversations/{conv_id}/jobs/{job_id}/cancel` | | `JobView` |
| POST | `/assistant/conversations/{conv_id}/briefs/{brief_id}/approve` | `BriefApproveRequest` `{validated_against_turn_id}` | `BriefResponse` (409 `brief_not_pending`) |
| POST | `/assistant/conversations/{conv_id}/briefs/{brief_id}/reject` | `BriefRejectRequest` | `BriefResponse` |
| GET | `/runs/{run_id}/assistant/settings` | | `AssistantRunSettingsView` |
| PUT | `/runs/{run_id}/assistant/settings` | `AssistantRunSettingsUpdate` | `AssistantRunSettingsView` |
| GET | `/runs/{run_id}/assistant/storybook?last_n=` | | `StorybookView` (read-only; never generates) |
| POST | `/runs/{run_id}/assistant/storybook/generate` | `StorybookGenerateRequest` | `StorybookGenerateResponse` (202) |
| POST | `/runs/{run_id}/assistant/storybook/entries/{turn_id}/regenerate` | | `StorybookGenerateResponse` (202) |
| GET | `/assistant/stories?status=all\|unfinished\|finished` | | `StorySessionSummary[]` (every run, most recently updated first, `run_name` filled; `unfinished` = interviewing, brief ready, writing, paused, interrupted; `finished` = complete) |
| GET | `/runs/{run_id}/assistant/stories` | | `StorySessionSummary[]` |
| POST | `/runs/{run_id}/assistant/stories` | `StoryCreateRequest` | `StoryView` (201; deterministic run card, no model call) |
| GET | `/runs/{run_id}/assistant/stories/{story_id}` | | `StoryView` |
| POST | `/runs/{run_id}/assistant/stories/{story_id}/messages` | `StoryMessageRequest` | `StoryView` (202; the author writes or revises the brief) |
| POST | `/runs/{run_id}/assistant/stories/{story_id}/approve` | `StoryApproveRequest` | `StoryView` (202; starts the chapter job) |
| POST | `/runs/{run_id}/assistant/stories/{story_id}/reject` | `StoryRejectRequest` | `StoryView` |
| POST | `/runs/{run_id}/assistant/stories/{story_id}/cancel` | | `StoryView` |
| POST | `/runs/{run_id}/assistant/stories/{story_id}/continue` | `StoryContinueRequest` `{to_turn_id?, generate_all?, job_budget_usd?}` | `StoryView` (202; `{to_turn_id: null}` extends to the last committed turn, `generate_all: true` writes every remaining chapter instead of 3 ahead of the reader, `job_budget_usd` raises the story budget and resumes a paused story) |
| GET | `/runs/{run_id}/assistant/stories/{story_id}/chapters/{n}?mark_read=1` | | `StoryChapter` (moves the reader position) |
| GET | `/runs/{run_id}/assistant/stories/{story_id}/export` | | `StoryExport` (Markdown) |
| POST | `/assistant/transcribe?language=en&run_id=&initial_prompt=` | raw audio (`audio/webm`, `audio/ogg`, `audio/wav`, `audio/mp4`; 10 MB cap) | `TranscriptionResult` (413 `payload_too_large`, 409 `assistant_busy`, 503 while speech is not ready) |

Assistant route semantics: chat and story messages answer 202 and run on the assistant's
executors (chat 2 workers, story 1, storybook 1, speech 1); the drawer polls
`GET /assistant/conversations/{conv_id}` every 700 ms while a job runs. Approve runs under the
conversation lock: CAS `pending` → `executing`, revalidation against the current committed
turn, server-side execution, and the stored `BriefEffect` is returned again on a retried
approve. Brief validation never opens a run (the open worker's committed checkpoint, else
`storage.load_checkpoint` read-only). Details: `docs/ASSISTANT.md`.

Routes that need the runner (`status`, `commands`, `events`, `state`, `pending_model_call`,
live knowledge, settings, rules, interventions, reload, close) return 409 `run_not_open` unless
`POST .../open` was called (the frontend calls open when entering a run and close when
leaving). `open` is 409 `illegal_command` while another process holds the run (one active
writer). Routes are plain `def`, run in FastAPI's thread pool, so a slow open/reload/close never
freezes the event loop; `close` returns at once (its `RunStatus` may still say
`pause_requested`) while the worker commits its active turn and exits. History routes read from disk and work for any run. `turn_id = "live"` in
turn-scoped GETs reads the open runner's committed checkpoint. A continuation's first turn
resolves its "previous" arrow through `TurnView.parent`.

Setup validation (`RunManager.validate_setup`, used by `POST /runs` and `/runs/validate`; every
problem reported at once): 6–12 cards; unique ids matching `^[A-Za-z0-9]{1,16}$` and not
reserved; unique names; position inside the region (mountains are corrected, A-WORLD-6); stats
≥ 0, health ≤ max_health, essence ≤ essence_capacity; model exists and is available (default
and per card); `context.validate_settings` for the run defaults and every card's effective
settings against its model; initial_skills compile; `initial_plants` species exist in
`rules.plant_species`. `seed` is strict at the shape gate (rev 3): a JSON boolean or string is a
422 `validation_error` at path `seed`. Problem paths (rev 3): a duplicate id or name is reported
on the SECOND card (`agents[5].id` / `agents[5].name`, the message names the first); a negative
or non-finite stat on `agents[i].stats.<name>`; a bad card position on `agents[i].position`;
context problems on `context.<field>` (run) or `agents[i].context_overrides.<field>`; model keys
on `default_model_key` / `agents[i].model_key`; skills on `agents[i].initial_skills[j]`.

`GET /runs/{id}/settings` (rev 3) also returns `limits` (`ContextLimits`: `min_packet_input_tokens`,
`min_generation_tokens` from config) so the UI's inline checks cannot drift; the static bounds
stay on `ContextSettings`. `POST working/reload` with invalid files returns 200 with `ok: false`
and `errors[...]` (file path + problem: the engine's `validate_world` messages are mapped to the
working file they point at, e.g. `working/entities/agents/a02.json: health 500.0 exceeds
max_health 100.0`, `working/entities/plants.json: p0003: ...`; only cross-table problems keep a
`world:` prefix), nothing staged; 409 only when the run is not paused / error / finished; never
422. Semantic checks need the whole world, so they run once every file parses; while any file
fails to parse or match its schema the error list ends with `working/: fix the JSON errors above
first; semantic checks run once every file parses` (`storage.PARSE_STAGE_HINT`).

Fix-pass fields: `RunStatus.next_round_order` (when `next_step == "new_round"`: the initiative
`compute_initiative` would give the next round from the committed world as it is, computed on a
private copy at commit time; a prediction, staged edits can change it; null otherwise);
`RunSummary.run_dir` (absolute run folder on the backend machine, so the UI can show
`<run_dir>/working/`); `ModelCallSummary.provider_cost_usd` and `.reasoning_tokens`.

Run archive: `RunSummary.archived` (bool, default false) and `RunSummary.archived_at` (ISO or null)
come from the run folder's `archive.json` in every summary (`GET /runs`, `GET /runs/{id}`, create,
continuation, archive, unarchive). `GET /runs` hides archived runs unless `archived=1` or `all`; the
Story Mode run picker and the assistant's `list_runs` tool use the default. Archiving an open run is
allowed (it keeps running; only the listing changes). Deleting needs the run closed everywhere.

Frontend polling: `pollEvents(runId, …, initialSince = max(0, status.latest_seq − 300))` every
~700 ms (also while paused, cheaply), plus `getLiveState` when `status.current_turn_id`
changes. The poller resets its cursor when `feed_epoch` changes or seqs rewind (`onReset`).
History navigation uses `listTurns` and `getTurn`; the UI keeps an explicit live/history
indicator and a "return to live" button, and a "Recover (pause)" control in the `error` state.

## 10. Interventions (god mode)

Staging (`POST /interventions`) validates fully (422 `invalid_intervention` with problems),
assigns `iv_{seq}` and persists `working/staged_edits.json` (in memory under the runner lock).
At the next boundary each is applied and recorded (`InterventionRecord` in `state.json` and an
`intervention`/`operator_voice` event with before/after). Nobody is charged.

| type | applied by | effect |
| --- | --- | --- |
| set_stat | world | dotted field on an entity, validated by re-parsing the entity model; species checked against the rules; integer stats stay integers; a living agent left at health ≤ 0 dies (`cause="operator"`); `alive` false→true is rejected (death is resolved once); a plant `stage_index` also settles `age_rounds`/`size` |
| place_entity | world (+ runner for settings/knowledge) | partial entity accepted, id assigned if empty; plants/seeds on land (a plant's age settled to its stage, its balances recorded as source inflow), agents not on mountains; a placed agent's `model_key` / `context_overrides` are validated against the settings in force at the boundary BEFORE anything is placed (a rejection changes nothing); it gets a knowledge store with a run-start record and its assignment in RunSettings; placed at a round end it acts in the round that starts, placed mid-round it joins the next round's initiative |
| remove_entity | world | entity removed (recorded in `world.removed`, reason `operator`); an agent's knowledge is kept; a scheduled id is later skipped (`skipped_removed`) |
| edit_knowledge | context | add (`KnowledgeRecordInput`: only `kind` and `text` required; `content`/`tags`/`importance`/`read` optional; other keys ignored; provenance forced to `operator`, id/seq/round assigned) / remove a record, or replace the notebook |
| voice | context | `operator_voice` record for each recipient (agents / broadcast_all = all living / at_point = living agents at the point) |
| update_context_settings | settings | scope `run`: non-null fields merged into `settings.context`; scope agent: `context_overrides[agent]` REPLACED by the object minus nulls (all-null deletes it); validated against the effective model at staging and apply |
| update_plant_rules | world | replaces `rules.plant_species[species]` (`rule.name == species`); plants beyond the new stage count are clamped (recorded) |
| update_prices | world | replaces `rules.prices` |
| update_model_assignment | settings | run default or per-agent override (key exists and available); mind multiplier snapshotted into `rules.cognition.mind_multipliers`; affected agents' context settings re-validated (reject whole on failure) |
| update_run_settings | settings | `max_rounds` / `real_budget_usd` (with clear flags) / `play_delay_seconds` |
| apply_working_files | runner | applies the reload's recorded field diff (`changes`, taken by `diff_working` against the committed turn `base_turn_id`) onto the boundary state AS IT IS after the staged edits applied before it (`storage.apply_working_changes`, A-GOD-1) — never a wholesale replacement, so UI edits staged before or after the reload all survive; a field changed by both keeps the later-staged value; the result is validated as a whole (schema, cross-file references, `validate_world`, then every agent's effective context settings) and a change whose parent no longer exists (its entity was removed by an earlier staged edit) or any validation problem rejects the WHOLE file edit (`ok=False` with the paths and reasons, nothing of it applied; the other staged edits still apply). Requires `base_turn_id` equal to the committed turn and an unedited `world.round` (checked in the diff and in the snapshot `snapshot_ref`, which stays a record of what was reloaded); otherwise `ok=False` ("stale" / "invalid world: round ..."). The record's `changes` carry the value each field really had at apply time as `before` (the staged intervention keeps the diff as shown at reload). Applied before a new round's initiative, so it never rolls a started round back |

Staging order is application order (fix pass, A-GOD-1): the staged list is applied top to
bottom at the boundary, a `working/` reload included, and every kind of edit is a delta onto
the state at that moment, so no staged edit can undo another one; when two edits touch the
same field the one staged later wins (as with two UI `set_stat`s). The UI says so next to
"Reload working/ files", and `working/README.txt` step 5 says the same.

`POST working/reload` is allowed only while paused/error/finished. Knowledge edits are separate
from changing reality: placing a fruit does not tell any agent. A rejected `place_entity` names
the kind and the point (`new plant at (3,4) must be on land, not water`), never an id the engine
assigned tentatively; an operator-given id is named. In the feed the `intervention` event
precedes the `death` / `residue_created` events of a set_stat kill (cause before effect). Staging and reload are allowed in
`finished`; a run command then applies them and re-checks the finish condition.

Not supported (rev 3): deleting or renaming a plant species by intervention
(`update_plant_rules` only replaces or adds one); remove species at run creation instead. The
frontend `GodModePanel` takes `staged: ReadonlyArray<Intervention | InterventionRecord>` and
`onDiscard(seq, id)`; the API side stays `StagedInterventionsResponse.staged: Intervention[]` and
`DELETE .../interventions/{iv_id}` by id.

## 11. Continuations

`POST /runs/{run_id}/continuations {from_turn_id, name?}` → `storage.create_continuation`: a new
run under the same world whose first and current checkpoint is a copy of the parent's
`turns/{from_turn_id}` (same turn id, so rounds continue numbering), `manifest.parent =
{world_id, run_id, turn_id}`, `next_event_seq` continues from that turn's `event_seq_end + 1`,
`next_intervention_seq = 1`, fresh working copy, empty staged edits, copied `assumptions.json`,
default name `"<parent name> from <turn_id>"`. The parent and its later turns are untouched. The
new run opens paused; the operator may then stage edits/edit working files and play forward.
The turn index of a continuation starts at the copied turn; the UI shows "← parent run @ turn"
(from `TurnView.parent`) for earlier history.

## 12. Fake adapter behaviour (for QA)

`fake-heuristic` is a pure function of `(agent_id, round, turn_id, situation, fake_options)`
seeded with `random.Random(f"{agent_id}:{round}:{turn_id}")` (never `hash()`): same inputs →
same decision across processes. Priority order is documented in `model.FakeAdapter`. It must
cope with `situation.self_state` fields being None and refreshes them with `query(self)` every
6th round. With eight default agents and seed 1 a run must be reproducible turn for turn (QA
compares two fresh runs' event summaries ignoring timestamps; summaries carry no latency).

Scripts and options travel through the run request: `AgentCard.fake_script` (a list of Decision
dicts) and `AgentCard.fake_options` are copied by `RunManager.create_run` into
`RunSettings.fake_scripts[agent_id]` / `fake_options[agent_id]`; the runner puts
`metadata["fake_script"] = settings.fake_scripts.get(agent_id)`, `metadata["fake_script_index"] =
agent.model_call_count` and `metadata["fake_options"] = settings.fake_options.get(agent_id, {})` on
every request (real adapters ignore them). `fake-scripted` returns `fake_script[index]` and falls
back to the heuristic when exhausted or absent. `fake-malformed` cycles by `(round + agent index)
% 3`: 0 → invalid JSON text, 1 → unknown action name, 2 → valid heuristic decision.
`fake_options`: `aggressive`, `idle`, `fail: {status, rounds, failing_attempts, http_status}`
(exercises retries, infrastructure classification, `charge_failed_calls` and pending-call
recovery without a live provider), `sleep_ms`. `agent.model_call_count` is incremented only when
the provider returned a response (agent-output statuses), so an infrastructure failure re-runs
the same script index.

Pinned in rev 3: `fail.failing_attempts` is counted across all calls of one turn: the attempt
ordinal is `(n − 1) × (max_retries + 1) + attempt` with `n` read from the request id
`mc_{turn_id}_{n:02d}`, so `failing_attempts: 3` exhausts call `_01` and the re-run `_02`
succeeds (the pause-recovery test relies on it); `fail.http_status` defaults to 500 for status
`error`. The `fake-malformed` "agent index" is the trailing digits of the agent id (`a03` → 3),
else the sum of its character codes. The fake heuristic is `model.fake_heuristic_decision` (pure)
and its skill is `model.FORAGE_SKILL_SOURCE` (design example 2, 48 blocks); it never absorbs
unless the situation lists a fruit/residue with a known `available_*` amount, so long-run
ecology (absorption, deaths, residue) is not exercised by the fakes alone.

## 13. Testing contract (QA)

* Unit tests use only fake models; `EMPYREAN_LIVE_TESTS=1` enables `@pytest.mark.live`.
* Fixtures in `tests/conftest.py`: `worlds_dir` (temp), `registry`, `default_request`, `rules`,
  `world`, `manager`, `client` (FastAPI TestClient).
* Required end-to-end checks (spec "Completion criteria"): create → play 3 rounds → pause →
  reopen → continue without repeating a committed action (compare turn ids and event seqs);
  malformed model output never applies an effect; skill and direct actions charge 0.8× / 1×;
  packets contain only the agent's records; voice reaches recipients' knowledge; working/ edit +
  reload produces an intervention with before/after; continuation preserves the parent's future.
* Required contract checks from this revision: `config.default_rules() == RulesConfig()`;
  design example 3 saved as a skill yields `upgrade_quotes.vision_range.compute == 20` and
  `essence == 2`; design example 1 uses exactly 3 agent turns and the 4th is a model decision;
  a skill transfer of 10 compute leaves the sender at −10.8, the recipient at +10,
  `cost_compute == 0.8`; a packet of an agent that never queried itself shows the derived
  belief (`self_state.source == "derived"`) and, after an undisclosed upkeep, differs from the
  authoritative balance; `IF r.ok == true AND r.data.x > 0` with a failed `r` evaluates to false
  without error; 50 max-length messages still yield an affordable packet; a fake `fail`
  timeout puts the run in `error` with no charge and pause re-runs the same turn with call id
  `_02`; usage-normalisation goldens per provider payload; a claude_cli live call bills ≤ 1.5×
  the packet estimate.
* Browser checks (QA, required): create/resume, edit cards (validation problems shown by
  path), run turn/play/pause/step round, history arrows + return to live, god mode settings,
  crowded coordinate click/hover, error-state recovery.
* Assistant browser checks (rev 4, `qa/browser_check.mjs` steps 18-33, fake models only): drawer
  entry, docking and floating; the run-page tabs row on one line under 34 px; a question with its
  context chip; progress and refs; a create-run brief approved into a run; an interventions brief
  with a validation problem, Ask for changes and a superseding brief; the God mode badge; the
  Storybook tab; Escape order with the record viewer; Story Mode to the first chapter; Dictate on
  secure and non-secure origins. The scripted steps need the QA backend `qa/assistant_fake_server.py`,
  which forces every assistant profile to `fake-assistant` and adds `GET/PUT /api/_qa/fake_metadata`
  (it sets `AssistantService.fake_metadata`, the per-profile metadata the fake adapter answers
  from). That hook is QA-only: it is not part of the API in section 9 and the served app never
  has it. Against a backend with live assistant keys the steps that would call a model skip.
* Storage growth (fix pass): a turn dir's `entities/knowledge/` holds only the changed stores
  and `world.json.knowledge_files` covers every agent; `read_knowledge` of an unchanged agent at
  any turn equals the file the map points at.
* Assistant (rev 4): every assistant test uses the `fake-assistant` key (or other fakes) and an
  `AssistantService` built with `auto_live_allowed=False`; a guard makes any real CLI attempt fail
  the test. Tests that run local Whisper are marked `whisper` and skip unless the model is in the
  local cache and a sample clip exists (`EMPYREAN_WHISPER_TEST_AUDIO` or
  `backend/tests/data/jfk.flac`, not committed). The provider boundary test scans
  `backend/empyrean/` recursively.
* Docs (rev 4): `backend/tests/test_docs_consistency.py` runs `scripts/check_docs.py`, so
  `pytest -q` fails on drift between the docs and the code (routes, env vars, assumptions, test
  ids, control labels, paths and symbols, stale phrases, the docs index).

## 14. Change control

The rules are in `CLAUDE.md` ("Change control for shared contracts" and "Docs rule"); they
replace the original frozen-file process of revisions 1-3. In short: `schemas.py`, `config.py`,
`api.py`, `types.ts` and `client.ts` (plus `assistant/models.py` and its TypeScript mirrors) are
change-controlled. A change edits the Python model and its TypeScript mirror together, updates
this document and the other owning docs in the same commit, and must pass
`scripts/check_docs.py`. When several people or agents work in parallel, one owner edits a
shared file at a time and the others hand over the exact change they need (in rev 4: the work
packages' handoff notes, applied by the lead). Do not work around a missing field by stuffing
data into `details` dictionaries that another part must parse.

The lists below record what each revision changed.

Applied in rev 3 (schemas.py / config.py / types.ts): `SkillRules.max_string_chars`;
`WorldState.observation_page_size` and `.warnings`; `BelievedSelf.position`;
`SituationEntity.queried_round`; `KnowledgeRecordInput` for `EditKnowledgeIntervention.record`;
strict `seed` on `RunCreateRequest` / `WorldPreviewRequest`; `ContextLimits` and
`EffectiveSettingsView.limits`; `config.FSYNC_TURN_FILES` / `FSYNC_WORKERS` (`EMPYREAN_FSYNC`);
`config.MODEL_FIXED_OVERHEAD_TOKENS`, `CLI_MAX_TURNS`, `CLI_KILL_GRACE_SECONDS`,
`MAX_JSON_SCAN_STARTS`; `types.ts` `AgentInput.stats` is `Partial<AgentStats>`. Fix pass (final):
`RunStatus.next_round_order`, `RunSummary.run_dir`, `ModelCallSummary.provider_cost_usd` /
`reasoning_tokens`, `provider_cost_usd` in model_call_completed/failed event details;
`WorldConfig.plants_at_agent_starts` / `initial_plant_fruit` are editable in the setup form. Fix pass (reload
ordering + agent view): `ObservedEntity` and `AgentKnowledgeView.observed_entities` (schemas.py /
types.ts, `context.observed_entities`); `storage.apply_working_changes` / `check_working_state` /
`PARSE_STAGE_HINT`; `apply_working_files` applies its diff instead of replacing the state
(A-GOD-1); frontend `MapViewProps.agentView` / `agentViewOverlay` and
`OccupantListProps.agentViewOverlay` (`AgentViewOverlay`). Deferred (still
open): a `delete_plant_species` intervention; sharing unchanged knowledge records between turns
(storage grows ~1 KiB per record per agent per turn).

Applied in rev 4 (assistant shared contracts, WP0):

* `schemas.py`: `ModelRequest.purpose` += `assistant`, `narrative`; `ModelRequest.response_format:
  'json' | 'text' = 'json'`; `ModelErrorCode` and `ModelResult.error_code` (`budget_exceeded`,
  `rate_limited`, `schema_mismatch`, `cancelled`, `timeout`, `not_logged_in`, `cli_missing`);
  `ModelInfo.assistant_only: bool = False`; `InterventionOrigin = 'ui' | 'file' | 'assistant'`;
  `ApiErrorCode` += `assistant_unavailable` (503), `assistant_busy` (409), `brief_not_pending`
  (409), `assistant_budget_exhausted` (409), `conversation_busy` (409), `payload_too_large` (413);
  new `TranscriptionResult` and `WhisperStatus`; `AgentCard` docstring 6-12. Every other assistant
  model lives in `backend/empyrean/assistant/models.py`.
* `config.py`: `ASSISTANT_MODEL_CHAT|NARRATOR|AUTHOR|SUMMARIZER` (`EMPYREAN_ASSISTANT_MODEL_*`),
  `ASSISTANT_CHAT|STORYBOOK|STORY|GLOBAL|MESSAGE_BUDGET_USD`, `ASSISTANT_CALL_COST_ESTIMATE_USD`,
  `ASSISTANT_MAX_STEPS`, `ASSISTANT_MESSAGE_TIMEOUT_SECONDS`, `ASSISTANT_TOOL_OUTPUT_MAX_CHARS`,
  `ASSISTANT_TOOLS_PER_STEP`, `KNOWLEDGE_CORE_TOKENS`, `KNOWLEDGE_RETRIEVAL_TOKENS`,
  `MEMORY_TOKEN_BUDGET`, `ASSISTANT_SYSTEM_PROMPT_MAX_BYTES`, `ASSISTANT_SCHEMA_MAX_BYTES`,
  `ASSISTANT_OUTPUT_TOKENS`, `ASSISTANT_REQUEST_SETTINGS`, `STORYBOOK_AUTO`
  (`EMPYREAN_STORYBOOK_AUTO` on|off|auto), `STORYBOOK_BATCH_MAX`, `STORYBOOK_BATCH_THRESHOLD`,
  `ASSISTANT_BACKGROUND_PAUSE_SECONDS`, `ASSISTANT_PRICES` / `ASSISTANT_PRICE_FALLBACK`,
  `WHISPER_MODEL` (`EMPYREAN_WHISPER_MODEL`), `WHISPER_PRELOAD` (`EMPYREAN_WHISPER_PRELOAD`),
  `WHISPER_MAX_AUDIO_BYTES`, `WHISPER_MAX_SECONDS`, `WHISPER_CPU_THREADS`, `WHISPER_DEVICE`,
  `WHISPER_COMPUTE_TYPE`, `WHISPER_LANGUAGE_DEFAULT`, `SERVER_LOG_RING_LINES`,
  `SERVER_LOG_TAIL_MAX_CHARS`, `CLI_ARGV_MAX_BYTES`, `ASSISTANT_GLOBAL_DIR_NAME`; ASSUMPTIONS
  gained `A-GOD-1` (registered; was only in docs) and `A-AST-1..10`.
* `model.py` (contract part): `FAKE_MODEL_IDS` += `fake-assistant` (a default fake ref with
  `options.assistant_only`); default fakes always come first in `FAKE_MODEL_IDS` order;
  `ModelInfo.assistant_only` from `ref.options`; `ModelRegistry.is_assistant_only(key)` and
  `validate_agent_key(key)`; `call_model(request, registry=None, *, cancel: threading.Event | None
  = None)` plumbed to every adapter's `attempt(ref, request, attempt_no, *, cancel=None)`; stubs
  `kill_inflight() -> int`, `whisper_status() -> WhisperStatus`, `preload_whisper() -> None`,
  `transcribe(audio, *, language=None, initial_prompt=None) -> TranscriptionResult` (never raise);
  the `ClaudeCliAdapter` docstring names `--output-format stream-json --verbose`.
* `api.py`: `create_app(manager, assistant=None)`; `app.state.assistant`; the assistant routers
  from `assistant.routes.build_routers(assistant)` (503 `assistant_unavailable` fallbacks when
  None); a lifespan whose shutdown runs `manager.shutdown()`, `assistant.shutdown()`,
  `model.kill_inflight()`; HTTP 413 -> `payload_too_large`; `GET /api/models?include_assistant=0`
  hides assistant-only refs; the route table lists every assistant route.
* `main.py`: `build_app(*, whisper_preload=None)` builds `AssistantService(manager, registry,
  auto_live_allowed=True)` and starts the Whisper preload thread when `config.WHISPER_PRELOAD`.
* `models.example.json`: `claude-cli-sonnet-assistant` (sonnet, max_budget_usd 0.25) and
  `claude-cli-haiku-assistant` (haiku, 0.08), both `max_turns 2`, `max_model_requests 3`,
  `assistant_only true`; the `_comment` documents `assistant_only`.
* `runner.py`: module-level `command_allowed(state, command) -> str | None` (used by
  `RunWorker.submit`) and `validate_intervention_on(checkpoint, registry, run_id, iv) ->
  list[ApiProblem]` (`RunWorker.validate_intervention` delegates); `RunWorker.__init__(...,
  on_commit=None)` called at the very end of `_commit` with `(run_id, turn_id, kind, round)` inside
  try/except; `RunManager.add_commit_listener(cb)` / `remove_commit_listener(cb)` and the
  `_fan_out_commit` passed to every worker; `validate_setup`, `_place_agent` and model
  assignment use `registry.validate_agent_key`.
* `storage.py`: `_source_hash` hashes `rglob('*.py')` by relative path (the assistant subpackage
  is part of the recorded revision).
* Frontend shared files (`types.ts`, `client.ts`, `useHashRoute.ts`, `App.tsx`, `state.test.mjs`
  and the assistant stub files): see the ownership table above and the frontend packages' notes.

Applied for the run archive (Resume page archive and delete):

* `schemas.py`: `RunSummary.archived: bool = False`, `RunSummary.archived_at: Optional[str] = None`;
  new stored record `RunArchiveMarker(LooseModel)` `{archived_at, note=""}` (`<run>/archive.json`);
  `ApiErrorCode` += `run_in_use` (409).
* `api.py`: `GET /api/runs?archived=0|1|all` (default `0`), `DELETE /api/runs/{run_id}` (204),
  `POST /api/runs/{run_id}/archive`, `POST /api/runs/{run_id}/unarchive`; `storage.RunInUseError`
  -> 409 `run_in_use`; the delete route also refuses while `AssistantService.run_writing_jobs(run_id)`
  lists a queued or running story, storybook or sequencer job.
* `storage.py`: `ARCHIVE_FILE`, `RunInUseError`, `read_archive_marker`, `archive_state`,
  `archive_run`, `unarchive_run`, `delete_run`; summaries carry the archive fields.
* `runner.py`: `summary_from_manifest` fills the archive fields; `RunManager.list_runs(archived="0")`,
  `archive_run`, `unarchive_run`, `delete_run` (refuses an open run; waits up to
  `DELETE_CLOSING_WAIT_SECONDS` for a closed worker still finishing its turn).
* `types.ts`: `RunSummary.archived` / `archived_at`, `RunArchiveFilter`, `ApiErrorCode` +=
  `run_in_use`. `client.ts`: `listRuns(archived = "0")`, `archiveRun`, `unarchiveRun`, `deleteRun`.

Applied for the attack damage cap (A-ACT-19):

* `schemas.py`: `AgentStats.attack_cap: float = 50` (most damage one attack deals; runs stored
  before it load with the default); `UpgradeAttribute` / `UPGRADE_ATTRIBUTES` += `attack_cap`;
  `UpgradeSchedule.attack_cap_base_compute = 100`, `attack_cap_base_essence = 10`,
  `attack_cap_growth = 4`, `increments["attack_cap"] = 25`; `BelievedSelf.attack_cap`.
* `config.py`: `DEFAULT_AGENT_STATS.attack_cap = 50`, the `DEFAULT_UPGRADES` fields above, A-ACT-5
  public fields += `attack_cap`, new assumption A-ACT-19.
* `world.py`: `effective_attack_budget`, `attack_damage`; `quote_action` charges the cut budget;
  `_plan_attack` caps the damage and adds `capped` / `attack_cap` to the effects; `upgrade_quotes`
  prices `attack_cap`; `self_query_data` and `public_entity_data` include it; `validate_world`
  requires it finite and ≥ 0.
* `context.py`: the stable rules (COSTS: the cap, what is charged, the cap's price; WORLD: attack
  and query reach when a run turns `attack_requires_same_point` / `query_uses_vision_range` off),
  the run-start record, the believed-self line and the query(self) description name `attack_cap`.
* `types.ts`: `AgentStats.attack_cap`, `BelievedSelf.attack_cap`, `UpgradeSchedule.attack_cap_*`,
  `UpgradeAttribute` / `UPGRADE_ATTRIBUTES` += `attack_cap`.
