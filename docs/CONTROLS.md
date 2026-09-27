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
| **New session** | Entry page | Opens the setup form (6-64 agent cards, world, rules) |
| **Resume session** | Entry page | Lists saved runs; opening one resumes it paused at its last saved turn |
| **How the world works** | Entry page | The rules explained, with numbers read from the backend defaults |
| **Story Mode** (*new*) | Entry page | Turn a run into a chaptered story |
| **Validate setup** / **Create and open** | New session | Check every problem by path / create the run (opens paused) |
| **Run turn** | Run page, left rail | One agent turn (or the round-end step), then pause |
| **Play** / **Pause** | Run page, left rail | Run continuously / stop before the next turn |
| **Step round** | Run page, left rail | Finish the current round, then pause |
| **Recover (pause)** | Status bar, error state | Discard the failed attempt; the next Run turn re-runs that turn |
| **Return to live** | Timeline | Leave history and follow the latest saved turn |
| **2D map** / **3D view** | Run page, end of the map legend's controls row (**Map view**) | Show the viewed turn as the SVG map or as a 3D board to fly over; remembered per browser |
| **Inspector** / **Turn record** / **God mode** / **Rules** / **Storybook** (*new*) | Run page, right tabs | Occupants of a cell and a summary of the selection / the facts of the viewed turn / stage edits / read the rules / read the AI narrative |
| Click an entity, or **Profile** | Map dot, occupant row, roster row, Inspector | Opens the entity's profile card over the page: Overview, Decisions, Skills, Knowledge, Messages, History (agents); Overview, Growth, Rules, History (plants) |
| **Create continuation from turn <id>** | God mode tab | New run from the viewed checkpoint; the original is untouched |
| **Reload working/ files** | God mode tab | Stage the edits made to the run's `working/` JSON files |
| **Assistant** (*new*) | Bottom-right pill on every page (hidden while the drawer is open) plus a rail-header button on the run page, Alt+A | Open the assistant drawer |
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
| Run | **Run name**, **Seed**, **Default model (every card without its own model)**, **Max rounds (empty = no limit)**, **Play delay (seconds between turns)**, **Real budget in USD (empty = no limit)** | Fields of the run request; the default model starts as `EMPYREAN_DEFAULT_MODEL` (`claude-cli-haiku` when the CLI is installed, else the fake model); the picker lists one fake model (the free, instant stand-in; the test doubles `fake-scripted` and `fake-malformed` are hidden), a paid default model shows a cost warning; unavailable models are disabled with the missing variables | | |
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
| Action row | **Refresh list** | Reloads the active runs and the archive | `GET /api/runs`, `GET /api/runs?archived=1` | |
| Action row | **New session instead** | Open `#/new` | | |
| Action row, right | **Archived runs** (with the count) | Switches the table to the archive: runs you archived, hidden from the normal list, data untouched | `GET /api/runs?archived=1` | Active view |
| Action row, right | **Back to active runs** | Switches back to the normal list | `GET /api/runs` | Archive view |
| Runs table | Run name (**Run (click to open)**) | Opens the run page; the run resumes paused at its latest checkpoint | `POST /api/runs/{run_id}/open` | Active view |
| Runs table (*new*) | **Story** | Open Story Mode for that run | | Active view |
| Runs table | Checkbox per row (**Select all shown runs** in the header) | Click toggles a run; Ctrl-click (Cmd on a Mac) on a checkbox or a row adds or removes one; Shift-click adds the range from the last clicked run; a plain click on a row (not on a button) selects only that run; Space toggles the focused checkbox. The header box selects or clears the rows the filter shows; selected rows hidden by the filter stay selected | | Both views |
| Selection toolbar | **Archive selected** | Moves the selected runs to the archive at once, then reloads; the notice "Archived N runs." offers **View archive** | `POST /api/runs/{run_id}/archive` per run | Active view, something selected |
| Selection toolbar | **Restore selected** | Moves the selected archived runs back to the active list | `POST /api/runs/{run_id}/unarchive` per run | Archive view, something selected |
| Selection toolbar | **Delete selected…** | Opens a confirmation that names the runs and says the folders are removed permanently and cannot be undone; its Delete button removes them one by one. A run that is open (playing, or shown in another tab) is refused and the reason is shown next to that run | `DELETE /api/runs/{run_id}` per run (409 `run_in_use` while open) | Both views, something selected |
| Selection toolbar | **Clear selection** | Unselects every run | | Something selected |
| Archive table | **Restore** | Puts that one run back in the active list (archived rows have no Open button) | `POST /api/runs/{run_id}/unarchive` | Archive view |
| Notice | **Dismiss** | Hides the archive, restore or delete notice | | After an action |

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
| Agents roster | Agent row | Select that agent and open its profile card (the Inspector tab shows it behind, unless God mode is open) | | |

### Map (centre)

A **Map view** switch at the end of the legend's controls row (in both views, like a map app's view
toggle in a corner, so it costs the board no row) chooses the view: **2D map** (the SVG map) or
**3D view** (the board described in "3D view (centre)"). The history strip stays above both, and
nothing else on the page changes with the switch.

| Area | Label | Effect |
| --- | --- | --- |
| Legend, end of the controls row | **Map view**: **2D map** / **3D view** | Switch the centre column between the SVG map and the 3D board; remembered per browser (`empyrean.map.view`, default 2D). The 3D code (three.js) is downloaded only when **3D view** is chosen; pointing at that radio prefetches it (keyboard focus does not). Keyboard: the checked radio is the one tab stop; arrows, Home and End switch, and the focus follows to the switch of the view that appears |
| Toolbar | **Pan left** / **Pan up** / **Pan down** / **Pan right** | Move the view 3 cells (arrow keys pan 1, Shift+arrow 5 when the map has focus) |
| Toolbar | **Zoom out** / **Zoom in** | Change the cell size (+ / - keys); zooming in spreads the dots of packed cells |
| Toolbar | **Fit map** | Show the whole region |
| Toolbar | **Origin** | Centre on (0, 0) |
| Toolbar | **Center selection** | Centre on the selected cell |
| Toolbar | **Go to** x / y + **Go** | Centre on and select a point inside the region |
| Map | Click a cell / a dot; drag | Select a point (its occupants are listed in the Inspector) / an entity and open its profile card (a cell with one entity opens it too); pan |
| Map | Count badge of a packed cell | Select the cell and pin its tooltip, which lists every occupant (no profile card opens) |
| Cell tooltip | **Close (Esc)** | Close the hover details |
| Cell tooltip | Entity row | Select that entity and open its profile card |
| Status line, first line | (read-only) | The hovered dot or cell (over a count badge: "Cell (x, y) land · N occupants · click the count to list every occupant"); otherwise the viewed turn's caption, "Turn <id> · <name> (<id>) <what it did>" ("took no action", or for a round end "round <n> ended · 3 grew · 1 died"); while a live turn runs it ends with " · <name> (<id>) is deciding now" |
| Status line, second line | "<N> cells packed: zoom in to spread the dots" | Shown when cells are packed (title: zoom in to spread them; the count badge shows each total). At the largest zoom it reads "<N> cells packed: click the count", or "<N> cells over capacity: click the count" when some cells still hold more dots than fit |
| Status line | **show removed-entity markers (∅n)** | Mark cells where entities were removed |
| Legend | Kind chips, **Select all**, **Unselect all** | Show or hide the dots of a kind on the map only (occupant lists and the tooltip stay complete) |
| Legend | **Action marks** | Show or hide the viewed turn's action marks (on by default; remembered per browser) |
| Legend | **Key** (▾ / ▴) | Open or close the key under the controls: what the count badge, group tiles, rings, marks and terrain colours mean. Collapsed by default so the map keeps its height; remembered per browser |
| History strip | **Back to live** | Leave history |

What the 2D map draws:

* Dots have one size per zoom level, whatever the cell holds: 8 px at 24-36 px cells, 9 px at
  44 px (the default zoom), growing to 24 px at 340 px. A cell with more occupants than fit at
  normal spacing is *packed*: its dots move closer together and a count badge in its top-right
  corner shows the total (a pill from 36 px cells, bare digits in the corner at 24-30 px).
  **Zoom in** spreads packed dots; at the largest zoom a cell that still holds more than fit shows
  as many dots as fit and the total in its badge. Names appear under a lone dot from 36 px cells
  and under a single row of dots from 160 px; otherwise the tooltip names the occupants.
* Group tiles replace the dots below 24 px (10, 14 and 18 px cells): one square per occupied
  cell, bigger for more occupants, blue when an agent is there, with the count in digits from
  14 px (for two or more) and a thin kind bar on mixed cells.
* Action marks show what the viewed turn did (live: the last saved turn). The acting agent
  gets a purple badge whose glyph names the action (arrow = move, cross = attack, M message,
  E absorb, T transfer, R recover, U upgrade, W wait, O observe, Q query, S skill, "·" no action;
  red = failed). A move draws an arrow from a dashed ghost of the old position. Rings mark the
  entities the action or a world event touched: red hit, orange fed from, blue heard, green given,
  grey died, dashed queried, purple dashed operator voice, green grew or germinated, orange fruit,
  brown seed. An observe outlines the observed cell (dashed), a broadcast draws its reach as a
  diamond, and amounts are printed (−damage, +gained). A failed action draws only its red badge
  (a blocked move also its stroke). While a live turn runs, the agent deciding now has a pulsing
  dashed ring. The key names these marks in short: "packed: zoom in", "group: bigger = more,
  blue = agent", "acting · pulses while deciding", "selected", "selected cell", "acted (red =
  failed)", "moved", "hit · fed · heard · given · died · queried", and the terrain colours.

### 3D view (centre)

The viewed turn as a board: land flat, mountains raised, water sunk, one figure per entity
(agents, plants tinted by species, fruit, seeds, residue; dead agents and plants lie flat), a
health disc under each living agent, the acting agent's dashed ring, the selected entity's ring
and cell frame, and a chip over the actor naming the viewed turn's action or world event. With
**Animations** on, the viewed turn plays once (moves slide, attacks lunge, messages ripple, new
plants pop up) within 0.7 s. Cells with 5 or more occupants carry a count badge; seen from more
than 60 units away the figures turn into columns as tall as the count, with badges from 2.

| Area | Label | Effect |
| --- | --- | --- |
| Toolbar | **Frame region** | The whole region from the south, looking north and down (F) |
| Toolbar | **Top view** | Look straight down at the region (T) |
| Toolbar | **Focus selection** | Fly to the selected cell (Home); disabled with no selected cell |
| Toolbar | **Layer down** / **Layer up** | Activate the layer below / above (PageDown / PageUp). A run has one layer today, so both are disabled; the chip reads "Layer 1 of 1 · World" |
| Toolbar | **Replay turn** | Play the viewed turn's animations again (R) |
| Toolbar | **Animations** | Animate the viewed turn (on by default; off and disabled when the system asks for reduced motion; the chips stay either way) |
| Toolbar | **Controls** | Show or hide the help card "3D map controls" (also ? or H). The card opens by itself on the first 3D open; **Close**, Escape or a click on the board hides it |
| Board | Agent label ("a03 Cyrene") | Select that agent and open its profile card (a focused label also takes Enter); closing the card returns the focus to the board, so the keys work straight away |
| Board | Click a figure | Select that entity and open its profile card |
| Board | Click a tile | Select the cell (a lone occupant is selected and its card opens too) |
| Board | Left drag / right or middle drag / wheel or pinch | Look around / pan across the board / zoom toward the point under the pointer. Drag, wheel and hover also work over labels |
| Board | Hover | The first status line names the figure or cell under the pointer (hovering a label hovers its entity); resting on an occupied cell opens its tooltip |
| Cell tooltip | **Close (Esc)** / entity row | Close it / select that entity and open its profile card (every occupant is a row; the hovered one is marked) |
| Status line, first line | (read-only) | The hovered figure ("a03 Cyrene at (3, 4): click to select it") or cell ("Cell (3, 4) land · 7 occupants"), else a summary of the keys |
| Status line, second line | (read-only) | "Selected: (x, y) <terrain> · <entity> · Turn <id>: <actor> <what it did> · Layer 1 of 1", plus "Not drawn: <kinds>" when legend kinds are hidden |
| Legend | Kind chips (**living agent**, **dead agent / plant**, **plant**, **fruit**, **seed**, **residue**), **Select all**, **Unselect all** | Show or hide the figures of a kind; the choice is stored with the 2D legend's and read when a view opens |
| Fallback | **Back to 2D map** | Shown instead of the board when the browser has no WebGL 2 ("This browser cannot draw the 3D view (WebGL 2 is unavailable). The 2D map keeps working.") or the view could not load ("The 3D view could not load." and "Reload the page to try again, or go back to the 2D map.") |
| Fallback | **Retry** | Rebuild the board after the browser lost its graphics context |

Labels name the living agents that have room on screen. Labels, chips and count badges never
overlap: in a crowd a label shows the agent's id only ("a03" instead of "a03 Cyrene"), and when even
that has no room it is left out until the camera moves. The hovered or selected entity's label
always shows. A chip over an agent stacks above that agent's label, and world-event chips outrank
agent names when space is short. Beyond 30 units a label shows only the id, beyond 60 units no
label is drawn, and at most 40 labels, badges, chips and floating numbers are drawn per frame. The
keys work while the board has focus (click it first); Ctrl, Alt and Cmd chords are ignored.

### Right column

| Area | Label | Effect | API | States |
| --- | --- | --- | --- | --- |
| Tabs | **Inspector** | Occupants of the selected cell and the selected entity | | |
| Tabs | **Turn record** | What happened in the viewed turn (facts, deterministic) | `GET /api/runs/{run_id}/turns/{turn_id}` | reads "Turn" when the tabs row is narrower than 385 px |
| Tabs | **God mode** | Stage edits (the tab shows the staged count, e.g. "God mode (3)") | | reads "God (3)" when the tabs row is narrower than 385 px |
| Tabs | **Rules** | Rules and settings in force (read-only) | `GET /api/runs/{run_id}/rules`, `/settings`, `/assumptions` | |
| Tabs (*new*) | **Storybook** | The AI-written narrative of the run | `GET /api/runs/{run_id}/assistant/storybook` | reads "Story" when the tabs row is narrower than 420 px (the default 390 px column) |
| Tabs | **Wider panel** | Widen the right column (God mode and Rules are always wide) | | |

The five tabs sit on one line and fit the column at every width from the 300 px minimum up: the labels
follow the width of the tabs row itself (not the window), with smaller type below 470 px and the short
labels above; the accessible name and the tooltip always carry the full label. Only on a phone-width
column narrower than about 280 px does the row scroll sideways.

#### Inspector tab

The tab lists what is at the selected cell and sums up the selected entity in two lines. The full
record is in the entity profile card.

| Label | Effect | API |
| --- | --- | --- |
| **Find entity by id** + **Select entity** | Select an entity of the viewed turn and open its profile card (or select its last point if it was removed) | |
| **Coordinate (x,y)** + **Select point** | Select a point (a single occupant is selected, the card stays closed) | |
| Occupant rows, "Other entities" chips | Select that entity and open its profile card | |
| **Clear selection** | Clear the entity selection | |
| **Profile** | Open the selected entity's profile card | |
| **Open its latest decision packet** / **View that turn** | Open the agent's latest packet / view the turn it was made in | `GET /api/runs/{run_id}/turns/{turn_id}/decision_packets/{packet_id}` |
| **Agent view** checkbox (agents) | Map and occupants show only what the selected agent knows; the card's Overview shows its believed self | `GET /api/runs/{run_id}/agents/{agent_id}/knowledge` (live) or `/turns/{turn_id}/agents/{agent_id}/knowledge` |

#### Entity profile card

A card over the run page for one entity of the viewed turn. The board stays visible, dimmed,
behind it, and a docked assistant drawer stays usable beside it. The card opens when you click an
entity: a map dot, a map tooltip row, an occupant row, a roster row, an "Other entities" chip, an
entity link in an assistant answer, or **Profile** in the Inspector. Opening it never changes the
viewed turn or the play state. Every value is "as of turn <id>" of the viewed turn: **View turn** in
Decisions or Messages moves the page to that turn and the card follows it. A dead or removed entity keeps its last known data
with a dead / removed badge.

| Area | Label | Effect | API |
| --- | --- | --- | --- |
| Header | **Agent view** (agents) | Same toggle as in the Inspector | |
| Header | **Ask** ("What is <name> up to?") | Opens the assistant drawer with the question prefilled | |
| Header | **Open in Inspector** | Close the card and show the entity in the Inspector tab | |
| Header | **×** (or Escape, or a click on the dimmed board) | Close the card; focus returns to what opened it | |
| Side list | **Overview**, **Decisions**, **Skills**, **Knowledge**, **Messages**, **History** (agents); **Overview**, **Growth**, **Rules**, **History** (plants); **Overview**, **History** (fruit, seeds, residue) | Show that section; arrow keys, Home and End move between sections. Below 900 px the list is a row of tabs and the card fills the window | |
| Overview (agent) | | Identity, model and mind multiplier, totals (compute spent on actions, cognition and interpreter, model calls, upgrades), the stats table, last action and result, persona, context settings | |
| Decisions (agent) | **View turn** / **Packet** / **Model call** | Every turn the agent acted in up to the viewed turn, newest first, ten at a time ("Show 10 older"), with its thought, action, result, cost and skill; view that turn / open its decision packet / its model call in the record viewer (the card waits behind it) | `GET /api/runs/{run_id}/turns`, `.../turns/{turn_id}/events`, `.../decision_packets/{packet_id}`, `.../model_calls/{call_id}` |
| Skills (agent) | | Saved skills with their source, and the skill execution state | |
| Knowledge (agent) | **Show full JSON** / **Hide full JSON** | Believed self against the actual stats, notebook, memory priorities, recent results as the agent recorded them, and every knowledge record with kind filters and search | `.../knowledge` |
| Messages (agent) | **View turn** | Messages it sent (send and broadcast, with who they reached) and messages and voice it received | `.../turns/{turn_id}/events`, `.../knowledge` |
| History | | Created round, death round and cause, residue left, removal, and presence in the viewed turn | |
| Overview (plant) | | Species, stage, age, size, stored energy, essence, alive, position | |
| Growth (plant) | | Its fruit and seeds (each id opens that entity's card), rounds since fruit and seed, when the next ones come, totals and the stage's intervals | |
| Rules (plant) | **Stage species rule change** / **Reset draft** | Stage an `update_plant_rules` edit for the plant's species (in history, the rule as of the viewed turn is shown above it) | `POST /api/runs/{run_id}/interventions` |
| Overview (fruit, seed, residue) | | Available compute and essence, source plant or entity, created round, rot or germination round | |

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
| Working indicator "Narrating N turns…" (status line) | Shown with a ticking counter while entries are queued or being written | |
| **Write missing** (N entries, ≈$X, ~Y min) | Narrate every committed turn without an entry, in batches | `POST /api/runs/{run_id}/assistant/storybook/generate` |
| **Regenerate** (per entry) | Write one entry again (one narrator call) | `POST /api/runs/{run_id}/assistant/storybook/entries/{turn_id}/regenerate` |
| **Raise budget** | Raise the run's storybook budget after auto paused at it | `PUT /api/runs/{run_id}/assistant/settings` |
| **Jump to viewed turn** | Scroll to the highlighted entry | |
| **Following <name>** · **clear** | While a map selection is active, only entries involving it are listed; clear removes the filter | |
| **Inspect** | Open the followed entity's profile card (the Inspector tab shows it behind) | |
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
| Composer | Text box + **Send** (Ctrl/Cmd+Enter) | Ask; the answer arrives step by step ("step k/4 · Ns · $x"); while it is written the button shows a spinner and "Thinking…" | `POST /api/assistant/conversations/{conv_id}/messages`, then `GET /api/assistant/conversations/{conv_id}` |
| Composer | **Include what I'm looking at** | Send the context chip (page, run, viewed turn, selection) with the message | |
| Composer | **Dictate** | Speech to text (see "Dictate") | `POST /api/assistant/transcribe` |
| Composer | Suggestion chips | Prefill a suggested question | |
| Message in progress | Working indicator + **Cancel** | Spinner, "Thinking…" (or the step's note, "Queued (N ahead)…"), the ticking "step k/4 · Ns · $x" line; Cancel stops after the current step ("Stopping after the current step…") | `POST /api/assistant/conversations/{conv_id}/jobs/{job_id}/cancel` |
| Failed message | **Retry** / **Raise limit** | Send again / raise the limit that stopped it | |
| Answer | Reference chips and linked ids | View a turn, select an entity or point, open a run, open a docs section, flash a control (no approval needed) | |
| Offline answer | "Docs search (AI offline)" | Shown when no model is available: the best matching docs sections | |

### Working indicator (*new*)

Wherever a model is working (the drawer's message in progress, Story Mode,
the Storybook tab, Dictate's "Transcribing…") the UI shows the same indicator: a spinner (a
static dotted ring when the system asks for reduced motion), what is happening, and an elapsed
counter that ticks in the browser from the job's start. Screen readers hear the label once, not
every tick.

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
| Pick a run | Run list | Choose a run (nothing is opened or spent). Runs with an unfinished story (choosing, brief ready, writing, paused, interrupted) are listed first, most recently touched first, shaded, with a **Stories** column saying what is going on ("writing 3 of 11 · title", "Story brief waiting for you · title") and a **Continue story** button that opens that story; other runs follow, newest saved first, with **Story** | `GET /api/runs`, `GET /api/assistant/stories?status=all` |
| Pick a run | **Finished stories** (N) (top right of the filter row) / **Hide finished stories** | Toggle a panel above the table listing the complete stories of every run, most recent first: title, run, chapters, spend, finished time, **Read** (opens the story) and **Back to runs** | `GET /api/assistant/stories?status=all` |
| Run card | Quick picks: genre, tone, vividness (1-5), point of view (chronicler or follow an agent), turn range; free text; **Dictate** | The deterministic run card (cast, rounds, deaths, highlights) plus your choices | `POST /api/runs/{run_id}/assistant/stories` |
| Interview | **Write the story brief** (**Send the changes** after Change) | One author call writes the story brief; while it works the button reads "Writing the brief…" with a spinner, the composer is disabled and the interview shows the author's pending reply | `POST /api/runs/{run_id}/assistant/stories/{story_id}/messages` |
| Story brief | **Accept** / **Change** / **Cancel** | Start the chapters / ask for a revised brief / drop it | `.../approve`, `.../messages`, `.../reject` |
| Reader | Chapter list, previous / next | Read; the next 3 chapters are written ahead of you | `GET .../stories/{story_id}/chapters/{n}` |
| Reader | **Generate all** (est. $X, ~Y min) | Write every remaining chapter now | `POST .../stories/{story_id}/continue` |
| Reader | **Continue story** | Extend a story pinned to an end turn over newer turns | `POST .../stories/{story_id}/continue` |
| Working banner (under the header) | Label, elapsed counter, **Cancel** | Shown while a model works for the story: "Sending your choices to the story author…", "Story author is thinking…", "Writing chapter 3 of 11…", "Queued behind …", "Stopping after the current chapter…"; the header badge pulses. Cancel stops the author or the chapter job after the current chapter (the story becomes cancelled; written chapters stay) | `POST .../stories/{story_id}/cancel` |
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
| Arrows, Home, End | **Map view** switch (focused) | Switch between **2D map** and **3D view** |
| W A S D | 3D view (focused) | Fly forward, back and sideways (faster the higher the camera) |
| Space / Shift | 3D view (focused) | Go up / go down |
| Q E, ← → | 3D view (focused) | Turn left / right |
| ↑ ↓ | 3D view (focused) | Look up / down |
| PageUp / PageDown | 3D view (focused) | Layer up / layer down |
| F / T / Home | 3D view (focused) | Frame the region / top view / fly to the selected cell |
| R | 3D view (focused) | Replay the viewed turn |
| ? or H | 3D view (focused) | Show or hide the help card |
| Escape | 3D view (focused) | Close the help card, else the cell tooltip, else cancel a drag; otherwise it reaches the profile card |
| Arrows, Home, End, double-click | splitters | Resize, min, max, reset |
| Enter | find bar, map Go to, forms | Submit |
