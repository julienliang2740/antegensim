"""
Unit tests for empyrean.world (engine/storage team).

Deterministic and fake-free: world.py needs no model.  Worlds are built with a small
all-land region (terrain clusters off) and then edited directly so every rule can be
exercised in isolation.  Numbers cite the design doc's cost examples table, the
"Important checks" paragraph of "Minimum prototype" and INTERFACES.md section 4.1.
"""

from __future__ import annotations

import copy
import json
import random

import pytest
from pydantic import TypeAdapter

from empyrean import world as W
from empyrean.config import default_rules, default_run_request
from empyrean.schemas import (
    ActionRequest,
    Agent,
    AgentCard,
    AgentStats,
    Fruit,
    Plant,
    PlaceEntityIntervention,
    PlantSpeciesRule,
    PlantStageRule,
    Point,
    Prices,
    Region,
    RemoveEntityIntervention,
    Residue,
    Seed,
    SetStatIntervention,
    TerrainGenConfig,
    UpdatePlantRulesIntervention,
    UpdatePricesIntervention,
    VoiceIntervention,
    FieldChange,
    RemovedEntity,
    WorldAction,
    WorldConfig,
    WorldState,
)

ACTION = TypeAdapter(WorldAction)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def small_config(radius: int = 3) -> WorldConfig:
    return WorldConfig(
        region=Region(min_x=-radius, max_x=radius, min_y=-radius, max_y=radius),
        terrain=TerrainGenConfig(mountain_clusters=0, water_clusters=0, keep_origin_clear_radius=0),
        initial_plants={},
        initial_plant_stage=2,
    )


def card(index: int, position=(0, 0), **stats) -> AgentCard:
    return AgentCard(
        id=f"a{index:02d}",
        name=f"Agent{index}",
        position=Point(x=position[0], y=position[1]),
        stats=AgentStats(**stats),
    )


def make_world(cards=None, radius: int = 3, seed: int = 1, rules=None) -> WorldState:
    """An all-land world at round 1 with the given cards (default: a01 and a02 at (0,0))."""
    if cards is None:
        cards = [card(1), card(2)]
    world = W.generate_world(small_config(radius), rules or default_rules(), seed, cards)
    world.round = 1
    return world


def act(world: WorldState, agent_id: str, name: str, via_skill: bool = False, **args):
    action = ACTION.validate_python({"name": name, "args": args})
    return W.apply_action(world, ActionRequest(agent_id=agent_id, action=action, via_skill=via_skill))


def add_fruit(world: WorldState, position=(0, 0), compute=100.0, plant_id=None) -> Fruit:
    fruit_id = W.new_entity_id(world, "fruit")
    fruit = Fruit(id=fruit_id, position=Point(x=position[0], y=position[1]), plant_id=plant_id, available_compute=compute)
    world.fruits[fruit_id] = fruit
    W.rebuild_occupants(world)
    return fruit


def add_residue(world: WorldState, position=(0, 0), compute=0.0, essence=0.0) -> Residue:
    residue_id = W.new_entity_id(world, "residue")
    residue = Residue(
        id=residue_id,
        position=Point(x=position[0], y=position[1]),
        source_id="a99",
        source_kind="agent",
        available_compute=compute,
        available_essence=essence,
    )
    world.residues[residue_id] = residue
    W.rebuild_occupants(world)
    return residue


def add_plant(world: WorldState, position=(0, 0), stage_index=2, essence=5.0, energy=0.0, species="fruit_tree") -> Plant:
    plant_id = W.new_entity_id(world, "plant")
    rule = world.rules.plant_species[species]
    stage = rule.stages[stage_index]
    plant = Plant(
        id=plant_id,
        position=Point(x=position[0], y=position[1]),
        species=species,
        stage_index=stage_index,
        age_rounds=stage.min_age_rounds,
        size=stage.size,
        energy=energy,
        essence=essence,
    )
    world.plants[plant_id] = plant
    W.rebuild_occupants(world)
    return plant


def events_of(outcome, kind: str):
    return [e for e in outcome.events if e.kind == kind]


# ---------------------------------------------------------------------------
# Generation and RNG
# ---------------------------------------------------------------------------


def test_generate_terrain_is_seeded_and_complete():
    config = default_run_request().world
    a = W.generate_terrain(config, random.Random(7))
    b = W.generate_terrain(config, random.Random(7))
    c = W.generate_terrain(config, random.Random(8))
    assert a.cells == b.cells
    assert a.cells != c.cells
    assert len(a.cells) == 21 * 21
    assert a.occupants == {}
    assert set(a.cells.values()) <= {"land", "mountain", "water"}
    assert "mountain" in a.cells.values() and "water" in a.cells.values()
    origin = Point(x=0, y=0)
    for key, terrain in a.cells.items():
        x, y = (int(v) for v in key.split(","))
        if Point(x=x, y=y).manhattan(origin) <= config.terrain.keep_origin_clear_radius:
            assert terrain == "land"


def test_generate_world_is_reproducible_and_places_plants_on_land():
    request = default_run_request()
    w1 = W.generate_world(request.world, default_rules(), request.seed, request.agents)
    w2 = W.generate_world(request.world, default_rules(), request.seed, request.agents)
    assert w1.map.cells == w2.map.cells
    assert w1.rng_state == w2.rng_state
    assert [p.position for p in w1.plants.values()] == [p.position for p in w2.plants.values()]
    assert len(w1.plants) == 12 and list(w1.plants)[0] == "p0001"
    for plant in w1.plants.values():
        assert W.terrain_at(w1, plant.position) == "land"
        assert plant.stage_index == 2 and plant.age_rounds == 15
        assert plant.essence == 5.0 and plant.energy == 0.0
    assert list(w1.agents) == [c.id for c in request.agents]
    assert w1.round == 0
    assert w1.map.occupants["0,0"] and "a01" in w1.map.occupants["0,0"]
    assert W.validate_world(w1) == []
    # different seed -> different world
    w3 = W.generate_world(request.world, default_rules(), 2, request.agents)
    assert w3.map.cells != w1.map.cells


def test_generate_world_places_plants_at_agent_starts_with_initial_fruit():
    """A-WORLD-7 / A-PLANT-13: with the defaults the first plants of a species sit on the
    agents' distinct start cells (card order) and every initial plant carries one ripe,
    source-funded fruit; both options can be switched off."""
    request = default_run_request()
    assert request.world.plants_at_agent_starts is True and request.world.initial_plant_fruit == 1
    world = W.generate_world(request.world, default_rules(), request.seed, request.agents)
    plants = list(world.plants.values())
    starts = [c.position for c in request.agents]
    assert [(p.position.x, p.position.y) for p in plants[: len(starts)]] == [(s.x, s.y) for s in starts]
    assert len(plants) == 12 and len(world.fruits) == 12
    rule = default_rules().plant_species["fruit_tree"]
    for plant in plants:
        assert len(plant.fruit_ids) == 1 and plant.total_fruit_produced == 1 and plant.rounds_since_fruit == 0
        fruit = world.fruits[plant.fruit_ids[0]]
        assert fruit.plant_id == plant.id and fruit.position == plant.position
        assert fruit.available_compute == rule.fruit_energy and fruit.available_essence == 0.0 and fruit.created_round == 0
        assert plant.energy == 0.0 and plant.total_source_energy == rule.fruit_energy  # the source funded it
    assert W.validate_world(world) == []
    # the observe result at an agent's start cell lists its plant and fruit (vision 0 suffices)
    key = f"{starts[0].x},{starts[0].y}"
    assert {world.plants[p].id for p in world.map.occupants[key] if p in world.plants} == {plants[0].id}
    assert plants[0].fruit_ids[0] in world.map.occupants[key]

    # duplicate start cells count once; more plants than cells fall back to uniform placement
    cards = [card(1), card(2), card(3, (1, 0))]
    cfg = small_config()
    cfg.initial_plants = {"fruit_tree": 4}
    cfg.initial_plant_fruit = 5  # capped by max_fruit (3)
    world = W.generate_world(cfg, default_rules(), 7, cards)
    positions = [(p.position.x, p.position.y) for p in world.plants.values()]
    assert positions[:2] == [(0, 0), (1, 0)]
    assert all(len(p.fruit_ids) == rule.max_fruit for p in world.plants.values())

    # switched off: uniform placement and no fruit, exactly as before
    cfg.plants_at_agent_starts = False
    cfg.initial_plant_fruit = 0
    world_off = W.generate_world(cfg, default_rules(), 7, cards)
    assert world_off.fruits == {} and all(p.total_fruit_produced == 0 for p in world_off.plants.values())
    rng = __import__("random").Random(7)
    W.generate_terrain(cfg, rng)  # same draw order: terrain, then every plant
    land = W._land_cells(world_off)
    assert [(p.position.x, p.position.y) for p in world_off.plants.values()] == [(c.x, c.y) for c in (rng.choice(land) for _ in range(4))]


def test_generate_world_rejects_unknown_species():
    config = small_config()
    config.initial_plants = {"cactus": 1}
    with pytest.raises(W.WorldError):
        W.generate_world(config, default_rules(), 1, [card(1), card(2)])


def test_card_on_mountain_is_moved_with_warning_and_ids_are_assigned():
    request = default_run_request()
    world = W.generate_world(request.world, default_rules(), request.seed, request.agents)
    mountain = next(k for k, t in world.map.cells.items() if t == "mountain")
    x, y = (int(v) for v in mountain.split(","))
    cards = [card(1, (x, y)), AgentCard(name="NoId", position=Point(x=0, y=0)), card(3)]
    world = W.generate_world(request.world, default_rules(), request.seed, cards)
    assert W.terrain_at(world, world.agents["a01"].position) == "land"
    warnings = W.world_warnings(world)
    assert len(warnings) == 1 and "a01" in warnings[0] and "mountain" in warnings[0]
    # Warnings live on WorldState.warnings: reading is idempotent and a copy keeps them.
    assert W.world_warnings(world) == warnings
    assert W.world_warnings(world.model_copy(deep=True)) == warnings
    assert "a02" in world.agents and world.agents["a02"].name == "NoId"
    assert world.next_entity_seq["agent"] == 4


def test_new_entity_id_never_reuses_ids():
    world = make_world()
    f1 = W.new_entity_id(world, "fruit")
    assert f1 == "f0001"
    world.removed["f0002"] = RemovedEntity(id="f0002", kind="fruit", position=Point(x=0, y=0), round=1, reason="consumed")
    assert W.new_entity_id(world, "fruit") == "f0003"
    assert W.new_entity_id(world, "residue") == "res0001"
    assert W.new_entity_id(world, "agent") == "a03"
    with pytest.raises(W.WorldError):
        W.new_entity_id(world, "rock")


def test_rng_state_round_trip():
    world = make_world()
    rng = W.get_rng(world)
    expected = [rng.random() for _ in range(3)]
    rng2 = W.get_rng(world)
    assert [rng2.random() for _ in range(3)] == expected
    W.save_rng(world, rng2)
    assert W.get_rng(world).random() == rng2.random()
    json.loads(world.rng_state)


def test_initiative_sorts_by_speed_with_seeded_tie_break():
    cards = [card(1, speed=1), card(2, speed=3), card(3, speed=1), card(4, speed=2), card(5, speed=1)]
    world = make_world(cards)
    before = world.rng_state
    order = W.compute_initiative(world)
    assert order[0] == "a02" and order[1] == "a04"
    assert set(order[2:]) == {"a01", "a03", "a05"}
    assert world.rng_state != before  # the run RNG advanced
    # the same state yields the same order; a dead agent is excluded
    twin = copy.deepcopy(world)
    twin.rng_state = before
    assert W.compute_initiative(twin) == order
    W.kill_agent(world, "a04", "operator")
    assert "a04" not in W.compute_initiative(world)


# ---------------------------------------------------------------------------
# Lookups
# ---------------------------------------------------------------------------


def test_entities_at_order_and_living_only():
    world = make_world()
    plant = add_plant(world)
    fruit = add_fruit(world)
    residue = add_residue(world, compute=1.0)
    ids = [e.id for e in W.entities_at(world, Point(x=0, y=0))]
    assert ids == ["a01", "a02", plant.id, fruit.id, residue.id]
    world.agents["a02"].stats.compute = 0
    world.agents["a02"].stats.essence = 0
    W.kill_agent(world, "a02", "operator")
    assert [e.id for e in W.entities_at(world, Point(x=0, y=0))] == ["a01", plant.id, fruit.id, residue.id]
    assert "a02" in [e.id for e in W.entities_at(world, Point(x=0, y=0), living_only=False)]
    assert "a02" in world.map.occupants["0,0"]


def test_visible_target_respects_vision_and_death():
    world = make_world([card(1, vision_range=1), card(2, (0, 1)), card(3, (0, 2))])
    a01 = world.agents["a01"]
    assert W.visible_target(world, a01, "a02") is not None
    assert W.visible_target(world, a01, "a03") is None
    assert W.visible_target(world, a01, "zzz") is None
    W.kill_agent(world, "a02", "operator")
    assert W.visible_target(world, a01, "a02") is None
    assert W.find_entity(world, "a02") is not None


def test_message_tokens_uses_chars_per_token():
    rules = default_rules()
    assert W.message_tokens(rules, "") == 0
    assert W.message_tokens(rules, "abcd") == 1
    assert W.message_tokens(rules, "abcde") == 2


# ---------------------------------------------------------------------------
# Cost examples table (design "Saved skill compute discount")
# ---------------------------------------------------------------------------


def test_five_moves_cost_25_direct_and_20_in_a_skill():
    world = make_world([card(1, (-3, -3)), card(2, (-3, -2))])
    for direction in ("up", "right", "up", "right", "up"):
        assert act(world, "a01", "move", direction=direction).result.ok
        assert act(world, "a02", "move", via_skill=True, direction=direction).result.ok
    assert world.agents["a01"].stats.compute == pytest.approx(175)
    assert world.agents["a02"].stats.compute == pytest.approx(180)
    assert world.agents["a01"].total_compute_spent == pytest.approx(25)
    assert world.agents["a02"].total_compute_spent == pytest.approx(20)


def test_first_upgrade_costs_25_plus_2_direct_and_20_plus_2_in_a_skill():
    world = make_world()
    direct = act(world, "a01", "upgrade", attribute="vision_range")
    skill = act(world, "a02", "upgrade", via_skill=True, attribute="vision_range")
    assert direct.result.ok and skill.result.ok
    assert (direct.result.cost_compute, direct.result.cost_essence) == (25, 2)
    assert (skill.result.cost_compute, skill.result.cost_essence) == (20, 2)
    assert world.agents["a01"].stats.compute == 175 and world.agents["a01"].stats.essence == 18
    assert world.agents["a02"].stats.compute == 180 and world.agents["a02"].stats.essence == 18
    assert world.agents["a01"].stats.vision_range == 1 and isinstance(world.agents["a01"].stats.vision_range, int)
    assert direct.result.data == {"attribute": "vision_range", "new_value": 1, "purchase_count": 1}
    assert direct.result.effects["purchased"] == "vision_range"


def test_attack_budget_10_charges_10_or_8_and_deals_10_damage():
    world = make_world([card(1), card(2), card(3)])
    direct = act(world, "a01", "attack", target="a03", compute_budget=10)
    skill = act(world, "a02", "attack", via_skill=True, target="a03", compute_budget=10)
    assert direct.result.cost_compute == 10 and skill.result.cost_compute == 8
    assert direct.result.effects["damage"] == 10 and skill.result.effects["damage"] == 10
    assert world.agents["a03"].stats.health == 80
    assert direct.result.effects == {"damage": 10, "target": "a03", "target_health_after": 90, "killed": False}
    assert len(events_of(direct, "damage")) == 1
    notice = direct.notices[0]
    assert notice.agent_id == "a03" and notice.kind == "damage"
    assert notice.content == {"amount": 10, "attacker": "a01", "health_after": 90, "cause": "attack"}


def test_recover_10_missing_health_charges_10_or_8_and_heals_10():
    world = make_world([card(1, health=90), card(2, health=90), card(3)])
    direct = act(world, "a01", "recover", compute_budget=10)
    skill = act(world, "a02", "recover", via_skill=True, compute_budget=10)
    assert direct.result.cost_compute == 10 and skill.result.cost_compute == 8
    assert direct.result.effects == {"healed": 10, "health": 100}
    assert skill.result.effects == {"healed": 10, "health": 100}
    # a bigger budget only charges the useful amount; full health is a free no-op
    world.agents["a01"].stats.health = 95
    big = act(world, "a01", "recover", compute_budget=50)
    assert big.result.ok and big.result.cost_compute == 5 and world.agents["a01"].stats.health == 100
    full = act(world, "a03", "recover", compute_budget=10)
    assert full.result.ok and full.result.cost_compute == 0 and full.result.effects["healed"] == 0


# ---------------------------------------------------------------------------
# Failure handling ("Important checks": failed moves do not move)
# ---------------------------------------------------------------------------


def test_failed_move_into_mountain_charges_attempt_fee_and_keeps_position():
    world = make_world()
    world.map.cells["0,1"] = "mountain"
    direct = act(world, "a01", "move", direction="up")
    skill = act(world, "a02", "move", via_skill=True, direction="up")
    assert direct.result.reason == "blocked" and not direct.result.ok
    assert skill.result.reason == "blocked"
    assert direct.result.cost_compute == 1 and skill.result.cost_compute == pytest.approx(0.8)
    assert world.agents["a01"].position == Point(x=0, y=0)
    assert world.agents["a02"].position == Point(x=0, y=0)
    assert world.agents["a01"].stats.compute == 199
    assert world.agents["a02"].stats.compute == pytest.approx(199.2)
    assert world.agents["a01"].last_action == {"name": "move", "args": {"direction": "up"}}
    assert world.agents["a01"].last_result.reason == "blocked"
    assert direct.events[0].kind == "action" and "blocked" in direct.events[0].summary


def test_move_outside_region_is_blocked_and_water_is_passable():
    world = make_world([card(1, (3, 3)), card(2)])
    out = act(world, "a01", "move", direction="up")
    assert out.result.reason == "blocked" and world.agents["a01"].position == Point(x=3, y=3)
    world.map.cells["0,1"] = "water"
    over = act(world, "a02", "move", direction="up")
    assert over.result.ok and over.result.cost_compute == 5
    assert world.agents["a02"].position == Point(x=0, y=1)
    assert over.result.effects == {"from": {"x": 0, "y": 0}, "to": {"x": 0, "y": 1}}


def test_insufficient_funds_charges_nothing():
    world = make_world([card(1, compute=3), card(2, compute=3.9)])
    out = act(world, "a01", "move", direction="up")
    assert out.result.reason == "insufficient_compute" and out.result.cost_compute == 0
    assert world.agents["a01"].stats.compute == 3 and world.agents["a01"].position == Point(x=0, y=0)
    # a skill move costs 4: 3.9 is not enough either, and nothing is debited
    out = act(world, "a02", "move", via_skill=True, direction="up")
    assert out.result.reason == "insufficient_compute" and world.agents["a02"].stats.compute == 3.9
    # a balance equal to the price pays
    world.agents["a02"].stats.compute = 4.0
    assert act(world, "a02", "move", via_skill=True, direction="up").result.ok
    assert world.agents["a02"].stats.compute == 0


def test_dead_actor_gets_dead_without_charge():
    world = make_world()
    W.kill_agent(world, "a01", "operator")
    out = act(world, "a01", "move", direction="up")
    assert out.result.reason == "dead" and out.result.cost_compute == 0
    assert world.agents["a01"].stats.compute == 0


def test_unknown_actor_is_a_programming_error():
    world = make_world()
    with pytest.raises(W.WorldError):
        act(world, "zz", "move", direction="up")


# ---------------------------------------------------------------------------
# Absorption (design "Absorption efficiency")
# ---------------------------------------------------------------------------


def test_absorb_100_compute_at_20_percent_gains_20_destroys_80_costs_3():
    world = make_world()
    fruit = add_fruit(world, compute=100)
    out = act(world, "a01", "absorb", source=fruit.id, resource="compute")
    assert out.result.ok and out.result.cost_compute == 3
    assert out.result.effects == {"processed": 100, "gained": 20, "lost": 80, "source": fruit.id, "resource": "compute"}
    assert world.agents["a01"].stats.compute == pytest.approx(217)
    assert fruit.available_compute == 0
    # "absorption losses cannot be recovered by retrying"
    again = act(world, "a02", "absorb", source=fruit.id, resource="compute")
    assert again.result.reason == "empty_source" and again.result.cost_compute == 1
    assert world.agents["a02"].stats.compute == 199
    # the skill charge is 2.4
    fruit2 = add_fruit(world, compute=10)
    skill = act(world, "a02", "absorb", via_skill=True, source=fruit2.id, resource="compute")
    assert skill.result.cost_compute == pytest.approx(2.4) and skill.result.effects["gained"] == pytest.approx(2)


def test_essence_absorption_is_limited_by_capacity_and_leaves_residue():
    world = make_world([card(1, essence=95, essence_capacity=100), card(2, essence=100, essence_capacity=100)])
    residue = add_residue(world, essence=100)
    out = act(world, "a01", "absorb", source=residue.id, resource="essence")
    assert out.result.ok
    assert out.result.effects["processed"] == pytest.approx(50)
    assert out.result.effects["gained"] == pytest.approx(5)
    assert out.result.effects["lost"] == pytest.approx(45)
    assert world.agents["a01"].stats.essence == pytest.approx(100)
    assert residue.available_essence == pytest.approx(50)
    # no free capacity: fail rather than destroy for zero gain (attempt fee only)
    full = act(world, "a02", "absorb", source=residue.id, resource="essence")
    assert full.result.reason == "at_limit" and full.result.cost_compute == 1
    assert residue.available_essence == pytest.approx(50)
    # fruit never yields essence
    fruit = add_fruit(world, compute=10)
    none = act(world, "a01", "absorb", source=fruit.id, resource="essence")
    assert none.result.reason == "empty_source"


def test_absorb_target_rules():
    world = make_world([card(1, vision_range=1), card(2)])
    far = add_fruit(world, position=(0, 1), compute=10)
    hidden = add_fruit(world, position=(0, 3), compute=10)
    assert act(world, "a01", "absorb", source=hidden.id, resource="compute").result.reason == "target_gone"
    assert act(world, "a01", "absorb", source=far.id, resource="compute").result.reason == "out_of_range"
    assert act(world, "a01", "absorb", source="a02", resource="compute").result.reason == "invalid_argument"
    assert far.available_compute == 10 and hidden.available_compute == 10


# ---------------------------------------------------------------------------
# Transfer
# ---------------------------------------------------------------------------


def test_skill_transfer_of_10_compute_charges_only_the_fee():
    world = make_world()
    out = act(world, "a01", "transfer", via_skill=True, recipient="a02", resource="compute", amount=10)
    assert out.result.ok and out.result.cost_compute == pytest.approx(0.8)
    assert world.agents["a01"].stats.compute == pytest.approx(200 - 10.8)
    assert world.agents["a02"].stats.compute == pytest.approx(210)
    assert out.result.effects == {"transferred": 10, "resource": "compute", "to": "a02"}
    assert world.agents["a01"].total_compute_spent == pytest.approx(0.8)
    assert out.events[0].costs.compute == pytest.approx(0.8)
    notice = out.notices[0]
    assert notice.agent_id == "a02" and notice.kind == "system"
    assert notice.content["amount"] == 10 and notice.content["resource"] == "compute" and notice.content["from"] == "a01"
    assert "received 10 compute from a01" in notice.text


def test_transfer_never_partial_and_checks_recipient():
    world = make_world([card(1, compute=10.5), card(2), card(3, (0, 1)), card(4, essence=95)])
    # amount + fee unaffordable -> nothing moves
    out = act(world, "a01", "transfer", recipient="a02", resource="compute", amount=10)
    assert out.result.reason == "insufficient_compute" and out.result.cost_compute == 0
    assert world.agents["a01"].stats.compute == 10.5 and world.agents["a02"].stats.compute == 200
    # essence recipient without capacity -> at_limit, fee only, no partial
    out = act(world, "a02", "transfer", recipient="a04", resource="essence", amount=10)
    assert out.result.reason == "at_limit" and out.result.cost_compute == 1
    assert world.agents["a04"].stats.essence == 95 and world.agents["a02"].stats.essence == 20
    # not at the same point (visible at distance 1) -> out_of_range; unseen -> target_gone
    world.agents["a02"].stats.vision_range = 1
    assert act(world, "a02", "transfer", recipient="a03", resource="compute", amount=1).result.reason == "out_of_range"
    world.agents["a02"].stats.vision_range = 0
    assert act(world, "a02", "transfer", recipient="a03", resource="compute", amount=1).result.reason == "target_gone"
    assert act(world, "a02", "transfer", recipient="a02", resource="compute", amount=1).result.reason == "invalid_argument"
    # essence transfer moves essence, the fee is compute
    ok = act(world, "a02", "transfer", recipient="a04", resource="essence", amount=5)
    assert ok.result.ok and ok.result.cost_compute == 1 and ok.result.cost_essence == 0
    assert world.agents["a04"].stats.essence == 100 and world.agents["a02"].stats.essence == 15


def test_transfer_notice_hides_an_unseen_sender():
    world = make_world([card(1, vision_range=0), card(2, vision_range=0)])
    world.rules.ranges.transfer_requires_same_point = False
    world.agents["a01"].stats.vision_range = 2
    world.agents["a02"].position = Point(x=0, y=2)
    out = act(world, "a01", "transfer", recipient="a02", resource="compute", amount=5)
    assert out.result.ok
    assert out.notices[0].content["from"] is None and "unknown" in out.notices[0].text


# ---------------------------------------------------------------------------
# Upgrades ("failed upgrades do not change stats"; "raising caps does not fill them")
# ---------------------------------------------------------------------------


def test_upgrade_at_limit_charges_only_the_fee_or_nothing():
    world = make_world([card(1, compute_absorption=1.0), card(2, compute_absorption=1.0, compute=0.5)])
    quotes = W.upgrade_quotes(world, world.agents["a01"], via_skill=False)
    q = quotes["compute_absorption"]
    assert q["allowed"] is False and q["next_value"] == 1.0 and q["compute"] == 25 and q["essence"] == 2
    out = act(world, "a01", "upgrade", attribute="compute_absorption")
    assert out.result.reason == "at_limit" and out.result.cost_compute == 1 and out.result.cost_essence == 0
    assert world.agents["a01"].stats.compute_absorption == 1.0 and world.agents["a01"].stats.compute == 199
    assert world.agents["a01"].upgrade_counts == {}
    poor = act(world, "a02", "upgrade", attribute="compute_absorption")
    assert poor.result.reason == "insufficient_compute" and poor.result.cost_compute == 0
    assert world.agents["a02"].stats.compute == 0.5
    skill = act(world, "a01", "upgrade", via_skill=True, attribute="compute_absorption")
    assert skill.result.reason == "at_limit" and skill.result.cost_compute == pytest.approx(0.8)


def test_failed_upgrade_leaves_stats_unchanged():
    world = make_world([card(1, essence=1), card(2, compute=10)])
    out = act(world, "a01", "upgrade", attribute="max_health")
    assert out.result.reason == "insufficient_essence" and out.result.cost_compute == 0
    assert world.agents["a01"].stats.max_health == 100 and world.agents["a01"].stats.essence == 1
    out = act(world, "a02", "upgrade", attribute="max_health")
    assert out.result.reason == "insufficient_compute" and world.agents["a02"].stats.compute == 10


def test_raising_caps_does_not_fill_them_and_prices_double():
    world = make_world([card(1, compute=1000, essence=50, health=60), card(2)])
    a01 = world.agents["a01"]
    out = act(world, "a01", "upgrade", attribute="essence_capacity")
    assert out.result.ok and a01.stats.essence_capacity == 120 and a01.stats.essence == 48
    out = act(world, "a01", "upgrade", attribute="max_health")
    assert a01.stats.max_health == 120 and a01.stats.health == 60
    second = act(world, "a01", "upgrade", attribute="essence_capacity")
    assert second.result.cost_compute == 50 and second.result.cost_essence == 4
    assert a01.upgrade_counts["essence_capacity"] == 2
    quotes = W.upgrade_quotes(world, a01, via_skill=True)
    assert quotes["essence_capacity"]["base_compute"] == 100 and quotes["essence_capacity"]["compute"] == 80
    assert quotes["max_health"]["compute"] == 40 and quotes["max_health"]["skill_compute"] == 40
    assert quotes["attack"] == {
        "base_compute": 100,
        "skill_compute": 80,
        "compute": 80,
        "essence": 10,
        "next_value": 1.25,
        "allowed": True,
    }


def test_absorption_upgrade_adds_percentage_points_and_caps():
    world = make_world([card(1, compute=100000, essence=100, essence_capacity=100), card(2)])
    a01 = world.agents["a01"]
    out = act(world, "a01", "upgrade", attribute="compute_absorption")
    assert out.result.data["new_value"] == 0.25 and a01.stats.compute_absorption == 0.25
    a01.stats.compute_absorption = 0.98
    a01.stats.essence = 100
    out = act(world, "a01", "upgrade", attribute="compute_absorption")
    assert out.result.ok and a01.stats.compute_absorption == 1.0
    assert act(world, "a01", "upgrade", attribute="compute_absorption").result.reason == "at_limit"


def test_integer_stats_stay_integers_after_upgrade():
    world = make_world([card(1, compute=1000, essence=50), card(2)])
    for attribute in ("speed", "communication_range", "skill_count_limit", "skill_block_limit"):
        out = act(world, "a01", "upgrade", attribute=attribute)
        assert out.result.ok
        assert isinstance(getattr(world.agents["a01"].stats, attribute), int)
    assert world.agents["a01"].stats.skill_block_limit == 120


# ---------------------------------------------------------------------------
# Observe and query ("queries respect visibility"; "prices are visible to the caller")
# ---------------------------------------------------------------------------


def test_observe_pagination():
    world = make_world()
    for _ in range(45):
        add_fruit(world, compute=1)
    page0 = act(world, "a01", "observe", point=[0, 0])
    assert page0.result.ok and page0.result.cost_compute == 1
    data = page0.result.data
    assert data["page"] == 0 and data["page_size"] == 40 and data["total_entities"] == 47
    assert len(data["entities"]) == 40 and data["has_more"] is True
    assert data["entities"][0] == {"id": "a01", "kind": "agent", "position": {"x": 0, "y": 0}}
    assert data["terrain"] == "land" and data["observed_round"] == 1 and data["point"] == {"x": 0, "y": 0}
    page1 = act(world, "a01", "observe", point={"x": 0, "y": 0}, page=1).result.data
    assert len(page1["entities"]) == 7 and page1["has_more"] is False
    page9 = act(world, "a01", "observe", point={"x": 0, "y": 0}, page=9).result
    assert page9.ok and page9.data["entities"] == [] and page9.data["has_more"] is False
    assert page9.effects == {}


def test_observe_range_and_outside_region():
    world = make_world([card(1, vision_range=1), card(2, (0, 2))])
    out = act(world, "a01", "observe", point={"x": 0, "y": 2})
    assert out.result.reason == "out_of_range" and out.result.cost_compute == 1
    # the region edge: within vision but outside -> ok, terrain null, no entities
    world.agents["a01"].position = Point(x=3, y=3)
    edge = act(world, "a01", "observe", point={"x": 4, "y": 3})
    assert edge.result.ok and edge.result.data["terrain"] is None and edge.result.data["entities"] == []
    # dead agents are not listed
    world.agents["a01"].position = Point(x=0, y=2)
    W.kill_agent(world, "a02", "operator")
    listing = act(world, "a01", "observe", point={"x": 0, "y": 2}).result.data["entities"]
    assert [e["id"] for e in listing] == ["a01", "res0001"]


def test_query_self_exposes_prices_quotes_and_post_payment_balances():
    world = make_world()
    out = act(world, "a01", "query", entity="self")
    data = out.result.data
    assert out.result.ok and out.result.cost_compute == 1
    assert data["compute"] == 199 and data["essence"] == 20 and data["position"] == {"x": 0, "y": 0}
    assert data["quote_mode"] == "direct" and data["round"] == 1
    assert data["costs"]["normal"]["move"] == 5 and data["costs"]["skill"]["move"] == 4
    assert data["costs"]["discount"] == 0.8 and data["costs"]["upkeep_per_round"] == 1
    assert data["costs"]["recovery_health_per_compute"] == 1 and data["costs"]["interpreter_cost_per_op"] == 0.01
    assert data["costs"]["failure_fee_cap"] == 1 and data["costs"]["max_ops_per_turn"] == 100
    assert data["costs"]["cognition"] == {"input_rate": 0.0002, "generation_rate": 0.001}
    assert data["upgrade_quotes"]["vision_range"]["compute"] == 25
    # using the caller's own id is a self-query too, and a skill query quotes skill prices
    own = act(world, "a01", "query", via_skill=True, entity="a01").result.data
    assert own["quote_mode"] == "skill" and own["upgrade_quotes"]["vision_range"]["compute"] == 20
    assert own["upgrade_quotes"]["vision_range"]["essence"] == 2
    assert own["compute"] == pytest.approx(198.2)
    for key in (
        "health", "max_health", "essence_capacity", "attack", "speed", "vision_range", "communication_range",
        "compute_absorption", "essence_absorption", "skill_count_limit", "skill_block_limit",
    ):
        assert key in own


def test_query_respects_visibility_and_returns_public_data_only():
    world = make_world([card(1, vision_range=1), card(2, (0, 1)), card(3, (0, 2))])
    hidden = act(world, "a01", "query", entity="a03")
    assert hidden.result.reason == "target_gone" and hidden.result.cost_compute == 1
    unknown = act(world, "a01", "query", entity="nope")
    assert unknown.result.reason == "target_gone"
    seen = act(world, "a01", "query", entity="a02")
    assert seen.result.ok
    data = seen.result.data
    assert data["id"] == "a02" and data["kind"] == "agent" and data["alive"] is True
    assert data["position"] == {"x": 0, "y": 1} and data["health"] == 100 and data["speed"] == 1
    assert "compute" not in data and "essence" not in data and "skills" not in data
    assert data["round"] == 1
    # fruit / residue / plant / seed shapes
    fruit = add_fruit(world, position=(0, 1), compute=10)
    fq = act(world, "a01", "query", entity=fruit.id).result.data
    assert fq["can_absorb_compute"] is True and fq["can_absorb_essence"] is False and fq["available_compute"] == 10
    residue = add_residue(world, position=(0, 1), compute=0, essence=3)
    rq = act(world, "a01", "query", entity=residue.id).result.data
    assert rq["can_absorb_compute"] is False and rq["can_absorb_essence"] is True
    plant = add_plant(world, position=(0, 1), essence=7)
    plant.fruit_ids = [fruit.id]
    plant.seed_ids = ["s0999"]
    pq = act(world, "a01", "query", entity=plant.id).result.data
    assert pq["stage_name"] == "mature" and pq["vitality"] == 7 and pq["fruit_ids"] == [fruit.id] and pq["seed_ids"] == []
    seed_id = W.new_entity_id(world, "seed")
    world.seeds[seed_id] = Seed(id=seed_id, position=Point(x=0, y=1), species="fruit_tree", germinates_round=5)
    sq = act(world, "a01", "query", entity=seed_id).result.data
    assert sq == {"id": seed_id, "kind": "seed", "position": {"x": 0, "y": 1}, "round": 1, "species": "fruit_tree"}


# ---------------------------------------------------------------------------
# Messaging (design "Coordinates vision and communication")
# ---------------------------------------------------------------------------


def test_send_delivers_from_unknown_source_when_recipient_cannot_see_sender():
    world = make_world([card(1, vision_range=1, communication_range=1), card(2, (0, 1))])
    out = act(world, "a01", "send", recipient="a02", message="hello there")
    assert out.result.ok and out.result.cost_compute == 3
    assert out.result.data == {"delivered_to": "a02"} and out.result.effects == {"delivered": 1}
    notice = out.notices[0]
    assert notice.agent_id == "a02" and notice.kind == "message"
    assert notice.content == {"text": "hello there", "sender": None, "sender_visible": False, "broadcast": False}
    assert notice.provenance.source == "unknown" and notice.provenance.sender_visible is False
    delivered = events_of(out, "message_delivered")[0]
    assert delivered.details == {"recipients": ["a02"], "broadcast": False, "sender_visible_to": {"a02": False}}
    # once the recipient can see the sender the id is disclosed
    world.agents["a02"].stats.vision_range = 1
    out = act(world, "a01", "send", recipient="a02", message="again")
    assert out.notices[0].content["sender"] == "a01" and out.notices[0].provenance.source == "agent:a01"


def test_send_failure_reasons():
    world = make_world([card(1, vision_range=2, communication_range=1), card(2, (0, 2)), card(3, (0, 3))])
    assert act(world, "a01", "send", recipient="a02", message="x").result.reason == "out_of_range"
    assert act(world, "a01", "send", recipient="a03", message="x").result.reason == "target_gone"
    assert act(world, "a01", "send", recipient="a01", message="x").result.reason == "invalid_argument"
    empty = act(world, "a01", "send", recipient="a02", message="   ")
    assert empty.result.reason == "invalid_argument" and empty.result.cost_compute == 1
    world.agents["a02"].position = Point(x=0, y=1)
    too_long = act(world, "a01", "send", recipient="a02", message="x" * (256 * 4 + 1))
    assert too_long.result.reason == "invalid_argument"
    assert act(world, "a01", "send", recipient="a02", message="x" * (256 * 4)).result.ok
    fruit = add_fruit(world, position=(0, 1))
    assert act(world, "a01", "send", recipient=fruit.id, message="x").result.reason == "invalid_argument"


def test_broadcast_fan_out_within_communication_range():
    world = make_world([card(1, vision_range=1, communication_range=2), card(2, (0, 1)), card(3, (2, 0)), card(4, (0, 3))])
    out = act(world, "a01", "broadcast", message="all hands")
    assert out.result.ok and out.result.cost_compute == 7
    assert sorted(n.agent_id for n in out.notices) == ["a02", "a03"]
    assert out.result.data == {"delivered_to_visible": ["a02"]} and out.result.effects == {"delivered_visible": 1}
    by_id = {n.agent_id: n for n in out.notices}
    assert by_id["a02"].content["broadcast"] is True and by_id["a02"].content["sender"] is None
    delivered = events_of(out, "message_delivered")[0]
    assert delivered.details["recipients"] == ["a02", "a03"] and delivered.details["broadcast"] is True
    # nobody in range still succeeds and charges the full price (A-ACT-12)
    world.agents["a01"].position = Point(x=-3, y=-3)
    alone = act(world, "a01", "broadcast", message="anyone?")
    assert alone.result.ok and alone.result.cost_compute == 7 and alone.notices == []
    assert alone.result.data == {"delivered_to_visible": []}
    # dead agents never receive
    world.agents["a01"].position = Point(x=0, y=0)
    W.kill_agent(world, "a02", "operator")
    assert sorted(n.agent_id for n in act(world, "a01", "broadcast", message="x").notices) == ["a03"]


# ---------------------------------------------------------------------------
# Attack, death and residue
# ---------------------------------------------------------------------------


def test_lethal_attack_resolves_death_once_with_residue():
    world = make_world([card(1, attack=2.0), card(2, health=20, compute=50, essence=20)])
    out = act(world, "a01", "attack", target="a02", compute_budget=10)
    assert out.result.ok and out.result.cost_compute == 10
    assert out.result.effects == {"damage": 20, "target": "a02", "target_health_after": 0, "killed": True}
    victim = world.agents["a02"]
    assert victim.alive is False and victim.stats.health == 0 and victim.stats.compute == 0 and victim.stats.essence == 0
    assert victim.died_round == 1 and victim.death_cause == "attack"
    assert out.deaths == ["a02"]
    death = events_of(out, "death")[0]
    assert death.details["entity_id"] == "a02" and death.details["cause"] == "attack" and death.details["residue_id"] == "res0001"
    residue = world.residues["res0001"]
    assert residue.available_compute == pytest.approx(25) and residue.available_essence == pytest.approx(8)
    assert residue.source_id == "a02" and residue.position == Point(x=0, y=0)
    created = events_of(out, "residue_created")[0]
    assert created.details["compute"] == pytest.approx(25) and created.details["essence"] == pytest.approx(8)
    assert [n.kind for n in out.notices] == ["damage"]
    assert out.notices[0].content["health_after"] == 0 and out.notices[0].content["attacker"] == "a01"
    # a subsequent attack against the dead target fails with target_gone and the fee
    again = act(world, "a01", "attack", target="a02", compute_budget=10)
    assert again.result.reason == "target_gone" and again.result.cost_compute == 1
    assert "a02" in world.map.occupants["0,0"]


def test_death_without_remains_has_no_residue():
    world = make_world([card(1), card(2, compute=0, essence=0)])
    out = W.kill_agent(world, "a02", "operator")
    assert events_of(out, "death")[0].details["residue_id"] is None and world.residues == {}
    assert W.kill_agent(world, "a02", "operator").events == []


def test_attack_target_rules():
    world = make_world([card(1, vision_range=1), card(2, (0, 1)), card(3, (0, 3))])
    assert act(world, "a01", "attack", target="a01", compute_budget=1).result.reason == "invalid_argument"
    assert act(world, "a01", "attack", target="a02", compute_budget=1).result.reason == "out_of_range"
    assert act(world, "a01", "attack", target="a03", compute_budget=1).result.reason == "target_gone"
    fruit = add_fruit(world)
    assert act(world, "a01", "attack", target=fruit.id, compute_budget=1).result.reason == "invalid_argument"
    assert world.agents["a02"].stats.health == 100
    # the attempt fee is min(1, budget)
    cheap = act(world, "a01", "attack", target="a03", compute_budget=0.5)
    assert cheap.result.cost_compute == 0.5
    # attack needs the full effective charge
    world.agents["a01"].stats.compute = 5
    assert act(world, "a01", "attack", target="a02", compute_budget=6).result.reason == "insufficient_compute"
    assert act(world, "a01", "attack", target="a02", compute_budget=6, via_skill=True).result.reason == "out_of_range"


def test_plant_lethal_hit_leaves_residue_from_pre_hit_essence():
    world = make_world()
    plant = add_plant(world, essence=5.0, energy=30.0)
    hit = act(world, "a01", "attack", target=plant.id, compute_budget=2)
    assert hit.result.ok and plant.essence == 3 and plant.alive
    assert hit.result.effects == {"damage": 2, "target": plant.id, "target_health_after": 3, "killed": False}
    assert world.residues == {} and hit.notices == []
    kill = act(world, "a01", "attack", target=plant.id, compute_budget=10)
    assert kill.result.effects["killed"] is True and kill.result.effects["target_health_after"] == 0
    assert plant.alive is False and plant.essence == 0 and plant.energy == 0 and plant.death_cause == "attack"
    residue = world.residues["res0001"]
    assert residue.available_essence == pytest.approx(1.5)  # pre-hit 3 x 0.5
    assert residue.available_compute == 0  # energy_residue_fraction 0
    assert residue.source_kind == "plant" and kill.deaths == [plant.id]
    assert act(world, "a01", "attack", target=plant.id, compute_budget=1).result.reason == "target_gone"
    # energy residue when configured
    world.rules.plant_species["fruit_tree"].energy_residue_fraction = 0.5
    plant2 = add_plant(world, essence=1.0, energy=40.0)
    W.kill_plant(world, plant2.id, "operator", pre_hit_essence=1.0)
    assert world.residues["res0002"].available_compute == pytest.approx(20)


def test_wait_sets_remaining_turns_and_costs_nothing():
    world = make_world()
    out = act(world, "a01", "wait", rounds=3)
    assert out.result.ok and out.result.cost_compute == 0
    assert out.result.effects == {"waiting_turns": 3} and world.agents["a01"].wait_turns_remaining == 2


# ---------------------------------------------------------------------------
# Round end
# ---------------------------------------------------------------------------


def test_upkeep_partial_payment_and_starvation():
    world = make_world([card(1, compute=0.4), card(2, compute=1.0), card(3, compute=0, health=5, essence=10)])
    out = W.end_round(world)
    a01, a02, a03 = (world.agents[i] for i in ("a01", "a02", "a03"))
    assert a01.stats.compute == 0 and a01.stats.health == 95
    assert a02.stats.compute == 0 and a02.stats.health == 100
    upkeep = {e.details["agent_id"]: e.details for e in events_of(out, "upkeep")}
    assert upkeep["a01"] == {"agent_id": "a01", "paid": 0.4, "owed": 1.0}
    assert upkeep["a02"]["paid"] == 1.0
    starved = {e.details["agent_id"]: e.details for e in events_of(out, "starvation")}
    assert starved["a01"] == {"agent_id": "a01", "health_loss": 5.0, "health_after": 95}
    assert "a02" not in starved
    # a03 starved to death: single death path with residue essence 10 x 0.4
    assert a03.alive is False and a03.death_cause == "starvation" and out.deaths == ["a03"]
    assert world.residues["res0001"].available_essence == pytest.approx(4) and world.residues["res0001"].available_compute == 0
    notices = {n.agent_id: n for n in out.notices}
    assert notices["a01"].kind == "damage" and notices["a01"].content["health_after"] == 95
    assert notices["a01"].content["cause"] == "starvation" and notices["a01"].provenance.source == "world"
    assert notices["a03"].content["health_after"] == 0
    assert "a02" not in notices
    assert out.events[-1].kind == "round_ended"
    assert out.events[-1].details == {"round": 1, "living_agents": ["a01", "a02"], "deaths": ["a03"]}
    assert world.round == 1


def test_plant_growth_stage_by_age_and_capped_inflow():
    world = make_world()
    sprout = add_plant(world, stage_index=0, essence=5.0)
    sprout.age_rounds = 4
    mature = add_plant(world, position=(1, 0), stage_index=2, essence=59.5, energy=175)
    out = W.end_round(world)
    assert sprout.age_rounds == 5 and sprout.stage_index == 1 and sprout.size == 2.0
    assert sprout.energy == 6 and sprout.essence == 5.5
    assert sprout.total_source_energy == 6 and sprout.total_source_essence == 0.5
    growth = [e for e in events_of(out, "plant_growth") if "plant_id" in e.details]
    assert growth[0].details["plant_id"] == sprout.id and growth[0].details["stage"] == "sapling"
    assert mature.energy == 180 and mature.essence == 60
    assert mature.total_source_energy == 5 and mature.total_source_essence == 0.5
    summary = [e for e in events_of(out, "plant_growth") if "count" in e.details][0]
    assert summary.details["count"] == 2 and summary.details["total_energy_inflow"] == 11
    assert summary.details["skipped_non_land"] == []
    assert sprout.rounds_since_fruit == 1 and sprout.rounds_since_seed == 1


def test_water_supports_no_growth():
    world = make_world()
    plant = add_plant(world, position=(1, 1), stage_index=2, essence=5.0, energy=100)
    plant.rounds_since_fruit = 10
    world.map.cells["1,1"] = "water"
    out = W.end_round(world)
    assert plant.age_rounds == 15 and plant.energy == 100 and plant.essence == 5.0
    assert plant.rounds_since_fruit == 10 and world.fruits == {}
    summary = [e for e in events_of(out, "plant_growth") if "count" in e.details][0]
    assert summary.details["skipped_non_land"] == [plant.id] and summary.details["count"] == 0
    # a seed on water stays dormant
    seed_id = W.new_entity_id(world, "seed")
    world.seeds[seed_id] = Seed(id=seed_id, position=Point(x=1, y=1), species="fruit_tree", germinates_round=0)
    W.end_round(world)
    assert seed_id in world.seeds and len(world.plants) == 1


def test_fruit_spawns_from_plant_energy_with_caps_and_counter_rules():
    world = make_world()
    plant = add_plant(world, stage_index=2, energy=100, essence=5.0)
    plant.rounds_since_fruit = 4  # becomes 5 = interval in step 1
    out = W.end_round(world)
    assert len(world.fruits) == 1
    fruit = world.fruits["f0001"]
    assert fruit.plant_id == plant.id and fruit.available_compute == 60 and fruit.position == plant.position
    assert plant.energy == pytest.approx(100 + 12 - 60) and plant.rounds_since_fruit == 0
    assert plant.fruit_ids == ["f0001"] and plant.total_fruit_produced == 1
    spawned = events_of(out, "fruit_spawned")[0]
    assert spawned.details["plant_id"] == plant.id and spawned.details["entity_id"] == "f0001"
    # not enough energy: blocked spawn keeps the counter
    plant.energy = 10
    plant.rounds_since_fruit = 4
    W.end_round(world)
    assert len(world.fruits) == 1 and plant.rounds_since_fruit == 5
    # max_fruit blocks
    plant.energy = 180
    plant.rounds_since_fruit = 4
    world.fruits["f0002"] = Fruit(id="f0002", position=plant.position, plant_id=plant.id, available_compute=1)
    world.fruits["f0003"] = Fruit(id="f0003", position=plant.position, plant_id=plant.id, available_compute=1)
    world.next_entity_seq["fruit"] = 4
    W.end_round(world)
    assert len(world.fruits) == 3 and plant.rounds_since_fruit == 5


def test_seed_dispersal_and_germination_on_land_only():
    world = make_world()
    plant = add_plant(world, position=(0, 0), stage_index=2, essence=5.0)
    plant.rounds_since_seed = 19
    world.map.cells["0,1"] = "water"
    out = W.end_round(world)
    assert len(world.seeds) == 1
    seed = world.seeds["s0001"]
    assert seed.plant_id == plant.id and seed.species == "fruit_tree" and seed.germinates_round == 11
    assert seed.position.manhattan(plant.position) <= 1 and W.terrain_at(world, seed.position) == "land"
    assert plant.seed_ids == ["s0001"] and plant.rounds_since_seed == 0
    assert events_of(out, "seed_spawned")[0].details["entity_id"] == "s0001"
    # the same RNG state disperses to the same cell
    twin = make_world()
    twin_plant = add_plant(twin, position=(0, 0), stage_index=2, essence=5.0)
    twin_plant.rounds_since_seed = 19
    twin.map.cells["0,1"] = "water"
    twin.rng_state = ""
    world.rng_state = ""
    for w in (world, twin):
        for p in w.plants.values():
            p.rounds_since_seed = 19
        w.seeds.clear()
    W.end_round(world)
    W.end_round(twin)
    assert list(world.seeds) == ["s0002"] and list(twin.seeds) == ["s0001"]
    assert world.seeds["s0002"].position == twin.seeds["s0001"].position
    # germination when due: stage-0 plant funded with initial essence, seed removed
    seed = world.seeds["s0002"]
    world.round = seed.germinates_round
    out = W.end_round(world)
    assert "s0002" not in world.seeds and world.removed["s0002"].reason == "germinated"
    new_plant = world.plants["p0002"]
    assert new_plant.stage_index == 0 and new_plant.essence == 5.0 and new_plant.age_rounds == 0
    assert new_plant.position == seed.position and plant.seed_ids == []
    assert events_of(out, "germination")[0].details["entity_id"] == "s0002"
    assert W.validate_world(world) == []


def test_max_seeds_alive_blocks_seed_spawn():
    world = make_world()
    plant = add_plant(world, stage_index=2, essence=5.0)
    for n in (1, 2):
        world.seeds[f"s000{n}"] = Seed(id=f"s000{n}", position=plant.position, species="fruit_tree", plant_id=plant.id, germinates_round=99)
    world.next_entity_seq["seed"] = 3
    plant.rounds_since_seed = 19
    W.end_round(world)
    assert len(world.seeds) == 2 and plant.rounds_since_seed == 20


def test_cleanup_removes_consumed_and_rotten_fruit_and_empty_residue():
    world = make_world()
    world.rules.plant_species["fruit_tree"].fruit_decay_rounds = 3
    plant = add_plant(world, stage_index=0, essence=5.0)
    consumed = add_fruit(world, compute=0.0, plant_id=plant.id)
    rotten = add_fruit(world, compute=30.0, plant_id=plant.id)
    rotten.created_round = 1
    fresh = add_fruit(world, compute=30.0, plant_id=plant.id)
    fresh.created_round = 3
    plant.fruit_ids = [consumed.id, rotten.id, fresh.id]
    empty = add_residue(world, compute=0.0, essence=1e-12)
    kept = add_residue(world, compute=1.0)
    world.round = 4
    out = W.end_round(world)
    assert consumed.id not in world.fruits and world.removed[consumed.id].reason == "consumed"
    assert rotten.id not in world.fruits and world.removed[rotten.id].reason == "decayed"
    assert fresh.id in world.fruits
    removed = {e.details["entity_id"]: e.details for e in events_of(out, "fruit_removed")}
    assert removed[rotten.id]["lost_compute"] == 30 and removed[rotten.id]["reason"] == "decayed"
    assert removed[consumed.id]["lost_compute"] == 0
    assert plant.fruit_ids == [fresh.id]
    assert empty.id not in world.residues and world.removed[empty.id].reason == "cleanup"
    assert kept.id in world.residues
    assert W.validate_world(world) == []


def test_residue_decay_when_configured():
    world = make_world()
    world.rules.death.residue_decay_per_round = 0.5
    residue = add_residue(world, compute=8.0, essence=1e-9)
    W.end_round(world)
    assert residue.available_compute == pytest.approx(4.0) and residue.available_essence == 0


# ---------------------------------------------------------------------------
# Interventions (spec "God mode")
# ---------------------------------------------------------------------------


def test_set_stat_changes_a_field_and_reports_before_after():
    world = make_world()
    changes = W.apply_world_intervention(world, SetStatIntervention(type="set_stat", entity_id="a01", field="stats.compute", value=50))
    assert changes == [FieldChange(path="world.agents.a01.stats.compute", before=200.0, after=50.0)]
    assert world.agents["a01"].stats.compute == 50
    changes = W.apply_world_intervention(world, SetStatIntervention(type="set_stat", entity_id="a01", field="position", value=[1, 2]))
    assert changes[0].after == {"x": 1, "y": 2} and world.agents["a01"].position == Point(x=1, y=2)
    assert world.map.occupants["1,2"] == ["a01"]
    W.apply_world_intervention(world, SetStatIntervention(type="set_stat", entity_id="a01", field="stats.speed", value=3.0))
    assert world.agents["a01"].stats.speed == 3 and isinstance(world.agents["a01"].stats.speed, int)


def test_set_stat_rejects_invalid_values_and_leaves_the_world_untouched():
    world = make_world()
    snapshot = world.model_dump(mode="json")
    bad = [
        SetStatIntervention(type="set_stat", entity_id="a01", field="stats.compute", value=-1),
        SetStatIntervention(type="set_stat", entity_id="a01", field="stats.speed", value=2.5),
        SetStatIntervention(type="set_stat", entity_id="a01", field="stats.health", value=150),
        SetStatIntervention(type="set_stat", entity_id="a01", field="stats.nope", value=1),
        SetStatIntervention(type="set_stat", entity_id="a01", field="position", value=[9, 9]),
        SetStatIntervention(type="set_stat", entity_id="zz", field="stats.compute", value=1),
        SetStatIntervention(type="set_stat", entity_id="a01", field="id", value="a09"),
    ]
    for intervention in bad:
        with pytest.raises(W.InterventionError):
            W.apply_world_intervention(world, intervention)
    assert world.model_dump(mode="json") == snapshot
    world.map.cells["0,1"] = "mountain"
    with pytest.raises(W.InterventionError):
        W.apply_world_intervention(world, SetStatIntervention(type="set_stat", entity_id="a01", field="position", value=[0, 1]))
    plant = add_plant(world)
    with pytest.raises(W.InterventionError):
        W.apply_world_intervention(world, SetStatIntervention(type="set_stat", entity_id=plant.id, field="species", value="cactus"))


def test_set_stat_health_zero_kills_with_operator_cause():
    world = make_world([card(1, compute=40, essence=10), card(2)])
    changes = W.apply_world_intervention(world, SetStatIntervention(type="set_stat", entity_id="a01", field="stats.health", value=0))
    a01 = world.agents["a01"]
    assert a01.alive is False and a01.death_cause == "operator" and a01.stats.compute == 0
    paths = [c.path for c in changes]
    assert paths[0] == "world.agents.a01.stats.health"
    assert "world.agents.a01.alive" in paths and "world.residues.res0001" in paths
    assert world.residues["res0001"].available_compute == pytest.approx(20)


def test_place_and_remove_entities():
    world = make_world()
    world.map.cells["2,2"] = "mountain"
    world.map.cells["1,1"] = "water"
    new_agent = Agent(id="", name="Placed", position=Point(x=1, y=1))
    changes = W.apply_world_intervention(world, PlaceEntityIntervention(type="place_entity", entity=new_agent))
    assert changes[0].path == "world.agents.a03" and world.agents["a03"].name == "Placed"
    assert world.agents["a03"].created_round == 1 and world.map.occupants["1,1"] == ["a03"]
    with pytest.raises(W.InterventionError):
        W.apply_world_intervention(world, PlaceEntityIntervention(type="place_entity", entity=Agent(id="", name="X", position=Point(x=2, y=2))))
    with pytest.raises(W.InterventionError):
        W.apply_world_intervention(world, PlaceEntityIntervention(type="place_entity", entity=Agent(id="a01", name="Dup", position=Point(x=0, y=0))))
    with pytest.raises(W.InterventionError):
        W.apply_world_intervention(world, PlaceEntityIntervention(type="place_entity", entity=Agent(id="self", name="R", position=Point(x=0, y=0))))
    # A rejected placement names the kind and the point, never an id the operator did not
    # choose (fix pass); an operator-given id is named.
    with pytest.raises(W.InterventionError, match=r"^new plant at \(1,1\) must be on land, not water$"):
        W.apply_world_intervention(world, PlaceEntityIntervention(type="place_entity", entity=Plant(id="", position=Point(x=1, y=1), species="fruit_tree")))
    with pytest.raises(W.InterventionError, match=r"^plant p0077 at \(1,1\) must be on land, not water$"):
        W.apply_world_intervention(world, PlaceEntityIntervention(type="place_entity", entity=Plant(id="p0077", position=Point(x=1, y=1), species="fruit_tree")))
    with pytest.raises(W.InterventionError, match=r"^new agent cannot be on a mountain at \(2,2\)$"):
        W.apply_world_intervention(world, PlaceEntityIntervention(type="place_entity", entity=Agent(id="", name="M", position=Point(x=2, y=2))))
    with pytest.raises(W.InterventionError, match=r"^new seed at \(99,99\) is outside the region$"):
        W.apply_world_intervention(world, PlaceEntityIntervention(type="place_entity", entity=Seed(id="", position=Point(x=99, y=99), species="fruit_tree", germinates_round=5)))
    with pytest.raises(W.InterventionError):
        W.apply_world_intervention(world, PlaceEntityIntervention(type="place_entity", entity=Plant(id="", position=Point(x=0, y=0), species="cactus")))
    W.apply_world_intervention(world, PlaceEntityIntervention(type="place_entity", entity=Plant(id="", position=Point(x=0, y=0), species="fruit_tree", stage_index=2)))
    assert world.plants["p0001"].size == 3.0
    W.apply_world_intervention(world, PlaceEntityIntervention(type="place_entity", entity=Fruit(id="f0007", position=Point(x=0, y=0), plant_id="p0001", available_compute=5)))
    assert world.next_entity_seq["fruit"] == 8
    world.plants["p0001"].fruit_ids = ["f0007"]
    changes = W.apply_world_intervention(world, RemoveEntityIntervention(type="remove_entity", entity_id="f0007"))
    assert changes[0].path == "world.fruits.f0007" and changes[0].after is None and changes[0].before["id"] == "f0007"
    assert "f0007" not in world.fruits and world.removed["f0007"].reason == "operator"
    assert world.plants["p0001"].fruit_ids == []
    assert W.new_entity_id(world, "fruit") == "f0008"
    with pytest.raises(W.InterventionError):
        W.apply_world_intervention(world, RemoveEntityIntervention(type="remove_entity", entity_id="f0007"))
    W.apply_world_intervention(world, RemoveEntityIntervention(type="remove_entity", entity_id="a03"))
    assert "a03" not in world.agents and world.removed["a03"].kind == "agent"
    assert W.validate_world(world) == []


def test_update_plant_rules_clamps_stages_and_update_prices():
    world = make_world()
    plant = add_plant(world, stage_index=2)
    rule = PlantSpeciesRule(name="fruit_tree", stages=[PlantStageRule(name="only", max_essence=10)])
    with pytest.raises(W.InterventionError):
        W.apply_world_intervention(world, UpdatePlantRulesIntervention(type="update_plant_rules", species="other", rule=rule))
    changes = W.apply_world_intervention(world, UpdatePlantRulesIntervention(type="update_plant_rules", species="fruit_tree", rule=rule))
    assert changes[0].path == "world.rules.plant_species.fruit_tree" and changes[0].before["name"] == "fruit_tree"
    assert changes[1] == FieldChange(path=f"world.plants.{plant.id}.stage_index", before=2, after=0)
    assert plant.stage_index == 0 and len(world.rules.plant_species["fruit_tree"].stages) == 1
    changes = W.apply_world_intervention(world, UpdatePricesIntervention(type="update_prices", prices=Prices(move=9)))
    assert changes[0].path == "world.rules.prices" and world.rules.prices.move == 9
    assert act(world, "a01", "move", direction="up").result.cost_compute == 9
    with pytest.raises(W.WorldError):
        W.apply_world_intervention(world, VoiceIntervention(type="voice", recipients={"mode": "broadcast_all"}, text="hi"))


# ---------------------------------------------------------------------------
# Validation and replacement
# ---------------------------------------------------------------------------


def test_validate_world_reports_inconsistencies():
    world = make_world()
    assert W.validate_world(world) == []
    world.agents["a01"].stats.essence = 500
    world.agents["a02"].position = Point(x=9, y=9)
    plant = add_plant(world)
    plant.species = "cactus"
    fruit = add_fruit(world, plant_id="p0999")
    world.next_entity_seq["fruit"] = 1
    world.removed["a01"] = RemovedEntity(id="a01", kind="agent", position=Point(x=0, y=0), round=1, reason="operator")
    errors = W.validate_world(world)
    text = "\n".join(errors)
    assert "essence" in text and "outside the region" in text and "cactus" in text
    assert "p0999" in text and "next_entity_seq.fruit" in text and "removed" in text
    assert fruit.id in text


def test_replace_world_adopts_only_valid_snapshots():
    world = make_world()
    broken = copy.deepcopy(world)
    broken.agents["a01"].stats.health = -5
    assert W.replace_world(world, broken) != []
    assert world.agents["a01"].stats.health == 100
    good = copy.deepcopy(world)
    good.agents["a01"].stats.compute = 12
    good.map.occupants = {"9,9": ["ghost"]}
    assert W.replace_world(world, good) == []
    assert world.agents["a01"].stats.compute == 12
    assert world.map.occupants == {"0,0": ["a01", "a02"]}  # rebuilt, the ghost is dropped


def test_results_are_json_serialisable_and_events_well_formed():
    world = make_world([card(1, vision_range=1, communication_range=1), card(2, (0, 1), health=3)])
    fruit = add_fruit(world, compute=5)
    outcomes = [
        act(world, "a01", "observe", point=[0, 0]),
        act(world, "a01", "query", entity="self"),
        act(world, "a01", "absorb", source=fruit.id, resource="compute"),
        act(world, "a01", "send", recipient="a02", message="hi"),
        act(world, "a01", "upgrade", attribute="attack"),
        act(world, "a01", "move", direction="up"),
        act(world, "a01", "attack", target="a02", compute_budget=5),
        W.end_round(world),
    ]
    for outcome in outcomes:
        json.dumps(outcome.model_dump(mode="json"))
        for event in outcome.events:
            assert event.summary and "\n" not in event.summary
    json.dumps(world.model_dump(mode="json"))
    assert W.validate_world(world) == []


# ---------------------------------------------------------------------------
# Regression checks from the edge-case probe
# ---------------------------------------------------------------------------


def test_interventions_keep_entity_object_identity():
    world = make_world()
    a01 = world.agents["a01"]
    W.apply_world_intervention(world, SetStatIntervention(type="set_stat", entity_id="a01", field="stats.compute", value=7))
    assert a01 is world.agents["a01"] and a01.stats.compute == 7
    a02 = world.agents["a02"]
    W.apply_world_intervention(world, SetStatIntervention(type="set_stat", entity_id="a02", field="stats.health", value=0))
    assert a02 is world.agents["a02"] and a02.alive is False and a02.death_cause == "operator"
    # death is resolved once (A-DEATH-6): flipping alive back on is rejected, nothing changes
    residues_before = dict(world.residues)
    with pytest.raises(W.InterventionError, match="cannot be revived"):
        W.apply_world_intervention(world, SetStatIntervention(type="set_stat", entity_id="a02", field="alive", value=True))
    assert a02.alive is False and world.residues == residues_before
    with pytest.raises(W.InterventionError):
        W.apply_world_intervention(world, SetStatIntervention(type="set_stat", entity_id="a02", field="stats.health", value=10))


def test_uncomputable_quote_is_invalid_argument_without_charge():
    world = make_world([card(1, compute=1e6, essence=1e6, essence_capacity=1e6), card(2)])
    world.agents["a01"].upgrade_counts["attack"] = 100000  # 4 ** n overflows a float
    out = act(world, "a01", "upgrade", attribute="attack")
    assert out.result.reason == "invalid_argument" and out.result.cost_compute == 0
    assert world.agents["a01"].stats.compute == 1e6 and world.agents["a01"].stats.attack == 1.0


def test_zero_efficiency_fails_instead_of_destroying_the_source():
    world = make_world([card(1, compute_absorption=0.0), card(2)])
    fruit = add_fruit(world, compute=50)
    out = act(world, "a01", "absorb", source=fruit.id, resource="compute")
    assert out.result.reason == "at_limit" and out.result.cost_compute == 1
    assert fruit.available_compute == 50


def test_recovery_rate_scales_healing_and_charge():
    world = make_world([card(1, health=50), card(2)])
    world.rules.recovery.health_per_compute = 2
    out = act(world, "a01", "recover", compute_budget=10)
    assert out.result.cost_compute == 10 and out.result.effects == {"healed": 20, "health": 70}
    capped = act(world, "a01", "recover", compute_budget=100)
    assert capped.result.cost_compute == 15 and world.agents["a01"].stats.health == 100
    world.rules.recovery.health_per_compute = 0
    world.agents["a01"].stats.health = 50
    none = act(world, "a01", "recover", compute_budget=10)
    assert none.result.ok and none.result.cost_compute == 0 and world.agents["a01"].stats.health == 50


# ---------------------------------------------------------------------------
# Review regressions: plant source accounting and operator-chosen stages
# ---------------------------------------------------------------------------


def test_plants_record_source_inflow_and_keep_an_operator_chosen_stage():
    """A-PLANT-4: a plant's initial essence comes from the source and is recorded as such
    (generated, germinated and placed plants alike); a placed or edited stage settles the
    age so round end (stage by age) does not undo the operator's choice."""
    config = small_config()
    config.initial_plants = {"fruit_tree": 3}
    world = W.generate_world(config, default_rules(), 1, [card(1), card(2)])
    world.round = 1
    for plant in world.plants.values():
        assert plant.essence > 0 and plant.total_source_essence == pytest.approx(plant.essence)
    rule = world.rules.plant_species["fruit_tree"]
    land = next(p for p in W._land_cells(world) if not W.entities_at(world, p))
    placed = Plant(id="", position=land, species="fruit_tree", stage_index=2, essence=5.0, energy=3.0)
    changes = W.apply_world_intervention(world, PlaceEntityIntervention(type="place_entity", entity=placed))
    pid = changes[0].path.split(".")[2]
    plant = world.plants[pid]
    assert plant.age_rounds == rule.stages[2].min_age_rounds and plant.size == rule.stages[2].size
    assert plant.total_source_essence == 5.0 and plant.total_source_energy == 3.0
    W.end_round(world)
    assert world.plants[pid].stage_index == 2
    world.round += 1
    changes = W.apply_world_intervention(world, SetStatIntervention(type="set_stat", entity_id=pid, field="stage_index", value=0))
    assert {c.path.rsplit(".", 1)[1] for c in changes} == {"stage_index", "age_rounds", "size"}
    assert plant.stage_index == 0 and plant.age_rounds == rule.stages[0].min_age_rounds and plant.size == rule.stages[0].size
    W.end_round(world)
    assert world.plants[pid].stage_index == 0 or rule.stages[1].min_age_rounds <= plant.age_rounds


def test_action_event_summaries_name_the_actor():
    """INTERFACES section 5: action summaries read "a03 observe (0,1) -> ok: ..." like every
    other event kind (fix pass)."""
    world = make_world()
    outcome = act(world, "a01", "observe", point={"x": 0, "y": 0})
    (action_event,) = [e for e in outcome.events if e.kind == "action"]
    assert action_event.summary.startswith("a01 observe (0,0) -> ok")
