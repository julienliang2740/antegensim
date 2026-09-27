# Limitations and known issues

State of the prototype on 2026-09-25, after the final fix pass (reload ordering, agent view and the UI display fixes) and its final verification, plus the assistant release of 2026-09-26 and its verification pass (section "The assistant": the playtest, browser QA and replay measurements of 2026-09-26), and the map changes of 2026-09-26 (the 2D map's equal dots, count badges and action marks, and the 3D view; section "Minor (UI): the 2D map and the 3D view"). Each item ends with a suggested next step. Severity follows the QA reports: **major** means an operator can get a wrong result without being told; **minor** means it is inconvenient or incomplete, not wrong.

Evidence for the items below is in [TEST_EVIDENCE.md](TEST_EVIDENCE.md) and in `docs/evidence/`.

## Known defects

### Major

None open. The one found by the browser re-test (a `working/` reload undid UI god-mode edits staged before it for the same turn) is fixed: a reload is now applied as a field-by-field diff onto the state at its turn in staging order (A-GOD-1), a field both edited keeps the later-staged value, and a file change that can no longer apply fails the whole file edit with the reason. Verified by `backend/tests/test_e2e_godmode.py` (both staging orders and the conflict case) and independently over HTTP by `qa/resilience/l_reload_order.py` (8 of 8 checks, see `docs/evidence/resilience.md`).

### Minor (backend)

- **Reload problems come in two rounds.** Semantic checks (`validate_world`) run only after every working file parses, so a broken JSON file hides other problems until it is fixed. The error list now says so in its last line (`working/: fix the JSON errors above first; semantic checks run once every file parses`), and each problem names its working file.
  - *Next step:* run the semantic checks on the files that did parse and report both lists in one response.
- **The manifest's `real_usage` lags a billed but failed call.** A call that failed after the provider billed it is added to the ledger only in the commit that carries its record. If a run is abandoned in the error state, its manifest under-reports by exactly the records still in `working/pending_model_calls/`. The live status (`RunStatus.real_usage`) includes them. This is documented, not fixed.
  - *Next step:* add pending records to `real_usage` when a run is listed or summarised, or write them to the ledger at the moment of failure with a flag.
- **Deleting a run leaves assistant conversations about it.** Conversations live under `worlds/_assistant/` and keep the deleted run's id; opening one still shows its transcript, but a new message there fails with "run … not found". The global assistant ledger keeps the run's lines; the per-run ledger goes with the run folder. Deleting is refused only while the run is open or has a story, storybook or sequencer job.
  - *Next step:* offer to delete or rebind (to the global scope) the run's conversations in the delete dialog.
- **The prompt is stored three times per turn.** The model call record keeps `request.messages` (and `request.metadata.situation`), and the decision packet keeps the same messages plus the same text split into sections. That is about 26 KB of duplicate data per agent turn.
  - *Next step:* when a call has a `packet_id` and identical messages, store a reference to the packet instead of a copy.
- **One live test fails whenever Haiku slips.** `test_live_claude_cli_decision_bills_near_packet_estimate` asserts `status == "ok"` with `max_retries=0`, so a stochastic malformed reply fails it. On the final source its first invocation failed that way (2 of 3 passed); the immediate re-run and a second full invocation passed (3 of 3). Live runs show about 2 malformed replies in 24.
  - *Next step:* let the test retry once on `malformed`, or check the billing ratio on any agent-output status (usage is reported either way).

### Minor (UI)

From the browser re-test of the final code (`docs/evidence/browser_qa.md` §4, pass 2), plus the lint result:

- **Agent view works only at the agent's own cell.** A map click away from the selected agent's true position (or on a sighting row) clears the selection, so the map and occupant list turn omniscient again (with an honest warning). The "Known at (x, y)" list therefore cannot be opened for any other cell, including the agent's believed cell when it differs; other cells show only in the hover tooltip (at most 8 rows).
  - *Next step:* keep the agent-view subject separate from the selected entity, so any cell can be listed from the agent's sightings.
- **The status bar changes height at every round boundary.** The full next-round order wraps onto a second line while the next step is "start round N" (173 → 191 px at 1440x900, 173 → 208 px at 1100x750), so the tabs, map and inspector jump during Play.
  - *Next step:* reserve the second line, or show the order in a fixed-height row with a tooltip.
- **A species-rule edit record does not show which field changed.** An `update_plant_rules` record has one line, `world.rules.plant_species.<name>`, with before and after as cut JSON previews; finding `fruit_energy 60 → 70` means expanding and comparing two ~1,300-character blocks.
  - *Next step:* record field-level changes for species edits, as `diff_working` does for file edits.
- **Runs saved before the final fix pass lack the new cost fields.** Their turn-record call buttons and failed-call log lines show no reasoning tokens, USD cost or "provider billed" note. The full model call record still shows both.
  - *Next step:* fall back to the model call record when a stored event or index lacks the fields, or accept this for old runs.
- **Frontend lint: 0 errors, 4 warnings after the assistant fix pass (2026-09-26).** 1 `react(set-state-in-effect)` in `RunPage.tsx:202` (the same effect, moved by the map view switch); 3 `react(only-export-components)`: `inspect/common.tsx:38` and `InstructionsPage.tsx:26,31`. The six `AssistantDrawer.tsx` warnings present at `bd240df` were removed by restructuring, not by suppress comments. None changes behaviour today; a state set in an effect costs an extra render and can hide an ordering bug. The two `react(refs)` warnings of `MapView.tsx` from before the release no longer appear.
  - *Next step:* derive the drawer's state during render or set it from the event that changes it; move the non-component exports into their own modules.

### Minor (UI): the 2D map and the 3D view

From the build and browser checks of the map changes (2026-09-26; `docs/TEST_EVIDENCE.md`, "2D map fixes and the 3D view"):

- **The profile card covers the whole board below 1440 px width.** The card is centred at 94 % of the window width (at most 1120 px) and 86 % of its height, so in a 900 px tall window the board shows beside it only when the map toolbar fits on one row (from about 1440 px wide: the map starts 22 px above the card). At 1400 px and below the toolbar takes two rows and the card covers every map cell; the dimmed page around the card stays visible. This was already so before the map changes; an earlier build that put the **Map view** switch in a row of its own above the map made it happen at 1440 px too (browser step 35 caught it), so the switch now sits at the end of the legend's controls row.
  - *Next step:* if the board must stay visible at every width, anchor the card beside the map column instead of centring it.
- **Marks and animations show one turn.** The 2D action marks, the 3D chips and animations come from the viewed turn only (live: the last saved turn). With Play at `play_delay_seconds` 0 several turns can commit between two live refreshes, and only the last one's marks show and animate; the activity log and the Turn record have every action, and browsing history shows every turn's marks. Agent view keeps only the viewer's own badge and arrow, at its believed position.
  - *Next step:* a "since the last refresh" summary of skipped turns.
- **Crowded cells in 2D.** A cell with more occupants than fit (at most 322 dots at the largest zoom, 340 px; 18 at 44 px; 6 at 24 px, beside the badge) shows as many dots as fit and the total in its count badge; the badge's tooltip lists everyone. In a packed cell the rings of a busy round end overlap (at 44 px a ring is wider than the dot spacing); zoom in. Names show under a lone dot from 36 px cells and under a single row from 160 px, otherwise only in the tooltip. The broadcast reach assumes the Manhattan range `world.py` uses. Up to 60 marks are drawn per turn (the caption says "+N marks not drawn").
  - *Next step:* none planned; zoom in or use the tooltip.
- **3D performance is measured only with software rendering.** This machine has no GPU: headless Chromium draws WebGL 2 with SwiftShader (`data-software="1"` on `.map3d`). `data-frame-ms` is the CPU time of a frame (0.4-1.1 ms on the QA runs; about 25-30 ms for the first frame and after a colour-scheme change), not the GPU time. The view renders on demand, caps the pixel ratio at 1.5 and drops it to 1 after ten frames slower than 45 ms. It needs WebGL 2; without it the column shows a fallback with **Back to 2D map**.
  - *Next step:* measure on a machine with a GPU and in Firefox and WebKit.
- **3D labels drop out in a crowd.** Labels name living agents (plus the hovered or selected entity). Labels, chips and badges never overlap, so a crowded label first shows only its id and then is left out until the camera moves: at the frame pose the 12-agent arena run showed 11 of 12 labels and a 21 x 21 run with its 8 agents in one area 0-1 of 8 (the QA run: 4 of 8). Beyond 30 units a label shows only the id, beyond 60 units none, and at most 40 labels, badges, chips and floating numbers are drawn per frame. World-event chips outrank agent names. Hover or select an agent to see its label; count badges start at 5 occupants (2 in the far column view).
  - *Next step:* a list of the agents whose labels are hidden, or a key that shows every label for a moment.
- **3D gaps against the 2D map.** One layer only: the layer stack (**Layer up** / **Layer down**, PageUp / PageDown) is exercised only by the dev harness (`?harness=1&view=3d&layers=2`). Removed-entity markers (∅n) are not drawn (the tooltip lists them). Absorb and transfer particles have one colour for every resource. The legend's kind toggles are stored with the 2D legend's but not shared live: a change in one view shows in the other when it next opens. The canvas has no DOM semantics; the labels, status lines, tooltip and Inspector are the accessible surface. Touch (one-finger look, two-finger pan and pinch) is implemented but untested. The 2D map keeps its zoom while hidden; the 3D camera pose is remembered per region while the page lives, so two runs with the same region share it. Selecting an entity re-packs its cell (the acting and selected entities take the first slots).
  - *Next step:* draw removed-entity markers and per-resource particles (needs a `resource` field on the turn effects); test touch on a device.

Fixed in the final fix pass and confirmed by the browser pass (`browser_qa.md` §1): the next-round order is shown in full; agent view draws the map and occupant list only from the agent's sightings (see the caveat above); the map tooltip is rendered beside the hovered cell, fully inside the window; the occupant list grows to 600 px and shows "N occupants — scroll for more"; action data has a Show/Hide full JSON control; Set stat shows `199.796` with "stored exactly as …" and has a 220 px input. `qa/browser_check.mjs` passed 17 of 17 with no console or page errors on the final code (`qa/out/2026-09-25_20-43-52/`).

## Storage growth

Storage per turn still grows with the length of the run. Since the fix pass a turn folder holds a knowledge file only for agents whose knowledge changed, but the acting agent's own file is written in full each time, and knowledge is never pruned. Measured with 8 fake agents, seed 1, on the final source (`qa/resilience/j_storage.py`): the mean agent-turn folder is 107 KB at round 1, 120 KB at round 4 and 147 KB at round 8 (before the fix it was 128, 188 and 309 KB); each agent-turn folder now holds exactly one knowledge file (the actor's) and a round-end folder none. A linear fit extrapolates to about 31 GB for a 1000-round, 8-agent run (about 125 GB before). The prompt is also stored three times per turn (see above).

- *Next step:* keep each agent's knowledge records once, in an append-only per-agent log at run level, and store only a pointer or delta per turn. Deduplicate the prompt copies.

Disk used by QA so far: `qa/resilience/worlds` holds about 516 MB (runs on the pre-fix storage), `qa/resilience/worlds-final` about 115 MB (the final suite's runs), and `worlds/` about 93 MB of review and live runs.

- *Next step:* delete the QA run folders once the evidence has been reviewed.

## Runs with many agents

The agent limit is 64 (`config.MAX_AGENTS`, raised from 12 on 2026-09-27). Only a short fake-model run has used more than 12 agents: 64 agents for 3 rounds ran in about 10 s per round of engine time and wrote about 200 KB per turn (39 MB for 197 turns). Live runs store far more because knowledge grows over the run: the 12-agent, 98-round live "Blood arena" run takes 1.5 GB (about 2.9 MB per turn), so a 100-round live run with 64 agents (about 6,500 turns) could need tens of GB of disk. Every living agent that is not running a skill makes one model call per round, so a 64-agent round costs about five times a 12-agent round in money and time (about 5-8 s per Haiku call, taken one after another), and storage grows with the number of agents whose knowledge changes each turn. The run page's roster, the map and the default 21 × 21 region were designed around a dozen agents; with 64 the default start positions reach Manhattan radius 6 around the origin.

The assistant's create-run brief writes its overlay within the chat output allowance (6000 tokens, `config.ASSISTANT_OUTPUT_TOKENS`), sized for about a dozen cards; a brief that writes a custom persona for each of many more agents can run out and fail.

- *Next step:* a 64-agent fake-model run to measure turn time and storage, then a short live run; consider a larger default region for big casts; let briefs describe card patterns instead of writing every card.

## Provider adapters verified only with mocked payloads

Only two adapters have run for real on this machine: `fake` and `claude_cli` (`claude-cli-haiku`). The `anthropic`, `openai`, `fireworks`, `bedrock` and `foundry` adapters are covered only by unit tests against recorded or mocked payloads (request shape, usage normalisation, error classification), because no credentials exist here. Their real request acceptance, schema handling, usage and cost reporting, retries and rate limits are unproven.

- *Next step:* for each provider, set its credentials and run `EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/run_sim.py --model KEY --live-check`, then `EMPYREAN_LIVE_TESTS=1 EMPYREAN_LIVE_MODELS=KEY pytest -m live`, and check billed input stays within 1.5x the packet estimate.

Related live-only gaps:

- **Live coverage of the final code is short.** On the final source there is one headless live run (`live-final-6x1`: 6 agents, 1 round, 6 valid decisions, USD 0.078) and the 3 live pytest tests (USD 0.044); see `docs/evidence/live_sims.md`. Multi-round live play with thinking off was shown only by `live-8x3-v3`, before the fix pass. The CLI has not re-prompted in any run since the fix, so accepting a re-prompt (A-COG-9) is covered by unit tests only. The UI live review ran on the older backend.
  - *Next step:* one short live UI session (6 agents, 1–2 rounds, budget under USD 0.20) on the current backend.
- **The `claude_cli` route has quirks.** The CLI cannot force the StructuredOutput tool, so it sometimes re-prompts once; up to 2 model requests are accepted and billed in full (A-COG-9). Extended thinking is off by default (`MAX_THINKING_TOKENS=0`, A-COG-10). About 2 in 24 Haiku replies were malformed with thinking off; the sample is too small to compare with thinking on.
  - *Next step:* collect a larger sample (for example 100 decisions) with thinking on and off before choosing the default.
- **The headless driver has no overall budget.** `scripts/run_sim.py` sets no `real_budget_usd`; the only cap in a live headless run is the per-call `max_budget_usd` of the `claude_cli` registry entries.
  - *Next step:* add a `--budget-usd` option that sets `real_budget_usd` on the run.
- **The 3 live pytest tests have run only for `claude-cli-haiku`.** On the final source: 2 of 3, then 3 of 3 (see the flaky-test item above). No other provider has credentials here.
  - *Next step:* run them for each provider alongside the per-provider live checks.

- **Retried calls now bill every attempt (rev 4).** `provider_cost_usd` of a model call is the sum over all attempts that reported a cost (before, only the last attempt counted). A retried or failed-then-retried CLI call therefore charges `Manifest.real_usage` and `real_budget_usd` for every billed attempt; old runs keep their under-reported totals.
  - *Next step:* none; this is the correct accounting. Compare budgets of old and new runs with this in mind.

## The assistant

The built-in assistant (`docs/ASSISTANT.md`) and its measured limits. The numbers come from the
verification pass of 2026-09-26: the ground-truthed playtest (`docs/evidence/assistant_playtest.md`,
Claude Code CLI 2.1.283, USD 10.93), the browser QA (`docs/evidence/browser_qa_assistant.md`) and the
offline replay of stored malformed replies.

### Models and answers

- **It depends on the Claude Code CLI.** Every default assistant model runs through the `claude` CLI (Sonnet for chat and Story Mode, Haiku for the storybook and summaries). Without the CLI, or when it is not logged in, the drawer only answers from docs search ("Docs search (AI offline)") and briefs, storybook and Story Mode are unavailable. Other providers can be configured per profile (`EMPYREAN_ASSISTANT_MODEL_*`) but are untested for the assistant.
  - *Next step:* run the assistant playtest against an API provider once credentials exist.
- **Thinking is off for every CLI call, and that is the untested variable.** The playtest ran with `config.CLI_MAX_THINKING_TOKENS = 0` (the shipped default for every `claude_cli` call, A-COG-10). Sonnet's two wrong alive counts stated a wrong number first and corrected themselves inside the same answer, which is what a small thinking budget usually prevents; no arm ran with thinking on.
  - *Next step:* re-run `scripts/assistant_playtest.py chat --arm sonnet` with a small thinking budget for chat steps before promoting Sonnet for analysis.
- **One chat model key serves help, run analysis, log interpretation and briefs.** On the measured questions Haiku matched Sonnet (help 8/8 each; run analysis 58/60 each) at p50 6.3 s vs 11.3 s and about a third of the cost (USD 0.031 vs 0.089 per question), but Sonnet was better at briefs (5/6 vs 4/6; it produced the only valid arena overlay). The shipped default stays `claude-cli-sonnet-assistant` for the whole chat profile, so plain questions pay Sonnet prices.
  - *Next step:* a chat sub-profile for answers on Haiku with briefs on Sonnet is the measured cheaper option; it is not implemented.
- **Log-interpretation counting is the weakest chat category.** "How many turns were lost to malformed replies in rounds A-B" first scored 8/12 (Haiku) and 7/12 (Sonnet) because `search_events` output was capped at 6,000 characters and reported only "capped". Fixed: `search_events` returns `total_matches` / `counts_by_round` over the whole range and takes `from_round` / `to_round` (an uncommitted turn id is now an error instead of silently widening the range), and the chat rules point at the round digest's `counts.lost_turns`. Re-measured on Haiku: 10/12 (one arithmetic slip over correct per-round data, one CLI adapter error "made 4 model requests; at most 3 allowed"); Sonnet was not re-measured. Still under the 90% gate on n = 12, so check counts over long ranges against the Turn record.
  - *Next step:* after the fix, re-run the `malformed_count` category (`chat --categories malformed_count`).
- **The narrator can still state a plan as a fact.** Invented survivor names are fixed (the round-end digest now carries names and every narrator call gets a cast list; the regenerated 13 Haiku entries name the real survivors), but a manual read found one entry saying Eos "absorbed" the residue when the digest only had that as her stated plan. The automated faithfulness check does not catch this class; the Turn record has the facts. Entries written before the fix keep their invented names; the storybook is narrative and is not rewritten.
  - *Next step:* after the fix, press **Regenerate** on affected entries (round-end entries first) and re-check the playtest entries with `scripts/assistant_playtest.py recheck`.
- **Brief repair is one step and cannot fix every overlay.** Every tier first proposed `field: "health"` for "Set Eos's health to 5"; the chat rules now name the dotted paths (`stats.health`) and the brief validated on the first try on Sonnet and Haiku in the recheck. A brief whose typed action has fixable validation problems now gets one repair step, but Haiku's create-run overlay for an arena "vibe" still invented `plant_species` keys after that step; Sonnet (the default) produced a valid overlay by calling `get_defaults` first. An unapprovable card needs an "Ask for changes" round trip.
- **Summaries were not exercised.** No playtest conversation passed the 3k-token memory budget and three chapters do not reach the five-chapter story-so-far refresh, so the summarizer profile (Haiku) is an initial choice with no measurement behind it.
  - *Next step:* a long conversation and a long story in the next playtest.
- **Answers are model output.** The assistant reads the run's records through tools and stamps "as of turn <id>", but it can still misread them. Agent thoughts are beliefs; the Turn record, events and model-call records are the facts. Storybook entries and Story Mode chapters are narrative and may embellish (the story brief lists what stays faithful).
  - *Next step:* check a surprising answer against the linked turn.
- **Spend figures are list-price estimates.** The CLI reports a cost per call; when it does not, the ledger estimates from tokens with a price table (`config.ASSISTANT_PRICES`, keyed by the served model). Subscription or discounted pricing is not modelled. Assistant spend is never part of `real_usage` or `real_budget_usd`. The ledger records a call's status before salvage, so a reply the CLI rejected but the engine recovered shows as `malformed` in `usage.jsonl` while the conversation shows the step as `ok`.
  - *Next step:* none for billing; count format failures from the conversation steps, not the ledger.
- **Latency (measured).** A message is one to four CLI steps of several seconds each (90 s cap). Haiku answered in p50 6.3 s / p90 9.2 s, Sonnet in p50 11.3 s / p90 22.5 s (Sonnet log questions p90 37 s); a create-run brief with a `get_defaults` step took 20-37 s. The drawer's elapsed counter ticks client-side and the backend refreshes the job's elapsed time every second during a model call. Answers are not streamed.
- **Cancellation stops after the current step.** Stop kills a running CLI call (`cancelled`), but a call already answered is billed.

### Storybook, Story Mode and Dictate

- **Storybook catch-up is manual and serial.** History is narrated only on "Write missing"; one narration job runs per run and background narration yields to agents' CLI calls. Measured: Haiku USD 0.0011 per entry, Sonnet USD 0.0039, with up to 9 turns in one batched call.
  - *Next step:* none planned; the estimate is shown before it starts.
- **A continuation starts with an empty storybook.** Continuations do not copy the parent run's `assistant/` folder; the continuation's opening entry recalls the parent, and earlier entries stay in the parent run only.
  - *Next step:* offer to copy (or link) the parent's entries up to the fork turn.
- **Story Mode writes chapters sequentially.** Chapters are generated 3 ahead of the reader (or all with "Generate all"); one story job runs at a time and others queue. A 285-turn run is about 285 chapters at one per turn; per-round chapters are one click away. The step-0 card's per-turn estimate counts agent turns only (9), while the brief plans the opening and the round end too (11).
- **Dictate needs a secure context, CPU time and, without preload, a slow first use.** The browser gives microphone access only on a secure origin (`localhost`, `127.0.0.1` or HTTPS), so opening the UI by the machine's IP address disables Dictate with its reason. Transcription runs on the CPU (no GPU here): an 11 s clip takes about 7 s with `large-v3-turbo` (shipped default), about 6 s with `medium` and about 3 s with `small` on 8 cores. One transcription runs at a time and at most 60 s of audio is accepted; the model needs about 1.6 GB of disk. With `EMPYREAN_WHISPER_PRELOAD=0` the model loads on the first Dictate, which then takes about 16 s longer.
  - *Next step:* `EMPYREAN_WHISPER_MODEL=small` on slow machines; keep the preload on for daily use.

### Storage, tests and QA hooks

- **Assistant folders grow without pruning.** Conversations (`worlds/_assistant/conversations/`), per-run ledgers (`assistant/usage.jsonl`, about 0.7 KB per call) and storybook entries (about 0.7-1.3 KB each) are kept until deleted. Measured in the playtest worlds: 86 short conversations used 293 KB of data (1.1 MB on disk), and one run's 78-call ledger 55 KB. Small next to the run folders themselves, but nothing expires; conversations can be deleted one at a time.
  - *Next step:* an age-based cleanup of conversations and a size line in the spend popover.
- **The frontend has no React component tests.** The drawer, brief card, Storybook tab and Story Mode are covered by the pure-logic tests (`src/state/state.test.mjs`, 96 tests on 2026-09-26) and by the browser check (`qa/browser_check.mjs` steps 18-33; the maps by steps 36 and 37), not by component tests; lint reports 4 warnings (see "Minor (UI)").
  - *Next step:* add component tests for the brief card and the drawer's approve path.
- **The browser check needs a QA-only server to reach brief cards.** The fake chat model answers from `AssistantService.fake_metadata`, which the served app does not expose; `qa/assistant_fake_server.py` adds `GET/PUT /api/_qa/fake_metadata` and refuses to start unless every assistant profile is fake. Never point it at real data. Against the primary (live) backend the browser check skips the 8 steps that would call a model.
- **Prompt injection is mitigated, not impossible.** Agent-written text reaches the assistant only inside nonce-fenced data blocks and the model can never execute anything itself (every change is an approved, server-validated brief), but a misleading agent message could still colour an answer.
- **Conversations are local and unshared.** They live under `worlds/_assistant/`; there is no memory across conversations and no multi-user access.
- **The docs are its knowledge.** A stale doc produces a stale answer. `scripts/check_docs.py` catches structural drift (paths, symbols, routes, variables, labels, assumption ids, test ids) but not a wrong sentence.
  - *Next step:* follow the docs rule in `CLAUDE.md`.

## Calibration questions still open

The design's "Open decisions and next experiments" are not settled. The defaults are in `docs/ASSUMPTIONS.md` and can all be changed through configuration.

| Question (design priority) | What is known | Next step |
| --- | --- | --- |
| Are cognition and action costs comparable? (1) | Live, one Haiku decision cost 1.4–2.0 compute, about the price of one cheap action (observe 1, absorb 3, move 5) | Record cognition vs action spend over longer live runs and tune `rules.cognition.*` |
| Do low absorption yields support survival? (1) | Live reading: a stationary agent on its own plant spends about 2.7 compute per round (cognition + upkeep) plus fees, and gains about 9 net per 5 rounds from one fruit at 0.2 absorption. The default economy is slightly negative even without exploring | Run 20+ round live sessions and adjust `fruit_energy`, `fruit_interval_rounds` or `compute_absorption` |
| How much residue survives death? (1) | Defaults 0.4 of essence and 0.5 of compute (A-DEATH-1/2). Live deaths so far used a run that set both to 1.0 (the Haiku "Blood arena" run of 2026-09-27: 12 deaths, 11 by attack, bodies looted by skills) | Observe deaths under the default fractions in long runs, then fix them |
| Is the provisional plant-damage rule acceptable? (1) | Attacks reduce plant essence (A-PLANT-5); only fake-tested | Scripted attack scenarios, then a live run with conflict |
| How severe is first-strike dominance? (1) | Before the damage cap it was total: in the live "Blood arena" run (12 Haiku agents, no food, attack 2, health 120) all 13 landed attacks killed with one blow and no victim ever acted between hits. The attack cap (A-ACT-19, 50 damage per attack by default) now forces at least two hits on a fresh 100-health agent; it has only been tested with fake models | A live run with the cap: measure hits per kill and how often victims flee, recover or strike back |
| What are the minimal seed and germination actions? (1) | Seeds drop and germinate automatically; agents have no planting action | Specify the actions before claiming cultivation |
| Are upgrades affordable and diverse enough? (2) | Live agents bought only `vision_range` (25 compute + 2 essence) | Review the price schedule after longer runs |
| How much data about other agents is public? (2) | Public fields are fixed in A-ACT-5 | Review with the query schema |
| How should the world be generated? (later) | Seeded clusters; first plants on agent start cells, each with one ripe fruit (A-WORLD-7, A-PLANT-13) | Decide map seeding and placement |

Behaviour exercised by live Haiku runs since (2026-09-26/27, 100-round runs): `save_skills` / `run_skill` (every agent in the "Scarce frontier" run saved at least one skill; in the "Blood arena" run 309 of 439 turns ran inside skills), `move`, `attack` and deaths (11 kills), `absorb` of residue, `upgrade` and starvation. Still not exercised live: `send` / `broadcast` (no agent messaged in either run), `transfer`, `recover` and `wait`, and the attack damage cap (added after those runs). Long-run plant ecology has run live only in the food runs.

- *Next step:* live scenarios that make messaging pay (squads, a communication range wider than the spawn spacing) and a live run with the attack cap.

## Deliberately not implemented

As listed in `docs/ASSUMPTIONS.md`: construction, persistent networks, fields, an agent birth action, mountain crossing, price modification, leaves with a function, natural plant spawning beyond seeds, embedding-based memory retrieval, mid-turn checkpoints, an `events` variable inside skills, and terrain occlusion. The Mortal Realm is out of scope.

- *Next step:* none for this prototype; revisit after the survival loop is calibrated.

## Browser support

The UI was tested only in Chromium (Playwright, headless) at 1440x900 and 1100x750, and the assistant steps also at 1200, 1280 and 1920 px wide. Firefox, Safari, Edge, small screens and touch input have not been tried. The layout assumes a desktop window; the wide inspector turns on at 1360 px and above. The frontend has node unit tests for its pure state modules (`src/state/state.test.mjs`, 96 tests) and no component tests. The 3D view was checked only with software WebGL 2 (SwiftShader) in headless Chromium. Clarity (U14) was judged by people from screenshots, not by assertions.

- *Next step:* run `qa/browser_check.mjs` in Firefox and WebKit (Playwright supports both), and state a minimum window size in the UI.

## Single operator, local only

This is a local, single-operator prototype, as the spec asks.

- The backend binds to `127.0.0.1` and has no authentication or user accounts. Anyone who can reach the port can create, run, read and edit runs, and spend the assistant's budget.
- One process can have a run open at a time (a file lock). There is no shared or multi-user editing.
- CORS allows only the local Vite ports (5173, 5174).
- Runs are plain files on the local disk. There is no database, no backup and no migration between schema versions.
- The resilience harness (`qa/resilience/rlib.py`, `qa/resilience/run_all.sh`) hard-codes the checkout path `/home/ubuntu/antegensim`.
  - *Next step:* derive the root from the script location.
- After a crash, event sequence numbers after the last saved turn can be reused. This is by design: the saved history never repeats a number, and `feed_epoch` changes so the UI resets its feed.
- *Next step:* before exposing the backend beyond localhost, add authentication and HTTPS, and decide how several operators would share a run.
