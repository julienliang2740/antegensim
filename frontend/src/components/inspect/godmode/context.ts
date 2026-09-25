/**
 * The context every god-mode form receives (built once by GodModePanel) and
 * small lookups on it.  Pure: no React, no fetch.
 */

import type {
  Agent,
  ApiProblem,
  EffectiveSettingsView,
  Entity,
  Intervention,
  ModelCapabilities,
  ModelInfo,
  Point,
  RulesConfig,
  RunSettings,
} from "../../../api/types";

/** Everything a god-mode form needs; built once by GodModePanel. */
export interface GodModeContext {
  agents: Agent[];
  entities: Entity[];
  rules: RulesConfig;
  settings: RunSettings;
  effective: EffectiveSettingsView | null;
  models: ModelInfo[];
  disabled: boolean;
  busy: boolean;
  defaultPoint: Point | null;
  /** Stage one or more interventions in order; resolves true when all were accepted. */
  stage(interventions: Intervention[]): Promise<boolean>;
  /** Show local validation problems next to the form without calling the backend. */
  reject(problems: ApiProblem[]): void;
}

/** The model key an agent uses now (live effective view first, then RunSettings). */
export function effectiveModelKey(ctx: GodModeContext, agentId: string): string {
  return ctx.effective?.effective_model_key[agentId] ?? ctx.settings.model_overrides[agentId] ?? ctx.settings.default_model_key;
}

export function capabilitiesOf(ctx: GodModeContext, modelKey: string): ModelCapabilities | null {
  return ctx.models.find((m) => m.key === modelKey)?.capabilities ?? null;
}
