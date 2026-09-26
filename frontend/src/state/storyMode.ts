/**
 * Pure helpers for Story Mode's deterministic step 0 and brief card (no React;
 * unit-tested in state.test.mjs).  WP6 extends this module; the exports here
 * are the starting contract.
 *
 * DOCS: chip option lists (genre, tone, vividness 1-5, point of view, chapter
 * unit), turn-range validation over a run's committed turn ids, and the
 * chapter count / cost / time estimate for per-turn and per-round chapters.
 * The UI estimate is indicative only: the story brief's own estimate (from the
 * backend) is what the Accept button commits to.
 */

import { parseTurnId } from "../api/types";

// ---------------------------------------------------------------- chips

export interface ChipOption<T extends string | number = string> {
  value: T;
  label: string;
  /** Tooltip / screen-reader hint. */
  hint?: string;
}

export const GENRE_OPTIONS: ChipOption[] = [
  { value: "myth", label: "Myth", hint: "An origin legend told by a chronicler." },
  { value: "survival", label: "Survival", hint: "Scarcity, hunger and hard choices." },
  { value: "adventure", label: "Adventure" },
  { value: "tragedy", label: "Tragedy" },
  { value: "mystery", label: "Mystery" },
  { value: "comedy", label: "Comedy" },
  { value: "fable", label: "Fable", hint: "Short, with a moral." },
  { value: "science_fiction", label: "Science fiction" },
];

export const TONE_OPTIONS: ChipOption[] = [
  { value: "hopeful", label: "Hopeful" },
  { value: "grim", label: "Grim" },
  { value: "wry", label: "Wry" },
  { value: "tender", label: "Tender" },
  { value: "epic", label: "Epic" },
  { value: "eerie", label: "Eerie" },
];

export type Vividness = 1 | 2 | 3 | 4 | 5;

export const VIVIDNESS_OPTIONS: ChipOption<Vividness>[] = [
  { value: 1, label: "1 · Plain", hint: "A factual chronicle." },
  { value: 2, label: "2 · Light", hint: "Some colour, mostly events." },
  { value: 3, label: "3 · Balanced", hint: "Scenes and events in equal measure." },
  { value: 4, label: "4 · Vivid", hint: "Scenery, senses, invented dialogue." },
  { value: 5, label: "5 · Lush", hint: "Richly embellished; the facts stay the same." },
];

export type ChapterUnit = "turn" | "round";

export const CHAPTER_UNIT_OPTIONS: ChipOption<ChapterUnit>[] = [
  { value: "turn", label: "One chapter per turn", hint: "The default; quiet turns become short interludes." },
  { value: "round", label: "One chapter per round", hint: "Fewer, longer chapters." },
];

/** Point of view: an omniscient chronicler, or following one agent. */
export type StoryPov = { kind: "chronicler" } | { kind: "follow"; agentId: string };

/** POV chips: the chronicler, then "Follow <name>" per agent (value "chronicler" or "follow:<agent_id>"). */
export function povOptions(agents: { id: string; name: string }[]): ChipOption[] {
  return [
    { value: "chronicler", label: "Chronicler", hint: "An all-seeing narrator." },
    ...agents.map((a) => ({ value: `follow:${a.id}`, label: `Follow ${a.name}`, hint: `Tell it through ${a.name} (${a.id}).` })),
  ];
}

/** The POV a chip value stands for (unknown values fall back to the chronicler). */
export function parsePov(value: string): StoryPov {
  return value.startsWith("follow:") && value.length > 7 ? { kind: "follow", agentId: value.slice(7) } : { kind: "chronicler" };
}

export interface StoryChoices {
  genre: string;
  tone: string;
  vividness: Vividness;
  pov: StoryPov;
  unit: ChapterUnit;
  range: TurnRange;
}

/** Step-0 defaults: every chip preselected, the whole run. */
export const DEFAULT_STORY_CHOICES: StoryChoices = {
  genre: "myth",
  tone: "epic",
  vividness: 3,
  pov: { kind: "chronicler" },
  unit: "turn",
  range: { from: null, to: null },
};

// ---------------------------------------------------------------- turn range

/** Inclusive range of committed turn ids; null ends mean "from the start" / "to the latest turn". */
export interface TurnRange {
  from: string | null;
  to: string | null;
}

/** What a range covers: turn counts drive the chapter estimate. */
export interface RangeCounts {
  /** Agent turns (one chapter or interlude each in per-turn mode). */
  agentTurns: number;
  /** Distinct rounds with at least one agent turn (one chapter each in per-round mode). */
  rounds: number;
}

export interface RangeCheck {
  ok: boolean;
  problems: string[];
  /** The selected turn ids in commit order (empty when not ok). */
  turnIds: string[];
  counts: RangeCounts;
}

/** Counts of agent turns and rounds among `turnIds` (init and round-end checkpoints are not chapters). */
export function countTurns(turnIds: string[]): RangeCounts {
  const rounds = new Set<number>();
  let agentTurns = 0;
  for (const id of turnIds) {
    let parsed;
    try {
      parsed = parseTurnId(id);
    } catch {
      continue;
    }
    if (parsed.kind !== "agent_turn" || Number.isNaN(parsed.round)) continue;
    agentTurns += 1;
    rounds.add(parsed.round);
  }
  return { agentTurns, rounds: rounds.size };
}

/**
 * Validate `range` against the run's committed turn ids (commit order, as
 * GET /turns lists them): both ends must exist, `from` must not come after
 * `to`, and the range must contain at least one agent turn.
 */
export function validateTurnRange(range: TurnRange, turnIds: string[]): RangeCheck {
  const problems: string[] = [];
  const fromIndex = range.from ? turnIds.indexOf(range.from) : 0;
  const toIndex = range.to ? turnIds.indexOf(range.to) : turnIds.length - 1;
  if (turnIds.length === 0) problems.push("This run has no recorded turns yet.");
  if (range.from && fromIndex < 0) problems.push(`Start turn ${range.from} is not in this run.`);
  if (range.to && toIndex < 0) problems.push(`End turn ${range.to} is not in this run.`);
  if (!problems.length && fromIndex > toIndex) problems.push(`Start turn ${range.from} comes after end turn ${range.to}.`);
  const selected = problems.length ? [] : turnIds.slice(fromIndex, toIndex + 1);
  const counts = countTurns(selected);
  if (!problems.length && counts.agentTurns === 0) problems.push("The range has no agent turns to tell.");
  return { ok: problems.length === 0, problems, turnIds: problems.length ? [] : selected, counts };
}

// ---------------------------------------------------------------- estimates

/** Per-call cost and time assumptions for the estimate (indicative; measured Sonnet chapters ran ~$0.04 and 15-25 s). */
export interface ChapterCostModel {
  chapterUsd: number;
  chapterSeconds: number;
  /** A per-round chapter covers several turns: its cost and time are the per-turn ones times this factor. */
  roundFactor: number;
  /** The story-so-far summarizer runs once every `summaryEvery` chapters. */
  summaryEvery: number;
  summaryUsd: number;
  summarySeconds: number;
}

export const DEFAULT_CHAPTER_COST: ChapterCostModel = {
  chapterUsd: 0.04,
  chapterSeconds: 20,
  roundFactor: 1.8,
  summaryEvery: 5,
  summaryUsd: 0.01,
  summarySeconds: 8,
};

export interface ChapterEstimate {
  unit: ChapterUnit;
  chapters: number;
  /** Summarizer refreshes included in the totals. */
  summaries: number;
  costUsd: number;
  seconds: number;
}

/** Chapters, cost and time to generate every chapter of `counts` in `unit` mode (sequential calls). */
export function estimateChapters(counts: RangeCounts, unit: ChapterUnit, model: ChapterCostModel = DEFAULT_CHAPTER_COST): ChapterEstimate {
  const chapters = Math.max(0, unit === "turn" ? counts.agentTurns : counts.rounds);
  const factor = unit === "round" ? model.roundFactor : 1;
  const summaries = model.summaryEvery > 0 ? Math.floor(chapters / model.summaryEvery) : 0;
  const costUsd = chapters * model.chapterUsd * factor + summaries * model.summaryUsd;
  const seconds = chapters * model.chapterSeconds * factor + summaries * model.summarySeconds;
  return { unit, chapters, summaries, costUsd: Math.round(costUsd * 10000) / 10000, seconds: Math.round(seconds) };
}

/** Both estimates side by side (the brief card shows per-turn and per-round together). */
export function estimateBoth(counts: RangeCounts, model: ChapterCostModel = DEFAULT_CHAPTER_COST): Record<ChapterUnit, ChapterEstimate> {
  return { turn: estimateChapters(counts, "turn", model), round: estimateChapters(counts, "round", model) };
}

/** "≈$0.52" (two decimals, "<$0.01" for tiny amounts). */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `≈$${usd.toFixed(2)}`;
}

/** "~40 s", "~6 min", "~2 h 5 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `~${Math.max(0, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  const rest = minutes % 60;
  return `~${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}

/** "12 chapters · ≈$0.52 · ~5 min". */
export function formatEstimate(estimate: ChapterEstimate): string {
  const noun = estimate.chapters === 1 ? "chapter" : "chapters";
  return `${estimate.chapters} ${noun} · ${formatUsd(estimate.costUsd)} · ${formatDuration(estimate.seconds)}`;
}
