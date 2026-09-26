# Test evidence

What was tested, how, and with what result. Date: 2026-09-25. Code: the working tree on top of commit `a11e51b` (uncommitted changes), recorded in run manifests as `code_revision` `a11e51b+dirty.67f19b11`. The sha256 prefix of `backend/empyrean/*.py` for every final-source result below is `1132bcec6042` (after the reload-order / agent-view fix pass).

Every section is labelled:

- **MOCKED**: no real provider was called. Models are the deterministic fakes (`fake-heuristic`, `fake-scripted`, `fake-malformed`), or provider responses are recorded or mocked payloads.
- **LIVE**: real, paid calls to `claude-cli-haiku` (the Claude Code CLI with model `haiku`). This is the only live model on this machine.

Requirement-to-test mapping is in [TEST_PLAN.md](TEST_PLAN.md). Known gaps are in [LIMITATIONS.md](LIMITATIONS.md).

> **To be refreshed by the assistant verification pass (WP8).** Everything below records the
> state before the assistant release (2026-09-25). The assistant release (2026-09-26) adds backend
> tests (`test_assistant_*.py`, `test_speech.py`, `test_docs_consistency.py`), frontend state tests,
> browser steps and live playtests, so these sections must be re-measured and replaced: the
> Summary table; "Backend tests" (counts per file, skipped live and `whisper` tests); "Frontend"
> (state test count, lint warnings); "Browser QA" (`browser_check.mjs` with the assistant steps);
> and a new "Assistant" section (fake-model QA, the replay of stored malformed envelopes, the
> Sonnet smoke and the ground-truthed playtest with per-call cost, latency and cache reads,
> linking `docs/evidence/assistant_playtest.md`). The docs check (`scripts/check_docs.py`) result
> belongs in the Summary table too. Until then, treat the counts below as historical.

## Summary

| Area | Label | Result |
| --- | --- | --- |
| Backend unit + end-to-end tests | MOCKED | 469 passed, 3 skipped (the live tests) |
| Frontend unit tests, type-check, build, lint | no models | 25 of 25 passed; `tsc -b` clean; `vite build` ok; lint 0 errors, 6 warnings |
| Headless simulations | MOCKED | 2 runs of 8 agents x 3 rounds, no errors (source before the last fix pass) |
| Resilience and completion criteria (13 scripts, 165 checks) | MOCKED | **165 of 165 passed on the final source** |
| Live simulations, live tests and a live UI session | LIVE | 6 runs (1 on the final source), the 3 live pytest tests on the final source (2 of 3, then 3 of 3), 102 calls in all, **USD 0.782** |
| Browser QA | MOCKED (one review session LIVE) | `browser_check.mjs` 17 of 17 on the final code; of the 21 reviewer findings 20 pass and 1 is partial (status-bar height); the pass-1 major is fixed; 3 minor UI issues remain (plus legacy-run cost fields) |
| Provider adapters other than `fake` and `claude_cli` | MOCKED only | Unit tests against mocked payloads; never called for real |

## Deterministic (fake models): MOCKED

### Backend tests

`cd backend && ../.venv/bin/pytest -q` on the final source: **469 passed, 3 skipped in 53.2 s.** The 3 skipped tests are `@pytest.mark.live` and run only with `EMPYREAN_LIVE_TESTS=1` (results under LIVE below).

| Kind | Files | Passed | Skipped (live) |
| --- | --- | --- | --- |
| Unit | `test_world` 65, `test_skills` 148, `test_runner` 54, `test_model` 69, `test_storage` 39, `test_context` 36, `test_api` 11, `test_integration_rev3` 9 | 429 | 2 (`test_model.py`) |
| End-to-end, through the public API routes | `test_e2e_run` 12, `test_e2e_rules` 9, `test_e2e_godmode` 12, `test_e2e_context` 4, `test_e2e_boundaries` 4 | 40 | 1 (`test_e2e_boundaries.py`) |

The fakes sit behind the same `model.py` boundary as the real providers, so these tests run the real runner, world engine, context builder, skills interpreter, storage and API. What they prove, and what only a live run can prove, is set out in TEST_PLAN.md under "Mocked vs live".

### Frontend

| Check | Command (in `frontend/`) | Result |
| --- | --- | --- |
| Unit tests of the state modules | `node src/state/state.test.mjs` | 25 of 25 passed |
| Type-check | `npx tsc -b` | no errors |
| Build | `npx vite build --outDir <scratch dir>` (the bundling half of `npm run build`, kept out of `frontend/dist`) | built in 0.2 s |
| Lint | `npm run lint` | 0 errors, 6 warnings: 2 `react(jsx-key)` (`AgentInspector.tsx:186-187`), 1 `react(only-export-components)` (`inspect/common.tsx:38`), 2 `react(refs)` (`MapView.tsx:490`), 1 `react(set-state-in-effect)` (`RunPage.tsx:137`); see LIMITATIONS.md |

### Headless simulations

`scripts/run_sim.py`, in-process, scratch worlds folder, run at 19:39 on the source before the last fix pass (not re-run; the resilience suite and pytest cover the final source). Full output: `docs/evidence/final_pass/headless_*.txt`.

| Model | Setup | Result |
| --- | --- | --- |
| `fake-heuristic` | 8 agents, 3 rounds, seed 1 | 2.7 s. 24 actions, all ok (observe 8, absorb 8, query 8). 24 model calls completed. No deaths. Cognition 13.05 compute, actions 40, upkeep 24. Mean agent-turn folder 112.5 KB; the printed turn folder holds only the acting agent's knowledge file |
| `fake-malformed` | 8 agents, 3 rounds, seed 1 | 8 observe actions ok. 16 decisions rejected by the format gate (`decision_invalid`: no action applied, cognition charged). 8 calls classified `failed/malformed`. The run stayed `paused` after each round, with no error |
| `claude-cli-haiku` without `EMPYREAN_ALLOW_LIVE=1` | | Refused: "refusing to run a live model (provider 'claude_cli') without EMPYREAN_ALLOW_LIVE=1" |

### Resilience and completion criteria

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

## Live provider (claude-cli-haiku): LIVE

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

## Browser QA

Full results: [evidence/browser_qa.md](evidence/browser_qa.md) (two passes, the second on the final code). Curated screenshots: `docs/evidence/screenshots/01-entry.png` … `18-resume-session.png`. Every screenshot was opened and checked by eye.

- **MOCKED (fake models, real Chromium):**
  - `qa/browser_check.mjs` passed **17 of 17** steps on the final code, with no console or page errors (`qa/out/2026-09-25_20-43-52/`; the fixer's own run `qa/out/2026-09-25_20-21-26/` also passed 17 of 17).
  - Pass 2 (after the reload-order fix): the pass-1 major (a `working/` reload undoing UI edits staged for the same turn) passes in both orders at 1440x900 and 1100x750. A conflicting reload is rejected whole, with the reason shown. The tooltip, the occupant scroll cue, the full action JSON, the Set stat display, the full next-round order and the agent-view filtering all pass.
  - Reviewer findings on the final code: 20 of 21 pass, and 1 is partial (row 21: the status bar now changes height at round boundaries because the full next-round order wraps).
  - Remaining: 3 minor issues (agent view works only at the agent's own cell; that status-bar height change; species-rule edit records do not name the changed field), plus the legacy-run cost fields. All are listed in LIMITATIONS.md.
  - All 18 required operator flows passed in pass 1 (entry, cards, validation, controls, pending call, pause, history, crowded cell, inspectors, plant rules, god mode, continuation, error recovery, resume).
- **Reviewer 1 (MOCKED):** an operator could complete all nine steps. They found 1 major and 10 minor issues, all fixed and re-tested since.
- **Reviewer 2 (LIVE):** six steps through the UI with `claude-cli-haiku` (the `review2` row in the live table). The main findings were the stale backend and the "nothing was charged" wording; both have been fixed and re-tested with fakes.

## Provider adapters verified only with mocked payloads

The `anthropic`, `openai`, `fireworks`, `bedrock` and `foundry` adapters were verified only against mocked payloads, because no credentials for those providers exist on this machine. `backend/tests/test_model.py` covers request building, schema transforms, usage-normalisation goldens, and error, refusal and truncation classification for each of them. None of them has made a real call.

## Reproduce

From the repository root:

```bash
(cd backend && ../.venv/bin/pytest -q)                                  # MOCKED
(cd frontend && node src/state/state.test.mjs && npx tsc -b)            # frontend
.venv/bin/python scripts/run_sim.py --model fake-heuristic --worlds-dir /tmp/w      # MOCKED
bash qa/resilience/run_all.sh     # MOCKED; own backend on :8020, about 3.5 min; overwrites qa/resilience/out/
                                  # RES_PORT / RES_WORLDS / RES_OUT / RES_LOG select another port and folders; expect 165 of 165
(cd qa && node browser_check.mjs)                                       # needs the backend and Vite running
EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/run_sim.py --model claude-cli-haiku --live-check   # LIVE, one paid call
(cd backend && env -u CLAUDECODE EMPYREAN_LIVE_TESTS=1 ../.venv/bin/pytest -q -m live)            # LIVE, 3 paid calls (about USD 0.017)
```
