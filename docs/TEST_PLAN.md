# Empyrean prototype: test plan

Owner: QA. This plan maps every completion criterion and every user requirement in
`manual_lab/2026-09-25_llm_world_technical_spec.md`, plus the required checks in `docs/INTERFACES.md`
section 13, to the test, script or browser step that verifies it. It also explains
what the fake models can and cannot prove.

## How to run

| What | Command | Needs |
| --- | --- | --- |
| All backend tests (unit + end-to-end + assistant + docs check, fake models) | `cd backend && ../.venv/bin/pytest -q` | nothing else; about 1 min |
| Docs consistency only | `.venv/bin/python scripts/check_docs.py` | nothing else; a few seconds |
| Whisper tests (the 2 tests marked `whisper`) | `cd backend && EMPYREAN_WHISPER_TEST_AUDIO=<11 s JFK clip> ../.venv/bin/pytest -q -m whisper` | the Whisper model (`large-v3-turbo`) already in the local Hugging Face cache and the clip (`EMPYREAN_WHISPER_TEST_AUDIO`, or `backend/tests/data/jfk.flac`); each skips with its reason otherwise; about 6 s each on 8 CPU cores |
| End-to-end tests only | `cd backend && ../.venv/bin/pytest -q tests/test_e2e_*.py` | about 40 s |
| Live provider tests | `cd backend && EMPYREAN_LIVE_TESTS=1 EMPYREAN_LIVE_MODELS=claude-cli-haiku ../.venv/bin/pytest -q -m live` | credentials or CLI login; costs money |
| Headless run with a summary | `.venv/bin/python scripts/run_sim.py [--model KEY --agents N --rounds R --seed S --worlds-dir PATH --name NAME]` | nothing for fake models |
| One live turn with a usage check | `EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/run_sim.py --model KEY --live-check` | credentials; about one call |
| Browser checks | `cd qa && npm install && node browser_check.mjs` (see `qa/README.md`) | backend + `npm run dev` running; against a live backend the assistant steps that would call a model skip themselves |
| Browser checks with the assistant steps on fake models (all 37 steps) | `.venv/bin/python qa/assistant_fake_server.py`, then `cd frontend && EMPYREAN_API_PROXY=http://127.0.0.1:8020 npx vite --port 5180 --strictPort`, then `cd qa && BASE_URL=http://127.0.0.1:5180 API_URL=http://127.0.0.1:8020 node browser_check.mjs` | nothing paid; the QA server forces every assistant profile to `fake-assistant` and adds the fake-metadata hook (`qa/README.md`) |
| Browser checks of the map views only (steps 36 `map-marks` and 37 `map-3d`) | `cd qa && QA_ONLY_MAP=1 node browser_check.mjs` (preflight, a new fake-model run with round 1 committed, then the two map steps), or `QA_ONLY_MAP=1 QA_RUN_ID=<run> node browser_check.mjs` (the two steps on an existing run: nothing is created, no turn runs) | backend + Vite; Canvas 2D in headless Chromium (WebGL is blocked by the map check); no model call |
| Replay of stored malformed CLI decision replies through the assistant's salvage | `.venv/bin/python scripts/assistant_replay_malformed.py [--worlds-dir DIR] [--json OUT.json]` | run folders with `claude_cli` model calls under `worlds/`; no model call, no spend |
| Assistant playtest: ground truth only | `.venv/bin/python scripts/assistant_playtest.py questions [--arm haiku]` | the two reference runs; no spend |
| Assistant playtest: live arms (LIVE, costs money) | `EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/assistant_playtest.py chat --arm haiku --max-spend 3.5` (also `narrator`, `author`, `briefs`, per arm `haiku` / `sonnet` / `opus`), then `.venv/bin/python scripts/assistant_playtest.py report` | the Claude Code CLI logged in; `chat`, `narrator`, `author` and `briefs` refuse to run without `EMPYREAN_ALLOW_LIVE=1` (`questions`, `ab-pairs`, `recheck` and `report` spend nothing). Caps: `chat --max-spend` (USD, default 4.0) stops the arm when its ledger reaches it; the other arms are bounded by the raised assistant budgets the script gives the arm's backend (global USD 60, chat 40, storybook 5, story 5), so decide a total cap before starting and check the arm ledgers between arms. The 2026-09-26 pass cost USD 10.93 against a USD 22 cap |

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
| 2 | New/resumed sessions open paused; cards have defaults; Run turn, Play, Pause behave as described | `test_e2e_run.py::test_create_run_from_defaults_opens_paused_with_init_checkpoint`, `::test_defaults_support_six_to_twelve_cards`, `::test_setup_validation_reports_every_problem_by_path`, `::test_run_turn_step_round_play_pause_and_layout` (one turn per Run turn; Step round ends at `r00001_end`; Play then Pause gives `pause_requested` then `paused`; overlapping commands get 409), `::test_pause_during_a_model_call_finishes_and_saves_that_turn`, `::test_max_rounds_finishes_and_update_run_settings_revives`. Browser `entry`, `new-session-cards`, `edit-card`, `invalid-value`, `create-run`, `run-turn`, `play-pause`, `step-round`, `resume` |
| 3 | Live terminal-style logs, clear run status, return from history to live | `test_e2e_run.py::test_live_feed_polling_returns_new_events_in_order` (the feed and turn history are the same events), `::test_pause_during_a_model_call_finishes_and_saves_that_turn` (pending call visible while waiting), `feed_epoch` change on reopen. Browser `run-turn` (a `[r1 t1]` feed line), `timeline` (return to live), `error-recovery` (error state and "Recover (pause)") |
| 4 | A point and every occupant can be inspected across rounds; agent knowledge and plant rules are visible | Browser `crowded-coordinate`, `select-occupants`, `agent-inspector`, `plant-rules`, `profile-card`, `timeline`, `map-marks` (a packed cell's count badge lists every occupant; history turns show their marks), `map-3d` (a label opens its agent's profile card; a history move is drawn at its destination). API: every test reads `TurnView` history per turn. `test_e2e_godmode.py::test_plant_rules_are_readable_and_editable_as_a_species_change` |
| 5 | Direct and skill actions share rule enforcement; malformed output and invalid actions fail without crashing or applying forbidden effects | `test_e2e_rules.py` (all tests). Unit: `test_world.py`, `test_skills.py` |
| 6 | Each model decision has an inspectable, bounded context built only from that agent's permitted information; older memories can be retrieved without free refreshes | `test_e2e_context.py::test_packets_cite_only_the_agents_own_records` (cited ids, rendered ids and notebooks belong to the agent; the call request equals the packet; estimate ≤ cap), `::test_self_state_is_derived_unless_the_agent_queried_itself`. Unit: `test_context.py::test_older_relevant_memory_beats_newer_irrelevant_one`, `::test_fifty_max_length_messages_still_yield_an_affordable_packet`. Browser `agent-inspector` (packet view) |
| 7 | Context limits and memory settings can change at run creation or in god mode; saved and effective changes are visible in history | `test_e2e_context.py::test_context_settings_from_run_creation_reach_the_packets`, `test_e2e_godmode.py::test_context_settings_change_at_the_next_boundary` (staged but not applied until the boundary; before/after; effective turn id; that turn's `settings.json`; packets use the new values; history keeps the old ones). Browser `new-session-cards` (notes), `god-mode` |
| 8 | UI and file edits apply before the next turn, produce a recorded intervention, and can start a continuation from history | `test_e2e_godmode.py::test_set_stat_place_and_remove_entity_without_charging_agents`, `::test_working_file_edit_and_reload_records_before_after`, `::test_invalid_working_json_is_reported_and_state_stays_intact`, `::test_continuation_from_history_keeps_the_parent_future`, `::test_model_assignment_changes_at_the_next_boundary`. Browser `god-mode` |
| 9 | An unseen operator voice reaches the selected recipients and appears in their recorded experience | `test_e2e_godmode.py::test_voice_reaches_only_recipients_and_their_next_packet` (one agent, selected agents, broadcast; source `unknown`; next packet). Browser `god-mode` |
| 10 | The same decision flow works with every provider through configuration alone; stored playback needs no model calls | `test_e2e_boundaries.py::test_provider_sdks_are_imported_only_by_model_py`, `::test_playback_reads_history_without_model_calls`. Live: `::test_live_provider_runs_the_same_decision_flow` (`@live`, one key per `EMPYREAN_LIVE_MODELS` entry), `scripts/run_sim.py --live-check --model KEY` per provider. Unit: `test_model.py` usage goldens per provider payload |

## User requirements U1-U16

| ID | Requirement | Verified by |
| --- | --- | --- |
| U1 | Click a dot, see who and what is there | Browser `crowded-coordinate` (hover + click; every occupant listed), `select-occupants`, `map-marks` (one dot size per zoom level, group tiles, the count badge's tooltip lists every occupant), `map-3d` (labels and the cell tooltip in the 3D view). API: `map.occupants` checked in `test_create_run_from_defaults…` and `test_set_stat_place_and_remove…` |
| U2 | Agent stuff very easy to see | Browser `agent-inspector` (the profile card: stats, skills, knowledge, model, decision packet, model call), `profile-card` (opened from a map dot, board visible behind it, Overview, Decisions with **View turn**, Skills, Knowledge, arrow keys, Escape). API: `AgentKnowledgeView.believed_self` in `test_self_state_is_derived…` |
| U3 | Plant rules easy to see and modify | `test_e2e_godmode.py::test_plant_rules_are_readable_and_editable_as_a_species_change`. Browser `plant-rules` |
| U4 | All model calls through `model.py` | `test_e2e_boundaries.py::test_provider_sdks_are_imported_only_by_model_py`. The call record equals the packet in `test_packets_cite_only_the_agents_own_records` |
| U5 | All actions and state per turn logged in a clear folder structure | `test_create_run_from_defaults…` (run, working and init layout), `test_run_turn_step_round_play_pause_and_layout` (every committed turn dir is complete; events carry turn ids and actors; index and manifest agree). `scripts/run_sim.py` prints a tree of one turn |
| U6 | Left/right arrows through rounds and turns; edit a selected scenario | Browser `timeline` (including a short gateway error and retry). API: the `previous_turn_id` chain in `assert_chain`; `test_continuation_from_history_keeps_the_parent_future` |
| U7 | Voice from nowhere | `test_voice_reaches_only_recipients_and_their_next_packet`. Browser `god-mode` |
| U8 | Change stats, place/remove objects | `test_set_stat_place_and_remove_entity_without_charging_agents`, `test_unaffordable_agent_is_skipped_and_starves_at_round_end` (set_stat). Browser `god-mode` |
| U9 | Edit files directly and in game, with an explicit apply | `test_working_file_edit_and_reload_records_before_after`, `test_invalid_working_json_is_reported_and_state_stays_intact`, plus the UI-path tests above |
| U10 | Resume an old session / start a new one | Browser `entry`, `resume`. API: `test_close_reopen_and_restart…` (`GET /runs` lists the run, reopen) |
| U10a | Resume page housekeeping: multi-select runs (click, Ctrl/Cmd-click, Shift-click range, row click), rename one selected run, pin and unpin a selected group, archive and restore them, delete them after a confirmation; an open run is refused | Browser `resume-select-archive-delete`. State: `state.test.mjs` selection and Story Mode picker pin-priority tests. API: `test_run_archive.py::test_rename_and_pin_persist_without_changing_run_setup`, `::test_archive_unarchive_round_trip_and_listing_filters`, `::test_open_run_can_be_archived_and_keeps_its_live_status`, `::test_delete_closed_run_removes_its_folder_and_the_emptied_world`, `::test_delete_keeps_the_world_while_other_runs_remain_and_continuations_do_not_copy_the_marker`, `::test_delete_refuses_an_open_run_and_one_locked_by_another_writer`, `::test_unknown_run_is_404_for_archive_unarchive_and_delete`, `::test_recover_run_keeps_the_archive_marker`, `::test_corrupt_archive_marker_is_logged_and_the_run_listed_as_active`, `::test_delete_refuses_a_run_with_a_story_job`; route shapes `test_api.py::test_run_presentation_route_and_validation`, `::test_archive_unarchive_delete_routes_and_list_filter` |
| U11 | Agents as cards prefilled with defaults | `test_create_run_from_defaults…`, `test_defaults_support_six_to_twelve_cards`, `test_setup_validation_reports_every_problem_by_path`, `test_card_on_a_mountain_is_moved_to_land_with_a_warning`. Browser `new-session-cards`, `edit-card`, `invalid-value` |
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
| Browser: the entity profile card (opened from a map dot; the board stays visible behind it; Overview, Decisions with **View turn**, Skills, Knowledge; arrow keys move between sections; Escape closes it) | `qa/browser_check.mjs` step 35 `profile-card`, after `resume-select-archive-delete`; the inspection steps `select-occupants`, `agent-inspector` and `plant-rules` also go through the card (table in `qa/README.md`) |
| Browser: the 2D map's word badge and fixed action explanation, equal dots, group tiles, count badge, **Action marks** and **Key**; the 3D view (chunk loaded on demand, counts, labels, keys, drag, wheel, frame, help, persistence, history replay, back to 2D) | `qa/browser_check.mjs` steps 36 `map-marks` and 37 `map-3d`, after `profile-card` (section "Map views" below) |

## Design "Minimum prototype" checks

| Check | Test |
| --- | --- |
| failed moves do not move | `test_e2e_rules.py::test_move_into_mountain_fails_and_position_is_unchanged` (reason `blocked`, fee 1) |
| failed upgrades do not change stats | `test_e2e_rules.py::test_failed_upgrade_changes_nothing` (`insufficient_essence`, no debit) |
| queries respect visibility; prices are visible to the caller | Unit: `test_world.py::test_query_respects_visibility_and_returns_public_data_only`, `::test_query_self_exposes_prices_quotes_and_post_payment_balances`. `test_design_example_3…` (skill-mode quotes) |
| raising caps does not fill them | `test_design_example_3…` (vision +1, essence −2, nothing else changes) |
| attack charges the nominal budget adjusted in a skill; absorption losses are not recoverable | Unit: `test_world.py::test_attack_budget_10_charges_10_or_8_and_deals_10_damage`, `::test_absorb_100_compute_at_20_percent_gains_20_destroys_80_costs_3` |
| attack damage cap (A-ACT-19): damage at most `attack_cap`, only the cut budget charged, the cap upgradable at the attack price, public in query and in the agents' rules text | Unit: `test_world.py::test_attack_damage_is_capped_per_attack_and_only_the_useful_budget_is_charged`, `::test_attack_cap_upgrade_is_priced_like_attack_and_grows_exponentially`, `::test_attack_cap_is_public_in_query_and_exact_in_query_self`, `test_context.py::test_stable_rules_explain_the_attack_cap_its_price_and_ranged_rules` |
| simultaneous round decisions (A-SCHED-5/6): a round of slow calls takes about one call; speed resolves a contested strike and the slower agent's unused decision is recorded uncharged in its own turn; packets show the world at round start; a mid-round edit voids the waiting decisions and the rest of the round decides again; close + open mid-round never reuses a call id; the agents' rules text explains it | `test_e2e_round_decisions.py::test_a_round_of_slow_calls_takes_about_one_call`, `::test_faster_agent_strikes_first_and_the_slower_decision_is_discarded`, `::test_decisions_see_the_world_as_it_was_at_round_start`, `::test_an_edit_between_turns_makes_the_rest_of_the_round_decide_again`, `::test_close_and_reopen_mid_round_never_reuses_a_call_id`; `test_context.py::test_stable_rules_explain_simultaneous_decisions_and_speed_order`; the runner unit tests (`test_runner.py`) run the round decisions on a one-worker pool |
| an input cap below the mandatory part never locks an agent out (the mandatory part is sent alone); the CLI's "exceeded the N output token maximum" error is a truncated reply, not an infrastructure error | Unit: `test_context.py::test_a_mandatory_part_above_the_input_cap_is_sent_alone_instead_of_locking_the_agent_out`, `::test_estimate_never_exceeds_cap_or_affordable_input`; `test_model.py::test_claude_cli_envelope_classification` (the output-cap case) |
| persona tip (A-KNOW-9): the tip follows the persona only when `context.persona_tip` is on (alone when the card has no persona, custom text honoured); new runs default to on with the shipped text, stored settings without the field read as off, a card override switches it per agent | Unit: `test_context.py::test_persona_tip_follows_the_persona_when_on_and_is_absent_when_off`, `test_context.py::test_persona_tip_defaults_on_for_new_runs_and_off_for_stored_settings`; API: `test_api.py::test_health_defaults_models_assumptions` (defaults carry it); browser: step U11 checks the New session switch is present and on |
| no skill gets multiple world actions in one turn | `test_design_example_1…` (exactly one `action` event per skill turn) |
| unaffordable minimum packet → explicit resource result; starvation at round end | `test_e2e_rules.py::test_unaffordable_agent_is_skipped_and_starves_at_round_end` |

## Assistant release (rev 4)

Every assistant test uses fake model keys (`fake-assistant`, or `fake-scripted` with a script);
no test reaches the Claude CLI. The app in `conftest.py` is built without an `AssistantService`
(assistant routes answer 503), so tests that need the assistant build their own service with
`auto_live_allowed=False`. Whisper tests carry the `whisper` marker and skip unless the model is
already in the local Hugging Face cache and a sample clip exists (`EMPYREAN_WHISPER_TEST_AUDIO`,
`EMPYREAN_WHISPER_SAMPLE`); they never download anything.

| Requirement | Verified by |
| --- | --- |
| All model and speech calls go through `model.py` (recursive scan, no allowlist) | `test_e2e_boundaries.py::test_provider_sdks_are_imported_only_by_model_py`, `::test_speech_packages_are_referenced_only_by_model_py` |
| Shared contracts: error codes, assistant-only refs, 503 without a service, commit listeners never break commits, `command_allowed` and `validate_intervention_on` parity | `test_assistant_contracts.py::test_new_api_error_codes_render`, `::test_api_models_hides_assistant_refs_unless_asked`, `::test_validate_agent_key_rejects_assistant_refs`, `::test_validate_setup_rejects_assistant_refs_for_agents`, `::test_assistant_routes_are_503_without_a_service`, `::test_commit_listeners_fan_out_and_never_break_commits`, `::test_command_allowed_parity_with_run_worker_submit`, `::test_validate_intervention_on_matches_worker_and_uses_agent_key_rule`, `::test_call_profile_records_a_ledger_line_with_a_fake_key`, `::test_assumptions_registry_has_god_and_assistant_entries` |
| Text mode, fake-assistant, error codes, cancellation, cost summed over attempts | `test_model.py::test_text_mode_claude_cli`, `::test_text_mode_has_no_json_instruction_overhead`, `::test_fake_assistant_script_then_reply_then_invalid_config`, `::test_error_codes_for_timeout_missing_cli_and_sdk_errors`, `::test_cancel_kills_the_cli_process_group`, `::test_cancel_between_retries_stops_retrying`, `::test_kill_inflight_stops_running_calls`, `::test_provider_cost_is_summed_over_attempts`, `::test_structured_output_names_follow_the_purpose` |
| Storybook: default auto rule, old runs off, no silent catch-up, batching, re-queue, budget pause, dedup, lock, continuation opening, read-only GET | `test_assistant_storybook.py::test_default_auto_rule_matrix`, `::test_existing_runs_without_settings_stay_off`, `::test_switching_auto_on_later_never_catches_up_history`, `::test_backlog_is_batched_per_round`, `::test_batch_with_missing_section_is_requeued_singly`, `::test_budget_pause_and_resume`, `::test_dedup_between_listener_and_manual_generate`, `::test_second_process_lock_blocks_writing`, `::test_continuation_opening_recalls_the_parent`, `::test_routes_get_is_read_only_and_generate_writes`, `::test_raising_and_slow_handlers_never_break_commits` |
| Dictate: body caps (413), busy queue (409), unavailable (503), redacted errors, preload only in main, initial prompt | `test_speech.py::test_transcribe_413_when_declared_length_exceeds_cap`, `::test_transcribe_413_when_chunked_stream_exceeds_cap`, `::test_transcribe_409_when_speech_queue_full`, `::test_transcribe_503_while_speech_not_ready`, `::test_transcribe_error_result_is_200_and_redacted`, `::test_create_app_does_not_start_a_preload`, `::test_compose_initial_prompt_keeps_names_and_trims_glossary_first`, `::test_every_speech_error_code_is_an_api_error_code` |
| Whisper transcribes a real clip (marker `whisper`; skipped without the cached model and the clip, never downloads) | `test_model.py::test_whisper_transcribes_the_jfk_sample` (`model.transcribe` directly), `test_speech.py::test_real_whisper_transcribes_jfk_clip` (the transcribe route end to end, WAV upload) |
| Chat engine, briefs (validation without opening a run, CAS approve, idempotent effect, staged origin `assistant`), conversation store, ledger and budgets, knowledge loader, assistant API; digest and Story Mode | the WP2/WP3 test files `test_assistant_engine.py`, `test_assistant_briefs.py`, `test_assistant_store.py`, `test_assistant_ledger.py`, `test_assistant_knowledge.py`, `test_assistant_api.py`, `test_assistant_digest.py`, `test_assistant_story.py` (node ids added here when they land) |
| Docs match the code (paths, symbols, routes, registry keys, env vars, assumption ids, these test ids, control labels, stale phrases, index) | `test_docs_consistency.py::test_docs_match_the_code` (runs `scripts/check_docs.py`) |
| Frontend: assistant context store, answer formatting, brief rendering, Story Mode helpers, the `story` route | `node src/state/state.test.mjs` (in `frontend/`) |
| Browser (fake models): drawer entry and docking, tabs row height < 34 px, docked drawer width, a question with context, progress and refs, first-time user, create-run and interventions briefs, God mode badge, Storybook, Escape order, Story Mode to the first chapter, Dictate on secure and non-secure origins | `qa/browser_check.mjs` steps 18-33: `assistant-preflight`, `assistant-entry-drawer`, `assistant-run-docked`, `assistant-run-floating`, `assistant-tabs-row`, `assistant-ask-answer`, `assistant-progress-and-refs`, `assistant-first-time-user`, `assistant-create-run-brief`, `assistant-interventions-brief`, `assistant-godmode-badge`, `assistant-storybook-readonly`, `assistant-storybook`, `assistant-escape-record-viewer`, `story-mode`, `assistant-dictate` (table and environment in `qa/README.md`; run against `qa/assistant_fake_server.py`) |
| Model tiers per capability, format reliability, latency and cost (LIVE, budgeted) | `scripts/assistant_playtest.py` (subcommands `questions`, `chat`, `narrator`, `ab-pairs`, `author`, `briefs`, `recheck`, `report`; one backend per arm on a worlds copy under `qa/worlds-playtest/<arm>/`, raw logs in `qa/playtest-out/`); results in `docs/evidence/assistant_playtest.md` and the "Model tier evidence" table of `docs/ASSISTANT.md` |
| Salvage of malformed CLI replies (offline, no spend) | `scripts/assistant_replay_malformed.py`; the result is in `docs/evidence/assistant_playtest.md` "Replay of stored malformed envelopes" |
| Brief cards render deterministically from the typed action | `qa/render_brief.mjs` (the real frontend `describeAction`, called by the playtest's `briefs` arm) and `node src/state/state.test.mjs` |

Browser steps for a manual check of the assistant (fake keys, as in `qa/README.md`):
open a run, press **Assistant**, ask "What is going on right now?" (an answer with turn links);
ask "Step 2 rounds" (a brief whose "What will happen" names step_round ×2; **Approve** and watch
the run advance); open the **Storybook** tab (entries appear as turns commit); on the entry page
choose **Story Mode**, pick the run, accept the brief and read chapter 1; hover **Dictate** when
the page is opened by IP address (disabled, "open via localhost").

## Map views: the 2D map fixes and the 3D view

No test calls a model; the browser steps create or open fake-model runs only.

| Requirement | Verified by |
| --- | --- |
| The viewed turn's effects are read from its saved record and its own events only (moves with their path, blocked moves, attacks, messages, absorbs, transfers, world events; no acting effect without an action) | `node src/state/state.test.mjs` (in `frontend/`): "turnEffects: a move reads its path from the result; a blocked move keeps the agent and points at the blocked cell", "turnEffects: attack, messages, absorb and transfer name their targets and cells", "turnEffects: world events become death, growth, fruit, germination, starvation and voice effects; turns without an action have no acting effect" |
| 2D dots: one diameter per zoom level, capacities that never fall when zooming in, roomy / packed / over-full cells with a count badge, the selected and acting entities keep a dot, the badge is hit before the dots, labels under dots, far-mode group tiles | "map dots: one diameter per zoom level, whatever the cell holds", "map dots: the table's capacities never fall when zooming in", "map dots: roomy, packed and over states at 44 px", "map dots: priority ids keep a dot when a cell overflows", "map dots: hitCell picks the badge first, then the nearest dot centre", "map dots: labels under a lone dot from 36 px and under a row from 160 px", "map dots: far-mode tiles" (`frontend/src/components/inspect/mapDots.ts`) |
| 2D action marks and captions: move badge and arrow (failed: red badge and stroke), rings, links and amounts for attack, absorb, transfer and messages, observe, query, round-end events, init, the 60-mark cap, no action, agent view | "map indicators: a move gives a badge with its direction, an arrow and nothing else; a blocked move a failed badge and a failed arrow", "map indicators: attack, absorb, transfer and messages ring and link their counterparts and print amounts", "map indicators: observe, query, round-end events, init and the cap", "map indicators: no action, agent view and captions" (`frontend/src/state/mapIndicators.ts`) |
| Agent fog: only successful own observations reveal terrain; queried entities and believed self reveal their locations without inventing terrain | "agent fog reveals only successful own observations and known locations" (`frontend/src/state/agentFog.ts`) |
| 3D pure logic: the stored view choice, scene coordinates and layers, packing without dropping an occupant, far-view columns, the camera (frame and top view, flight, look, pan, wheel, focus, glide, key bindings, the `data-camera` key), the turn's animation timeline (within 700 ms, reduced motion), the merged terrain, colours from the CSS tokens, chip glyphs, and overlay placement that never lets labels, chips and badges overlap | "map3dView: parseMapViewMode and the storage key", "map3dLayout: cells, layers and scene coordinates", "map3dLayout: packCell never drops an occupant and keeps figures equal-sized", "map3dLayout: orderForSlots, countBadge, LOD", "map3dLayout: boxesOverlap keeps a gap and treats touching edges as apart", "map3dLayout: placeOverlay never lets two placed boxes overlap (crowded labels fall back to the id, then drop out)", "map3dLayout: placeOverlay order: pinned first and always, then priority, depth and key; free entries take no room", "map3dCamera: frameRegion and topView look at the board centre", "map3dCamera: step flies horizontally, climbs, and respects the floor, ceiling and dt cap", "map3dCamera: look, pan and wheel", "map3dCamera: focus, elevator, glide, bindings and the data-camera key", "map3dTimeline: agent action clips arrive at the saved turn", "map3dTimeline: world clips, staggered spawns, scaling, reduced motion and missing data", "map3dTerrain: one merged board with raised mountains and sunk water", "map3dPalette: CSS colours, missing tokens, health, species and dominant kinds", "map3dGlyphs: an ASCII SVG path per effect kind, a strike for failures, chip text" (`frontend/src/state/map3d*.ts`) |
| Browser, 2D: the live turn's marks group keyed by its turn id with the turn's kind and a fixed action line; the same group survives a hover and a live refresh; an agent turn in history shows the actor's badge with a plain-language action word (and an arrow for a successful move); dot radius 4.5 at 44 px and 5 at 56 px; one group tile per occupied cell and no dots at 10 px, tile digits at 18 px; the most crowded cell's dots and count badge, whose click lists every occupant without opening a profile card; **Action marks** hides and restores the marks; **Key** is collapsed by default, opens the key with the terrain entries and is remembered; the map keeps at least 220 px | `qa/browser_check.mjs` step 36 `map-marks` (screenshots `36-map-marks-turn.png`, `36-map-far.png`, `36-map-key.png`, `36-map-dark.png`) |
| Browser, 3D: no three.js request before **3D view** is chosen and the `Map3dView` chunk after; the 2D map stays mounted and hidden; the help card on the first open; `data-entities` and `data-agents` equal the API's counts, CPU Canvas 2D renderer, zero triangles, finite frame timing, no WebGL requests or Three.js runtime (`data-renderer` and `data-frame-ms` recorded); labels match living agents in the viewed knowledge (which may differ from the true roster), the selected agent's label on its believed cell, a label click opens its profile card and Escape returns the focus to the board; W, Space, Shift and Q move the camera; F equals `map3dCamera.frameRegion`; a 120 px drag turns 30 degrees without changing the selection; the wheel moves closer; one layer (**Layer up** / **Layer down** disabled, PageUp no change); ? opens the help card; the choice persists across a reload; the newest successful move in history is drawn at its destination with its chip and **Replay turn animation** animates within 300 ms and settles within 1.5 s; **2D map** restores the SVG and stores "2d" | `qa/browser_check.mjs` step 37 `map-3d` (screenshots `37-map-3d-board.png`, `37-map-3d-help.png`, `37-map-3d-history.png`, `37-map-3d-dark.png`) |

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

### Saved-turn replay refinements (2026-09-27)

Run `node qa/replay_refinement_check.mjs` against the running frontend/backend. The read-only recorded-run check covers mouse-wheel zoom without page scroll, visible 2D cues, checkpoint loading slower than playback tempo, stopping/manual navigation, crossing round boundaries, stopping at the recording's end in history, explicit playback from a chosen past turn while viewing the latest turn, restarting from the beginning, including checkpoints appended during playback (browser response mock only), replaying one turn repeatedly in CPU 3D, reduced motion, mobile overflow, and zero simulation command requests. The main `qa/browser_check.mjs` continues to verify the renamed simulation buttons against fake-model turn counts.

The board workspace refinement also checks that the default board takes over 75% of desktop width and over 65% of viewport height with the left Replay panel open, and that opening a utility panel leaves its bounds unchanged. Review 1366×768, 1600×1000, 1024×768 and 390×844 layouts in both views; check Session, Inspector/God mode and right-side Activity panels, the Replay toggle, Close/Escape, and record-view close buttons. The 2D initial framing must show the entire region; explicit zoom/pan must still work.


### Clone saved setup

`test_e2e_run.py::test_clone_setup_preserves_original_request_and_creates_a_fresh_world` checks the full 16-agent request after progress and settings edits, an archived source with no open worker, distinct world/run ids, an initial checkpoint only, editable clone values and unchanged source bytes. `test_clone_setup_of_continuation_uses_inherited_creation_request` covers branches. `test_clone_setup_reports_missing_or_invalid_reference` covers missing/corrupt references and unknown runs. The frontend state suite covers the clone route round trip. Browser check: `node qa/clone_setup_check.mjs` verifies single selection, prefilled editable form, validation and creation using a fake model, archive access, source preservation and an explicit load error.
