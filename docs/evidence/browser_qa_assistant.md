# Browser QA: assistant drawer, briefs, Storybook, Story Mode, Dictate (WP8 browser)

Headless Chromium (Playwright 1.49.1 from `qa/`) drove the real UI through `qa/browser_check.mjs`. The old
17 steps are unchanged and still pass; 16 assistant steps were added (steps 18-33). **No model money was
spent**: the assistant runs used only `fake-assistant`, and against the primary (live-model) backend every
step that would call a model is skipped by the script itself (the primary's assistant spend was USD
0.1028 before and after, all of it from the lead's earlier Sonnet smoke; no new ledger line was written).

## Runs

| Pass | When (UTC, 2026-09-26) | UI / backend | Assistant models | Result | Log |
| --- | --- | --- | --- | --- | --- |
| A: all fake (final) | 08:34:16-08:36:05 | Vite `127.0.0.1:5180` -> QA backend `127.0.0.1:8020` (`qa/assistant_fake_server.py`, worlds `qa/worlds-assistant`) | all four profiles `fake-assistant` | **33 passed, 0 failed, 0 skipped** | `docs/evidence/browser_qa_assistant_fake.log.json` (`qa/out/2026-09-26_08-34-16/`) |
| B: primary servers (final) | 08:36:09-08:37:31 | Vite `127.0.0.1:5173` (PID 130830) -> backend `127.0.0.1:8000` (PID 1315052) | chat/author `claude-cli-sonnet-assistant`, narrator/summarizer `claude-cli-haiku-assistant` (live) | **25 passed, 0 failed, 8 skipped** (the old 17 all pass; the 8 skipped steps would call a model) | `docs/evidence/browser_qa_assistant_primary.log.json` (`qa/out/2026-09-26_08-36-09/`) |

Earlier iterations of the same script: fake 08:13 (29/32, three script selector bugs, fixed), 08:16
(assistant steps only, 15/15), 08:18 (32/32), 08:26 (33/33); primary 08:20 (24 passed, 8 skipped) and
08:29 (25 passed, 8 skipped). No console errors and no page errors in any final pass.

Runs created on the primary backend (`worlds/`, all closed): `run_20260926_082006_280c`,
`run_20260926_082056_2660`, `run_20260926_082930_2afa`, `run_20260926_083021_fde7`,
`run_20260926_083613_257b`, `run_20260926_083704_3e08` (all fake agents, storybook auto **off** as the
default rule says for a paid narrator). Everything the fake pass created is in `qa/worlds-assistant/`
(git-ignored).

### How to reproduce

```bash
# QA backend: every assistant profile forced to fake-assistant, whisper preload off, port 8020,
# worlds qa/worlds-assistant, plus PUT /api/_qa/fake_metadata to script the fake chat model
.venv/bin/python qa/assistant_fake_server.py
# Vite on 5180 proxying to it; allowedHosts lets the Dictate check use a non-secure host name
cd frontend && EMPYREAN_API_PROXY=http://127.0.0.1:8020 npx vite --config <cfg with port 5180, allowedHosts ['qa-insecure.test']>
cd qa && BASE_URL=http://127.0.0.1:5180 API_URL=http://127.0.0.1:8020 node browser_check.mjs
# the primary servers (no spend: model steps skip themselves)
cd qa && node browser_check.mjs
```

`QA_ASSISTANT=0` skips all assistant steps, `=1` requires fake models; `QA_ONLY_ASSISTANT=1 QA_RUN_ID=<run>`
runs only the assistant steps against an existing run with model turns; `QA_INSECURE_HOST` (default
`qa-insecure.test`) is the host name mapped to 127.0.0.1 for the non-secure Dictate check.

**Why a QA launcher:** the fake chat model answers from `AssistantService.fake_metadata`, a test hook that
the served app does not expose. With `python -m empyrean.main` and the fake env keys, chat only ever
returns the default "(fake assistant) I read the context you sent…" answer, so no brief card can be shown.
`qa/assistant_fake_server.py` builds the same app (`empyrean.main.build_app`), refuses to start unless all
four profiles are fake, and adds `GET/PUT /api/_qa/fake_metadata`. The script uses the hook only for the
steps marked "scripted" below; without the hook they are skipped with that reason.

## Step table (steps 18-33; steps 1-17 are the unchanged old check)

Screenshots are in `docs/evidence/screenshots/assistant/` (from pass A unless named `*-primary*`). Every
screenshot listed was opened and checked by eye.

| # | Step id | What was checked | Pass A (fake) | Pass B (primary) | Screenshots |
| --- | --- | --- | --- | --- | --- |
| 18 | `assistant-preflight` | Capabilities; whether every profile is fake; the fake hook; storybook auto for the all-fake-agent QA run matches the rule | PASS: 4x fake, hook present, auto **on** (fake narrator) | PASS: live keys, no hook, auto **off** (paid narrator, fake agents) | `01-assistant-preflight.png` |
| 19 | `assistant-entry-drawer` | Entry page 1440x900: pill "Assistant" (status dot "assistant ready (fake model: free, canned answers)"), opens a **floating** drawer 400 px wide, focus in the composer, pill hidden while open, no horizontal scroll, × closes and focus returns to the launcher, Alt+A opens and closes | PASS | PASS (dot "assistant ready") | `02-entry-drawer-open.png`, `02-assistant-entry-drawer.png` |
| 20 | `assistant-run-docked` | Run page 1440x900: the rail-header **Assistant** button docks the drawer (`aria-pressed=true`); the drawer (x 1040-1440) overlaps neither the map nor the side column; map ≥ 360 px; no horizontal scroll | PASS. Map box closed `270,8 762x884` -> docked `270,8 362x884`; side column moves 1040 -> 640 | PASS (same numbers) | `03-assistant-run-docked.png`, `03-run-docked-primary.png` |
| 21 | `assistant-run-floating` | **Float**: the map box is exactly the closed-drawer box (`270,8 762x884`) and the drawer overlays; **Dock** again; at 1280 px it docks at 360 px with the map at exactly 360 px, no overlap, no scroll; at 1200 px it floats | PASS | PASS | `04-run-floating.png`, `04-assistant-run-floating.png` |
| 22 | `assistant-tabs-row` | Three voice edits staged by API so the tab reads "God mode (3)"; at 1280/1440/1920, drawer closed and docked: `.tabs` height, tab count, one line | PASS: 29.2 px, 5 tabs, 1 line everywhere. **But see finding 1: the row only fits by scrolling; "Storybook" is partly hidden** | PASS (same) | `05-tabs-1440-docked.png`, `05-assistant-tabs-row.png` |
| 23 | `assistant-ask-answer` | Ask on the run page with "Include what I'm looking at" on: the default fake answer arrives; the question shows its context chip "Looking at: run qa browser … · turn r00002_t01_a04"; the conversation is scoped to the run | PASS | SKIP (would call Sonnet) | `06-assistant-ask-answer.png` |
| 24 | `assistant-progress-and-refs` | *Scripted* 4.5 s answer with entity/turn/doc refs: the progress line ticks `step 1/4 · 0 s … 4 s · $0.00` with Cancel; the entity chip selects a01 in the side column; the turn chip opens history (strip shown) | PASS, with findings 2, 3 and 4 | SKIP | `07-progress-midway.png`, `07-assistant-progress-and-refs.png` |
| 25 | `assistant-first-time-user` | Entry page "New here? Ask the assistant: …" opens the drawer with the question prefilled (not sent); *scripted* answer with a docs chip and a control chip | PASS | SKIP | `08-assistant-first-time-user.png` |
| 26 | `assistant-create-run-brief` | *Scripted* `create_run` brief (6 agents, a01 renamed Ash with attack 3, move price 2, play delay 0): card "Proposal", status "awaiting your approval", **What will happen** = the deterministic lines `Creates a paused run "QA brief arena …" with 6 agents.` / `Nothing is spent until you play it.` + "5 settings differ from the defaults" (`agents[0].name: Aster → Ash`, `agents[0].stats.attack: 1 → 3`, `name`, `play_delay_seconds: 0.2 → 0`, `rules.prices.move: 5 → 2`), **Assistant's description**, "Proposed in reply to"; **Approve: create run** creates the run (paused, a01 = Ash with attack 3), navigates to it, "Now about: QA brief arena …", conversation rebound to the new run | PASS | SKIP | `09-create-run-brief-card.png`, `09-assistant-create-run-brief.png` |
| 27 | `assistant-interventions-brief` | *Scripted* `stage_interventions` brief on entity `zz99`: "Cannot be executed as proposed: `interventions[0].entity_id`: unknown entity 'zz99'", **Approve: stage 1 edit** disabled; **Ask for changes** quotes the brief into the composer and shows "Waiting for your changes"; the corrected brief (a01) supersedes it ("replaced by a newer proposal"); Approve stages `iv_0001 set_stat` with origin `assistant`, note "assistant: Set compute of a01 to 50." | PASS | SKIP | `10-interventions-brief-problem.png`, `10-assistant-interventions-brief.png` |
| 28 | `assistant-godmode-badge` | "Open God mode (1 staged)" selects the God mode tab; the staged list row reads `iv_0001 set_stat [assistant] set a01.stats.compute = 50` | PASS; the edit appeared 1.5 s after approval (finding 5) | SKIP | `11-assistant-godmode-badge.png` |
| 29 | `assistant-storybook-readonly` | Storybook tab on the old-check QA run, read-only (never presses Write missing): label "AI-written narrative; the Turn record has the facts", Auto per the default rule | PASS: "Auto on", "10 entries · spent $0.00 of $2.00" | PASS: "Auto off", "0 entries · spent $0.00 of $2.00 · 11 missing", button "Write missing (11 entries, ≈$0.03, ~38 s)" (not pressed) | `12-assistant-storybook-readonly.png`, `12-storybook-readonly-primary-live-narrator.png` |
| 30 | `assistant-storybook` | On the brief-created fake run: two **Run turn** clicks; the tab shows "Auto on", "2 entries · spent $0.00 of $2.00", the Opening, entries "Round 1 · turn 1 · a02 Boreas" (with "Operator: operator iv_0001 set_stat -> ok") and "Round 1 · turn 2 · a01 Ash" (viewed), "Make a story of this run" | PASS | SKIP | `13-assistant-storybook.png` |
| 31 | `assistant-escape-record-viewer` | Record viewer open on "Decision packet pk_r00002_t01_a04"; drawer opened (focus inside); Escape closes the drawer and the record viewer **stays open**; a second Escape closes the viewer | PASS | PASS | `14-after-escape.png`, `14-assistant-escape-record-viewer.png` |
| 32 | `story-mode` | Entry **Story Mode** -> run picker (`#/story`) -> **Story** on the QA run -> **New story** -> step-0 card "STEP 0 · FROM THE RUN'S RECORDS, NO MODEL CALL" with Cast and chip groups Genre (Chronicle), Tone (Measured), Vividness (3 · Balanced), Point of view (Chronicler / Follow <agent>), Chapters, turn range and "Dictate to the story author" -> **Write the story brief** -> brief with **both** estimates ("One chapter per turn: 11 chapters", "One chapter per round: 3 chapters") -> **Accept: write 11 chapters per turn, 3 at a time as you read** -> reader "1 of 11 chapters written", "1. Opening"; the job wrote 4 chapters (opening + 3 interludes, 3 ahead of the reader) -> **Export Markdown** downloads `the-chronicle-of-qa-browser-….md` (866 bytes, starts `# The Chronicle of …`) | PASS | SKIP (the brief is a Sonnet call) | `15-story-picker.png`, `15-story-step0.png`, `15-story-brief.png`, `15-story-mode.png` |
| 33 | `assistant-dictate` | Dictate button in the drawer composer on three origins | PASS: `http://127.0.0.1:5180` and `http://localhost:5180` are secure contexts -> **enabled** (speech "ready"); `http://qa-insecure.test:5180` (mapped to 127.0.0.1) is not -> `aria-disabled=true`, tooltip and, after a click, the inline message "Dictate needs a secure page: open via localhost (for example http://localhost:5173) or HTTPS…", phase stays idle | PASS for 127.0.0.1 and localhost (enabled, speech "ready"); the non-secure host was not checked: Vite 5173 answers 403 for an unknown Host | `16-dictate-insecure.png`, `16-assistant-dictate.png`, `16-dictate-primary.png` |

## Findings

Ranked most serious first. None of them made a step fail; the step criteria in the brief (tabs row < 34 px on
one line, etc.) hold, and these are what the measurements showed beyond them.

1. **Tabs row: the fifth tab is partly hidden at every tested width (UX, moderate).** The row is one line
   (29.2 px) only because it scrolls sideways: its content is 451 px wide. Hidden at the right edge:
   "Storybook" by 61 px at 1280 and 1440 (side column 390 px) and in every docked layout, by 11 px at 1920
   (440 px); at 1280 docked (side column 300 px) "Rules" by 58 px and "Storybook" by 151 px. There is no
   visible scroll cue. When Storybook is selected the row scrolls and "Inspector" shows as "pector"
   (`13-assistant-storybook.png`). The short label "Story" only applies below a 419 px *viewport*
   (`App.css` `@media (max-width: 419px)`), not a narrow column. Screenshot `05-tabs-1440-docked.png`.
   Suggested fix: switch to the short label (or smaller padding) by the column width (container query or
   a class from `useRunLayout`).
2. **Progress: the main line ticks, the line under it and the API stay at "0 s" (minor; known issue
   partly confirmed).** In a 4.5 s fake step the UI line went `0 s, 1 s, 2 s, 3 s, 4 s` (it computes the
   elapsed time client-side from `job.started_at`), so "shows 0 s until the first step completes" is
   **refuted for the main line**. It is **confirmed** for the backend: `job.elapsed_s` stayed 0 and
   `job.progress` / `message.progress` stayed "step 1/4 · 0 s · $0.00" for the whole step, and the drawer
   prints that stale string as the hint line right under the ticking one (`07-progress-midway.png`:
   "step 1/4 · 2 s · $0.00" above "step 1/4 · 0 s · $0.00").
3. **Step list off by one while a message runs (minor).** During step 1 the list under the progress line
   reads "step 2: …" (`07-progress-midway.png`). The engine's `StepRecord.index` is 1-based
   (`engine.py` `StepRecord(index=step_no)`, `step_no` starts at 1) and `MessageList.tsx` prints
   `step.index + 1`.
4. **"TURN turn r00002_t01_a04" chip (cosmetic).** The engine-added "as of" ref has the label
   "turn <id>", and the chip prefixes the kind again. The same answer also says "As of turn …" twice (in the
   text and in the meta line).
5. **Staged count after approving an interventions brief lags by one status poll (minor).** The God mode
   tab and the rail's "Staged edits" showed the assistant's edit about 1.5 s after approval (measured in
   two passes). `AssistantDrawer.approve` calls `handlers.applyStatus(effect.status)` only when the action
   needs an on-screen run (`requiresOnScreenRun`, i.e. `run_command`), so for `stage_interventions` the page
   waits for its next poll. In the first draft of this step (checked after 0.7 s) the tab read "God mode"
   and the rail "0" (`qa/out/2026-09-26_08-13-50/28-assistant-godmode-badge.png`).
6. **`http://127.0.0.1` is a secure context (correction to the test brief).** Chromium treats loopback as
   potentially trustworthy, so on 127.0.0.1 Dictate is enabled when speech is ready, exactly as on
   localhost. The disabled-with-reason state appears on a non-loopback origin (the machine's IP, or the
   `qa-insecure.test` alias used here), which is what an operator reaching the AWS host by its address gets.
7. **Docked reserve reflows the map (by design; the brief's "map box unchanged" holds only when floating).**
   Opening the docked drawer at 1440x900 shrinks the map from 762 to 362 px (the side column slides left);
   nothing is covered and there is no horizontal scroll. Floating leaves the map box identical. The script
   asserts: docked -> no overlap, map ≥ 360 px, no page scroll; floating -> identical box.
8. **The served app has no way to script the fake chat model (test infrastructure).** With
   `python -m empyrean.main` and the fake env keys, brief cards cannot be reached in a browser (see "Why a
   QA launcher"). `qa/README.md`'s assistant section documents exactly that command, so following it would
   skip the brief steps; the needed README change is in the handoff note
   `scratchpad/handoff/wp8-browser.md`.
9. **Story Mode step-0 estimate vs brief (cosmetic).** The step-0 card says "Per turn: 9 chapters" (agent
   turns), the brief plans 11 (opening + 9 + round end). Both are labelled (step 0 as "indicative").

## Known issues from the brief

| Issue | Verdict | Evidence |
| --- | --- | --- |
| The job progress line shows 0 s until the first step completes | **Partly confirmed**: backend `elapsed_s` / progress text stay 0 during a step and the drawer shows that stale text as a second line; the main UI line ticks correctly | finding 2, `07-progress-midway.png`, log step 24 `progress_ui` / `progress_api` |
| `test_plain_answer_with_refs_and_progress` failed once in a group run | **Not reproduced** (5 group runs of `tests/test_assistant_*.py`: 135 passed each, 43 s). **Plausible cause from the code:** `_finish_*` sets the job to `done` before the `finally` in `engine.py` clears `meta.active_job_id`; the test's `ask()` returns as soon as the job is terminal and then asserts `meta.active_job_id is None`, so a GET in that window fails the assertion | loop output `scratchpad/wp8b_pytest_loop.txt` |
| oxlint reports 10 warnings (6 new set-state-in-effect in the drawer) | **Confirmed**: 10 warnings: `AssistantDrawer.tsx` set-state-in-effect at 206, 244, 277, 301, 319, 445; `RunPage.tsx:170` set-state-in-effect; only-export-components in `inspect/common.tsx:38` and `InstructionsPage.tsx:26,31` | `npm run lint` at 08:23 UTC |

## Spend

| Where | Model calls | Cost |
| --- | --- | --- |
| QA backend 8020 | chat 30, narrator 61, author 15 (all `fake-assistant`) plus fake-heuristic agents | USD 0.00 |
| Primary backend 8000 | none by this package (the drawer was opened, never sent; the Storybook was only read) | USD 0.00 (global assistant spend stayed 0.1028028 = the lead's smoke) |

Side observation for the playtest owner: the lead's smoke call is in the run ledger as `status: malformed`,
`error_code: schema_mismatch`, cost 0.1028, while the conversation shows that step as `ok` (the reply was
salvaged). Format-failure rates computed from `usage.jsonl` therefore count pre-salvage outcomes.
