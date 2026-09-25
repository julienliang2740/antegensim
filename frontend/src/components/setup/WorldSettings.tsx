/**
 * World settings for run setup (spec "Sessions and run controls": usable
 * world/plant settings; design "Spawned terrain and passage"): region,
 * terrain generation, initial plants per species and the observation page
 * size.  Problems under world.* are shown next to the fields.
 */

import type { ApiProblem, RunCreateRequest, TerrainGenConfig, WorldConfig } from "../../api/types";
import { NumberField } from "../common/NumberField";
import { FieldProblems } from "../common/Problems";
import { problemsAt } from "../../state/setupForm";

const TERRAIN_FIELDS: { key: keyof TerrainGenConfig; hint: string }[] = [
  { key: "mountain_clusters", hint: "number of mountain clusters (impassable)" },
  { key: "mountain_cluster_size", hint: "cells per mountain cluster" },
  { key: "water_clusters", hint: "number of water clusters (no plants)" },
  { key: "water_cluster_size", hint: "cells per water cluster" },
  { key: "keep_origin_clear_radius", hint: "no terrain within this distance of (0, 0)" },
];

export function WorldSettings(props: { request: RunCreateRequest; problems: ApiProblem[]; onChange(world: WorldConfig): void }) {
  const world = props.request.world;
  const at = (path: string) => problemsAt(props.problems, `world.${path}`);
  const setRegion = (key: keyof WorldConfig["region"], value: number) => props.onChange({ ...world, region: { ...world.region, [key]: value } });
  const setTerrain = (key: keyof TerrainGenConfig, value: number) => props.onChange({ ...world, terrain: { ...world.terrain, [key]: value } });
  const species = Object.keys(props.request.rules.plant_species);

  return (
    <div className="world-settings">
      <fieldset className="card-group">
        <legend>Region (inclusive bounds)</legend>
        <div className="inline-fields">
          {(["min_x", "max_x", "min_y", "max_y"] as const).map((key) => (
            <label key={key} className="field field-short">
              <span>{key}</span>
              <NumberField integer value={world.region[key]} invalid={at(`region.${key}`).length > 0} onChange={(v) => setRegion(key, v ?? 0)} />
            </label>
          ))}
        </div>
        <FieldProblems problems={[...at("region"), ...at("region.min_x"), ...at("region.max_x"), ...at("region.min_y"), ...at("region.max_y")]} />
      </fieldset>

      <fieldset className="card-group">
        <legend>Terrain generation (from the seed)</legend>
        <div className="form-table">
          {TERRAIN_FIELDS.map(({ key, hint }) => (
            <div key={key} className="form-row">
              <label className="field">
                <span>{key}</span>
                <NumberField integer value={world.terrain[key]} invalid={at(`terrain.${key}`).length > 0} onChange={(v) => setTerrain(key, v ?? 0)} />
              </label>
              <span className="hint">{hint}</span>
              <FieldProblems problems={at(`terrain.${key}`)} />
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="card-group">
        <legend>Plants at the start</legend>
        <div className="form-table">
          {species.map((name) => (
            <div key={name} className="form-row">
              <label className="field">
                <span>initial {name} plants</span>
                <NumberField
                  integer
                  value={world.initial_plants[name] ?? 0}
                  invalid={at(`initial_plants.${name}`).length > 0}
                  onChange={(v) => props.onChange({ ...world, initial_plants: { ...world.initial_plants, [name]: v ?? 0 } })}
                />
              </label>
              <span className="hint">placed on random land cells</span>
              <FieldProblems problems={at(`initial_plants.${name}`)} />
            </div>
          ))}
          <div className="form-row">
            <label className="field">
              <span>initial plant stage</span>
              <NumberField
                integer
                value={world.initial_plant_stage}
                invalid={at("initial_plant_stage").length > 0}
                onChange={(v) => props.onChange({ ...world, initial_plant_stage: v ?? 0 })}
              />
            </label>
            <span className="hint">stage index the starting plants begin in (0 = first stage)</span>
            <FieldProblems problems={at("initial_plant_stage")} />
          </div>
          <div className="form-row">
            <label className="field">
              <span>initial fruit per plant</span>
              <NumberField
                integer
                value={world.initial_plant_fruit}
                invalid={at("initial_plant_fruit").length > 0}
                onChange={(v) => props.onChange({ ...world, initial_plant_fruit: v ?? 0 })}
              />
            </label>
            <span className="hint">ripe fruit on each starting plant at round 0, capped by the species max_fruit (A-PLANT-13); 0 = plants start with an empty store</span>
            <FieldProblems problems={at("initial_plant_fruit")} />
          </div>
          <div className="form-row">
            <label className="field field-check">
              <span>plants at agent starts</span>
              <input
                type="checkbox"
                checked={world.plants_at_agent_starts}
                onChange={(e) => props.onChange({ ...world, plants_at_agent_starts: e.target.checked })}
              />
            </label>
            <span className="hint">the first starting plants of each species go to the agents' start cells, the rest to random land (A-WORLD-7); off = all random</span>
            <FieldProblems problems={at("plants_at_agent_starts")} />
          </div>
          <div className="form-row">
            <label className="field">
              <span>observation page size</span>
              <NumberField
                integer
                value={world.max_entities_per_observation_page}
                invalid={at("max_entities_per_observation_page").length > 0}
                onChange={(v) => props.onChange({ ...world, max_entities_per_observation_page: v ?? 1 })}
              />
            </label>
            <span className="hint">entities listed per observe page (A-ACT-4)</span>
            <FieldProblems problems={at("max_entities_per_observation_page")} />
          </div>
        </div>
        <FieldProblems problems={at("initial_plants")} />
      </fieldset>
    </div>
  );
}
