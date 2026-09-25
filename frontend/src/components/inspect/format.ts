/**
 * Pure display helpers shared by the inspection components.
 *
 * Nothing here fetches or mutates: every function turns typed API data
 * (src/api/types.ts) into short readable strings.  Display rounding only;
 * the backend keeps full precision (INTERFACES.md section 3 "Money") and the
 * components show the exact value in a title attribute where it matters.
 */

import type { Entity, EntityKind, Point, RulesConfig } from "../../api/types";

/**
 * Readable number: integers as-is, otherwise up to 3 decimals with trailing
 * zeros removed.  A fraction never displays as a whole number (199.9999 is
 * "199.9999", not "200"): more decimals are shown until it no longer looks
 * untouched.  Every view (roster, occupants, hover card, inspector) uses this.
 */
export function fmtNum(value: number | null | undefined): string {
  if (value === null || value === undefined) return "unknown";
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.001) return value.toPrecision(2);
  for (let decimals = 3; decimals <= 9; decimals += 1) {
    const rounded = Number(value.toFixed(decimals));
    if (!Number.isInteger(rounded)) return String(rounded);
  }
  return String(value);
}

/** "(x, y)" */
export function fmtPoint(p: Point | null | undefined): string {
  if (!p) return "(?, ?)";
  return `(${p.x}, ${p.y})`;
}

/** Any JSON value on one line (for vars, args, before/after values). */
export function fmtValue(value: unknown, maxChars = 120): string {
  let text: string;
  if (value === undefined) text = "undefined";
  else if (typeof value === "string") text = JSON.stringify(value);
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text === undefined) text = String(value);
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** Pretty JSON for <pre> blocks. */
export function fmtJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Human label for an entity kind (plural when count != 1). */
export function kindLabel(kind: EntityKind, count = 1): string {
  const singular: Record<EntityKind, string> = {
    agent: "agent",
    plant: "plant",
    fruit: "fruit",
    seed: "seed",
    residue: "residue",
  };
  const plural: Record<EntityKind, string> = {
    agent: "agents",
    plant: "plants",
    fruit: "fruit",
    seed: "seeds",
    residue: "residues",
  };
  return count === 1 ? singular[kind] : plural[kind];
}

/** One-letter tag used on map badges, occupant rows and the legend. */
export const KIND_LETTER: Record<EntityKind, string> = {
  agent: "A",
  plant: "P",
  fruit: "F",
  seed: "S",
  residue: "R",
};

/** Mark for dead agents and plants on map badges and kind tags. */
export const DEAD_MARK = "✕";

/** Display order: agents, plants, fruit, residue, seeds. */
export const KIND_ORDER: EntityKind[] = ["agent", "plant", "fruit", "residue", "seed"];

/** True for agents and plants that are dead (their records stay in the world). */
export function isDead(entity: Entity): boolean {
  return (entity.kind === "agent" || entity.kind === "plant") && !entity.alive;
}

/** "Aster (a01)" for agents, the id for everything else. */
export function entityTitle(entity: Entity): string {
  if (entity.kind === "agent") return `${entity.name} (${entity.id})`;
  if (entity.kind === "plant" || entity.kind === "seed") return `${entity.id} ${entity.species}`;
  return entity.id;
}

/** Stage name of a plant from the species rule, or "stage N" when the rule is unknown. */
export function plantStageName(stageIndex: number, species: string, rules: RulesConfig | null | undefined): string {
  const rule = rules?.plant_species[species];
  const stage = rule?.stages[stageIndex];
  return stage ? `${stage.name} (stage ${stageIndex})` : `stage ${stageIndex}`;
}

/**
 * Quick stats on one line (map tooltip and occupant list):
 * agent: health/max, compute, essence; plant: species, stage, fruit count;
 * fruit/residue: available compute/essence; seed: species and germination round.
 */
export function entityOneLine(entity: Entity, rules?: RulesConfig | null): string {
  switch (entity.kind) {
    case "agent": {
      const s = entity.stats;
      const base = `health ${fmtNum(s.health)}/${fmtNum(s.max_health)} · compute ${fmtNum(s.compute)} · essence ${fmtNum(s.essence)}/${fmtNum(s.essence_capacity)}`;
      if (!entity.alive) {
        return `DEAD since round ${entity.died_round ?? "?"}${entity.death_cause ? ` (${entity.death_cause})` : ""}`;
      }
      return base;
    }
    case "plant": {
      const stage = plantStageName(entity.stage_index, entity.species, rules);
      const life = entity.alive ? "" : ` · DEAD round ${entity.died_round ?? "?"}`;
      return `${entity.species} · ${stage} · ${entity.fruit_ids.length} fruit · essence ${fmtNum(entity.essence)}${life}`;
    }
    case "fruit":
      return `compute ${fmtNum(entity.available_compute)} · essence ${fmtNum(entity.available_essence)}${entity.plant_id ? ` · from ${entity.plant_id}` : ""}`;
    case "residue":
      return `compute ${fmtNum(entity.available_compute)} · essence ${fmtNum(entity.available_essence)} · from ${entity.source_kind} ${entity.source_id}`;
    case "seed":
      return `${entity.species} · germinates round ${entity.germinates_round}${entity.plant_id ? ` · from ${entity.plant_id}` : ""}`;
  }
}

/** Sort key: kind order, living before dead, then id. */
export function compareEntities(a: Entity, b: Entity): number {
  const ka = KIND_ORDER.indexOf(a.kind);
  const kb = KIND_ORDER.indexOf(b.kind);
  if (ka !== kb) return ka - kb;
  const da = isDead(a) ? 1 : 0;
  const db = isDead(b) ? 1 : 0;
  if (da !== db) return da - db;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
