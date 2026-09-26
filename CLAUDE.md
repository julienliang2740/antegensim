# Working on Empyrean (antegensim): rules for agents and humans

This file is the coding practice for everyone who changes this repository, people and AI
coding agents alike. Read it before your first edit. [docs/INDEX.md](docs/INDEX.md) lists every
other document; [docs/SYSTEM.md](docs/SYSTEM.md) explains how the simulation works and
[docs/CODE_MAP.md](docs/CODE_MAP.md) says where each piece lives.

## Environment and exact commands

Python 3.12 in a virtualenv at the repository root (`.venv/`), Node 20.19+/22.12+ for the
frontend. Setup is in [README.md](README.md#setup). Always use the venv interpreter; never
install into the system Python.

| What | Command (from the repository root) |
| --- | --- |
| All backend tests (fake models only, ~1 min) | `cd backend && ../.venv/bin/pytest -q` |
| One backend test file | `cd backend && ../.venv/bin/pytest -q tests/test_runner.py` |
| Docs consistency check (also runs inside `pytest -q`) | `.venv/bin/python scripts/check_docs.py` |
| Frontend type check, lint and state tests | `cd frontend && npx tsc -p tsconfig.app.json --noEmit && npm run lint && node src/state/state.test.mjs` |
| Frontend production build | `cd frontend && npm run build` (one build at a time; it rewrites `frontend/dist`) |
| Headless run (fake model, free) | `.venv/bin/python scripts/run_sim.py --model fake-heuristic --agents 8 --rounds 3` |
| Backend server | `cd backend && ../.venv/bin/python -m empyrean.main` |
| Frontend dev server | `cd frontend && npm run dev -- --host 127.0.0.1 --port 5173 --strictPort` |
| Browser check (needs both servers; the 8 model-calling assistant steps skip themselves on a live backend) | `cd qa && node browser_check.mjs` |
| Browser check, all 33 steps on fake assistant models | `.venv/bin/python qa/assistant_fake_server.py`, then `cd frontend && EMPYREAN_API_PROXY=http://127.0.0.1:8020 npx vite --port 5180 --strictPort`, then `cd qa && BASE_URL=http://127.0.0.1:5180 API_URL=http://127.0.0.1:8020 node browser_check.mjs` |

Tests never spend money. Every test uses fake model keys (`fake-heuristic`, `fake-scripted`,
`fake-malformed`, `fake-assistant`). Live tests are marked `@pytest.mark.live` and run only
with `EMPYREAN_LIVE_TESTS=1`; `scripts/run_sim.py` refuses a paid model unless
`EMPYREAN_ALLOW_LIVE=1`. Never set either variable in `.env`, in a test, or in a script you
commit; set it on the command line for one deliberate, budgeted run.

## Model calls: only through `model.py`

Every call to a language model or to speech recognition goes through
`backend/empyrean/model.py` (`call_model`, `transcribe`). No other module imports a provider
SDK (`anthropic`, `openai`, `boto3`, `botocore`, `httpx`, `requests`), `subprocess` (except
`storage.py`), or the Whisper stack (`faster_whisper`, `ctranslate2`, `av`), and no module
outside `model.py` branches on a provider name. The assistant reaches `model.call_model` through
`backend/empyrean/assistant/calls.py`, which also meters the call in the assistant ledger.

The boundary is enforced by `backend/tests/test_e2e_boundaries.py`
(`test_provider_sdks_are_imported_only_by_model_py` scans every `.py` file under
`backend/empyrean/` recursively). Do not add an allowlist entry to make a new module pass; move
the provider code into `model.py` instead.

## Secrets

* Credentials live only in `.env` at the repository root, which is gitignored. `.env.example`
  is committed and holds variable names with **empty** values and comments, never a value.
* The model registry (`models.example.json` or `EMPYREAN_MODELS_FILE`) stores variable
  **names** (`credential_env`), never values.
* Only `model.py` adapters read credential values. Nothing sends them to the frontend, writes
  them to logs, run folders, assistant conversations or ledgers, or puts them into a prompt.
  Error texts pass through `model.redact` before they are stored or shown.
* The `claude_cli` adapter runs the CLI with a minimal environment
  (`config.CLAUDE_CLI_ENV_ALLOWLIST`); keep it minimal.
* Assistant prompts contain no environment values; its server-log tool reads a redacted ring
  buffer of `empyrean.*` loggers only.
* Never commit `worlds/`, `.env`, `*.log`, `*.pid`, `qa/out/` or screenshots outside
  `docs/evidence/`.

## Commits

* Author and committer: **Julien Liang <julienliang2740@gmail.com>** (already the git config).
* Never add AI attribution: no `Co-Authored-By` for Claude or any tool, no "Generated with ...",
  no Claude/Anthropic/AI mention in commit messages or pull requests.
* One logical change per commit, with a message that says what changed and why.
* Do not commit with failing checks: backend tests, frontend checks and the docs check must
  all pass.

## Docs rule: every behaviour change updates the docs in the same commit

The docs are read by people and loaded by the built-in assistant as its knowledge
(docs/INDEX.md marks which docs it loads). A stale doc makes the assistant give wrong answers.

1. When you change behaviour (a rule, a default, a route, a control label, a file layout, an
   environment variable, a test that the test plan names), update the owning doc from the table
   below **in the same commit**.
2. Run `.venv/bin/python scripts/check_docs.py`; it must print `docs check: clean`. The same
   check runs in `pytest -q` through `backend/tests/test_docs_consistency.py`.
3. Numbers that describe defaults are labelled "shipped default"; the per-run truth is the
   Rules tab (`GET /api/runs/{run_id}/rules`) and `docs/ASSUMPTIONS.md` lists every default with
   its config key.

What the checker compares (see the docstring of `scripts/check_docs.py`): backticked repo paths
and `path::Symbol` references; the served routes against `docs/INTERFACES.md` section 9, the
`api.py` docstring and the frontend wrappers; registry keys against the README models table;
every `EMPYREAN_*` variable read in code against README and `.env.example`; `config.ASSUMPTIONS`
against `docs/ASSUMPTIONS.md`; test ids in `docs/TEST_PLAN.md` against `pytest --collect-only`;
bold control labels in `docs/CONTROLS.md` against literals in `frontend/src`; forbidden stale
phrases; and that `docs/INDEX.md` lists every doc.

### Doc ownership map

| When you change ... | Update |
| --- | --- |
| Rules, costs, actions, skills, knowledge, round order (`world.py`, `skills.py`, `context.py`) | `docs/SYSTEM.md`, `docs/GLOSSARY.md`, `docs/INTERFACES.md` section 4, `frontend/src/pages/InstructionsPage.tsx` text |
| A default value or an open rule (`config.py`, `config.ASSUMPTIONS`) | `docs/ASSUMPTIONS.md` (ids must match) |
| A route, request or response model (`api.py`, `assistant/routes*.py`, `schemas.py`) | `docs/INTERFACES.md` section 9, the `api.py` docstring table, `frontend/src/api/*.ts`, `docs/ASSISTANT.md` for assistant routes |
| Storage layout (`storage.py`, `assistant/store.py`) | `docs/INTERFACES.md` section 5, `docs/SYSTEM.md` "Storage", `docs/sample_run/README.md` |
| Events (`EventKind`) | `docs/INTERFACES.md` section 7, `docs/GLOSSARY.md` |
| A UI control, label, tab or route | `docs/CONTROLS.md`, README "Using the UI", `qa/browser_check.mjs` locators, `qa/README.md` |
| The assistant (profiles, tools, briefs, budgets, storybook, Story Mode, Dictate) | `docs/ASSISTANT.md`, `docs/CONTROLS.md`, `docs/LIMITATIONS.md` |
| An environment variable | README "Backend options", `.env.example` |
| Model registry entries | README "Models and credentials" |
| A file added, moved or removed | `docs/CODE_MAP.md` |
| Tests | `docs/TEST_PLAN.md`; fresh results in `docs/TEST_EVIDENCE.md` |
| Known limits | `docs/LIMITATIONS.md` |
| A new doc | `docs/INDEX.md` (with its `assistant: yes|no` flag) |

## Change control for shared contracts

These files are the contracts every part of the system builds against:
`backend/empyrean/schemas.py`, `backend/empyrean/config.py`, `backend/empyrean/api.py`,
`frontend/src/api/types.ts` and `frontend/src/api/client.ts` (and, for the assistant,
`backend/empyrean/assistant/models.py` with its mirrors `frontend/src/api/assistantTypes.ts` and
`frontend/src/api/storyTypes.ts`). They may be edited, under these rules:

1. Change the Python model and its TypeScript mirror in the same commit; add fields with
   defaults so stored JSON stays readable (stored records use `LooseModel`).
2. Update `docs/INTERFACES.md` (the section that describes the change, and section 14's
   revision list) and any doc named in the ownership map, in the same commit.
3. A new `ApiErrorCode` is added to `schemas.py`, `types.ts`, the `api.py` docstring and
   `docs/INTERFACES.md` section 9 together.
4. When several people or agents work in parallel, one owner edits a shared file at a time;
   everyone else writes the exact change they need into a handoff note (for agent work
   packages: the scratchpad `handoff/<package>.md`) and the lead applies it. Never work around
   a missing field by stuffing data into untyped `details` dictionaries.

## Code conventions

* Every module starts with a docstring that says its role; every public function has a
  docstring. New modules also carry a one-line `# DOCS:` comment summarising what a docs
  writer must know.
* Backend: Pydantic v2 `StrictModel` for requests and model output, `LooseModel` for stored
  records; plain `def` routes (thread pool) unless a route must stream a body; errors raise
  `api.ApiException` with a code from `schemas.ApiErrorCode`; write files with
  `storage.atomic_write_json`.
* Frontend: React 19 + TypeScript strict (`verbatimModuleSyntax`: use `import type`;
  `erasableSyntaxOnly`: no `enum`); pure logic lives in `frontend/src/state/*.ts` and is tested
  by `src/state/state.test.mjs`; API calls go through `frontend/src/api/`.
* Keep playback model-free: browsing history never calls a model
  (`test_playback_reads_history_without_model_calls`).
* The assistant never mutates anything without an approved brief; UI-only navigation
  (select, view a turn, switch a tab) needs no approval.
