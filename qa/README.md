# Empyrean browser checks

`browser_check.mjs` drives the real UI in headless Chromium (1400x900) and walks the
required browser checks of `docs/INTERFACES.md` section 13. It saves numbered
screenshots and a JSON log of what it found to `qa/out/<timestamp>/`.

The UI is still changing, so the script does not depend on exact selectors. It looks
for controls by role, label, placeholder, title and visible text, trying several
candidates for each, and checks results through the backend API where it can. When it
cannot find or finish something, it records the step as failed with the reason
("could not find Pause (tried: ...)") and moves on. Steps that need an earlier result
(for example the run id) are skipped, not crashed.

## Setup (once)

```bash
cd qa
npm install            # playwright 1.49.1, pinned to the Chromium build in ~/.cache/ms-playwright (chromium-1148)
# only if that browser is missing:  npx playwright install chromium
```

## Run

Start the backend and the Vite dev server, then run the check:

```bash
# terminal 1
cd backend && ../.venv/bin/python -m empyrean.main             # http://127.0.0.1:8000
# terminal 2
cd frontend && npm run dev                                      # http://127.0.0.1:5173
# terminal 3
cd qa && node browser_check.mjs                                 # or: npm run check
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `BASE_URL` | `http://127.0.0.1:5173` | Where the UI is served |
| `API_URL` | `http://127.0.0.1:8000` | The backend, used to check results and create the error-state run |
| `HEADED` | unset | `1` shows the browser window |
| `STEP_TIMEOUT_MS` | `8000` | How long to look for each control |
| `QA_RUN_NAME` | `qa browser <timestamp>` | Name typed into the run name field, if the form has one |
| `QA_SKIP_ERROR_STEP` | unset | `1` skips the error-state step (it creates an extra run) |

The assistant steps have their own variables (`QA_ASSISTANT`, `QA_ONLY_ASSISTANT`, `QA_RUN_ID`,
`QA_INSECURE_HOST`) and their own QA backend; see "Assistant, Storybook and Story Mode steps" below.

To keep QA runs out of your normal `worlds/` folder and away from dev servers that are
already running, use other ports and a scratch worlds dir:

```bash
cd backend && EMPYREAN_API_PORT=8011 EMPYREAN_WORLDS_DIR=/tmp/qa-worlds ../.venv/bin/python -m empyrean.main
cd frontend && EMPYREAN_API_PROXY=http://127.0.0.1:8011 npx vite --port 5181 --strictPort
cd qa && BASE_URL=http://127.0.0.1:5181 API_URL=http://127.0.0.1:8011 node browser_check.mjs
```

Exit status: 0 when every attempted step passed; 1 when any step failed; 2 if the
script itself aborted. `log.json` is written after every step, so it is there even
when the script is interrupted.

## What it checks

Steps 1-17 (the simulation UI); steps 18-33 are in the assistant section below.

| # | Step id | Check | Requirement |
| --- | --- | --- | --- |
| 1 | `preflight` | `GET /api/health` and `/api/defaults` answer | |
| 2 | `entry` | The entry page shows **New session** and **Resume session** | U10 |
| 3 | `new-session-cards` | New session shows 8 prefilled cards with the default names. Also notes whether add/remove card, context settings and a model choice exist | U11, U16 |
| 4 | `edit-card` | Renames the first card and sets its starting x to 3 | U11 |
| 5 | `invalid-value` | Sets health to 999 (or x to 999). Expects a problem shown by its path (`agents[0]...`), then fixes the value | Spec "New session" |
| 6 | `create-run` | Creates the run and checks that it opens **Paused** with a round/turn status line. The backend confirms the edited name and x | U12, U14 |
| 7 | `run-turn` | **Run turn** commits exactly one turn, and a `[r1 t1] ...` feed line appears | U12, U13 |
| 8 | `play-pause` | **Play**, then **Pause**. Records whether "Pause requested" was seen before "Paused" | U12 |
| 9 | `step-round` | **Step round** stops at `r{n}_end` | U12 |
| 10 | `timeline` | Previous/next arrows, a history indicator, turn selection, then **return to live** | U6 |
| 11 | `crowded-coordinate` | Hovers and clicks the coordinate with the most occupants (taken from the API). Every occupant id must be listed | U1 |
| 12 | `select-occupants` | Selects each occupant and expects inspector details | U1, U2 |
| 13 | `agent-inspector` | Agent stats, skills, knowledge and model, plus the decision packet and model call record | U2 |
| 14 | `plant-rules` | The plant inspector shows the species and stage. Editing "fruit energy" stages `update_plant_rules` | U3 |
| 15 | `god-mode` | Changes "recent history length" and sends a broadcast voice. Both appear in the staged list, and after **Run turn** they are recorded in that turn | U7, U8, U16 |
| 16 | `resume` | Goes back to the entry page, uses **Resume session**, and checks the run opens paused | U10 |
| 17 | `error-recovery` | A run whose fake model times out in round 1 is opened in the UI. **Run turn** leads to the error state, and **Recover (pause)** leads back to paused | A-COG-5 |

## Reading the results

* `out/<timestamp>/NN-<step>.png`: the screen at the end of each step, plus a few extra
  shots (`crowded-hover`, `decision-packet`, `error-state`).
* `out/<timestamp>/log.json` has one entry per step:
  * `ok`: `true`, `false`, or `null` when skipped.
  * `error`: why the step failed.
  * `found`: which locator matched each control and what was observed.
  * `notes`: non-fatal gaps, for example `not found: add card control`.
  * `console_errors` / `page_errors`: errors from the browser.
* A failure like "could not find X (tried: …)" usually means the control has no
  accessible name. Give it visible text, a `<label>`, `aria-label` or `title` that
  matches the wording above. For map cells, `data-coord="x,y"` or a title containing
  `x,y` lets the script click a coordinate. A coordinate lookup field labelled
  "Go to" also works.

The script creates runs in the backend's worlds dir. Their names start with
`qa browser`.

## Assistant, Storybook and Story Mode steps (rev 4)

The assistant release adds 16 browser steps (18-33) that never spend money. Run them against the
QA backend `qa/assistant_fake_server.py`: it builds the same app as `python -m empyrean.main`, forces
every assistant profile (chat, narrator, author, summarizer) to `fake-assistant`, refuses to start
otherwise, turns the Whisper preload off, serves on port 8020 with the worlds folder
`qa/worlds-assistant/`, and adds `GET/PUT /api/_qa/fake_metadata` so the script can tell the fake chat
model what to answer (a brief, refs, a slow step). The plain server has no such hook, so there the fake
chat model only ever gives its default answer and the brief steps cannot run.

```bash
# QA backend: every assistant profile forced to fake-assistant, whisper preload off, port 8020,
# worlds qa/worlds-assistant, plus GET/PUT /api/_qa/fake_metadata to script the fake chat model
.venv/bin/python qa/assistant_fake_server.py
cd frontend && EMPYREAN_API_PROXY=http://127.0.0.1:8020 npx vite --port 5180 --strictPort
cd qa && BASE_URL=http://127.0.0.1:5180 API_URL=http://127.0.0.1:8020 node browser_check.mjs
```

Against the primary servers (`cd qa && node browser_check.mjs`) the free assistant steps run and every
step that would call a model skips itself, so the script never spends against a live backend.

| # | Step id | Check |
| --- | --- | --- |
| 18 | `assistant-preflight` | Capabilities, whether every profile is fake, whether the fake hook exists, the storybook auto rule for the QA run |
| 19 | `assistant-entry-drawer` | Entry page: the **Assistant** pill opens a floating drawer with focus in the composer; × and Alt+A close it and focus returns |
| 20 | `assistant-run-docked` | Run page: the rail-header **Assistant** button docks the drawer; no overlap with the map or side column, map at least 360 px, no horizontal scroll |
| 21 | `assistant-run-floating` | **Float** leaves the map box exactly as with the drawer closed; **Dock** again; docked at 1280 px, floating at 1200 px |
| 22 | `assistant-tabs-row` | With "God mode (3)", the run-page tabs row is one line under 34 px at 1280, 1440 and 1920 px, drawer closed and docked |
| 23 | `assistant-ask-answer` | A question with "Include what I'm looking at" gets the default fake answer, shows its context chip and is scoped to the run (model call) |
| 24 | `assistant-progress-and-refs` | A scripted slow answer: the progress line ticks with Cancel; entity and turn chips select and open history (scripted) |
| 25 | `assistant-first-time-user` | "New here? Ask the assistant" prefills the question; the scripted answer carries docs and control chips (scripted) |
| 26 | `assistant-create-run-brief` | A scripted `create_run` brief: the card's deterministic lines and settings diff; **Approve: create run** creates the run paused and opens it (scripted) |
| 27 | `assistant-interventions-brief` | A `stage_interventions` brief with an unknown entity cannot be approved; **Ask for changes**; the corrected brief supersedes it and stages the edit with origin `assistant` (scripted) |
| 28 | `assistant-godmode-badge` | "Open God mode (1 staged)" opens the God mode tab with the assistant's staged edit (scripted) |
| 29 | `assistant-storybook-readonly` | The **Storybook** tab of the old-check run, read only (never presses Write missing); Auto per the default rule |
| 30 | `assistant-storybook` | Two **Run turn** clicks on the brief-created run write two entries in the Storybook tab (model calls: the fake narrator) |
| 31 | `assistant-escape-record-viewer` | With the record viewer open, Escape closes the drawer first and the viewer stays open |
| 32 | `story-mode` | **Story Mode** from the entry page: run picker, step-0 card, story brief with both estimates, Accept, chapter 1 in the reader, Export Markdown (model calls) |
| 33 | `assistant-dictate` | The **Dictate** button: enabled on secure origins when speech is ready; on a non-secure origin disabled with its reason |

"Scripted" steps need the fake-metadata hook and skip with that reason without it; they and the
"model call(s)" steps run only when every profile is fake (8 steps: 23-28, 30 and 32). The others spend
nothing and run against any backend with the assistant.

| Variable | Default | Meaning |
| --- | --- | --- |
| `QA_ASSISTANT` | `auto` | `auto`: free assistant steps always, steps that call a model only when every profile is fake; `0`: skip all assistant steps; `1`: require fake profiles (fail otherwise) |
| `QA_ONLY_ASSISTANT` | unset | `1` runs only the assistant steps, against the run named by `QA_RUN_ID` |
| `QA_RUN_ID` | unset | An existing run with model turns for `QA_ONLY_ASSISTANT=1` |
| `QA_INSECURE_HOST` | `qa-insecure.test` | Host name mapped to 127.0.0.1 in a second browser to check Dictate on a non-secure origin. The Vite server must list it in `server.allowedHosts` (a config passed with `--config`); otherwise that sub-check is recorded as not run |

`http://127.0.0.1` is a secure context in Chromium, like `localhost`, so Dictate is enabled there; the
disabled state with its reason appears only on a non-loopback origin (the machine's IP address, or the
`QA_INSECURE_HOST` alias). Labels the script looks for are the ones in `docs/CONTROLS.md`; change both
together. The latest results are in `docs/evidence/browser_qa_assistant.md`.

Two helpers of the assistant playtest (`scripts/assistant_playtest.py`) live here too:
`qa/render_brief.mjs` renders a stored brief's "What will happen" lines with the real frontend
`describeAction` (stdin JSON in, JSON out), and `qa/playtest_shots.mjs` takes the playtest screenshots
through the UI (fake keys, no spend; backend on the playtest worlds copy).

## Resilience harness

`qa/resilience/` holds crash, restart, one-writer, playback, invalid-input, skill, context,
voice, working-files, storage and reload-order scenarios (`a_crash_resume.py` ..
`l_reload_order.py`) driven over HTTP by `rlib.py`, which starts its own backend
(`RES_PORT`, `RES_WORLDS`, `RES_OUT`, `RES_LOG`). `run_all.sh` runs them all and writes one log
per scenario to `qa/resilience/out/`. The scripts assume the checkout is at
`/home/ubuntu/antegensim` (see `docs/LIMITATIONS.md`). Results are recorded in
`docs/evidence/resilience.md`.
