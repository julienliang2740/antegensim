/**
 * Props of the 3D view (components/map3d/Map3dView.tsx) and the layer seam.
 *
 * The 3D view is fed by the same props as the 2D map (MapViewProps: map,
 * entities, removed, selection callbacks, highlight, rules, persistKey, agent
 * view) plus the viewed turn's effects and id, whether the page shows the live
 * state, whether something covers the map, and a way back to the 2D map for
 * the fallbacks.  `layers` is the seam for stacked worlds: when absent the
 * view builds one layer ("World") from `map` and `entities`.
 */

// DOCS: Map3dProps = MapViewProps minus heightPx/fill/effects/turnId/pendingAgentId, plus effects, turnId, live, paused, layers?, onBackTo2d.

import type { Entity, MapState } from "../../api/types";
import type { TurnEffect } from "../../state/turnEffects";
import type { MapMarker } from "../inspect/logic";
import type { MapViewProps } from "../inspect/props";

/**
 * One board of the stack.  Layer 0 is drawn at scene y 0, layer i at
 * i * LAYER_GAP (state/map3dLayout.ts); the last layer is the active one when
 * the view mounts.  `markers` are what the layer draws (entityMarkers or
 * overlayMarkers of components/inspect/logic.ts); `entities` gives the health
 * discs, plant sizes and species, agent names and communication ranges.
 */
export interface LayerInput {
  id: string;
  label: string;
  map: MapState;
  markers: MapMarker[];
  entities: ReadonlyMap<string, Entity>;
}

export type Map3dProps = Omit<MapViewProps, "heightPx" | "fill" | "effects" | "turnId" | "pendingAgentId"> & {
  /** The viewed turn's effects (state/turnEffects.ts::turnEffects(viewed)): chips and animations. */
  effects: readonly TurnEffect[];
  /** The viewed turn's id: a change restarts the animations once. */
  turnId: string;
  /** True while the page shows the live state (animations are squeezed to the live turn rate). */
  live: boolean;
  /** True while something covers the map (the record overlay): no frames are drawn. */
  paused: boolean;
  /** Stacked boards; absent = one layer built from `map` and `entities`. */
  layers?: LayerInput[];
  /** The fallbacks' "Back to 2D map". */
  onBackTo2d(): void;
};
