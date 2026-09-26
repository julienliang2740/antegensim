# Code map

Where each piece lives: every source file with its purpose and its key symbols as
`path::Symbol` (no line numbers; `scripts/check_docs.py` verifies that every symbol exists).
Audience: developers and coding agents. For how the parts work together read
`docs/SYSTEM.md`; for exact contracts read `docs/INTERFACES.md`.

## Backend core (`backend/empyrean/`)

| File | Purpose | Key symbols |
| --- | --- | --- |
| `backend/empyrean/main.py` | Process entry point: registry, RunManager, AssistantService, app; Whisper preload thread | `backend/empyrean/main.py::build_app`, `backend/empyrean/main.py::start_whisper_preload`, `backend/empyrean/main.py::main` |
| `backend/empyrean/api.py` | FastAPI routes (thin: one manager call per route), error mapping, lifespan; the docstring holds the route table | `backend/empyrean/api.py::create_app`, `backend/empyrean/api.py::ApiException`, `backend/empyrean/api.py::InternalErrorMiddleware` |
| `backend/empyrean/config.py` | Every default, `.env` loading, the ASSUMPTIONS registry, the default run request, assistant and Whisper settings | `backend/empyrean/config.py::ASSUMPTIONS`, `backend/empyrean/config.py::default_run_request`, `backend/empyrean/config.py::default_rules`, `backend/empyrean/config.py::MAX_AGENTS`, `backend/empyrean/config.py::ASSISTANT_PRICES`, `backend/empyrean/config.py::estimate_tokens` |
| `backend/empyrean/schemas.py` | Shared Pydantic v2 models: rules, world, actions, decisions, events, turn records, interventions, API bodies, model requests/results | `backend/empyrean/schemas.py::RunCreateRequest`, `backend/empyrean/schemas.py::RulesConfig`, `backend/empyrean/schemas.py::Decision`, `backend/empyrean/schemas.py::Event`, `backend/empyrean/schemas.py::TurnRecord`, `backend/empyrean/schemas.py::Intervention`, `backend/empyrean/schemas.py::ModelRequest`, `backend/empyrean/schemas.py::ModelResult`, `backend/empyrean/schemas.py::TranscriptionResult`, `backend/empyrean/schemas.py::ApiErrorCode` |
| `backend/empyrean/world.py` | World truth and rules: generation, actions with quotes and charges, round end, deaths, god-mode world edits | `backend/empyrean/world.py::generate_world`, `backend/empyrean/world.py::apply_action`, `backend/empyrean/world.py::quote_action`, `backend/empyrean/world.py::end_round`, `backend/empyrean/world.py::compute_initiative`, `backend/empyrean/world.py::validate_world` |
| `backend/empyrean/skills.py` | Skill language: tokenizer, parser, save-time validation, compiler, resumable interpreter | `backend/empyrean/skills.py::parse_skill`, `backend/empyrean/skills.py::validate_and_build`, `backend/empyrean/skills.py::compile_skill`, `backend/empyrean/skills.py::run_until_action`, `backend/empyrean/skills.py::count_blocks` |
| `backend/empyrean/context.py` | Knowledge store, importance and retrieval, believed self, the decision packet, stable rules text, context settings validation | `backend/empyrean/context.py::build_packet`, `backend/empyrean/context.py::believed_self`, `backend/empyrean/context.py::stable_rules_text`, `backend/empyrean/context.py::rank_memories`, `backend/empyrean/context.py::cognition_cost`, `backend/empyrean/context.py::validate_settings` |
| `backend/empyrean/model.py` | THE model boundary: registry, adapters (fake, claude_cli, anthropic, openai/fireworks/foundry, bedrock), retries, usage and cost, text mode, cancellation, the decision format gate, local Whisper | `backend/empyrean/model.py::call_model`, `backend/empyrean/model.py::ModelRegistry`, `backend/empyrean/model.py::load_registry`, `backend/empyrean/model.py::parse_decision`, `backend/empyrean/model.py::redact`, `backend/empyrean/model.py::transcribe`, `backend/empyrean/model.py::whisper_status`, `backend/empyrean/model.py::preload_whisper`, `backend/empyrean/model.py::kill_inflight`, `backend/empyrean/model.py::ClaudeCliAdapter`, `backend/empyrean/model.py::FakeAdapter` |
| `backend/empyrean/models.example.json` | The model registry (keys, providers, credential variable names, capabilities, options) | registry keys are listed in README "Models and credentials" |
| `backend/empyrean/runner.py` | One worker thread per open run: state machine, turn procedure, commits, interventions, reload, continuations; RunManager owns the workers | `backend/empyrean/runner.py::RunManager`, `backend/empyrean/runner.py::RunWorker`, `backend/empyrean/runner.py::command_allowed`, `backend/empyrean/runner.py::validate_intervention_on`, `backend/empyrean/runner.py::turn_view`, `backend/empyrean/runner.py::RunManager.validate_setup`, `backend/empyrean/runner.py::RunManager.add_commit_listener` |
| `backend/empyrean/storage.py` | Files: run folders, atomic writes, checkpoints and the commit protocol, recovery, working/ reload, continuations, writer lock | `backend/empyrean/storage.py::write_checkpoint`, `backend/empyrean/storage.py::create_run`, `backend/empyrean/storage.py::recover_run`, `backend/empyrean/storage.py::load_checkpoint`, `backend/empyrean/storage.py::atomic_write_json`, `backend/empyrean/storage.py::find_run_dir`, `backend/empyrean/storage.py::apply_working_changes`, `backend/empyrean/storage.py::create_continuation` |

## Assistant (`backend/empyrean/assistant/`)

Every model call goes `calls.call_profile` -> `model.call_model`; every route is built by
`routes.build_routers`, the only hook `api.create_app` calls.

| File | Purpose | Key symbols |
| --- | --- | --- |
| `backend/empyrean/assistant/__init__.py` | Package entry; exports the service | `backend/empyrean/assistant/__init__.py::AssistantService` |
| `backend/empyrean/assistant/service.py` | AssistantService: executors (chat 2, story 1, storybook 1, speech 1), jobs, budgets, capabilities, commit fan-in, shutdown | `backend/empyrean/assistant/service.py::AssistantService`, `backend/empyrean/assistant/service.py::AssistantService.capabilities`, `backend/empyrean/assistant/service.py::AssistantService.on_commit`, `backend/empyrean/assistant/service.py::AssistantService.shutdown` |
| `backend/empyrean/assistant/models.py` | Every assistant Pydantic model: steps, brief actions, briefs, messages, conversations, jobs, budgets, storybook, stories, capabilities | `backend/empyrean/assistant/models.py::AnswerStep`, `backend/empyrean/assistant/models.py::BriefDraft`, `backend/empyrean/assistant/models.py::Brief`, `backend/empyrean/assistant/models.py::Message`, `backend/empyrean/assistant/models.py::ConversationView`, `backend/empyrean/assistant/models.py::StorybookEntry`, `backend/empyrean/assistant/models.py::StorySession`, `backend/empyrean/assistant/models.py::AssistantCapabilities`, `backend/empyrean/assistant/models.py::action_from_envelope` |
| `backend/empyrean/assistant/calls.py` | The single model-call path: budget check, request build with size asserts, cost settle, ledger line, salvage | `backend/empyrean/assistant/calls.py::call_profile`, `backend/empyrean/assistant/calls.py::build_request`, `backend/empyrean/assistant/calls.py::salvage`, `backend/empyrean/assistant/calls.py::ProfileCallResult` |
| `backend/empyrean/assistant/ledger.py` | `usage.jsonl` per scope, aggregates, prices, budget checks | `backend/empyrean/assistant/ledger.py::Ledger`, `backend/empyrean/assistant/ledger.py::BudgetExceeded`, `backend/empyrean/assistant/ledger.py::estimate_cost_usd`, `backend/empyrean/assistant/ledger.py::price_for` |
| `backend/empyrean/assistant/store.py` | Paths, conversation store with per-conversation locks, run settings, restart recovery | `backend/empyrean/assistant/store.py::AssistantPaths`, `backend/empyrean/assistant/store.py::ConversationStore`, `backend/empyrean/assistant/store.py::read_run_settings`, `backend/empyrean/assistant/store.py::write_run_settings` |
| `backend/empyrean/assistant/engine.py` | Chat step loop: prefetch, steps, tools, restricted last step, repair, offline answer, memory refresh | `backend/empyrean/assistant/engine.py::ChatEngine`, `backend/empyrean/assistant/engine.py::parse_step` |
| `backend/empyrean/assistant/prompts.py` | Byte-stable system prompts, the user message layout, nonce data fences, step schemas | `backend/empyrean/assistant/prompts.py::system_prompt`, `backend/empyrean/assistant/prompts.py::user_message`, `backend/empyrean/assistant/prompts.py::fence`, `backend/empyrean/assistant/prompts.py::step_schema`, `backend/empyrean/assistant/prompts.py::assert_sizes` |
| `backend/empyrean/assistant/knowledge.py` | Docs as knowledge: reads `docs/INDEX.md`, splits sections, knowledge core, retrieval, search | `backend/empyrean/assistant/knowledge.py::KnowledgeBase`, `backend/empyrean/assistant/knowledge.py::DocSection`, `backend/empyrean/assistant/knowledge.py::parse_index`, `backend/empyrean/assistant/knowledge.py::slugify` |
| `backend/empyrean/assistant/tools.py` | The read tools of the chat profile | `backend/empyrean/assistant/tools.py::TOOL_NAMES`, `backend/empyrean/assistant/tools.py::run_tool`, `backend/empyrean/assistant/tools.py::tool_catalogue` |
| `backend/empyrean/assistant/digest.py` | Deterministic, model-free digests of history: turns, rounds, trends, highlights, dossiers, run card | `backend/empyrean/assistant/digest.py::turn_digest`, `backend/empyrean/assistant/digest.py::round_digest`, `backend/empyrean/assistant/digest.py::trends`, `backend/empyrean/assistant/digest.py::get_highlights`, `backend/empyrean/assistant/digest.py::agent_dossier`, `backend/empyrean/assistant/digest.py::run_card` |
| `backend/empyrean/assistant/briefs.py` | Brief validation, setup diff, warnings, CAS approval, execution (incl. the step_round sequencer), deep merge | `backend/empyrean/assistant/briefs.py::validate_brief`, `backend/empyrean/assistant/briefs.py::approve_brief`, `backend/empyrean/assistant/briefs.py::execute_action`, `backend/empyrean/assistant/briefs.py::merge_create_run`, `backend/empyrean/assistant/briefs.py::deep_merge` |
| `backend/empyrean/assistant/storybook.py` | Storybook: auto rule, coalescing per-run job, batching, budget pause, opening entries | `backend/empyrean/assistant/storybook.py::StorybookService`, `backend/empyrean/assistant/storybook.py::default_auto`, `backend/empyrean/assistant/storybook.py::parse_batched` |
| `backend/empyrean/assistant/story.py` | Story Mode: run card, interview, story brief, lazy chapter job, summaries, continue, export | `backend/empyrean/assistant/story.py::StoryService` |
| `backend/empyrean/assistant/speech.py` | Dictate service side: speech executor with a bounded queue, preload thread, capability, initial prompt | `backend/empyrean/assistant/speech.py::SpeechService`, `backend/empyrean/assistant/speech.py::compose_initial_prompt` |
| `backend/empyrean/assistant/logbuffer.py` | Redacted ring buffer of `empyrean.*` log lines for the server-log tool | `backend/empyrean/assistant/logbuffer.py::RingBufferHandler`, `backend/empyrean/assistant/logbuffer.py::install` |
| `backend/empyrean/assistant/routes.py` | Core routers (capabilities, conversations, messages, jobs, briefs, run settings) and the 503 fallback | `backend/empyrean/assistant/routes.py::build_routers`, `backend/empyrean/assistant/routes.py::build_core_router`, `backend/empyrean/assistant/routes.py::build_unavailable_router` |
| `backend/empyrean/assistant/routes_storybook.py` | Storybook routes | `backend/empyrean/assistant/routes_storybook.py::build_router` |
| `backend/empyrean/assistant/routes_story.py` | Story Mode routes | `backend/empyrean/assistant/routes_story.py::build_router` |
| `backend/empyrean/assistant/routes_speech.py` | The raw-body transcribe route (async, 10 MB cap) | `backend/empyrean/assistant/routes_speech.py::build_router` |

## Backend tests (`backend/tests/`)

| File | Covers |
| --- | --- |
| `backend/tests/conftest.py` | fixtures (`worlds_dir`, `registry`, `manager`, `client`, `api`, `no_retry_sleep`), the `live` marker gate |
| `backend/tests/e2e_support.py` | `backend/tests/e2e_support.py::E2EApi`, `backend/tests/e2e_support.py::base_request` for the end-to-end tests |
| `backend/tests/test_world.py`, `test_skills.py`, `test_context.py`, `test_model.py`, `test_runner.py`, `test_storage.py`, `test_api.py` | unit tests per module |
| `backend/tests/test_e2e_run.py`, `test_e2e_rules.py`, `test_e2e_context.py`, `test_e2e_godmode.py`, `test_e2e_boundaries.py` | end-to-end through the public API; the provider boundary |
| `backend/tests/test_integration_rev3.py` | the revision-3 contract changes |
| `backend/tests/test_assistant_contracts.py` | the rev-4 shared contracts |
| `backend/tests/test_assistant_*.py` | assistant engine, briefs, store, ledger, knowledge, API, digest, storybook, story (fake models only) |
| `backend/tests/test_speech.py` | Dictate service and route (Whisper tests marked `whisper`) |
| `backend/tests/test_docs_consistency.py` | runs `scripts/check_docs.py` |

## Frontend (`frontend/src/`)

| File | Purpose | Key symbols |
| --- | --- | --- |
| `frontend/src/main.tsx` | mounts the app (or the dev inspect harness with `?harness=1`) | |
| `frontend/src/App.tsx` | route switch plus the assistant drawer on every page | `frontend/src/App.tsx::App` |
| `frontend/src/hooks/useHashRoute.ts` | hash router: entry, new, resume, run, instructions, story | `frontend/src/hooks/useHashRoute.ts::parseHash`, `frontend/src/hooks/useHashRoute.ts::routeHash`, `frontend/src/hooks/useHashRoute.ts::navigate` |
| `frontend/src/api/types.ts` | TypeScript mirror of `schemas.py` | `frontend/src/api/types.ts::ApiErrorCode`, `frontend/src/api/types.ts::RunStatus`, `frontend/src/api/types.ts::TranscriptionResult` |
| `frontend/src/api/client.ts` | typed fetch wrappers for the core routes; `request` helper and polling constants | `frontend/src/api/client.ts::request`, `frontend/src/api/client.ts::ApiClientError`, `frontend/src/api/client.ts::API_BASE`, `frontend/src/api/client.ts::listModels` |
| `frontend/src/api/assistant.ts`, `frontend/src/api/assistantTypes.ts` | assistant route wrappers and the mirror of `assistant/models.py` | `frontend/src/api/assistant.ts::postMessage`, `frontend/src/api/assistant.ts::approveBrief`, `frontend/src/api/assistant.ts::getAssistantCapabilities` |
| `frontend/src/api/story.ts`, `frontend/src/api/storyTypes.ts` | storybook, Story Mode and run-settings wrappers and types | `frontend/src/api/story.ts::getStorybook`, `frontend/src/api/story.ts::generateStorybook`, `frontend/src/api/story.ts::createStory` |
| `frontend/src/api/assistantSpeech.ts` | raw-audio transcribe upload and the speech capability store | `frontend/src/api/assistantSpeech.ts::transcribeAudio`, `frontend/src/api/assistantSpeech.ts::fetchSpeechCapability` |
| `frontend/src/pages/EntryPage.tsx` | entry choices and backend health | `frontend/src/pages/EntryPage.tsx::EntryPage` |
| `frontend/src/pages/NewSessionPage.tsx` | the setup form | `frontend/src/pages/NewSessionPage.tsx::NewSessionPage` |
| `frontend/src/pages/ResumePage.tsx` | saved runs | `frontend/src/pages/ResumePage.tsx::ResumePage` |
| `frontend/src/pages/RunPage.tsx` | the run page: layout, feed, selection, tabs, commands, assistant context and handlers | `frontend/src/pages/RunPage.tsx::RunPage` |
| `frontend/src/pages/InstructionsPage.tsx` | "How the world works" with numbers from `GET /api/defaults` | `frontend/src/pages/InstructionsPage.tsx::InstructionsPage` |
| `frontend/src/pages/StoryPage.tsx` | Story Mode | `frontend/src/pages/StoryPage.tsx::StoryPage` |
| `frontend/src/components/run/` | run page parts: `RunControls`, `StatusBar`, `Timeline`, `ActivityLog`, `RecordViewer`, `TurnRecordTab`, `GodModeTab`, `RulesTab`, `StorybookTab`, `EntityLists`, `FindBar`, `Splitter` | `frontend/src/components/run/RunControls.tsx::RunControls`, `frontend/src/components/run/StorybookTab.tsx::StorybookTab`, `frontend/src/components/run/turnStory.ts::actionPhrase` |
| `frontend/src/components/inspect/` | map, inspectors, god-mode panel and forms, plant rules and context editors | `frontend/src/components/inspect/MapView.tsx::MapView`, `frontend/src/components/inspect/GodModePanel.tsx::GodModePanel`, `frontend/src/components/inspect/logic.ts::describeIntervention` |
| `frontend/src/components/setup/` | setup form parts: agent table, card dialog and editor, world settings, model select | `frontend/src/components/setup/AgentTable.tsx::AgentTable`, `frontend/src/components/setup/AgentCardEditor.tsx::AgentCardEditor` |
| `frontend/src/components/assistant/` | the drawer: launcher, conversation picker, messages, answers with refs, brief card, composer, Dictate, spend popover, Ask buttons | `frontend/src/components/assistant/AssistantDrawer.tsx::AssistantDrawer`, `frontend/src/components/assistant/BriefCard.tsx::BriefCard`, `frontend/src/components/assistant/DictateButton.tsx::DictateButton`, `frontend/src/components/assistant/Launcher.tsx::LauncherPill`, `frontend/src/components/assistant/AskButton.tsx::AskButton` |
| `frontend/src/components/story/` | Story Mode parts: run picker, run card, chips, interview, brief card, reader | `frontend/src/components/story/RunPicker.tsx::RunPicker`, `frontend/src/components/story/Reader.tsx::Reader` |
| `frontend/src/state/` | pure, node-tested logic: feed, status text, timeline, setup form, records, run sessions, assistant context store, answer formatting, brief rendering, Story Mode helpers | `frontend/src/state/statusText.ts::controlAvailability`, `frontend/src/state/runSessions.ts::withReopen`, `frontend/src/state/assistantContext.ts::publishContext`, `frontend/src/state/assistantContext.ts::registerHandlers`, `frontend/src/state/assistantFormat.ts::linkify`, `frontend/src/state/assistantBrief.ts::describeAction`, `frontend/src/state/storyMode.ts::estimateBoth` |
| `frontend/src/state/state.test.mjs` | node:test runner for the pure state modules | |
| `frontend/src/hooks/` | `useRunFeed` (open + poll), `useRunData`, `useRunLayout` (panel sizes, drawer reserve), `useFetched`, `useThrottledKey` | `frontend/src/hooks/useRunFeed.ts::useRunFeed`, `frontend/src/hooks/useRunLayout.ts::useRunLayout` |
| `frontend/src/dev/` | dev-only inspect harness and fixtures | |
| CSS: `frontend/src/index.css` (tokens, dark mode), `frontend/src/App.css`, `frontend/src/inspect.css`, `frontend/src/setup.css` | styles | |

## Scripts, QA and docs

| Path | Purpose |
| --- | --- |
| `scripts/run_sim.py` | headless driver: create a run from the defaults (plus `--request` overlay), step rounds, print a summary; optional `--assistant` |
| `scripts/scenarios/` | scenario overlays (`arena_fight.json`, `arena_predators.json`) |
| `scripts/check_docs.py` | the docs consistency checker (`scripts/check_docs.py::main`, `scripts/check_docs.py::CHECKS`) |
| `qa/browser_check.mjs` | Playwright walk through the real UI (see `qa/README.md`) |
| `qa/resilience/` | crash, restart and concurrency scenarios over HTTP (`qa/resilience/run_all.sh`) |
| `docs/` | the documentation; `docs/INDEX.md` lists every file |
