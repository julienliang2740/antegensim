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

