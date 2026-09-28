# Scenario sweep brief (for every sweep sub-agent)

The operator wants many live simulations run in parallel to find settings that produce **high
interaction, skill use, attacks, and resource scarcity that matters without everyone simply
starving**. Each sub-agent owns one category (A skills, B attacks, C movement, D cooperation,
E balanced stories) and 4-5 proposals in it.

## Hard rules (non-negotiable)

1. **Never change source code, the engine, tests, docs, configs or the model registry.** You only
   write scenario JSON files in `/home/ubuntu/antegensim/sweep/scenarios/` and notes in
   `/home/ubuntu/antegensim/sweep/notes/`. Do not edit anything else in the repository. Do not
   restart or stop the backend (port 8000), the Vite server, the tunnel or the watchdog.
2. Only launch runs through the sweep tool (below). Never run `scripts/run_sim.py` yourself and never
   set `EMPYREAN_ALLOW_LIVE` / `EMPYREAN_LIVE_TESTS`. The tool's `dryrun` forces every agent onto the
   free `fake-heuristic` model.
3. **Budget rule (operator, 2026-09-27 after the async-round rework; raised to 100 on 2026-09-28):** `max_rounds` is at most **100**
   for every run (the tool refuses more). Things should start happening within rounds 30-40; a run
   still quiet at round 30-40 is cut, anything running past 40 needs a clear reason. Rounds now take
   about one model-call latency (all agents decide at once, A-SCHED-5), so an 80-round run takes
   roughly 15-40 minutes.
3b. **Persona tip (2026-09-28):** the engine now appends the persona tip itself when `context.persona_tip` is on,
   which `GET /api/defaults` does by default (A-KNOW-9). New scenarios keep the plain persona and leave the
   setting on; never paste the tip into personas. Every scenario written before the setting existed pins
   `"context": {"persona_tip": false}` so it reproduces what actually ran.
4. Agent models: `claude-cli-haiku` for everyone, `claude-cli-sonnet` only where the proposal says so
   (about 5-10% of agents at most). Every run: `max_rounds` <= 100.
5. **Three strikes:** each proposal gets at most 3 versions (v1, v2, v3). Only touch your own tags.
6. Keep your context lean: never print whole event files or run folders; use `metrics`.

## Tool

`T=sweep/tools/sweep.py`
and run it with `/home/ubuntu/antegensim/.venv/bin/python $T <command>` from `/home/ubuntu/antegensim`.

* `dryrun sweep/scenarios/A1v1.json [--rounds 3]`: free check with fake models (catches every
  validation error: bad fields, skills that do not compile, bad positions). Must exit 0 before launch.
* `launch sweep/scenarios/A1v1.json`: create the live run on the shared backend, open it and play.
  A background watchdog keeps it playing to `max_rounds` (resumes pauses, reopens closed runs).
* `status [A1 ...]`, `metrics A1v1 [--samples N]`: progress and interest metrics (living curve, deaths
  by cause, actions by kind, attacks, via-skill share, skills saved/run, messages, transfers,
  upgrades, model calls, cost, sample messages/attacks/decisions).
* `wait A1v1 A2v1 ... --round R --max-min 9`: blocks until the listed runs have completed round R
  (or finished/were cut), at most 9.5 minutes; call Bash with `timeout: 600000`. Loop it to wait longer.
* `cut A1v1 <reason>`: pause + close the run, mark it cut. `note A1v1 <text>`: add a registry note.

## Scenario file format

`sweep/scenarios/<TAG>.json`, TAG = category letter + proposal number + version, e.g. `A1v1`, `A1v2`.
The file is a run_sim-style overlay on `GET http://127.0.0.1:8000/api/defaults?agent_count=N`:
`world`, `rules` and `context` are deep-merged onto the defaults; any other top-level key replaces
the default; `agents` is the full list of agent cards. Keys starting with `_` (e.g. `"_design"`) are
kept in the file only (use `_design` for a short design note). Required:

* `"name": "SWEEP-<TAG> <Title>"` (e.g. `"SWEEP-A1v1 Orchard rows"`). This is how the operator finds
  runs in the UI, so the prefix must be exact.
* `"seed"`, `"max_rounds"` (<= 100), `"default_model_key": "claude-cli-haiku"`,
  `"real_budget_usd"` (a runaway guard, e.g. 60), and `"agents"` (6-64 cards: `id` a01.., `name`,
  `model_key`, `position` {x,y}, optional `stats` (partial, merged with defaults), `persona` (one line;
  newlines are flattened, so never put skill code in a persona), `notebook`, `initial_skills`
  (list of {name, params, source}, compiled at creation)).

Look at `curl -s 'http://127.0.0.1:8000/api/defaults?agent_count=6'` for every field and default.
Rules reference: `docs/SYSTEM.md` (actions, costs, skills language, round order), `docs/ASSUMPTIONS.md`
(every default with its config key), `docs/GLOSSARY.md`. Earlier scenario examples:
`scripts/scenarios/*.json` and
`sweep/reference/blood_arena_request.json`
(a no-food arena with verified `hunt`/`loot` skills in `initial_skills`).

## What earlier live runs taught us (Haiku)

* Haiku over-observes: in a 6-agent scarce run 283 of 451 actions were `observe`. Default
  `vision_range` is 0 (an agent only sees its own point), so giving some vision or making `query`
  useful changes behaviour a lot.
* Agents rarely write and run skills on their own; seeding a working skill in `initial_skills` plus a
  persona that says when to use it, and making thinking expensive relative to scripted actions
  (`rules.cognition.input_rate` / `generation_rate`, `rules.skills.action_discount`), pushes skill use.
  Running skills make no model calls (cheap in money and time).
* The old Blood arena ended in one-hit kills (attack x full budget). The engine now has
  `stats.attack_cap` (shipped default 50 damage per attack, upgradeable +25 at 100x4^n compute +
  10x4^n essence), so a fresh 100-health agent needs two hits. Tune it per agent or per scenario.
* `rules.skills.interrupt_on: ["damage"]` also triggers on starvation damage.
* With `rules.ranges.query_uses_vision_range: false`, `query(id)` finds an entity anywhere by id;
  with `attack_requires_same_point: false` an attack reaches targets within vision.
* Real speed: agents act one at a time, about 4-8 s per Haiku decision, about 4 s for Sonnet; a run
  with N living agents takes about N x 6 s per round (skill turns are near instant). A 30-agent run can
  need ~5 h for 100 rounds. Cost is roughly $0.007-0.01 per Haiku decision, $0.01-0.02 per Sonnet.
* **Always set `"context": {"input_token_cap": 10000}`.** Long personas plus the Haiku CLI overhead
  (~2700 tokens) push the mandatory packet over the default cap 6000, and the agent is locked out
  (a `resource_skip` every turn, "mandatory packet part ... exceeds the input cap"), even with plenty of compute.
  Crowded cells hit it first. A relaunch done only to fix this lockout does not count as a strike.
* Previous runs were dominated by starvation (quiet death) or first-strike kills; the operator
  finds both boring.

## What counts as interesting

High interaction (messages between agents, transfers/trades, attacks with several hits and
responses), skills being saved **and run** (via-skill action share), movement across the map,
deaths spread over the run rather than an early wipe, some agents surviving through scarcity, and
visible stories (alliances, betrayals, hunts, migrations). Boring: everyone idles/observes, everyone
starves in a quiet line, one early massacre then nothing, or nothing changes for many rounds.

## Process for each sub-agent

1. Draft all your scenario files, `dryrun` each (fix until exit 0), then `launch` them all right away
   so they run in parallel. Write `sweep/notes/<category letter>.md` with the design intent per tag.
2. Monitor with `wait` + `metrics` at checkpoints (about rounds 8, 20, 40, 70). Judge each run.
   Cut a run early when it is clearly failing or boring and the trend will not change (e.g. everyone
   idling, most agents starving with no interaction). When a change could fix it, write the next
   version (new file `A1v2.json`, same proposal number) and launch it; at most v3 per proposal.
   A run that is going well stays running to its `max_rounds`.
3. Record every judgement with `note` and in your notes file (what you saw, why you cut or kept,
   what you changed in the next version).
4. Stay active until every run of yours is finished or cut, then return the final report below.

## Final report (your return value)

For each proposal: the versions tried (tag, run_id, rounds reached, cut/finished), the best version,
a verdict (**success**, **fail**, or **middling**), the key numbers (living curve, deaths by cause,
attacks/kills, via-skill share and skills run, messages, transfers, upgrades, cost) and 2-3
sentences on what happened and why. Then: what made your successful settings interesting and what
made the failures fail (concrete settings, not generalities).
