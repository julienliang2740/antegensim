# Model comparison: GPT-6 Luna, DeepSeek V4 Flash and Claude Haiku

> **Manual lab record, dated 2026-09-29.** This is the report of an operator-specified experiment: three
> agent models, all non-thinking, on the Five Groves and Two to a Tree baselines. It is a timestamped
> record, not a running doc: it is not updated when the code or the docs change, so details may be out
> of date. See `manual_lab/README.md`.

**DeepSeek V4 Flash numbers are partly extrapolated.** Its Azure deployment is capped at 125 requests and
125,000 tokens per minute, and the full design needs far more. The operator asked to stop the
rate-limited DeepSeek runs and to play DeepSeek only inside the quota, then extrapolate. DeepSeek
played 23 rounds (745 decisions); everything beyond them is marked **EXTRAPOLATED** in the tables,
and the method is in [section 7](#7-deepseek-extrapolation-method). Haiku and Luna ran the full design and
every number for them is measured.

## 1. Ranking

| Rank | Model | Summary |
| --- | --- | --- |
| 1 | **GPT-6 Luna** (`azure-gpt6-luna`) | Best on all three hard metrics: 1 invalid decision in 4,027 (0.02%), **$0.006 per round** (45× cheaper than Haiku), 1.6 s per call. Behaviour is flat: it never writes its notebook or memory priorities, almost never saves skills or talks, and nobody dies. |
| 2 | **DeepSeek V4 Flash** (`azure-deepseek-v4-flash`) | 0 invalid in 745 (95% upper bound 0.4%), **$0.023 per round** (13× cheaper than Haiku), 2.9 s per call. The richest early behaviour: 30 of 64 agents saved skills by round 15, with notebooks and priorities like Haiku. The deployment quota limits it to about one round a minute. Later-round numbers are extrapolated. |
| 3 | **Claude Haiku** (`claude-cli-haiku`) | 7.7% invalid decisions (almost all one fixable pattern), **$0.28 per round**, 7.5 s per call. The most social and conflictual play: talk, trades and the only kills. |

## 2. Setup

| Item | Value |
| --- | --- |
| Baselines | **Five Groves** (`run_20260927_221309_cc43`, seed 1818) and **Two to a Tree** (`run_20260928_034839_c3c2`, seed 2930); each run clones the baseline setup (`GET /api/runs/{id}/setup`) with the same seed, so every model starts from the identical world |
| Agents | 32 per run, all on the model under test (`default_model_key` and every agent card) |
| Prices | The baselines' own stored prices (observe/query 1.0, the pre-2026-09-29 defaults), the same for every model |
| Design | Per model and baseline: a trunk to round 25, then two forks from `r00025_end` to round 45 (continuations: identical state, only model sampling differs) |
| Thinking | Off for all: Luna `reasoning_effort: "none"` (0 reasoning tokens); DeepSeek on Azure is served non-thinking (no reasoning content, "9" answered in 2 tokens); Haiku CLI with `MAX_THINKING_TOKENS=0` |
| Structured output | Luna and DeepSeek: native `json_schema` (non-strict) through the openai provider on the Azure AI v1 endpoint; Haiku: CLI `--json-schema` |
| Backends | :8001 Haiku (model concurrency 12), :8002 Luna (12, lowered to 5 at round 10 after HTTP 429s: its quota is 1M tokens/min), :8003 DeepSeek (1 after the stop; see section 7) |
| Tools | `sweep/tools/showcase/model_compare.py`, `mc_collect.py`, `launch_variant.py` (new `model` patch key), `fork_exp.py`, `ds_driver.py` |

**Prices used for cost** (USD per million tokens, input / cached input / output):

| Model | Price | Source |
| --- | --- | --- |
| GPT-6 Luna | 0.10 / 0.01 / 0.50 | OpenAI list price (the Azure retail price API had no Luna meter); **check against the Azure invoice** |
| DeepSeek V4 Flash | 0.19 / 0.028 / 0.51 | Azure retail price API, Global meters |
| Haiku | CLI-reported `total_cost_usd` (API-price equivalent) | On the Claude subscription it consumes session limits, not dollars |

## 3. Hard metrics per model

| Metric | Haiku (measured) | GPT-6 Luna (measured) | DeepSeek V4 Flash |
| --- | --- | --- | --- |
| Rounds played | 130 (2×25 + 4×20) | 130 | 23 measured (r1-15 FG, r1-8 TT); **130 EXTRAPOLATED** |
| Decision attempts | 3,686 | 4,027 | 745 |
| **Invalid decisions** | **282 (7.65%)** | **1 (0.02%)** | **0 (0%; 95% upper bound 0.40%)** |
| Reference | 20 Haiku runs of the same setups (18 from the 2026-09-28 baselines plus the MC trunks): 8.9% of about 24,000 decisions (r1-45); 5.9-10.7% per baseline run in r1-25 | – | – |
| World-rejected actions | 4.4-6.9% of actions | 1.7-4.2% | 5.8-7.5% |
| **Cost, full design** | **$36.42** | **$0.82** | **$2.80 EXTRAPOLATED** (range $2.58-2.93); $0.52 measured for 23 rounds |
| Cost per round | $0.24-0.31 | $0.0058-0.0065 | $0.0225 measured (r1-15) |
| Cost per decision | $0.0099 | $0.0002 | $0.0007 |
| Tokens per call, in / out | 7,800-8,300 / 580-655 | 4,700-4,900 / 49-54 | 3,200-3,800 / 150-167 |
| **Latency per call**, p50 / p90 (first attempts) | **7.3-8.8 / 10.3-11.7 s** | **1.6-1.7 / 1.9-2.0 s** | **2.8-2.9 / 5.3-6.0 s** |
| Model-seconds per round (calls × mean latency) | 188-259 | 49-55 | 118-157 |
| Wall time, full design | 45 min (6 runs, 2-4 at a time) | 34 min | **~3.9 h inside the quota, EXTRAPOLATED** (runs one at a time, ~115 s per round) |
| Provider quota | Claude session limits | 1M tokens/min, 1,000 requests/min | **125K tokens/min, 125 requests/min**; one round is ~124K tokens, so the quota allows ~1 round/min in total |

Round time follows model-seconds per round ÷ effective concurrency. This predicted all three measured
round times: Haiku 244/6 ≈ 41 s (measured 40-42), Luna 52/2.5 ≈ 21 s (21), DeepSeek 118/1 ≈ 118 s (115).
At an equal 6 concurrent calls per run, the projection is Haiku ~41 s, Luna ~9 s and DeepSeek ~20 s per
round (**EXTRAPOLATED for DeepSeek**; one run at that pace needs about 3× its current token quota).

## 4. Per run

Times are launch to finish; "active min" in the tool output excludes gaps over 10 minutes (there were none).

| Run | Tag | Rounds | Decisions | Invalid | Cost $ | Wall time | Latency p50 s | Round s (median) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MC Five Groves · Haiku (`run_20260929_035629_a8e4`) | MC-FG-HAIKU | 1-25 | 790 | 57 (7.2%) | 7.56 | 17.1 min | 7.3 | 42 |
| … fork A (`run_20260929_041339_bea1`) | MC-FG-HAIKU-A | 26-45 | 503 | 42 (8.3%) | 4.93 | 26.6 min | 7.3 | 77 |
| … fork B (`run_20260929_041339_3141`) | MC-FG-HAIKU-B | 26-45 | 485 | 41 (8.5%) | 4.70 | 26.9 min | 7.3 | 80 |
| MC Two to a Tree · Haiku (`run_20260929_035630_2109`) | MC-TT-HAIKU | 1-25 | 792 | 52 (6.6%) | 7.72 | 17.5 min | 7.9 | 40 |
| … fork A (`run_20260929_041400_67ac`) | MC-TT-HAIKU-A | 26-45 | 553 | 41 (7.4%) | 5.73 | 26.9 min | 8.8 | 82 |
| … fork B (`run_20260929_041401_b95a`) | MC-TT-HAIKU-B | 26-45 | 563 | 49 (8.7%) | 5.77 | 27.2 min | 8.6 | 83 |
| MC Five Groves · GPT-6 Luna (`run_20260929_035630_6c96`) | MC-FG-LUNA | 1-25 | 800 | 0 | 0.161 | 8.8 min | 1.6 | 21 |
| … fork A (`run_20260929_040531_ccdd`) | MC-FG-LUNA-A | 26-45 | 579 | 0 | 0.120 | 23.9 min | 1.7 | 73 |
| … fork B (`run_20260929_040532_c153`) | MC-FG-LUNA-B | 26-45 | 583 | 1 (0.2%) | 0.117 | 24.6 min | 1.7 | 73 |
| MC Two to a Tree · GPT-6 Luna (`run_20260929_035631_20f6`) | MC-TT-LUNA | 1-25 | 800 | 0 | 0.162 | 9.2 min | 1.6 | 21 |
| … fork A (`run_20260929_040553_7eab`) | MC-TT-LUNA-A | 26-45 | 635 | 0 | 0.131 | 24.6 min | 1.7 | 71 |
| … fork B (`run_20260929_040556_5943`) | MC-TT-LUNA-B | 26-45 | 630 | 0 | 0.125 | 24.8 min | 1.7 | 73 |
| MC Five Groves · DeepSeek V4 Flash (`run_20260929_035632_4e7b`) | MC-FG-DSV4 | 1-15 | 471 | 0 | 0.339 | 21 min for r6-15 inside the quota | 2.9 | 115 (r6-15) |
| MC Two to a Tree · DeepSeek V4 Flash (`run_20260929_035632_0a89`) | MC-TT-DSV4 | 1-8 | 274 | 0 | 0.180 | stopped at round 8 when Haiku finished | 2.8 | 160 |
| DeepSeek trunk r1-25, per baseline | – | **EXTRAPOLATED** | ~790 | ~0 | **~0.57** | **~48 min** | – | ~115 |
| DeepSeek fork r26-45, each | – | **EXTRAPOLATED** | ~560 | ~0 | **~0.41** | **~34 min** | – | ~102 |

Fork round times are longer than trunk round times because four forks shared one backend's call
slots, against two trunks. Luna's forks shared 5 slots and Haiku's 12. Latency per call is the
comparable speed number.

## 5. Invalid calls: which, why, and fixes

"Invalid" means a `decision_invalid` event: the model's reply could not be used, and the agent lost the
turn. The call is still paid. Rate-limit and session-limit failures are not counted: they fail the turn,
and the turn is replayed. Luna hit 63 HTTP 429s in rounds 1-10 at concurrency 12; DeepSeek hit 238 in
rounds 1-5 before the stop. There were none after each fix.

### Haiku: 282 of 3,686 (7.65%)

Causes, over the 20 Haiku runs of these setups (the 2 MC trunks and 18 earlier baseline runs,
r1-45, 2,152 invalid decisions in 24,070):

| Cause | Share | Example (raw reply) |
| --- | --- | --- |
| Whole decision nested inside `action` | 62.8% | `{"action": {"thought": "…", "action": {"name": "absorb", "args": {…}}, "notebook_update": "…"}}` |
| Decision serialized as a string under an invented key (`output`, `value`, `input`, `properties`), or no `action` at all | 33.9% | `{"output": "{\n  \"thought\": \"…\", \"action\": {…}}"}` |
| `think` instead of `thought`, CLI "could not parse" tool input | 2.6% | `{"think": "…", "action": {…}}` |
| Wrong enum (`"direction": "west"`) or truncated at the output cap | 0.8% | – |

**Why:**
- The CLI's `--json-schema` is enforced by a StructuredOutput tool that validates the reply after
  generation. Nothing constrains the decoding.
- Haiku sometimes fills the tool's first property with the whole decision, or pastes the JSON as a
  string into one field.
- The CLI then rejects the reply and the engine records it as malformed.
- This is the same failure as the INTERFACES rev 3 note (Haiku nesting the decision inside `action`).

**Fixes, best first:**
1. **Deterministic salvage in `model.parse_decision`** for agent decisions:
   - unwrap `{"action": <whole decision>}`;
   - JSON-decode a single-key wrapper whose value is a decision string;
   - accept `think` as `thought`.

   This would have recovered about 97% of Haiku's invalid decisions (7.7% down to about 0.3%). It
   would also have saved about $2.70 of the $36.42 and about 270 of the 282 lost agent turns. The assistant already
   does exactly this salvage for its own outputs (A-AST-4). It is a rule change, so it needs its
   assumption row and docs.
2. One repair re-prompt on a malformed reply, with the validator's message. This costs one more
   Haiku call, about $0.01, per failure.
3. Try the API routes (`anthropic-haiku` forced tool use, or `bedrock-haiku`). They are untested in
   this experiment.

### GPT-6 Luna: 1 of 4,027 (0.02%)

The only failure was a garbled coordinate in MC-FG-LUNA-B, turn `r00035_t08_a18`:
`"action":{"name":"observe","args":{"point":{"x":":-3,"},"page":0}}}`.

**Why:** the schema is sent with `strict: false`, so it guides the output but does not constrain it.

**Fix:** not worth one.
- Strict mode is not a drop-in fix. A live check with `strict_schema: true` returned HTTP 400
  "Invalid schema for response_format 'decision'", so Luna's strict validator does not accept
  `openai_strict_schema`'s output.
- If it ever matters, a one-shot retry of a malformed reply costs $0.0002.

### DeepSeek V4 Flash: 0 of 745

Nothing to fix. If wanted, strict mode works: one live decision with `strict_schema: true` returned
200 and was valid. Its world-rejected actions include `observe:out_of_range` (7). These are requests
to look beyond vision range, a spatial slip rather than a format error.

**World-rejected actions** (all models) are mostly races rather than adherence failures:
- `absorb:target_gone` and `absorb:empty_source`: another agent took the fruit first.
- Luna's Two to a Tree forks add `move:blocked`, 14-17 per fork: Luna agents walk into blocked
  tiles again and again.

## 6. Behaviour differences

Trunks r1-25 (two runs per model; DeepSeek: r1-15 and r1-8):

| Behaviour | Haiku | GPT-6 Luna | DeepSeek V4 Flash (r1-15 / r1-8) |
| --- | --- | --- | --- |
| Thought length (chars) / output tokens | 190 / 585 | 117 / 50 | 145 / 155 |
| Decisions that update the notebook | 82-83% | **0%** | 78-83% |
| Decisions that set memory priorities | 36-46% | **0%** | 52-56% |
| Agents that saved a skill (skills saved) | 3 (3) | **0 (0)** | **30 (35)**; 23 of 32 in Five Groves by round 15 |
| Messages (senders) | 9 (5), all in Two to a Tree | 0 | 4 (3) |
| Action mix, Five Groves | observe 51%, absorb 21%, query 15%, move 12% | observe 63%, absorb 18%, move 15%, query 2% | observe 59%, absorb 19%, move 15%, query 5% |
| Action mix, Two to a Tree | observe 50%, move 18%, query 17%, absorb 11% | observe 61%, **move 27%**, absorb 8%, query 3% | observe 61%, move 18%, absorb 13%, query 5% |
| Share of compute spent on thinking (FG / TT) | 69% / 52% | 51% / 31% | 44% / 27% |
| Deaths by r25 | 0 | 0 | 0 (r15 / r8) |

Forks r26-45 (four runs per model; DeepSeek not played):

| Behaviour | Haiku | GPT-6 Luna |
| --- | --- | --- |
| Deaths | **7**: 4 starved (Five Groves), 3 killed (Two to a Tree) | **0** |
| Attack hits / kills | 6 / 3 (Two to a Tree forks) | 0 / 0 |
| Messages (senders) | 20 (15) | 8 (6) |
| Transfers | 3 (fork TT-B) | 0 |
| Agents that saved a skill | 7 | 1 |
| Agents that went broke (compute 0) | 39 | 29 |
| Waits | 0-6% of actions | 2-8% |

Findings:

- **Luna plays a lean, silent survival game.**
  - Short thoughts, no notebook, no memory priorities, almost no skills or talk, and more walking.
  - It spends 31-51% of its compute on thinking, against Haiku's 52-69%.
  - Nobody dies, but nothing much happens. That is the "boring" failure mode the showcase work fought against.
  - A persona that asks for notebook use or cooperation would be the next thing to test.
- **DeepSeek is the most tool-using model.**
  - It saves skills from round 1, often (35 skills by round 15/8, against Haiku's 3 in 25 rounds).
  - It writes notebooks and priorities at Haiku's rate, and spends a smaller share of compute on
    thinking than either.
  - Whether this leads to more interesting mid-game play (rounds 26-45) is **not measured**. Its runs
    stopped at rounds 15 and 8.
- **Haiku is the most social and conflictual.**
  - Messages, replies, transfers and the only kills in this experiment all came from Haiku, in the
    Two to a Tree forks.
  - It pays for this with long outputs (585 tokens a turn, mostly notebook) and the highest share of
    compute spent on thinking, so more of its agents go broke and starve.
- **Five Groves vs Two to a Tree hold for every model.** Two to a Tree makes agents move and query more
  and eat less. The model changes the style, not the setup's pressure.

## 7. DeepSeek extrapolation method

What was measured:
- DeepSeek played rounds 1-15 of Five Groves and rounds 1-8 of Two to a Tree: 745 decisions, 0 invalid,
  $0.519.
- Rounds 1-5 ran at concurrency 3, then 2. There were 238 HTTP 429s; the failed turns were replayed and
  none produced a decision.
- From 04:08 UTC the runs played one at a time at model concurrency 1, with a guard that parks a run on
  the first 429 (`sweep/tools/showcase/ds_driver.py`). That phase had **0 HTTP 429s** in about 400
  calls.
- In that phase a round took about 115 s and used about 124K tokens, which is **about 65K tokens/min,
  52% of the 125K quota**, and about 16 requests/min (13% of 125).
- Quota headers checked on the deployment: `x-ratelimit-limit-tokens: 125000` and
  `x-ratelimit-limit-requests: 125`, both per 60 s. Only the prompt and the actual output count against
  the token limit, not the requested `max_tokens`: a call with `max_tokens` 4000 used 24 tokens of quota.
- The Two to a Tree trunk was stopped at round 8 when Haiku and Luna finished, at the operator's request.

How the rest was extrapolated:

| Quantity | Method | Result |
| --- | --- | --- |
| Cost, rounds 16-25 | Measured DeepSeek $/round (r1-15, $0.0225) × the growth Haiku and Luna showed from r1-15 to r16-25 in the same setups (×0.99 to ×1.06, mean ×1.03) | $0.0232/round |
| Cost, rounds 26-45 | Same, r1-15 to the forks (×0.81 to ×0.99, mean ×0.92; later rounds have fewer decisions as agents go broke or run skills) | $0.0207/round |
| Cost, full design | 2 trunks × 25 rounds + 4 forks × 20 rounds | **$2.80** (range $2.58-2.93 from the growth range) |
| Invalid rate | 0 in 745; rule of three gives a 95% upper bound of 0.40%. Haiku's rate rose 1.2-1.5 points in r26-45 and Luna's did not change, so later rounds are assumed near 0 | **~0% (≤0.4%)** |
| Wall time inside the quota | 115 s per trunk round, and 115 s × 0.88 (fewer decisions per round in forks) per fork round; runs one at a time | ~48 min per trunk, ~34 min per fork, **~3.9 h** for the design |
| Wall time without the quota | model-seconds per round (118) ÷ concurrency, as verified on all three models | ~20 s per round at 6 calls per run |
| Behaviour after round 15 | **Not extrapolated.** No claim about DeepSeek's mid-game |

To measure DeepSeek fully, raise the `DeepSeek-V4-Flash` deployment's tokens-per-minute limit in the
Azure portal. At Luna's 1M TPM it would run at about Luna's pace × 2.3 (model-seconds 118 against 52).

## 8. What changed in the code for this experiment

- Commit 10caf46 added:
  - the registry entries `azure-gpt6-luna` and `azure-deepseek-v4-flash` (openai provider,
    `AZURE_AI_V1_ENDPOINT` and `AZURE_AI_API_KEY`);
  - the OpenAI-family options `reasoning_effort` and `usd_per_mtok`. The second turns reported usage
    into a list-price `provider_cost_usd`, so run budgets and cost totals work for these routes.
- The sweep tooling is now on backends 8001-8003, with per-backend concurrency set by `PORT_ENV` in
  `sweep/tools/sweep.py`.
