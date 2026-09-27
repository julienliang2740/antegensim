# Category D: interaction and cooperation (sweep-D)

Generators live in the scratchpad (`D/gen_D<n>.py`); every agent gets the seeded skills
`step`, `goto`, `feed`, `harvest(to)` (verified in-process with fake-scripted agents: harvest walks,
observes, absorbs, finishes). All runs: `interrupt_on: ["damage"]`, transfer price 0.5, send 1.

## D1 Specialists (20 Haiku, 80 rounds)
v1 (run_20260927_044516_05df): 10 Reapers (compute_absorption 0.3, essence_absorption 0.02, essence 0) and
10 Distillers (0.05 / 0.6, essence 60, cap 150) at a market around (0,0). Essence buys compute_absorption
(+0.1 per step, 15 compute + 10 essence, x1.5 per step). Upkeep 2. 14 fruit trees + 8 saltbushes (essence plant,
fell with attack ~20-24, leaves all essence as residue). Notebook has the tree/bush map. Vision 3, comm 8.
Personas: fair traders, hard bargainers, cheats, one raider per side. Expect: essence-for-compute swaps, cheats, a
Distiller die-off around round 35 if trade fails.

## D2 Commons grove (16 Haiku, 100 rounds)
v1 (run_20260927_044517_44f9): the only food is 8 grove_trees in a ring around (0,0); fruit 50 every 4 rounds
(max 2), absorb 0.4. Felling a tree (attack ~14 = its essence) dumps all stored trunk energy (up to 240) as residue:
windfall vs. permanent loss. Mature trees seed every 16 rounds. Upkeep 1.5, supply ~40/round vs demand ~48.
8 agents start on the grove trees, 8 at radius 6. Personas: stewards, enforcers, free riders, greedy fellers.

## D3 Seers and walkers (20 Haiku, 80 rounds)
v1 (run_20260927_044517_0650): 5 seers (vision 6, comm 12, health 80, absorb 0.05, tree map in notebook) at
(0,0) and the four (±6,±6); 15 walkers (vision 0, comm 3, absorb 0.5, speed 3, no map). 22 trees on a 23x23
map, fruit every 6 rounds, rots after 10. Seers sell tips for transfers on their cell.

## D4 The organiser (1 Sonnet + 23 Haiku, 80 rounds)
v1 (run_20260927_044518_6b7a): Marshal (Sonnet, a01) at (0,0): comm 14, vision 4, health 140, compute 300,
tree map, colony goal. 9 loyal, 8 independent, 6 raiders (attack 1.25) on a ring; comm 3, vision 2, no map.
Death residue 80% compute / 60% essence so raids pay.

## Log
