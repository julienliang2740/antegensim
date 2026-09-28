import type { AgentKnowledgeView, Terrain } from "../api/types";
import { pointKey } from "../api/types";

/** Cells disclosed by the agent's own records. A null value means the location is known, but its terrain is not. */
export function knownTerrainFromKnowledge(view: AgentKnowledgeView): Record<string, Terrain | null> {
  const known: Record<string, Terrain | null> = Object.create(null);
  for (const record of view.knowledge.records) {
    if (record.kind !== "observation" || record.provenance.source !== "own_action") continue;
    const result = record.content.result;
    if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("data" in result)) continue;
    const data = result.data;
    if (!data || typeof data !== "object" || !("point" in data)) continue;
    const point = data.point;
    if (!point || typeof point !== "object" || !("x" in point) || !("y" in point) || typeof point.x !== "number" || typeof point.y !== "number") continue;
    const terrain = "terrain" in data ? data.terrain : null;
    known[pointKey({ x: point.x, y: point.y })] = terrain === "land" || terrain === "mountain" || terrain === "water" ? terrain : null;
  }
  for (const sighting of view.observed_entities) {
    const key = pointKey(sighting.position);
    if (!(key in known)) known[key] = null;
  }
  if (view.believed_self.position) {
    const key = pointKey(view.believed_self.position);
    if (!(key in known)) known[key] = null;
  }
  return known;
}
