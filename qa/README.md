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
