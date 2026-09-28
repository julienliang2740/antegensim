# Test evidence

What was tested, how, and with what result. **Current as of 2026-09-26** (the assistant release and its verification pass), on the working tree at commit `bd240df`; later changes of the same day have their own dated rows (the latest: the 2D map fixes and the 3D view, 23:35-23:48 UTC). Sections that were not re-run in this pass keep their original date in the heading (2026-09-25, before the assistant release); their numbers are historical.

Every section is labelled:

- **MOCKED**: no real provider was called. Models are the deterministic fakes (`fake-heuristic`, `fake-scripted`, `fake-malformed`, `fake-assistant`), or provider responses are recorded or mocked payloads.
- **LIVE**: real, paid calls through the Claude Code CLI (`claude-cli-haiku` for simulation agents; `claude-cli-haiku-assistant`, `claude-cli-sonnet-assistant`, `claude-cli-opus-assistant` for the assistant). This is the only live provider on this machine.
- **LOCAL**: no model provider and no spend, but real local computation (Whisper on the CPU, the salvage replay over stored replies).

Requirement-to-test mapping is in [TEST_PLAN.md](TEST_PLAN.md). Known gaps are in [LIMITATIONS.md](LIMITATIONS.md).

## Summary

### Frontend presentation refinement — 2026-09-27 (LOCAL / MOCKED)

- Production build and typecheck passed. Lint: zero errors, four pre-existing warnings. All 96 frontend state tests passed.
- Full browser walkthrough: 29 passed, zero failed, eight AI-backed assistant steps skipped on the primary backend. The walkthrough used fake simulation models; the requested sweep replays were inspected without advancing their simulations.
- Read-only map checks on SWEEP-B2v2 passed: 2D crowd counts and marks, 3D selection, camera controls, history, replay, and view persistence. The CPU renderer works with WebGL requests blocked and does not download Three.js.
- Visually reviewed Two tribes, Blood arena II, and Three clans blood feud in light and dark modes. Sample CPU frame times were 1.8–3.3 ms; idle rendering stopped. Reduced-motion playback remained static. Checked widths 1600, 1280, 1024, and 390 px without horizontal page overflow.
- Final camera refinement fits the near board corners; the 13-occupant Two tribes cell retains its count badge. Attack replay shows the target and recorded damage. Backend, simulation rules, API contracts, and application data flow were unchanged.

Earlier dated results below remain historical.

| Area | Label | Date | Result |
| --- | --- | --- | --- |
| Backend unit + end-to-end + assistant tests | MOCKED | 2026-09-26 17:33 UTC (after the working indicator and the story listing) | **683 passed, 4 skipped** (3 live, 1 Whisper test without its clip) of 687 collected, 114.8 s (682 passed at 09:22 after the fix pass) |
| Docs consistency (`scripts/check_docs.py`) | no models | 2026-09-26 | `docs check: clean` (10 checks) |
| Frontend type-check, lint, state tests, build | no models | 2026-09-26 17:33 UTC | `tsc -p tsconfig.app.json --noEmit` clean; lint 0 errors, 4 warnings; `state.test.mjs` 54 of 54 (50 at 09:22; +3 working-indicator helpers, +1 run-picker ordering); `npm run build` ok |
| Whisper (real model on the CPU) | LOCAL | 2026-09-26 | both `whisper`-marked tests pass with the clip present (6.4 s and 5.9 s); an 11 s clip transcribes in about 7 s with `large-v3-turbo` |
| Browser QA, 17 legacy + 16 assistant steps | MOCKED | 2026-09-26 17:30 UTC (after the working indicator and the story listing; earlier 09:24 and 08:34-08:37) | **33 of 33** against the fake QA backend (`qa/out/2026-09-26_17-30-23`); **25 passed, 8 skipped** (the steps that would call a model) against the primary live backend at 09:24 (`qa/out/2026-09-26_09-24-14`); no console or page errors; USD 0 |
| Working indicator (Story Mode banner, drawer, Storybook), independent Playwright verification with slow fake replies | MOCKED | 2026-09-26 17:20 UTC | 28 of 28 checks (banner within 1 s of submitting the spec, ticking counter, disabled composer, chapter and drawer and Storybook states, reduced motion, 390 px, reload mid-work); screenshots `docs/evidence/screenshots/assistant/working-*.png` |
| Story Mode run picker: unfinished stories first, Finished stories panel newest first | MOCKED | 2026-09-26 17:30 UTC | Lead browser check on the fake servers: unfinished runs shaded at the top with the Stories cell and **Continue story**, **Finished stories (1)** opens the panel, **Read** opens the story; screenshots `picker-unfinished-first.png`, `picker-finished-panel.png` |
| Assistant playtest, model tiers per capability | LIVE | 2026-09-26 | 80 ground-truthed questions per chat arm: Haiku 74/80, Sonnet 73/80; narrator, author and briefs arms; **USD 10.93** of a USD 22 cap |
| Sonnet smoke on the primary backend | LIVE | 2026-09-26 | 1 chat step, CLI `malformed` then salvaged into a correct answer, **USD 0.10** |
| Replay of stored malformed CLI replies through salvage | LOCAL | 2026-09-26 | 83 payloads: 77 validate after salvage (the same-key unwrap rule shipped in `calls.salvage`; 28 before it) |
| Resume page archive and delete (multi-select, archive view, restore, delete with confirmation) | MOCKED | 2026-09-26 18:05 UTC | Backend **693 passed, 4 skipped** (+10: `test_run_archive.py` 9, `test_api.py` 1); `state.test.mjs` **60 of 60** (+6 selection tests); tsc clean, lint 0 errors and the same 4 warnings; `docs check: clean`; browser **34 of 34** on a fake QA backend (port 8022, `qa/worlds-archive`; `qa/out/2026-09-26_17-57-24`) and step 34 again after the last UI change (`qa/out/2026-09-26_18-05-57`); USD 0. See "Resume page archive and delete" below |
| Entity profile card (card over the run page replaces the inspector's full record; Inspector tab keeps the cell, occupants and a summary) | MOCKED | 2026-09-26 19:44 UTC | tsc clean; lint 0 errors and the same 4 warnings; `state.test.mjs` **66 of 66** (+5 profile tests); `docs check: clean`; browser **35 of 35** on the fake QA backend (port 8020 on the launcher with the fake agent default, `qa/out/2026-09-26_19-46-30`, 0 live calls; new step 35 `profile-card`; `select-occupants`, `agent-inspector`, `plant-rules` and `assistant-progress-and-refs` now go through the card; one expected 409 console line from the refused delete in step 34). The check now creates every run on `fake-heuristic`; before that fix, the shipped default `claude-cli-haiku` made 31 live CLI Haiku calls during this work (a demo run and one aborted check, 191k input and 14k output tokens). Screenshots `docs/evidence/screenshots/profile-*.png` (agent Overview and Decisions, plant Overview and Growth, fruit; light and dark) |
| 2D map fixes (equal dots, count badges, group tiles, action marks, **Key**) and the 3D view | MOCKED | 2026-09-27 00:13-00:17 UTC | tsc clean; lint 0 errors and the same 4 warnings (`RunPage.tsx:202` now); `state.test.mjs` **96 of 96** (+30: 3 turnEffects, 7 map dots, 4 map indicators, 16 map3d); `docs check: clean`; backend **694 passed, 4 skipped** (the one flaky archive test fixed: it now waits for the closed worker to release the writer lock, 0 failures in 40 isolated runs against 2 in 30 before); browser **37 of 37** on the fake QA backend (`qa/out/2026-09-27_00-13-13`), and the map steps 3 of 3 on each of three saved runs on the primary servers without running a turn. 3D on SwiftShader: 9-12 draw calls, 730-5,844 triangles, 0.8-1.2 ms CPU per frame; USD 0. See "2D map fixes and the 3D view" below |
| Sweep follow-ups: storybook auto off by default, input-cap lockout, CLI output-cap stalls | MOCKED | 2026-09-27 14:50 UTC | Backend **711 passed, 4 skipped** (+2: a mandatory part above the input cap is sent alone; the CLI "exceeded the 250 output token maximum" envelope is `truncated`; the storybook tests now pin the `auto` rule they exercise); `docs check: clean`; tsc clean; lint 0 errors and the same 4 warnings; `state.test.mjs` 96 of 96 |
| Simultaneous round decisions (A-SCHED-5/6) | MOCKED + LIVE | 2026-09-27 06:50 UTC | Backend **709 passed, 4 skipped** (+11: ten end-to-end round-decision tests in `test_e2e_round_decisions.py` and the agents' rules text; `test_runner.py` now runs the round decisions on a one-worker pool, looped 8 times without a failure); `docs check: clean`; tsc clean; lint 0 errors and the same 4 warnings; `state.test.mjs` **96 of 96**; build ok; browser **37 of 37** on the fake QA backend (`qa/out/2026-09-27_06-44-59`). The concurrency test fails as it should with `EMPYREAN_MODEL_CONCURRENCY=1` (a round of 8 x 0.4 s calls took 3.4 s). An adversarial review found seven defects (stale decisions after a failed first turn plus an edit, an interrupted skill shown as running, recovered calls in the wrong turn, an extra round of calls per retry, untracked calls when packet building fails, a voided call recorded before `turn_started` with the wrong reason, voided calls waited out instead of cancelled); all fixed, with regression tests for five of them. LIVE, Claude Code CLI Haiku 4.5 (8 agents x 3 rounds; 24 agents x 2 rounds): 8-agent rounds took 6.0 / 8.3 / 7.6 s (24 calls, mean latency 5.9 s: about 48 s per round one call after another), 24-agent rounds 10.7 / 14.0 s (48 calls at up to 16 at once, peak about 2.5 GB more memory); every call id unique, ledger equal to the call records, no pending files left; $0.21 and $0.40 |
| Attack damage cap (`stats.attack_cap`, A-ACT-19) and the 64-agent limit | MOCKED | 2026-09-27 04:13 UTC | tsc clean; lint 0 errors and the same 4 warnings; `state.test.mjs` **96 of 96**; build ok; `docs check: clean`; backend **698 passed, 4 skipped** (+4: capped attack and charge, the cap's upgrade price and growth, the cap in query answers, the agents' rules text; the API test now requests 64 default cards); browser **37 of 37** on the fake QA backend (`qa/out/2026-09-27_04-13-43`); a headless 64-agent fake-heuristic run (`scripts/run_sim.py --agents 64 --rounds 3`) ran 3 rounds with 64 living agents, about 10 s per round, about 200 KB per turn. A stored decision packet shows the agent the cap rule, its price and its own `attack_cap 50`. The main backend was restarted on the new code. Not yet run: a live model run with the cap or with more than 12 agents |
| Resilience and completion criteria (13 scripts, 165 checks) | MOCKED | 2026-09-25 | 165 of 165 on the source before the assistant release (not re-run) |
| Headless simulations | MOCKED | 2026-09-25 | 2 runs of 8 agents x 3 rounds, no errors (not re-run) |
| Live simulations, live tests and a live UI session | LIVE | 2026-09-25 | 6 runs, the 3 live pytest tests (2 of 3, then 3 of 3), 102 calls, USD 0.782 (not re-run) |
| Provider adapters other than `fake` and `claude_cli` | MOCKED only | | Unit tests against mocked payloads; never called for real |

Total paid model spend recorded here: USD 0.782 (simulation agents, 2026-09-25) + USD 10.93 (assistant playtest) + USD 0.10 (Sonnet smoke) = **USD 11.81**.

## Deterministic (fake models): MOCKED

### Backend tests (2026-09-26)

`cd backend && ../.venv/bin/pytest -q` at 09:22 UTC, after the fix pass: **682 passed, 4 skipped in 111.1 s** (686 collected; about twice the usual minute because other work was running on the machine). Fake model keys only; `EMPYREAN_LIVE_TESTS` unset. The per-file table below is the `bd240df` state (674 collected) before the fix pass added 12 assistant tests.

Skipped:

- the 3 `@pytest.mark.live` tests (`test_model.py::test_live_claude_cli_haiku_tiny_schema`, `test_model.py::test_live_claude_cli_decision_bills_near_packet_estimate`, `test_e2e_boundaries.py::test_live_provider_runs_the_same_decision_flow[claude-cli-haiku]`), which need `EMPYREAN_LIVE_TESTS=1`;
- `test_model.py::test_whisper_transcribes_the_jfk_sample` ("no test audio at backend/tests/data/jfk.flac"). The other `whisper` test found the session's copy of the clip and passed. With `EMPYREAN_WHISPER_TEST_AUDIO` set to the clip, `pytest -q -m whisper` gives 2 passed in 13.0 s (6.4 s and 5.9 s per test).

Tests per file (collected):

| Kind | Files | Tests |
| --- | --- | --- |
| Unit | `test_world` 65, `test_skills` 148, `test_runner` 54, `test_model` 108, `test_storage` 39, `test_context` 36, `test_api` 11, `test_integration_rev3` 9 | 470 |
| End-to-end, through the public API routes | `test_e2e_run` 12, `test_e2e_rules` 9, `test_e2e_godmode` 12, `test_e2e_context` 4, `test_e2e_boundaries` 5 | 42 |
| Assistant (fake models) | `test_assistant_contracts` 25, `test_assistant_engine` 16, `test_assistant_briefs` 11, `test_assistant_store` 8, `test_assistant_ledger` 6, `test_assistant_knowledge` 15, `test_assistant_api` 13, `test_assistant_digest` 10, `test_assistant_storybook` 16, `test_assistant_story` 15 | 135 |
| Dictate | `test_speech` 25 | 25 |
| Docs | `test_docs_consistency` 2 | 2 |
| **Total** | | **674** |

Re-run at 09:10-09:12 UTC while the assistant fix packages were landing their backend and test changes: 685 collected, 680 passed, 4 skipped (the same four), 1 failed in `test_assistant_engine.py`, a file being edited at that moment; `test_assistant_engine.py` and `test_docs_consistency.py` passed (25 of 25) on the immediate re-run. Final run on the committed fix pass at 09:22 UTC: 686 collected, 682 passed, 4 skipped.

Known flake: `test_assistant_api.py::test_plain_answer_with_refs_and_progress` failed in 2 of 18 runs during the playtest (and not in 5 group runs during browser QA, nor in this run). The engine marks the job `done` before it clears `meta.active_job_id`, so a read between the two writes saw a stale id; the UI was unaffected. Fixed: the final message write, the clearing of `active_job_id` and the job status now change together under the conversation lock, and the test passed 10 of 10 single runs and 10 of 10 file runs afterwards.

The fakes sit behind the same `model.py` boundary as the real providers, so these tests run the real runner, world engine, context builder, skills interpreter, storage, API and assistant engine. What they prove, and what only a live run can prove, is set out in TEST_PLAN.md under "Mocked vs live".

### Docs check (2026-09-26)

`.venv/bin/python scripts/check_docs.py`: `[paths] OK`, `[symbols] OK`, `[routes] OK`, `[models] OK`, `[env] OK`, `[assumptions] OK`, `[testplan] OK`, `[controls] OK`, `[stale] OK`, `[index] OK`, `docs check: clean`. It also runs inside the backend suite (`test_docs_consistency.py`).

### Frontend (2026-09-26)

| Check | Command (in `frontend/`) | Result |
| --- | --- | --- |
| Type-check | `npx tsc -p tsconfig.app.json --noEmit` | no errors |
| Lint | `npm run lint` (oxlint) | 0 errors, 4 warnings after the fix pass: 1 `react(set-state-in-effect)` (`RunPage.tsx:170`), 3 `react(only-export-components)` (`inspect/common.tsx:38`, `InstructionsPage.tsx:26,31`); see LIMITATIONS.md (10 warnings at `bd240df`) |
| Unit tests of the state modules | `node src/state/state.test.mjs` | 50 of 50 passed (47 at `bd240df`) |
| Build | `npm run build` | ok (09:22 UTC) |

The table shows the state after the fix pass (09:22 UTC); at `bd240df` lint had 10 warnings (six `react(set-state-in-effect)` in `AssistantDrawer.tsx`, since removed without suppress comments) and the state tests numbered 47.

There are no React component tests; the UI is covered by the state tests above and the browser check below.

### Headless simulations (2026-09-25, before the assistant release)

`scripts/run_sim.py`, in-process, scratch worlds folder, run at 19:39 on the source before the last fix pass (not re-run; the resilience suite and pytest cover the final source). Full output: `docs/evidence/final_pass/headless_*.txt`.

| Model | Setup | Result |
| --- | --- | --- |
| `fake-heuristic` | 8 agents, 3 rounds, seed 1 | 2.7 s. 24 actions, all ok (observe 8, absorb 8, query 8). 24 model calls completed. No deaths. Cognition 13.05 compute, actions 40, upkeep 24. Mean agent-turn folder 112.5 KB; the printed turn folder holds only the acting agent's knowledge file |
| `fake-malformed` | 8 agents, 3 rounds, seed 1 | 8 observe actions ok. 16 decisions rejected by the format gate (`decision_invalid`: no action applied, cognition charged). 8 calls classified `failed/malformed`. The run stayed `paused` after each round, with no error |
| `claude-cli-haiku` without `EMPYREAN_ALLOW_LIVE=1` | | Refused: "refusing to run a live model (provider 'claude_cli') without EMPYREAN_ALLOW_LIVE=1" |

### Resilience and completion criteria (2026-09-25, before the assistant release)

Full method, per-criterion evidence and run ids: [evidence/resilience.md](evidence/resilience.md). The scripts in `qa/resilience/` drive a real backend process over HTTP with fake models; `qa/resilience/run_all.sh` runs them all.

**Final source** (20:44–20:48 UTC; own backend on ports 8040/8041, fresh worlds folder `qa/resilience/worlds-final`; source hash `1132bcec6042` at start and end): **13 scripts, 165 of 165 checks passed.** Logs: `docs/evidence/final_pass/resilience/*.log` and `run_all.meta`.

| Scenario | Passed | Notes |
| --- | --- | --- |
| a. `kill -9` during `waiting_model`, then resume | 27 of 27 | Reopens paused at the last saved turn, re-runs the turn with call `_02`; 37 turns and 8 agent files match the uninterrupted reference; ledger 36 calls / 3 interrupted = the committed records after a double crash |
| a2. 12 random `kill -9`s during play | 15 of 15 | Index, chain, seq and ledger invariants after every restart (final: 52 records, 12 interrupted, ledger `calls 52, interrupted_calls 12`); 46 turns match the reference |
| b. Controls: opens paused, card defaults, Run turn / Play / Pause / Step round | 22 of 22 | |
| c. Playback makes no model calls | 8 of 8 | |
| d. Malformed and invalid decisions: no forbidden effect, correct fees | 15 of 15 | |
| e. Skill actions cost 0.8x, direct 1x (design example 1) | 8 of 8 | |
| f. Context settings at creation and in god mode | 15 of 15 | |
| g. Operator voice reaches exactly its recipients | 7 of 7 | |
| h. `working/` edit + reload, continuation keeps the parent's future | 17 of 17 | The continuation's first turn is the parent's resolved checkpoint: every knowledge file written, map pointing at itself |
| i. One writer per run | 9 of 9 | |
| j. Storage per turn and the knowledge-file rule | 5 of 5 | 107, 120 and 147 KB mean agent-turn folder at rounds 1, 4, 8; one knowledge file per agent turn; all 73 turns and 584 knowledge views load through the API |
| k. Live feed, point inspection, bounded packets | 9 of 9 | |
| l. Reload and UI edits for the same boundary (new) | 8 of 8 | Both staging orders keep every edit, the later-staged value wins on a shared field, and a conflicting file edit fails as a whole |
| **Total** | **165 of 165** | |

This pass realigned 19 assertions with rules the fix pass changed on purpose. There were 17 on the ledger (`calls` counts every record; `interrupted_calls` is a subset), 1 on knowledge files (written only when changed, resolved through `world.json.knowledge_files`) and 1 on continuations (the copy is the resolved checkpoint). It also added scenario l. Before that, the same scripts gave 134 of 153 on the fix-pass source (`c4e9c95fb6a3`), and the first batch gave 153 of 153 on the pre-fix source.

The first QA batch found 5 defects. On the final source: D1 (every turn copied all knowledge) is fixed; D2 (ledger helpers disagreed) is fixed; D3 (prompt stored three times) is open; D4 (reload problems) has its paths fixed but still comes in two rounds; D5 (`action` summaries omitted the actor) is fixed.

## Browser QA

### Assistant steps and the legacy steps (2026-09-26): MOCKED

Full results, step table, findings and screenshots: [evidence/browser_qa_assistant.md](evidence/browser_qa_assistant.md). Headless Chromium (Playwright 1.49.1) through `qa/browser_check.mjs`: the 17 legacy steps plus 16 assistant steps (18-33: drawer, docking, tabs row, questions, progress and refs, first-time user, create-run and interventions briefs, God mode badge, Storybook, Escape order, Story Mode, Dictate).

| Pass | When (UTC) | UI / backend | Assistant models | Result | Log |
| --- | --- | --- | --- | --- | --- |
| A: all fake | 08:34-08:36, repeated 09:24 after the fix pass | Vite 5180 -> `qa/assistant_fake_server.py` on 8020 (worlds `qa/worlds-assistant`) | all four profiles `fake-assistant` | **33 passed, 0 failed, 0 skipped** both times | `docs/evidence/browser_qa_assistant_fake.log.json` (first run); `qa/out/2026-09-26_09-24-22/log.json` (after the fix pass, with step 27 scripting the invalid brief twice for the new repair step) |
| B: primary servers | 08:36-08:37, repeated 09:24 after the fix pass | Vite 5173 -> backend 8000 | chat/author Sonnet, narrator/summarizer Haiku (live keys) | **25 passed, 0 failed, 8 skipped** both times (the 8 steps that would call a model skip themselves) | `docs/evidence/browser_qa_assistant_primary.log.json` (first run); `qa/out/2026-09-26_09-24-14/log.json` |

No model money was spent: the primary's assistant spend stayed at USD 0.1028 (the Sonnet smoke) before and after. No console or page errors in either final pass. Screenshots: `docs/evidence/screenshots/assistant/` (each opened and checked by eye).

Findings (none failed a step): the fifth run-page tab ("Storybook") is partly hidden in the scrolling tabs row at the default side-column width; the drawer printed the backend's stale "0 s" progress text under the ticking line; the step list numbered steps from 2; the as-of chip read "TURN turn <id>"; an approved interventions brief showed in the God mode count only after the next status poll (about 1.5 s). All five were fixed by the frontend fix pass (tabs sized by the tabs-row container, backend progress text no longer shown and the elapsed time derived client-side, 1-based step list, ref chips without a doubled kind, staged count applied at approval), and the browser check passed again afterwards (09:24 UTC). `http://127.0.0.1` is a secure context in Chromium, so Dictate's disabled state is checked on a non-loopback host alias (`QA_INSECURE_HOST`).

### Resume page archive and delete (2026-09-26): MOCKED

Browser step 34 `resume-select-archive-delete` (see `qa/README.md`) on `qa/assistant_fake_server.py`
(port 8022, worlds `qa/worlds-archive/`) with Vite on 5182: five closed runs and one open run created
through the API; Ctrl-click on the first and third rows and Shift-click on the fifth selected exactly
rows 1, 3, 4 and 5; **Archive selected** showed "Archived 4 runs." and the API listed them only with
`?archived=1`; the archive view had no Open buttons; **Restore** moved one back; **Delete selected…**
opened the dialog naming the run and saying it cannot be undone, then the folder was gone (404); the
open run was refused with "Not deleted: run … is open in this backend; leave it (Back to sessions)
before deleting". The only console error is that intended 409. Screenshots, each checked by eye:
`docs/evidence/screenshots/resume-selection-toolbar.png`, `resume-archive-view.png`,
`resume-delete-dialog.png`, `resume-delete-refused.png` and `resume-dark-selection.png` (dark
scheme). The same full run passed all 33 earlier steps.

### 2D map fixes and the 3D view (2026-09-26): MOCKED

Two new browser steps after `profile-card` (see `qa/README.md`): 36 `map-marks` (the 2D map) and 37
`map-3d` (the 3D view). Headless Chromium 131 (Playwright 1.49.1) at 1400x900; WebGL 2 is drawn by
SwiftShader ("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader
driver)", `data-software="1"`), with no launch flag. No model was called and no turn ran on the
primary backend.

| Pass | When (UTC) | UI / backend | Result | Log |
| --- | --- | --- | --- | --- |
| Full check, all fake (first build) | 2026-09-26 23:38-23:41 | Vite 5180 -> `qa/assistant_fake_server.py` on 8020 | 36 passed, 1 failed (`profile-card`: "the card covers the whole map", see below); 36 and 37 passed; the only console error is the intended 409 of step 34 | `qa/out/2026-09-26_23-38-41/log.json` |
| Full check, all fake (final code) | 2026-09-27 00:13-00:15 | Vite 5180 -> 8020 | **37 of 37**; step 35 again sees the board above the card at 1440 x 900 (backdrop alpha 0.32); the only console error is the intended 409 of step 34 | `qa/out/2026-09-27_00-13-13/log.json` |
| `QA_ONLY_MAP=1 QA_RUN_ID=…`, saved runs (final code) | 2026-09-27 00:15-00:17 | Vite 5173 -> primary backend 8000 (nothing ran) | 3 of 3 on each saved run: badge clicks listed 9 (bare, 30 px), 7 (bare, 30 px) and 14 (pill, 44 px) occupants without opening a card; history moves r00049_t02_a02 and r00022_t04_a06 replayed in 596 and 610 ms; no console or page error | `qa/out/2026-09-27_00-15-59/`, `…_00-16-27/`, `…_00-16-59/` |
| `QA_ONLY_MAP=1`, new fake run | 23:35 | Vite 5180 -> 8020 | 8 of 8 (preflight, run creation, round 1, 36, 37) | `qa/out/2026-09-26_23-35-54/log.json` |
| `QA_ONLY_MAP=1 QA_RUN_ID=…`, saved runs | 23:46-23:48 | Vite 5173 -> primary backend 8000 (live models; nothing ran) | 3 of 3 on each of `run_20260926_185253_0ad7`, `run_20260926_022058_ec4a`, `run_20260926_034607_b7c5`; no console or page error | `qa/out/2026-09-26_23-46-09/`, `…_23-46-37/`, `…_23-47-08/` |

What the steps found (saved runs: 21 x 21 with 135 markers and no living agent / the 3 x 3 arena with 2 living of 12 agents / the one-cell arena with 14 entities; the fake QA run: 21 x 21, 8 agents, 32 markers):

| Check | Result |
| --- | --- |
| Marks of a history agent turn | move r00049_t02_a02 (badge `move`, 1 arrow, caption "Turn r00049_t02_a02 · Boreas (a02) moved left"); move r00022_t04_a06; observe r00020_t03_a07; query r00002_t01_a04 on the QA run; the live group survived a hover and a 2.8 s refresh every time |
| Dot radius | "4.5" at 44 px and "5" at 56 px on every run |
| Far mode (10 px) | tiles = occupied cells: 59 of 59, 5 of 5, 1 of 1, 12 of 12; no dots; digits on every tile of two or more at 18 px |
| Count badge | bare "9" at 30 px on (-1, 0) of the 21 x 21 run, bare "7" at 30 px on the arena, pill "14" at 44 px on the one-cell arena: each click listed every occupant and opened no profile card. The QA run's fullest cell holds 3 (never packs; recorded as a note) |
| **Action marks** / **Key** | off removes the marks group, on restores it; Key collapsed by default, open shows "packed: zoom in" and the terrain entries and stores `empyrean.map.key.run` = "1" |
| Map viewport | 666 px tall with the Key collapsed |
| 3D chunk | no `Map3dView` or `three` resource before the click; `/src/components/map3d/Map3dView.tsx` after; ready in 620-885 ms (dev server) |
| 3D counts | `data-entities` / `data-agents` = API: 135/8, 26/12, 14/8, 32/8; 9, 11, 12 and 12 draw calls; 5,844, 1,216, 730 and 2,604 triangles; `data-frame-ms` 0.8-1.2 |
| 3D labels | only living agents, never more than their number (0 of 0, 2 of 2, 4 of 4, 4 of 8 on the QA run at the frame pose); the selected agent's label on its API cell; a click opened its profile card and Escape returned the focus to the board |
| 3D camera | W moved z by -2.2 to -6.0 with y unchanged; Space up, Shift down, Q turned; F equalled `frameRegion` to 0.01 (x 0, y 19.84, z 16.64, pitch -0.87 on 21 x 21 boards); a 120 px drag turned 0.52 rad; the wheel moved closer (25.89 -> 18.17 units from the centre of a 21 x 21 board) |
| 3D history | the actor's label on `effects.to` ("2,2", "0,1") with the chips "moved left" / "moved up"; **Replay turn**: `data-animating` "1" after 2-16 ms, "0" after 608-614 ms. The QA run and the one-cell arena have no successful move (recorded as a note) |
| Persistence and return | 3D kept after a reload, the help card not shown again; **2D map** removed `.map3d` and stored "2d" |

Found and fixed: the first build put the **Map view** switch in a row of its own above the map, which moved
the board 30 px down, so at 1440 x 900 the profile card covered every map cell and step 35 failed. The
switch now sits at the end of the legend's controls row in both views (the toolbar keeps its single row at
1440 px, the map starts at y 55 again, 22 px above the card); below 1440 px the card covers the board as
it did before the map changes (LIMITATIONS.md). The same pass applied the code review's patches (priority
dots in overflowing cells, the 3D status line, radiogroup keys on the switch with the focus handed to the
copy that appears, `// DOCS:` lines) and fixed the flaky archive test. Screenshots, each opened and checked by eye: `docs/evidence/screenshots/map-2d-marks-move.png`,
`map-2d-key-open.png`, `map-2d-far-tiles.png`, `map-3d-arena.png`, `map-3d-history-replay.png`,
`map-3d-help.png`.

### Legacy steps 1-17 and the reviewer passes (2026-09-25)

Recorded on 2026-09-25, before the assistant release; the 17 steps still pass in the 2026-09-26 runs above. Full results: [evidence/browser_qa.md](evidence/browser_qa.md) (two passes, the second on the final code). Curated screenshots: `docs/evidence/screenshots/01-entry.png` … `18-resume-session.png`. Every screenshot was opened and checked by eye.

- **MOCKED (fake models, real Chromium):**
  - `qa/browser_check.mjs` passed **17 of 17** steps on the final code, with no console or page errors (`qa/out/2026-09-25_20-43-52/`; the fixer's own run `qa/out/2026-09-25_20-21-26/` also passed 17 of 17).
  - Pass 2 (after the reload-order fix): the pass-1 major (a `working/` reload undoing UI edits staged for the same turn) passes in both orders at 1440x900 and 1100x750. A conflicting reload is rejected whole, with the reason shown. The tooltip, the occupant scroll cue, the full action JSON, the Set stat display, the full next-round order and the agent-view filtering all pass.
  - Reviewer findings on the final code: 20 of 21 pass, and 1 is partial (row 21: the status bar now changes height at round boundaries because the full next-round order wraps).
  - Remaining: 3 minor issues (agent view works only at the agent's own cell; that status-bar height change; species-rule edit records do not name the changed field), plus the legacy-run cost fields. All are listed in LIMITATIONS.md.
  - All 18 required operator flows passed in pass 1 (entry, cards, validation, controls, pending call, pause, history, crowded cell, inspectors, plant rules, god mode, continuation, error recovery, resume).
- **Reviewer 1 (MOCKED):** an operator could complete all nine steps. They found 1 major and 10 minor issues, all fixed and re-tested since.
- **Reviewer 2 (LIVE):** six steps through the UI with `claude-cli-haiku` (the `review2` row in the live table). The main findings were the stale backend and the "nothing was charged" wording; both have been fixed and re-tested with fakes.

## Assistant (2026-09-26): LIVE and LOCAL

### Ground-truthed playtest: LIVE

Full report: [evidence/assistant_playtest.md](evidence/assistant_playtest.md); per-call log `docs/evidence/assistant_playtest_calls.jsonl`; tier decisions in `docs/ASSISTANT.md` "Model tier evidence". `scripts/assistant_playtest.py` started one backend per arm on a copy of two reference runs (`qa/worlds-playtest/<arm>/`), Claude Code CLI 2.1.283, thinking off, served models `claude-haiku-4-5-20251001`, `claude-sonnet-5`, `claude-opus-5-5`. Answers were scored automatically against ground truth computed from the run folders.

| Arm | Chat questions correct | p50 / p90 latency | Chat calls | CLI malformed | Post-salvage failures | $/question |
| --- | --- | --- | --- | --- | --- | --- |
| Haiku | 74 of 80 (92%) | 6.3 / 9.2 s | 132 | 1 | 1 | 0.031 |
| Sonnet | 73 of 80 (91%) | 11.3 / 22.5 s | 139 | 3 | 2 | 0.089 |

| Capability | Haiku | Sonnet | Opus |
| --- | --- | --- | --- |
| Help and controls | 8/8 | 8/8 | |
| Run analysis | 58/60 (97%) | 58/60 (97%) | |
| Log interpretation (malformed-turn counts) | 8/12 | 7/12 | |
| Execution briefs | 4/6 | 5/6 | 2/3 |
| Storybook entries faithful | 12/13 ($0.0011/entry) | 11/13 ($0.0039/entry) | |
| Story brief valid first try | 1/1 | 1/1 | 2/2 |

| Arm | Spend (CLI-reported) |
| --- | --- |
| Haiku | USD 2.64 |
| Sonnet | USD 7.70 |
| Opus | USD 0.59 |
| **Total** | **USD 10.93** (hard cap USD 22) |

What it showed: Haiku matches Sonnet on help and run analysis at about half the latency and a third of the cost; log-interpretation counting failed on both tiers because `search_events` output is capped without a match count; every tier wrote `set_stat` with `field: "health"` instead of a dotted path; both narrator tiers invented survivor names because the round-end digest listed ids only; every story brief was valid on the first call; format failures stayed under 2% after salvage, and every late chat step read the system prompt from the CLI cache. Defaults were not changed (Sonnet chat and author, Haiku narrator and summarizer). Open items are in LIMITATIONS.md "The assistant".

### Sonnet smoke: LIVE

[evidence/assistant_sonnet_smoke.md](evidence/assistant_sonnet_smoke.md). On the primary backend: one chat step on `run_20260926_034607_b7c5`, CLI verdict `malformed` (`schema_mismatch`), salvaged into a valid, correct answer step without a repair call; 15.2 s, USD 0.103, 40,229 input tokens of which 19,654 cache reads. The ledger records the pre-salvage status. From the sonnet arm: five chat steps all matched the step schema (4.2-7.9 s, USD 0.04-0.06 each), and the narrator's batched calls parsed every section.

### Replay of stored malformed replies: LOCAL

`.venv/bin/python scripts/assistant_replay_malformed.py`: 144 `claude_cli` decision replies under `worlds/` were rejected by the CLI validator (USD 1.12 paid for them); 83 have the rejected payload stored. Salvage turns all 83 into a JSON object, and 28 validate as a Decision (the `{"output": "<json>"}` wrappers). Of the rest, 49 are the whole object wrapped under one of its own field names (`{"action": {"thought": ..., "action": ...}}`); the same-key unwrap rule now in `calls._salvage_once` (top level only) brings the total to 77 of 83 (93%); the replay reports 77 of 83.

### Whisper benchmark: LOCAL

`faster-whisper` int8 on the CPU (8 cores, no GPU), the 11 s public-domain JFK clip: about 7 s per clip with `large-v3-turbo` (shipped default), about 6 s with `medium`, about 3 s with `small` (measured when Dictate was built). A load without preload adds about 15 s to the first Dictate. In this pass both `whisper`-marked tests passed in 6.4 s and 5.9 s with `large-v3-turbo` from the local cache.

## Live provider, simulation agents (claude-cli-haiku, 2026-09-25): LIVE

Provider `claude_cli`, Claude Code CLI 2.1.282 using its own login, served model `claude-haiku-4-5-20251001` (recorded as `response_model` in every call). No API keys exist on this machine. Details, excerpts and commands: [evidence/live_sims.md](evidence/live_sims.md). The UI session is described in the reviewer 2 report summarised under Browser QA.

| Run | How | Code | Calls | Tokens in / out | Cost (USD) | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `live-smoke-6x1` (`run_20260925_175931_40bf`) | headless, 6 agents x 1 round | before the fixes | 6 | 36,107 / 3,082 | 0.0876 | 6 of 6 valid; 6 observes |
| `live-8x3` (`run_20260925_180307_779a`) | headless, 8 x 3 | before the fixes | 16 (15 saved, 1 failed) | 105,196 / 11,207 | 0.1334 | Halted in round 2: the adapter rejected a reply for which the CLI had re-prompted once. Fixed (A-COG-9) |
| `live-8x3-v2` (`run_20260925_181656_cf1a`) | headless, 8 x 3 | with a harmful prompt line | 24 | 142,539 / 6,497 | 0.1780 | 24 of 24 malformed: Haiku wrapped the decision in an `input` key. The line was removed |
| `live-8x3-v3` (`run_20260925_182033_8888`) | headless, 8 x 3 | with the fixes | 24 | 146,959 / 11,243 | 0.1425 | 22 of 24 valid; 22 actions, all ok |
| `review2 live haiku 183035` (`run_20260925_183039_9341`) | UI, 6 agents | backend before the fixes | 10 | 75,191 / 6,565 | 0.0730 | 2 replies rejected by the old re-prompt rule (USD 0.0251), then success |
| `live-final-6x1` (`run_20260925_203815_7924`) | headless, 6 x 1, seed 5 | **final source** | 6 | 35,036 / 1,636 | 0.0782 | 6 of 6 valid (observe 5, query self 1, all ok); billed/estimate 1.135; mean latency 4.2 s |
| `pytest -q -m live` (3 tests), two invocations + one re-run | pytest | **final source** | 7 | 27,737 / 1,464 | 0.0435 | First invocation 2 of 3 (one stochastic malformed Haiku reply in the decision-vs-estimate test); re-run of that test passed; second invocation 3 of 3 |
| Diagnostic replays of stored requests | CLI, outside runs | | 9 | | 0.046 | Used to find the causes above |
| **Total** | | | **102** | **568,765 / 41,694** (runs and tests) | **0.782** | |

What the live runs showed:

- **The whole decision loop works live:** packet, hardened CLI subprocess with `--json-schema`, envelope parsing (usage including cache tokens, cost, served model), format gate, world action, knowledge record, next packet.
- **Billing matches the estimate.** Billed input was 1.13–1.17x the packet estimate; the contract limit is 1.5x.
- **Cost and speed.** In `live-8x3-v3` (thinking off) a decision cost about USD 0.006, mean latency was 5.8 s (3.6–8.1 s), and cognition cost 1.4–2.0 compute. With thinking on (the smoke run) a decision cost about USD 0.015, and thinking took 40–70% of the output tokens.
- **The basic survival loop closes.** In `live-8x3-v3` all 8 agents observed the fruit on their start cell and absorbed it (8 of 8 ok, +12 compute each). There were also 5 `query(self)` actions and 1 `vision_range` upgrade.
- **Malformed replies are handled.** They are charged, the turn is lost, and the agent is told why in its next packet: 24 in v2, and 2 stochastic ones in v3 that replayed fine.
- **Infrastructure errors are handled.** In `live-8x3` the run entered `error` and kept the pending call record under `working/pending_model_calls/`. In the UI session, **Recover (pause)** re-ran the failed turn each time.
- **In the UI** (reviewer 2): "Waiting for model" appeared within 0.2 s, with the call id and a live timer. Pause during a call showed "Pause requested", then paused without an extra call. A voice to one agent reached only that agent's knowledge and next packet, with its source shown as unknown.
- **Three problems were found live and fixed:** the adapter rejected the CLI's single re-prompt (A-COG-9); extended thinking crowded out the output (A-COG-10, thinking now off by default); no fruit was reachable from the start cells (A-WORLD-7 plants at agent starts, A-PLANT-13 one ripe fruit per initial plant).
- **No secrets leaked.** A scan of every run folder and log for key patterns and credential variable names found nothing. On the final run, `grep -rniE 'api[_-]?key|sk-[a-z0-9]{8}|bearer '` over the run folder returns 0 hits.
- **The final source works live.** `live-final-6x1` produced 6 valid decisions and 6 successful actions. Records carry usage, cost and the served model, and every knowledge store and packet held only the agent's own records. Storage followed the new knowledge-file rule (one knowledge file per agent-turn dir), and the history API served the new `observed_entities` field. A decision cost about USD 0.013 here, against USD 0.006 in `live-8x3-v3`, because a one-round run has no prompt-cache reads.

Not shown live:

- Skills, `send` / `broadcast`, `recover`, `attack`, `transfer`, `wait` and deaths. No Haiku agent chose them in these short runs; they are covered by fake-model tests only.
- Accepting a CLI re-prompt (A-COG-9, the fix for `live-8x3`). The CLI did not re-prompt in `live-8x3-v3`, so this is covered by unit tests only.
- Multi-round live play on the final source: the final live run is one round. No live UI session has run on the final backend.
- The live test `test_live_claude_cli_decision_bills_near_packet_estimate` fails when Haiku returns a malformed reply (it happened once in 3 invocations); see LIMITATIONS.md.

## Provider adapters verified only with mocked payloads

The `anthropic`, `openai`, `fireworks`, `bedrock` and `foundry` adapters were verified only against mocked payloads, because no credentials for those providers exist on this machine. `backend/tests/test_model.py` covers request building, schema transforms, usage-normalisation goldens, and error, refusal and truncation classification for each of them. None of them has made a real call.

## Reproduce

From the repository root:

```bash
(cd backend && ../.venv/bin/pytest -q)                                  # MOCKED, about 1-2 min
.venv/bin/python scripts/check_docs.py                                  # docs check
(cd frontend && npx tsc -p tsconfig.app.json --noEmit && npm run lint && node src/state/state.test.mjs)
(cd backend && EMPYREAN_WHISPER_TEST_AUDIO=<jfk clip> ../.venv/bin/pytest -q -m whisper)   # LOCAL, needs the cached model
.venv/bin/python scripts/run_sim.py --model fake-heuristic --worlds-dir /tmp/w      # MOCKED
bash qa/resilience/run_all.sh     # MOCKED; own backend on :8020, about 3.5 min; overwrites qa/resilience/out/
                                  # RES_PORT / RES_WORLDS / RES_OUT / RES_LOG select another port and folders; expect 165 of 165
# browser check, all 37 steps on fake models (see qa/README.md)
.venv/bin/python qa/assistant_fake_server.py
(cd frontend && EMPYREAN_API_PROXY=http://127.0.0.1:8020 npx vite --port 5180 --strictPort)
(cd qa && BASE_URL=http://127.0.0.1:5180 API_URL=http://127.0.0.1:8020 node browser_check.mjs)
.venv/bin/python scripts/assistant_replay_malformed.py                  # LOCAL, no spend
EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/assistant_playtest.py chat --arm haiku --max-spend 3.5   # LIVE, about USD 2.5
EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/run_sim.py --model claude-cli-haiku --live-check   # LIVE, one paid call
(cd backend && env -u CLAUDECODE EMPYREAN_LIVE_TESTS=1 ../.venv/bin/pytest -q -m live)            # LIVE, 3 paid calls (about USD 0.017)
```

### Replay and terrain refinements — 2026-09-27

- Production build passes; frontend lint has 0 errors and the same 4 existing warnings; all 96 state tests pass, including updated visual attack cues and renamed assistant command labels.
- Simulation browser regression: **21 passed, 0 failed** with assistant steps disabled (`qa/out/2026-09-27_17-39-14/log.json`). This covers the renamed Start/Pause, single-turn and round controls on fake-model runs, history, inspection, staging, recovery, 2D marks and CPU 3D navigation. Timeline locators now explicitly select turn controls rather than confusing the new round selector with the turn selector.
- `qa/replay_refinement_check.mjs` uses SWEEP-B2v2 saved turns with Chromium GPU and WebGL disabled. It checks mouse-wheel zoom without page scroll, visible 2D cues, delayed loading, stop, inspector suspension, round and same-run route navigation, end-of-record history, repeated CPU 3D replay, reduced motion and mobile overflow. No simulation command requests are permitted by the check. Screenshots are written to `/tmp/empyrean-replay-check/`.
- Terrain and attack effects were also visually reviewed on SWEEP-B1v1: the 33×33 CPU board took approximately 4.4 ms per sampled frame; terrain detail adds no idle animation. Saved replay stretches only visual timing, never simulation timing.

### Board workspace correction — 2026-09-27

The run page now gives the map the full workspace width, with simulation controls in the top bar and a compact timeline below. Session/agents, inspector/tools and activity open as dismissible panels without resizing the map. The 2D initial camera fits the whole region.

Read-only Chromium review of SWEEP-B2v2, with GPU/WebGL disabled, measured the 3D viewport at 1328×473 on a 1366×768 window (previously 736×220), 1562×705 at 1600×1000, and 986×439 at 1024×768. The 390×844 phone layout keeps a roughly 366×418 board and scrolls for the remaining controls. Both views were checked at all four sizes, including opening/closing Session, God mode and Activity; utility panels did not change the board bounds and no page errors occurred.

The replay regression passes, including explicit board-size and unchanged-bounds assertions, wheel zoom, saved replay, loading/stop/end, inspector suspension and reduced motion. The simulation workflow checks passed controls, history, occupants, agent records, plant rules, God mode staging, resume and error recovery. The profile test was updated to wait for the selected checkpoint to load instead of asserting against the previous cached turn; its focused run passed (`qa/out/2026-09-27_17-52-21/log.json`). Browser selectors now open utility panels explicitly and use the compact timeline's history indicator.

Final focused map regression: **3 passed, 0 failed** (`qa/out/2026-09-27_17-54-49/log.json`), covering 2D marks and CPU 3D labels, selection, keyboard/pointer navigation, zoom, framing, history replay and switching views. The test now locates the 2D/3D switch in the top bar and opens/closes the inspector when using its Find control. Production build and docs consistency checks pass; lint retains the same four existing warnings.

### Side replay panel and continuous playback — 2026-09-27

History, round/turn selection and replay speed now occupy a collapsible left panel. The activity log opens on the right and resizes horizontally. The 3D view shows WASD, Space and Shift instructions in the replay panel and on the unfocused board. On narrow screens replay and utility panels take turns so their controls cannot cover each other.

The read-only recorded-run replay check passes with GPU/WebGL disabled: cross-round playback reaches the last saved turn, starting at the latest checkpoint replays from the beginning, and checkpoints appended through mocked browser index/status responses join the sequence without any simulation commands. Loading delays, manual stop/navigation, inspector suspension, repeated single-turn animation, reduced motion and mobile overflow checks also pass.

Responsive browser checks passed at 1366×768, 1600×1000, 1024×768 and 390×844 in both views. The 3D viewport measures 1104×567 at 1366×768 and 1338×799 at 1600×1000 with the left panel open, gaining approximately 94 pixels in height over the previous bottom timeline. Opening Session, Inspector/God mode or Activity leaves the board bounds unchanged. The log is on the right, fills the available height and its width changes correctly using the resize handle's arrow keys and resets on double-click. No page errors or horizontal overflow occurred.

Focused map regression: **3 passed, 0 failed** (`qa/out/2026-09-27_18-15-25/log.json`). Production build, all 96 state tests and documentation checks pass. Lint has zero errors and the same four existing warnings. Backend health is reachable through the running public tunnel.

### Replay from a chosen saved turn — 2026-09-28

`node qa/replay_refinement_check.mjs` passes on the recorded SWEEP run. It selects a past round and exact turn while the latest turn is on screen, then verifies playback starts there and advances to the next saved checkpoint. The existing loading, stop, inspector suspension, cross-round, beginning, appended-turn, single-turn animation, reduced-motion and mobile checks also pass. No simulation command requests were sent. Production build and frontend type check pass.

### Clone saved session setup — 2026-09-27

- Full backend suite: **716 passed, 4 skipped** in 137.14 s, including five new clone cases. These verify exact original settings after simulated progress and settings edits, all 16 agent cards, archived/closed sources, distinct new-world identity, a fresh initial checkpoint, unchanged source bytes, inherited setup for continuations, and missing/corrupt reference errors. Fake models only.
- `node qa/clone_setup_check.mjs`: passes the full Resume selection → Clone setup → edit → validate → create flow, multiple-selection disabling, all request fields, 16 cards, reload, archive access, missing-source error and assistant-draft isolation. Temporary fake-model sessions were removed; no simulation turns or paid calls were made.
- Read-only visual review on SWEEP-B2v2 confirms its 30 original cards, seed and limits load into the new form. The public tunnel serves the new setup endpoint. Backend and frontend remain running.
- Production build, all 96 frontend state tests and docs consistency pass; lint reports zero errors and four existing warnings. No existing simulation calculations or run-command behavior changed.

### Persona tip switch — 2026-09-28

- Full backend suite: **718 passed, 4 skipped** in 137.6 s, including the two new A-KNOW-9 cases (`test_context.py::test_persona_tip_follows_the_persona_when_on_and_is_absent_when_off`, `test_context.py::test_persona_tip_defaults_on_for_new_runs_and_off_for_stored_settings`) and the defaults assertion in `test_api.py::test_health_defaults_models_assumptions`.
- Docs consistency: clean. Frontend: `tsc` clean, lint zero errors (the four existing warnings), all 96 state tests pass, production build passes.
- Browser check on fake models (`qa/assistant_fake_server.py` + Vite on :5180): **28 passed, 9 failed** (`qa/out/2026-09-28_00-01-39/log.json`). Step 3 `new-session-cards` passes and records `persona_tip_default_on: true`. None of the nine failures involves this change; they predate it. Eight assistant and record-viewer steps look for the launcher and tabs inside `.run-rail` and the tab row, which the board-layout commits (`1806485`, `479150b`) moved into panels that open over the board. `assistant-preflight` still expects automatic storybook narration on for all-fake runs, which has been off by default since `0584ebd` (A-AST-3, `EMPYREAN_STORYBOOK_AUTO`). Those steps need their locators and expectation updated separately.

### Run pinning and renaming — 2026-09-28

- Full backend suite: **720 passed, 4 skipped** in 135.31 s. The new route and real-storage tests cover trimmed-name validation, pin ordering, persistence through open/close and archive/restore, unchanged original setup and manifest, and missing-run errors. The in-memory runner test store was updated for the new metadata read; its 54 tests pass.
- Frontend: 97 state tests and type check pass. The production build passes; lint has zero errors and the same four existing warnings.
- `QA_ONLY_RESUME_ARCHIVE=1 node qa/browser_check.mjs`: **2 passed, 0 failed** (`qa/out/2026-09-28_05-39-13/log.json`). The flow renames a selected run, pins it to the first row, refreshes, unpins it, then pins and unpins a selected group before the existing archive/delete checks. Public trycloudflare inspection confirmed a pinned run appears as the first row with its badge and the new actions are in the selected-runs toolbar.
