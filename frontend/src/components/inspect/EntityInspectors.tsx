/**
 * Inspectors for plants, fruit, seeds and residue.  The plant inspector shows
 * the instance's current state beside the species rule governing it, clearly
 * labelled "instance" vs "species" (spec "Display and historical inspection":
 * "The plant inspector shows its current state alongside the rules and source
 * settings governing it ... distinguishing a species/rule change from editing
 * one instance").
 */

import type { Fruit, Plant, PlantSpeciesRule, PlantStageRule, Residue, RulesConfig, Seed, TurnView } from "../../api/types";
import { pointKey } from "../../api/types";
import { KeyValueTable, Section } from "./common";
import { kv } from "./rows";
import type { KeyValueRow } from "./rows";
import { fmtNum, fmtPoint } from "./format";
import { PlantRulesEditor } from "./PlantRulesEditor";

const NOOP = () => {};

function terrainNote(turn: TurnView | null, position: { x: number; y: number }): string | null {
  if (!turn) return null;
  const terrain = turn.map.cells[pointKey(position)];
  return terrain ?? null;
}

function lifeRows(e: { alive: boolean; created_round: number; died_round: number | null; death_cause: string | null }): KeyValueRow[] {
  const rows: KeyValueRow[] = [["created round", String(e.created_round)]];
  rows.push(kv("alive", e.alive ? "yes" : <span className="insp-bad">no — died round {e.died_round ?? "?"} ({e.death_cause ?? "unknown cause"})</span>));
  return rows;
}

/**
 * Why the plant will or will not grow fruit at the next round end, in the order the
 * engine checks (world.end_round step 2): terrain, stage interval, live fruit below
 * max_fruit, stored energy >= fruit_energy.
 */
function nextFruitText(plant: Plant, rule: PlantSpeciesRule | null, stage: PlantStageRule | null, liveFruit: number, terrain: string | null): string {
  if (!rule || !stage) return "unknown (species rule not loaded)";
  if (!plant.alive) return "none: the plant is dead";
  if (terrain && terrain !== "land") return `none while it stands on ${terrain}`;
  if (stage.fruit_interval_rounds <= 0) return "none in this stage";
  const blockers: string[] = [];
  const due = stage.fruit_interval_rounds - plant.rounds_since_fruit;
  if (due > 0) blockers.push(`interval: due in ${due} round${due === 1 ? "" : "s"}`);
  if (liveFruit >= rule.max_fruit) blockers.push(`${liveFruit} fruit alive, max ${rule.max_fruit} (a fruit must be eaten or decay first)`);
  if (plant.energy < rule.fruit_energy) {
    const missing = rule.fruit_energy - plant.energy;
    const inflow = stage.energy_inflow_per_round;
    const rounds = inflow > 0 ? Math.ceil(missing / inflow) : null;
    blockers.push(
      `energy: needs ${fmtNum(rule.fruit_energy)}, has ${fmtNum(plant.energy)}${rounds !== null ? ` (+${fmtNum(inflow)}/round → about ${rounds} round${rounds === 1 ? "" : "s"})` : " (no inflow in this stage)"}`,
    );
  }
  if (blockers.length === 0) return `at the next round end (${fmtNum(rule.fruit_energy)} compute, funded from stored energy)`;
  return `waiting — ${blockers.join("; ")}`;
}

function nextSeedText(plant: Plant, rule: PlantSpeciesRule | null, stage: PlantStageRule | null, liveSeeds: number, terrain: string | null): string {
  if (!rule || !stage) return "unknown (species rule not loaded)";
  if (!plant.alive) return "none: the plant is dead";
  if (terrain && terrain !== "land") return `none while it stands on ${terrain}`;
  if (stage.seed_interval_rounds <= 0) return "none in this stage";
  const blockers: string[] = [];
  const due = stage.seed_interval_rounds - plant.rounds_since_seed;
  if (due > 0) blockers.push(`interval: due in ${due} round${due === 1 ? "" : "s"}`);
  if (liveSeeds >= rule.max_seeds_alive) blockers.push(`${liveSeeds} seeds alive, max ${rule.max_seeds_alive}`);
  if (blockers.length === 0) return `at the next round end, on a land cell within ${rule.seed_dispersal_radius} of the plant (skipped if none)`;
  return `waiting — ${blockers.join("; ")}`;
}

export function PlantInspector(props: { plant: Plant; turn: TurnView | null; rules: RulesConfig | null }) {
  const { plant, turn } = props;
  const rules = turn?.rules ?? props.rules;
  const rule = rules?.plant_species[plant.species] ?? null;
  const stage = rule?.stages[plant.stage_index] ?? null;
  const next = rule?.stages[plant.stage_index + 1] ?? null;
  const terrain = terrainNote(turn, plant.position);
  const liveFruit = turn ? Object.values(turn.entities.fruits).filter((f) => f.plant_id === plant.id).length : plant.fruit_ids.length;
  const liveSeeds = turn ? Object.values(turn.entities.seeds).filter((s) => s.plant_id === plant.id).length : plant.seed_ids.length;

  const instanceRows: KeyValueRow[] = [
    kv("species", <code>{plant.species}</code>),
    ["stage", stage ? `${plant.stage_index} — ${stage.name}` : `${plant.stage_index} (not in the species rule)`],
    ["age (rounds)", `${plant.age_rounds}${next ? ` — next stage "${next.name}" at age ${next.min_age_rounds}` : " — final stage"}`],
    ["size", fmtNum(plant.size)],
    ["energy (stored, funds fruit)", `${fmtNum(plant.energy)}${stage ? ` / ${fmtNum(stage.max_energy)} stage cap` : ""}`],
    ["essence (living)", `${fmtNum(plant.essence)}${stage ? ` / ${fmtNum(stage.max_essence)} stage cap` : ""}`],
    kv("fruit ids", plant.fruit_ids.length ? plant.fruit_ids.join(", ") : <span className="insp-muted">none</span>),
    kv("seed ids", plant.seed_ids.length ? plant.seed_ids.join(", ") : <span className="insp-muted">none</span>),
    kv(
      "rounds since fruit",
      `${plant.rounds_since_fruit}${stage ? (stage.fruit_interval_rounds > 0 ? ` (fruits every ${stage.fruit_interval_rounds})` : " (no fruit in this stage)") : ""}`,
    ),
    kv("next fruit", nextFruitText(plant, rule, stage, liveFruit, terrain)),
    kv(
      "rounds since seed",
      `${plant.rounds_since_seed}${stage ? (stage.seed_interval_rounds > 0 ? ` (seeds every ${stage.seed_interval_rounds})` : " (no seeds in this stage)") : ""}`,
    ),
    kv("next seed", nextSeedText(plant, rule, stage, liveSeeds, terrain)),
    ["fruit / seeds produced", `${plant.total_fruit_produced} / ${plant.total_seeds_produced}`],
    ["source inflow admitted (energy / essence)", `${fmtNum(plant.total_source_energy)} / ${fmtNum(plant.total_source_essence)}`],
    ["position", `${fmtPoint(plant.position)}${terrain ? ` · ${terrain}` : ""}`],
    ...lifeRows(plant),
  ];

  return (
    <div>
      {terrain && terrain !== "land" ? (
        <div className="insp-banner insp-banner-warn">This plant stands on {terrain}: it does not grow, fruit or seed there (A-PLANT-10).</div>
      ) : null}
      <Section title={<>Instance values <span className="insp-scope-tag">this plant only ({plant.id})</span></>}>
        <KeyValueTable rows={instanceRows} />
        <div className="insp-hint">To change only this plant, use God mode → Set stat on {plant.id}.</div>
      </Section>
      <Section title={<>Species rule <span className="insp-scope-tag insp-scope-species">shared by every {plant.species} plant</span></>}>
        {rule ? (
          <>
            <div className="insp-hint">
              Read-only here. To change it, edit "Species rule change" below this inspector (or God mode → Plant rules); the change applies to every{" "}
              {plant.species} plant at the next turn boundary.
            </div>
            <PlantRulesEditor species={[rule]} onChange={NOOP} readOnly highlight={{ species: rule.name, stageIndex: plant.stage_index }} />
          </>
        ) : (
          <p className="insp-bad">No species rule named "{plant.species}" in the rules.</p>
        )}
      </Section>
    </div>
  );
}

export function FruitInspector(props: { fruit: Fruit; turn: TurnView | null; rules: RulesConfig | null }) {
  const { fruit, turn } = props;
  const rules = turn?.rules ?? props.rules;
  const parent = fruit.plant_id && turn ? (turn.entities.plants[fruit.plant_id] ?? null) : null;
  const decayRounds = parent && rules ? (rules.plant_species[parent.species]?.fruit_decay_rounds ?? null) : null;
  const rows: KeyValueRow[] = [
    ["available compute", fmtNum(fruit.available_compute)],
    ["available essence", `${fmtNum(fruit.available_essence)} (fruit holds no essence by design)`],
    kv("from plant", fruit.plant_id ? `${fruit.plant_id}${parent ? ` (${parent.species})` : ""}` : <span className="insp-muted">none</span>),
    ["created round", String(fruit.created_round)],
    kv(
      "rots",
      decayRounds === null ? "unknown (parent plant or rule not found)" : decayRounds === 0 ? "never (fruit_decay_rounds = 0)" : `at age ${decayRounds} rounds (round ${fruit.created_round + decayRounds})`,
    ),
    ["position", fmtPoint(fruit.position)],
  ];
  return (
    <Section title="Fruit">
      <KeyValueTable rows={rows} />
    </Section>
  );
}

export function SeedInspector(props: { seed: Seed; turn: TurnView | null }) {
  const { seed, turn } = props;
  const round = turn?.turn.round ?? null;
  const rows: KeyValueRow[] = [
    kv("species", <code>{seed.species}</code>),
    kv("from plant", seed.plant_id ?? <span className="insp-muted">none</span>),
    ["created round", String(seed.created_round)],
    kv(
      "germinates round",
      `${seed.germinates_round}${round !== null ? (seed.germinates_round > round ? ` (in ${seed.germinates_round - round} rounds)` : " (due; land only, else dormant)") : ""}`,
    ),
    ["position", `${fmtPoint(seed.position)}${terrainNote(turn, seed.position) ? ` · ${terrainNote(turn, seed.position)}` : ""}`],
  ];
  return (
    <Section title="Seed (dormant record, no harvestable essence)">
      <KeyValueTable rows={rows} />
    </Section>
  );
}

export function ResidueInspector(props: { residue: Residue; turn: TurnView | null; rules: RulesConfig | null }) {
  const { residue, turn } = props;
  const rules = turn?.rules ?? props.rules;
  const rows: KeyValueRow[] = [
    ["source", `${residue.source_kind} ${residue.source_id}`],
    ["available compute", fmtNum(residue.available_compute)],
    ["available essence", fmtNum(residue.available_essence)],
    ["created round", String(residue.created_round)],
    ["decay per round", rules ? `${fmtNum(rules.death.residue_decay_per_round)} (fraction; 0 = persists)` : "?"],
    ["position", fmtPoint(residue.position)],
  ];
  return (
    <Section title="Residue (left by a death; absorb to extract)">
      <KeyValueTable rows={rows} />
    </Section>
  );
}
