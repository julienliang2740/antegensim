# Manual lab: timestamped records

This folder holds documents that belong to a moment in time:
* the operator's original source requirements;
* experiments the operator specified (scenario sweeps, baselines, model or setting comparisons);
* their reports.

**These are not running docs.** The running documentation lives in `docs/` and `README.md`. It is
kept true to the code by the docs rule in `CLAUDE.md` and checked by `scripts/check_docs.py`. The files
here are **not** updated when behaviour changes, and the docs checker does not read them. Anything in
an older file may be out of date: defaults, prices, run names, even whole features. Check the date
first, and use `docs/` for how things work today.

## Conventions

* **File name:** `YYYY-MM-DD_topic.md`, dated the day the work was specified or done. For example,
  `2026-09-29_senses_experiment.md`.
* **Header:** under the title, a banner stating the date, what the record is, and that it is a
  timestamped record, not a running doc.
* **Frozen once written.** Finish a report while its experiment is running, then leave it. If
  something in it turns out to be wrong, add a dated note at the end
  (`Note added YYYY-MM-DD: ...`) instead of rewriting.
* **New experiments get a new file.** Never overwrite an older record, even for a re-run.
* **Referring to these files:** the running docs and code comments cite them by file name and date.
  They never depend on them for current behaviour.

## Contents

| Date | File | What it is |
| --- | --- | --- |
| 2026-09-25 | `2026-09-25_llm_world_technical_spec.md` | Source requirements: technical specification v0.5 (cited as **S** in `docs/ASSUMPTIONS.md`) |
| 2026-09-25 | `2026-09-25_llm_world_running_design.md` | Source requirements: world design v0.7 (cited as **D**) |
| 2026-09-27 | `2026-09-27_scenario_sweep_report.md` | First scenario sweep: 37 runs across skills, attacks, movement, cooperation and balanced categories |
| 2026-09-27 | `2026-09-27_showcase_scenario_proposals.md` | Showcase scenario proposals (identical agents, one instruction) |
| 2026-09-28 | `2026-09-28_showcase_scenarios.md` | Showcase results: flagship runs, the persona tip switch, cleanup |
| 2026-09-28 | `2026-09-28_baseline_experiments.md` | Five Groves and Two to a Tree baselines: 26 runs, metrics, timing, forks |
| 2026-09-29 | `2026-09-29_senses_experiment.md` | Cheaper and wider talking and looking: 19 runs; led to the new default prices (A-ECON-3) |
