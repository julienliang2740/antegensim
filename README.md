# Empyrean prototype (antegensim)

Empyrean is a local, turn-based artificial-life world in which each agent is a language model: on its turn an agent gets a bounded decision packet built only from what it knows, returns one JSON decision, and the world engine applies the rules, costs and effects. Every turn is saved as a readable JSON checkpoint, so a run can be paused, inspected turn by turn, edited ("god mode") and continued from any point in its history.

A built-in **assistant** explains the world and the controls, reads a run's records to answer questions, proposes changes as execution briefs that run only after you approve them, writes a per-turn **Storybook**, and turns a run into a chaptered story in **Story Mode**. You can speak to it with **Dictate** (local Whisper).

The backend is Python 3.12 with FastAPI (`backend/empyrean`). The UI is Vite, React 19 and TypeScript (`frontend/`). Requirements are in `llm_world_technical_spec.md` and `llm_world_running_design.md`.

Documentation (full list with audiences in [docs/INDEX.md](docs/INDEX.md)):

| File | What it holds |
| --- | --- |
| [CLAUDE.md](CLAUDE.md) | Coding practice for people and coding agents: commands, the model boundary, secrets, commits, the docs rule |
| [docs/SYSTEM.md](docs/SYSTEM.md) | How the simulation works end to end, and common misreadings |
| [docs/CONTROLS.md](docs/CONTROLS.md) | Every control in the UI: label, effect, API call, allowed states |
| [docs/ASSISTANT.md](docs/ASSISTANT.md) | The assistant: models, budgets, briefs, storybook, Story Mode, Dictate |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Every domain term |
| [docs/CODE_MAP.md](docs/CODE_MAP.md) | Where each piece of code lives |
| [docs/INTERFACES.md](docs/INTERFACES.md) | The detailed contract: ids and the run state machine (§3), storage layout (§5), decision JSON (§6), events (§7), turn procedure (§8), API (§9), interventions (§10), fake models (§12), testing (§13), change log (§14) |
| [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) | Every rule the design leaves open, with its config key and default |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | Known issues and limitations, each with a next step |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) / [docs/TEST_EVIDENCE.md](docs/TEST_EVIDENCE.md) | Which test covers each requirement / what was tested and the results |

## Prerequisites

- Linux or macOS with Python 3.12.
- Node.js 20.19+ or 22.12+ (Vite 8 needs one of these; tested with Node 24.19) and npm.
- Optional, for live runs through `claude-cli-*` models and for the assistant: the Claude Code CLI installed as `claude` on `PATH` and logged in. Without it the assistant answers from the docs only ("Docs search (AI offline)").
- Optional, for Dictate: about 1.6 GB of disk for the Whisper model (downloaded to the Hugging Face cache on first load) and a few GB of RAM.
- Optional, for the other providers: an API key or cloud credentials (see [Models and credentials](#models-and-credentials)).
- Optional, for the browser check: Playwright's Chromium (installed by `npx playwright install chromium` if it is missing).

## Setup

From the repository root:

```bash
cp .env.example .env                      # leave every value empty unless you use that provider
python3.12 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
(cd frontend && npm install)
(cd qa && npm install)                    # only needed for the browser check
```

`.env` is gitignored. The backend loads it once at startup and never overrides a variable that is already set in the environment. Empty lines are ignored.

## Running

Start the backend and the UI in two terminals:

```bash
# terminal 1: API on http://127.0.0.1:8000 (routes under /api, health check at /api/health)
cd backend && ../.venv/bin/python -m empyrean.main

# terminal 2: UI on http://127.0.0.1:5173
cd frontend && npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open http://127.0.0.1:5173 (use `localhost` or `127.0.0.1`: the browser only allows the microphone for Dictate in a secure context). The Vite dev server proxies `/api` to `http://127.0.0.1:8000`, so the browser only talks to port 5173. The UI is meant to be used through the dev server. `npm run build` type-checks and builds `frontend/dist`, but the backend does not serve it.

Backend options (environment variables or `.env`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `EMPYREAN_API_HOST` / `EMPYREAN_API_PORT` | `127.0.0.1` / `8000` | Where the API listens |
| `EMPYREAN_WORLDS_DIR` | `<repo>/worlds` | Where run data is written |
| `EMPYREAN_DEFAULT_MODEL` | `claude-cli-haiku` | The model a new run starts from (the New session form, `GET /api/defaults`, the assistant's create-run briefs). Falls back to `fake-heuristic` when the key is unknown or unavailable (no `claude` on PATH) |
| `EMPYREAN_MODELS_FILE` | `backend/empyrean/models.example.json` | Model registry |
| `EMPYREAN_LOG_LEVEL` | `INFO` | Backend log level |
| `EMPYREAN_FSYNC` | `1` | `0` skips fsync of turn files: commits are about 2.5x faster and a process crash is still safe, but a power loss is not |
| `EMPYREAN_FSYNC_WORKERS` | `8` | Threads that fsync turn files in parallel |
| `EMPYREAN_MODEL_CONCURRENCY` | `16` | Model calls that run at once, shared by every open run in the process. Every agent decides at round start and the round's calls run together, so a round costs about one call's latency (A-SCHED-5). Each `claude_cli` call is a ~250 MB subprocess: lower it on a small machine |
| `EMPYREAN_CODE_REVISION` | `dev` | Label written into each manifest and turn record |
| `EMPYREAN_API_PROXY` (frontend) | `http://127.0.0.1:8000` | Where the Vite dev server sends `/api` |
| `EMPYREAN_ASSISTANT_MODEL_CHAT` | `claude-cli-sonnet-assistant` | Model key of the assistant drawer |
| `EMPYREAN_ASSISTANT_MODEL_NARRATOR` | `claude-cli-haiku-assistant` | Model key that writes storybook entries |
| `EMPYREAN_ASSISTANT_MODEL_AUTHOR` | `claude-cli-sonnet-assistant` | Model key of Story Mode (brief and chapters) |
| `EMPYREAN_ASSISTANT_MODEL_SUMMARIZER` | `claude-cli-haiku-assistant` | Model key for conversation memory and story-so-far summaries |
| `EMPYREAN_ASSISTANT_CHAT_BUDGET_USD` | `5.0` | Assistant chat spend limit per scope (a run, or the global pages) |
| `EMPYREAN_ASSISTANT_STORYBOOK_BUDGET_USD` | `2.0` | Storybook spend limit per run |
| `EMPYREAN_ASSISTANT_STORY_BUDGET_USD` | `5.0` | Spend limit per Story Mode job (the story brief may set its own) |
| `EMPYREAN_ASSISTANT_MESSAGE_BUDGET_USD` | `0.75` | Spend limit per assistant message (all its steps) |
| `EMPYREAN_ASSISTANT_GLOBAL_BUDGET_USD` | `20.0` | Assistant spend limit across everything in this backend |
| `EMPYREAN_STORYBOOK_AUTO` | `off` | `on` / `off` / `auto`: automatic narration of new runs while they play (`off`: the storybook is written only on request; `auto`: on unless a paid narrator would narrate an all-fake-agent run) |
| `EMPYREAN_WHISPER_MODEL` | `large-v3-turbo` | Whisper model for Dictate (`medium` and `small` are faster, less accurate; `off` disables Dictate) |
| `EMPYREAN_WHISPER_PRELOAD` | `1` | Load the Whisper model when the backend starts (about 16 s, in the background) |

Assistant budgets are list-price estimates in USD and are metered separately from the agents' `real_usage`; per-run limits can also be raised in the UI. See [docs/ASSISTANT.md](docs/ASSISTANT.md).

To run a second, separate instance (for example for tests), give it its own port and worlds folder:

```bash
cd backend && EMPYREAN_API_PORT=8011 EMPYREAN_WORLDS_DIR=/tmp/empyrean-worlds ../.venv/bin/python -m empyrean.main
cd frontend && EMPYREAN_API_PROXY=http://127.0.0.1:8011 npx vite --host 127.0.0.1 --port 5181 --strictPort
```

Only one backend process may have a given run open at a time. A second process gets `409 illegal_command` ("open in another process") when it tries to open it, though it can still read the run's history.

## Using the UI

### Create a run

1. On the entry page choose **New session**.
2. The form starts with 8 prefilled agent cards. You can have 6 to 64 (**Add agent**; **Remove** in the table or **Remove this agent** in the card dialog). Each card has an id, a name, a start point, all stats and a model. The form also holds the world settings (seed, plants, fruit), the context and memory settings, the play delay and an optional real-money budget (`real_budget_usd`).
3. **Validate setup** lists every problem by its path, for example `agents[2].stats.compute: must be a finite number >= 0`. Nothing is created until the problems are fixed.
4. **Create and open** creates the run. It always opens **Paused** at `r00000_init`.

When a model key with a real provider is chosen, the form warns that every decision is a paid call. Models that are missing credentials are listed as unavailable, with the variables they need.

### Run controls

| Control | What it does |
| --- | --- |
| **Advance 1 turn** | Runs one agent turn (or the round-end step when the round is complete), saves it, then pauses |
| **Start simulation** | Keeps running turns, waiting the play delay between them |
| **Pause simulation** | Stops before the next turn. A turn that is already running, including a model call in progress, finishes and is saved first, so the badge shows "Pause requested" and then "Paused" |
| **Finish round** | Runs until the round-end checkpoint `r{n}_end` is saved |
| **Recover (pause)** | Shown in the error state. It discards the failed turn, reloads the last saved checkpoint and pauses; the next Advance 1 turn re-runs the same turn |

Start and pause share one button. To watch saved actions, open **Replay** on the left: choose a round and turn, then **Play saved turns**. Playback continues across rounds through the latest saved turn, including turns saved while playing. At the latest turn, **Replay from start** begins at the first checkpoint. **Animate this turn** repeats only its visual cues; **Speed** offers 0.5×, 1×, 2× and 4×. Replay only reads saved checkpoints and never generates turns. Mouse-wheel zoom works in both views.

The board fills the workspace. The top bar holds simulation controls, the 2D/3D switch and **Session & agents**, **Inspector & tools**, and **Activity log**. These panels open over the board without resizing it; Close or Escape dismisses them. Session ids are under **Session details** in the session panel; secondary status facts are under **Turn details & model usage**. The status bar shows the run state, the acting agent, a pending model call with a running timer, and running totals of calls, tokens and provider cost. The log shows events as they happen.

### Inspect and go back in time

- Click a map point to list every occupant in the **Inspector** tab. Click an entity (a map dot, an occupant row, a roster row, or **Profile** in the Inspector) to open its profile card over the page; the board stays visible behind it. A list on the side of the card picks a section. For an agent: **Overview** (stats, totals, model, last action), **Decisions** (every turn it acted in, newest first, with its thought, action, result and cost, and buttons to view that turn or open its decision packet and model call record), **Skills**, **Knowledge** (believed self, notebook, memory priorities, records), **Messages** and **History**. For a plant: **Overview**, **Growth**, **Rules** (the species rule, with **Stage species rule change**) and **History**; fruit, seeds and residue have **Overview** and **History**. Everything in the card is as of the viewed turn. Escape or **×** closes it.
- The map draws what the viewed turn did: the acting agent gets a badge naming its action (red when it failed), a move gets an arrow, and rings mark the entities it touched; the line under the map says the same in words ("Turn r00012_t03_a03 · Aster (a03) moved up"). **Action marks** in the legend hides them, and **Key** explains every mark and colour. Dots have one size per zoom level, with distinct silhouettes for plants, fruit, seeds and residue; a crowded cell packs its dots and shows its total in a count badge (click it to list everyone there), **Zoom in** spreads them, and far out each occupied cell becomes one group tile (bigger = more, blue = an agent is there).
- **3D view** (the switch above the map; **2D map** goes back) shows the same turn as a board you can fly over: land flat, mountains raised, water sunk, one figure per entity, a label over each agent and a chip over the actor naming its action. Fly with W A S D, Space and Shift, drag to look around, use the wheel to zoom, and click a figure or its label to open its profile card; **Animate once** plays that turn’s visual cues again. The lightweight CPU Canvas 2D renderer is downloaded only when you choose the view (or hover its switch); it does not use WebGL, and the choice is remembered in the browser.
- Previous/next round, previous/next turn and the turn list in the left Replay panel move through history. An orange HISTORY band names the turn you are viewing. **Return to live** goes back.
- **Create continuation from turn** (in God mode) starts a new run from the viewed turn. The original run and its later turns are left untouched.
- The **Turn record** tab tells what happened in the viewed turn from the recorded facts; the **Rules** tab shows the rules and settings in force.

### God mode

The **God mode** tab can set a stat, place or remove an entity, send a voice to one agent, to selected agents or to everyone, change species rules, prices, context settings, model assignments and run settings. Edits are staged. They apply at the start of the next turn and are recorded in that turn as interventions with before/after values. Edits staged by the assistant carry the origin `assistant`.

### The assistant

Open it with **Assistant** in the run page’s session panel, the button at the bottom right of other pages, or Alt+A. Ask in plain language: how something works, what a control does, what is happening, why the run stopped, what an agent is up to. Answers link to turns, entities and docs sections. When you ask it to do something ("set up a fight arena with 10 agents", "step 3 rounds", "give a01 50 compute") it shows an execution brief with what will happen and any problems; nothing happens until you press **Approve**. Spend is shown in the drawer; the default models are Sonnet (chat, Story Mode) and Haiku (storybook, summaries) through the Claude Code CLI. **Dictate** (the microphone) transcribes speech into the text box. Details: [docs/ASSISTANT.md](docs/ASSISTANT.md).

### Storybook and Story Mode

The **Storybook** tab on the run page is an AI-written narrative with one entry per turn. By default it is written only on request: **Write missing** narrates the turns so far and shows the estimated cost first, and the tab's auto toggle (or `EMPYREAN_STORYBOOK_AUTO=on`/`auto`) narrates new turns while a run plays. The **Turn record** stays the source of truth.

**Story Mode** on the entry page turns any run into a chaptered story: pick a run, choose genre, tone, vividness and point of view, review the story brief with its cost estimate, accept it, and read the chapters as they are written. The story exports to Markdown.

### Resume a run

On the entry page choose **Resume session**. The list shows each run's name, last saved round and turn, and save time. Opening a run resumes it paused at its last saved turn; **Story** on a row opens Story Mode for that run. **Back to sessions** closes the run you are in; if a turn is running it is finished and saved first.

To tidy the list, select runs with the checkboxes: click a row to select it, Ctrl-click (Cmd on a Mac) to add or remove runs, and Shift-click to add a range. **Archive selected** moves them to the archive, which hides them from the list and keeps all their data; **Archived runs** shows the archive, where **Restore** brings a run back. **Delete selected…** asks for confirmation and then removes the run folders permanently; a run that is still open is refused, so leave it first.

## Literal god mode: edit files, then reload

Every run has a `working/` folder with a human-editable copy of the latest saved checkpoint. The UI shows its absolute path, and `working/README.txt` explains each file.

1. Pause the run. Every saved turn overwrites `working/`, so edit only while paused.
2. Edit any JSON file in `working/` (agent stats in `entities/agents/<id>.json`, knowledge in `entities/knowledge/<id>.json`, plants in `entities/plants.json`, rules in `rules.json`, settings in `settings.json`, and so on).
3. Click **Reload working/ files**, or call `POST /api/runs/{run_id}/working/reload`.
   - If anything is invalid, the errors name the file and the problem, and nothing changes.
   - If it is valid, the response lists every changed field with its before and after value, and one `apply_working_files` intervention is staged. It is applied at the next turn, and only if the run is still at the same saved turn (`working/BASE_TURN`).


## Where run data lives

Runs are written under `EMPYREAN_WORLDS_DIR` (default `worlds/`, gitignored):

```
worlds/world_<YYYYmmdd_HHMMSS>_<hex>/runs/run_<YYYYmmdd_HHMMSS>_<hex>/
  manifest.json            commit point: current turn, counters, real-usage ledger, parent (for continuations)
  run_request.json         the request the run was created from
  assumptions.json         the assumption table in force at creation
  staged_snapshots/        snapshots of staged file reloads
  working/                 editable copy of the latest checkpoint (see above)
  turns/
    index.jsonl            one line per saved turn
    r00000_init/           the initial checkpoint
    r00001_t01_a03/        round 1, turn 1, agent a03
    ...
    r00001_end/            round-end step (plants, fruit, upkeep, deaths)
  assistant/               the assistant's data for this run (never inside turns/)
    settings.json          storybook auto flag and budgets
    usage.jsonl            the run's assistant spend ledger
    storybook/entries/     one JSON file per narrated turn (opening.json for the opening)
    stories/<story_id>/    Story Mode sessions and chapters
worlds/_assistant/         every assistant conversation (conversations/<id>/) and the global assistant ledger
```

Each turn folder is a complete, readable checkpoint:

```
turns/r00001_t05_a07/
  state.json               turn record: acting agent, decision source, action, result, interventions
  events.json              the events of this turn, in order
  world.json               round, id counters, rng state, agent order, and knowledge_files
  map.json  rules.json  settings.json
  entities/agents/<id>.json          every agent
  entities/knowledge/<id>.json       only for agents whose knowledge changed this turn
  entities/plants.json  fruits.json  seeds.json  residues.json  removed.json
  decision_packets/pk_<turn_id>.json exactly what the model was given
  model_calls/index.json
  model_calls/mc_<turn_id>_01.json   request, raw output, parsed decision, usage, cost, latency
```

`world.json` holds a `knowledge_files` map that names, for every agent, the turn folder holding its current knowledge file, so every turn can be loaded and inspected on its own. Turn ids and every other id are defined in `docs/INTERFACES.md` §3; the file formats are in §5.

Browsing history only reads these files. It never makes a model call.

## Models and credentials

Models are defined in `backend/empyrean/models.example.json`. Agent cards and run defaults refer to a model by its key. To use your own registry, copy the file and point `EMPYREAN_MODELS_FILE` at the copy.

| Key | Provider | Needs |
| --- | --- | --- |
| `fake-heuristic`, `fake-scripted`, `fake-malformed` | `fake` | Nothing. Deterministic stand-ins; only `fake-heuristic` is offered in the pickers (the other two are test doubles, listed by `GET /api/models?include_test=1`) |
| `fake-assistant` | `fake` | Nothing. Deterministic assistant stand-in (tests, demos); assistant only |
| `claude-cli-haiku`, `claude-cli-haiku-prompted` | `claude_cli` | The `claude` CLI on `PATH`, logged in. No variable in `.env` |
| `claude-cli-sonnet-assistant`, `claude-cli-haiku-assistant` | `claude_cli` | The `claude` CLI, logged in. Assistant only (per-call caps USD 0.25 / 0.08) |
| `anthropic-haiku` | `anthropic` | `ANTHROPIC_API_KEY` |
| `openai-mini` | `openai` | `OPENAI_API_KEY` |
| `fireworks-llama` | `fireworks` | `FIREWORKS_API_KEY` |
| `bedrock-haiku` | `bedrock` | The boto3 default credential chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, profiles or roles); `AWS_REGION` overrides the entry's region |
| `foundry-gpt` | `foundry` | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` |

`GET /api/models` reports, for each key, whether it is available and which variables are missing. The New session form shows the same information. Keys marked assistant only (`options.assistant_only` in the registry) are hidden from that list unless `?include_assistant=1` and are rejected on agent cards and in god mode.

How secrets are handled:

- The registry holds variable **names** only (`credential_env`). Values come from the environment or `.env`.
- Only `model.py` reads credential values. They are never sent to the frontend and never written to logs or run folders; error texts are scrubbed of credential values before they are stored.
- The `claude_cli` adapter starts the CLI with a minimal environment (`PATH`, `HOME`, locale and a few others), so none of the keys above reach it.
- Keep `.env` out of version control (it is in `.gitignore`), and never put a key into a registry file.

Only the `fake` and `claude_cli` adapters have been run on this machine. The other adapters have been tested against recorded or mocked payloads only (see [docs/TEST_EVIDENCE.md](docs/TEST_EVIDENCE.md)).

## Headless driver

`scripts/run_sim.py` creates a run from the defaults, advances it round by round and prints a summary: agents, actions, model calls, compute charged, provider usage, deaths, the world and the storage used per turn. It runs the backend in-process, so no server is needed, and it writes run data in the normal layout, so you can open the run afterwards with **Resume session**.

```bash
# fake model: free, about 3 seconds for 8 agents x 3 rounds
.venv/bin/python scripts/run_sim.py --model fake-heuristic --agents 8 --rounds 3 --seed 1 \
    --worlds-dir /tmp/empyrean-worlds --name "fake 8x3"

# a scenario: a partial run request deep-merged onto the defaults
.venv/bin/python scripts/run_sim.py --request scripts/scenarios/arena_fight.json --rounds 5
```

Options: `--model KEY` (default `fake-heuristic`), `--agents N` (6 to 64, default 8), `--rounds R` (default 3), `--seed S` (default 1), `--worlds-dir PATH` (default `EMPYREAN_WORLDS_DIR` or `worlds/`), `--name NAME`, `--request FILE` (a JSON overlay: `world`, `rules` and `context` are deep-merged, other keys such as `agents` replace the default; see `scripts/scenarios/`), `--assistant` (run the assistant service in-process so the storybook is written; a paid narrator writes only with `EMPYREAN_ALLOW_LIVE=1`), `--live-check`, `--timeout SECONDS` (default 900).

**Live models cost real money.** The script refuses any model whose provider is not `fake` unless `EMPYREAN_ALLOW_LIVE=1` is set:

```bash
# one decision only: prints the call's usage, cost and billed/estimate ratio
EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/run_sim.py --model claude-cli-haiku --live-check

# a short live run
EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/run_sim.py --model claude-cli-haiku \
    --agents 8 --rounds 3 --seed 1 --name "live 8x3"
```

For scale: with `claude-cli-haiku`, 8 agents x 3 rounds (24 decisions) cost about USD 0.14, roughly USD 0.006 per decision. The script sets no overall budget. The only cap is the per-call `max_budget_usd` (USD 0.05) in the `claude_cli` registry entries; the other providers have no cap in a headless run. Keep rounds small, or create the run in the UI with a real budget set.

Exit status: 0 on success; 1 on an exception, a run that ends in the `error` state or a failed live check; 2 when the model is refused or unknown.

## Tests

Run these from the repository root:

```bash
# all backend tests (unit + end-to-end, fake models only): about 50 s
(cd backend && ../.venv/bin/pytest -q)

# end-to-end tests only (public API routes, temporary worlds folder)
(cd backend && ../.venv/bin/pytest -q tests/test_e2e_*.py)

# live provider tests: skipped unless EMPYREAN_LIVE_TESTS=1; they make real, paid calls
(cd backend && EMPYREAN_LIVE_TESTS=1 EMPYREAN_LIVE_MODELS=claude-cli-haiku ../.venv/bin/pytest -q -m live)

# Whisper tests (marked `whisper`): run only when the model is already in the local cache
(cd backend && ../.venv/bin/pytest -q -m whisper)

# docs consistency (also part of the backend suite)
.venv/bin/python scripts/check_docs.py

# frontend: unit tests of the pure state modules, type-check, lint, build
(cd frontend && node src/state/state.test.mjs && npx tsc -p tsconfig.app.json --noEmit && npm run lint && npm run build)

# assistant: replay stored malformed CLI replies through the salvage (no model call)
.venv/bin/python scripts/assistant_replay_malformed.py

# assistant playtest across model tiers: LIVE, costs money (the 2026-09-26 pass cost about USD 11)
EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/assistant_playtest.py chat --arm haiku --max-spend 3.5
```

`EMPYREAN_LIVE_MODELS` takes a comma-separated list of registry keys that have credentials configured. The Whisper tests read a sample clip from `EMPYREAN_WHISPER_TEST_AUDIO` / `EMPYREAN_WHISPER_SAMPLE` or the default fixture path and skip when it is missing; `EMPYREAN_TEST_ENDPOINT` and `EMPYREAN_TEST_DEPLOYMENT` are placeholders the adapter unit tests use for the Azure registry entry. No test ever calls a paid model unless `EMPYREAN_LIVE_TESTS=1`.

## Browser check

`qa/browser_check.mjs` drives the real UI in headless Chromium: entry page, cards, validation, run controls, timeline, crowded map point, entity profile cards, plant rules, god mode, resume and error recovery, plus the assistant drawer, a brief, the Storybook tab and Story Mode with fake models. Every run it creates uses the free `fake-heuristic` agent model. It saves a screenshot per step and a `log.json` to `qa/out/<timestamp>/`. Start the backend and the dev server first, then:

```bash
cd qa && node browser_check.mjs                  # uses BASE_URL=http://127.0.0.1:5173, API_URL=http://127.0.0.1:8000
```

It creates runs (named `qa browser …`) in the backend's worlds folder. To keep them apart from your own runs, point it at a second instance (see [Running](#running)) with `BASE_URL` and `API_URL`. Exit status: 0 when every step passed, 1 when a step failed, 2 when the script aborted. See `qa/README.md` for all options.

Against a backend with live assistant models the script skips the assistant steps that would call a model, so it never spends. To run all of them for free, use the QA backend, which forces every assistant profile to `fake-assistant` and lets the script choose the fake answers:

```bash
.venv/bin/python qa/assistant_fake_server.py                                        # port 8020, worlds qa/worlds-assistant
cd frontend && EMPYREAN_API_PROXY=http://127.0.0.1:8020 npx vite --port 5180 --strictPort
cd qa && BASE_URL=http://127.0.0.1:5180 API_URL=http://127.0.0.1:8020 node browser_check.mjs
```

## Scope

This is a local, single-operator prototype. The backend listens on `127.0.0.1` and has no authentication. Do not expose it on a network: anyone who can reach it can spend your model budget through the assistant. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for what is not done yet.
