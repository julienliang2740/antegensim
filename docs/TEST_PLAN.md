# Empyrean prototype: test plan

Owner: QA. This plan maps every completion criterion and every user requirement in
`llm_world_technical_spec.md`, plus the required checks in `docs/INTERFACES.md`
section 13, to the test, script or browser step that verifies it. It also explains
what the fake models can and cannot prove.

## How to run

| What | Command | Needs |
| --- | --- | --- |
| All backend tests (unit + end-to-end, fake models) | `cd backend && ../.venv/bin/pytest -q` | nothing else; about 50 s |
| End-to-end tests only | `cd backend && ../.venv/bin/pytest -q tests/test_e2e_*.py` | about 40 s |
| Live provider tests | `cd backend && EMPYREAN_LIVE_TESTS=1 EMPYREAN_LIVE_MODELS=claude-cli-haiku ../.venv/bin/pytest -q -m live` | credentials or CLI login; costs money |
| Headless run with a summary | `.venv/bin/python scripts/run_sim.py [--model KEY --agents N --rounds R --seed S --worlds-dir PATH --name NAME]` | nothing for fake models |
| One live turn with a usage check | `EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/run_sim.py --model KEY --live-check` | credentials; about one call |
| Browser checks | `cd qa && npm install && node browser_check.mjs` (see `qa/README.md`) | backend + `npm run dev` running |

The end-to-end tests (`backend/tests/test_e2e_*.py`) use only the public API routes
(FastAPI `TestClient`, a fresh `RunManager`, a temporary worlds dir) and the
documented folder layout. Helpers live in `backend/tests/e2e_support.py`. Fixtures
are in `conftest.py`: `api`, and `no_retry_sleep`, which removes the retry backoff
so fake timeouts retry instantly. Scripted decisions come from `fake-scripted` cards
(`AgentCard.fake_script`). Failures come from `fake_options`.

`scripts/run_sim.py` refuses any model whose provider is not `fake` unless
`EMPYREAN_ALLOW_LIVE=1` is set. It exits non-zero on any exception or when the run
ends in `error`.

## Completion criteria (spec "Completion criteria and implementation freedom")

| # | Criterion | Verified by |
| --- | --- | --- |
| 1 | An eight-agent run can pause, restart and continue without losing state or repeating a committed action | `test_e2e_run.py::test_close_reopen_and_restart_continue_without_repeating` (close + open, then a fresh RunManager; next turn id = the scheduled one; unique turn ids and seqs; every agent acts once per round). `::test_crash_recovery_discards_partial_turn_and_carries_interrupted_call` (a half-written `.partial_` dir never replaces the checkpoint; a leftover pending call becomes an interrupted, uncharged record; the re-run uses `_02`). `::test_run_turn_step_round_play_pause_and_layout`. Browser `play-pause`, `resume` |
| 2 | New/resumed sessions open paused; cards have defaults; Run turn, Play, Pause behave as described | `test_e2e_run.py::test_create_run_from_defaults_opens_paused_with_init_checkpoint`, `::test_defaults_support_six_to_eleven_cards`, `::test_setup_validation_reports_every_problem_by_path`, `::test_run_turn_step_round_play_pause_and_layout` (one turn per Run turn; Step round ends at `r00001_end`; Play then Pause gives `pause_requested` then `paused`; overlapping commands get 409), `::test_pause_during_a_model_call_finishes_and_saves_that_turn`, `::test_max_rounds_finishes_and_update_run_settings_revives`. Browser `entry`, `new-session-cards`, `edit-card`, `invalid-value`, `create-run`, `run-turn`, `play-pause`, `step-round`, `resume` |
| 3 | Live terminal-style logs, clear run status, return from history to live | `test_e2e_run.py::test_live_feed_polling_returns_new_events_in_order` (the feed and turn history are the same events), `::test_pause_during_a_model_call_finishes_and_saves_that_turn` (pending call visible while waiting), `feed_epoch` change on reopen. Browser `run-turn` (a `[r1 t1]` feed line), `timeline` (return to live), `error-recovery` (error state and "Recover (pause)") |
| 4 | A point and every occupant can be inspected across rounds; agent knowledge and plant rules are visible | Browser `crowded-coordinate`, `select-occupants`, `agent-inspector`, `plant-rules`, `timeline`. API: every test reads `TurnView` history per turn. `test_e2e_godmode.py::test_plant_rules_are_readable_and_editable_as_a_species_change` |
| 5 | Direct and skill actions share rule enforcement; malformed output and invalid actions fail without crashing or applying forbidden effects | `test_e2e_rules.py` (all tests). Unit: `test_world.py`, `test_skills.py` |
| 6 | Each model decision has an inspectable, bounded context built only from that agent's permitted information; older memories can be retrieved without free refreshes | `test_e2e_context.py::test_packets_cite_only_the_agents_own_records` (cited ids, rendered ids and notebooks belong to the agent; the call request equals the packet; estimate ≤ cap), `::test_self_state_is_derived_unless_the_agent_queried_itself`. Unit: `test_context.py::test_older_relevant_memory_beats_newer_irrelevant_one`, `::test_fifty_max_length_messages_still_yield_an_affordable_packet`. Browser `agent-inspector` (packet view) |
| 7 | Context limits and memory settings can change at run creation or in god mode; saved and effective changes are visible in history | `test_e2e_context.py::test_context_settings_from_run_creation_reach_the_packets`, `test_e2e_godmode.py::test_context_settings_change_at_the_next_boundary` (staged but not applied until the boundary; before/after; effective turn id; that turn's `settings.json`; packets use the new values; history keeps the old ones). Browser `new-session-cards` (notes), `god-mode` |
| 8 | UI and file edits apply before the next turn, produce a recorded intervention, and can start a continuation from history | `test_e2e_godmode.py::test_set_stat_place_and_remove_entity_without_charging_agents`, `::test_working_file_edit_and_reload_records_before_after`, `::test_invalid_working_json_is_reported_and_state_stays_intact`, `::test_continuation_from_history_keeps_the_parent_future`, `::test_model_assignment_changes_at_the_next_boundary`. Browser `god-mode` |
| 9 | An unseen operator voice reaches the selected recipients and appears in their recorded experience | `test_e2e_godmode.py::test_voice_reaches_only_recipients_and_their_next_packet` (one agent, selected agents, broadcast; source `unknown`; next packet). Browser `god-mode` |
| 10 | The same decision flow works with every provider through configuration alone; stored playback needs no model calls | `test_e2e_boundaries.py::test_provider_sdks_are_imported_only_by_model_py`, `::test_playback_reads_history_without_model_calls`. Live: `::test_live_provider_runs_the_same_decision_flow` (`@live`, one key per `EMPYREAN_LIVE_MODELS` entry), `scripts/run_sim.py --live-check --model KEY` per provider. Unit: `test_model.py` usage goldens per provider payload |

## User requirements U1-U16

| ID | Requirement | Verified by |
| --- | --- | --- |
| U1 | Click a dot, see who and what is there | Browser `crowded-coordinate` (hover + click; every occupant listed), `select-occupants`. API: `map.occupants` checked in `test_create_run_from_defaults…` and `test_set_stat_place_and_remove…` |
| U2 | Agent stuff very easy to see | Browser `agent-inspector` (stats, skills, knowledge, model, decision packet, model call). API: `AgentKnowledgeView.believed_self` in `test_self_state_is_derived…` |
| U3 | Plant rules easy to see and modify | `test_e2e_godmode.py::test_plant_rules_are_readable_and_editable_as_a_species_change`. Browser `plant-rules` |
| U4 | All model calls through `model.py` | `test_e2e_boundaries.py::test_provider_sdks_are_imported_only_by_model_py`. The call record equals the packet in `test_packets_cite_only_the_agents_own_records` |
| U5 | All actions and state per turn logged in a clear folder structure | `test_create_run_from_defaults…` (run, working and init layout), `test_run_turn_step_round_play_pause_and_layout` (every committed turn dir is complete; events carry turn ids and actors; index and manifest agree). `scripts/run_sim.py` prints a tree of one turn |
| U6 | Left/right arrows through rounds and turns; edit a selected scenario | Browser `timeline`. API: the `previous_turn_id` chain in `assert_chain`; `test_continuation_from_history_keeps_the_parent_future` |
| U7 | Voice from nowhere | `test_voice_reaches_only_recipients_and_their_next_packet`. Browser `god-mode` |
| U8 | Change stats, place/remove objects | `test_set_stat_place_and_remove_entity_without_charging_agents`, `test_unaffordable_agent_is_skipped_and_starves_at_round_end` (set_stat). Browser `god-mode` |
| U9 | Edit files directly and in game, with an explicit apply | `test_working_file_edit_and_reload_records_before_after`, `test_invalid_working_json_is_reported_and_state_stays_intact`, plus the UI-path tests above |
| U10 | Resume an old session / start a new one | Browser `entry`, `resume`. API: `test_close_reopen_and_restart…` (`GET /runs` lists the run, reopen) |
| U11 | Agents as cards prefilled with defaults | `test_create_run_from_defaults…`, `test_defaults_support_six_to_eleven_cards`, `test_setup_validation_reports_every_problem_by_path`, `test_card_on_a_mountain_is_moved_to_land_with_a_warning`. Browser `new-session-cards`, `edit-card`, `invalid-value` |
| U12 | Run turn, play and pause | `test_run_turn_step_round_play_pause_and_layout`, `test_pause_during_a_model_call_finishes_and_saves_that_turn`. Browser `run-turn`, `play-pause`, `step-round` |
| U13 | See things in real time | `test_live_feed_polling_returns_new_events_in_order`, `test_pause_during_a_model_call…` (the `model_call_pending` event and `GET /pending_model_call`). Browser `run-turn` feed line |
| U14 | Clarity over aesthetics | Browser screenshots of every step for human review. Status line (`create-run`), occupant list (`crowded-coordinate`). Judged by a person, not asserted |
| U15 | Providers interchangeable in code | `test_provider_sdks_are_imported_only_by_model_py` (no SDK imports and no `provider ==` branches outside `model.py`). Unit: `test_model.py` adapters and goldens. Live: `test_live_provider_runs_the_same_decision_flow`, `run_sim.py --live-check` |
| U16 | Context settings changeable at creation and in god mode | `test_context_settings_from_run_creation_reach_the_packets`, `test_context_settings_change_at_the_next_boundary`. Browser `new-session-cards` (setup fields noted), `god-mode` |

## INTERFACES section 13 required checks

| Check | Test |
| --- | --- |
| create → play 3 rounds → pause → reopen → continue without repeating a committed action | `test_e2e_run.py::test_run_turn_step_round_play_pause_and_layout` + `::test_close_reopen_and_restart_continue_without_repeating` |
| malformed model output never applies an effect | `test_e2e_rules.py::test_malformed_model_output_never_applies_an_effect` (8 invalid-JSON turns + 8 unknown-action turns: no action event, only the cognition charge, feedback record, run keeps going) |
| skill and direct actions charge 0.8× / 1× | `test_e2e_rules.py::test_direct_move_costs_5_and_skill_move_costs_4` |
| packets contain only the agent's records | `test_e2e_context.py::test_packets_cite_only_the_agents_own_records` |
| voice reaches recipients' knowledge | `test_e2e_godmode.py::test_voice_reaches_only_recipients_and_their_next_packet` |
| working/ edit + reload → intervention with before/after | `test_e2e_godmode.py::test_working_file_edit_and_reload_records_before_after` |
| continuation preserves the parent's future | `test_e2e_godmode.py::test_continuation_from_history_keeps_the_parent_future` |
| `config.default_rules() == RulesConfig()` | `test_e2e_boundaries.py::test_default_rules_equal_schema_defaults` |
| example 3 as a skill: `vision_range.compute == 20`, `essence == 2` | `test_e2e_rules.py::test_design_example_3_skill_sees_skill_prices_and_upgrades`. Unit: `test_skills.py::test_example_3_reads_quotes_and_upgrades` |
| example 1 uses exactly 3 agent turns; the 4th is a model decision | `test_e2e_rules.py::test_design_example_1_skill_uses_three_turns_then_model_decision`. Unit: `test_skills.py::test_example_1_uses_three_turns_then_finishes_without_action` |
| skill transfer of 10: sender −10.8, recipient +10, `cost_compute 0.8` | `test_e2e_rules.py::test_skill_transfer_of_10_compute_charges_only_the_fee` |
| derived self state; differs from the authoritative balance after undisclosed upkeep | `test_e2e_context.py::test_self_state_is_derived_unless_the_agent_queried_itself` |
| `IF r.ok == true AND r.data.x > 0` with a failed `r` is false without error | Unit: `test_skills.py::test_and_short_circuit_on_failed_result` |
| 50 max-length messages still give an affordable packet | Unit: `test_context.py::test_fifty_max_length_messages_still_yield_an_affordable_packet` |
| fake `fail` timeout → error, no charge, pause re-runs the same turn with `_02` | `test_e2e_context.py::test_fake_timeout_puts_run_in_error_without_charge_and_pause_reruns_with_call_02` (also: nothing marked read, A-KNOW-5; other commands get 409) |
| usage-normalisation goldens per provider payload | Unit: `test_model.py::test_*_usage_golden*` |
| a claude_cli live call bills ≤ 1.5× the packet estimate | Live: `test_model.py::test_live_claude_cli_decision_bills_near_packet_estimate`, `test_e2e_boundaries.py::test_live_provider_runs_the_same_decision_flow`, `scripts/run_sim.py --live-check --model claude-cli-haiku` |
| Browser: create/resume, card edits with problems by path, run turn/play/pause/step round, history arrows + return to live, god mode settings, crowded coordinate click/hover, error-state recovery | `qa/browser_check.mjs` steps `entry` … `error-recovery` (table in `qa/README.md`) |

## Design "Minimum prototype" checks

| Check | Test |
| --- | --- |
| failed moves do not move | `test_e2e_rules.py::test_move_into_mountain_fails_and_position_is_unchanged` (reason `blocked`, fee 1) |
| failed upgrades do not change stats | `test_e2e_rules.py::test_failed_upgrade_changes_nothing` (`insufficient_essence`, no debit) |
| queries respect visibility; prices are visible to the caller | Unit: `test_world.py::test_query_respects_visibility_and_returns_public_data_only`, `::test_query_self_exposes_prices_quotes_and_post_payment_balances`. `test_design_example_3…` (skill-mode quotes) |
| raising caps does not fill them | `test_design_example_3…` (vision +1, essence −2, nothing else changes) |
| attack charges the nominal budget adjusted in a skill; absorption losses are not recoverable | Unit: `test_world.py::test_attack_budget_10_charges_10_or_8_and_deals_10_damage`, `::test_absorb_100_compute_at_20_percent_gains_20_destroys_80_costs_3` |
| no skill gets multiple world actions in one turn | `test_design_example_1…` (exactly one `action` event per skill turn) |
| unaffordable minimum packet → explicit resource result; starvation at round end | `test_e2e_rules.py::test_unaffordable_agent_is_skipped_and_starves_at_round_end` |

## Mocked vs live

**What the fake models prove.** `fake-heuristic`, `fake-scripted` and `fake-malformed`
are deterministic stand-ins for a provider. They sit behind the same `model.py`
boundary, so every test above runs the real runner, world, context, skills, storage
and API code. The only thing replaced is the network call. With them we prove:

* Game rules and accounting are exact: prices, the 0.8 discount, fees, transfers,
  upkeep, starvation, skill turn usage and the op budget. Scripts choose the exact
  decisions and the tests compare exact numbers.
* The format gate: invalid JSON and unknown actions never reach the world.
* The knowledge boundary and packet assembly, from the stored packet, the stored call
  request and the knowledge files.
* Persistence: the commit protocol, reopen/restart, crash recovery of pending calls,
  continuations and the working/ reload.
* The run state machine, including the error path. `fake_options.fail` produces
  timeouts, HTTP errors, refusals and truncation. Retry counting, the `_02` call id,
  "no charge on infrastructure failure" and "nothing marked read" are checked
  without a provider.
* Determinism: two runs with the same seed produce identical event summaries. This
  is also what makes the other tests reproducible.
* Charging from usage. Fake usage is `source="estimate"` (`config.estimate_tokens`),
  so the charging code path is exercised, but with estimated token counts only.

**What only a live provider run proves.** Fakes cannot show these, so they need a
run with `EMPYREAN_LIVE_TESTS=1` or `run_sim.py --live-check`, per provider:

* Each adapter's real request shape is accepted: schema transforms (strict JSON
  schema, forced tool use, `--json-schema`, Bedrock text instructions), credentials,
  endpoints, regions and deployments.
* Real usage normalisation on live payloads, including cache tokens. The goldens in
  `test_model.py` only replay recorded shapes. Billed input also has to stay within
  1.5× of the packet estimate.
* Real models return valid decisions often enough under the packet and schema, and
  refusal, truncation and malformed replies are classified correctly when they
  really happen.
* Timeouts, 429/5xx retries and `Retry-After` handling against real services, and
  `provider_cost_usd` / `real_budget_usd` with real costs.
* Latency behaviour in the UI while `waiting_model` lasts seconds, not milliseconds.
  The "Pause requested" window is only reliably visible with a slow model; the fake
  `sleep_ms` option simulates it in `test_pause_during_a_model_call…`.
* Whether agents actually make use of retrieved memories and the notebook. That is a
  behaviour question for recorded live scenarios (spec "Evaluate the starting
  policy"), not a pass/fail test.

Live runs cost money. `run_sim.py` refuses non-fake providers without
`EMPYREAN_ALLOW_LIVE=1`, and `--live-check` makes one decision (one call plus bounded
retries).

## Measurements and known gaps

* **Bytes per turn**: printed by `test_run_turn_step_round_play_pause_and_layout` and
  by `run_sim.py`. Eight fake-heuristic agents, seed 1:
  * About 110 KB for an agent turn in round 1, 324 KB in round 10 and 569 KB in
    round 20, roughly +24 KB per round.
  * Growth comes from every agent's whole knowledge file being copied into every
    turn. The storage team's benchmark shows about 1 MB per turn at 100 records per
    agent.
  * The spec estimates 250 KB per turn. Long runs will exceed that, so storage
    sharing (spec "Later, share unchanged … historical memory records") should be
    planned before runs of hundreds of rounds.
* The fake-heuristic rarely exercises skills or absorbs fruit in its first 20 rounds
  (it walks and observes). Skills are covered by the scripted tests. Long-run
  ecology (fruit, deaths, residue) is not covered end to end by fakes.
* U14 (clarity) is judged by a person from the browser screenshots.
