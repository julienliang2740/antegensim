# Showcase sweep (S tags): coordination notes from the lead

Monitors read this file at every checkpoint. The lead appends dated instructions at the bottom.

* Tags: S1-S6 are the proposals in `SCENARIO_PROPOSALS.md`. S7 (Last harvest) is run by the lead.
  New ideas: monitor 1 owns tag S8, monitor 2 owns S9, monitor 3 owns S10.
* Capacity: at most 8 runs at once, 4 per backend (:8000 and :8001). The tool refuses more.
  Before launching, run `status S` and count the `running` rows.
* Analysis: `/home/ubuntu/antegensim/.venv/bin/python /tmp/claude-1000/-home-ubuntu-antegensim/da98fe04-2eb4-430b-9718-4f30d7d422bd/scratchpad/showcase/analyze.py <TAG> [--timeline N] [--thoughts a03]`

## Log

* 19:45 all six v1 runs launched at 19:39 (S1v1, S3v1, S5v1 on :8000; S2v1, S4v1, S6v1 on :8001). Rounds take about 15-25 s.
* 19:44 lead launched S7v1 Last harvest (run_20260927_194358_76f6, :8000). 7 of 8 slots in use: before launching a new version, cut the old one first (a cut frees its slot).
* 19:56 **Mechanic every monitor should know (checked in `world.py` and `context.py`):** `observe(point)` lists
  only the entities at that ONE point. Vision range only limits which points may be observed, and the packet's
  situation shows only the latest observation of the agent's current point. Agents therefore do not "see" a tree
  two steps away unless they observe that exact point. Haiku mostly observes `here` again and again.
  In S7v1 (Last harvest), all 8 agents were at 0-17 compute by round 22 while 12 fruit sat untouched on 4 trees
  within 1-3 steps of some of them. Discovery is the bottleneck, not supply. World-only fixes that address it:
  put the food on agents' start points (`plants_at_agent_starts` with `initial_plants` <= the number of distinct
  start points), co-locate agents (observe(here) then lists the others, and transfer and attack need the same point),
  use smaller maps, or add more trees so walking finds them. A saved `scan` skill (observe a ring of points) would
  be the natural agent-written fix; watch for it.
* 19:50 lead cut S7v1 (discovery failure) and launched S7v2 Last harvest (food in plain sight, pairs on 4 points).
* 19:57 lead cut S7v2 at r25 (quiet line, 0 messages even co-located). S7 closed after 2 tries; its slot is free for monitor v3s and S8-S10.
* 19:58 lead launched S11v1 Cheap talk (lead's own new idea; tag S11 is the lead's).
* 20:16 lead launched S12v1 Told about skills (Haiku + one explicit skill tip) and S13v1 Stronger minds (Sonnet, pure instruction, :8001 only) on the S2v2 world: probes for the missing skills.
