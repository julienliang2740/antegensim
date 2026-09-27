# Category C: Movement (sweep-C)

Builders (scratchpad, not in repo): sweepC/c1.py..c4.py, skills in sweepC/cskills.py. Layouts are seed-searched offline
with world.generate_world (no runs), skills tested offline against the generated terrain with skills.run_until_action.

Shared economy for all C runs (v1): move 3 (1.8 in a skill, action_discount 0.6), observe 1-2, query 1, send 2,
broadcast 6, absorb 2; cognition 2x default (input 0.0004, output 0.002 -> ~2.5-3 per decision) so walking by hand
starves and skills pay; interrupt_on [damage]; attack 2.0 cap 50 (25 compute per 50-damage hit, 2 hits kill);
residue 80% compute / 60% essence; compute_absorption 0.5 (fruit 60 -> 30); vision 2, comm 5.
Seeded skills: goto(x,y,maxsteps) (greedy + wall-sliding side mode, 'stuck' after 10 bumps), forage(), trek(x,y),
camp(rounds); C2 raiders get ambush(rounds,strike); C3 gets circuit(x1,y1,x2,y2,x3,y3,laps).

## C1v1 Wide scatter (seed 291)
61x61, 9 mature trees (pairwise >= 17 apart), 5 camps of 4 at (+-18,+-18) and (0,2); each camp told its 2 nearest
trees (10-20 path steps; 3 trees known by two camps, 2 trees by nobody + approximate rumours for one agent per camp).
Observe 2. Start compute 150. Expect long treks by skill, map notes, contention at shared trees, deaths en route.

## C2v1 Mountain maze (seed 168)
31x31, 55 mountain clusters of 8 (~35% rock, ridges; every start connects to every valley, BFS paths 13-65).
3 strong trees (fruit every 2 rounds, max 4, seeds radius 2 every 8 rounds) = 3 valleys. 4 groups of 5 in the
corners, each told one valley + a route note (north valley told to 2 groups = 10 agents; SW group has a hard route).
One raider per group with ambush(). Same-point attacks.

## C3v1 Nomads (seed 53)
41x41, 28 trees with max_fruit 1 regrowing 15 rounds after eaten, no seeding; fruit 80 x 0.6 = 48; upkeep 3 so
camping one tree is a slow loss; standard upgrades cheap (10 compute + 1 essence, doubling); query finds a tree by
id anywhere. 8 pairs at the rim, each told its 3 nearest trees. circuit() skill. Offline test: a 3-tree circuit lap
takes ~30 turns and eats all 3 again on lap 2 -> about break-even for one agent, starvation for two on one loop.

## C4v1 Outward frontier (seed 431)
41x41, 24 agents on 6 centre points, 12 trees all >= 13 (Chebyshev) from the centre: west 2, south 3, east 4,
north 3. Each agent has one rumour (+-1) of a tree, 6 agents per direction -> west overcrowded. Seeding radius 1
every 15 rounds grows edge groves. Start compute 140. Personas include warlords and raiders.

## Log
