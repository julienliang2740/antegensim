#!/usr/bin/env python3
"""Candidate balanced templates (2026-09-29): built from the "Two to a Tree · baseline A (peace)" setup
(32 Haiku agents, neutral persona with the tip, new default prices) with a different world, layout or
stats.  Plants are placed through A-WORLD-7: each species' first N plants go to the first N distinct
start cells in card order, so card order decides which cells get which trees.

Usage: template_designs.py <design> <TAG> "<name>" <seed> <max_rounds> <budget_usd> <port>
Designs: hunter_gatherer, commons, four_to_a_tree, lean_years, commons_hunters (see DESIGNS).
Params (JSON, optional 8th argument): compute (every agent), hunter_absorption, rim_interval, vision, interval.
"""
import copy, json, sys, time
sys.path.insert(0, "/home/ubuntu/antegensim/sweep/tools")
import sweep as S

BASE_RUN = "run_20260929_151549_3786"  # Two to a Tree · baseline A (peace), new default prices


def tree(rules, energy=None, interval=None, max_fruit=None, name="fruit_tree"):
    """A copy of the fruit_tree species with a different mature fruit rate."""
    sp = copy.deepcopy(rules["plant_species"]["fruit_tree"])
    sp["name"] = name
    if energy is not None:
        sp["fruit_energy"] = energy
    if max_fruit is not None:
        sp["max_fruit"] = max_fruit
    if interval is not None:
        for st in sp["stages"]:
            if st["fruit_interval_rounds"]:
                st["fruit_interval_rounds"] = interval if st["name"] == "mature" else interval + 4
    return sp


def place(req, cells, per_cell):
    """Put agents on cells in card order, per_cell agents each."""
    for i, a in enumerate(req["agents"]):
        x, y = cells[i // per_cell]
        a["position"] = {"x": x, "y": y}


def hunter_gatherer(req, p):
    """Two to a Tree layout; every pair is one gatherer (good eater, harmless) and one hunter
    (poor eater, strong, tough, sees and moves further)."""
    for i, a in enumerate(req["agents"]):
        if i % 2 == 0:
            a["stats"].update({"compute_absorption": 0.8, "attack": 1.0, "health": 60.0, "max_health": 60.0})
        else:
            a["stats"].update({"compute_absorption": p.get("hunter_absorption", 0.25), "attack": 8.0, "health": 120.0,
                               "max_health": 120.0, "vision_range": 5, "speed": 2})


def commons(req, p):
    """4 incumbent pairs on rich trees at the centre, 12 pairs on lean trees on a ring 8 steps out."""
    r = req["rules"]
    centre = [(1, 0), (0, 1), (-1, 0), (0, -1)]
    rim = [(8, 0), (0, 8), (-8, 0), (0, -8), (4, 4), (-4, 4), (4, -4), (-4, -4), (6, 2), (-6, -2), (2, -6), (-2, 6)]
    place(req, centre + rim, 2)
    req["world"]["region"] = {"min_x": -10, "max_x": 10, "min_y": -10, "max_y": 10}
    r["plant_species"]["fruit_tree"] = tree(r, interval=p.get("rim_interval", 9))
    r["plant_species"]["great_tree"] = tree(r, energy=120.0, interval=3, max_fruit=4, name="great_tree")
    req["world"]["initial_plants"] = {"great_tree": 4, "fruit_tree": 16}  # great: the 4 centre cells; fruit: every cell
    for a in req["agents"]:
        a["stats"].update({"vision_range": p.get("vision", 8), "communication_range": 6})


def four_to_a_tree(req, p):
    """8 cells, 4 agents and two trees on each (the same food per agent as Two to a Tree)."""
    r = req["rules"]
    cells = [(x, y) for y in (-3, 3) for x in (-6, -2, 2, 6)]
    place(req, cells, 4)
    r["plant_species"]["twin_tree"] = tree(r, name="twin_tree")
    req["world"]["initial_plants"] = {"fruit_tree": 8, "twin_tree": 8}


def lean_years(req, p):
    """Two to a Tree layout; trees start loaded, then fruit only every 12 rounds."""
    r = req["rules"]
    r["plant_species"]["fruit_tree"] = tree(r, interval=p.get("interval", 12))
    req["world"]["initial_plant_fruit"] = 3


def commons_hunters(req, p):
    """The Commons layout with every rim pair a hunter and a gatherer (the centre pairs stay ordinary)."""
    commons(req, p)
    for i, a in enumerate(req["agents"][8:]):
        if i % 2 == 0:
            a["stats"].update({"compute_absorption": 0.8, "attack": 1.0, "health": 60.0, "max_health": 60.0})
        else:
            a["stats"].update({"compute_absorption": p.get("hunter_absorption", 0.2), "attack": 8.0, "health": 120.0,
                               "max_health": 120.0, "speed": 2})


DESIGNS = {"hunter_gatherer": hunter_gatherer, "commons": commons, "four_to_a_tree": four_to_a_tree, "lean_years": lean_years,
           "commons_hunters": commons_hunters}


def build(design, params=None):
    c, req = S.call("GET", f"/runs/{BASE_RUN}/setup", port=8000, timeout=60)
    if c != 200:
        raise SystemExit(f"setup failed {c}")
    params = params or {}
    DESIGNS[design](req, params)
    if "compute" in params:  # starting compute for every agent (pressure arrives sooner)
        for a in req["agents"]:
            a["stats"]["compute"] = float(params["compute"])
    return req


if __name__ == "__main__":
    design, tag, name, seed, rounds, budget, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), float(sys.argv[6]), int(sys.argv[7])
    params = json.loads(sys.argv[8]) if len(sys.argv) > 8 else {}
    if tag in S.read_registry()["runs"]:
        raise SystemExit(f"{tag} already registered")
    req = build(design, params)
    req.update({"name": name, "seed": seed, "max_rounds": rounds, "real_budget_usd": budget, "play_delay_seconds": 0.0, "world_id": None})
    c, v = S.call("POST", "/runs/validate", req, port=port)
    if c != 200 or (isinstance(v, dict) and v.get("ok") is False):
        raise SystemExit(f"validate failed {c}: {str(v)[:1500]}")
    c, s = S.call("POST", "/runs", req, timeout=120, port=port)
    if c != 201:
        raise SystemExit(f"create failed {c}: {str(s)[:800]}")
    rid = s["run_id"]
    S.call("POST", f"/runs/{rid}/open", port=port, timeout=120)
    c2, _ = S.call("POST", f"/runs/{rid}/commands", {"command": "play"}, port=port)
    with S.Registry() as r:
        r["runs"][tag] = {"run_id": rid, "world_id": s.get("world_id"), "name": name, "scenario": f"template design {design} {json.dumps(params)}",
                          "status": "running", "port": port, "agents": len(req["agents"]), "max_rounds": rounds,
                          "launched": time.strftime("%Y-%m-%d %H:%M:%S"), "notes": [f"design {design}, seed {seed}, params {json.dumps(params)}"]}
    print(f"launched {tag} -> {rid} on :{port} ({name}; play {c2}; warnings {s.get('warnings') or ''})")
