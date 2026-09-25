"""
Authoritative world state and rules.  OWNER: engine/storage team.

Owns
----
* World generation from a seed (terrain, initial plants, agent placement).
* Every legality check and cost for the eleven world actions, including the
  saved-skill discount, the attempt fee, and precise fractional accounting
  (``rules.accounting.eps``).
* Plant growth, fruit/seed spawning, germination, residue decay, upkeep,
  starvation, death, residue creation, and cleanup at round end.
* Upgrade quotes and the ``query(self)`` data block.
* Applying world-level god-mode interventions (set_stat, place/remove entity,
  plant rules, prices) and validating consistency.

Must not
--------
* Know about turn ids, event sequence numbers, model calls, packets, or
  knowledge stores.  It returns ``EventDraft``/``Notice`` lists and the runner
  assigns ids and routes notices to ``context.py``.
* Perform I/O, call models, or read configuration files or config constants.
  All numbers come from ``world.rules`` (a ``RulesConfig``), never from module
  constants: message length uses ``rules.messages.chars_per_token``, epsilon
  uses ``rules.accounting.eps``.
* Mutate state on a failed action beyond the documented attempt fee.

Error behaviour
---------------
Gameplay failures are NOT exceptions: ``apply_action`` always returns an
``ActionOutcome`` whose ``result.ok`` is False with a ``FailureReason``.
``WorldError`` is raised only for programming/consistency errors (unknown
actor id, rules missing a species) and ``InterventionError`` for an
intervention that would leave invalid state (the runner reports it, state
stays untouched).

Every mutation goes through ``apply_action``, ``end_round``, ``kill_agent``,
``kill_plant``, ``apply_world_intervention`` or ``replace_world`` so the
ledger stays exact.

Dead entities (A-DEATH-6)
-------------------------
Dead agents and plants STAY in ``world.agents`` / ``world.plants`` with
``alive=False`` (health/compute/essence clamped to 0, position kept).  They
appear in ``map.occupants`` (for the UI) but never in ``entities_at(...,
living_only=True)``, observe listings, initiative or as action targets; the
residue entity is the remains.  Entities that leave the dicts (consumed fruit
or residue, germinated seeds, operator removals) are recorded in
``world.removed``.

Accounting conventions used throughout
--------------------------------------
* Balances are plain floats; nothing is ever rounded except the absorption
  fractions (9 decimals, design "Upgradeable attributes") and INTEGER_STATS.
* ``_clean(x, eps)`` turns any amount below ``eps`` into exactly 0.0 so a
  balance or source can never hold a sub-epsilon remainder or go negative.
* Affordability comparisons tolerate ``eps`` so a balance that is equal to the
  price up to float noise still pays.
"""

from __future__ import annotations

import json
import math
import random
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from pydantic import ValidationError

from .schemas import (
    INTEGER_STATS,
    RESERVED_AGENT_IDS,
    UPGRADE_ATTRIBUTES,
    ActionOutcome,
    ActionQuote,
    ActionRequest,
    ActionResult,
    Agent,
    AgentCard,
    Entity,
    EntityKind,
    EventCosts,
    EventDraft,
    FieldChange,
    Fruit,
    Intervention,
    MapState,
    Notice,
    Plant,
    PlantSpeciesRule,
    PlantStageRule,
    Point,
    Provenance,
    Region,
    RemovedEntity,
    Residue,
    RoundEndOutcome,
    RulesConfig,
    Seed,
    Terrain,
    WorldAction,
    WorldConfig,
    WorldState,
)


class WorldError(Exception):
    """Programming or consistency error inside the world engine."""


class InterventionError(Exception):
    """An intervention would produce invalid state.  Nothing was changed."""


# ---------------------------------------------------------------------------
# Module-level constants that are NOT gameplay numbers (id formats, key names)
# ---------------------------------------------------------------------------

# Entity id format per kind: prefix and zero-padded width (INTERFACES section 3).
ID_FORMATS: dict[str, tuple[str, int]] = {
    "agent": ("a", 2),
    "plant": ("p", 4),
    "fruit": ("f", 4),
    "seed": ("s", 4),
    "residue": ("res", 4),
}

# WorldState dict attribute per entity kind, in the stable listing order.
KIND_TO_DICT: dict[str, str] = {
    "agent": "agents",
    "plant": "plants",
    "fruit": "fruits",
    "seed": "seeds",
    "residue": "residues",
}
ENTITY_DICTS: tuple[str, ...] = ("agents", "plants", "fruits", "seeds", "residues")

# Stats stored as fractions; upgrades round them to this many decimals (A-ACT-17).
FRACTION_STATS: tuple[str, ...] = ("compute_absorption", "essence_absorption")
FRACTION_DECIMALS = 9

# Fixed draw order for cluster growth (a tuple so rng.choice is reproducible).
_DIRECTIONS: tuple[str, ...] = ("up", "down", "left", "right")

_AGENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9]{1,16}$")


def _add_warning(world: WorldState, text: str) -> None:
    """Warnings live on ``WorldState.warnings`` so they survive copies and checkpoints."""
    world.warnings.append(text)


def world_warnings(world: WorldState) -> list[str]:
    """Human-readable warnings collected by ``generate_world`` (A-WORLD-6, e.g. "a03 moved
    from (5,5) mountain to (5,4)").  A copy of ``world.warnings``; reading does not clear
    them (the run_created event and world.json both carry them)."""
    return list(world.warnings)


# ---------------------------------------------------------------------------
# Small pure helpers
# ---------------------------------------------------------------------------


def _eps(world: WorldState) -> float:
    return world.rules.accounting.eps


def _clean(value: float, eps: float) -> float:
    """Amounts below ``eps`` are empty (INTERFACES section 3, "Money")."""
    value = float(value)
    return 0.0 if value < eps else value


def _fmt(value: Any) -> str:
    """Compact number formatting for event summaries (never rounds stored values)."""
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return f"{value:g}"
    return str(value)


def _point_dict(point: Point) -> dict[str, int]:
    return {"x": point.x, "y": point.y}


def _fmt_point(point: Point) -> str:
    return f"({point.x},{point.y})"


def _region_cells(region: Region) -> list[Point]:
    """Every cell of the region in a fixed scan order (x outer, y inner)."""
    return [
        Point(x=x, y=y)
        for x in range(region.min_x, region.max_x + 1)
        for y in range(region.min_y, region.max_y + 1)
    ]


def _land_cells(world: WorldState) -> list[Point]:
    return [p for p in _region_cells(world.map.region) if world.map.cells.get(p.key()) == "land"]


def _species_rule(world: WorldState, species: str) -> PlantSpeciesRule:
    rule = world.rules.plant_species.get(species)
    if rule is None:
        raise WorldError(f"species {species!r} is not in rules.plant_species")
    return rule


def _stage_rule(rule: PlantSpeciesRule, stage_index: int) -> PlantStageRule:
    index = max(0, min(stage_index, len(rule.stages) - 1))
    return rule.stages[index]


def _stage_for_age(rule: PlantSpeciesRule, age: int) -> int:
    """Highest stage whose ``min_age_rounds`` <= age (stage 0 when none qualifies)."""
    best = 0
    for index, stage in enumerate(rule.stages):
        if stage.min_age_rounds <= age:
            best = index
    return best


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


def _grow_cluster(region: Region, rng: random.Random, size: int) -> list[Point]:
    """Grow one contiguous cluster of about ``size`` cells from a seeded centre.

    Draw order is fixed: centre x, centre y, then (base index, direction) pairs until the
    cluster is full or the attempt budget (8 x size) is spent, so a seed always yields the
    same cells."""
    centre = Point(x=rng.randint(region.min_x, region.max_x), y=rng.randint(region.min_y, region.max_y))
    cells = [centre]
    keys = {centre.key()}
    attempts = 0
    while len(cells) < size and attempts < size * 8:
        attempts += 1
        base = cells[rng.randrange(len(cells))]
        nxt = base.moved(rng.choice(_DIRECTIONS))
        if region.contains(nxt) and nxt.key() not in keys:
            cells.append(nxt)
            keys.add(nxt.key())
    return cells


def generate_terrain(config: WorldConfig, rng: random.Random) -> MapState:
    """Terrain only (also used by POST /api/world/preview): every cell in ``config.region``
    starts as land; then ``terrain.mountain_clusters`` clusters of about
    ``mountain_cluster_size`` cells and ``water_clusters`` clusters of about
    ``water_cluster_size`` cells are grown from seeded centres; cells within
    ``keep_origin_clear_radius`` (Manhattan) of (0,0) stay land.  Draws from ``rng`` in a
    fixed order so the same seed always yields the same map.  ``occupants`` is empty.

    Mountains are painted before water; a cell already painted keeps its first terrain
    (A-WORLD-2)."""
    region = config.region
    cells: dict[str, Terrain] = {p.key(): "land" for p in _region_cells(region)}
    origin = Point(x=0, y=0)
    clear_radius = config.terrain.keep_origin_clear_radius

    def paint(terrain: Terrain, count: int, size: int) -> None:
        for _ in range(max(0, count)):
            for point in _grow_cluster(region, rng, max(1, size)):
                if point.manhattan(origin) <= clear_radius:
                    continue
                if cells[point.key()] != "land":
                    continue
                cells[point.key()] = terrain

    paint("mountain", config.terrain.mountain_clusters, config.terrain.mountain_cluster_size)
    paint("water", config.terrain.water_clusters, config.terrain.water_cluster_size)
    return MapState(region=region.model_copy(), cells=cells, occupants={})


def _nearest_land(world: WorldState, point: Point) -> Point:
    """Deterministic nearest land cell: Manhattan distance, then x, then y (A-WORLD-6)."""
    land = _land_cells(world)
    if not land:
        raise WorldError("the map has no land cell")
    return min(land, key=lambda p: (p.manhattan(point), p.x, p.y))


def generate_world(config: WorldConfig, rules: RulesConfig, seed: int, agents: list[AgentCard]) -> WorldState:
    """Build the round-0 world with ``random.Random(seed)`` as THE run RNG.

    Draw order (reproducibility): terrain -> initial plants -> nothing else; the generator
    state is then serialised into ``world.rng_state`` so later randomness (initiative
    tie-breaks, seed dispersal) continues from it.
    * Plants: for each species in ``config.initial_plants`` place that many plants at stage
      ``config.initial_plant_stage`` (clamped to the last stage) with ``age_rounds =
      stages[stage].min_age_rounds``, ``essence = initial_essence`` (recorded in
      ``total_source_essence``: the source supplied it, A-PLANT-4), ``energy = 0``.  Ids
      ``p0001``...  With ``config.plants_at_agent_starts`` (A-WORLD-7) the first plants of
      each species go to the agents' final start cells (one per distinct LAND cell, card
      order; no rng draw); the remaining plants are placed on uniformly chosen LAND cells
      (may share a cell).  Each initial plant then gets ``config.initial_plant_fruit`` ripe
      fruit (A-PLANT-13, capped by the species ``max_fruit``; ``available_compute =
      fruit_energy``, funded by the source: ``total_fruit_produced`` and
      ``total_source_energy`` count it; ``rounds_since_fruit`` stays 0).  Ids ``f0001``...
    * Agents: one ``Agent`` per card in card order; id from the card or the lowest unused
      ``aNN``; a card position on a mountain cell is moved to the nearest land cell
      (deterministic scan by Manhattan distance, then x, then y) and the move is returned
      through ``world_warnings`` (A-WORLD-6).  Model assignment and context overrides are
      NOT stored on agents (they live in RunSettings).  ``initial_skills`` are compiled by
      the runner via skills.py and set on ``agent.skills`` afterwards.
    * ``rules`` is stored on the returned state; ``round`` is 0; ``map.occupants`` is filled.
    Raises ``WorldError`` if a species in ``initial_plants`` is not in rules.
    """
    for species in config.initial_plants:
        if species not in rules.plant_species:
            raise WorldError(f"initial_plants species {species!r} is not in rules.plant_species")

    rng = random.Random(seed)
    map_state = generate_terrain(config, rng)
    world = WorldState(
        round=0,
        map=map_state,
        rules=rules.model_copy(deep=True),
        observation_page_size=max(1, config.max_entities_per_observation_page),
    )

    # Agent start cells first (pure, no rng): plants may be placed on them (A-WORLD-7).
    placements: list[tuple[AgentCard, str, Point]] = []
    seen_ids: set[str] = set()
    for card in agents:
        agent_id = card.id or new_entity_id(world, "agent")
        if agent_id in seen_ids or agent_id in world.agents:
            raise WorldError(f"duplicate agent id {agent_id!r} in the cards")
        seen_ids.add(agent_id)
        _bump_seq_past(world, "agent", agent_id)  # a later card without an id never reuses this one
        position = card.position.model_copy()
        terrain = terrain_at(world, position)
        if terrain is None or terrain == "mountain":
            moved_to = _nearest_land(world, position)
            where = "outside the region" if terrain is None else "mountain"
            _add_warning(world, f"{agent_id} moved from {_fmt_point(position)} {where} to {_fmt_point(moved_to)}")
            position = moved_to.model_copy()
        placements.append((card, agent_id, position))

    start_cells: list[Point] = []
    if config.plants_at_agent_starts:
        for _card, _agent_id, position in placements:
            if terrain_at(world, position) == "land" and all((c.x, c.y) != (position.x, position.y) for c in start_cells):
                start_cells.append(position)

    land = _land_cells(world)
    for species, count in config.initial_plants.items():
        rule = rules.plant_species[species]
        stage_index = max(0, min(config.initial_plant_stage, len(rule.stages) - 1))
        stage = rule.stages[stage_index]
        fruit_per_plant = max(0, min(config.initial_plant_fruit, rule.max_fruit))
        for ordinal in range(max(0, count)):
            if ordinal < len(start_cells):
                position = start_cells[ordinal]
            elif land:
                position = rng.choice(land)
            else:
                _add_warning(world, f"no land cell available to place a {species}")
                break
            plant_id = new_entity_id(world, "plant")
            plant = Plant(
                id=plant_id,
                position=position.model_copy(),
                species=species,
                stage_index=stage_index,
                age_rounds=stage.min_age_rounds,
                size=stage.size,
                energy=0.0,
                essence=rule.initial_essence,
                created_round=0,
                total_source_essence=rule.initial_essence,  # supplied by the source (A-PLANT-4)
            )
            world.plants[plant_id] = plant
            for _ in range(fruit_per_plant):  # A-PLANT-13: ripe fruit funded by the source
                fruit_id = new_entity_id(world, "fruit")
                world.fruits[fruit_id] = Fruit(
                    id=fruit_id,
                    position=position.model_copy(),
                    plant_id=plant_id,
                    available_compute=float(rule.fruit_energy),
                    available_essence=0.0,
                    created_round=0,
                )
                plant.fruit_ids.append(fruit_id)
                plant.total_fruit_produced += 1
                plant.total_source_energy += float(rule.fruit_energy)

    for card, agent_id, position in placements:
        world.agents[agent_id] = Agent(
            id=agent_id,
            name=card.name,
            position=position,
            stats=card.stats.model_copy(deep=True),
            persona=card.persona,
            created_round=0,
        )

    save_rng(world, rng)
    rebuild_occupants(world)
    return world


def _id_for(kind: str, number: int) -> str:
    prefix, width = ID_FORMATS[kind]
    return f"{prefix}{number:0{width}d}"


def _id_number(kind: str, entity_id: str) -> Optional[int]:
    """The numeric part of a canonical id of ``kind`` (a01 -> 1), None for other ids."""
    prefix, _ = ID_FORMATS[kind]
    if entity_id.startswith(prefix) and entity_id[len(prefix):].isdigit():
        return int(entity_id[len(prefix):])
    return None


def _bump_seq_past(world: WorldState, kind: str, entity_id: str) -> None:
    number = _id_number(kind, entity_id)
    if number is not None and world.next_entity_seq.get(kind, 1) <= number:
        world.next_entity_seq[kind] = number + 1


def _id_in_use(world: WorldState, entity_id: str) -> bool:
    if entity_id in world.removed:
        return True
    return any(entity_id in getattr(world, name) for name in ENTITY_DICTS)


def new_entity_id(world: WorldState, kind: EntityKind) -> str:
    """Allocate the next id for ``kind`` (a01/p0001/f0001/s0001/res0001) and bump
    ``next_entity_seq``; never returns an id present in any dict or in ``world.removed``."""
    if kind not in ID_FORMATS:
        raise WorldError(f"unknown entity kind {kind!r}")
    number = max(1, world.next_entity_seq.get(kind, 1))
    while _id_in_use(world, _id_for(kind, number)):
        number += 1
    world.next_entity_seq[kind] = number + 1
    return _id_for(kind, number)


def get_rng(world: WorldState) -> random.Random:
    """Return a ``random.Random`` restored from ``world.rng_state`` (fresh seeded if empty)."""
    rng = random.Random(0)
    if world.rng_state:
        version, internal, gauss_next = json.loads(world.rng_state)
        rng.setstate((version, tuple(internal), gauss_next))
    return rng


def save_rng(world: WorldState, rng: random.Random) -> None:
    """Serialise ``rng`` back into ``world.rng_state``."""
    version, internal, gauss_next = rng.getstate()
    world.rng_state = json.dumps([version, list(internal), gauss_next])


# ---------------------------------------------------------------------------
# Lookup helpers (pure)
# ---------------------------------------------------------------------------


def terrain_at(world: WorldState, point: Point) -> Optional[Terrain]:
    """Terrain at ``point`` or None when outside the region."""
    if not world.map.region.contains(point):
        return None
    return world.map.cells.get(point.key())


def find_entity(world: WorldState, entity_id: str) -> Optional[Entity]:
    """Any entity (agent/plant/fruit/seed/residue) by id, dead or alive; None if absent."""
    for name in ENTITY_DICTS:
        entity = getattr(world, name).get(entity_id)
        if entity is not None:
            return entity
    return None


def _is_present(entity: Entity) -> bool:
    """Living for agents/plants; fruit/seeds/residue are present while in the dicts."""
    if entity.kind in ("agent", "plant"):
        return bool(entity.alive)
    return True


def _all_entities(world: WorldState, living_only: bool) -> list[Entity]:
    """Every entity in the stable order: agents, plants, fruits, seeds, residues; id order."""
    result: list[Entity] = []
    for name in ENTITY_DICTS:
        table = getattr(world, name)
        for entity_id in sorted(table):
            entity = table[entity_id]
            if living_only and not _is_present(entity):
                continue
            result.append(entity)
    return result


def entities_at(world: WorldState, point: Point, living_only: bool = True) -> list[Entity]:
    """Entities whose position equals ``point`` in a stable order (agents, plants, fruits,
    seeds, residues; id order).  With ``living_only`` (the gameplay view: observe, targets)
    dead agents and dead plants are excluded."""
    key = point.key()
    return [e for e in _all_entities(world, living_only) if e.position.key() == key]


def rebuild_occupants(world: WorldState) -> None:
    """Recompute ``world.map.occupants`` from EVERY entity in the dicts (dead ones included,
    the UI flags them).  Called after every mutation batch."""
    occupants: dict[str, list[str]] = {}
    for entity in _all_entities(world, living_only=False):
        occupants.setdefault(entity.position.key(), []).append(entity.id)
    world.map.occupants = occupants


def living_agents(world: WorldState) -> list[Agent]:
    """Living agents in id order."""
    return [world.agents[aid] for aid in sorted(world.agents) if world.agents[aid].alive]


def can_see(world: WorldState, agent: Agent, point: Point) -> bool:
    """Manhattan distance from ``agent.position`` to ``point`` <= ``vision_range`` (no terrain
    occlusion, A-WORLD-5)."""
    return agent.position.manhattan(point) <= agent.stats.vision_range


def can_reach(world: WorldState, agent: Agent, point: Point) -> bool:
    """Manhattan distance <= ``communication_range`` (send/broadcast reach)."""
    return agent.position.manhattan(point) <= agent.stats.communication_range


def _visible_target(world: WorldState, agent: Agent, entity_id: str, use_vision: bool) -> Optional[Entity]:
    entity = find_entity(world, entity_id)
    if entity is None or not _is_present(entity):
        return None
    if use_vision and not can_see(world, agent, entity.position):
        return None
    return entity


def visible_target(world: WorldState, agent: Agent, entity_id: str) -> Optional[Entity]:
    """The entity ``entity_id`` if it exists, is present (living for agents/plants) and its
    point is within ``agent``'s vision; otherwise None.  This is the ONLY lookup used by
    entity-targeted actions (A-ACT-14): a None result is reported as ``target_gone`` so a
    caller can never learn whether an unseen id exists."""
    return _visible_target(world, agent, entity_id, use_vision=True)


def compute_initiative(world: WorldState) -> list[str]:
    """Living agent ids: sorted ascending, ``rng.shuffle`` with ``get_rng(world)``, then a
    stable sort by speed descending; the RNG state is saved back (A-SCHED-1).  Called once
    per round at round start."""
    ids = sorted(agent.id for agent in living_agents(world))
    rng = get_rng(world)
    rng.shuffle(ids)
    ids.sort(key=lambda aid: -world.agents[aid].stats.speed)
    save_rng(world, rng)
    return ids


def message_tokens(rules: RulesConfig, text: str) -> int:
    """ceil(len(text) / rules.messages.chars_per_token); the send/broadcast size measure."""
    if not text:
        return 0
    chars = max(1, rules.messages.chars_per_token)
    return math.ceil(len(text) / chars)


# ---------------------------------------------------------------------------
# Prices and quotes
# ---------------------------------------------------------------------------


def _discount(world: WorldState, via_skill: bool) -> float:
    return world.rules.skills.action_discount if via_skill else 1.0


def _useful_recovery(world: WorldState, agent: Agent, compute_budget: float) -> float:
    """Design "Health damage and recovery": the useful nominal amount, at most the budget;
    0 at full health (never charge for healing past the cap)."""
    per_compute = world.rules.recovery.health_per_compute
    missing = max(0.0, agent.stats.max_health - agent.stats.health)
    if per_compute <= 0:
        return 0.0
    return max(0.0, min(float(compute_budget), missing / per_compute))


def quote_action(world: WorldState, agent: Agent, action: WorldAction, via_skill: bool) -> ActionQuote:
    """Effective price of ``action`` for ``agent`` in the given mode.

    * move/observe/query/send/broadcast/absorb/wait: ``base_compute`` from ``rules.prices``;
      ``compute = base * rules.skills.action_discount`` when ``via_skill``.
    * transfer: ``base_compute = prices.transfer`` (the FEE); ``required_compute = compute +
      amount`` for a compute transfer, ``required_essence = amount`` for an essence transfer.
      The transferred amount is never discounted and never a "cost".
    * recover: ``base_compute = min(compute_budget, (max_health - health) / health_per_compute)``
      (useful nominal amount; 0 at full health); discounted in a skill.
    * attack: ``base_compute = compute_budget``; discounted in a skill; damage is
      ``attack * compute_budget`` regardless of discount.
    * upgrade: from ``upgrade_quotes``; ``essence`` never discounted; ``allowed`` copied.
    * ``attempt_fee = min(rules.accounting.failure_fee_cap, base_compute) * (discount if via_skill else 1)``
      (both modes).
    ``required_*`` default to ``compute``/``essence`` when nothing is transferred.
    """
    name = action.name
    args = action.args
    discount = _discount(world, via_skill)
    prices = world.rules.prices
    essence = 0.0
    allowed = True
    extra_compute = 0.0
    extra_essence = 0.0

    if name == "transfer":
        base = float(prices.transfer)
        if args.resource == "compute":
            extra_compute = float(args.amount)
        else:
            extra_essence = float(args.amount)
    elif name == "recover":
        base = _useful_recovery(world, agent, args.compute_budget)
    elif name == "attack":
        base = float(args.compute_budget)
    elif name == "upgrade":
        quote = upgrade_quotes(world, agent, via_skill)[args.attribute]
        base = float(quote["base_compute"])
        essence = float(quote["essence"])
        allowed = bool(quote["allowed"])
    else:
        base = float(getattr(prices, name))

    compute = base * discount
    fee = min(world.rules.accounting.failure_fee_cap, base) * discount
    return ActionQuote(
        action=name,
        via_skill=via_skill,
        base_compute=base,
        compute=compute,
        essence=essence,
        required_compute=compute + extra_compute,
        required_essence=essence + extra_essence,
        attempt_fee=fee,
        allowed=allowed,
    )


def _upgrade_next_value(attribute: str, value: float, increment: float, cap: Optional[float]) -> Any:
    """``min(cap, value + increment)``; int for INTEGER_STATS, 9 decimals for fractions."""
    nxt = value + increment
    if cap is not None:
        nxt = min(cap, nxt)
    if attribute in INTEGER_STATS:
        return int(round(nxt))
    if attribute in FRACTION_STATS:
        return round(nxt, FRACTION_DECIMALS)
    return float(nxt)


def upgrade_quotes(world: WorldState, agent: Agent, via_skill: bool) -> dict[str, dict[str, Any]]:
    """Per attribute: ``{base_compute, skill_compute, compute, essence, next_value, allowed}``.

    ``compute`` is the effective price in the current mode.  Prices: standard
    ``base * growth**n``, attack ``attack_base * attack_growth**n`` with ``n =
    upgrade_counts[attr]``.  At a hard cap (``value >= cap - eps``): prices still show the
    formula for display, ``next_value = current value`` and ``allowed = False`` (A-ACT-18).
    Otherwise ``next_value = min(cap, value + increment)`` (rounded to 9 decimals for the
    absorption fractions; ``int`` for INTEGER_STATS).
    """
    schedule = world.rules.upgrades
    discount = world.rules.skills.action_discount
    eps = _eps(world)
    quotes: dict[str, dict[str, Any]] = {}
    for attribute in UPGRADE_ATTRIBUTES:
        count = int(agent.upgrade_counts.get(attribute, 0))
        if attribute == "attack":
            growth = schedule.attack_growth ** count
            base = schedule.attack_base_compute * growth
            essence = schedule.attack_base_essence * growth
        else:
            growth = schedule.standard_growth ** count
            base = schedule.standard_base_compute * growth
            essence = schedule.standard_base_essence * growth
        value = getattr(agent.stats, attribute)
        cap = schedule.hard_caps.get(attribute)
        increment = schedule.increments.get(attribute)
        allowed = increment is not None and increment > 0
        if cap is not None and value >= cap - eps:
            allowed = False
        next_value = _upgrade_next_value(attribute, value, increment, cap) if allowed else value
        quotes[attribute] = {
            "base_compute": float(base),
            "skill_compute": float(base) * discount,
            "compute": float(base) * (discount if via_skill else 1.0),
            "essence": float(essence),
            "next_value": next_value,
            "allowed": allowed,
        }
    return quotes


def _costs_block(world: WorldState) -> dict[str, Any]:
    """``query(self).data.costs`` (design "Observe query and action feedback")."""
    rules = world.rules
    normal = {k: float(v) for k, v in rules.prices.model_dump().items()}
    discount = rules.skills.action_discount
    return {
        "normal": normal,
        "skill": {k: v * discount for k, v in normal.items()},
        "discount": discount,
        "recovery_health_per_compute": rules.recovery.health_per_compute,
        "upkeep_per_round": rules.upkeep.compute_per_round,
        "interpreter_cost_per_op": rules.skills.interpreter_cost_per_op,
        "max_ops_per_turn": rules.skills.max_ops_per_turn,
        "failure_fee_cap": rules.accounting.failure_fee_cap,
        "cognition": {
            "input_rate": rules.cognition.input_rate,
            "generation_rate": rules.cognition.generation_rate,
        },
    }


def self_query_data(world: WorldState, agent: Agent, via_skill: bool) -> dict[str, Any]:
    """The ``query(self)`` data block (design doc query table) using POST-payment balances.

    Keys: position, health, max_health, compute, essence, essence_capacity, attack,
    speed, vision_range, communication_range, compute_absorption, essence_absorption,
    skill_count_limit, skill_block_limit, costs, upgrade_quotes, quote_mode ("direct" |
    "skill"), round.
    ``costs`` = {normal: {...prices}, skill: {...prices*discount}, discount,
    recovery_health_per_compute, upkeep_per_round, interpreter_cost_per_op,
    max_ops_per_turn, failure_fee_cap, cognition: {input_rate, generation_rate}}.
    """
    stats = agent.stats
    return {
        "position": _point_dict(agent.position),
        "health": stats.health,
        "max_health": stats.max_health,
        "compute": stats.compute,
        "essence": stats.essence,
        "essence_capacity": stats.essence_capacity,
        "attack": stats.attack,
        "speed": stats.speed,
        "vision_range": stats.vision_range,
        "communication_range": stats.communication_range,
        "compute_absorption": stats.compute_absorption,
        "essence_absorption": stats.essence_absorption,
        "skill_count_limit": stats.skill_count_limit,
        "skill_block_limit": stats.skill_block_limit,
        "costs": _costs_block(world),
        "upgrade_quotes": upgrade_quotes(world, agent, via_skill),
        "quote_mode": "skill" if via_skill else "direct",
        "round": world.round,
    }


def _can_absorb(entity: Entity, resource: str, eps: float) -> bool:
    """Source-intrinsic eligibility: the resource kind is eligible for that entity kind AND
    the available amount is > eps.  Fruit carries compute only; residue carries both."""
    if entity.kind == "fruit" and resource == "essence":
        return False
    if entity.kind not in ("fruit", "residue"):
        return False
    available = entity.available_compute if resource == "compute" else entity.available_essence
    return available > eps


def public_entity_data(world: WorldState, viewer: Agent, entity: Entity, round_no: int) -> dict[str, Any]:
    """What ``query(entity_id)`` returns for a non-self entity (A-ACT-5), as seen by ``viewer``:

    agent: id, name, kind, position, health, max_health, attack, speed, alive, round
    plant: id, kind, position, species, stage_index, stage_name, size, alive,
           vitality (=essence), fruit_ids, seed_ids (both filtered to entities the viewer
           can see), round
    fruit/residue: id, kind, position, available_compute, available_essence,
                   can_absorb_compute, can_absorb_essence (source-intrinsic: the resource
                   kind is eligible for that entity kind AND available > eps), round
    seed: id, kind, position, species, round (no germination time)
    """
    base = {"id": entity.id, "kind": entity.kind, "position": _point_dict(entity.position), "round": round_no}
    if entity.kind == "agent":
        base.update(
            {
                "name": entity.name,
                "health": entity.stats.health,
                "max_health": entity.stats.max_health,
                "attack": entity.stats.attack,
                "speed": entity.stats.speed,
                "alive": entity.alive,
            }
        )
        return base
    if entity.kind == "plant":
        rule = world.rules.plant_species.get(entity.species)
        stage_name = _stage_rule(rule, entity.stage_index).name if rule is not None else "unknown"

        def visible_ids(ids: list[str], table: dict[str, Any]) -> list[str]:
            return [i for i in ids if i in table and can_see(world, viewer, table[i].position)]

        base.update(
            {
                "species": entity.species,
                "stage_index": entity.stage_index,
                "stage_name": stage_name,
                "size": entity.size,
                "alive": entity.alive,
                "vitality": entity.essence,
                "fruit_ids": visible_ids(entity.fruit_ids, world.fruits),
                "seed_ids": visible_ids(entity.seed_ids, world.seeds),
            }
        )
        return base
    if entity.kind in ("fruit", "residue"):
        eps = _eps(world)
        base.update(
            {
                "available_compute": entity.available_compute,
                "available_essence": entity.available_essence,
                "can_absorb_compute": _can_absorb(entity, "compute", eps),
                "can_absorb_essence": _can_absorb(entity, "essence", eps),
            }
        )
        return base
    base["species"] = entity.species
    return base


# ---------------------------------------------------------------------------
# Notices and events shared by actions and round end
# ---------------------------------------------------------------------------


def _damage_notice(
    victim: Agent,
    amount: float,
    attacker_id: Optional[str],
    attacker_visible: bool,
    health_after: float,
    cause: str,
    died: bool = False,
) -> Notice:
    """KnowledgeRecord kind ``damage``: ``{amount, attacker, health_after, cause}``."""
    if cause == "attack":
        who = f"from {attacker_id}" if attacker_visible and attacker_id else "from an unknown attacker"
        text = f"Took {_fmt(amount)} damage {who}"
        source = f"agent:{attacker_id}" if attacker_visible and attacker_id else "unknown"
    elif cause == "starvation":
        text = f"Upkeep unpaid: lost {_fmt(amount)} health to starvation"
        source = "world"
    else:
        text = f"Lost {_fmt(amount)} health ({cause})"
        source = "world" if cause != "operator" else "operator"
    text += "; you died." if died else f"; health now {_fmt(health_after)}."
    tags = ["damage", cause, victim.position.key()]
    if attacker_visible and attacker_id:
        tags.append(attacker_id)
    return Notice(
        agent_id=victim.id,
        kind="damage",
        provenance=Provenance(source=source),
        text=text,
        content={
            "amount": amount,
            "attacker": attacker_id if attacker_visible else None,
            "health_after": health_after,
            "cause": cause,
        },
        tags=tags,
    )


def _message_notice(world: WorldState, sender: Agent, recipient: Agent, text: str, broadcast: bool) -> Notice:
    """KnowledgeRecord kind ``message`` with the unknown-source rule (A-KNOW-3): the sender id
    is disclosed only when the recipient can see the sender's point."""
    sender_visible = can_see(world, recipient, sender.position)
    label = sender.id if sender_visible else "unknown source"
    kind_word = "Broadcast" if broadcast else "Message"
    tags = ["message", "broadcast" if broadcast else "direct"]
    if sender_visible:
        tags.append(sender.id)
    return Notice(
        agent_id=recipient.id,
        kind="message",
        provenance=Provenance(source=f"agent:{sender.id}" if sender_visible else "unknown", sender_visible=sender_visible),
        text=f"{kind_word} from {label}: {json.dumps(text)}",
        content={
            "text": text,
            "sender": sender.id if sender_visible else None,
            "sender_visible": sender_visible,
            "broadcast": broadcast,
        },
        tags=tags,
    )


def _create_residue(
    world: WorldState, source_id: str, source_kind: str, position: Point, compute: float, essence: float
) -> Optional[Residue]:
    """Residue only when at least one amount is > eps (A-DEATH-6); amounts below eps are 0."""
    eps = _eps(world)
    compute = _clean(compute, eps)
    essence = _clean(essence, eps)
    if compute <= 0 and essence <= 0:
        return None
    residue_id = new_entity_id(world, "residue")
    residue = Residue(
        id=residue_id,
        position=position.model_copy(),
        source_id=source_id,
        source_kind=source_kind,
        available_compute=compute,
        available_essence=essence,
        created_round=world.round,
    )
    world.residues[residue_id] = residue
    return residue


def _residue_event(residue: Residue) -> EventDraft:
    return EventDraft(
        actor="world",
        kind="residue_created",
        summary=(
            f"residue {residue.id} left by {residue.source_id} at {_fmt_point(residue.position)}: "
            f"{_fmt(residue.available_compute)} compute, {_fmt(residue.available_essence)} essence"
        ),
        details={
            "residue_id": residue.id,
            "source_id": residue.source_id,
            "compute": residue.available_compute,
            "essence": residue.available_essence,
            "position": _point_dict(residue.position),
        },
    )


def _synthetic_ok(world: WorldState) -> ActionResult:
    return ActionResult(ok=True, reason="ok", round=world.round)


def _resolve_agent_death(
    world: WorldState,
    agent: Agent,
    cause: str,
    attacker_id: Optional[str] = None,
    attacker_visible: bool = False,
    amount: float = 0.0,
) -> ActionOutcome:
    """Design "Agent death and essence residue": death is resolved once.  Residue essence =
    essence x death.essence_residue_fraction, residue compute = compute x
    death.compute_residue_fraction (A-DEATH-1/2); the remainder is lost; balances -> 0."""
    if not agent.alive:
        return ActionOutcome(result=_synthetic_ok(world))
    death = world.rules.death
    residue = _create_residue(
        world,
        agent.id,
        "agent",
        agent.position,
        agent.stats.compute * death.compute_residue_fraction,
        agent.stats.essence * death.essence_residue_fraction,
    )
    agent.alive = False
    agent.died_round = world.round
    agent.death_cause = cause
    agent.stats.health = 0.0
    agent.stats.compute = 0.0
    agent.stats.essence = 0.0
    agent.wait_turns_remaining = 0
    execution = agent.skill_execution
    if execution is not None and execution.status in ("running", "awaiting_action_result"):
        execution.status = "stopped"
        execution.last_error = "operator" if cause == "operator" else "death"
        execution.pending_action = None
    events = [
        EventDraft(
            actor="world",
            kind="death",
            summary=f"{agent.name} ({agent.id}) died of {cause}"
            + (f"; residue {residue.id}" if residue else "; nothing remained"),
            details={"entity_id": agent.id, "kind": "agent", "cause": cause, "residue_id": residue.id if residue else None},
        )
    ]
    if residue is not None:
        events.append(_residue_event(residue))
    notice = _damage_notice(agent, amount, attacker_id, attacker_visible, 0.0, cause, died=True)
    return ActionOutcome(result=_synthetic_ok(world), events=events, notices=[notice], deaths=[agent.id])


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------


@dataclass
class _Applied:
    """What a successful action produced (filled by the per-action apply closures)."""

    data: dict[str, Any] = field(default_factory=dict)
    effects: dict[str, Any] = field(default_factory=dict)
    events: list[EventDraft] = field(default_factory=list)
    notices: list[Notice] = field(default_factory=list)
    deaths: list[str] = field(default_factory=list)
    detail: str = ""


# A plan is (failure reason or None, apply closure or None).  Legality is checked when the
# plan is built (before any debit); the closure applies the effects after the debit.
_Plan = tuple[Optional[str], Optional[Callable[[], _Applied]]]


def _check_message(world: WorldState, text: str) -> Optional[str]:
    """Design "Action blocks": non-empty and at most ``max_message_tokens`` (A-ACT-3)."""
    if not text or not text.strip():
        return "invalid_argument"
    if message_tokens(world.rules, text) > world.rules.messages.max_message_tokens:
        return "invalid_argument"
    return None


def _observe_page_size(world: WorldState) -> int:
    """A-ACT-4: the page size the run was created with (``WorldState.observation_page_size``)."""
    return max(1, world.observation_page_size)


def _plan_move(world: WorldState, agent: Agent, args: Any) -> _Plan:
    """Design "Spawned terrain and passage": mountains block, water is ordinary passage,
    outside the region is blocked (A-ACT-2; the reason is out_of_range when the flag is off)."""
    destination = agent.position.moved(args.direction)
    terrain = terrain_at(world, destination)
    if terrain is None:
        return ("blocked" if world.rules.ranges.outside_region_is_blocked else "out_of_range"), None
    if terrain == "mountain":
        return "blocked", None

    def apply() -> _Applied:
        origin = agent.position
        agent.position = destination
        return _Applied(
            effects={"from": _point_dict(origin), "to": _point_dict(destination)},
            detail=f"{_fmt_point(origin)} -> {_fmt_point(destination)}",
        )

    return None, apply


def _plan_observe(world: WorldState, agent: Agent, args: Any) -> _Plan:
    if args.page < 0:
        return "invalid_argument", None
    point = args.point
    if world.rules.ranges.observe_uses_vision_range and not can_see(world, agent, point):
        return "out_of_range", None

    def apply() -> _Applied:
        terrain = terrain_at(world, point)
        listing = entities_at(world, point, living_only=True) if terrain is not None else []
        page_size = _observe_page_size(world)
        start = args.page * page_size
        entries = [
            {"id": e.id, "kind": e.kind, "position": _point_dict(e.position)} for e in listing[start : start + page_size]
        ]
        data = {
            "point": _point_dict(point),
            "terrain": terrain,
            "entities": entries,
            "observed_round": world.round,
            "page": args.page,
            "page_size": page_size,
            "total_entities": len(listing),
            "has_more": start + page_size < len(listing),
        }
        return _Applied(data=data, detail=f"{terrain or 'outside region'}, {len(listing)} entities")

    return None, apply


def _plan_query(world: WorldState, agent: Agent, args: Any, via_skill: bool) -> _Plan:
    if args.entity == "self" or args.entity == agent.id:

        def apply_self() -> _Applied:
            return _Applied(data=self_query_data(world, agent, via_skill), detail="self")

        return None, apply_self
    target = _visible_target(world, agent, args.entity, world.rules.ranges.query_uses_vision_range)
    if target is None:
        return "target_gone", None

    def apply() -> _Applied:
        return _Applied(data=public_entity_data(world, agent, target, world.round), detail=target.kind)

    return None, apply


def _delivery_event(sender: Agent, notices: list[Notice], broadcast: bool) -> EventDraft:
    recipients = [n.agent_id for n in notices]
    return EventDraft(
        actor=sender.id,
        kind="message_delivered",
        summary=("broadcast" if broadcast else "message") + f" delivered to {', '.join(recipients) or 'nobody'}",
        details={
            "recipients": recipients,
            "broadcast": broadcast,
            "sender_visible_to": {n.agent_id: bool(n.provenance.sender_visible) for n in notices},
        },
    )


def _plan_send(world: WorldState, agent: Agent, args: Any) -> _Plan:
    reason = _check_message(world, args.message)
    if reason:
        return reason, None
    if args.recipient == agent.id:
        return "invalid_argument", None
    target = visible_target(world, agent, args.recipient)
    if target is None:
        return "target_gone", None
    if target.kind != "agent":
        return "invalid_argument", None
    if not can_reach(world, agent, target.position):
        return "out_of_range", None

    def apply() -> _Applied:
        notice = _message_notice(world, agent, target, args.message, broadcast=False)
        return _Applied(
            data={"delivered_to": target.id},
            effects={"delivered": 1},
            events=[_delivery_event(agent, [notice], broadcast=False)],
            notices=[notice],
            detail=f"delivered to {target.id}",
        )

    return None, apply


def _plan_broadcast(world: WorldState, agent: Agent, args: Any) -> _Plan:
    reason = _check_message(world, args.message)
    if reason:
        return reason, None

    def apply() -> _Applied:
        recipients = [
            other for other in living_agents(world) if other.id != agent.id and can_reach(world, agent, other.position)
        ]
        notices = [_message_notice(world, agent, other, args.message, broadcast=True) for other in recipients]
        visible = [other.id for other in recipients if can_see(world, agent, other.position)]
        return _Applied(
            data={"delivered_to_visible": visible},
            effects={"delivered_visible": len(visible)},
            events=[_delivery_event(agent, notices, broadcast=True)],
            notices=notices,
            detail=f"{len(visible)} visible recipients",
        )

    return None, apply


def _plan_absorb(world: WorldState, agent: Agent, args: Any) -> _Plan:
    """Design "Absorption efficiency": process the maximum eligible amount; compute is
    processed entirely, essence only up to what fills the free capacity; the lost fraction is
    destroyed; fail rather than destroy for zero gain (A-ACT-16/17)."""
    eps = _eps(world)
    source = visible_target(world, agent, args.source)
    if source is None:
        return "target_gone", None
    if source.kind not in ("fruit", "residue"):
        return "invalid_argument", None
    if world.rules.ranges.absorb_requires_same_point and source.position.key() != agent.position.key():
        return "out_of_range", None
    resource = args.resource
    available = source.available_compute if resource == "compute" else source.available_essence
    if resource == "essence" and source.kind == "fruit":
        available = 0.0
    if available < eps:
        return "empty_source", None
    efficiency = agent.stats.compute_absorption if resource == "compute" else agent.stats.essence_absorption
    if resource == "essence":
        free = agent.stats.essence_capacity - agent.stats.essence
        if free < eps:
            return "at_limit", None
        raw = min(available, free / efficiency) if efficiency > 0 else 0.0
        gained = min(raw * efficiency, free)
    else:
        raw = available
        gained = raw * efficiency
    if gained < eps:
        return "at_limit", None

    def apply() -> _Applied:
        if resource == "compute":
            source.available_compute = _clean(source.available_compute - raw, eps)
            agent.stats.compute = agent.stats.compute + gained
        else:
            source.available_essence = _clean(source.available_essence - raw, eps)
            agent.stats.essence = min(agent.stats.essence_capacity, agent.stats.essence + gained)
        return _Applied(
            effects={"processed": raw, "gained": gained, "lost": raw - gained, "source": source.id, "resource": resource},
            detail=f"gained {_fmt(gained)} {resource}, lost {_fmt(raw - gained)}",
        )

    return None, apply


def _plan_transfer(world: WorldState, agent: Agent, args: Any) -> _Plan:
    """Design "Action blocks": voluntary transfer; the caller covers amount plus fee; an
    essence recipient needs capacity for the full amount; never partial (A-ACT-6)."""
    eps = _eps(world)
    if not math.isfinite(args.amount) or args.amount <= 0:
        return "invalid_argument", None
    if args.recipient == agent.id:
        return "invalid_argument", None
    target = visible_target(world, agent, args.recipient)
    if target is None:
        return "target_gone", None
    if target.kind != "agent":
        return "invalid_argument", None
    if world.rules.ranges.transfer_requires_same_point and target.position.key() != agent.position.key():
        return "out_of_range", None
    if args.resource == "essence":
        free = target.stats.essence_capacity - target.stats.essence
        if free + eps < args.amount:
            return "at_limit", None

    def apply() -> _Applied:
        amount = float(args.amount)
        if args.resource == "compute":
            agent.stats.compute = _clean(agent.stats.compute - amount, eps)
            target.stats.compute = target.stats.compute + amount
        else:
            agent.stats.essence = _clean(agent.stats.essence - amount, eps)
            target.stats.essence = min(target.stats.essence_capacity, target.stats.essence + amount)
        sender_visible = can_see(world, target, agent.position)
        label = agent.id if sender_visible else "unknown"
        notice = Notice(
            agent_id=target.id,
            kind="system",
            provenance=Provenance(source=f"agent:{agent.id}" if sender_visible else "unknown", sender_visible=sender_visible),
            text=f"received {_fmt(amount)} {args.resource} from {label}",
            content={
                "text": f"received {_fmt(amount)} {args.resource} from {label}",
                "amount": amount,
                "resource": args.resource,
                "from": agent.id if sender_visible else None,
            },
            tags=["transfer", args.resource] + ([agent.id] if sender_visible else []),
        )
        return _Applied(
            effects={"transferred": amount, "resource": args.resource, "to": target.id},
            notices=[notice],
            detail=f"{_fmt(amount)} {args.resource} to {target.id}",
        )

    return None, apply


def _plan_recover(world: WorldState, agent: Agent, args: Any, quote: ActionQuote) -> _Plan:
    """Design "Health damage and recovery": heal useful x health_per_compute, never past
    max_health; a zero-cost no-op at full health."""

    def apply() -> _Applied:
        healed_nominal = quote.base_compute * world.rules.recovery.health_per_compute
        before = agent.stats.health
        agent.stats.health = min(agent.stats.max_health, agent.stats.health + healed_nominal)
        healed = agent.stats.health - before
        return _Applied(
            effects={"healed": healed, "health": agent.stats.health},
            detail=f"healed {_fmt(healed)} to {_fmt(agent.stats.health)}",
        )

    return None, apply


def _plan_attack(world: WorldState, agent: Agent, args: Any) -> _Plan:
    """Design "Conflict injury": damage = attack x nominal budget; agent death at health <= 0
    resolved immediately; plants lose living essence, lethal at <= 0 with residue from the
    pre-hit essence (A-PLANT-5)."""
    eps = _eps(world)
    if args.target == agent.id:
        return "invalid_argument", None
    target = visible_target(world, agent, args.target)
    if target is None:
        return "target_gone", None
    if target.kind not in ("agent", "plant"):
        return "invalid_argument", None
    if world.rules.ranges.attack_requires_same_point and target.position.key() != agent.position.key():
        return "out_of_range", None

    def apply() -> _Applied:
        damage = agent.stats.attack * float(args.compute_budget)
        events: list[EventDraft] = []
        notices: list[Notice] = []
        deaths: list[str] = []
        if target.kind == "agent":
            victim: Agent = target
            victim.stats.health = victim.stats.health - damage
            killed = victim.stats.health <= eps
            if killed:
                victim.stats.health = 0.0
            health_after = victim.stats.health
            attacker_visible = can_see(world, victim, agent.position)
            events.append(
                EventDraft(
                    actor=agent.id,
                    kind="damage",
                    summary=f"{agent.id} hits {victim.id} for {_fmt(damage)} (health {_fmt(health_after)})",
                    details={"target": victim.id, "amount": damage, "health_after": health_after, "cause": "attack"},
                )
            )
            if killed:
                outcome = _resolve_agent_death(world, victim, "attack", agent.id, attacker_visible, damage)
                events.extend(outcome.events)
                notices.extend(outcome.notices)
                deaths.extend(outcome.deaths)
            else:
                notices.append(_damage_notice(victim, damage, agent.id, attacker_visible, health_after, "attack"))
        else:
            plant: Plant = target
            pre_hit = plant.essence
            remaining = plant.essence - damage
            killed = remaining <= eps
            health_after = 0.0 if killed else remaining
            events.append(
                EventDraft(
                    actor=agent.id,
                    kind="damage",
                    summary=f"{agent.id} hits plant {plant.id} for {_fmt(damage)} (vitality {_fmt(health_after)})",
                    details={"target": plant.id, "amount": damage, "health_after": health_after, "cause": "attack"},
                )
            )
            if killed:
                outcome = kill_plant(world, plant.id, "attack", pre_hit_essence=pre_hit)
                events.extend(outcome.events)
                deaths.extend(outcome.deaths)
            else:
                plant.essence = remaining
        return _Applied(
            effects={"damage": damage, "target": target.id, "target_health_after": health_after, "killed": killed},
            events=events,
            notices=notices,
            deaths=deaths,
            detail=f"{_fmt(damage)} damage to {target.id}" + (", killed" if killed else ""),
        )

    return None, apply


def _plan_upgrade(world: WorldState, agent: Agent, args: Any, quote: ActionQuote, via_skill: bool) -> _Plan:
    """Design "Upgradeable attributes and prices": exactly one increment; the stat changes
    atomically after payment; caps are raised, balances never filled."""
    attribute = args.attribute
    detail_quote = upgrade_quotes(world, agent, via_skill)[attribute]

    def apply() -> _Applied:
        new_value = detail_quote["next_value"]
        setattr(agent.stats, attribute, new_value)
        agent.upgrade_counts[attribute] = int(agent.upgrade_counts.get(attribute, 0)) + 1
        return _Applied(
            data={"attribute": attribute, "new_value": new_value, "purchase_count": agent.upgrade_counts[attribute]},
            effects={"purchased": attribute, "new_value": new_value, "compute": quote.compute, "essence": quote.essence},
            detail=f"{attribute} -> {_fmt(new_value)}",
        )

    return None, apply


def _plan_wait(world: WorldState, agent: Agent, args: Any) -> _Plan:
    """A-ACT-7: this turn is the first waited turn; ``rounds - 1`` more are skipped."""
    if args.rounds < 1:
        return "invalid_argument", None

    def apply() -> _Applied:
        agent.wait_turns_remaining = int(args.rounds) - 1
        return _Applied(effects={"waiting_turns": int(args.rounds)}, detail=f"{args.rounds} turns")

    return None, apply


def _build_plan(world: WorldState, agent: Agent, action: WorldAction, quote: ActionQuote, via_skill: bool) -> _Plan:
    name = action.name
    args = action.args
    if name == "move":
        return _plan_move(world, agent, args)
    if name == "observe":
        return _plan_observe(world, agent, args)
    if name == "query":
        return _plan_query(world, agent, args, via_skill)
    if name == "send":
        return _plan_send(world, agent, args)
    if name == "broadcast":
        return _plan_broadcast(world, agent, args)
    if name == "absorb":
        return _plan_absorb(world, agent, args)
    if name == "transfer":
        return _plan_transfer(world, agent, args)
    if name == "recover":
        return _plan_recover(world, agent, args, quote)
    if name == "attack":
        return _plan_attack(world, agent, args)
    if name == "upgrade":
        return _plan_upgrade(world, agent, args, quote, via_skill)
    if name == "wait":
        return _plan_wait(world, agent, args)
    raise WorldError(f"unknown action {name!r}")


def _args_summary(world: WorldState, action: WorldAction) -> str:
    name = action.name
    args = action.args
    if name == "move":
        return args.direction
    if name == "observe":
        return _fmt_point(args.point) + (f" page {args.page}" if args.page else "")
    if name == "query":
        return args.entity
    if name == "send":
        return f"to {args.recipient} ({message_tokens(world.rules, args.message)} tokens)"
    if name == "broadcast":
        return f"({message_tokens(world.rules, args.message)} tokens)"
    if name == "absorb":
        return f"{args.resource} from {args.source}"
    if name == "transfer":
        return f"{_fmt(args.amount)} {args.resource} to {args.recipient}"
    if name == "recover":
        return f"budget {_fmt(args.compute_budget)}"
    if name == "attack":
        return f"{args.target} budget {_fmt(args.compute_budget)}"
    if name == "upgrade":
        return args.attribute
    if name == "wait":
        return f"{args.rounds} rounds"
    return ""


def _quote_is_finite(quote: ActionQuote) -> bool:
    return all(
        math.isfinite(v)
        for v in (
            quote.base_compute,
            quote.compute,
            quote.essence,
            quote.required_compute,
            quote.required_essence,
            quote.attempt_fee,
        )
    )


def _charge(agent: Agent, compute: float, essence: float, eps: float) -> None:
    """Debit a charge; balances never go negative or keep a sub-eps remainder."""
    if compute:
        agent.stats.compute = _clean(agent.stats.compute - compute, eps)
    if essence:
        agent.stats.essence = _clean(agent.stats.essence - essence, eps)


def apply_action(world: WorldState, request: ActionRequest) -> ActionOutcome:
    """Validate and apply exactly one world action atomically.

    Order of checks (first failure wins; docs/INTERFACES.md "Action semantics"):
      1. actor exists and is alive -> "dead" (no charge).
      2. arguments that make the quote uncomputable (non-finite numbers that slipped past
         the format gate) -> "invalid_argument", NO charge.
      3. upgrade only: quote.allowed is False -> "at_limit" with the attempt fee when the
         fee is affordable, else "insufficient_compute" with no debit (A-ACT-18).
      4. affordability of ``required_compute`` / ``required_essence`` ->
         "insufficient_compute" / "insufficient_essence", NO debit.
      5. legality (target visibility -> "target_gone"; self-target / wrong entity kind /
         over-long or empty message / page < 0 -> "invalid_argument"; range -> "out_of_range";
         terrain -> "blocked"; empty_source; at_limit) -> charge ONLY the attempt fee, no
         essence.
      6. success: debit ``compute``/``essence`` (the charge) and move any transferred amount,
         apply effects, ``reason = "ok"``.
    Failed attempts never change any state except the actor's compute (fee).
    ``result.cost_compute`` / ``cost_essence`` are the CHARGE (fee or price), never the
    transferred amount (which appears only in ``effects.transferred``); the same holds for
    the action event's costs and ``agent.total_compute_spent``.
    Successful results fill ``data`` (observe/query) and ``effects`` without leaking hidden
    state.  ``result.round`` is the current world round.  ``events`` contains one "action"
    event plus any damage/death/message_delivered/residue_created events; ``notices`` carry
    messages/damage/transfers to OTHER agents (the actor learns from the result itself).
    Also updates ``agent.last_action``/``last_result``/``total_compute_spent`` and rebuilds
    occupants.  ``via_skill`` selects the discounted quote.
    """
    agent = world.agents.get(request.agent_id)
    if agent is None:
        raise WorldError(f"unknown actor {request.agent_id!r}")
    action = request.action
    name = action.name
    args_dict = action.args.model_dump(mode="json")
    eps = _eps(world)
    round_no = world.round

    def finish(
        ok: bool,
        reason: str,
        cost_compute: float = 0.0,
        cost_essence: float = 0.0,
        applied: Optional[_Applied] = None,
    ) -> ActionOutcome:
        applied = applied or _Applied()
        result = ActionResult(
            ok=ok,
            reason=reason,
            cost_compute=cost_compute,
            cost_essence=cost_essence,
            round=round_no,
            data=applied.data,
            effects=applied.effects,
        )
        agent.last_action = {"name": name, "args": args_dict}
        agent.last_result = result
        agent.total_compute_spent += cost_compute
        summary = f"{agent.id} {name} {_args_summary(world, action)} -> {reason}"
        if applied.detail:
            summary += f": {applied.detail}"
        summary += f" (cost {_fmt(cost_compute)}" + (f" + {_fmt(cost_essence)} essence" if cost_essence else "") + ")"
        action_event = EventDraft(
            actor=agent.id,
            kind="action",
            summary=summary,
            details={
                "action": {"name": name, "args": args_dict},
                "result": result.model_dump(mode="json"),
                "via_skill": request.via_skill,
                "skill_name": request.skill_name,
            },
            costs=EventCosts(compute=cost_compute, essence=cost_essence),
        )
        rebuild_occupants(world)
        return ActionOutcome(
            result=result,
            events=[action_event] + applied.events,
            notices=applied.notices,
            deaths=applied.deaths,
        )

    # 1. alive
    if not agent.alive:
        return finish(False, "dead")

    # 2. computable quote
    try:
        quote = quote_action(world, agent, action, request.via_skill)
    except (OverflowError, ValueError, ZeroDivisionError):
        return finish(False, "invalid_argument")
    if not _quote_is_finite(quote):
        return finish(False, "invalid_argument")

    # 3. upgrade at a hard cap (A-ACT-18)
    if name == "upgrade" and not quote.allowed:
        if agent.stats.compute + eps >= quote.attempt_fee:
            _charge(agent, quote.attempt_fee, 0.0, eps)
            return finish(False, "at_limit", cost_compute=quote.attempt_fee)
        return finish(False, "insufficient_compute")

    # 4. affordability (no debit)
    if agent.stats.compute + eps < quote.required_compute:
        return finish(False, "insufficient_compute")
    if agent.stats.essence + eps < quote.required_essence:
        return finish(False, "insufficient_essence")

    # 5. legality (attempt fee only)
    reason, apply = _build_plan(world, agent, action, quote, request.via_skill)
    if reason is not None or apply is None:
        _charge(agent, quote.attempt_fee, 0.0, eps)
        return finish(False, reason or "invalid_argument", cost_compute=quote.attempt_fee)

    # 6. success: debit the charge, then apply
    _charge(agent, quote.compute, quote.essence, eps)
    applied = apply()
    return finish(True, "ok", cost_compute=quote.compute, cost_essence=quote.essence, applied=applied)


def kill_agent(world: WorldState, agent_id: str, cause: str) -> ActionOutcome:
    """Resolve an agent death once: ``alive=False``, ``died_round``, ``death_cause``, health
    clamped to 0, its skill execution stopped, a residue with ``essence *
    essence_residue_fraction`` and ``compute * compute_residue_fraction`` created ONLY when
    at least one of them is > eps (the death event's residue_id is null otherwise), the
    agent's balances zeroed, "death" and "residue_created" events and a "damage" notice
    (health_after 0, cause) for the victim.  Returns an ActionOutcome with a synthetic ok
    result (unused).  No-op if already dead.  The agent record stays in ``world.agents``.
    """
    agent = world.agents.get(agent_id)
    if agent is None:
        raise WorldError(f"unknown agent {agent_id!r}")
    outcome = _resolve_agent_death(world, agent, cause)
    rebuild_occupants(world)
    return outcome


def kill_plant(world: WorldState, plant_id: str, cause: str, pre_hit_essence: float) -> ActionOutcome:
    """Plant death (A-PLANT-5): residue essence = ``pre_hit_essence * species.essence_residue_fraction``,
    residue compute = ``energy * energy_residue_fraction`` (residue created only when > eps);
    plant.essence/energy -> 0, ``alive=False``; existing fruit stays; growth stops.  Emits
    death/residue_created events.  The plant record stays in ``world.plants``."""
    plant = world.plants.get(plant_id)
    if plant is None:
        raise WorldError(f"unknown plant {plant_id!r}")
    if not plant.alive:
        return ActionOutcome(result=_synthetic_ok(world))
    rule = _species_rule(world, plant.species)
    residue = _create_residue(
        world,
        plant.id,
        "plant",
        plant.position,
        plant.energy * rule.energy_residue_fraction,
        max(0.0, pre_hit_essence) * rule.essence_residue_fraction,
    )
    plant.essence = 0.0
    plant.energy = 0.0
    plant.alive = False
    plant.died_round = world.round
    plant.death_cause = cause
    events = [
        EventDraft(
            actor="world",
            kind="death",
            summary=f"plant {plant.id} died of {cause}" + (f"; residue {residue.id}" if residue else "; nothing remained"),
            details={"entity_id": plant.id, "kind": "plant", "cause": cause, "residue_id": residue.id if residue else None},
        )
    ]
    if residue is not None:
        events.append(_residue_event(residue))
    rebuild_occupants(world)
    return ActionOutcome(result=_synthetic_ok(world), events=events, deaths=[plant.id])


# ---------------------------------------------------------------------------
# Round end
# ---------------------------------------------------------------------------


def _live_fruit_count(world: WorldState, plant: Plant) -> int:
    return sum(1 for fruit in world.fruits.values() if fruit.plant_id == plant.id)


def _live_seed_count(world: WorldState, plant: Plant) -> int:
    return sum(1 for seed in world.seeds.values() if seed.plant_id == plant.id)


def _prune_references(world: WorldState, plant: Plant) -> None:
    plant.fruit_ids = [i for i in plant.fruit_ids if i in world.fruits]
    plant.seed_ids = [i for i in plant.seed_ids if i in world.seeds]


def _grow_plants(world: WorldState, events: list[EventDraft]) -> list[Plant]:
    """Step 1: age, stage by age, counters, capped inflow (A-PLANT-1/11/12).  Returns the
    living land plants that the fruit/seed steps process."""
    eps = _eps(world)
    active: list[Plant] = []
    skipped: list[str] = []
    total_energy = 0.0
    total_essence = 0.0
    for plant_id in sorted(world.plants):
        plant = world.plants[plant_id]
        if not plant.alive:
            continue
        if terrain_at(world, plant.position) != "land":
            skipped.append(plant.id)
            continue
        rule = _species_rule(world, plant.species)
        plant.age_rounds += 1
        new_stage = _stage_for_age(rule, plant.age_rounds)
        stage = rule.stages[new_stage]
        if new_stage != plant.stage_index:
            plant.stage_index = new_stage
            plant.size = stage.size
            events.append(
                EventDraft(
                    actor="world",
                    kind="plant_growth",
                    summary=f"plant {plant.id} reached stage {stage.name}",
                    details={
                        "plant_id": plant.id,
                        "stage": stage.name,
                        "stage_index": new_stage,
                        "size": plant.size,
                        "energy": plant.energy,
                        "essence": plant.essence,
                    },
                )
            )
        plant.rounds_since_fruit += 1
        plant.rounds_since_seed += 1
        energy_in = max(0.0, min(stage.energy_inflow_per_round, stage.max_energy - plant.energy))
        essence_in = max(0.0, min(stage.essence_inflow_per_round, stage.max_essence - plant.essence))
        plant.energy = _clean(plant.energy + energy_in, eps)
        plant.essence = _clean(plant.essence + essence_in, eps)
        plant.total_source_energy += energy_in
        plant.total_source_essence += essence_in
        total_energy += energy_in
        total_essence += essence_in
        active.append(plant)
    events.append(
        EventDraft(
            actor="world",
            kind="plant_growth",
            summary=(
                f"{len(active)} plants grew: +{_fmt(total_energy)} energy, +{_fmt(total_essence)} essence"
                + (f"; {len(skipped)} skipped off land" if skipped else "")
            ),
            details={
                "count": len(active),
                "total_energy_inflow": total_energy,
                "total_essence_inflow": total_essence,
                "skipped_non_land": skipped,
            },
        )
    )
    return active


def _spawn_fruit(world: WorldState, plants: list[Plant], events: list[EventDraft]) -> None:
    """Step 2 (A-PLANT-2/12): fruit funded from the plant's energy store."""
    eps = _eps(world)
    for plant in plants:
        rule = _species_rule(world, plant.species)
        stage = _stage_rule(rule, plant.stage_index)
        interval = stage.fruit_interval_rounds
        if interval <= 0 or plant.rounds_since_fruit < interval:
            continue
        if _live_fruit_count(world, plant) >= rule.max_fruit:
            continue
        if plant.energy + eps < rule.fruit_energy:
            continue
        fruit_id = new_entity_id(world, "fruit")
        world.fruits[fruit_id] = Fruit(
            id=fruit_id,
            position=plant.position.model_copy(),
            plant_id=plant.id,
            available_compute=float(rule.fruit_energy),
            available_essence=0.0,
            created_round=world.round,
        )
        plant.energy = _clean(plant.energy - rule.fruit_energy, eps)
        plant.rounds_since_fruit = 0
        plant.total_fruit_produced += 1
        _prune_references(world, plant)
        plant.fruit_ids.append(fruit_id)
        events.append(
            EventDraft(
                actor="world",
                kind="fruit_spawned",
                summary=f"plant {plant.id} grew fruit {fruit_id} ({_fmt(rule.fruit_energy)} compute) at {_fmt_point(plant.position)}",
                details={
                    "plant_id": plant.id,
                    "entity_id": fruit_id,
                    "position": _point_dict(plant.position),
                    "compute": float(rule.fruit_energy),
                },
            )
        )


def _dispersal_cells(world: WorldState, origin: Point, radius: int) -> list[Point]:
    """Land cells within Manhattan ``radius`` of ``origin`` in a fixed order (x, then y)."""
    cells: list[Point] = []
    for dx in range(-radius, radius + 1):
        for dy in range(-radius, radius + 1):
            if abs(dx) + abs(dy) > radius:
                continue
            point = Point(x=origin.x + dx, y=origin.y + dy)
            if terrain_at(world, point) == "land":
                cells.append(point)
    return cells


def _spawn_seeds(world: WorldState, plants: list[Plant], rng: random.Random, events: list[EventDraft]) -> None:
    """Step 3 (A-PLANT-4/12): one seed per interval on a random land cell within the
    dispersal radius, drawn from the run RNG; skipped (counter kept) when no cell qualifies."""
    for plant in plants:
        rule = _species_rule(world, plant.species)
        stage = _stage_rule(rule, plant.stage_index)
        interval = stage.seed_interval_rounds
        if interval <= 0 or plant.rounds_since_seed < interval:
            continue
        if _live_seed_count(world, plant) >= rule.max_seeds_alive:
            continue
        cells = _dispersal_cells(world, plant.position, max(0, rule.seed_dispersal_radius))
        if not cells:
            continue
        position = rng.choice(cells)
        seed_id = new_entity_id(world, "seed")
        germinates = world.round + rule.seed_germination_delay_rounds
        world.seeds[seed_id] = Seed(
            id=seed_id,
            position=position,
            species=plant.species,
            plant_id=plant.id,
            created_round=world.round,
            germinates_round=germinates,
        )
        plant.rounds_since_seed = 0
        plant.total_seeds_produced += 1
        _prune_references(world, plant)
        plant.seed_ids.append(seed_id)
        events.append(
            EventDraft(
                actor="world",
                kind="seed_spawned",
                summary=f"plant {plant.id} dropped seed {seed_id} at {_fmt_point(position)} (germinates round {germinates})",
                details={
                    "plant_id": plant.id,
                    "entity_id": seed_id,
                    "position": _point_dict(position),
                    "species": plant.species,
                    "germinates_round": germinates,
                },
            )
        )


def _germinate(world: WorldState, events: list[EventDraft]) -> None:
    """Step 4 (A-PLANT-4/10): a due seed on land becomes a stage-0 plant with the species'
    source-funded initial essence; a seed on non-land stays dormant."""
    for seed_id in sorted(world.seeds):
        seed = world.seeds[seed_id]
        if seed.germinates_round > world.round:
            continue
        if terrain_at(world, seed.position) != "land":
            continue
        rule = _species_rule(world, seed.species)
        plant_id = new_entity_id(world, "plant")
        stage = rule.stages[0]
        world.plants[plant_id] = Plant(
            id=plant_id,
            position=seed.position.model_copy(),
            species=seed.species,
            stage_index=0,
            age_rounds=0,
            size=stage.size,
            energy=0.0,
            essence=rule.initial_essence,
            created_round=world.round,
        )
        world.plants[plant_id].total_source_essence = rule.initial_essence
        del world.seeds[seed_id]
        world.removed[seed_id] = RemovedEntity(
            id=seed_id, kind="seed", position=seed.position.model_copy(), round=world.round, reason="germinated"
        )
        parent = world.plants.get(seed.plant_id) if seed.plant_id else None
        if parent is not None:
            parent.seed_ids = [i for i in parent.seed_ids if i != seed_id]
        events.append(
            EventDraft(
                actor="world",
                kind="germination",
                summary=f"seed {seed_id} germinated into plant {plant_id} at {_fmt_point(seed.position)}",
                details={
                    "plant_id": plant_id,
                    "entity_id": seed_id,
                    "position": _point_dict(seed.position),
                    "species": seed.species,
                    "parent_plant_id": seed.plant_id,
                },
            )
        )


def _decay_residue(world: WorldState) -> None:
    """Step 5 (A-DEATH-3): available *= (1 - decay); amounts below eps -> 0."""
    decay = world.rules.death.residue_decay_per_round
    if decay <= 0:
        return
    eps = _eps(world)
    keep = max(0.0, 1.0 - decay)
    for residue in world.residues.values():
        residue.available_compute = _clean(residue.available_compute * keep, eps)
        residue.available_essence = _clean(residue.available_essence * keep, eps)


def _settle_upkeep(world: WorldState, events: list[EventDraft], notices: list[Notice], deaths: list[str]) -> None:
    """Step 6, design "Health damage and recovery": pay min(compute, upkeep); consume a partial
    payment but never go negative; an unpaid round costs ``starvation_health_loss`` health;
    death at health <= 0 through the single death path (A-ACT-11)."""
    eps = _eps(world)
    owed = world.rules.upkeep.compute_per_round
    loss = world.rules.upkeep.starvation_health_loss
    for agent in living_agents(world):
        paid = min(agent.stats.compute, owed)
        paid = _clean(paid, eps)
        agent.stats.compute = _clean(agent.stats.compute - paid, eps)
        events.append(
            EventDraft(
                actor="world",
                kind="upkeep",
                summary=f"{agent.id} paid {_fmt(paid)} of {_fmt(owed)} upkeep",
                details={"agent_id": agent.id, "paid": paid, "owed": owed},
                costs=EventCosts(compute=paid),
            )
        )
        if paid + eps >= owed:
            continue
        agent.stats.health = max(0.0, agent.stats.health - loss)
        lethal = agent.stats.health <= eps
        if lethal:
            agent.stats.health = 0.0
        events.append(
            EventDraft(
                actor="world",
                kind="starvation",
                summary=f"{agent.id} starves: -{_fmt(loss)} health (now {_fmt(agent.stats.health)})",
                details={"agent_id": agent.id, "health_loss": loss, "health_after": agent.stats.health},
            )
        )
        if lethal:
            outcome = _resolve_agent_death(world, agent, "starvation", amount=loss)
            events.extend(outcome.events)
            notices.extend(outcome.notices)
            deaths.extend(outcome.deaths)
        else:
            notices.append(_damage_notice(agent, loss, None, False, agent.stats.health, "starvation"))


def _cleanup(world: WorldState, events: list[EventDraft]) -> None:
    """Step 7 (A-PLANT-6): consumed or rotten fruit and empty residues leave the dicts."""
    eps = _eps(world)
    for fruit_id in sorted(world.fruits):
        fruit = world.fruits[fruit_id]
        reason: Optional[str] = None
        if fruit.available_compute < eps:
            reason = "consumed"
        else:
            plant = world.plants.get(fruit.plant_id) if fruit.plant_id else None
            rule = world.rules.plant_species.get(plant.species) if plant is not None else None
            if rule is not None and rule.fruit_decay_rounds > 0 and world.round - fruit.created_round >= rule.fruit_decay_rounds:
                reason = "decayed"
        if reason is None:
            continue
        lost = fruit.available_compute
        del world.fruits[fruit_id]
        world.removed[fruit_id] = RemovedEntity(
            id=fruit_id, kind="fruit", position=fruit.position.model_copy(), round=world.round, reason=reason
        )
        parent = world.plants.get(fruit.plant_id) if fruit.plant_id else None
        if parent is not None:
            parent.fruit_ids = [i for i in parent.fruit_ids if i != fruit_id]
        events.append(
            EventDraft(
                actor="world",
                kind="fruit_removed",
                summary=f"fruit {fruit_id} removed ({reason}; {_fmt(lost)} compute lost)",
                details={
                    "plant_id": fruit.plant_id,
                    "entity_id": fruit_id,
                    "position": _point_dict(fruit.position),
                    "lost_compute": lost,
                    "reason": reason,
                },
            )
        )
    for residue_id in sorted(world.residues):
        residue = world.residues[residue_id]
        if residue.available_compute < eps and residue.available_essence < eps:
            del world.residues[residue_id]
            world.removed[residue_id] = RemovedEntity(
                id=residue_id, kind="residue", position=residue.position.model_copy(), round=world.round, reason="cleanup"
            )


def end_round(world: WorldState) -> RoundEndOutcome:
    """Deterministic round-end processing in this fixed order (A-ECON-1).  Plants whose cell
    is not land are skipped in steps 1-3 (A-PLANT-10; the summary event lists them).

      1. plants (living, on land): age +1; stage = highest stage with min_age <= age;
         rounds_since_fruit/seed += 1; energy = min(stage.max_energy, energy + inflow);
         essence = min(stage.max_essence, essence + inflow); ``total_source_*`` record only
         the ADMITTED inflow; "plant_growth" event on a stage change, plus one summary
         event per round with totals.
      2. fruit: for each living land plant with fruit_interval > 0 and rounds_since_fruit
         >= interval and live fruit (entities whose plant_id is this plant) < max_fruit and
         energy >= fruit_energy: spawn Fruit(available_compute=fruit_energy) at the plant's
         point, energy -= fruit_energy, counter = 0; "fruit_spawned".  A blocked spawn
         keeps the counter (A-PLANT-12).
      3. seeds: same pattern with seed_interval/max_seeds_alive (per plant); position = a
         random LAND cell within dispersal radius drawn from the run RNG, or skipped if
         none; germinates_round = round + delay; "seed_spawned".
      4. germination: seeds with germinates_round <= round whose cell is land become a
         stage-0 plant with initial_essence (source-funded); seed removed (``removed``
         reason "germinated"); "germination".  A seed on non-land stays dormant.
      5. residue decay: available *= (1 - decay); amounts < eps -> 0.
      6. upkeep: each living agent pays min(compute, upkeep) ("upkeep" event with paid/owed);
         if the full amount was not paid, health -= starvation loss ("starvation" event +
         damage notice with health_after); health <= 0 -> kill_agent(cause="starvation").
      7. cleanup: fruit with available_compute < eps or (fruit_decay_rounds > 0 and age >=
         it) removed ("fruit_removed" with the lost compute; ``removed`` reason "consumed" /
         "decayed"), residues with both amounts < eps removed ("cleanup"); occupants rebuilt.
    Does NOT increment ``world.round`` (the runner does at round start).  The last event is
    ``round_ended`` with the living agents and this step's deaths.
    """
    events: list[EventDraft] = []
    notices: list[Notice] = []
    deaths: list[str] = []
    rng = get_rng(world)

    active_plants = _grow_plants(world, events)
    _spawn_fruit(world, active_plants, events)
    _spawn_seeds(world, active_plants, rng, events)
    _germinate(world, events)
    _decay_residue(world)
    _settle_upkeep(world, events, notices, deaths)
    _cleanup(world, events)

    save_rng(world, rng)
    rebuild_occupants(world)
    alive = [agent.id for agent in living_agents(world)]
    events.append(
        EventDraft(
            actor="world",
            kind="round_ended",
            summary=f"round {world.round} ended: {len(alive)} living agents, {len(deaths)} deaths",
            details={"round": world.round, "living_agents": alive, "deaths": list(deaths)},
        )
    )
    return RoundEndOutcome(events=events, notices=notices, deaths=deaths)


# ---------------------------------------------------------------------------
# Interventions and consistency
# ---------------------------------------------------------------------------


def _adopt(world: WorldState, trial: WorldState) -> None:
    """Copy every field of ``trial`` into ``world`` (same object identity for callers)."""
    for name in WorldState.model_fields:
        setattr(world, name, getattr(trial, name))


def _entity_class(kind: str) -> type:
    return {"agent": Agent, "plant": Plant, "fruit": Fruit, "seed": Seed, "residue": Residue}[kind]


def _get_path(data: Any, parts: list[str]) -> Any:
    for part in parts:
        if not isinstance(data, dict) or part not in data:
            raise InterventionError(f"unknown field path {'.'.join(parts)!r}")
        data = data[part]
    return data


def _set_path(data: dict[str, Any], parts: list[str], value: Any) -> None:
    for part in parts[:-1]:
        if not isinstance(data.get(part), dict):
            raise InterventionError(f"unknown field path {'.'.join(parts)!r}")
        data = data[part]
    if parts[-1] not in data:
        raise InterventionError(f"unknown field path {'.'.join(parts)!r}")
    data[parts[-1]] = value


def _check_placement(world: WorldState, entity: Entity, label: Optional[str] = None) -> None:
    """Terrain rules for interventions (A-PLANT-10, A-WORLD-6): inside the region; agents not
    on mountains; plants and seeds on land; species known.  ``label`` names the entity in
    messages; the default is ``"<kind> <id>"``.  A placement whose id the engine assigned
    passes ``"new <kind>"`` so the operator is never told about an id they did not choose."""
    where = _fmt_point(entity.position)
    who = label or f"{entity.kind} {entity.id}"
    terrain = terrain_at(world, entity.position)
    if terrain is None:
        raise InterventionError(f"{who} at {where} is outside the region")
    if entity.kind == "agent" and entity.alive and terrain == "mountain":
        raise InterventionError(f"{who} cannot be on a mountain at {where}")
    if entity.kind in ("plant", "seed"):
        if terrain != "land":
            raise InterventionError(f"{who} at {where} must be on land, not {terrain}")
        if entity.species not in world.rules.plant_species:
            raise InterventionError(f"species {entity.species!r} is not in rules.plant_species")
        if entity.kind == "plant" and not 0 <= entity.stage_index < len(world.rules.plant_species[entity.species].stages):
            raise InterventionError(f"{who}: stage_index {entity.stage_index} is out of range")


def _settle_plant_stage(trial: WorldState, plant: Plant, prefix: str) -> list[FieldChange]:
    """Keep a plant's ``age_rounds`` and ``size`` consistent with an operator-chosen
    ``stage_index``: round end derives the stage from the age (``_stage_for_age``), so a
    placed or edited plant would otherwise snap back to the stage its age implies one
    round later.  When the age implies another stage, ``age_rounds`` becomes the chosen
    stage's ``min_age_rounds``; an age that already fits is left alone.  Returns the extra
    FieldChanges (paths under ``prefix``; none when nothing moved)."""
    rule = trial.rules.plant_species.get(plant.species)
    if rule is None or not 0 <= plant.stage_index < len(rule.stages):
        return []
    stage = rule.stages[plant.stage_index]
    changes: list[FieldChange] = []
    if _stage_for_age(rule, plant.age_rounds) != plant.stage_index:
        changes.append(FieldChange(path=f"{prefix}.age_rounds", before=plant.age_rounds, after=stage.min_age_rounds))
        plant.age_rounds = stage.min_age_rounds
    if plant.size != stage.size:
        changes.append(FieldChange(path=f"{prefix}.size", before=plant.size, after=stage.size))
        plant.size = stage.size
    return changes


def _apply_set_stat(trial: WorldState, intervention: Any) -> list[FieldChange]:
    entity = find_entity(trial, intervention.entity_id)
    if entity is None:
        raise InterventionError(f"unknown entity {intervention.entity_id!r}")
    parts = [p for p in str(intervention.field).split(".") if p]
    if not parts:
        raise InterventionError("field path is empty")
    if parts[0] in ("id", "kind"):
        raise InterventionError(f"field {parts[0]!r} cannot be changed")
    data = entity.model_dump(mode="json")
    before = _get_path(data, parts)
    value = intervention.value
    if len(parts) == 2 and parts[0] == "stats" and parts[1] in INTEGER_STATS:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or float(value) != int(value):
            raise InterventionError(f"{parts[1]} must stay an integer, got {value!r}")
        value = int(value)
    _set_path(data, parts, value)
    try:
        updated = _entity_class(entity.kind).model_validate(data)
    except ValidationError as exc:
        raise InterventionError(f"invalid value for {intervention.field}: {exc.errors()[0].get('msg', exc)}") from exc
    if entity.kind == "agent" and not entity.alive and updated.alive:
        # Death is resolved once (A-DEATH-6): flipping ``alive`` back would resolve it again
        # (a second residue, a second death event).  Revival is remove_entity + place_entity.
        raise InterventionError(
            f"dead agent {entity.id} cannot be revived through set_stat; remove it and place a new agent instead"
        )
    _check_placement(trial, updated)
    # Copy the validated fields into the EXISTING record so references stay valid.
    for name in type(entity).model_fields:
        setattr(entity, name, getattr(updated, name))
    after = _get_path(entity.model_dump(mode="json"), parts)
    prefix = f"world.{KIND_TO_DICT[entity.kind]}.{entity.id}"
    changes = [FieldChange(path=f"{prefix}.{'.'.join(parts)}", before=before, after=after)]
    if entity.kind == "plant" and parts == ["stage_index"]:
        changes.extend(_settle_plant_stage(trial, entity, prefix))
    if entity.kind == "agent" and entity.alive and entity.stats.health <= 0:
        snapshot = entity.model_dump(mode="json")
        residues_before = set(trial.residues)
        _resolve_agent_death(trial, entity, "operator")
        for path in ("alive", "died_round", "death_cause", "stats.health", "stats.compute", "stats.essence"):
            path_parts = path.split(".")
            changes.append(
                FieldChange(
                    path=f"{prefix}.{path}",
                    before=_get_path(snapshot, path_parts),
                    after=_get_path(entity.model_dump(mode="json"), path_parts),
                )
            )
        for residue_id in sorted(set(trial.residues) - residues_before):
            changes.append(
                FieldChange(path=f"world.residues.{residue_id}", before=None, after=trial.residues[residue_id].model_dump(mode="json"))
            )
    return changes


def _apply_place_entity(trial: WorldState, intervention: Any) -> list[FieldChange]:
    entity = intervention.entity.model_copy(deep=True)
    # The id is assigned only when the placement is accepted; rejections name the kind and
    # the point (the operator never saw a tentative id).
    label = f"{entity.kind} {entity.id}" if entity.id else f"new {entity.kind}"
    if not entity.id:
        entity.id = new_entity_id(trial, entity.kind)
    else:
        if _id_in_use(trial, entity.id):
            raise InterventionError(f"id {entity.id!r} is already used (ids are never reused)")
        if entity.kind == "agent":
            if not _AGENT_ID_PATTERN.match(entity.id) or entity.id.lower() in RESERVED_AGENT_IDS:
                raise InterventionError(f"invalid agent id {entity.id!r}")
        _bump_seq_past(trial, entity.kind, entity.id)
    if entity.kind == "residue" and entity.source_kind not in ("agent", "plant"):
        raise InterventionError("residue source_kind must be agent or plant")
    entity.created_round = trial.round
    if entity.kind == "plant":
        rule = trial.rules.plant_species.get(entity.species)
        if rule is not None and 0 <= entity.stage_index < len(rule.stages):
            _settle_plant_stage(trial, entity, "")
        # Whatever the operator put into the plant came from the source (A-PLANT-4);
        # explicit totals in the entity are respected.
        if entity.total_source_essence == 0:
            entity.total_source_essence = entity.essence
        if entity.total_source_energy == 0:
            entity.total_source_energy = entity.energy
    _check_placement(trial, entity, label)
    getattr(trial, KIND_TO_DICT[entity.kind])[entity.id] = entity
    return [FieldChange(path=f"world.{KIND_TO_DICT[entity.kind]}.{entity.id}", before=None, after=entity.model_dump(mode="json"))]


def _apply_remove_entity(trial: WorldState, intervention: Any) -> list[FieldChange]:
    entity = find_entity(trial, intervention.entity_id)
    if entity is None:
        raise InterventionError(f"unknown entity {intervention.entity_id!r}")
    table = getattr(trial, KIND_TO_DICT[entity.kind])
    del table[entity.id]
    trial.removed[entity.id] = RemovedEntity(
        id=entity.id, kind=entity.kind, position=entity.position.model_copy(), round=trial.round, reason="operator"
    )
    for plant in trial.plants.values():
        plant.fruit_ids = [i for i in plant.fruit_ids if i != entity.id]
        plant.seed_ids = [i for i in plant.seed_ids if i != entity.id]
    if entity.kind == "plant":
        for fruit in trial.fruits.values():
            if fruit.plant_id == entity.id:
                fruit.plant_id = None
        for seed in trial.seeds.values():
            if seed.plant_id == entity.id:
                seed.plant_id = None
    return [FieldChange(path=f"world.{KIND_TO_DICT[entity.kind]}.{entity.id}", before=entity.model_dump(mode="json"), after=None)]


def _apply_update_plant_rules(trial: WorldState, intervention: Any) -> list[FieldChange]:
    if intervention.rule.name != intervention.species:
        raise InterventionError(f"rule.name {intervention.rule.name!r} must equal species {intervention.species!r}")
    before_rule = trial.rules.plant_species.get(intervention.species)
    trial.rules.plant_species[intervention.species] = intervention.rule.model_copy(deep=True)
    changes = [
        FieldChange(
            path=f"world.rules.plant_species.{intervention.species}",
            before=before_rule.model_dump(mode="json") if before_rule else None,
            after=intervention.rule.model_dump(mode="json"),
        )
    ]
    last = len(intervention.rule.stages) - 1
    for plant_id in sorted(trial.plants):
        plant = trial.plants[plant_id]
        if plant.species == intervention.species and plant.stage_index > last:
            changes.append(FieldChange(path=f"world.plants.{plant_id}.stage_index", before=plant.stage_index, after=last))
            plant.stage_index = last
            plant.size = intervention.rule.stages[last].size
    return changes


def apply_world_intervention(world: WorldState, intervention: Intervention) -> list[FieldChange]:
    """Apply a world-level intervention without charging anyone.

    Handles:
    * set_stat: dotted ``field`` on the entity record ("stats.compute", "position", "alive",
      "species"...); validated by re-parsing the entity model, plus: species must exist in
      the rules, INTEGER_STATS stay integers, positions inside the region, agents not on
      mountains.  A living agent whose health ends <= 0 is resolved through
      ``kill_agent(cause="operator")`` (A-DEATH-6); the extra changes are appended.  A dead
      agent cannot be set ``alive`` again (death is resolved once); a plant's
      ``stage_index`` edit also settles ``age_rounds``/``size`` to that stage.
    * place_entity: id assigned when empty (reused ids rejected); agents not on mountains;
      plants and seeds only on land; a new agent starts with stats as given (defaults
      otherwise); a placed plant gets ``age_rounds >= min_age_rounds`` of its stage and its
      balances recorded as source inflow.  Model/context assignment of a placed agent is
      handled by the runner.
    * remove_entity: entity removed from its dict and recorded in ``world.removed``
      (reason "operator"); references from plants (fruit_ids/seed_ids) cleaned.
    * update_plant_rules: ``rule.name`` must equal ``species``; plants with stage_index >=
      len(stages) are clamped to the last stage (each clamp a FieldChange).
    * update_prices: replaces ``rules.prices``.
    Other intervention types raise ``WorldError`` (the runner routes them elsewhere).
    Returns the before/after changes with paths like ``world.agents.a01.stats.compute``.
    Raises ``InterventionError`` and leaves the world untouched on invalid input.
    Rebuilds occupants.

    Implementation: the change is first applied to a deep copy on which ``validate_world``
    must pass; only then is the same deterministic change applied to the live world, so
    the live world never holds a half-applied edit and untouched entity objects keep
    their identity (callers holding references stay valid).
    """
    if intervention.type not in ("set_stat", "place_entity", "remove_entity", "update_plant_rules", "update_prices"):
        raise WorldError(f"intervention type {intervention.type!r} is not a world intervention")
    trial = world.model_copy(deep=True)
    _apply_intervention_to(trial, intervention)
    errors = validate_world(trial)
    if errors:
        raise InterventionError("; ".join(errors))
    changes = _apply_intervention_to(world, intervention)
    rebuild_occupants(world)
    return changes


def _apply_intervention_to(state: WorldState, intervention: Intervention) -> list[FieldChange]:
    """The mutation behind ``apply_world_intervention`` (deterministic, so the dry run on a
    copy and the real application produce the same changes and ids)."""
    kind = intervention.type
    if kind == "set_stat":
        return _apply_set_stat(state, intervention)
    if kind == "place_entity":
        return _apply_place_entity(state, intervention)
    if kind == "remove_entity":
        return _apply_remove_entity(state, intervention)
    if kind == "update_plant_rules":
        return _apply_update_plant_rules(state, intervention)
    changes = [
        FieldChange(
            path="world.rules.prices",
            before=state.rules.prices.model_dump(mode="json"),
            after=intervention.prices.model_dump(mode="json"),
        )
    ]
    state.rules.prices = intervention.prices.model_copy()
    return changes


def replace_world(world: WorldState, new_world: WorldState) -> list[str]:
    """Adopt ``new_world`` (from a validated working snapshot) wholesale after
    ``validate_world`` passes; occupants are recomputed, never trusted from the file.
    Returns validation errors instead of applying when non-empty."""
    errors = validate_world(new_world)
    if errors:
        return errors
    trial = new_world.model_copy(deep=True)
    rebuild_occupants(trial)
    _adopt(world, trial)
    return []


def _finite_nonneg(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def validate_world(world: WorldState) -> list[str]:
    """Consistency checks: every entity inside the region; living agents not on mountains;
    plants and seeds on land; fruit/seed plant references exist or are None; no duplicate
    ids across kinds or with ``removed``; species referenced by plants/seeds exist in rules;
    balances finite and >= 0; essence <= capacity; health <= max_health; dead agents have
    health 0; INTEGER_STATS are integers; ``next_entity_seq`` above every used number.
    Returns a list of readable errors (empty = valid)."""
    errors: list[str] = []
    eps = world.rules.accounting.eps
    seen: dict[str, str] = {}
    for name in ENTITY_DICTS:
        table = getattr(world, name)
        for key, entity in table.items():
            if key != entity.id:
                errors.append(f"{name}: key {key!r} does not match entity id {entity.id!r}")
            if entity.id in seen:
                errors.append(f"duplicate entity id {entity.id!r} in {name} and {seen[entity.id]}")
            seen[entity.id] = name
            if entity.id in world.removed:
                errors.append(f"{name}.{entity.id}: id also appears in removed")
            terrain = terrain_at(world, entity.position)
            if terrain is None:
                errors.append(f"{name}.{entity.id}: position {_fmt_point(entity.position)} is outside the region")
            if entity.kind == "agent":
                if entity.alive and terrain == "mountain":
                    errors.append(f"agents.{entity.id}: living agent on a mountain at {_fmt_point(entity.position)}")
                stats = entity.stats
                for field_name in ("compute", "essence", "health", "max_health", "essence_capacity", "attack"):
                    if not _finite_nonneg(getattr(stats, field_name)):
                        errors.append(f"agents.{entity.id}: stats.{field_name} must be finite and >= 0")
                for field_name in ("compute_absorption", "essence_absorption"):
                    if not _finite_nonneg(getattr(stats, field_name)):
                        errors.append(f"agents.{entity.id}: stats.{field_name} must be finite and >= 0")
                if stats.essence > stats.essence_capacity + eps:
                    errors.append(f"agents.{entity.id}: essence {stats.essence} exceeds capacity {stats.essence_capacity}")
                if stats.health > stats.max_health + eps:
                    errors.append(f"agents.{entity.id}: health {stats.health} exceeds max_health {stats.max_health}")
                if not entity.alive and stats.health != 0:
                    errors.append(f"agents.{entity.id}: dead agent must have health 0")
                for field_name in INTEGER_STATS:
                    value = getattr(stats, field_name)
                    if isinstance(value, bool) or not isinstance(value, int):
                        errors.append(f"agents.{entity.id}: stats.{field_name} must be an integer")
                    elif value < 0:
                        errors.append(f"agents.{entity.id}: stats.{field_name} must be >= 0")
            elif entity.kind == "plant":
                if terrain is not None and terrain != "land":
                    errors.append(f"plants.{entity.id}: plant on {terrain} at {_fmt_point(entity.position)}")
                rule = world.rules.plant_species.get(entity.species)
                if rule is None:
                    errors.append(f"plants.{entity.id}: unknown species {entity.species!r}")
                elif not 0 <= entity.stage_index < len(rule.stages):
                    errors.append(f"plants.{entity.id}: stage_index {entity.stage_index} out of range")
                if not _finite_nonneg(entity.energy) or not _finite_nonneg(entity.essence):
                    errors.append(f"plants.{entity.id}: energy/essence must be finite and >= 0")
                for fruit_id in entity.fruit_ids:
                    if fruit_id not in world.fruits:
                        errors.append(f"plants.{entity.id}: fruit_ids references missing fruit {fruit_id!r}")
                for seed_id in entity.seed_ids:
                    if seed_id not in world.seeds:
                        errors.append(f"plants.{entity.id}: seed_ids references missing seed {seed_id!r}")
            elif entity.kind == "seed":
                if terrain is not None and terrain != "land":
                    errors.append(f"seeds.{entity.id}: seed on {terrain} at {_fmt_point(entity.position)}")
                if entity.species not in world.rules.plant_species:
                    errors.append(f"seeds.{entity.id}: unknown species {entity.species!r}")
                if entity.plant_id is not None and entity.plant_id not in world.plants:
                    errors.append(f"seeds.{entity.id}: plant_id {entity.plant_id!r} does not exist")
            elif entity.kind == "fruit":
                if entity.plant_id is not None and entity.plant_id not in world.plants:
                    errors.append(f"fruits.{entity.id}: plant_id {entity.plant_id!r} does not exist")
                if not _finite_nonneg(entity.available_compute) or not _finite_nonneg(entity.available_essence):
                    errors.append(f"fruits.{entity.id}: available amounts must be finite and >= 0")
            elif entity.kind == "residue":
                if not _finite_nonneg(entity.available_compute) or not _finite_nonneg(entity.available_essence):
                    errors.append(f"residues.{entity.id}: available amounts must be finite and >= 0")
    for kind, dict_name in KIND_TO_DICT.items():
        used = [_id_number(kind, i) for i in getattr(world, dict_name)]
        used += [_id_number(kind, r.id) for r in world.removed.values() if r.kind == kind]
        numbers = [n for n in used if n is not None]
        if numbers and world.next_entity_seq.get(kind, 1) <= max(numbers):
            errors.append(f"next_entity_seq.{kind} = {world.next_entity_seq.get(kind, 1)} is not above the used id {max(numbers)}")
    return errors
