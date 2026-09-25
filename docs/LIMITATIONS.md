# Limitations and known issues

State of the prototype on 2026-09-25, after the final fix pass (reload ordering, agent view and the UI display fixes) and its final verification. Each item ends with a suggested next step. Severity follows the QA reports: **major** means an operator can get a wrong result without being told; **minor** means it is inconvenient or incomplete, not wrong.

Evidence for the items below is in [TEST_EVIDENCE.md](TEST_EVIDENCE.md) and in `docs/evidence/`.

## Known defects

### Major

None open. The one found by the browser re-test (a `working/` reload undid UI god-mode edits staged before it for the same turn) is fixed: a reload is now applied as a field-by-field diff onto the state at its turn in staging order (A-GOD-1), a field both edited keeps the later-staged value, and a file change that can no longer apply fails the whole file edit with the reason. Verified by `backend/tests/test_e2e_godmode.py` (both staging orders and the conflict case) and independently over HTTP by `qa/resilience/l_reload_order.py` (8 of 8 checks, see `docs/evidence/resilience.md`).

### Minor (backend)

- **Reload problems come in two rounds.** Semantic checks (`validate_world`) run only after every working file parses, so a broken JSON file hides other problems until it is fixed. The error list now says so in its last line (`working/: fix the JSON errors above first; semantic checks run once every file parses`), and each problem names its working file.
  - *Next step:* run the semantic checks on the files that did parse and report both lists in one response.
- **The manifest's `real_usage` lags a billed but failed call.** A call that failed after the provider billed it is added to the ledger only in the commit that carries its record. If a run is abandoned in the error state, its manifest under-reports by exactly the records still in `working/pending_model_calls/`. The live status (`RunStatus.real_usage`) includes them. This is documented, not fixed.
  - *Next step:* add pending records to `real_usage` when a run is listed or summarised, or write them to the ledger at the moment of failure with a flag.
- **The prompt is stored three times per turn.** The model call record keeps `request.messages` (and `request.metadata.situation`), and the decision packet keeps the same messages plus the same text split into sections. That is about 26 KB of duplicate data per agent turn.
  - *Next step:* when a call has a `packet_id` and identical messages, store a reference to the packet instead of a copy.
- **A rejected CLI structured reply gives a generic reason.** The `claude_cli` adapter uses `--output-format json`, whose envelope does not include the validator's message, so the record says only "structured output did not match the decision schema".
  - *Next step:* switch to `--output-format stream-json` (already used for diagnostic replays) and keep the validator's message in `attempt_errors`.
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
- **Frontend lint has 4 warnings (0 errors).** One `react(only-export-components)` in `inspect/common.tsx:38`, two `react(refs)` in `MapView.tsx:490`, where the portal tooltip reads `svgRect.current` during render (placement is correct because each hover change re-renders the tooltip, but a layout change without a hover change could leave it stale until the next mouse move), and one `react(set-state-in-effect)` in `RunPage.tsx:137`. The two `react(jsx-key)` warnings were fixed by the lead.
  - *Next step:* keep the SVG rect in state (set on hover, scroll and resize) and give the row fragments keys.

Fixed in the final fix pass and confirmed by the browser pass (`browser_qa.md` §1): the next-round order is shown in full; agent view draws the map and occupant list only from the agent's sightings (see the caveat above); the map tooltip is rendered beside the hovered cell, fully inside the window; the occupant list grows to 600 px and shows "N occupants — scroll for more"; action data has a Show/Hide full JSON control; Set stat shows `199.796` with "stored exactly as …" and has a 220 px input. `qa/browser_check.mjs` passed 17 of 17 with no console or page errors on the final code (`qa/out/2026-09-25_20-43-52/`).

## Storage growth

Storage per turn still grows with the length of the run. Since the fix pass a turn folder holds a knowledge file only for agents whose knowledge changed, but the acting agent's own file is written in full each time, and knowledge is never pruned. Measured with 8 fake agents, seed 1, on the final source (`qa/resilience/j_storage.py`): the mean agent-turn folder is 107 KB at round 1, 120 KB at round 4 and 147 KB at round 8 (before the fix it was 128, 188 and 309 KB); each agent-turn folder now holds exactly one knowledge file (the actor's) and a round-end folder none. A linear fit extrapolates to about 31 GB for a 1000-round, 8-agent run (about 125 GB before). The prompt is also stored three times per turn (see above).

- *Next step:* keep each agent's knowledge records once, in an append-only per-agent log at run level, and store only a pointer or delta per turn. Deduplicate the prompt copies.

Disk used by QA so far: `qa/resilience/worlds` holds about 516 MB (runs on the pre-fix storage), `qa/resilience/worlds-final` about 115 MB (the final suite's runs), and `worlds/` about 93 MB of review and live runs.

- *Next step:* delete the QA run folders once the evidence has been reviewed.

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

## Calibration questions still open

The design's "Open decisions and next experiments" are not settled. The defaults are in `docs/ASSUMPTIONS.md` and can all be changed through configuration.

| Question (design priority) | What is known | Next step |
| --- | --- | --- |
| Are cognition and action costs comparable? (1) | Live, one Haiku decision cost 1.4–2.0 compute, about the price of one cheap action (observe 1, absorb 3, move 5) | Record cognition vs action spend over longer live runs and tune `rules.cognition.*` |
| Do low absorption yields support survival? (1) | Live reading: a stationary agent on its own plant spends about 2.7 compute per round (cognition + upkeep) plus fees, and gains about 9 net per 5 rounds from one fruit at 0.2 absorption. The default economy is slightly negative even without exploring | Run 20+ round live sessions and adjust `fruit_energy`, `fruit_interval_rounds` or `compute_absorption` |
| How much residue survives death? (1) | Defaults 0.4 of essence and 0.5 of compute (A-DEATH-1/2); no live death has happened | Observe deaths in long runs, log residue, then fix the fractions |
| Is the provisional plant-damage rule acceptable? (1) | Attacks reduce plant essence (A-PLANT-5); only fake-tested | Scripted attack scenarios, then a live run with conflict |
| How severe is first-strike dominance? (1) | No agent attacked in any live run | Measure deaths by attack budget and speed over long runs |
| What are the minimal seed and germination actions? (1) | Seeds drop and germinate automatically; agents have no planting action | Specify the actions before claiming cultivation |
| Are upgrades affordable and diverse enough? (2) | Live agents bought only `vision_range` (25 compute + 2 essence) | Review the price schedule after longer runs |
| How much data about other agents is public? (2) | Public fields are fixed in A-ACT-5 | Review with the query schema |
| How should the world be generated? (later) | Seeded clusters; first plants on agent start cells, each with one ripe fruit (A-WORLD-7, A-PLANT-13) | Decide map seeding and placement |

Behaviour not exercised by a live model: skills (`save_skills` / `run_skill`), `send` / `broadcast`, `recover`, `attack`, `transfer`, `wait` and deaths. No Haiku agent chose them in 3 rounds. Their rules are covered by fake-model tests only, and long-run ecology (fruit cycles, deaths, residue) is not covered end to end at all.

- *Next step:* a longer live run (10+ rounds) and scripted live scenarios that prompt for skills and messages.

## Deliberately not implemented

As listed in `docs/ASSUMPTIONS.md`: construction, persistent networks, fields, an agent birth action, mountain crossing, price modification, leaves with a function, natural plant spawning beyond seeds, embedding-based memory retrieval, mid-turn checkpoints, an `events` variable inside skills, and terrain occlusion. The Mortal Realm is out of scope.

- *Next step:* none for this prototype; revisit after the survival loop is calibrated.

## Browser support

The UI was tested only in Chromium (Playwright, headless) at 1440x900 and 1100x750. Firefox, Safari, Edge, small screens and touch input have not been tried. The layout assumes a desktop window; the wide inspector turns on at 1360 px and above. The frontend has 25 unit tests for its state modules and no component tests. Clarity (U14) was judged by people from screenshots, not by assertions.

- *Next step:* run `qa/browser_check.mjs` in Firefox and WebKit (Playwright supports both), and state a minimum window size in the UI.

## Single operator, local only

This is a local, single-operator prototype, as the spec asks.

- The backend binds to `127.0.0.1` and has no authentication or user accounts. Anyone who can reach the port can create, run, read and edit runs.
- One process can have a run open at a time (a file lock). There is no shared or multi-user editing.
- CORS allows only the local Vite ports (5173, 5174).
- Runs are plain files on the local disk. There is no database, no backup and no migration between schema versions.
- After a crash, event sequence numbers after the last saved turn can be reused. This is by design: the saved history never repeats a number, and `feed_epoch` changes so the UI resets its feed.
- *Next step:* before exposing the backend beyond localhost, add authentication and HTTPS, and decide how several operators would share a run.
