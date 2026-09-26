/**
 * Pure helpers for the New session form (spec "Sessions and run controls":
 * editable cards prefilled with defaults, add/remove within 6–12, validate
 * and explain invalid values by path; INTERFACES section 9 "Setup
 * validation" problem paths such as agents[2].position).
 */

import type { Agent, AgentCard, ApiProblem, ModelInfo, PlantSpeciesRule, RunCreateRequest } from "../api/types";

export const MIN_AGENTS = 6;
export const MAX_AGENTS = 12;

/** Problems whose path is exactly one of `paths`. */
export function problemsAt(problems: readonly ApiProblem[], ...paths: string[]): ApiProblem[] {
  return problems.filter((p) => paths.includes(p.path));
}

/** Problems whose path starts with `prefix` followed by ".", "[" or the end. */
export function problemsUnder(problems: readonly ApiProblem[], prefix: string): ApiProblem[] {
  return problems.filter((p) => p.path === prefix || p.path.startsWith(`${prefix}.`) || p.path.startsWith(`${prefix}[`));
}

/** Problems not claimed by any of the given prefixes (shown in a general list). */
export function problemsOutside(problems: readonly ApiProblem[], prefixes: readonly string[]): ApiProblem[] {
  return problems.filter((p) => !prefixes.some((prefix) => p.path === prefix || p.path.startsWith(`${prefix}.`) || p.path.startsWith(`${prefix}[`)));
}

/**
 * A new card for "Add agent card": the first template (from GET /defaults
 * with 11 cards) whose id and name are unused, else a copy of the last card
 * with the lowest unused aNN id.
 */
export function newCard(cards: readonly AgentCard[], templates: readonly AgentCard[]): AgentCard {
  const ids = new Set(cards.map((c) => c.id ?? ""));
  const names = new Set(cards.map((c) => c.name));
  const template = templates.find((t) => !ids.has(t.id ?? "") && !names.has(t.name));
  if (template) return structuredClone(template);
  const base = structuredClone(cards[cards.length - 1] ?? templates[0]);
  let n = 1;
  while (ids.has(`a${String(n).padStart(2, "0")}`)) n += 1;
  const id = `a${String(n).padStart(2, "0")}`;
  let name = `Agent ${n}`;
  while (names.has(name)) name = `${name}+`;
  return { ...base, id, name };
}

/** rules.plant_species as a list for PlantRulesEditor. */
export function speciesList(request: RunCreateRequest): PlantSpeciesRule[] {
  return Object.values(request.rules.plant_species);
}

/**
 * Back from the editor's list to rules.plant_species (keyed by rule.name) and
 * world.initial_plants: renamed species keep their plant count, removed
 * species lose it.  Duplicate names keep the first rule (the editor warns).
 */
export function withSpecies(request: RunCreateRequest, list: readonly PlantSpeciesRule[]): RunCreateRequest {
  const oldNames = Object.keys(request.rules.plant_species);
  const plantSpecies: Record<string, PlantSpeciesRule> = {};
  const initialPlants: Record<string, number> = {};
  list.forEach((rule, index) => {
    if (rule.name in plantSpecies) return;
    plantSpecies[rule.name] = rule;
    const previousName = oldNames[index];
    const count = request.world.initial_plants[rule.name] ?? (previousName !== undefined ? request.world.initial_plants[previousName] : undefined);
    if (count !== undefined) initialPlants[rule.name] = count;
  });
  return {
    ...request,
    rules: { ...request.rules, plant_species: plantSpecies },
    world: { ...request.world, initial_plants: initialPlants },
  };
}

/** The capabilities used to check context settings of a card (its model, else the run default). */
export function cardModel(card: AgentCard, request: RunCreateRequest, models: readonly ModelInfo[]): ModelInfo | null {
  const key = card.model_key || request.default_model_key;
  return models.find((m) => m.key === key) ?? null;
}

/**
 * A preview-only Agent built from a card so MapView can show where the cards
 * start (the real agents are created by the backend).
 */
export function previewAgent(card: AgentCard, index: number): Agent {
  return {
    kind: "agent",
    id: card.id || `card${index + 1}`,
    name: card.name,
    position: card.position,
    stats: card.stats,
    upgrade_counts: {},
    persona: card.persona,
    alive: true,
    created_round: 0,
    died_round: null,
    death_cause: null,
    skills: {},
    skill_execution: null,
    wait_turns_remaining: 0,
    last_action: null,
    last_result: null,
    total_compute_spent: 0,
    total_cognition_spent: 0,
    total_interpreter_spent: 0,
    model_call_count: 0,
  };
}

/** Rules other than plant species, as editable JSON text (advanced section). */
export function otherRulesText(request: RunCreateRequest): string {
  const rest: Record<string, unknown> = { ...request.rules };
  delete rest.plant_species;
  return JSON.stringify(rest, null, 2);
}

/** Parse the advanced rules JSON; returns the merged request or an error message. */
export function applyOtherRules(request: RunCreateRequest, text: string): { request: RunCreateRequest } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "must be a JSON object" };
  const merged = { ...request.rules, ...(parsed as Record<string, unknown>), plant_species: request.rules.plant_species };
  return { request: { ...request, rules: merged as RunCreateRequest["rules"] } };
}

/** Local file-name-safe check of the run name (the backend accepts any string). */
export function trimmedName(name: string): string {
  return name.trim() || "New run";
}
