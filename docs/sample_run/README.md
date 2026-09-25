# Sample run data (committed reference for the on-disk format)

Real run data is written under `worlds/` (gitignored, see `EMPYREAN_WORLDS_DIR`).
This folder is a trimmed copy of one real run so the file format can be read
without running anything: `live-story-8x12`, 8 agents on `claude-cli-haiku`,
12 rounds, seed 7 (run id `run_20260925_225352_5ae2`). Only three turns are
included; a full run has one folder per agent turn plus one per round end.

```
world_sample/runs/run_sample/
  manifest.json              commit point: current turn, counters, real-usage ledger
  run_request.json           the request the run was created from (agent cards, settings)
  assumptions.json           the assumption table in force at creation
  turns/
    index.jsonl              one line per committed turn (trimmed to the three below)
    r00000_init/             the initial checkpoint, before any agent acts
    r00011_t03_a04/          round 11, turn 3, agent a04: it buys communication range
                             and sends the run's first message to a01
    r00011_end/              the round-end step: plant growth, upkeep, deaths
  working/
    README.txt               how literal god mode (edit files, then reload) works
    BASE_TURN                which committed turn the working copy was made from
```

Each turn folder holds:

| File | Content |
| --- | --- |
| `state.json` | turn record: acting agent, decision source, action, result, interventions, event range |
| `events.json` | the turn's events in order: who did what, result, costs, pending flags |
| `world.json` | round, id counters, rng state, initiative order, `knowledge_files` map |
| `map.json`, `rules.json`, `settings.json` | terrain, rules/prices/plant species, model and context settings |
| `entities/agents/<id>.json` | every agent's authoritative state (stats, skills, execution state) |
| `entities/knowledge/<id>.json` | an agent's own knowledge records, written only when they changed |
| `entities/plants.json`, `fruits.json`, `seeds.json`, `residues.json`, `removed.json` | other entities |
| `decision_packets/pk_<turn>.json` | exactly what the model was given, with selected and omitted memory ids |
| `model_calls/mc_<turn>_NN.json` | request, raw output, parsed decision, usage, cost, latency; never credentials |

The full format is specified in `docs/INTERFACES.md` §5. Nothing here contains
secrets: model call records hold prompts and replies only.
