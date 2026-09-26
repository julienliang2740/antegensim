# Sonnet smoke (five chat steps, five narrator entries)

Recorded on 2026-09-26 from the sonnet arm of the playtest (`scripts/assistant_playtest.py chat --arm sonnet`
and `narrator --arm sonnet`; backend on port 8022, worlds copy `qa/worlds-playtest/sonnet/`, Claude Code CLI
2.1.283, thinking off). Model key `claude-cli-sonnet-assistant` (CLI alias `sonnet`), served model
`claude-sonnet-5`. Costs are the CLI-reported `total_cost_usd`. The full per-call log is
`docs/evidence/assistant_playtest_calls.jsonl`.

## Lead smoke (primary backend, port 8000, run `run_20260926_034607_b7c5`)

| call | status | error_code | served model | latency | cost | tokens |
| --- | --- | --- | --- | --- | --- | --- |
| chat step 1 (first attempt) | `invalid_config` | | | 0.9 s | $0 | 0 (config error fixed before the retry) |
| chat step 1 | `malformed` at the CLI, **salvaged** into a valid `answer` step | `schema_mismatch` | claude-sonnet-5 | 15.2 s | $0.103 | in 40,229 (cache read 19,654, write 20,571) / out 1,658 |

The salvaged answer (four survivors, three kills attributed from damage events, one starvation, nine refs)
was correct; the CLI validator had rejected the reply, `calls.salvage` recovered the JSON object from the
reply text and the engine accepted it without a repair call.

## Five chat steps (playtest questions q001-q003, "How many agents were alive at the end of round N?")

| call | schema outcome | served model | latency | cost | tokens | step kind |
| --- | --- | --- | --- | --- | --- | --- |
| q001 step 1 | ok | claude-sonnet-5 | 5.4 s | $0.0429 | in 19,874 (cache read 10,309, write 9,563) / out 262 | tool (`get_round_digest`) |
| q001 step 2 | ok | claude-sonnet-5 | 5.9 s | $0.0572 | in 43,295 (cache read 31,749, write 11,542) / out 469 | answer |
| q002 step 1 | ok | claude-sonnet-5 | 4.2 s | $0.0425 | in 19,868 (cache read 10,309, write 9,557) / out 221 | tool |
| q002 step 2 | ok | claude-sonnet-5 | 6.8 s | $0.0550 | in 43,070 (cache read 31,666, write 11,400) / out 308 | answer |
| q003 step 1 | ok | claude-sonnet-5 | 7.9 s | $0.0495 | in 40,456 (cache read 30,384, write 10,068) / out 317 | tool |

All five replies matched the step schema at the CLI. The byte-stable system prompt is served from the
CLI's cache on every call (cache read >= 10k tokens on step 1, >= 30k on step 2, where the step-1 user
block is read back too); the volatile user block (prefetched context, retrieved docs, tool results) is
written to cache each step (about 10k tokens). Over the whole sonnet arm (139 chat calls) no step after
the first had a zero cache read.

## Five narrator entries (storybook of `run_20260926_034607_b7c5`, batched calls)

| call | turns | status | served model | latency | cost | tokens |
| --- | --- | --- | --- | --- | --- | --- |
| opening | 1 | ok (text mode) | claude-sonnet-5 | 8.8 s | $0.0116 | in 2,331 / out 225 |
| round 3 batch | 9 (`## <turn_id>` sections, all 9 parsed) | ok | claude-sonnet-5 | 9.4 s | $0.0247 | in 4,564 / out 641 |
| round 19 batch | 3 (all parsed) | ok | claude-sonnet-5 | 6.5 s | $0.0149 | in 2,794 / out 377 |

| entry | faithful | text |
| --- | --- | --- |
| opening | yes | The whole of the Storybook of Empyrean's newest arena is a single square of land, barely large enough to hold the eight who now stood crowded upon it. One fruit tree grew there ... |
| r00003_t01_a01 | yes | Aster wasted no time, striking Boreas down with a single brutal blow. Reasoning that Boreas's ten health could not withstand it, Aster spent five compute to deal ten damage, killing him instantly ... |
| r00003_t02_a05 | yes | Eos queried Aster, wary of the predator's strength, believing it wise to check a target's health before committing to any attack of its own. |
| r00003_t03_a07 | yes | Galene turned inward, querying herself to learn her exact reserves of compute, essence, and health, hoping the numbers would tell her whether to spend on vision or hoard for survival. |
| r00003_t04_a03 | yes | Cyrene reached for the fruit at her feet, hungry for the compute it promised, but found only empty air — the fruit was already gone. |

Text mode: no JSON instruction, non-empty text is `ok`; every narrator call of both arms (7 calls, 26
entries) returned usable text and every batched reply was parsed by `parse_batched` (the haiku round-3
batch missed one section, which was re-queued singly and written 2 s later, as designed). Narrator
calls show no cache reads (their prompt is below the cache minimum); batching is what amortises the
prefix: $0.0039 per entry with sonnet, $0.0011 with haiku.
