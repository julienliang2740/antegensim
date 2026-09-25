Empyrean working copy (literal god mode)
=======================================

This folder is a human-editable copy of the run's latest committed checkpoint.
The turn it was made from is written in BASE_TURN.  Editing files here changes
nothing until you reload them.

How to edit
-----------
1. Pause the run (the "Pause" button, or POST /api/runs/{run_id}/commands with
   {"command": "pause"}).  Every committed turn overwrites this folder with the
   new checkpoint, so edit only while the run is paused.
2. Edit any file below with a text editor.  Keep valid JSON.
3. Reload: the "Reload working files" button, or
   POST /api/runs/{run_id}/working/reload
   Every file is parsed and validated.  If anything is invalid (bad JSON, a wrong
   field type, a reference to a missing entity, a position outside the region,
   ...) the errors are listed with the file and the problem, NOTHING changes, and
   your edited files stay here so you can fix them and reload again.
4. A valid reload shows the before/after value of every changed field and stages
   one "apply_working_files" intervention (origin "file") holding exactly those
   field changes (and a snapshot of what you reloaded).  It is applied at the
   next turn boundary, and only if the run is still at the same committed turn
   (BASE_TURN); otherwise it is recorded as stale and not applied.  Later edits
   need another reload.
5. Order with UI edits: staged edits are applied in the order they were staged,
   and a file edit is applied as its field-by-field diff onto the state at that
   moment, so UI edits staged before or after the reload (voice, placements,
   stat changes, settings) all survive.  A field changed both in the UI and in a
   file keeps the value of the edit staged later.  If a change can no longer be
   applied (for example the entity it edits was removed by an earlier staged
   edit) or the result would be invalid, the whole file edit is recorded as
   failed with the reason and nothing of it is applied; the other edits still
   apply.  The record shows the value each field really had when it was changed.

Files
-----
BASE_TURN                       committed turn this copy was made from (do not edit)
map.json                        region and terrain per "x,y" cell; occupants are
                                recomputed on reload, so editing them has no effect
rules.json                      every gameplay rule and price (RulesConfig).  It does
                                not contain the assumptions table: edit the rule keys.
settings.json                   model assignment and context/memory settings (RunSettings)
world.json                      round, entity id counters, random-number state, observe page size, generation warnings and the
                                agent order
entities/agents/<id>.json       one agent each: stats, skills, skill execution state
entities/knowledge/<id>.json    what that agent knows: records and notebook
entities/plants.json            {id: plant}   (fruits.json, seeds.json, residues.json alike)
entities/removed.json           ids that left the world and why
staged_edits.json               interventions staged in the UI (managed by the app)
pending_model_calls/            in-flight model call records (managed by the app)

Notes
-----
* Adding an agent by hand needs both entities/agents/<id>.json and
  entities/knowledge/<id>.json; the UI "place entity" does this for you.
* Changing reality (for example placing a fruit) does not tell any agent.  Edit a
  knowledge file to change what an agent knows.
* To change the past instead, create a continuation from a recorded turn; the
  original run and its later turns are kept.
