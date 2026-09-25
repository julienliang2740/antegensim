/**
 * Inspection components: map, occupant list, inspector, god mode, plant-rule
 * and context-settings editors.  Props are documented in ./props.ts.  The
 * components never fetch; the app shell passes data and performs callbacks.
 */

export { MapView } from "./MapView";
export { OccupantList } from "./OccupantList";
export { InspectorPanel } from "./InspectorPanel";
export { GodModePanel } from "./GodModePanel";
export { PlantRulesEditor } from "./PlantRulesEditor";
export { plantRuleWarnings } from "./plantRules";
export { ContextSettingsEditor } from "./ContextSettingsEditor";

export type {
  ContextSettingsEditorProps,
  GodModePanelProps,
  InspectorPanelProps,
  MapViewProps,
  OccupantListProps,
  PlantRulesEditorProps,
} from "./props";

export {
  agentSettings,
  applyOverrides,
  describeIntervention,
  entitiesAtPoint,
  flattenEntities,
  groupByPoint,
  interventionSeq,
  presenceInTurn,
  problemsFromError,
  removedList,
  stagedIntervention,
} from "./logic";
export type { AgentSettingsSummary, Presence, PresenceStatus, StagedItem } from "./logic";
export { validateContextSettings, MIN_GENERATION_TOKENS, MIN_PACKET_INPUT_TOKENS } from "./contextLimits";
export { entityOneLine, entityTitle, fmtNum, fmtPoint } from "./format";
export type { AgentViewOverlay } from "./props";
export type { MapMarker } from "./logic";
export { entityMarkers, markersAtPoint, overlayMarkers, sightingLine } from "./logic";
