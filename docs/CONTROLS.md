# Controls

Every control of the UI: where it is, its label, what it does, the API call behind it and the run
states in which it works. Audience: operators, developers and the built-in assistant (the quick
reference is part of its always-loaded knowledge). Labels in **bold** are the exact text on
screen; `<...>` marks a part that changes (a name, a count, an id). Rows marked *new* belong to
the assistant release (assistant drawer, Storybook tab, Story Mode, Dictate). How the rules work
is in `docs/SYSTEM.md`; the assistant is described in `docs/ASSISTANT.md`.

Pages (hash routes): `#/` entry, `#/new` New session, `#/resume` Resume session,
`#/run/<run_id>[?turn=<turn_id>]` run page, `#/instructions[?section=<id>]` How the world works,
`#/story`, `#/story/<run_id>`, `#/story/<run_id>/<story_id>` Story Mode (*new*).

## Quick reference

| Control | Where | What it does |
| --- | --- | --- |
| **New session** | Entry page | Opens the setup form (6-12 agent cards, world, rules) |
| **Resume session** | Entry page | Lists saved runs; opening one resumes it paused at its last saved turn |
| **How the world works** | Entry page | The rules explained, with numbers read from the backend defaults |
| **Story Mode** (*new*) | Entry page | Turn a run into a chaptered story |
| **Validate setup** / **Create and open** | New session | Check every problem by path / create the run (opens paused) |
| **Run turn** | Run page, left rail | One agent turn (or the round-end step), then pause |
| **Play** / **Pause** | Run page, left rail | Run continuously / stop before the next turn |
| **Step round** | Run page, left rail | Finish the current round, then pause |
| **Recover (pause)** | Status bar, error state | Discard the failed attempt; the next Run turn re-runs that turn |
| **Return to live** | Timeline | Leave history and follow the latest saved turn |
| **Inspector** / **Turn record** / **God mode** / **Rules** / **Storybook** (*new*) | Run page, right tabs | Inspect entities / the facts of the viewed turn / stage edits / read the rules / read the AI narrative |
| **Create continuation from turn <id>** | God mode tab | New run from the viewed checkpoint; the original is untouched |
| **Reload working/ files** | God mode tab | Stage the edits made to the run's `working/` JSON files |
| **Assistant** (*new*) | Rail header on the run page, bottom-right pill elsewhere, Alt+A | Open the assistant drawer |
| **Approve** / **Ask for changes** / **Cancel** (*new*) | Brief card in the drawer | Execute the proposed action once / reply with changes / reject it |
| **Dictate** (*new*) | Assistant and Story Mode composers | Record speech and insert the transcript (never sends) |
| **Write missing** (*new*) | Storybook tab | Narrate the turns that have no storybook entry yet (costs money with a paid narrator) |

Commands and their states: **Run turn**, **Play** and **Step round** work only in `paused` or
`finished` and when no command is in flight; **Pause** works in `running`, `turn_active` and
`waiting_model` (and recovers from `error`). Anything else answers 409 `illegal_command`. God-mode
edits can be staged in any state and apply at the next turn boundary of the live run.

## Every page

| Area | Label | Effect | API | States |
| --- | --- | --- | --- | --- |
| Header (all pages but Entry and Instructions) | **Back to sessions** | Go to the entry page; on the run page the run is closed 400 ms later | `POST /api/runs/{run_id}/close` | any |
| Launcher (*new*) | **Assistant** | Toggle the assistant drawer; the dot shows ready / fake model / offline / unavailable; shortcut Alt+A | `GET /api/assistant/capabilities` | any |

## Entry page (`#/`)

| Area | Label | Effect | API | States |
| --- | --- | --- | --- | --- |
| Choices | **New session** | Open `#/new` | | |
| Choices | **Resume session** | Open `#/resume` | | |
| Choices | **How the world works** | Open `#/instructions` | | |
| Choices (*new*) | **Story Mode** | Open `#/story` (pick a run) | | |
| Below the choices (*new*) | "New here? Ask the assistant" | Opens the drawer with "What is Empyrean and how do I start?" prefilled | | |
| Footer | Backend status line (read-only) | Shows the backend version or the start command | `GET /api/health` | |

## New session (`#/new`)

Loads `GET /api/defaults?agent_count=8` (and `?agent_count=12` for new-card templates) and
`GET /api/models`.

| Area | Label | Effect | API | States |
| --- | --- | --- | --- | --- |
| Action bar | **Validate setup** | Checks the whole request; every problem appears by its path next to its field and in a summary; later edits mark the result stale | `POST /api/runs/validate` | |
| Action bar | **Create and open** | Creates the run and opens it paused at `r00000_init` | `POST /api/runs` | |
| Run | **Run name**, **Seed**, **Default model (every card without its own model)**, **Max rounds (empty = no limit)**, **Play delay (seconds between turns)**, **Real budget in USD (empty = no limit)** | Fields of the run request; a paid default model shows a cost warning; unavailable models are disabled with the missing variables | | |
| Agents | Row click or **Edit…** | Opens the agent card dialog | | |
| Agents | **Remove** | Removes that card (disabled at 6 cards) | | |
| Agents | **Add agent** | Appends a card from the next default template (disabled at 12) | | |
| Agent card dialog | **Close** / **Done** / Escape / backdrop | Close the dialog | | |
| Agent card | id, name, model, **Starting coordinate**, **Initial stats and resources** (13 stats), context overrides, **Persona (optional; shown to the agent as part of its identity)**, **Starting notebook (optional; the agent's own notes)** | Card fields | | |
| Agent card | **Add initial skill** / **Remove skill** | Edit the card's starting skills (compiled when you validate) | | |
| Agent card | **Remove this agent** | Removes the card (disabled at 6) | | |
| Context settings | **Context settings (run defaults)** | Input token cap, generation allowance, history, notebook, memories, digest, weights, skill source; checked inline against the default model | | |
| World | Region, terrain, initial plants, stage, fruit, plants at agent starts, observation page size | World fields | | |
| World | **Preview world** | Shows the terrain for this seed and where the cards start | `POST /api/world/preview` | |
| Plant rules | **+ Add species**, **Duplicate**, **Remove species**, **+ Add stage**, **Remove** (stage) | Edit plant species and stages | | |
| Other rules (advanced) | **Use these rules** / **Reload from the form** | Apply the JSON of the remaining rules / regenerate it from the form | | |
| Banner (*new*) | Assistant draft banner | Shown when the assistant's "Open in setup form instead" filled the form | | |

## Resume session (`#/resume`)

| Area | Label | Effect | API | States |
| --- | --- | --- | --- | --- |
| Action row | **Filter by name or id** | Filters the list locally | | |
| Action row | **Refresh list** | Reloads the saved runs | `GET /api/runs` | |
| Action row | **New session instead** | Open `#/new` | | |
| Runs table | Run name (**Run (click to open)**) | Opens the run page; the run resumes paused at its latest checkpoint | `POST /api/runs/{run_id}/open` | |
| Runs table (*new*) | **Story** | Open Story Mode for that run | | |

## Run page (`#/run/<run_id>`)

Opening the page opens the run (`POST /api/runs/{run_id}/open`) and polls
`GET /api/runs/{run_id}/events` every 700 ms while busy and every 2.5 s while idle. From 1200 px
wide the page has three columns (left rail, map, right tabs) with the live activity log below;
at 1280 px and wider the assistant drawer docks on the right (*new*).

### Left rail

| Area | Label | Effect | API | States |
| --- | --- | --- | --- | --- |
| Run controls | **Run turn** | Exactly one agent turn (or the round-end step), then pause | `POST /api/runs/{run_id}/commands` `run_turn` | paused, finished |
| Run controls | **Play** | Turns continuously, `play_delay_seconds` apart | `commands` `play` | paused, finished |
| Run controls | **Pause** | Stop before the next turn; a running turn (and its model call) finishes and is saved first | `commands` `pause` | running, turn_active, waiting_model |
| Run controls | **Step round** | The rest of the current round, then pause | `commands` `step_round` | paused, finished |
| Run controls | **Reset layout** (in the "?" help) | Reset all splitter sizes | | |
| Rail header (*new*) | **Make a story of this run** | Open Story Mode for this run | | |
| Status bar | **View request in progress** | Open the pending model call in the record viewer | `GET /api/runs/{run_id}/pending_model_call` | waiting_model |
| Status bar | **Recover (pause)** | Discard the failed attempt and reload the last saved turn | `commands` `pause` | error |
| Status bar (*new*) | **Ask** ("Why did the run stop?") | Opens the drawer with that question prefilled | | error |
| Timeline | **Return to live** | Follow the latest saved turn | | history |
| Timeline | **◀ Previous round** / **Next round ▶** | View the last turn of the neighbouring round | `GET /api/runs/{run_id}/turns/{turn_id}` | |
| Timeline | **‹ Previous turn** / **Next turn ›** | View the neighbouring turn | same | |
| Timeline | **‹ Parent run** / **Open parent run at that turn** | On a continuation's first turn: open the parent run at the branch turn | | |
| Timeline | Turn select | Pick any turn of the viewed round | `GET /api/runs/{run_id}/turns` | |
| Agents roster | Agent row | Select that agent (switches to the Inspector unless God mode is open) | | |

### Map (centre)

| Area | Label | Effect |
| --- | --- | --- |
| Toolbar | **Pan left** / **Pan up** / **Pan down** / **Pan right** | Move the view 3 cells (arrow keys pan 1, Shift+arrow 5 when the map has focus) |
| Toolbar | **Zoom out** / **Zoom in** | Change the cell size (+ / - keys) |
| Toolbar | **Fit map** | Show the whole region |
| Toolbar | **Origin** | Centre on (0, 0) |
| Toolbar | **Center selection** | Centre on the selected cell |
| Toolbar | **Go to** x / y + **Go** | Centre on and select a point inside the region |
| Map | Click a cell / a dot; drag | Select a point / an entity; pan |
| Cell tooltip | **Close (Esc)** | Close the hover details |
| Status line | **show removed-entity markers (∅n)** | Mark cells where entities were removed |
| Legend | Kind chips, **Select all**, **Unselect all** | Show or hide dots of a kind on the map only |
| History strip | **Back to live** | Leave history |

### Right column

| Area | Label | Effect | API | States |
| --- | --- | --- | --- | --- |
| Tabs | **Inspector** | Occupants of the selected cell and the selected entity | | |
| Tabs | **Turn record** | What happened in the viewed turn (facts, deterministic) | `GET /api/runs/{run_id}/turns/{turn_id}` | |
| Tabs | **God mode** | Stage edits (the tab shows the staged count) | | |
| Tabs | **Rules** | Rules and settings in force (read-only) | `GET /api/runs/{run_id}/rules`, `/settings`, `/assumptions` | |
| Tabs (*new*) | **Storybook** | The AI-written narrative of the run | `GET /api/runs/{run_id}/assistant/storybook` | |
| Tabs | **Wider panel** | Widen the right column (God mode and Rules are always wide) | | |

#### Inspector tab

| Label | Effect | API |
| --- | --- | --- |
| **Find entity by id** + **Select entity** | Select an entity of the viewed turn (or its last point if it was removed) | |
| **Coordinate (x,y)** + **Select point** | Select a point | |
| Occupant rows | Select that entity | |
| **Clear selection** | Clear the entity selection | |
| **Open its latest decision packet** / **View that turn** | Open the agent's latest packet / view the turn it was made in | `GET /api/runs/{run_id}/turns/{turn_id}/decision_packets/{packet_id}` |
| **Agent view** checkbox | Map, occupants and inspector show only what the selected agent knows | `GET /api/runs/{run_id}/agents/{agent_id}/knowledge` (live) or `/turns/{turn_id}/agents/{agent_id}/knowledge` |
| **Open decision packet <id>** / **Open model call <id>** | Open the record viewer | `.../decision_packets/{packet_id}`, `.../model_calls/{call_id}` |
| **Show full JSON** / **Hide full JSON** | Expand an action result | |
| **Stage species rule change** / **Reset draft** (plants) | Stage an `update_plant_rules` edit for the plant's species | `POST /api/runs/{run_id}/interventions` |
| **Ask** (*new*, entity header, "What is <name> up to?") | Opens the drawer with the question prefilled | |

#### Turn record tab

Read-only account of the viewed turn: what the agent thought, what it was told (**Open decision
packet <id>**, **Open model call <id>**), what it decided, what happened, the state change, the
round-end story, the edits applied at this boundary, the events and the turn facts. *New*: an
**Ask** button in the header ("Summarize this turn").

#### God mode tab

Every edit is staged and applied at the next turn boundary of the live run (even while history
is shown), in staging order, and recorded with before/after values. Nobody is charged.

| Area | Label | Effect | API |
| --- | --- | --- | --- |
| Quick form | **Voice from nowhere** + **Send voice** | Message to **All living agents (broadcast)**, **Chosen agents** or **Living agents at a point**; recipients hear it from an unknown source | `POST /api/runs/{run_id}/interventions` `voice` |
| Quick form | **Run-default context settings** + **Stage run-default context change** / **Reset draft** | Change the run's default context settings | `update_context_settings` scope `run` |
| Staged edits | **Discard** | Remove a staged edit | `DELETE /api/runs/{run_id}/interventions/{iv_id}` |
| Sub-tabs | **Set stat**, **Place entity**, **Remove entity**, **Edit knowledge**, **Voice**, **Context settings**, **Plant rules**, **Prices**, **Model assignment**, **Run settings** | Choose the edit form | |
| Every form | **Note (optional)** | Attached to the staged edit | |
| Forms | **Stage stat change**, **Stage placement of a new <kind>**, **Stage removal of <id>**, **Stage knowledge edit**, **Stage voice**, **Stage run-default change**, **Stage override for <agent>**, **Stage <n> species change**, **Stage price table**, **Stage model assignment**, **Stage run settings** | Stage that intervention (`set_stat`, `place_entity`, `remove_entity`, `edit_knowledge`, `voice`, `update_context_settings`, `update_plant_rules`, `update_prices`, `update_model_assignment`, `update_run_settings`) | `POST /api/runs/{run_id}/interventions` |
| Files and history | **Reload working/ files** | Validate the run's `working/` files and stage their changes as one `apply_working_files` edit | `POST /api/runs/{run_id}/working/reload` (paused, error or finished) |
| Files and history | **Copy path** | Copy the `working/` folder path | |
| Files and history | **Create continuation from turn <id>** | New run from the viewed (or live) turn, opened paused | `POST /api/runs/{run_id}/continuations` |

Staged edits proposed by the assistant carry the origin `assistant` and show an assistant badge
(*new*).

#### Rules tab

Read-only: effective context settings and model per agent, run settings, prices, cognition,
upkeep, recovery, accounting, messages, death and residue, ranges, skills, upgrades, plant
species, and the assumptions recorded with the run. *New*: an **Ask** button ("Explain these
rules in plain words").

#### Storybook tab (*new*)

AI-written narrative, labelled "AI-written narrative; the Turn record has the facts". Reading it
never spends money.

| Label | Effect | API |
| --- | --- | --- |
| Opening entry, entries in commit order | Click an entry to view that turn; the viewed turn's entry is highlighted | |
| Auto on/off toggle | Narrate new turns automatically from now on (the "auto since" turn) | `PUT /api/runs/{run_id}/assistant/settings` |
| **Write missing** (N entries, ≈$X, ~Y min) | Narrate every committed turn without an entry, in batches | `POST /api/runs/{run_id}/assistant/storybook/generate` |
| **Regenerate** (per entry) | Write one entry again (one narrator call) | `POST /api/runs/{run_id}/assistant/storybook/entries/{turn_id}/regenerate` |
| **Raise budget** | Raise the run's storybook budget after auto paused at it | `PUT /api/runs/{run_id}/assistant/settings` |
| **Jump to viewed turn** | Scroll to the highlighted entry | |
| **Following <name>** · **clear** | While a map selection is active, only entries involving it are listed; clear removes the filter | |
| **Inspect** | Show the followed entity in the Inspector | |
| **Make a story of this run** | Open Story Mode for this run | |

#### Record viewer (over the map)

Decision packet, model call or the call in progress. **Close record view** (or Escape) closes it;
**Try to open the saved record** retries when a pending call has just finished. *New*: an **Ask**
button on a failed model call ("Explain this failure").

### Live activity log

| Label | Effect |
| --- | --- |
| **Hide log** / **Show log** | Collapse the log to its newest line |
| **Auto-scroll** | Keep the newest line in view |
| **Hide routine world events** | Hide upkeep, plant growth, fruit, seed and germination lines |
| **Jump to newest** | Scroll to the bottom |

Splitters between the columns and above the log resize the panels (drag, arrow keys 16 px,
Home/End, double-click resets); sizes are kept in the browser.

## How the world works (`#/instructions`)

The rules for people, with numbers loaded from `GET /api/defaults` (shipped defaults; a run's
own values are on its Rules tab). **← Back** returns to the entry page, the contents links scroll
to a section, and `#/instructions?section=<id>` opens the page at that section (the assistant
links docs sections this way).

## Assistant drawer (*new*)

Opened with **Assistant** or Alt+A; docked beside the run page at 1280 px and wider, floating
otherwise. Escape closes it when focus is inside (a recording is cancelled first).

| Area | Label | Effect | API |
| --- | --- | --- | --- |
| Header | Scope chip ("This run: <name>" or **Home**) | Which conversations are listed | |
| Header | Conversation picker, **New conversation**, **Rename this conversation**, **Delete this conversation** | Switch, create, rename or delete a conversation (delete is refused while a job runs) | `GET/POST /api/assistant/conversations`, `PATCH/DELETE /api/assistant/conversations/{conv_id}` |
| Header | Spend indicator ("$x of $y") | Opens the spend popover: per-profile spend (list-price estimate) and the limits | `GET /api/assistant/capabilities` |
| Spend popover | **Save limits** | Set this run's chat and storybook budgets (a direct control, no brief) | `PUT /api/runs/{run_id}/assistant/settings` |
| Header | Dock / Float toggle | Dock the drawer beside the run page or float it | |
| Composer | Text box + **Send** (Ctrl/Cmd+Enter) | Ask; the answer arrives step by step ("step k/4 · Ns · $x") | `POST /api/assistant/conversations/{conv_id}/messages`, then `GET /api/assistant/conversations/{conv_id}` |
| Composer | **Include what I'm looking at** | Send the context chip (page, run, viewed turn, selection) with the message | |
| Composer | **Dictate** | Speech to text (see "Dictate") | `POST /api/assistant/transcribe` |
| Composer | Suggestion chips | Prefill a suggested question | |
| Message in progress | **Stop** | Cancel after the current step ("Stopping after the current step…") | `POST /api/assistant/conversations/{conv_id}/jobs/{job_id}/cancel` |
| Failed message | **Retry** / **Raise limit** | Send again / raise the limit that stopped it | |
| Answer | Reference chips and linked ids | View a turn, select an entity or point, open a run, open a docs section, flash a control (no approval needed) | |
| Offline answer | "Docs search (AI offline)" | Shown when no model is available: the best matching docs sections | |

### Brief card (*new*)

A proposal to change something. **What will happen** is computed by the app from the typed
action (never the model's prose); **Assistant's description** below it is the model's text;
"Proposed in reply to: <message>" names the request.

| Label | Effect | API |
| --- | --- | --- |
| **Approve** (named by its effect, for example "Approve: create run", "Approve: step 3 rounds") | Revalidate and execute once, server-side; the card turns into a result | `POST /api/assistant/conversations/{conv_id}/briefs/{brief_id}/approve` |
| **Open <run> and run this** | For a run command whose run is not on screen: open that run first | |
| **Ask for changes** | Quote the brief into the composer ("Waiting for your changes") | |
| **Cancel** | Reject the brief | `POST /api/assistant/conversations/{conv_id}/briefs/{brief_id}/reject` |
| **Open in setup form instead** | For a create-run brief: fill the New session form instead of creating | |

Actions a brief can carry: create a run (opens paused; nothing is spent until you play), send a
run command (`step_round` for 1-50 rounds, or `run_turn` / `play` / `pause`), stage god-mode
edits (origin `assistant`), create a continuation, open a run, change the run's storybook auto
flag or budgets.

## Story Mode (`#/story`) (*new*)

| Step | Label | Effect | API |
| --- | --- | --- | --- |
| Pick a run | Run list | Choose a run (nothing is opened or spent) | `GET /api/runs` |
| Run card | Quick picks: genre, tone, vividness (1-5), point of view (chronicler or follow an agent), turn range; free text; **Dictate** | The deterministic run card (cast, rounds, deaths, highlights) plus your choices | `POST /api/runs/{run_id}/assistant/stories` |
| Interview | Send | One author call writes the story brief | `POST /api/runs/{run_id}/assistant/stories/{story_id}/messages` |
| Story brief | **Accept** / **Change** / **Cancel** | Start the chapters / ask for a revised brief / drop it | `.../approve`, `.../messages`, `.../reject` |
| Reader | Chapter list, previous / next | Read; the next 3 chapters are written ahead of you | `GET .../stories/{story_id}/chapters/{n}` |
| Reader | **Generate all** (est. $X, ~Y min) | Write every remaining chapter now | `POST .../stories/{story_id}/continue` |
| Reader | **Continue story** | Extend a story pinned to an end turn over newer turns | `POST .../stories/{story_id}/continue` |
| Reader | Stop | Stop the chapter job after the current chapter | `POST .../stories/{story_id}/cancel` |
| Reader | **Export Markdown** | Download the story | `GET .../stories/{story_id}/export` |

## Dictate (*new*)

The microphone button in the assistant composer and the Story Mode composer. Press **Dictate** to
record, press again to stop; recording stops by itself at 60 s (countdown shown); Escape cancels
a recording. The clip is transcribed locally ("Transcribing… (about N s)") and the text is
inserted into the composer, never sent. The button is enabled only on a secure page (open the UI
via `http://localhost:5173` or HTTPS), with a microphone, when the speech model is ready; its
tooltip says why otherwise.

## Keyboard

| Key | Where | Effect |
| --- | --- | --- |
| Alt+A (*new*) | anywhere | Toggle the assistant drawer |
| Ctrl/Cmd+Enter (*new*) | assistant composer | Send |
| Escape | record viewer, cell tooltip, agent card dialog, assistant drawer (focus inside), Dictate recording | Close / cancel the innermost one |
| Arrows, Shift+arrows, + / - | map (focused) | Pan 1 / 5 cells, zoom |
| Arrows, Home, End, double-click | splitters | Resize, min, max, reset |
| Enter | find bar, map Go to, forms | Submit |
