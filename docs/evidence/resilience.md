# Resilience and completion-criteria evidence

Final pass of 2026-09-25 (20:44–20:48 UTC) against the spec's "Completion criteria and implementation freedom"
list (`llm_world_technical_spec.md`), through the real HTTP API with fake models only. No live model call was made.

| Item | Value |
| --- | --- |
| Backend | own process, `python -m empyrean.main` on `127.0.0.1:8040` (a second writer on 8041 in scenario i), `EMPYREAN_WORLDS_DIR=qa/resilience/worlds-final` (fresh). SIGKILLed and restarted during scenarios a and a2; stopped at the end. The shared servers (backend :8000, Vite :5173) were not touched. |
| Code under test | `code_revision` `a11e51b+dirty.67f19b11` (from the runs' `manifest.json`); sha256 prefix of `backend/empyrean/*.py` `1132bcec6042` at both the start and the end of the batch. |
| Models | `fake-heuristic`, `fake-scripted`, `fake-malformed` (plus the fake `fail` and `sleep_ms` options) |
| Reproduce | `RES_PORT=8040 RES_WORLDS=$PWD/qa/resilience/worlds-final RES_OUT=$PWD/qa/resilience/out-final RES_LOG=$PWD/qa/resilience/out-final/server.log bash qa/resilience/run_all.sh` (about 3.5 minutes). Without the variables it uses port 8020, `qa/resilience/worlds` and `qa/resilience/out/`. |
| Result | **13 scripts, 165 of 165 checks passed.** No new defect. |
| Evidence | Logs: `docs/evidence/final_pass/resilience/<scenario>.log` and `run_all.meta` (copied from `qa/resilience/out-final/`, which also holds the `<scenario>.json` files with every check's evidence and the run ids). Run folders: `qa/resilience/worlds-final/<world>/runs/<run>/`. |

## Suite realignment (this pass)

The fix pass changed three rules on purpose; 19 checks asserted the old ones and were updated to INTERFACES rev 3:

* **Ledger rule** (INTERFACES §4.5, §8): every committed call record counts in `calls`; an interrupted record also
  counts in `interrupted_calls` (a subset). `RunStatus.real_usage` adds the uncommitted records by the same rule.
  Updated: 5 checks in `a_crash_resume.py` (plus one new check of the status view after the double crash, and token
  sums in the after-crash invariant) and the `ledger_ok` invariant in `a2_kill_stress.py` (12 failing checks before;
  now `calls == records`, `interrupted_calls == interrupted records`, token sums equal).
* **Knowledge files** (§5, §13): a turn dir holds `entities/knowledge/<id>.json` only for the stores that changed,
  and `world.json` `knowledge_files` names, for every agent, the turn dir holding its file. `j_storage.py` now checks
  that map, the "only changed stores" rule, and that every turn loads through the API. `g_voice.py` and
  `k_other_bullets.py` resolve knowledge through the map (`rlib.read_knowledge_file`).
* **Continuations** (§5, §11): the first turn of a continuation is the parent's resolved checkpoint. `h_working_continuation.py`
  now checks that the non-knowledge files are byte-identical, that `world.json` is equal apart from the map, that every
  knowledge file is present and equal to the parent's resolved file, and that the API shows the same turn.

Also new: `rlib.py` takes `RES_PORT`, `RES_PORT2`, `RES_WORLDS`, `RES_OUT` and `RES_LOG`; `run_all.sh` passes them through.
`l_reload_order.py` is new: it checks the fix-pass reload rule (A-GOD-1) over HTTP.

## Results

| # | Criterion | How verified | Result | Evidence |
| --- | --- | --- | --- | --- |
| a | 8-agent run survives `kill -9` during `waiting_model` and continues without losing state or repeating a committed action | Fake-heuristic, seed 1, `sleep_ms` 3000. The run plays to `r00002_t05_a01`, pauses, gets `run_turn`, and the server is SIGKILLed while waiting on `mc_r00002_t06_a02_01`. Then restart, reopen, re-run and play to `r00004_end`. The result is compared with an uninterrupted reference run. Extra: a double crash on one turn. | **PASS 27/27.** Before the kill, the pending file (with its request) was on disk. After the kill the manifest was still at `r00002_t05_a01`, with no partial dir. The run reopened paused, with a new `feed_epoch`, and recovery left the ledger on disk untouched. The status view showed calls 13→14 and interrupted 0→1. The turn re-ran as `[_01 failed "interrupted (outcome uncertain)" charged 0, _02 completed]`, and the commit brought the ledger to 15 calls, 1 interrupted. At `r00004_end`: 37 turns, index = chain, 214 events with no gap or duplicate, and ledger 33 calls / 1 interrupted = the sum of the records. Actions, results and all 8 agent files match the reference. In the double crash, `r00005_t01_a08` holds `_01`, `_02` (interrupted) and `_03`; the ledger went to 36 calls / 3 interrupted, equal to the records. | `a_crash_resume.log`; runs `run_20260925_204421_9710`, reference `run_20260925_204418_383b` |
| a2 | (extra) `kill -9` at random moments of continuous play | 12 random SIGKILLs during `play` (`sleep_ms` 150): 11 in `waiting_model`, 1 in `turn_active` with a `.partial_*` dir on disk. After each restart and open the invariants are checked, and the run is compared with a reference at the end. | **PASS 15/15.** After every open: index = manifest chain, no duplicate turns, seqs or call ids, and a ledger equal to the committed records (final: 52 records, 12 interrupted, ledger `calls 52, interrupted_calls 12`, tokens equal). No unreachable or partial dirs remain. All 46 turns and the final agents are identical to the reference. | `a2_kill_stress.log`; runs `run_20260925_204604_2ec0`, `run_20260925_204622_3e1b` |
| b | New and resumed sessions open paused; cards have defaults; Run turn / Play / Pause / Step round | `GET /defaults` for 6, 8, 11 and 12 agents; invalid and valid card edits; `run_turn` ×2, an overlapping command, `play`, `pause` (also while paused), `step_round` ×2; close/reopen, including closing mid-play | **PASS 22/22.** 6, 8 and 11 prefilled cards; 12 gives 422. Problems come by path (`agents[2].stats.health`, `agents[5].name`). The run opens paused at `r00000_init`, and each `run_turn` commits one turn. An overlapping command gives 409. Pause goes `pause_requested` → `paused`. `step_round` stops at `r{n}_end`, and a reopen is paused at the last commit. | `b_controls.log` |
| c | Stored playback needs no model calls | Two browsing passes (closed, then open and paused) over 8 turns of the run from (a): turn views, events, knowledge, packets and model calls | **PASS 8/8.** There were 36 call files before and after; turn files are hash-identical; seqs and ledger did not change. The server log gained 112 GETs and no `model call provider=` line (166 such lines exist from the play phases). | `c_playback.log` |
| d | Malformed output and invalid actions fail safely with the design's fees | a01/a02 fake-malformed; a03 fake-scripted with 10 impossible or invalid decisions; a05 gets a truncated reply; 11 rounds | **PASS 15/15.** No error state and no traceback. The fees: blocked 1, insufficient_compute 0, target_gone 1, at_limit 1, insufficient_essence 0, target_gone 1, invalid_argument 1. Format-gate rejections cost cognition only. Nothing else changed, and the reasons are in a03's knowledge. | `d_invalid.log` |
| e | Direct and skill actions share rule enforcement (design example 1) | a03 saves and runs example 1; a06 runs a skill into a mountain, then moves directly into it | **PASS 8/8.** 3 agent turns of skill moves at 4.0 each (the 4th turn is a model decision, with a direct move at 5.0), and a direct query at 1.0. Interpreter work is charged separately (0.17). Blocked costs 0.8 via the skill and 1.0 direct. | `e_skill_vs_direct.log` |
| f | Context settings at creation and in god mode apply at the next boundary and show in history | Run and a02 context set at creation; run-scope and a02-scope changes staged, plus an invalid cap of 10 | **PASS 15/15.** The invalid cap gives 422 with problems. Both changes applied at `r00002_t01_a04` with before/after recorded; the previous turn keeps the old values, and the packets use the new ones. | `f_context_settings.log` |
| g | Operator voice reaches exactly the selected recipients | Voices to [a01], [a02, a05] and all | **PASS 7/7.** The events have exactly those recipients. The records (provenance `unknown`, `sender_visible: false`) are in exactly the recipients' knowledge and their next packets. | `g_voice.log` |
| h | `working/` edits + reload apply before the next turn and are recorded; a continuation from history keeps the parent's future | Three invalid reload cases, then valid edits (a01 compute 777.25, p0001 energy 42, `retrieved_memory_limit` 9), then `run_turn`. The parent plays 3 more rounds, and a continuation is made from `r00001_end`. | **PASS 17/17.** Invalid files give `ok:false` with one problem per file; a parse error list ends with the hint `working/: fix the JSON errors above first; semantic checks run once every file parses`. Valid edits are applied at `r00003_t01_a01` with before/after. The continuation's `r00001_end`: 19 other files byte-identical, `world.json` equal apart from the map, all 8 knowledge files written (the parent's dir held 0 of them locally), and every API view equal. It opens paused, and seqs continue from 53. All 27 later parent turns, the index and the manifest are unchanged. | `h_working_continuation.log`; parent `run_20260925_204656_eccb`, continuation `run_20260925_204659_0d38` |
| i | One active writer | A second backend process of mine (8041) on the same worlds dir | **PASS 9/9.** Open on 8041 gives 409 ("open in another process"), while history reads work. Commands, staging and reload give 409 `run_not_open`. After 8040 closes, 8041 can open and 8040 is refused. After 8041 is SIGKILLed, 8040 opens again. | `i_one_writer.log` |
| j | Storage per turn (8 agents) and the knowledge-file rule | 8 rounds, fake-heuristic, seed 1; bytes per turn dir; the `knowledge_files` map of all 73 turns; 73 turn views and 584 knowledge views through the API | **PASS 5/5.** Every map covers all agents and points at an existing file with that hash. The init turn holds 8 files, every agent turn exactly 1 (the actor's), and every round end 0. Every turn loads, and each knowledge view equals the file the map names. Sizes are in the table below. | `j_storage.log`; run `run_20260925_204704_74b7` |
| k | Live feed, point inspection, bounded and permitted context | Polling during play; crowded points at rounds 1/4/8; 64 packets of the run from (j) | **PASS 9/9.** Uncommitted events stream over 15 polls. Every co-located entity is listed and inspectable. Packets are ≤ their cap and hold only the agent's own records; 56 retrieve records older than a round, with no free refresh. Every event kind's summary now names the actor (D5 fixed). | `k_other_bullets.log` |
| l | (new) Reload and UI god-mode edits staged for the same boundary all survive (A-GOD-1) | After round 1, in both orders: a voice to a01, a placed fruit, `set_stat` a05 health 50, and run context `recent_history_length` 4, plus a reload editing a05 health 77 and a plant's energy 42. Then a conflict case: `remove_entity` of a fruit, then a reload editing that fruit and a05. | **PASS 8/8.** All 5 records are ok, in staging order. The voice, the placed fruit, the setting and the plant edit all survive. a05 ends at the later-staged value (77 for UI-then-file, 50 for file-then-UI), and each record shows what it replaced (`50→77` or `77→50`). In the conflict case the file edit is `ok:false` ("world.fruits.f0001 does not exist any more…"). Nothing of it applies (a05 stays 100), the removal stands, and the snapshot file is removed. | `l_reload_order.log`; runs `run_20260925_204717_c627`, `run_20260925_204718_38cc`, `run_20260925_204720_e3fb` |

### Spec bullet coverage

| Spec completion bullet | Covered by |
| --- | --- |
| Eight-agent run can pause, restart and continue without losing state or repeating a committed action | a, a2 |
| New/resumed sessions open paused; cards have defaults; Run turn, Play, Pause | b |
| Live terminal-style logs, clear run status, return from history to live | k (API side); the UI side belongs to `qa/browser_check.mjs` |
| A point and every occupant inspectable across rounds; knowledge and plant rules visible | k, c, j (API side); click/hover belongs to the browser QA |
| Direct and skill actions share rule enforcement; malformed or invalid output fails safely | d, e |
| Bounded context from the agent's permitted information; older memories retrievable without free refresh | k, g, f |
| Context settings changeable at creation and in god mode; saved and effective changes visible in history | f |
| UI and file edits apply before the next turn, are recorded, and can start a continuation from history | h, l, f, g |
| Operator voice reaches the selected recipients and their recorded experience | g |
| Same flow for every provider through configuration; stored playback needs no model calls | c (playback). Provider parity: only `claude_cli` is live here (see `live_sims.md`); the other adapters are covered by mocked-payload unit tests only |

### Storage (criterion j)

8 agents, fake-heuristic, seed 1, run `run_20260925_204704_74b7`. An agent-turn dir holds 23 files; `r00000_init` is 53,479 B.

| Round | Mean agent-turn dir (apparent / allocated) | of which knowledge | Round-end dir | Whole round (8 turns + end) | Bytes identical to the previous turn |
| --- | --- | --- | --- | --- | --- |
| 1 | 107,411 B / 172,032 B | 4,543 B | 51,035 B | 0.91 MB | 31.2 % |
| 4 | 119,549 B / 180,736 B | 11,257 B | 49,102 B | 1.01 MB | 28.2 % |
| 8 | 147,416 B / 208,896 B | 24,656 B | 53,571 B | 1.23 MB | 25.8 % |

Mean agent-turn dir at round 8, in bytes: model_calls 37,494; decision_packets 32,536; knowledge 24,656 (the actor's
file only); agents 12,449; plants/fruits/seeds/residues/removed 11,765; map 9,851; world 8,735; events 4,180;
rules 3,480; state 1,710; settings 560. A least-squares fit (round total ≈ 820,939 + 59,971 × round bytes)
extrapolates to **≈ 30.8 GB for a 1000-round, 8-agent run** (≈ 125 GB before the fix). What still grows is the
acting agent's own knowledge file (about 2.9 KB per round).

## Defects from the first QA batch: status on the final source

| ID | Severity | Defect | Status |
| --- | --- | --- | --- |
| D1 | major | Every turn copied every agent's full knowledge (≈ 125 GB per 1000 rounds) | **Fixed**: only changed stores are written (j); ≈ 30.8 GB per 1000 rounds. Still grows; see LIMITATIONS.md |
| D2 | minor | The two ledger helpers counted interrupted calls differently | **Fixed**: one rule, verified in a and a2 |
| D3 | minor | The prompt is stored three times per agent turn (model call `request.messages`, packet `messages`, packet `sections`) | Open (LIMITATIONS.md) |
| D4 | minor | Reload problems lacked file paths and came in two rounds | Paths **fixed**; still two rounds, now with an explicit hint line (h) |
| D5 | minor | `action` event summaries omitted the actor | **Fixed** (k) |

No new defect was found in this pass.

## Notes

* **Event seqs are reissued after a crash.** Seqs the live feed showed but never committed are reused after restart.
  INTERFACES §3 allows this: `feed_epoch` changes (checked in a), and committed history never repeats a seq.
* A kill mid-commit can leave a `.partial_*` dir (a2 cycle 11). Recovery on open removes it. A kill between the
  manifest write and the index append (seen in an earlier batch) is rebuilt on open.
* Disk: `qa/resilience/worlds-final` holds 115 MB and the older `qa/resilience/worlds` 516 MB (pre-fix storage).
  Both are safe to delete once reviewed.
* PIDs: every backend I started is listed in `qa/resilience/pids.txt` (ports 8040/8041 for this pass). Scenario i
  killed the 8041 server and the last 8040 server was stopped at the end. The shared servers were not touched:
  backend PID 270011 on :8000 and Vite PID 130830.
