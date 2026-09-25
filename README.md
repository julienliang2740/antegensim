# Empyrean prototype (antegensim)

Empyrean is a local, turn-based artificial-life world in which each agent is a language model: on its turn an agent gets a bounded decision packet built only from what it knows, returns one JSON decision, and the world engine applies the rules, costs and effects. Every turn is saved as a readable JSON checkpoint, so a run can be paused, inspected turn by turn, edited ("god mode") and continued from any point in its history.

The backend is Python 3.12 with FastAPI (`backend/empyrean`). The UI is Vite, React 19 and TypeScript (`frontend/`). Requirements are in `llm_world_technical_spec.md` and `llm_world_running_design.md`. The contract the code follows is `docs/INTERFACES.md`.

Documentation:

| File | What it holds |
| --- | --- |
| [docs/INTERFACES.md](docs/INTERFACES.md) | The contract: ids and the run state machine (§3), storage layout (§5), decision JSON (§6), events (§7), turn procedure (§8), API (§9), interventions (§10), fake models (§12), testing (§13) |
| [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) | Every rule the design leaves open, with its config key and default |
| [docs/TEST_EVIDENCE.md](docs/TEST_EVIDENCE.md) | What was tested, with fake models and with a live model, and the results |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | Known issues and limitations, each with a next step |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | Which test covers each requirement |

## Prerequisites

- Linux or macOS with Python 3.12.
- Node.js 20.19+ or 22.12+ (Vite 8 needs one of these; tested with Node 24.19) and npm.
- Optional, for live runs through `claude-cli-*` models: the Claude Code CLI installed as `claude` on `PATH` and logged in.
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

Open http://127.0.0.1:5173. The Vite dev server proxies `/api` to `http://127.0.0.1:8000`, so the browser only talks to port 5173. The UI is meant to be used through the dev server. `npm run build` type-checks and builds `frontend/dist`, but the backend does not serve it.

Backend options (environment variables or `.env`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `EMPYREAN_API_HOST` / `EMPYREAN_API_PORT` | `127.0.0.1` / `8000` | Where the API listens |
| `EMPYREAN_WORLDS_DIR` | `<repo>/worlds` | Where run data is written |
| `EMPYREAN_MODELS_FILE` | `backend/empyrean/models.example.json` | Model registry |
| `EMPYREAN_LOG_LEVEL` | `INFO` | Backend log level |
| `EMPYREAN_FSYNC` | `1` | `0` skips fsync of turn files: commits are about 2.5x faster and a process crash is still safe, but a power loss is not |
| `EMPYREAN_CODE_REVISION` | `dev` | Label written into each manifest and turn record |
| `EMPYREAN_API_PROXY` (frontend) | `http://127.0.0.1:8000` | Where the Vite dev server sends `/api` |

To run a second, separate instance (for example for tests), give it its own port and worlds folder:

```bash
cd backend && EMPYREAN_API_PORT=8011 EMPYREAN_WORLDS_DIR=/tmp/empyrean-worlds ../.venv/bin/python -m empyrean.main
cd frontend && EMPYREAN_API_PROXY=http://127.0.0.1:8011 npx vite --host 127.0.0.1 --port 5181 --strictPort
```

Only one backend process may have a given run open at a time. A second process gets `409 illegal_command` ("open in another process") when it tries to open it, though it can still read the run's history.

## Using the UI

### Create a run

1. On the entry page choose **New session**.
2. The form starts with 8 prefilled agent cards. You can have 6 to 11 (**Add agent card**, **Remove this card**). Each card has an id, a name, a start point, all stats and a model. The form also holds the world settings (seed, plants, fruit), the context and memory settings, the play delay and an optional real-money budget (`real_budget_usd`).
3. **Validate setup** lists every problem by its path, for example `agents[2].stats.compute: must be a finite number >= 0`. Nothing is created until the problems are fixed.
4. **Create and open** creates the run. It always opens **Paused** at `r00000_init`.

When a model key with a real provider is chosen, the form warns that every decision is a paid call. Models that are missing credentials are listed as unavailable, with the variables they need.

### Run controls

| Control | What it does |
| --- | --- |
| **Run turn** | Runs one agent turn (or the round-end step when the round is complete), saves it, then pauses |
| **Play** | Keeps running turns, waiting the play delay between them |
| **Pause** | Stops before the next turn. A turn that is already running, including a model call in progress, finishes and is saved first, so the badge shows "Pause requested" and then "Paused" |
| **Step round** | Runs until the round-end checkpoint `r{n}_end` is saved |
| **Recover (pause)** | Shown in the error state. It discards the failed turn, reloads the last saved checkpoint and pauses; the next Run turn re-runs the same turn |

The status bar shows the run state, the acting agent, a pending model call with a running timer, and running totals of calls, tokens and provider cost. The log shows events as they happen.

### Inspect and go back in time

- Click a map point to list every occupant; select one to open the inspector. For an agent you see stats, skills, knowledge, notebook, the decision packet it was given and the model call record (raw output, parsed JSON, usage, cost). For a plant you see the instance values and the species rules.
- Previous/next round, previous/next turn and the turn list move through history. An orange HISTORY band names the turn you are viewing. **Return to live** goes back.
- **Create continuation from turn …** starts a new run from the viewed turn. The original run and its later turns are left untouched.

### God mode

The **God mode** tab can set a stat, place or remove an entity, send a voice to one agent, to selected agents or to everyone, change species rules, change context settings, and change model assignments. Edits are staged. They apply at the start of the next turn and are recorded in that turn as interventions with before/after values.

### Resume a run

On the entry page choose **Resume session**. The list shows each run's name, last saved round and turn, and save time. Opening a run resumes it **Paused** at its last saved turn. **Back to sessions** closes the run you are in; if a turn is running it is finished and saved first.

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
| `fake-heuristic`, `fake-scripted`, `fake-malformed` | `fake` | Nothing. Deterministic stand-ins used by the tests |
| `claude-cli-haiku`, `claude-cli-haiku-prompted` | `claude_cli` | The `claude` CLI on `PATH`, logged in. No variable in `.env` |
| `anthropic-haiku` | `anthropic` | `ANTHROPIC_API_KEY` |
| `openai-mini` | `openai` | `OPENAI_API_KEY` |
| `fireworks-llama` | `fireworks` | `FIREWORKS_API_KEY` |
| `bedrock-haiku` | `bedrock` | The boto3 default credential chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, profiles or roles); `AWS_REGION` overrides the entry's region |
| `foundry-gpt` | `foundry` | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` |

`GET /api/models` reports, for each key, whether it is available and which variables are missing. The New session form shows the same information.

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
```

Options: `--model KEY` (default `fake-heuristic`), `--agents N` (6 to 11, default 8), `--rounds R` (default 3), `--seed S` (default 1), `--worlds-dir PATH` (default `EMPYREAN_WORLDS_DIR` or `worlds/`), `--name NAME`, `--live-check`, `--timeout SECONDS` (default 900).

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

# frontend: unit tests of the pure state modules, type-check + build, lint
(cd frontend && node src/state/state.test.mjs && npm run build && npm run lint)
```

`EMPYREAN_LIVE_MODELS` takes a comma-separated list of registry keys that have credentials configured.

## Browser check

`qa/browser_check.mjs` drives the real UI in headless Chromium through 17 steps: entry page, cards, validation, run controls, timeline, crowded map point, inspectors, plant rules, god mode, resume and error recovery. It saves a screenshot per step and a `log.json` to `qa/out/<timestamp>/`. Start the backend and the dev server first, then:

```bash
cd qa && node browser_check.mjs                  # uses BASE_URL=http://127.0.0.1:5173, API_URL=http://127.0.0.1:8000
```

It creates runs (named `qa browser …`) in the backend's worlds folder. To keep them apart from your own runs, point it at a second instance (see [Running](#running)) with `BASE_URL` and `API_URL`. Exit status: 0 when every step passed, 1 when a step failed, 2 when the script aborted. See `qa/README.md` for all options.

## Scope

This is a local, single-operator prototype. The backend listens on `127.0.0.1` and has no authentication. Do not expose it on a network. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for what is not done yet.
