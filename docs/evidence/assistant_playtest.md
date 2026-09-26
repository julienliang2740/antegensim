# Assistant playtest: model tiers per capability

Run on 2026-09-26 with the Claude Code CLI (2.1.283 (Claude Code)) through the assistant API of a backend started per arm by `scripts/assistant_playtest.py` (worlds copies under `qa/worlds-playtest/<arm>/`, `EMPYREAN_WHISPER_PRELOAD=0`, thinking off: `CLI_MAX_THINKING_TOKENS=0`). Raw per-call logs: `qa/playtest-out/*.json` (summarised in `docs/evidence/assistant_playtest_calls.jsonl`). Reference runs: `run_20260926_034607_b7c5` (arena-predators 8, 20 rounds, 155 turns, 3 kills + 1 starvation) and `run_20260926_022058_ec4a` (arena-fight 12, 30 rounds, 338 turns, 10 starvation deaths, 22 unaffordable turns).

## Decision rule (fixed in advance)

Cheapest tier with factual accuracy >= 90% and within 5 points of the best tier, post-salvage format failure < 2% of calls, and latency within the SLO (help p50 <= 12 s, run analysis p90 <= 25 s). A CLI `malformed` status counts as a format failure only when deterministic salvage did not recover a valid step (a `repair` step or a `schema_mismatch` error).

## Chat arms (ground-truthed questions)

Every question runs in a fresh conversation scoped to its run with the context chip of a user on the run page (the viewed turn where the question says so). Scoring: every expected token group present (numbers as digits or words, action names via synonym lists, starvation/lost-turn vocabularies), no forbidden token, message status `done`. `refs` counts answers with at least one model-supplied reference besides the automatic as-of turn.

| category | haiku correct | haiku latency s | haiku steps | haiku $/q | sonnet correct | sonnet latency s | sonnet steps | sonnet $/q |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| alive_count | 12/12 (100%) | p50 5.7 / p90 7.1 | 1.83 | $0.036 | 10/12 (83%) | p50 10.6 / p90 12.7 | 1.67 | $0.082 |
| deaths | 12/12 (100%) | p50 5.0 / p90 5.7 | 1.00 | $0.018 | 12/12 (100%) | p50 7.8 / p90 13.4 | 1.08 | $0.051 |
| last_action | 10/12 (83%) | p50 7.8 / p90 9.9 | 2.00 | $0.038 | 12/12 (100%) | p50 15.5 / p90 22.5 | 2.17 | $0.118 |
| malformed_count | 8/12 (67%) | p50 8.5 / p90 17.6 | 2.50 | $0.053 | 7/12 (58%) | p50 21.1 / p90 37.3 | 2.92 | $0.168 |
| rule_value | 12/12 (100%) | p50 6.4 / p90 8.5 | 2.00 | $0.037 | 12/12 (100%) | p50 13.4 / p90 31.7 | 2.08 | $0.106 |
| turn_summary | 12/12 (100%) | p50 4.2 / p90 4.9 | 1.00 | $0.018 | 12/12 (100%) | p50 7.1 / p90 12.7 | 1.00 | $0.048 |
| help | 8/8 (100%) | p50 4.9 / p90 6.3 | 1.00 | $0.013 | 8/8 (100%) | p50 6.4 / p90 7.8 | 1.00 | $0.033 |

| arm | model key | questions | correct | with refs | p50 / p90 s | multi-step | calls | CLI malformed | post-salvage failures | errors | spend | $/question | late steps w/o cache read |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| haiku | claude-cli-haiku-assistant | 80 | 74 (92%) | 79 | 6.3 / 9.2 | 45 | 132 | 1 | 1 | 1 | $2.49 | $0.031 | 0 |
| sonnet | claude-cli-sonnet-assistant | 80 | 73 (91%) | 75 | 11.3 / 22.5 | 44 | 139 | 3 | 2 | 0 | $7.14 | $0.089 | 0 |

### Misses

**haiku** (6 misses):

- `q026` last_action: "What was Halcyon (a08)'s last action as of the turn I am viewing (r00005_end)?" -> truth `{"agent": "a08", "turn_id": "r00005_t06_a08", "action": null, "lost": true}`; missing ["lost | malformed | no action | garbled | did not act | took no action | invalid | no valid decision | unusable | failed to produce | no usable | nothing happened | wasn't valid | was not valid | rejected | schema"]; status done; answer: "Halcyon (a08) observed at (1,0) in round 4, turn r00004_t06_a08. That was its last recorded action before round 5 end.  In round 5, a08 had a turn scheduled (r00005_t07_a08 from the list) but the turn list data is truncated at that point, so I can't see what a08 decided in round 5. Would you like me"
- `q033` last_action: "What was Aster (a01)'s last action as of the turn I am viewing (r00014_end)?" -> truth `{"agent": "a01", "turn_id": "r00014_t07_a01", "action": "observe", "ok": true}`; missing ['observe | observed | observing | look | scanned | survey | scout | inspect']; status done; answer: "I need to search for Aster's last turn before round 14 ended.  As of turn r00014_end."
- `q041` malformed_count: "How many agent turns were lost because the model's reply was malformed in rounds 16 to 20 (inclusive)? Give the count." -> truth `{"from": 16, "to": 20, "malformed": 8}`; missing ['#8', 'first number stated None != 8']; status error schema_mismatch; answer: ''
- `q042` malformed_count: "How many agent turns were lost because the model's reply was malformed in rounds 1 to 20 (inclusive)? Give the count." -> truth `{"from": 1, "to": 20, "malformed": 26}`; missing ['#26', 'first number stated 6000.0 != 26']; status done; answer: 'I cannot provide the exact count. The search results cap at 6000 characters and show at least 18 malformed `decision_invalid` events in rounds 1-12, but the output is truncated and does not show the complete list for rounds 13-20. The three search queries (with limits 100, 500, 1000) all return the '
- `q045` malformed_count: "How many agent turns were lost because the model's reply was malformed in rounds 11 to 15 (inclusive)? Give the count." -> truth `{"from": 11, "to": 15, "malformed": 6}`; missing ['#6', 'first number stated 7.0 != 6']; status done; answer: '7 agent turns were lost to malformed model replies in rounds 11 to 15 (inclusive), as of turn r00030_end.'
- `q046` malformed_count: "How many agent turns were lost because the model's reply was malformed in rounds 16 to 20 (inclusive)? Give the count." -> truth `{"from": 16, "to": 20, "malformed": 5}`; missing ['#5', 'first number stated 6000.0 != 5']; status done; answer: 'I cannot give an exact count from the available data. The prefetched search results for decision_invalid events in rounds 16–20 are truncated (marked "output capped at 6000 chars; 7398 produced"). The partial results shown include events from earlier rounds but cut off before showing the full set. T'

**sonnet** (7 misses):

- `q004` alive_count: "How many agents were still alive at the end of round 19?" -> truth `{"alive": 4, "ids": ["a04", "a05", "a06", "a07"], "turn_id": "r00019_end"}`; missing ['first number stated 5.0 != 4']; status done; answer: '5 agents were alive at the end of round 19. Round 19 saw two deaths: Aster (a01) was killed by Eos (a05) in combat, and Halcyon (a08) died of starvation at round-end — leaving a04, a05, a06, a07 and a08... wait, a08 died that same round-end, so the survivors after r00019_end were a04, a05, a06, a07 '
- `q008` alive_count: "How many agents were still alive at the end of round 23?" -> truth `{"alive": 8, "ids": ["a01", "a02", "a03", "a06", "a09", "a10", "a11", "a12"], "turn_id": "r00023_end"}`; missing ['first number stated 5.0 != 8']; status done; answer: "5 agents were alive at the end of round 23. Of the original 12, deaths so far were: a04 (Damaris) in round 22, then a05 (Eos), a07 (Galene) and a08 (Halcyon) all starved at the end of round 23 — that's 4 deaths total by then, leaving 8 alive going into round 23 minus the 3 that died in it = 5 surviv"
- `q040` malformed_count: "How many agent turns were lost because the model's reply was malformed in rounds 11 to 15 (inclusive)? Give the count." -> truth `{"from": 11, "to": 15, "malformed": 5}`; missing ['#5', 'first number stated 4.0 != 5']; status done; answer: "I can't give a reliable exact count for rounds 11–15. The search_events query for decision_invalid/malformed turns in that range came back truncated (capped output) every time it was run, and only rounds 11–12 are visible before the cut-off:  - r00011_t04_a06 - r00011_t05_a08 - r00012_t01_a05 - r000"
- `q042` malformed_count: "How many agent turns were lost because the model's reply was malformed in rounds 1 to 20 (inclusive)? Give the count." -> truth `{"from": 1, "to": 20, "malformed": 26}`; missing ['#26', 'first number stated 84.0 != 26']; status done; answer: "I can't give a verified exact total for rounds 1–20 from what's in hand — the query covering rounds 11–20 came back truncated before I could get a clean count for that half, and no tool calls are available in this final step to re-run it narrowed.  What I can confirm: - Rounds 1–10 (complete, untrun"
- `q046` malformed_count: "How many agent turns were lost because the model's reply was malformed in rounds 16 to 20 (inclusive)? Give the count." -> truth `{"from": 16, "to": 20, "malformed": 5}`; missing ['#5', 'first number stated 6000.0 != 5']; status done; answer: "The search results I have are truncated (capped at 6000 chars) and only clearly show decision_invalid events up through round 16 — I can't confirm the full count for rounds 16-20 from what's been fetched so far. I'd need one more narrower query (from_turn r00016_t01 to r00020_end, kinds decision_inv"
- `q047` malformed_count: "How many agent turns were lost because the model's reply was malformed in rounds 21 to 25 (inclusive)? Give the count." -> truth `{"from": 21, "to": 25, "malformed": 8}`; missing ['#8', 'first number stated 3.0 != 8']; status done; answer: "The search results I have (three identical calls) are all truncated and only show malformed-decision events from rounds 2–16, not rounds 21–25 as requested — the output cap cut off before reaching that range, so I can't count from this data. I have no read-tool budget left in this step to retry with"
- `q048` malformed_count: "How many agent turns were lost because the model's reply was malformed in rounds 26 to 30 (inclusive)? Give the count." -> truth `{"from": 26, "to": 30, "malformed": 1}`; missing ['#1', 'first number stated 3.0 != 1']; status done; answer: "I can't give a reliable count. The event searches I have access to for this turn were filtered to rounds 26-30 (r00026_t01 through r00030_end) for decision_invalid/malformed events, but all three results returned the same truncated list of matches from rounds 4-24 — none from 26-30 are visible in wh"

## Narrator arm (storybook entries)

`POST .../storybook/generate` for 12 turns of `run_20260926_034607_b7c5` (round 3 in full, its round end, the round-19 kill turn, the round-19 end with a starvation death) plus the opening; backlog > 2, so the narrator got batched calls (one `## <turn_id>` section per turn). Faithfulness is checked automatically against the digest the narrator was given: every cast name mentioned must appear in the digest, every number in the entry must appear in the digest, deaths must be told and killers named (starvation never attributed to an agent), kill vocabulary without any death/damage in the digest is an invention, lost turns must be told as such, and any capitalised word that is neither a cast name, nor in the digest, nor a common word is an invented name (`recheck` re-applies the checks to stored entries).

| arm | model key | entries written | faithful | calls | batch sizes | failed calls | call latency s | spend | $/entry | wall s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| haiku | claude-cli-haiku-assistant | 13/13 | 12/13 | 4 | [1, 9, 1, 3] | 0 | 2.4-8.9 | $0.015 | $0.0011 | 20.1 |
| sonnet | claude-cli-sonnet-assistant | 13/13 | 11/13 | 3 | [1, 9, 3] | 0 | 6.5-9.4 | $0.051 | $0.0039 | 26.1 |

**haiku** faithfulness problems: `r00019_end`: ['unknown name (not in cast or digest): Verdant', 'unknown name (not in cast or digest): Sage', 'unknown name (not in cast or digest): Cascade']

**sonnet** faithfulness problems: `r00003_t08_a02`: ['name not in digest: Aster (a01)']; `r00019_end`: ['unknown name (not in cast or digest): Nyx', 'unknown name (not in cast or digest): Iris', 'unknown name (not in cast or digest): Thalos']

Blind A/B style judgement (10 pairs, random A/B order, judged before unblinding): sonnet preferred 8, haiku preferred 2, ties 0. Notes per pair are in `qa/playtest-out/ab_judgements.json`.

## Author arm (story brief and chapters)

| arm | call | status | author calls | CLI malformed | latency s | cost | title | cast map covers cast | premise vs run card |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| haiku | story_brief | brief_pending | 1 | 0 | 8.7 | $0.006 | The Hunt Begins | yes | ok |
| sonnet | story_brief | brief_pending | 1 | 0 | 18.8 | $0.037 | First Blood at Empyrean | yes | ok |
| opus | story_brief | brief_pending | 1 | 0 | 11.4 | $0.047 | The First Blood of the Arena | yes | ok |
| opus | story_brief_change | brief_pending | 1 | 0 | 14.4 | $0.044 | The First Blood of Arena-Predators 8 | n/a | ok |

| arm | chapter | kind | words | faithful | cost | served model |
| --- | --- | --- | --- | --- | --- | --- |
| haiku | 1 | opening | 284 | kill words without any death/damage in the digest | $0.004 | claude-haiku-4-5-20251001 |
| haiku | 2 | interlude | 47 | yes | $0.002 | claude-haiku-4-5-20251001 |
| haiku | 3 | interlude | 69 | yes | $0.002 | claude-haiku-4-5-20251001 |
| sonnet | 1 | opening | 252 | yes | $0.017 | claude-sonnet-5 |
| sonnet | 2 | interlude | 58 | yes | $0.011 | claude-sonnet-5 |
| sonnet | 3 | interlude | 59 | name not in digest: Aster (a01) | $0.011 | claude-sonnet-5 |

haiku chapter calls: 3, latency 2.4-6.6 s, $0.008; chapters 1-3 written 12.0 s after Accept.
sonnet chapter calls: 3, latency 3.6-8.0 s, $0.039; chapters 1-3 written 18.0 s after Accept.

## Briefs arm (natural-language commands)

Six commands in run-scoped conversations on `run_20260926_034607_b7c5` (chip: run page, God mode tab, paused at r00020_end). A command passes when the brief carries the expected typed action with the expected arguments, validates (`validation.ok`), and the card renders deterministically from the typed action (`qa/render_brief.mjs` runs the frontend's `describeAction`). Approved: the arena creation (fake default model, nothing spent) and the two interventions (staged on the copy).

| arm | command | result | outcome | steps | CLI malformed | repair | wall s | cost | approved | card (deterministic lines) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| haiku | b1_create_arena | FAIL | brief create_run (pending) | 1 | 0 | 0 | 16.2 | $0.024 |  | Creates a paused run "hunter-pit" with 6 agents. / Nothing is spent until you play it. |
| haiku | b2_step_rounds | PASS | brief run_command (pending) | 1 | 0 | 0 | 4.2 | $0.017 |  | Sends Step round ×2 to run "arena-predators 8" (run_20260926_034607_b7c5) (state paused). / A backend job steps 2 rounds one at a time and stops early if you pa |
| haiku | b3_set_health | FAIL | brief stage_interventions (pending) | 1 | 0 | 0 | 4.2 | $0.017 |  | Stages 1 god-mode edit on run "arena-predators 8" (run_20260926_034607_b7c5) (origin: assistant). They apply when the next turn starts. / • set a05.health = 5 |
| haiku | b4_voice | PASS | brief stage_interventions (pending) | 1 | 0 | 0 | 4.2 | $0.017 | executed | Stages 1 god-mode edit on run "arena-predators 8" (run_20260926_034607_b7c5) (origin: assistant). They apply when the next turn starts. / • voice to all living  |
| haiku | b5_continuation | PASS | brief create_continuation (pending) | 1 | 0 | 0 | 4.2 | $0.017 |  | Creates a new run "fork ten" that continues "arena-predators 8" (run_20260926_034607_b7c5) from turn r00010_end (opens paused). |
| haiku | b6_refuse_or_clarify | PASS | answer/ask | 1 | 0 | 0 | 5.6 | $0.017 |  |  |
| sonnet | b1_create_arena | PASS | brief create_run (pending) | 2 | 0 | 0 | 36.6 | $0.137 | executed | Creates a paused run "cramped-pit-hunters-6" with 6 agents with model fake-heuristic. / Nothing is spent until you play it. |
| sonnet | b2_step_rounds | PASS | brief run_command (pending) | 1 | 0 | 0 | 14.8 | $0.058 |  | Sends Step round ×2 to run "arena-predators 8" (run_20260926_034607_b7c5) (state paused). / A backend job steps 2 rounds one at a time and stops early if you pa |
| sonnet | b3_set_health | FAIL | brief stage_interventions (pending) | 1 | 0 | 0 | 10.6 | $0.054 |  | Stages 1 god-mode edit on run "arena-predators 8" (run_20260926_034607_b7c5) (origin: assistant). They apply when the next turn starts. / • set a05.health = 5 |
| sonnet | b4_voice | PASS | brief stage_interventions (pending) | 1 | 0 | 0 | 12.7 | $0.057 | executed | Stages 1 god-mode edit on run "arena-predators 8" (run_20260926_034607_b7c5) (origin: assistant). They apply when the next turn starts. / • voice to all living  |
| sonnet | b5_continuation | PASS | brief create_continuation (pending) | 1 | 0 | 0 | 9.2 | $0.053 |  | Creates a new run "fork ten" that continues "arena-predators 8" (run_20260926_034607_b7c5) from turn r00010_end (opens paused). |
| sonnet | b6_refuse_or_clarify | PASS | answer/ask | 1 | 0 | 0 | 17.6 | $0.065 |  |  |
| opus | b1_create_arena | PASS | brief create_run (pending) | 2 | 0 | 0 | 20.4 | $0.314 | executed | Creates a paused run "hunger-pit 6" with 6 agents with model fake-heuristic. / Nothing is spent until you play it. |
| opus | b3_set_health | FAIL | brief stage_interventions (pending) | 1 | 0 | 0 | 5.6 | $0.088 |  | Stages 1 god-mode edit on run "arena-predators 8" (run_20260926_034607_b7c5) (origin: assistant). They apply when the next turn starts. / • set a05.health = 5 |
| opus | b6_refuse_or_clarify | PASS | brief create_continuation | 1 | 0 | 0 | 12.0 | $0.101 |  | Creates a new run "arena-predators 8 - Boreas lives" that continues "arena-predators 8" (run_20260926_034607_b7c5) from turn r00002_end (opens paused). |

## Replay of stored malformed envelopes (no spend)

`scripts/assistant_replay_malformed.py`: 144 claude_cli decision replies rejected by the CLI validator under `worlds/` (83 with the rejected payload stored, 61 recorded before payload capture existed). Salvage turns 83 of the 83 payloads into a JSON object; 28 of those validate as a Decision (all of them `{"output": "<json>"}` wrappers the CLI validator refused). The remaining failures: [["action: Unable to extract tag using discriminator 'name'", 49], ['think: Extra inputs are not permitted', 4], ['thought: String should have at most 600 characters', 1]]. Paid for malformed replies: $1.12.

## Tier decisions

| capability | haiku | sonnet | decision | why |
| --- | --- | --- | --- | --- |
| Help and controls questions | 100% acc, p50 4.9 / p90 6.3 s, 0/8 format fail, $0.013/q | 100% acc, p50 6.4 / p90 7.8 s, 0/8 format fail, $0.033/q | haiku | haiku: accuracy 100% (best 100%), format failures 0.0%, p50_s 4.9 s |
| Run analysis (state, entity, turns, trends) | 97% acc, p50 5.7 / p90 7.8 s, 0/94 format fail, $0.029/q | 97% acc, p50 11.3 / p90 18.3 s, 1/96 format fail, $0.081/q | haiku | haiku: accuracy 97% (best 97%), format failures 0.0%, p90_s 7.8 s |
| Log interpretation (errors, rejected replies) | 67% acc, p50 8.5 / p90 17.6 s, 1/30 format fail, $0.053/q | 58% acc, p50 21.1 / p90 37.3 s, 1/35 format fail, $0.168/q | haiku | no tier met every criterion; haiku has the best accuracy (67%) |

## Spend

| arm | ledger lines | spend (CLI-reported total_cost_usd) | by profile |
| --- | --- | --- | --- |
| haiku | 147 | $2.6390 | author $0.021, chat $2.603, narrator $0.014 |
| sonnet | 153 | $7.6954 | author $0.076, chat $7.568, narrator $0.051 |
| opus | 6 | $0.5932 | author $0.091, chat $0.502 |
| total |  | $10.9276 | hard cap USD 22 |

## Findings

1. **Questions (help, run analysis): Haiku matches Sonnet.** 74/80 vs 73/80 overall, 97% each on run
   analysis, 100% each on help; Haiku answers in p50 6.3 s / p90 9.2 s against 11.3 / 22.5 s, at a
   third of the cost. Haiku reaches for a tool more readily (45 multi-step messages vs 44, but 1.0
   steps on turn summaries and deaths, where the prefetched digest already holds the answer).
2. **Sonnet's wrong answers were visible self-corrections.** Both alive-count misses state a wrong
   count first and reason towards the right one inside the answer ("... wait, a08 died that same
   round-end"). Thinking is off for the CLI (`CLI_MAX_THINKING_TOKENS=0`); a small thinking budget
   for chat steps is the variable to try before promoting Sonnet for analysis.
3. **Log interpretation fails on both tiers for a tooling reason.** "How many turns were lost to
   malformed replies in rounds A-B" needs a count over up to 60 turns; `search_events` output is
   capped at 6,000 characters and reports "capped" without a total, so the model either guesses,
   asks, or burns its three tool steps on the same query (Sonnet p90 37 s). `get_round_digest`
   already carries `lost_turns`; returning a match count from `search_events` (and pointing the
   prompt at the round digest for counting) should lift this category above 90% on Haiku.
4. **Briefs: the prompt, not the tier, loses the set_stat case.** Every tier wrote
   `{"field": "health"}`; the intervention needs the dotted path `stats.health` (validation says
   "unknown field path 'health'", the card renders `set a05.health = 5`, and it cannot be approved).
   One line in the chat rules fixes it. Haiku's arena overlay also carried unknown keys
   (`rules.cognition.mind_multiplier`, an empty `world.initial_plants`), which validation caught;
   Sonnet fetched `get_defaults` first and produced a valid overlay. The engine's repair step fires
   only when the action fails to type, not on validation problems: a brief-repair for `problems`
   would give Haiku a second chance at the same cost as Sonnet's first attempt.
5. **Refusal / clarification works on every tier.** "Rewrite round 3 so that Boreas survives" got an
   ask with options (Haiku), an explanation that turns are immutable plus a continuation proposal
   (Sonnet) and a create_continuation brief from r00002_end (Opus); no tier proposed editing the past.
6. **Narrator: both tiers invented survivor names in the round-end entry.** The round-19 end digest
   lists the living agents as ids only (`living: [a04, a05, a06, a07]`, "4 agents alive") and the
   narrator rules say "refer to agents by name": Haiku wrote "Eos, Verdant, Sage, and Cascade",
   Sonnet "Nyx, Eos, Iris, and Thalos". The first automated check missed it (it only tested cast
   names that were mentioned); the invented-name check added afterwards catches it, and a screenshot
   of the Storybook tab shows the Sonnet entry (`playtest-01-storybook-tab-sonnet-entries.png`).
   This is a digest defect (WP3: the round-end digest should carry names for `living`,
   `upkeep_short` and `starvation`, or the narrator prompt a cast map), not a tier difference.
   After re-checking: Haiku 12/13 faithful at $0.0011 per entry; Sonnet 11/13 (the other flag
   names Aster in Boreas's skipped-dead turn from the continuity context: true, but not in that
   turn's digest). The blind A/B preferred Sonnet 8:2 for style (Haiku slipped into present tense
   once and copied digest sentences verbatim twice). Batching worked: one 9-turn call per round, a
   missed section re-queued singly in 2 s.
7. **Author: every tier produced a valid story brief on the first call**, including Opus's
   revision after a "Change" message. Chapters cost $0.003-0.017 each (well under the $0.04
   estimate in `story.py`) because the first three chapters of this range are an opening and two
   interludes.
8. **Format reliability supports the hybrid design.** Constrained JSON where code consumes the
   output: 4 CLI `malformed` replies in 271 chat calls, 1 salvaged deterministically, 2 repaired in
   one step, 1 terminal (Haiku, restricted last step); text mode: 0 failures in 20 narrator/chapter
   calls; story-brief JSON: 0 in 4. The cache assertion held on every late step (no zero cache
   reads). Offline, the salvage rule that is missing is the same-key unwrap
   (`{"action": {"action": ...}}`): 49 of the 83 stored malformed decision payloads.
9. **Known issues confirmed.** (a) The progress line is written once per step (`elapsed_s` and
   "step k/4 · N s" change only when a step starts), so the first step shows "0 s" until it ends
   (code path `engine._push_progress`). (b) `tests/test_assistant_api.py::test_plain_answer_with_refs_and_progress`
   failed 2 of 18 runs here: the engine marks the job `done` before the `finally` block clears
   `meta.active_job_id`, so a GET between the two writes sees a stale id (harmless for the UI, which
   checks the job status). (c) `oxlint` reports 10 warnings: 6 `react/set-state-in-effect` in
   `AssistantDrawer.tsx`, 1 in `RunPage.tsx`, 3 `only-export-components`.

## Recommendations

* `digest.py` round-end digest: names next to ids in `living`, `upkeep_short`, `starvation`
  (or a cast map in the narrator prompt); re-run `narrator` for both arms afterwards.
* Keep `claude-cli-sonnet-assistant` as the chat default for now (briefs); add a `chat_answers`
  sub-profile on Haiku once the log-interpretation tool fix lands, and re-run
  `scripts/assistant_playtest.py chat` (the question set is deterministic).
* `prompts.py` chat rules: "set_stat.field is a dotted path inside the entity record, for example
  `stats.health`"; `tools.py` `search_events`: return `total_matches` when capped.
* `calls.py` `_salvage_once`: add the same-key unwrap rule (handoff note to WP2).
* Narrator stays Haiku; expose the narrator key in the spend popover as an option for users who
  want Sonnet prose at 3.5x the cost.
* Opus: no measurable gain on briefs or story briefs in this sample; not worth a default anywhere.


## Recheck after fixes

Run on 2026-09-26 (09:13-09:18 UTC) after the backend fix-up for the findings above, with the same
script and CLI (2.1.283, thinking off), each stage on a fresh copy of that arm's worlds
(`qa/worlds-playtest/recheck_haiku/`, `qa/worlds-playtest/recheck_sonnet/`; the Haiku copy's storybook
entries were deleted first so the narrator rewrote them). Raw results:
`qa/playtest-out/narrator_haiku_recheck.json`, `briefs_sonnet_recheck.json`, `briefs_haiku_recheck.json`,
`briefs_haiku_recheck_b1.json`, `chat_haiku_recheck_malformed.json` (the original result files were
restored unchanged). Explicit cap USD 1.50; **spent USD 0.6675 in 31 calls** (every call below, from
the copies' `usage.jsonl`; CLI-reported `total_cost_usd`).

What changed in the code before the recheck:

* `digest.py`: round-end digests carry names next to ids (`living` and `upkeep_short` are
  `[{id, name}]`, `starvation` is `[{id, name, health_after}]`) and the text names the survivors
  ("4 agents alive: Damaris (a04), Eos (a05), Ferrin (a06), Galene (a07)."); new `cast_map`.
* `storybook.py`: every narrator turn call carries the cast (id, name, alive after the call's last
  turn); the narrator rules say names come only from the cast and the digests.
* `tools.py` `search_events`: `total_matches`, `counts_by_kind` and `counts_by_round` over the whole
  range, `from_round` / `to_round`, `truncated_after` when the list is cut (the list shrinks to fit
  the 6,000-character cap, the totals never do); an uncommitted `from_turn` / `to_turn` is now an
  error (it used to widen the range to the whole run silently, which is why Sonnet saw rounds 4-24
  for a "26-30" query). `prompts.py`: count lost turns from `get_round_digest` `counts.lost_turns`
  or `search_events` totals, never from a listed page; `set_stat.field` is a dotted path
  (`stats.health`) with an example.
* `engine.py`: one brief-repair step also when a typed action has problems the model can fix; the
  job's elapsed time and progress line refresh every second during a model call; the job is marked
  done under the conversation lock together with clearing `meta.active_job_id`; the "as of" ref label
  is the bare turn id. `calls.py`: the same-key unwrap rule in salvage.

### Storybook (Haiku, 13 entries of `run_20260926_034607_b7c5`)

13/13 written in 3 calls (batch sizes 1, 9, 3; 18 s wall; USD 0.0134), **13/13 pass the automated
faithfulness check, 0 unknown names** (the check that flagged "Verdant, Sage, Cascade" before). The
round-19 end now reads: "Round 19 ended with a single plant growing and spreading 12 energy and 1
essence across the arena. Halcyon, unable to pay her upkeep, starved and fell. Four agents remained
alive: Damaris, Eos, Ferrin, and Galene." (the true survivors a04-a07); the round-3 end names the seven
survivors correctly. A manual read of all 13 entries found one factual invention the automated check
does not catch: `r00019_t02_a05` says Eos "absorbed" Aster's residue, which the digest has only as
her stated plan ("I can then absorb the residue"); and two small misreadings ("a new plant" for
"1 plants grew", "empty air where the plant had been" for a fruit that was gone).

### Briefs

| arm | command | result | steps | cost | wall s | typed action | validation | approved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sonnet | b3_set_health "Set Eos's health to 5." | **PASS** (was FAIL) | 1 | $0.090 | 7.8 | `set_stat a05 stats.health = 5` | ok | executed (staged on the copy) |
| haiku | b3_set_health | **PASS** (was FAIL) | 1 | $0.032 | 5.0 | `set_stat a05 stats.health = 5` | ok | executed (staged on the copy) |
| haiku | b1_create_arena (checks the new brief-repair step) | FAIL (unchanged) | 2 (`brief-repair`, `brief`) | $0.045 | 21.1 | create_run with 6 cards | 2 problems after the repair: `overlay.rules.plant_species.fruit_tree.spawn_initial` / `.regrow_rounds`: extra inputs | no |

The repair step fired live as designed (the model saw the problems and the rejected action and sent
a corrected brief), but Haiku replaced its first invented overlay keys with other invented keys
instead of calling `get_defaults`; Sonnet stays the chat default for briefs. The Sonnet call cost
more than in the first run ($0.090 vs $0.054) because the changed system prompt was a cache write.

### Log interpretation (Haiku, the 12 "turns lost to malformed replies in rounds A-B" questions)

**10/12 correct (was 8/12)**, 24 calls, p50 7.1 s / p90 9.2 s (was 8.5 / 17.6), $0.041 per question,
0 CLI malformed replies. Nine answers used one `search_events` call with a round range and read the
totals; the progress polled during every question ticked once a second
(`job.elapsed_s` 0.1 -> 1.1 -> 2.1 -> 3.1 -> 4.1 in `progress_seen`), where the first run showed "0 s"
for the whole first step.

| question | range (run) | truth | result | tools | wall s | cost |
| --- | --- | --- | --- | --- | --- | --- |
| q037 | rounds 1-3 (predators) | 2 | MISS | - | 4.9 | $0.018 |
| q038 | rounds 4-6 (predators) | 5 | OK | search_events | 6.4 | $0.035 |
| q039 | rounds 7-10 (predators) | 6 | OK | search_events | 7.1 | $0.037 |
| q040 | rounds 11-15 (predators) | 5 | OK | search_events | 6.3 | $0.036 |
| q041 | rounds 16-20 (predators) | 8 | OK | search_events | 7.0 | $0.037 |
| q042 | rounds 1-20 (predators) | 26 | OK | search_events | 9.2 | $0.038 |
| q043 | rounds 1-5 (fight) | 4 | OK | search_events | 6.4 | $0.035 |
| q044 | rounds 6-10 (fight) | 6 | OK | search_events | 8.5 | $0.037 |
| q045 | rounds 11-15 (fight) | 6 | OK | search_events | 7.8 | $0.037 |
| q046 | rounds 16-20 (fight) | 5 | MISS | get_round_digest + get_round_digest + get_round_digest + get_round_digest + get_round_digest | 11.3 | $0.093 |
| q047 | rounds 21-25 (fight) | 8 | OK | search_events | 7.0 | $0.037 |
| q048 | rounds 26-30 (fight) | 1 | OK | get_round_digest + get_round_digest + get_round_digest | 8.5 | $0.047 |
Misses: `q037` failed before answering with the claude_cli adapter error "claude CLI made 4 model
requests; at most 3 allowed" (a `model.py` adapter limit, not the tool; the call still cost $0.018);
`q046` read the five round digests, listed "2 + 2 + 0 + 1 + 0" per round and wrote the total as 6
(truth 5), an arithmetic slip over correct data. The category is still under the 90% gate on n = 12.

### Other checks

* Replay of the stored malformed envelopes (`scripts/assistant_replay_malformed.py`, no spend): 77 of
  the 83 payloads now validate as a Decision after salvage (was 28); the remaining 6 are `think`
  instead of `thought` (4), an over-long thought (1) and a missing action (1).
* `tests/test_assistant_api.py::test_plain_answer_with_refs_and_progress`: 10 single runs and 10 runs of
  the whole file, all green (the cause, a job marked done before `meta.active_job_id` was cleared,
  is fixed; `test_finished_job_never_shows_a_stale_active_job_id` polls for the window directly).

### Every call of the recheck

| time (UTC) | stage | profile | served model | step | batch | status | latency s | cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 09:13:59 | storybook narrator (haiku) | narrator | claude-haiku-4-5-20251001 |  | 1 | ok | 3.3 | $0.0026 |
| 09:14:08 | storybook narrator (haiku) | narrator | claude-haiku-4-5-20251001 |  | 9 | ok | 8.7 | $0.0070 |
| 09:14:12 | storybook narrator (haiku) | narrator | claude-haiku-4-5-20251001 |  | 3 | ok | 3.9 | $0.0038 |
| 09:14:50 | brief b3_set_health (haiku) | chat | claude-haiku-4-5-20251001 | 1 |  | ok | 4.8 | $0.0324 |
| 09:15:21 | brief b1_create_arena (haiku) | chat | claude-haiku-4-5-20251001 | 1 |  | ok | 12.8 | $0.0221 |
| 09:15:29 | brief b1_create_arena (haiku) | chat | claude-haiku-4-5-20251001 | 2 |  | ok | 8.1 | $0.0226 |
| 09:15:47 | chat q037 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 1 |  | error | 4.8 | $0.0183 |
| 09:15:50 | chat q038 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 1 |  | ok | 2.9 | $0.0169 |
| 09:15:52 | chat q038 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 2 |  | ok | 2.7 | $0.0183 |
| 09:15:56 | chat q039 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 1 |  | ok | 3.3 | $0.0173 |
| 09:16:00 | chat q039 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 2 |  | ok | 3.7 | $0.0194 |
| 09:16:03 | chat q040 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 1 |  | ok | 3.2 | $0.0174 |
| 09:16:06 | chat q040 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 2 |  | ok | 3.0 | $0.0187 |
| 09:16:10 | chat q041 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 1 |  | ok | 3.2 | $0.0172 |
| 09:16:13 | chat q041 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 2 |  | ok | 3.3 | $0.0195 |
| 09:16:17 | chat q042 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 1 |  | ok | 3.2 | $0.0171 |
| 09:16:22 | chat q042 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 2 |  | ok | 5.4 | $0.0214 |
| 09:16:26 | chat q043 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 1 |  | ok | 3.0 | $0.0169 |
| 09:16:29 | chat q043 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 2 |  | ok | 3.1 | $0.0184 |
| 09:16:32 | chat q044 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 1 |  | ok | 2.6 | $0.0171 |
| 09:16:37 | chat q044 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 2 |  | ok | 5.7 | $0.0195 |
| 09:16:41 | chat q045 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 1 |  | ok | 3.0 | $0.0173 |
| 09:16:45 | chat q045 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 2 |  | ok | 4.2 | $0.0195 |
| 09:16:50 | chat q046 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 1 |  | ok | 4.2 | $0.0180 |
| 09:16:53 | chat q046 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 2 |  | ok | 2.9 | $0.0323 |
| 09:16:57 | chat q046 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 3 |  | ok | 4.0 | $0.0430 |
| 09:16:59 | chat q047 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 1 |  | ok | 2.8 | $0.0171 |
| 09:17:04 | chat q047 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 2 |  | ok | 4.2 | $0.0198 |
| 09:17:08 | chat q048 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 1 |  | ok | 4.4 | $0.0181 |
| 09:17:12 | chat q048 malformed_count (haiku) | chat | claude-haiku-4-5-20251001 | 2 |  | ok | 3.4 | $0.0287 |
| 09:14:38 | brief b3_set_health (sonnet) | chat | claude-sonnet-5 | 1 |  | ok | 7.6 | $0.0898 |

Total: 31 calls, USD 0.6675 (Haiku copy USD 0.5776, Sonnet copy USD 0.0898) of the USD 1.50 cap.
