# Browser QA: re-test after the final fix passes

This file covers two browser passes against the shared servers (UI at http://127.0.0.1:5173 through Vite PID 130830, backend at http://127.0.0.1:8000). Both used Chromium (Playwright 1.49 from `qa/`) and fake models only (`fake-heuristic`, with `fake_options` `sleep_ms` / `fail` in pass 1). No live model call was made.

| Pass | When (UTC, 2026-09-25) | Backend | Viewports | Scripts, log, proof screenshots |
| --- | --- | --- | --- | --- |
| 1: after the final fix pass | 19:19–19:37 | PID 227025 | 1440x900 (1100x750 for the layout rows) | `qa/retest/*.mjs`, `qa/retest/log.txt`, `qa/retest/shots/` |
| 2: after the reload-order fix pass | 20:32–20:48 | PID 270011 (the final code) | 1440x900 and 1100x750 | `qa/retest2/*.mjs`, `qa/retest2/log.txt`, `qa/retest2/shots/` |

**Curated screenshots:** `docs/evidence/screenshots/01…18`. Pass 2 refreshed `04-run-paused.png`, `08-crowded-cell-hover.png`, `09-crowded-cell-occupants.png` and `10-agent-inspector.png` (same names). The others are from pass 1 and show views that pass 2 did not change.

Every screenshot listed below, and every screenshot the two passes took, was opened and checked by eye.

**Runs created in pass 2** (all in `worlds/`, all closed at the end):

| Run | Purpose |
| --- | --- |
| `run_20260925_203239_cc92`, `run_20260925_203258_a811` | reload order at 1440x900: UI edits, then reload / reload, then UI edits |
| `run_20260925_204758_a27f`, `run_20260925_204817_b30a` | the same two orders at 1100x750 |
| `run_20260925_203345_9f0c` | reload conflict (the file edit targets an agent removed by an earlier staged edit) |
| `run_20260925_203435_6758` | `retest2 main 203435`: 8 agents, rounds 1–6, a 7-occupant agent cell and a 16-occupant cell |
| `run_20260925_204523_b57a` | created from the UI for `04-run-paused.png` |
| `run_20260925_204356_ab06`, `run_20260925_204447_d374` | `qa/browser_check.mjs` (normal run and 503 error run) |

The pass-2 regression run of `qa/browser_check.mjs` passed 17 of 17 steps, with no console errors and no page errors (`qa/out/2026-09-25_20-43-52/`). Pass 1's run also passed 17 of 17 (`qa/out/2026-09-25_19-34-22/`).

## 1. Pass 2: the reload-order fix and the pass-1 minors

"Pass" means the reported problem no longer shows. Staging in rows A and B went through the UI (quick voice box, God mode Place entity / Plant rules / Set stat forms, quick run-default context box, "Reload working/ files"); the results were then read in the Turn record tab and checked through the API. In this section, `shots/…` means `qa/retest2/shots/…` and `screenshots/…` means `docs/evidence/screenshots/…`.

| # | Pass-1 issue | Result | Proof |
| --- | --- | --- | --- |
| A | **Major.** A working/ reload silently undid God mode edits staged before it in the same boundary | **Pass, in both orders and at both viewports.** Staged: voice to a01, fruit placed at (0, 0) with compute 33, `fruit_tree` fruit_energy 60 → 70, run-default recent history 5 → 3, `set_stat a05.stats.health = 55`, and a working/ reload of `a05.json` with health 77. After Run turn, all 6 records are `ok` and in staging order (`iv_0001…iv_0006`), in the turn record, the API and the log. Every edit survived: a01 has 1 `operator_voice` record, fruit `f0013` (compute 33) is at (0, 0), fruit_energy is 70, recent_history_length is 3. On the field that both edits change, the edit staged later wins, and its record shows the real before value (see the table below). | `shots/r1-ui-then-file-staged-1440x900.png`, `r1-ui-then-file-turn-record-1440x900.png`, `r1-file-then-ui-staged-1440x900.png`, `r1-file-then-ui-turn-record-1440x900.png`, and the same four at 1100x750 |
| B | (new check) A reload whose target an earlier staged edit removes | **Pass.** A UI `remove_entity a05` was staged before a reload that changes a05 (health 77) and a03 (health 88). The removal applied. The file edit is recorded as failed, in red, with the path and reason: "cannot apply the file edit onto the current state: world.agents.a05.stats.health: world.agents.a05 does not exist any more (removed or renamed by an earlier staged edit?)". Nothing of it applied (a03 health stayed 100). | `shots/r1b-conflict-turn-record.png` |
| C | The map hover tooltip was clipped by the 360 px map viewport and drawn over the hovered cell | **Pass.** Measured on the 16-occupant cell (-2, 0) and the 7-occupant agent cell (0, 0), at 1440x900 with the wide inspector on and off, with no selection, and at 1100x750. The tooltip is always fully inside the window, never over the hovered cell, and on top (the probe found the tooltip at all 4 corners and the centre). Nothing inside it is clipped (scrollHeight = clientHeight, no stats line cut). Example at 1440x900 with the wide inspector: tooltip x 258–648 beside cell 204–249, map viewport 27–387. The tooltip lists each occupant with its stats line ("health 100/100 · compute 199.796 · essence 20/100", "fruit_tree · mature (stage 2) · 0 fruit · essence 9", "compute 5 · essence 2 · from agent a99"). The 16-occupant cell shows 8 rows and "+8 more — click the cell to list all". Scrolling the page hides the tooltip. | `screenshots/08-crowded-cell-hover.png`, `shots/h-1440x900-wide-true-hoverB.png`, `h-1440x900-wide-false-hoverA.png`, `h-1440x900-wide-false-hoverB.png`, `h-1100x750-*.png` |
| D | The occupant list hid rows below a 260 px fold with no cue | **Pass.** The list now grows to 600 px. The 7-occupant cell fits (446/446 px, no cue). The 16-occupant cell overflows (795 px of content in a 598 px box) and shows "16 occupants — scroll for more ▾" over a bottom fade. All 16 rows are listed; each was scrolled into full view and the last one (s0005) opens its inspector. At the end of the list the cue is gone. The same holds at 1100x750. | `screenshots/09-crowded-cell-occupants.png`, `shots/o-1440x900-16-cell-end.png`, `o-1440x900-7-cell.png`, `o-1100x750-16-cell-top.png`, `o-1100x750-16-cell-end.png` |
| E | "Current action and result → data" was cut at 200 characters with no expand | **Pass.** The data row shows a cut preview and "Show full JSON (518 chars)". Clicking it shows the full pretty-printed observation (996 characters, all 6 co-located ids) in a scrollable block, with no sideways overflow (598/598 at 1440, 712/712 at 1100). The button then reads "Hide full JSON" (`aria-expanded=true`), and Hide restores the preview. | `screenshots/10-agent-inspector.png`, `shots/d-1440x900-data-expanded.png`, `d-1100x750-data-expanded.png` |
| F | God mode Set stat showed float noise and a too-narrow input | **Pass.** For a01 `stats.compute` (stored as 199.79560000000004), "Current value" reads `199.796` with the hint "stored exactly as 199.79560000000004". The New value input reads `199.7956`, is 220 px wide, and the text fits. | `shots/s-1440x900-set-stat.png`, `s-1100x750-set-stat.png` |
| G | The next-round prediction named only the first 3 of 8 agents | **Pass.** The Next step row reads "start round 5 — likely order (8 agents): a08 Halcyon, a06 Ferrin, a05 Eos, a02 Boreas, a03 Cyrene, a04 Damaris, a01 Aster, a07 Galene (predicted; staged edits can change it)". It names all 8 agents in the backend's `next_round_order`, wraps (white-space normal, not clipped) and adds no page overflow at either viewport. A run freshly created from the UI shows the same at `r00000_init`. In rounds 5 and 6, the agents that then acted first and second matched the prediction. | `screenshots/04-run-paused.png`, `shots/n-1440x900-next-step.png`, `n-1100x750-next-step.png` |
| H | Agent view was labelled, not filtered | **Pass, with one remaining minor (§4).** With a01 selected and Agent view ON, the map banner reads "Agent view: only what Aster (a01) has observed. …". Badges are drawn only on the cells the agent knows about: (0, 0) only. The badge cells match `observed_entities` plus the believed position, so no other agent, plant or the 16-entity cell is drawn. The occupant list reads "Known at (0, 0) · 8 entities" with the note "agent view: only what this agent has observed". Its 8 rows are exactly a01's 7 sightings plus "a01 Aster (you)". Each row carries its sighting line ("observed in round 4 · at the position it was last seen"), and no true values are shown. The hover tooltip reads "8 known here", and "show removed-entity markers" is hidden. | `shots/av-1440x900-map-and-list.png`, `av-1440x900-hover-own-cell.png`, `av-1100x750-map-and-list.png`, `av-1100x750-hover-own-cell.png` |
| I | Regression: `qa/browser_check.mjs` | **Pass:** 17 of 17 steps, 0 console errors, 0 page errors. | `qa/out/2026-09-25_20-43-52/` |

Row A in numbers (a05 health, the one field that both the file edit and a UI edit change):

| Order (both viewports) | Records | Record of the earlier edit | Record of the later edit | a05 health after |
| --- | --- | --- | --- | --- |
| UI edits, then reload | 6 × ok, `iv_0001…iv_0006` | `iv_0005 set_stat`: 100 → 55 | `iv_0006 apply_working_files`: 55 → 77 | 77 |
| Reload, then UI edits | 6 × ok, `iv_0001…iv_0006` | `iv_0001 apply_working_files`: 100 → 77 | `iv_0006 set_stat`: 77 → 55 | 55 |

In both orders the staged list shows the file edit's diff as taken at reload time (`world.agents.a05.stats.health: 100 → 77`). The hint next to "Reload working/ files" explains the order, the field-diff rule, that the later-staged edit wins, and that a file edit is rejected as a whole.

## 2. Reviewer findings: re-test results (pass 1; rows 3, 9, 20 and 21 updated in pass 2)

"Pass" means the reported problem no longer shows. "Partial" means it is mitigated but the underlying gap is still there. In this section, `shots/…` means pass 1's `qa/retest/shots/…`.

| # | Reviewer finding (source) | Result | Proof |
| --- | --- | --- | --- |
| 1 | World settings form lacks `plants_at_agent_starts` / `initial_plant_fruit` (live-sim) | **Pass.** The checkbox "plants at agent starts" and the number field "initial fruit per plant" are shown. A run created from the UI with them off / 0 had 12 plants, 0 fruit and no plant on an agent start cell. | `../../qa/retest/shots/a02-world-settings-fields.png`, `k01-world-fields-off.png` |
| 2 | Storage grows quadratically: every turn stores every agent's knowledge (resilience) | **Pass** (checked on disk). Across 40 turn dirs, every agent-turn dir holds only the one changed knowledge store, and `world.json.knowledge_files` covers all 8 agents. The mean agent-turn dir is 116 KB (rounds 1–5). | log.txt ("mean knowledge files per agent turn 1.0") |
| 3 | Inspector overflows sideways at 1440x900; knowledge text column about 40 px (review1, major) | **Pass.** The wide inspector is on by default (`aria-pressed=true`, 604 px). All 11 sections have scrollWidth equal to clientWidth (598/598). The narrow mode (429 px) also has no overflow. Knowledge records are full-width blocks (text 566 px). The separate 200-character cut of the action `data` is fixed in pass 2 (§1 row E). | `screenshots/10-agent-inspector.png`, `shots/c01-knowledge-records.png`, `c02-recent-results.png`, `c03-knowledge-records-narrow.png` |
| 4 | Failed model call labelled "answered" (review1) | **Pass.** The pending line now reads "— failed (see next line)". | `screenshots/17-error-state.png`, `shots/i02-log-after-rerun.png` |
| 5 | After Recover and a re-run, the failed attempt's `round_started` / `turn_started` lines look like real history (review1) | **Pass.** Lines #2 and #3 are struck through (`text-decoration: line-through`) and tagged "discarded attempt: not saved". The saved turn holds seq 4–12, which matches the log. | `shots/i02-log-after-rerun.png` |
| 6 | A valid working/ reload hides the before/after values (review1) | **Pass.** The UI shows "1 field will change … world.agents.a05.stats.health: 100 → 77", and the staged row lists the same change. | `shots/e01-working-reload-changes.png`, `e03-staged-list.png` |
| 7 | Run name input overlaps the Seed hint (review1, review2) | **Pass.** Input right edge 362 vs hint left edge 380 at 1440x900; 365 vs 383 at 1100x750. | `shots/a01-setup-top-1440.png`, `a04-setup-top-1100.png` |
| 8 | The God mode quick-panel context table spills 79 px at 1100x750 (review1) | **Pass.** Table right edge 730, box right edge 741, no page overflow. | `shots/e06-quick-panel-1100.png` |
| 9 | Agent view still shows an omniscient map and occupant rows (review1) | **Pass in pass 2** (was Partial in pass 1). The map and the occupant list now show only what the selected agent has observed, at last-seen positions, plus itself at its believed position, with no true values (§1 row H). One minor remains: clicking another cell or a sighting row deselects the agent and the view turns omniscient again (§4). | `../../qa/retest2/shots/av-1440x900-map-and-list.png` (pass 1: `shots/c04-agent-view.png`) |
| 10 | Plant inspector does not say why a plant is not fruiting (review1) | **Pass.** The "next fruit" row reads "waiting — interval: due in 1 round; energy: needs 60, has 48 (+12/round → about 1 round)". The "next seed" row is shown too. | `screenshots/13-plant-inspector-rules.png` |
| 11 | working/ path is relative and contradicts its hint (review1) | **Pass.** The absolute path `/home/ubuntu/antegensim/worlds/…/working/` exists on disk, and the hint says "An absolute path on the machine that runs the backend". A reload error names the file: `working/entities/agents/a02.json: health 500.0 exceeds max_health 100.0`. | `shots/e01-…png`, `e02-working-reload-invalid.png` |
| 12 | STAGED EDITS lags the God mode tab count by about 1.3 s (review1) | **Pass.** The tab count changed at 101 ms and the status bar at 213 ms. The mismatch lasts about 0.1 s and is not noticeable. | log.txt ("staged-count samples") |
| 13 | Shared backend on :8000 ran the pre-fix code (review2-live) | **Pass** (config). The backend started at 19:06:24, after the last backend source change (19:03:55), and `/api/defaults` serves the new world fields. The claude CLI fix itself was not called live (fake-only task). | `ps` / mtime check in the report |
| 14 | "nothing was charged" wording although the provider billed (review2-live) | **Pass** (fake path). The panel reads "infrastructure failure: no world compute was charged and no memory was marked read; the provider reported no cost for this attempt". The log reads "no world compute charged". The "provider still billed $X" branch cannot be reached with fakes. | `screenshots/17-error-state.png` |
| 15 | Reasoning tokens never shown (review2-live) | **Pass.** Checked read-only on the stored live haiku run (no run control pressed): the record viewer shows "output 647 (of which reasoning 397)", and the log shows "7.3 s · 397 reasoning tokens (part of output)". | `shots/j02-live-model-call-record.png` |
| 16 | Provider cost printed with float noise (review2-live) | **Pass.** The costs read `$0.00704` and `$0.013252`. | `shots/j02-…png`, `j03-live-failed-call-record.png` |
| 17 | A pending line whose call failed says "answered" (review2-live) | **Pass.** Same fix as row 4. The stored live run also shows "— failed (see next line)". | `shots/j02-…png` (log column) |
| 18 | The "Model call in progress" view uses finished-call wording (review2-live) | **Pass.** The view reads "pending (the model has not answered yet)", "still running", "latency pending", "usage: waiting for the reply", "provider cost: waiting for the reply", "(waiting for the reply)". | `shots/h01-pending-call-view.png` |
| 19 | Run name overlap on New session (review2-live) | **Pass.** Same fix as row 7. | as row 7 |
| 20 | At a round boundary the UI shows only "start round N (new initiative order)" (review2-live) | **Pass in pass 2** (was Partial in pass 1). The row now lists every agent in predicted order: "start round 5 — likely order (8 agents): a08 Halcyon, a06 Ferrin, … a07 Galene (predicted; staged edits can change it)", and the row wraps instead of cutting (§1 row G). In pass 1 the predictions matched the real orders of rounds 2–5. | `screenshots/04-run-paused.png`, `../../qa/retest2/shots/n-1440x900-next-step.png` |
| 21 | Status bar grows a line once usage text lengthens (review2-live) | **Partial in pass 2** (Pass in pass 1). The usage text no longer changes the height. However, the Next step row now wraps to list every agent (row 20), so at every round boundary the bar grows: 173 → 191 px at 1440x900 (tabs y 386 → 403) and 173 → 208 px at 1100x750 (tabs y 431 → 466). It shrinks back after the first turn of the round (§4). | `qa/retest2/log.txt` ("R9"), `../../qa/retest2/shots/n-*.png` |

## 3. Required browser flows (curated evidence set)

| Scenario | Result | Screenshot |
| --- | --- | --- |
| Entry page offers New session and Resume session (U10) | Pass | `screenshots/01-entry.png` |
| New session shows 8 prefilled, editable agent cards (U11) | Pass | `screenshots/02-new-session-cards.png` |
| An invalid card value (health 999) is shown by path `agents[0].stats.health`; no run is created until it is fixed | Pass | `screenshots/03-new-session-validation-problem.png` (inline field message: `shots/a03-validation-card1.png`) |
| The created run opens Paused at `r00000_init`, with the predicted next-round order naming all 8 agents | Pass (pass 2) | `screenshots/04-run-paused.png` |
| Play with a pending model call: "Waiting for model", the call id and seconds, and the pending log line "WAITING FOR MODEL…" | Pass | `screenshots/05-playing-pending-call.png` |
| Pause during a call: "Pause requested", then Paused after the turn is saved | Pass | `screenshots/06-pause-requested.png` |
| History: Previous round and turn select show the HISTORY banner and the turn record; Return to live | Pass | `screenshots/07-history-view.png` |
| Hovering a crowded cell lists its occupants with stats: agent, plant, 3 fruit, residue, seed (7), and the removed f0001; the tooltip sits beside the cell, fully in the window (the 16-occupant cell shows 8 rows and "+8 more") | Pass (pass 2) | `screenshots/08-crowded-cell-hover.png` |
| Clicking the cell lists every occupant by group; each opens its inspector; a 16-occupant list shows "16 occupants — scroll for more" until its end | Pass (pass 2) | `screenshots/09-crowded-cell-occupants.png` |
| Agent inspector: stats, action and result (data with "Show full JSON"), model, skills, believed self, messages, results, notebook, knowledge (U2) | Pass (pass 2) | `screenshots/10-agent-inspector.png` |
| Decision packet: sections with token estimates, selected records, settings | Pass | `screenshots/11-decision-packet.png` |
| Model call record: usage, world compute, cost, output, parsed JSON | Pass | `screenshots/12-model-call-record.png` |
| Plant inspector: instance and species rule, next fruit and next seed explained; the species rule change is staged (U3) | Pass | `screenshots/13-plant-inspector-rules.png` |
| God mode voice to chosen agents is staged (U7); combined with a working/ reload it survives in either order (§1 row A) | Pass | `screenshots/14-god-mode-voice.png` |
| God mode run-default context settings: recent history 5 → 3 is staged (U16) | Pass | `screenshots/15-god-mode-context-settings.png` |
| Continuation from history turn `r00004_t04_a02` opens paused with a parent link | Pass | `screenshots/16-continuation.png` |
| Error state (fake 503 x3): failed turn, cause, honest cost wording, controls disabled, Recover (pause) | Pass | `screenshots/17-error-state.png` |
| Resume session list; opening a run resumes it Paused at its last saved turn | Pass | `screenshots/18-resume-session.png` |

## 4. Remaining issues (after pass 2)

### Major

None. The pass-1 major (a working/ reload undoing earlier UI edits) is fixed (§1 rows A and B).

### Minor

- **Agent view works only at the agent's own cell.** Agent view is tied to the selected entity, and a map click that is not at the selected entity's true position clears the selection (`RunPage.selectPoint`). So in agent view, clicking any other cell (for example (-2, 0)), or clicking a sighting row in "Known at" (for example f0013), deselects the agent. The map and the occupant list then turn omniscient again, with the warning "Agent view is on, but no agent is selected …, so the map shows everything". The warning is honest. However, the "Known at (x, y)" list cannot be opened for any cell other than the agent's true cell, including its believed cell when that differs. Other cells can be read only through the hover tooltip, which shows at most 8 rows. This matters once an agent has sightings on several cells (vision range above 0, movement, queries). Proof: `qa/retest2/shots/av-1440x900-after-other-cell-click.png`, `av-1440x900-after-sighting-click.png`, and the same at 1100x750.
- **The status bar changes height at every round boundary.** Because the Next step row now wraps to list every agent, the bar grows from 173 to 191 px at 1440x900 and from 173 to 208 px at 1100x750 while the next step is "start round N". It shrinks back after the round's first turn. During Play, the tabs, map and inspector therefore jump down and back once per round (by 17 px or 35 px). Proof: `qa/retest2/log.txt` ("R9"), `shots/n-1440x900-next-step.png`, `n-1100x750-next-step.png`.
- **A species-rule edit record does not show which field changed.** The turn record's `update_plant_rules` row has one line (`world.rules.plant_species.fruit_tree`) whose before and after are both cut JSON previews starting with `{"name":"fruit_tree","description":"Default…`. To see fruit_energy 60 → 70, you have to expand both ~1,300-character JSON blocks and compare them by eye. The log line is the same. Proof: `qa/retest2/shots/r6-plant-rule-record-expanded.png`, `r1-*-turn-record-*.png`.
- **Legacy runs lack the new cost fields** (from pass 1, not re-tested). Runs saved before that fix (for example the review2 live run) show no reasoning tokens or USD on the turn-record call buttons, and no "provider billed" note on failed-call log lines. The full record viewer shows both.

### Observations (by design, not defects)

- At 1100x750 the map tab is one column. The "Wider inspector" toggle is hidden there (`@container (max-width: 859px)`). After a cell click, the occupant list starts at the window's bottom edge (its heading peeks in at y ≈ 740 of 750) and the page does not scroll to it (`shots/o-1100x750-right-after-click.png`).
- Agent view keeps a sighting until a newer one replaces it. a01 queried fruit f0001 in round 2 and consumed it in round 3; agent view still lists f0001 at (0, 0) as "queried in round 2 · at the position it was last seen". This matches INTERFACES 4.3 (observed entities come only from observe / query records).
- In agent view, hovering a cell the agent knows nothing about shows no tooltip. The same is true of empty cells in the normal view.
- `01-preflight.png` in the browser_check output is blank by design (it is taken before any page loads).
