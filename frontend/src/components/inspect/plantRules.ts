/**
 * Plant-rule field catalogue, templates and local sanity checks used by
 * PlantRulesEditor (schemas.PlantSpeciesRule / PlantStageRule; spec U3).
 * Pure: no React.
 */

import type { PlantSpeciesRule, PlantStageRule } from "../../api/types";

type SpeciesNumberField = Exclude<keyof PlantSpeciesRule, "name" | "description" | "stages">;
type StageNumberField = Exclude<keyof PlantStageRule, "name">;

interface FieldSpec<F> {
  field: F;
  integer: boolean;
  hint: string;
  fraction?: boolean;
}

/** Species-level fields in schema order, with the meaning from schemas.PlantSpeciesRule. */
export const SPECIES_FIELDS: FieldSpec<SpeciesNumberField>[] = [
  { field: "initial_essence", integer: false, hint: "living essence supplied by the source at germination / placement" },
  { field: "max_fruit", integer: true, hint: "live fruit entities at once" },
  { field: "fruit_energy", integer: false, hint: "compute available in one new fruit" },
  { field: "fruit_decay_rounds", integer: true, hint: "fruit rots after this many rounds (0 = never)" },
  { field: "seed_germination_delay_rounds", integer: true, hint: "rounds before a seed germinates" },
  { field: "seed_dispersal_radius", integer: true, hint: "seeds land within this Manhattan radius (0 = parent point)" },
  { field: "max_seeds_alive", integer: true, hint: "live seeds per plant at once" },
  { field: "essence_residue_fraction", integer: false, fraction: true, hint: "share of living essence left as residue at death (0..1)" },
  { field: "energy_residue_fraction", integer: false, fraction: true, hint: "share of stored energy left as residue at death (0..1)" },
];

/** Stage fields in schema order, with the meaning from schemas.PlantStageRule. */
export const STAGE_FIELDS: FieldSpec<StageNumberField>[] = [
  { field: "min_age_rounds", integer: true, hint: "plant enters this stage at this age" },
  { field: "size", integer: false, hint: "descriptive growth size" },
  { field: "energy_inflow_per_round", integer: false, hint: "energy admitted from the source each round" },
  { field: "essence_inflow_per_round", integer: false, hint: "living essence admitted each round" },
  { field: "max_energy", integer: false, hint: "stored energy cap in this stage" },
  { field: "max_essence", integer: false, hint: "living essence cap in this stage" },
  { field: "fruit_interval_rounds", integer: true, hint: "rounds between fruit (0 = no fruit)" },
  { field: "seed_interval_rounds", integer: true, hint: "rounds between seeds (0 = no seeds)" },
];

/** A new stage with the schema defaults (schemas.PlantStageRule). */
export function newStage(name: string, minAge: number): PlantStageRule {
  return {
    name,
    min_age_rounds: minAge,
    size: 1,
    energy_inflow_per_round: 0,
    essence_inflow_per_round: 0,
    max_energy: 180,
    max_essence: 0,
    fruit_interval_rounds: 0,
    seed_interval_rounds: 0,
  };
}

/** A new species with the schema defaults (schemas.PlantSpeciesRule) and one stage. */
export function newSpecies(name: string): PlantSpeciesRule {
  return {
    name,
    description: "",
    stages: [newStage("stage_0", 0)],
    initial_essence: 5,
    max_fruit: 3,
    fruit_energy: 60,
    fruit_decay_rounds: 0,
    seed_germination_delay_rounds: 10,
    seed_dispersal_radius: 1,
    max_seeds_alive: 2,
    essence_residue_fraction: 0.5,
    energy_residue_fraction: 0,
  };
}

export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

/** Local sanity checks shown under each species (the backend validates authoritatively). */
export function plantRuleWarnings(rule: PlantSpeciesRule, allNames: string[]): string[] {
  const warnings: string[] = [];
  if (!rule.name.trim()) warnings.push("name must not be empty");
  if (allNames.filter((n) => n === rule.name).length > 1) warnings.push(`name "${rule.name}" is used by more than one species`);
  if (rule.stages.length === 0) warnings.push("a species needs at least one stage");
  for (const spec of SPECIES_FIELDS) {
    const v = rule[spec.field];
    if (v < 0) warnings.push(`${spec.field} is negative`);
    if (spec.fraction && v > 1) warnings.push(`${spec.field} should be between 0 and 1`);
  }
  rule.stages.forEach((stage, i) => {
    if (!stage.name.trim()) warnings.push(`stage ${i}: name must not be empty`);
    for (const spec of STAGE_FIELDS) {
      if (stage[spec.field] < 0) warnings.push(`stage ${i} (${stage.name}): ${spec.field} is negative`);
    }
    if (i === 0 && stage.min_age_rounds !== 0) warnings.push(`stage 0 (${stage.name}): min_age_rounds is usually 0`);
    if (i > 0 && stage.min_age_rounds < rule.stages[i - 1].min_age_rounds) {
      warnings.push(`stage ${i} (${stage.name}): min_age_rounds is below the previous stage's`);
    }
  });
  return warnings;
}
