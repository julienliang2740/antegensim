# Live simulations with claude-cli-haiku (evidence)

Date: 2026-09-25. Model key `claude-cli-haiku` (provider `claude_cli`, Claude Code CLI 2.1.282, logged-in
account, served model `claude-haiku-4-5-20251001` recorded in every call as `response_model`). All headless runs
used `scripts/run_sim.py` in-process against the real backend with `EMPYREAN_ALLOW_LIVE=1` (the review2 session used
the UI), run data under `/home/ubuntu/antegensim/worlds`. Nothing in any run folder or console log matches a secret pattern
(scanned for `sk-ant-…`, `sk-…`, `AKIA…`, `Bearer …`, and the credential env names); `.env` holds no keys.

**Total live spend: USD 0.782** over 102 calls (budget cap USD 3):

| Source | Calls | Tokens in / out | USD |
| --- | --- | --- | --- |
| Runs 1–4 below (manifests' `real_usage`, plus the one failed call the run-2 manifest omits) | 70 | 430,801 / 32,029 | 0.541 |
| UI review session `review2 live haiku 183035` (`run_20260925_183039_9341`, reviewer 2, older backend) | 10 | 75,191 / 6,565 | 0.073 |
| Final source: run `live-final-6x1` (section at the end) | 6 | 35,036 / 1,636 | 0.078 |
| Final source: the 3 `@pytest.mark.live` tests, two invocations plus one re-run (section at the end) | 7 | 27,737 / 1,464 | 0.044 |
| Diagnostic single CLI calls outside runs (replays of stored requests with `--output-format stream-json`; listed near the end) | 9 | | 0.046 |

## What is proven live vs. by fakes

Proven live before the final fix pass (three complete or partial simulations, 70 decisions billed; the final
source was re-checked live at the end of this file):
- The whole decision loop through `model.py`: packet → hardened CLI subprocess with `--json-schema` → envelope
  parsing (structured_output, usage incl. cache tokens, `total_cost_usd`, served model, stop reason) → format gate
  → world action → knowledge record → next packet. Billed input stayed at 1.13–1.17× the packet estimate
  (contract limit 1.5).
- `observe` at the own point, `query(self)`, `upgrade(vision_range)`, `move`, and the design's basic loop
  observe → absorb fruit (8 of 8 absorbs ok, 60 compute processed → 12 gained at 0.2 absorption, 3 fee).
- The agent-output failure path: a `malformed` structured reply is charged, the turn is lost, and the agent is
  told next turn (`your last reply was not a valid decision (status=malformed: …); the turn was lost`).
- The infrastructure path: an unexpected adapter `error` puts the run in state `error` with the pending call
  record kept under `working/pending_model_calls/` (v1, round 2).
- Cognition metering with provider usage: 1.4–2.0 compute per decision.

Verified only with fakes/mocks (unit tests, 454 passing): retries/backoff, timeouts and process-group kill,
`error_max_turns`/`is_error` classification goldens, the new re-prompt acceptance limit (num_turns 3 accepted,
4 rejected), the thinking env variable plumbing, and every other provider adapter (anthropic/openai/fireworks/
bedrock/foundry have no credentials on this machine). Skills (`save_skills`/`run_skill`), `send`/`broadcast`,
`recover`, `attack`, `transfer`, `wait` and deaths were NOT exercised by Haiku in these short runs (no agent chose
them within 3 rounds); their engine behaviour is covered by the fake-model tests only.

## Run 1 — smoke, 6 agents × 1 round (defaults as found)

- Command: `EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/run_sim.py --model claude-cli-haiku --agents 6 --rounds 1 --seed 3 --worlds-dir /home/ubuntu/antegensim/worlds --name live-smoke-6x1`
- Folder: `worlds/world_20260925_175931_7649/runs/run_20260925_175931_40bf`
- Calls 6, all `completed/ok`, 1 attempt each. Tokens billed in 36,107 (6,017/call: ~10 uncached + ~6,008 cache
  creation), out 3,082 (513/call, of which 1,708 total = 55% extended-thinking tokens). Cost USD 0.0876
  (0.0146/call). Latency mean 5.9 s, max 7.3 s. Billed/estimate 1.17.
- Actions: observe 6 (all ok). Cognition charged 10.30 compute (1.72/decision), actions 6, upkeep 6.
- Inspection: the rules text the model saw (system message, 7,641 chars ≈ 1,911 tokens) is complete: world,
  costs, skill language, output format; the user message (2,081 chars) holds skills, notebook, situation and the
  decision request. Every reply parsed. Knowledge files hold only the agent's own records (run-start system
  record, own observation, own cognition charge); `self_state.source == "derived"`.
- Economy: no fruit anywhere (`fruit 0`), because initial mature plants start with `energy = 0` and need 60
  energy at 12/round with a 5-round interval, and the nearest plant was 5 Manhattan steps from the start cluster
  with `vision_range 0`. Packet overhead 2,713 tokens (schema 1,563 + CLI harness 1,150) out of a 5,145 estimate.

## Run 2 — 8 agents × 3 rounds, seed 1 (defaults as found): halted by an adapter error in round 2

- Command: `… --agents 8 --rounds 3 --seed 1 … --name live-8x3`
- Folder: `worlds/world_20260925_180307_9a81/runs/run_20260925_180307_779a`
- Rounds completed: 1 (and 7 of 8 turns of round 2). Calls 16: 15 `completed/ok`, 1 `failed/error`
  (uncommitted, `working/pending_model_calls/mc_r00002_t08_a07_01.json`). Tokens billed in 105,196, out 11,207
  (6,789 thinking). Cost USD 0.1334 (manifest ledger shows 0.1215 for the 15 committed calls). Latency mean
  8.3 s, max 14.9 s (the failed call). Billed/estimate 1.17.
- Actions: observe 8, query self 3, upgrade vision_range 3 (25 compute + 2 essence each), move 1; all ok.
  Cognition 28.40 compute (1.89/decision), actions 91, upkeep 8.
- Problem 1 (fixed): the failing call's envelope had `num_turns == 3` (two model requests) with a valid decision
  and summed usage (13,189 billed input, 1,205 output). The adapter treated "more than one model request" as an
  infrastructure error and the run entered `error`. Replaying the stored request twice showed what the CLI does:
  the model writes a text block and then calls `StructuredOutput` in one response; when a response ends as text
  only, the CLI re-prompts once (the CLI cannot force tool choice). Fix: `config.CLI_MAX_MODEL_REQUESTS = 2`
  (A-COG-9, per-entry `options.max_model_requests`); such replies are accepted, charged in full from the summed
  usage, and noted in `attempt_errors` ("attempt 1: note: claude CLI re-prompted the model: 2 model requests
  billed …"); more requests remain an error.
- Problem 2 (fixed): extended thinking (CLI default) used 40–70% of the output tokens; one reply reached 968 of
  the 1,000-token generation allowance with 668 thinking tokens, leaving no room for a notebook or skill source.
  A probe showed `MAX_THINKING_TOKENS=0` turns thinking off (thinking_tokens 0, 178 fewer harness input
  tokens, ~40% lower latency). Fix: `config.CLI_MAX_THINKING_TOKENS = 0` (A-COG-10, per-entry
  `options.max_thinking_tokens`, `null` keeps the CLI default) passed as env `MAX_THINKING_TOKENS`.
- Problem 3 (fixed): fruit unfindable (see run 1). Fix: `WorldConfig.plants_at_agent_starts` (A-WORLD-7,
  default true: the first plants of each species sit on the agents' start cells) and `WorldConfig.initial_plant_fruit`
  (A-PLANT-13, default 1 ripe fruit per initial plant, source-funded and recorded in `total_fruit_produced` /
  `total_source_energy`). Mirrored in `frontend/src/api/types.ts`. `false` / `0` restore the old world exactly.

## Run 3 (v2) — 8 × 3, seed 1, with a WRONG fix: 24 of 24 replies malformed

- Command: `… --name live-8x3-v2`; folder `worlds/world_20260925_181656_ba0a/runs/run_20260925_181656_cf1a`.
- Calls 24, all `failed/malformed` (`error_max_turns`, empty result), cost USD 0.1780, out 6,497 (0 thinking),
  latency mean 4.0 s. Actions 0; every agent was charged its cognition (35.0 compute total) and told the reason.
- Cause (mine): together with the fixes above I had appended a line to the CLI system prompt: "give your reply by
  calling the StructuredOutput tool with the JSON object as its input …". Replays with `stream-json` showed Haiku
  taking "input" literally and wrapping the decision as a string under an `input` key
  (`{"input": "{\n \"thought\": …"}` → CLI: `must NOT have additional properties ('input' is not allowed)`), with
  thinking on or off; the same request without that line succeeded. The line was removed; nothing is appended to the
  system prompt in the schema route (documented in `model.py` next to `CLI_MAX_MODEL_REQUESTS` and in A-COG-9).
  This run is evidence that the malformed path (charge, lost turn, reason in the next packet) works end to end.

## Run 4 (v3) — 8 × 3, seed 1, with the final code: the loop closes

- Command: `EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/run_sim.py --model claude-cli-haiku --agents 8 --rounds 3 --seed 1 --worlds-dir /home/ubuntu/antegensim/worlds --name live-8x3-v3`
- Folder: `worlds/world_20260925_182033_fcab/runs/run_20260925_182033_8888`
- Rounds 3 (28 turn dirs). Calls 24: 22 `completed/ok`, 2 `failed/malformed`; 1 attempt each; no re-prompts.
  Tokens billed in 146,959 (6,123/call; 4,551 of each are cache reads of the shared rules prefix), out 11,243
  (468/call, max 741, 0 thinking). Cost USD 0.1425 (0.0059/call). Latency mean 5.8 s, min 3.6 s, max 8.1 s.
  Billed/estimate 1.13–1.15.
- Actions 22, all ok: observe 8 (round 1), absorb 8 (round 2: every agent absorbed the fruit on its start cell,
  +12 compute each, 48 lost to the 0.2 absorption rate, fee 3), query self 5, upgrade vision_range 1 (a06).
  No skills, messages, waits, moves, attacks or deaths. Fruit left 4 of 12.
- Costs: cognition 40.64 compute (1.69/decision, range 1.4–2.0), actions 62, upkeep 24. Per agent over 3 rounds:
  ~5.1 cognition + 3 upkeep + 5 actions vs. +12 from one fruit, so balances ended at 198.6–200.1 (a06 174.9 after
  the 25-compute upgrade). Calibration reading (design "Open decisions" priority 1): one decision costs about one
  cheap action (observe 1, absorb 3, move 5), so cognition and action prices are comparable; but a stationary agent
  on its own plant burns ~2.7 compute/round (cognition + upkeep) plus fees while a mature plant yields one 60-compute
  fruit per 5 rounds = 9 net per 5 rounds at 0.2 absorption, i.e. the default economy is slightly negative even
  without exploration. That is the design's open question "Do low absorption yields support survival?"; not tuned.
- The two malformed replies (a01 and a05 in round 3) replayed successfully both times; they are stochastic Haiku
  slips (one replay ended a `thought` with a stray `\"`). Rate so far: 2 of 24 with thinking off vs 0 of 21 with
  thinking on (plus 1 re-prompt) — too few samples to separate; `options.max_thinking_tokens: null` re-enables the
  CLI default if the lead prefers.

### Excerpt 1 — a04, round 2 (v3): packet situation section, reply, and result

Packet `turns/r00002_t01_a04/decision_packets/pk_r00002_t01_a04.json` (estimate 5,381 tokens, overhead 2,713,
reservation 2.076 compute, selected records a04-k000003/1/2, nothing omitted):

```
## SITUATION NOW
Round 2; this is your turn r00002_t01_a04.
Position: (-1,0). Terrain here: land (observed in round 1).
Your state as of round 1 (derived, may be stale): compute 197.6038, essence 20 of capacity 100, health 100 of 100, attack 1, speed 1, vision_range 0, communication_range 0, compute_absorption 0.2, essence_absorption 0.1, skill limits 5 skills x 100 blocks. Upkeep and skill interpretation are not included; query("self") gives exact values.
Your latest observation of this point (round 1, may be stale): p0004 plant, f0004 fruit.
Your last action (round 1): observe (-1,0) -> ok; terrain land; entities: a04 agent, p0004 plant, f0004 fruit; observed round 1; cost 1 compute.
Unread since your last decision (1 system), most urgent first:
[a04-k000002 r1 system world] your last decision cost 1.396 compute
```

Reply (`model_calls/mc_r00002_t01_a04_01.json`, usage: input 3, cache read 4,551, cache creation 1,579, output 468;
cost USD 0.00596; latency 5.7 s; charged 1.695 compute):

```json
{"action":{"name":"absorb","args":{"source":"f0004","resource":"compute"}},
 "thought":"Absorbing fruit f0004 at my location to gather compute resources. With limited vision range, gathering what's immediately available is more efficient than exploring.",
 "notebook_update":"## Damaris (a04) - Round 2\n**Status**: compute ~197.6, essence 20/100, health 100/100\n..."}
```

Action event: `{"ok": true, "cost_compute": 3.0, "effects": {"processed": 60.0, "gained": 12.0, "lost": 48.0, "source": "f0004", "resource": "compute"}}`.
Knowledge afterwards (`r00003_end/entities/knowledge/a04.json`): `a04-k000005 action_result own_action | You absorb
compute from f0004 -> ok; processed 60 compute from f0004, gained 12, lost 48; cost 3 compute.` and, after
`query(self)` in round 3, `compute 200.08` (exact) versus the derived 197.60 shown before it.

### Excerpt 2 — a02, round 2 (run 2, thinking on): upgrade

Reply: `{"action":{"name":"upgrade","args":{"attribute":"vision_range"}},"thought":"With vision_range 0, I can only see my current location. Upgrading vision_range to 1 (costs 25 compute + 2 essence) will let me observe nearby cells…"}`
→ event `upgrade vision_range -> ok: vision_range -> 1 (cost 25 + 2 essence)`; knowledge record
`a02-k000005 action_result | You upgrade vision_range -> ok; attribute=vision_range, new_value=1, purchase_count=1; …`.

### Excerpt 3 — the stable rules the model sees (system message, unchanged by this work)

```
## COSTS (compute; an action executed inside a saved skill is charged x0.8)
move 5 (skill 4); observe 1 (skill 0.8); query 1 (skill 0.8); send 3 (skill 2.4); broadcast 7 (skill 5.6); absorb 3 (skill 2.4); transfer fee 1 (skill 0.8) plus the amount sent; wait 0 (skill 0).
...
Thinking: each decision costs 1 x (0.0002 x input tokens + 0.001 x output tokens) compute (your mind multiplier is 1), charged after the reply; everything in this request is input.
```

## Changes made (all covered by unit tests; full suite 454 passed, 3 live tests skipped)

- `backend/empyrean/model.py`: `CLI_MAX_MODEL_REQUESTS` (accept the CLI's one re-prompt, note in
  `attempt_errors`, error beyond the limit; `Attempt.notes`); `CLI_MAX_THINKING_TOKENS` → env `MAX_THINKING_TOKENS`
  via `cli_environment(max_output_tokens, max_thinking_tokens)`; `parse_decision` now includes the adapter's error
  detail in the reason (`status=malformed: structured output did not match the decision schema`) so the agent is
  told why; comment recording the harmful "delivery hint" experiment.
- `backend/empyrean/config.py`: the two CLI constants, `DEFAULT_WORLD` fields, assumptions A-COG-9, A-COG-10,
  A-PLANT-13, A-WORLD-7. `docs/ASSUMPTIONS.md`: matching rows.
- `backend/empyrean/schemas.py`: `WorldConfig.plants_at_agent_starts`, `WorldConfig.initial_plant_fruit`.
  `backend/empyrean/world.py`: `generate_world` places the first plants on the agents' final start cells and
  spawns the initial fruit; draw order for the switched-off configuration is unchanged.
- `frontend/src/api/types.ts`: the two `WorldConfig` fields (type-check passes).
- Tests: `tests/test_model.py` (overhead, argv/env, classification cases, re-prompt acceptance, thinking env),
  `tests/test_world.py` (placement + initial fruit + switched-off equivalence), `tests/test_integration_rev3.py`
  (one assertion made independent of the round-1 initiative order, which changed with fewer rng draws).

## Diagnostic CLI calls outside runs (USD 0.046)

2 tiny schema probes (thinking on/off: 0.0017 + 0.0013); 2 replays of the v1 failing request (0.0078 + 0.0070);
3 replays isolating the v2 failure (0.0043 + 0.0046 + 0.0061); 2 replays of the v3 malformed requests
(0.0059 + 0.0069). Replays use the stored request from the call record with `--output-format stream-json
--verbose` and the same hardened argv/env; script kept in the session scratchpad only.

## Final source (after the final fix pass), 2026-09-25 20:38–20:42 UTC

Code: `code_revision` `a11e51b+dirty.67f19b11` (sha256 prefix of `backend/empyrean/*.py` `1132bcec6042`, the
same source the resilience suite and `pytest -q` ran on). CLI 2.1.282, served model `claude-haiku-4-5-20251001`.

### Run `live-final-6x1`: 6 agents x 1 round, seed 5

- Command (from the repository root, `CLAUDECODE` unset): `EMPYREAN_ALLOW_LIVE=1 .venv/bin/python scripts/run_sim.py --model claude-cli-haiku --agents 6 --rounds 1 --seed 5 --worlds-dir /home/ubuntu/antegensim/worlds --name live-final-6x1`. Exit 0; round 1 took 25.4 s.
- Folder: `worlds/world_20260925_203815_2ccd/runs/run_20260925_203815_7924` (8 turn dirs, state `paused` at `r00001_end`).
- Calls 6: all `completed/ok`, 1 attempt each, no re-prompt note, `stop_reason` `tool_use`, `usage.source` `provider`.
  Every record carries `model_key` `claude-cli-haiku`, provider `claude_cli`, `model_id` `haiku` and `response_model`.
- Tokens billed in 35,036 (5,838–5,841 per call: 3 uncached + about 5,836 cache-creation, 0 cache reads), out 1,636
  (173–356 per call, 0 reasoning tokens: thinking is off). Billed/estimate **1.135** on every call (estimates 5,144–5,146; limit 1.5).
- Cost **USD 0.0782** (0.0125–0.0135 per call; the manifest ledger `calls 6, interrupted_calls 0, provider_cost_usd 0.078234`
  equals the sum over the 6 records). Latency mean 4.2 s, min 3.2 s, max 5.0 s.
- Actions 6, all ok: observe 5 (each agent its own start cell, seeing its plant and ripe fruit), query self 1 (a05).
  Cognition 8.64 compute (1.34–1.52 per decision), actions 6, upkeep 6. No deaths; fruit 12 of 12 left.
- Validity: 40 committed events, seqs 1–40 with no gap; each turn has turn_started → model_call_pending →
  model_call_completed → decision → action. Every packet (`stable_rules, skills, notebook, situation, decision_request`)
  is within its 6,000-token cap, holds only the agent's own record ids and shows `self_state.source` `derived`. Each
  agent's knowledge holds exactly 3 own records (start, cognition charge, its observation or query), none foreign.
  Storage follows the fix-pass rule: `r00000_init` holds all 6 knowledge files, each agent-turn dir only the actor's,
  `r00001_end` none, and every `world.json` `knowledge_files` map covers all 6 agents. The history API (dev backend,
  read-only GETs) serves `turns/r00001_end/agents/a01/knowledge` with `observed_entities` `[f0001, p0001]` (the new
  agent-view field) and a05's `believed_self.source` `query`.
- Secrets: `grep -rniE 'api[_-]?key|sk-[a-z0-9]{8}|bearer '` over the run folder returns **0 hits** in 197 files (not
  even field names); the console output also has 0 hits.
- Problems: none. Two observations: a04's reply was only `{"action": ...}` without a `thought` (the schema allows it,
  the decision event then shows no quote); and with no prompt-cache reads (each agent's first call writes its own
  prefix, so there is nothing to read in a one-round run) a decision cost about USD 0.013, twice run 4's USD 0.006,
  where later rounds read about 4,550 cached tokens per call.

### The 3 live pytest tests

Command: `cd backend && env -u CLAUDECODE EMPYREAN_LIVE_TESTS=1 ../.venv/bin/pytest -q -m live`. A pass-through QA
plugin (loaded with `PYTEST_PLUGINS`, kept in the session scratchpad, not in the repository) logged each call's
status, usage, cost and latency; it records no message contents.

| Invocation | Result | Per call: test, status, tokens in / out, USD, latency |
| --- | --- | --- |
| 1 | **2 passed, 1 failed** (11.7 s) | e2e decision flow ok 5,840 / 394, 0.0050, 5.3 s; tiny schema ok 971 / 55, 0.0012, 1.7 s; decision-vs-estimate **malformed** 4,706 / 234, 0.0106, 4.0 s (the test asserts `status == "ok"`) |
| re-run of the failed test | 1 passed (3.3 s) | ok 4,705 / 200, 0.0104, 3.3 s |
| 2 | **3 passed** (9.4 s) | e2e decision flow ok 5,840 / 311, 0.0046, 4.3 s; tiny schema ok 970 / 55, 0.0012, 1.7 s; decision-vs-estimate ok 4,705 / 215, 0.0105, 2.9 s |

7 calls, 27,737 in / 1,464 out, **USD 0.0435**. The failure is a stochastic Haiku slip of the kind seen in run 4
(2 of 24); the adapter's error text for it was not kept (only the tail of the pytest output was captured). The
decision-vs-estimate test therefore fails about as often as Haiku returns a malformed reply; see LIMITATIONS.md.

