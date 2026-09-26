/**
 * The plant's sections of the entity profile card: Overview (the instance's
 * values), Growth (fruit and seed counters, why the next fruit or seed is or
 * is not due, totals and the stage's intervals) and Rules (the species rule,
 * with the staged "Species rule change" form).  Spec "Display and historical
 * inspection": "The plant inspector shows its current state alongside the
 * rules and source settings governing it ... distinguishing a species/rule
 * change from editing one instance".
 */

import type { Intervention, Plant, PlantSpeciesRule, PlantStageRule, RulesConfig, TurnView } from "../../api/types";
import { KeyValueTable, Section } from "../inspect/common";
import { fmtNum, fmtPoint } from "../inspect/format";
import { PlantRulesEditor } from "../inspect/PlantRulesEditor";
import { kv } from "../inspect/rows";
import type { KeyValueRow } from "../inspect/rows";
import { SpeciesRulePanel } from "../run/SpeciesRulePanel";
import { EntityLink } from "./EntitySections";
import { terrainAt } from "../../state/profile";

const NOOP = () => {};

function plantRule(plant: Plant, turn: TurnView): { rule: PlantSpeciesRule | null; stage: PlantStageRule | null; next: PlantStageRule | null } {
  const rule = turn.rules.plant_species[plant.species] ?? null;
  return { rule, stage: rule?.stages[plant.stage_index] ?? null, next: rule?.stages[plant.stage_index + 1] ?? null };
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

function TerrainWarning(props: { terrain: string | null }) {
  if (!props.terrain || props.terrain === "land") return null;
  return <div className="insp-banner insp-banner-warn">This plant stands on {props.terrain}: it does not grow, fruit or seed there (A-PLANT-10).</div>;
}

export function PlantOverview(props: { plant: Plant; turn: TurnView }) {
  const { plant, turn } = props;
  const { stage, next } = plantRule(plant, turn);
  const terrain = terrainAt(turn, plant.position);
  const rows: KeyValueRow[] = [
    kv("species", <code>{plant.species}</code>),
    ["stage", stage ? `${plant.stage_index} — ${stage.name}` : `${plant.stage_index} (not in the species rule)`],
    ["age (rounds)", `${plant.age_rounds}${next ? ` — next stage "${next.name}" at age ${next.min_age_rounds}` : " — final stage"}`],
    ["size", fmtNum(plant.size)],
    ["energy (stored, funds fruit)", `${fmtNum(plant.energy)}${stage ? ` / ${fmtNum(stage.max_energy)} stage cap` : ""}`],
    ["essence (vitality)", `${fmtNum(plant.essence)}${stage ? ` / ${fmtNum(stage.max_essence)} stage cap` : ""}`],
    kv("alive", plant.alive ? "yes" : <span className="insp-bad">no, died in round {plant.died_round ?? "?"} ({plant.death_cause ?? "unknown cause"})</span>),
    ["position", `${fmtPoint(plant.position)}${terrain ? ` · ${terrain}` : ""}`],
  ];
  return (
    <div>
      <TerrainWarning terrain={terrain} />
      <Section title={<>Instance values <span className="insp-scope-tag">this plant only ({plant.id})</span></>}>
        <KeyValueTable rows={rows} />
        <div className="insp-hint">To change only this plant, use God mode → Set stat on {plant.id}.</div>
      </Section>
    </div>
  );
}

export function PlantGrowth(props: { plant: Plant; turn: TurnView; onSelect(id: string): void }) {
  const { plant, turn } = props;
  const { rule, stage } = plantRule(plant, turn);
  const terrain = terrainAt(turn, plant.position);
  const liveFruit = Object.values(turn.entities.fruits).filter((f) => f.plant_id === plant.id).length;
  const liveSeeds = Object.values(turn.entities.seeds).filter((s) => s.plant_id === plant.id).length;
  const links = (ids: string[]) =>
    ids.length ? (
      <span className="profile-links">
        {ids.map((id) => (
          <EntityLink key={id} id={id} turn={turn} onSelect={props.onSelect} />
        ))}
      </span>
    ) : (
      <span className="insp-muted">none</span>
    );
  const counters: KeyValueRow[] = [
    kv("fruit", links(plant.fruit_ids)),
    kv("seeds", links(plant.seed_ids)),
    kv("rounds since fruit", `${plant.rounds_since_fruit}${stage ? (stage.fruit_interval_rounds > 0 ? ` (fruits every ${stage.fruit_interval_rounds})` : " (no fruit in this stage)") : ""}`),
    kv("next fruit", nextFruitText(plant, rule, stage, liveFruit, terrain)),
    kv("rounds since seed", `${plant.rounds_since_seed}${stage ? (stage.seed_interval_rounds > 0 ? ` (seeds every ${stage.seed_interval_rounds})` : " (no seeds in this stage)") : ""}`),
    kv("next seed", nextSeedText(plant, rule, stage, liveSeeds, terrain)),
  ];
  const totals: KeyValueRow[] = [
    ["fruit / seeds produced", `${plant.total_fruit_produced} / ${plant.total_seeds_produced}`],
    ["source inflow admitted (energy / essence)", `${fmtNum(plant.total_source_energy)} / ${fmtNum(plant.total_source_essence)}`],
  ];
  const intervals: KeyValueRow[] =
    rule && stage
      ? [
          ["stage", `${plant.stage_index} — ${stage.name}`],
          ["inflow per round (energy / essence)", `${fmtNum(stage.energy_inflow_per_round)} / ${fmtNum(stage.essence_inflow_per_round)}`],
          ["fruit interval (rounds)", stage.fruit_interval_rounds > 0 ? String(stage.fruit_interval_rounds) : "none in this stage"],
          ["seed interval (rounds)", stage.seed_interval_rounds > 0 ? String(stage.seed_interval_rounds) : "none in this stage"],
          ["fruit energy (compute per fruit)", fmtNum(rule.fruit_energy)],
          ["max fruit alive / max seeds alive", `${rule.max_fruit} / ${rule.max_seeds_alive}`],
          ["fruit rots after (rounds)", rule.fruit_decay_rounds > 0 ? String(rule.fruit_decay_rounds) : "never"],
          ["seed germination delay / dispersal radius", `${rule.seed_germination_delay_rounds} rounds / ${rule.seed_dispersal_radius}`],
        ]
      : [["species rule", `no rule named "${plant.species}" in the viewed turn's rules`]];
  return (
    <div>
      <TerrainWarning terrain={terrain} />
      <Section title="Fruit and seeds">
        <KeyValueTable rows={counters} />
      </Section>
      <div className="profile-grid">
        <Section title="Totals">
          <KeyValueTable rows={totals} />
        </Section>
        <Section title={<>Intervals <span className="insp-scope-tag insp-scope-species">from the {plant.species} rule</span></>}>
          <KeyValueTable rows={intervals} />
        </Section>
      </div>
    </div>
  );
}

export function PlantRules(props: {
  plant: Plant;
  turn: TurnView;
  /** The live run's rules (the change form edits them); null until loaded. */
  liveRules: RulesConfig | null;
  onStage(intervention: Intervention): Promise<void>;
}) {
  const { plant, turn } = props;
  const viewedRule = turn.rules.plant_species[plant.species] ?? null;
  const liveRule = props.liveRules?.plant_species[plant.species] ?? null;
  // In history the viewed turn's rule may differ from the live one the form edits: show it read-only first.
  const showViewed = !turn.live && JSON.stringify(viewedRule) !== JSON.stringify(liveRule);
  return (
    <div>
      {showViewed ? (
        <Section title={<>Species rule as of turn {turn.turn.turn_id} <span className="insp-scope-tag insp-scope-species">shared by every {plant.species} plant</span></>}>
          {viewedRule ? (
            <PlantRulesEditor species={[viewedRule]} onChange={NOOP} readOnly highlight={{ species: viewedRule.name, stageIndex: plant.stage_index }} />
          ) : (
            <p className="insp-bad">No species rule named "{plant.species}" in that turn's rules.</p>
          )}
        </Section>
      ) : null}
      {props.liveRules ? (
        <SpeciesRulePanel key={plant.species} species={plant.species} liveRule={liveRule} stageIndex={plant.stage_index} onStage={props.onStage} />
      ) : (
        <p className="insp-muted">Loading the live rules…</p>
      )}
    </div>
  );
}
