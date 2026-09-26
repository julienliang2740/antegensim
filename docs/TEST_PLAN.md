# Empyrean prototype: test plan

Owner: QA. This plan maps every completion criterion and every user requirement in
`llm_world_technical_spec.md`, plus the required checks in `docs/INTERFACES.md`
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
| Browser checks with the assistant steps on fake models (all 33 steps) | `.venv/bin/python qa/assistant_fake_server.py`, then `cd frontend && EMPYREAN_API_PROXY=http://127.0.0.1:8020 npx vite --port 5180 --strictPort`, then `cd qa && BASE_URL=http://127.0.0.1:5180 API_URL=http://127.0.0.1:8020 node browser_check.mjs` | nothing paid; the QA server forces every assistant profile to `fake-assistant` and adds the fake-metadata hook (`qa/README.md`) |
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
