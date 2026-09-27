# Sweep status before the async-turn engine rework

Snapshot 2026-09-27 05:57 UTC. Every run is parked, cut or finished; nothing was lost. Parked runs were played by the old
sequential engine up to the round shown; resuming them after the rework continues them under the new round rules.

| tag | status | round | living/agents | deaths (cause) | attack hits | kills | via-skill % | skill runs | messages | transfers | upgrades | lockout skips | cost $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A1v1 Orchard rows | finished | 80/80 | 16/16 | 0  | 0 | 0 | 98 | 25 | 0 | 0 | 0 | 63 | 0.491 |
| A1v2 Orchard rows | parked | 21/80 | 16/16 | 0  | 0 | 0 | 94 | 44 | 0 | 0 | 0 | 0 | 0.68 |
| A2v1 Expensive minds | cut | 73/100 | 12/13 | 1 {'starvation': 1} | 0 | 0 | 91 | 52 | 0 | 0 | 0 | 19 | 1.001 |
| A2v2 Expensive minds | parked | 2/100 | 13/13 | 0  | 0 | 0 | 16 | 4 | 1 | 0 | 0 | 0 | 0.325 |
| A3v1 Guild of scripts | parked | 17/70 | 20/20 | 0  | 0 | 0 | 13 | 27 | 24 | 1 | 0 | 0 | 2.529 |
| A4v1 Patrol and ambush | parked | 15/70 | 20/20 | 0  | 0 | 0 | 4 | 8 | 0 | 0 | 0 | 0 | 2.163 |
| A4v2 Patrol and ambush | parked | 5/70 | 20/20 | 0  | 0 | 0 | 35 | 27 | 0 | 0 | 0 | 0 | 0.819 |
| B1v1 Blood arena II | parked | 22/100 | 15/26 | 11 {'attack': 11} | 38 | 11 | 58 | 44 | 4 | 0 | 1 | 6 | 1.857 |
| B2v1 Two tribes | cut | 8/100 | 30/30 | 0  | 0 | 0 | 30 | 14 | 1 | 0 | 0 | 31 | 1.242 |
| B3v1 Bounty rush | parked | 24/80 | 16/24 | 8 {'attack': 8} | 29 | 8 | 61 | 33 | 1 | 0 | 9 | 26 | 1.544 |
| B4v1 Predators and prey | cut | 6/80 | 30/30 | 0  | 0 | 0 | 55 | 40 | 0 | 0 | 0 | 0 | 1.046 |
| C1v1 Wide scatter | parked | 33/80 | 20/20 | 0  | 0 | 0 | 92 | 54 | 1 | 0 | 0 | 0 | 0.876 |
| C2v1 Mountain maze | parked | 30/80 | 20/20 | 0  | 1 | 0 | 83 | 39 | 0 | 0 | 0 | 5 | 1.12 |
| C3v1 Nomads | parked | 37/100 | 16/16 | 0  | 0 | 0 | 76 | 25 | 1 | 0 | 4 | 80 | 1.252 |
| C4v1 Outward frontier | parked | 28/80 | 24/24 | 0  | 0 | 0 | 90 | 30 | 0 | 0 | 0 | 0 | 0.827 |
| D1v1 Specialists | parked | 23/80 | 20/20 | 0  | 2 | 0 | 48 | 60 | 25 | 6 | 5 | 13 | 2.474 |
| D2v1 Commons grove | parked | 24/100 | 16/16 | 0  | 1 | 0 | 52 | 77 | 7 | 0 | 0 | 0 | 2.085 |
| D3v1 Seers and walkers | parked | 21/80 | 20/20 | 0  | 0 | 0 | 35 | 34 | 29 | 1 | 0 | 2 | 2.582 |
| D4v1 The organiser | parked | 16/80 | 24/24 | 0  | 0 | 0 | 42 | 37 | 4 | 0 | 0 | 0 | 2.081 |
| E1v1 Frontier valley | cut | 7/100 | 30/30 | 0  | 0 | 0 | 81 | 24 | 2 | 0 | 0 | 27 | 0.766 |
| E1v2 Frontier valley | parked | 19/100 | 30/30 | 0  | 0 | 0 | 85 | 42 | 11 | 1 | 0 | 0 | 1.002 |
| E2v1 Famine clock | cut | 27/100 | 24/24 | 0  | 0 | 0 | 90 | 35 | 1 | 0 | 0 | 116 | 0.791 |
| E2v2 Famine clock | parked | 1/100 | 24/24 | 0  | 0 | 0 | 38 | 13 | 0 | 0 | 0 | 0 | 0.513 |
| E3v1 Three houses | cut | 5/100 | 30/30 | 0  | 0 | 0 | 54 | 18 | 2 | 0 | 0 | 23 | 0.944 |
| E3v2 Three houses | parked | 6/100 | 30/30 | 0  | 0 | 0 | 62 | 28 | 5 | 0 | 0 | 0 | 0.713 |
| E4v1 The tyrant | cut | 14/80 | 21/21 | 0  | 0 | 0 | 86 | 19 | 2 | 0 | 0 | 73 | 0.483 |
| E4v2 The tyrant | parked | 30/80 | 20/21 | 1 {'starvation': 1} | 0 | 0 | 86 | 39 | 11 | 1 | 0 | 80 | 0.957 |
| E5v1 Settlers meet wanderers | cut | 12/100 | 24/24 | 0  | 0 | 0 | 93 | 24 | 0 | 0 | 0 | 20 | 0.461 |
| E5v2 Settlers meet wanderers | parked | 27/100 | 19/24 | 5 {'starvation': 5} | 0 | 0 | 83 | 37 | 3 | 0 | 0 | 124 | 0.911 |

Registry notes per run are in `sweep/registry.json`.
