# Category B (Attacks): sweep notes

Generators (scratchpad, not in the repo): `sweepB/gen_b{1..4}.py` build the scenario files from shared
skills (`loot`, `hunt` from the verified Blood arena, plus new `gather` = loot for fruit and `flee`).
All runs: `interrupt_on: ["damage"]`, `query_uses_vision_range: false` (query finds anyone),
`attack_requires_same_point: false` (strike within vision), seeded skills + persona with an explicit
turn-1 instruction.

## B1 Blood arena II (B1v1)
24 Haiku + 2 Sonnet (a13 warlord, a26 bounty caller), 33x33, no food, residue 100% (compute and
essence, absorption 1.0), 250 compute, 120 health, attack 2, **attack_cap 50** (25 compute per full blow,
3 blows to kill a fresh fighter), vision 3 = strike range, upkeep 2, starvation 10. Essence 5 at
start; attack_cap +25 costs 60c + 10e (x3) so the arms race is gated by looted essence; max_health
+20 at 25c + 2e. 12 archetypes x2 (ambusher, pursuer, scavenger, brute, tactician, duelist,
berserker, assassin, traitor, pack leader, trickster, counterpuncher), each told its nearest
rival as turn-1 target. Intent: multi-blow fights with retreats and heals, deaths spread, last
survivors ~r60-80.

## B2 Two tribes (B2v1)
30 Haiku: West a01-a15 (home x=-12), East a16-a30 (home x=12), region 25x15. The only 6 trees
are in the middle ((-2,0) (-1,+-1) west, (2,0) (1,+-1) east), placed via `plants_at_agent_starts`
on the start cells of 3 wardens per tribe (listed first in the card list). Slow drip: fruit 50
every 6 rounds, absorption 0.6 (30 per fruit), max 2 fruit; seeds spread the grove slowly. 200
compute, 100 health, cap 40 (3 blows), strike range 2, comm range 10 for tribe coordination,
upkeep 1.5. Roles per tribe: 3 wardens, chief, 5 warriors, 3 gatherers, 2 scouts, medic.
Intent: raids on the grove, defence, chief orders, transfers to wounded tribemates.

## B3 Bounty rush (B3v1)
24 Haiku on 21x21 (spacing 5), 3 trees (40 compute every 10 rounds). Residue 100% but decays
30%/round (loot within 1-2 rounds). Half-price upgrades: attack and attack_cap 50c + 5e (x4),
10 starting essence (one upgrade at once), cap 40 (3 blows; 65 after one cap upgrade = 2 blows).
Upkeep 2. Archetypes: armorer, bounty hunter (targets biggest upgrades), scavenger, berserker,
duelist, turtle (max_health), opportunist, broker, glass cannon, pack hunter, vulture, assassin.
Intent: arms race and loot scrambles.

## B4 Predators and prey (B4v1)
6 predators a01-a06 (attack 3, cap 100, 160 hp, 160 compute, absorption 0.4, speed 2, strike
range 3) vs 24 prey a07-a30 in 4 corner herds of 6 (250 compute, 120 hp = 2 predator blows,
attack 1 cap 20, absorption 1.0, strike range 2). 14 trees on herd cells, fruit 40 every 5 rounds.
Residue 100%. Upkeep 2.5 (predators starve in ~40 rounds without kills; a kill is ~100 for them,
a fruit 16). Prey roles per herd: leader, sentinel, fighter, grazer, runner, wanderer; predator
roles: stalker, ambusher, pack pair (a03+a04), opportunist, apex (eats wounded predators).
Intent: hunts, herd warnings, fleeing, prey ganging up.

## Log
