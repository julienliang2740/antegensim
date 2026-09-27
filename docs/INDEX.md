# Documentation index

One line per document: what it is for, who it is written for, and whether the built-in assistant
loads it as knowledge (`assistant: yes`). The assistant's knowledge loader
(`backend/empyrean/assistant/knowledge.py`) reads the rows of the table below: it loads every
`assistant: yes` file and splits it into sections at `##` headings, addressed as
`<FILE>.md#<slug>`. `scripts/check_docs.py` fails when a file in `docs/` is missing here.

Row format (parsed): `` | `<repo path>` | purpose | audience | assistant: yes|no | ``.

| File | Purpose | Audience | Assistant |
| --- | --- | --- | --- |
| `README.md` | Setup, running, using the UI, run data layout, models, env vars, headless driver, tests | operators, developers | assistant: yes |
| `CLAUDE.md` | Coding practice: commands, model boundary, secrets, commits, the docs rule, change control | developers, coding agents | assistant: no |
| `docs/INDEX.md` | This list | everyone | assistant: no |
| `docs/SYSTEM.md` | How the simulation works end to end (the knowledge core's overview) | operators, developers, assistant | assistant: yes |
| `docs/GLOSSARY.md` | Every domain term as implemented | operators, developers, assistant | assistant: yes |
| `docs/CONTROLS.md` | Every UI control: page, label, effect, API, allowed states | operators, assistant, QA | assistant: yes |
| `docs/ASSISTANT.md` | The assistant: profiles, models, budgets, tools, briefs, storybook, Story Mode, Dictate, routes | operators, developers, assistant | assistant: yes |
| `docs/ASSUMPTIONS.md` | Every open rule with its config key and shipped default (mirror of `config.ASSUMPTIONS`) | operators, developers, assistant | assistant: yes |
| `docs/INTERFACES.md` | The contract: ids, state machine, module contracts, storage, decision JSON, events, API, interventions | developers | assistant: yes |
| `docs/CODE_MAP.md` | Where each piece lives: files with purpose and key `path::Symbol`s | developers, coding agents | assistant: no |
| `docs/TEST_PLAN.md` | Which test, script or browser step verifies each requirement | developers, QA | assistant: no |
| `docs/TEST_EVIDENCE.md` | What was tested and the results, mocked vs live | developers, QA | assistant: no |
| `docs/LIMITATIONS.md` | Known limits and defects, each with a next step | operators, developers, assistant | assistant: yes |
| `docs/sample_run/README.md` | A trimmed real run folder and how to read it | developers | assistant: no |
| `frontend/README.md` | Frontend structure, commands and conventions | developers | assistant: no |
| `qa/README.md` | The browser check (37 steps: 17 legacy, 16 assistant, Resume page housekeeping, the profile card, the 2D map marks and the 3D view; the fake QA server) and the resilience harness | QA | assistant: no |
| `llm_world_technical_spec.md` | Source requirements: the technical specification (v0.5) | developers | assistant: no |
| `llm_world_running_design.md` | Source requirements: the world design (v0.7) | developers | assistant: no |

Historical evidence (`docs/evidence/`: browser QA, live simulations, resilience runs, the
assistant playtest, screenshots) is a dated record of past checks and is not rewritten when the
code changes; `docs/TEST_EVIDENCE.md` summarises the current state. The assistant does not load it.

| File | Purpose | Audience | Assistant |
| --- | --- | --- | --- |
| `docs/evidence/assistant_playtest.md` | 2026-09-26 assistant playtest: model tiers per capability, salvage replay, spend, findings (per-call log `docs/evidence/assistant_playtest_calls.jsonl`) | developers, QA | assistant: no |
| `docs/evidence/assistant_sonnet_smoke.md` | 2026-09-26 Sonnet smoke: the salvaged chat step on the primary backend, five chat steps, narrator calls | developers, QA | assistant: no |
| `docs/evidence/browser_qa_assistant.md` | 2026-09-26 browser QA of the assistant steps 18-33 (logs `docs/evidence/browser_qa_assistant_fake.log.json`, `docs/evidence/browser_qa_assistant_primary.log.json`; screenshots `docs/evidence/screenshots/assistant/`) | developers, QA | assistant: no |
| `docs/evidence/browser_qa.md` | 2026-09-25 browser QA and reviewer passes of the simulation UI | developers, QA | assistant: no |
| `docs/evidence/live_sims.md` | 2026-09-25 live simulation runs and live tests (claude-cli-haiku) | developers, QA | assistant: no |
| `docs/evidence/resilience.md` | 2026-09-25 resilience and completion-criteria runs | developers, QA | assistant: no |

Knowledge core (always in the assistant's system prompt): `docs/SYSTEM.md#overview`,
`docs/GLOSSARY.md`, `docs/CONTROLS.md#quick-reference` and
`docs/ASSISTANT.md#rules-of-engagement`. Everything else marked `assistant: yes` is retrieved by
keyword overlap per question.
