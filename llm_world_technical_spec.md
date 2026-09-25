# Empyrean Prototype Technical Requirements

Running technical document · Version 0.5 · September 25, 2026

## Contents

- [Purpose and scope](#purpose-and-scope)
- [Explicit user requirements](#explicit-user-requirements)
- [Stack and operating shape](#stack-and-operating-shape)
- [Main components](#main-components)
- [State and file storage](#state-and-file-storage)
- [Turn orchestration](#turn-orchestration)
- [Agent context and memory selection](#agent-context-and-memory-selection)
- [Model calls and validation](#model-calls-and-validation)
  - [Provider-independent model interface](#provider-independent-model-interface)
- [Sessions and run controls](#sessions-and-run-controls)
- [Display and historical inspection](#display-and-historical-inspection)
- [God mode and direct file editing](#god-mode-and-direct-file-editing)
- [Completion criteria and implementation freedom](#completion-criteria-and-implementation-freedom)
- [References and revision history](#references-and-revision-history)

## Purpose and scope

Build an inspectable, editable Empyrean simulation for **6–11 initial LLM agents**, with **8 as the suggested default**. The game-design document defines gameplay; this high-level brief defines technical responsibilities and operator requirements for Alan and the coding agents.

The game design says “The Empyrean is the one and only realm” and defers construction. Preserve its rules for turns, visibility, health, compute, coded skills, and terrain without duplicating their numerical tables here. [G, “STARTING PROTOTYPE REALM - The Empyrean”; “Construction in the Empyrean”]

**Recommended starting architecture:** React/Vite/TypeScript frontend, one Python/FastAPI backend, one simulation runner, and readable folders/files. No database is required for the initial prototype. Treat numbered requirements below as commitments; implementation suggestions remain adjustable. Any unresolved gameplay rule must be recorded as a configurable assumption, not silently settled by implementation.

## Explicit user requirements

These preserve the user's stated intent and are acceptance requirements, not optional architecture suggestions. Quotes are exact locators from the technical-planning, controls, provider, and context-setting discussions. [U, C, P, M]

| ID | User requirement | Required experience |
| --- | --- | --- |
| U1 | “click on a dot and open up who and what is there” | Display the plane clearly. Selecting a coordinate reveals every colocated entity; hovering or selecting an agent or plant exposes its stats. |
| U2 | “agent stuff must be very easy to see” | Make agent stats, skills, knowledge, observations, and recent actions readily inspectable. |
| U3 | “plant rules must be easy to see and modify” | Provide readable plant configuration and a clear interface for viewing and changing it. |
| U4 | “all model calls should go through some sorta model.py” | Centralize every model call, including skill authoring or memory processing; other modules do not handle provider differences. |
| U5 | “all actions and state per turn should be logged with very clear folder structure” | Give each world a folder and each turn a subfolder containing inspectable map/state, entity information, actions, and supporting records. |
| U6 | “clicking left and right arrow buttons” | Navigate rounds visually, inspect individual turns, and edit a selected scenario. |
| U7 | “agents to basically hear a voice coming from nowhere” | Let the operator send an in-world message to selected agents or a broader audience without requiring a visible sender. |
| U8 | “changing stats, placing removing objects” | God mode can modify stats, add/remove entities, and alter scenario information before the next turn. |
| U9 | “both just me changing the files straight up, and an in-game mechanism” | Support both direct file edits and UI edits, with an explicit way to apply them to the next simulation state. |
| U10 | “resume an old session” / “start a new session” | Make these the two clear entry choices. |
| U11 | “each agent should be, like, a card” / “pre-fill it with defaults” | Create agents through individual editable cards with usable defaults. |
| U12 | “start simulation is, like, run turn” / “pause and play it” | Offer explicit single-turn, continuous-play, and pause controls. |
| U13 | “see things real-time, just pop up in terminals” | Show live, readable event logs identifying who did what, alongside historical inspection. |
| U14 | “clarity is more important than aesthetics right now” | Prioritize clear labels, occupant lists, stats, and status over visual polish. |
| U15 | “without any difference noticeable or having to be dealt with in the code” | All named providers use one `model.py` interface; provider differences stay inside its adapters, with no preferred provider. |
| U16 | “changeable when i am creating a run or modifying in god mode” | Expose context limits and memory-selection settings during run creation and through god mode. |

## Stack and operating shape

| Area | Starting choice |
| --- | --- |
| Frontend | React, Vite, TypeScript; a simple map and inspection panels |
| Backend/API | Python with FastAPI |
| Validation | Shared documented schemas; Pydantic is the suggested Python implementation |
| Persistence | Human-readable JSON snapshots/configuration and structured event/model logs |
| Execution | One backend application with separate modules; one active writer per world run |
| Deployment | Local single-operator prototype first |

Use one authoritative runner and sequential turns. Keep the UI responsive during model calls and prevent duplicate loops. Distributed workers, orchestration frameworks, and databases are unnecessary initially.

FastAPI supports request-body validation through Pydantic models; its documentation explicitly describes “Validate the data.” This fits the proposed API boundary, while game-rule validation remains our responsibility. [F]

## Main components

These are responsibility boundaries, not mandatory separate services or exact directory names. `model.py` is the specifically requested common entry point.

| Component | Owns |
| --- | --- |
| Display and controls | Session selection/setup, agent cards, map/entity inspectors, timeline, live logs, run controls, plant-rule editor, god mode |
| API | Commands to create/load sessions, run/pause/step, read history/live events, inspect state, and stage edits; no independent game logic |
| Simulation runner | Round/turn sequencing, initiative, pause/resume, intervention boundaries, and commit coordination |
| World state and rules | Authoritative entities/map, legal action checks, costs, effects, plant updates, upkeep, and death |
| Agent context and memory | Each agent's permitted observations, known information, messages, memory selection, bounded decision context, and selection audit |
| Skill module | Block validation, saved skills, local variables, calls/loops, execution limits, and resumable program position |
| `model.py` and internal adapters | Provider requests, model-specific options, structured-output handling, usage normalization, and call errors |
| Storage and history | Snapshots, event/model records, configuration versions, restart loading, and editable continuations |

The world engine owns changes to reality. The UI, models, and skill interpreter submit requests; none edits authoritative balances independently. Direct actions and skill actions pass through the same rule/cost implementation, including the one-time skill discount. [G, “Saved skill compute discount”]

## State and file storage

### What must be stored

Use stable identifiers and versioned schemas. Store data separately from Python code so ordinary inspection and supported edits do not require changing implementation.

| Record group | Required content |
| --- | --- |
| World/run | World and run IDs, parent continuation if any, seed/random state, rule/config versions, code revision, round/turn position |
| Map | Terrain by coordinate and entity locations; allow many entities at one point |
| Agents | Stats/resources, model assignment, saved skills, current skill execution state, knowledge/memory, messages and pending events |
| Plants and other entities | Type, position, growth/resources, rule references, fruit/seeds/residue state |
| Rules/configuration | Editable plant rules, action prices, upgrade settings, model configurations, context/memory settings with run defaults and per-agent overrides, and chosen prototype assumptions |
| Turn record | Actor, input state reference, requested action, validation outcome, charged costs, effects, resulting state, and interventions |
| Model record | Request context, available response, model/settings, usage, latency/errors, and decision linkage; never API secrets |

Separate world truth from agent knowledge. Record what each agent observed or was told, with provenance and time. Historical inspection must show its knowledge then, with any referenced memory records resolving to that exact version.

### Suggested folder organization

Use a world folder with runs underneath. A new run can start from an earlier checkpoint without replacing its history. Within `worlds/{world_id}/runs/{run_id}/`:

| Location | Purpose |
| --- | --- |
| `manifest.json` | Identity, parent checkpoint, configuration/code versions, and current committed checkpoint |
| `working/` | Human-editable state and configuration prepared for the next turn |
| `turns/{turn_id}/state.json` | Completed-turn metadata, scheduler state, and references needed to resume |
| `turns/{turn_id}/map.json` | Map at that turn |
| `turns/{turn_id}/entities/` | Clearly grouped agents, plants, and other entities; readable records including stats and knowledge |
| `turns/{turn_id}/events.json` | Actions, failures, costs, state changes, and operator interventions in order |
| `turns/{turn_id}/model_calls/` | Calls and responses associated with the turn |

Save an initial checkpoint before any agent acts. A **round** contains the scheduled agents' turns; record both identifiers so the UI can group them. End-of-round plant/upkeep changes must also appear in a committed checkpoint and event record.

Start with complete readable snapshots. Later, share unchanged maps, skills, and historical memory records if needed, while keeping every turn inspectable and loadable. Keep that optimization behind the storage module.

**Scale estimate, not a benchmark:** eight agents over 1,000 rounds produce roughly 8,000 action-turn records. At an assumed 250 KB of snapshot data per turn, that is about 2 GB before model traces and extra checkpoints. Measure actual bytes per turn early. Agent count alone does not justify a database; reconsider storage when measured history loading, disk use, or concurrent writes become problematic.

**Persistence requirement:** incomplete writes must not replace the last complete checkpoint. Restart with the correct skill position and turn order, without repeating committed actions. Record pending model calls so recovery can identify uncertain outcomes and avoid duplicate usage accounting.

## Turn orchestration

1. At a turn boundary, honor pause requests and apply validated staged edits. Establish initiative at a new round; retain its recorded order within that round.
2. Select the next living agent. Resume its skill, or build the bounded context described below when a fresh model decision is needed.
3. Obtain a structured decision through `model.py`, or an action from the skill interpreter. Record it and actual usage.
4. Validate against current state, resolve the action/cost, and return success or failure. Skills retain the same one-world-action-per-turn limit.
5. Update agent experience and skill state; save the checkpoint and refresh the display. Record round-end plant, upkeep, and death effects too.

The game document specifies “Higher speed acts earlier” and “one world-action turn per round.” Preserve both; API response time must not determine initiative or advance simulation time. [G, “Turns speed and skill execution”]

Initially request decisions sequentially against current state. Playback uses saved outcomes without model calls; a new continuation may diverge. Controls and pause behavior are defined below.

## Agent context and memory selection

**Starting decision:** retain each agent's experience in files, but assemble a bounded decision packet for each LLM call. The context module chooses the content; `model.py` translates and sends it. A continuing skill executes from its saved state without requiring an LLM call every turn.

### What belongs in a decision packet

| Layer | Include |
| --- | --- |
| Stable instructions | Concise game/action rules, relevant costs, output schema, and the agent's identity; no prescribed personality or goals unless configured. |
| Immediate situation | Latest action result, new received-event/message digest, and self-information already disclosed to the agent. Keep observation times and unknown/stale labels. |
| Working memory | A short persisted notebook of the agent's own plans, unresolved commitments, and hypotheses; a skill catalogue and relevant execution state. Include full skill code only when needed. |
| Recent experience | A small rolling window of the agent's recent actions and results. |
| Retrieved experience | A few older records relevant to its known situation or its own stated plan. |

**Knowledge boundary:** filter to that agent's permitted records before retrieval or summarization. Do not include the global map, other agents' private state, or unseen events. Reusing a past observation is allowed; refreshing it still requires the game's `observe`/`query` action. Do not silently supply a fresh `query(self)` every turn. Apply only self-updates actually disclosed through action feedback or received events; the backend can use authoritative balances for billing without exposing extra state. [G, “Observe query and action feedback”]

### How selection works

1. Reserve space for instructions, the latest result, and a compact digest of new events. Surface urgent received damage, failures, and unresolved messages before routine repetition. Preserve raw events; show overflow counts if message bodies cannot all fit.
2. Include the bounded notebook and recent experience; start with the last five agent decisions as a configurable window.
3. Rank older eligible memories by **relevance, recency, and importance**, then deduplicate and fill the remaining token budget. Relevance initially uses matching known entity IDs, coordinates, event types, and words from the agent's plan/current situation. Recency uses simulation time. Importance uses transparent event rules, such as damage or substantial resource changes, plus bounded agent-supplied priorities. These rank attention; they do not choose goals or actions.
4. Start with deterministic filtering/ranking over file records. Add embedding similarity only if simple matching misses useful memories; no vector database is required initially. Default to shared run settings for weights and limits, with operator-editable per-agent overrides.

Let the normal structured decision include an optional bounded notebook update, avoiding a separate reflection call every turn. Treat these notes as fallible agent beliefs, with references to supporting events; never overwrite raw experience or turn an inference into world truth. Later summarization can compact older material when needed. Any model-based summarization or embedding request goes through `model.py`, with its usage and accounting recorded.

### Budget delivery and inspection

*Suggested initial limits: up to 6,000 total input tokens and a 1,000-token generation allowance per ordinary decision. These are editable run defaults, not research-established optima or targets to fill.* Count instructions and schemas too. Fit input plus generation allowance within the provider's context limit and the agent's affordable cognition reservation. Trim low-ranked history first; if the minimum valid packet is unaffordable, return an explicit resource result to the runner rather than making an unfunded call. Charge actual usage under the existing compute rules. [G, “Compute metering”]

**Operator controls:** expose input-token cap, generation allowance, recent-history length, notebook size, retrieved-memory limit, and retrieval weights in both new-run setup and god mode. Support run-wide defaults and per-agent overrides, editable through the UI or `working/` files. Validate settings against the selected model's capabilities and show the effective settings. Save initial values and later changes with the run. God-mode changes apply at the next turn boundary, before the next model request; log their effective turn without altering an in-flight request or historical context. [M]

Send a fresh, explicitly structured packet with stable rules first, labeled memories, then the immediate situation and decision request. Agent/operator messages remain quoted world data. Persist the exact request, selected memory IDs, notebook version, token usage, and omission reasons, and expose them in the inspector. A fresh API request must retain continuity through this stored memory. Skipped material stays available for future retrieval.

Evaluate the starting policy on recorded scenarios: can the agent use an older relevant fact, retain an unresolved plan, distinguish stale observations, and avoid hidden information? Compare against recent-history-only context while tracking tokens, latency, and invalid actions; adjust limits and retrieval before adding machinery.

**Research basis:** Park et al.'s *Generative Agents* combines “relevance, recency, and importance” for memory retrieval. Liu et al.'s *Lost in the Middle* found sensitivity to where relevant information appears in the tested models' long contexts. These motivate selective retrieval and deliberate ordering; they do not establish an optimal budget for our agents. The simple ranking, notebook, and token caps above are prototype design choices. [R1, R2]

## Model calls and validation

### A single model boundary

`model.py` accepts a provider-independent request and returns a normalized result. Internally it handles provider/model selection, capabilities, settings, token limits, response formats, timeouts, and bounded retries. No provider SDK calls should appear elsewhere.

Configure models globally and per agent; the operator chooses the run's provider/model default and any per-agent overrides. No provider is preferred or hardcoded as the default. Support a deterministic fake adapter for development and no silent model substitution. Normalize token usage without double-counting, keeping real expense separate from world compute.

Log only provider-exposed responses and usage, not assumed hidden reasoning. Unsupported output capabilities need an explicit validated fallback or a clear configuration error.

### Provider-independent model interface

**All listed providers must work through the same application-facing interface.** Provider selection is configuration: the runner, context builder, skill module, and other callers must not branch on providers or handle provider-specific request/response formats. `model.py` and its internal adapters own those differences. No provider has priority. [P]

| Provider / route | Intended support |
| --- | --- |
| Fireworks | Support a Fireworks adapter behind the same application-facing interface. |
| AWS Bedrock | Support a Bedrock adapter behind the same application-facing interface. |
| OpenAI API | Provide the API integration corresponding to the user's ChatGPT/OpenAI model preference. |
| Anthropic API | Support calling Claude directly through Anthropic. |
| Microsoft AI Foundry | Support a Foundry adapter behind the same interface. |
| Additional LLM sources | Allow another adapter without changing simulation rules, agent logic, or skill execution. |

Keep **provider/hosting route separate from model identity**. Configuration should hold the model ID, provider, credential reference, and any required endpoint, region, or deployment settings. Agent cards select a configured provider/model; credentials stay on the backend and out of saved world records.

Each adapter translates the common request into its provider's format and normalizes the response, usage, and errors. Handle differences in authentication, message formats, supported parameters, structured outputs, and limits inside this boundary. Do not assume every source accepts the same API shape or supports the same features. Resolve capability differences inside the adapter through a validated fallback or a consistent configuration error; callers must not implement provider-specific workarounds. Apply the validation gates below regardless of provider.

Record the actual provider and model used for each call. Expose unsupported configurations clearly, without silently changing providers. Alan may choose direct SDK adapters or a shared library; `model.py` remains the sole application entry point either way.

### Two distinct validation gates

**Format validation:** decode and check the decision schema, action names, argument types, finite numeric values, and block-program structure. Prefer provider-native structured outputs when supported, then validate at the backend boundary. Refusal, truncation, timeout, or malformed output is a handled result, never an executable action. OpenAI's guidance distinguishes schema adherence from correctness: “Structured Outputs can still contain mistakes.” [O]

**World-rule validation:** immediately before execution, check the actor, target, visibility, range, terrain, resources, capacity, allowed upgrades, and skill limits. Valid JSON can still request an impossible move. Reject that action without applying its intended effect; record only the failure, fees, and timing specified by the game design. [G, “Failure and resource handling”]

Validate API requests, model results, saved skills, and imported files through shared schemas. Operator edits can bypass gameplay limits but must preserve valid state. Generated skills never execute arbitrary Python.

Bound retries, expose exhausted failures, and distinguish infrastructure errors from agent choices. Log spent usage even when no action results; prevent duplicate execution.

## Sessions and run controls

**Entry:** offer **New session** and **Resume session**. A session opens a saved world/run; it does not require a separate storage system.

**New session:** provide usable world/plant settings, editable context/memory settings, a provider/model choice, and an initial roster of editable agent cards, with eight agents as the suggested default. Allow adding/removing cards for the initial 6–11-agent setup. Each card exposes its name, model, starting coordinate, initial stats/resources, and optional context-setting overrides, prefilled from run defaults. Validate setup, explain any invalid values, then save the initial checkpoint and open the simulation paused.

**Resume session:** list saved sessions with identifying names, last saved round/turn, and save time. Load the selected session's latest complete checkpoint and open it paused, ready for inspection or continuation.

| Control | Behavior |
| --- | --- |
| Start / Run turn | Advance exactly one agent turn, then remain paused. Clearly distinguish a turn from a full round. |
| Play | Continue running turns until paused or the run stops. |
| Pause | Stop before the next turn starts. If a turn is active, show “Pause requested,” finish and save that turn, then show “Paused.” |
| Step round | Advance through the remainder of the current round, then pause. |

Show the current round, turn, acting agent, and status, including waiting for a model response or an error. Prevent overlapping run commands. History navigation changes the viewed checkpoint without silently changing the active run; provide an obvious return to live view.

*Optional, low-priority suggestion: if practical later, save intermediate progress during an interrupted or paused turn so continuation can reuse completed work. Mid-turn checkpoint/resume is not a first-build requirement; the baseline pause behavior remains at turn boundaries.*

## Display and historical inspection

**Clarity comes before aesthetics.** Plain panels, readable labels, and terminal-style logs are sufficient. Make terrain, coordinates, entity types, selection, and run status easy to distinguish.

Show terrain distinctly and mark occupant counts at a coordinate. A point click opens a scrollable list of every occupant; hover gives quick stats and selection opens a detailed inspector. Colocated entities must remain individually selectable rather than hiding behind overlapping dots. Provide simple map navigation and coordinate lookup; the operator should not need to view the entire plane at once.

**Live activity:** append events as they happen while the run continues. Identify the round/turn, agent or operator, action, result, and relevant costs or errors. Distinguish pending activity (such as a model call) from completed effects. Keep the map and selected inspector updated as state changes. The live feed and historical logs must refer to the same recorded events; browsing history must not hide how to return to current activity.

The agent inspector must expose stats, balances, model assignment, saved skills, current block/action, knowledge, received messages, and recent results/costs. The plant inspector shows its current state alongside the rules and source settings governing it. Provide a clear plant-rule editor, distinguishing a species/rule change from editing one instance.

Provide left/right round navigation, turn selection, and a live/history indicator. Preserve entity selection across history, indicate before-birth/after-death, and expose changes alongside their action/model records.

Keep omniscient operator inspection separate from agent context. An optional agent-view overlay shows only permitted information. Load historical details on demand.

## God mode and direct file editing

**UI god mode:** edit stats, plant settings, and run/agent context-memory settings; place/remove entities; modify knowledge or messages; and inject a voice to one agent, selected agents, or a broadcast audience. Context-setting changes follow the next-turn application rule above. Operator messages are world events from an unseen source, not elevated model instructions. They remain distinguishable in operator logs. Knowledge edits must be distinguished from merely changing reality, which does not automatically inform every agent.

**Literal god mode:** pause at a turn boundary, edit files in `working/`, then explicitly reload/validate/apply them. Ordinary file editing must remain a supported workflow. Invalid JSON or inconsistent references produce clear errors and leave the last valid state available. The UI should offer the same edit capability without requiring file manipulation.

Both editing paths record before/after values, origin, and effective boundary, without charging agents. Queue edits arriving during model calls; check state versions before applying a response.

**Editing history:** select a recorded turn, create an editable continuation from that checkpoint, then run forward. Preserve the original future; it is not valid history for the edited state. This supports changing a past scenario through the UI or copied files while keeping comparisons meaningful. Committed turn records stay historical; `working/` is the deliberate editing surface.

## Completion criteria and implementation freedom

The first usable build must demonstrate:

- An eight-agent run can pause, restart, and continue without losing state or repeating a committed action.
- New/resumed sessions open paused; editable agent cards have defaults, and Run turn, Play, and Pause behave as described.
- Live terminal-style logs show activity as it happens, with clear run status and a return from history to live view.
- A point and every occupant can be inspected across rounds; agent knowledge and plant rules are visible.
- Valid direct and skill actions share rule enforcement; malformed output and invalid actions fail without crashing the simulation or applying forbidden effects.
- Each model decision has an inspectable, bounded context built only from that agent's permitted information; older relevant memories can be retrieved without refreshing observations for free.
- Context limits and memory-selection settings can be changed during run creation or in god mode; saved settings and effective changes are visible in history.
- UI and file edits apply before the next turn, produce a recorded intervention, and can start a new continuation from history.
- An unseen operator voice reaches the selected recipients and appears in their recorded experience.
- The same decision flow works with each listed provider through configuration alone, with no provider-specific caller code; stored playback requires no model calls.

Alan should choose exact module/file names apart from the requested `model.py` boundary, API routes, schemas, map rendering method, frontend state management, update transport, and storage optimizations. Keep prices and plant/model settings in configuration. No visual block editor, database migration, elaborate world generator, multiplayer service, or construction system is required for this first build.

## References and revision history

**[G] Game design:** `llm_world_running_design.md`, version 0.7. Referenced section titles and short exact quotations appear beside the requirements they support. Gameplay changes belong there; this document should track technical consequences rather than maintain a second set of game rules.

**[U] Explicit technical requirements:** the September 25, 2026 discussion. The requirements table preserves exact searchable phrases and their intended behavior.

**[C] Session and controls requirements:** the September 25, 2026 follow-up requesting new/resumed sessions, default-filled agent cards, turn/play/pause controls, live logs, easy occupant inspection, and clarity over aesthetics. Mid-turn saving was explicitly a tentative suggestion.

**[P] Provider requirements:** the September 25, 2026 follow-up naming Fireworks, AWS Bedrock, ChatGPT/OpenAI, Claude through Anthropic, and Microsoft AI Foundry, clarified to require a uniform application-facing interface with no provider priority.

**[M] Context-setting requirements:** the September 25, 2026 clarification requiring context limits and related settings to be editable when creating a run and through god mode.

**[F] FastAPI documentation:** [Request Body](https://fastapi.tiangolo.com/tutorial/body/), especially “Validate the data.” Used for the proposed typed API boundary.

**[O] OpenAI documentation:** [Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs), especially “Handling mistakes” and “Refusals with Structured Outputs.” Used as one provider example; the architecture remains provider-independent.

**[R1] Park et al. (2023):** [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/html/2304.03442v2), §4.1, “Memory and Retrieval.” Searchable phrase: “relevance, recency, and importance.” Supports the retrieval pattern; its human-behavior simulation is different from this game's purpose.

**[R2] Liu et al. (2024):** [Lost in the Middle: How Language Models Use Long Contexts](https://aclanthology.org/2024.tacl-1.9/), abstract. Searchable phrase: “beginning or end of the input context.” Supports evaluating information placement rather than assuming a larger context is always better; results concern the paper's tested models/tasks.

| Version | Change |
| --- | --- |
| 0.1 | Initial high-level implementation requirements, explicit user requirements, file-based history, module boundaries, model validation, visual inspection, and two god-mode editing paths |
| 0.2 | Added session setup/resume, editable agent cards, explicit run controls, live logs, and clearer occupant inspection; kept mid-turn saving optional |
| 0.3 | Added provider integration targets and adapter/configuration requirements behind `model.py`; the provider-priority assumption was corrected in 0.5 |
| 0.4 | Specified bounded agent context, permitted knowledge, recent and retrieved memory, working notes, configurable token caps, and supporting research |
| 0.5 | Made context/memory settings editable in run setup and god mode; removed provider priority and required a uniform `model.py` interface for every listed provider |
