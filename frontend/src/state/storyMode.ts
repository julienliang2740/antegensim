/**
 * Pure helpers for the Storybook tab and Story Mode (no React; unit-tested in
 * state.test.mjs).  OWNER: WP6.
 *
 * DOCS: chip option lists (genre, tone, vividness 1-5, point of view, chapter
 * unit), turn-range validation over a run's committed turn ids, the chapter
 * count / cost / time estimate for per-turn and per-round chapters, the
 * mapping between the step-0 chips and the backend's StoryQuickPicks, the
 * reader's lazy window (3 chapters ahead), the session's phase and polling
 * rule, and the Storybook tab's status line,
 * entity filter ("Following <name>") and polling rule (every 2.5 s while
 * entries are pending, else only when the turn changes).  The UI estimate is
 * indicative only: the story brief's own estimate (from the backend) is what
 * the Accept button commits to.
 */

import { parseTurnId } from "../api/types";
import type {
  JobView,
  StoryBrief,
  StoryChapter,
  StoryEstimate,
  StoryQuickPicks,
  StoryRunCard,
  StorySession,
  StoryStatus,
  StorybookEntry,
  StorybookStatus,
} from "../api/storyTypes";

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

/** "$0.12" (plain two decimals, for spend that already happened). */
export function formatSpent(usd: number): string {
  return `$${Math.max(0, usd).toFixed(2)}`;
}

/** Friendly tier name for an assistant model key ("claude-cli-haiku-assistant" -> "Haiku"). */
export function modelTier(modelKey: string | null | undefined): string {
  const key = (modelKey ?? "").toLowerCase();
  if (!key) return "";
  if (key.startsWith("fake")) return "fake model";
  if (key.includes("haiku")) return "Haiku";
  if (key.includes("sonnet")) return "Sonnet";
  if (key.includes("opus")) return "Opus";
  return modelKey ?? "";
}

// ---------------------------------------------------------------- step 0 <-> StoryQuickPicks

/** `options` plus a chip for `value` when it is not one of them (a backend suggestion such as "chronicle"). */
export function optionsWith(options: ChipOption[], value: string): ChipOption[] {
  if (!value || options.some((o) => o.value === value)) return options;
  const label = value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return [...options, { value, label }];
}

function asVividness(value: number): Vividness {
  const n = Math.round(Number.isFinite(value) ? value : 3);
  return Math.min(5, Math.max(1, n)) as Vividness;
}

/** The chips as the backend's StoryQuickPicks. */
export function choicesToPicks(choices: StoryChoices, language = "en"): StoryQuickPicks {
  return {
    genre: choices.genre,
    tone: choices.tone,
    vividness: asVividness(choices.vividness),
    pov: choices.pov.kind,
    follow_agent_id: choices.pov.kind === "follow" ? choices.pov.agentId : null,
    from_turn_id: choices.range.from,
    to_turn_id: choices.range.to,
    unit: choices.unit,
    language,
  };
}

/** StoryQuickPicks (a run card's suggestion or a saved session) as chip choices. */
export function picksToChoices(picks: Partial<StoryQuickPicks> | null | undefined): StoryChoices {
  if (!picks) return { ...DEFAULT_STORY_CHOICES };
  const pov: StoryPov = picks.pov === "follow" && picks.follow_agent_id ? { kind: "follow", agentId: picks.follow_agent_id } : { kind: "chronicler" };
  return {
    genre: picks.genre || DEFAULT_STORY_CHOICES.genre,
    tone: picks.tone || DEFAULT_STORY_CHOICES.tone,
    vividness: asVividness(picks.vividness ?? DEFAULT_STORY_CHOICES.vividness),
    pov,
    unit: picks.unit === "round" ? "round" : "turn",
    range: { from: picks.from_turn_id ?? null, to: picks.to_turn_id ?? null },
  };
}

/** The chip value of a POV ("chronicler" | "follow:<id>"), the inverse of parsePov. */
export function povValue(pov: StoryPov): string {
  return pov.kind === "follow" ? `follow:${pov.agentId}` : "chronicler";
}

/** What step 0 sends as the message text (the API needs one; the chips travel as picks). */
export function stepZeroText(freeText: string): string {
  const text = freeText.trim();
  return text || "Write the story with the choices above.";
}

/** "8 agents · 12 rounds · 96 turns · 3 deaths · 2 kills". */
export function runCardSummary(card: Pick<StoryRunCard, "cast" | "rounds" | "turns" | "deaths" | "kills">): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    plural(card.cast.length, "agent", "agents"),
    plural(card.rounds, "round", "rounds"),
    plural(card.turns, "turn", "turns"),
    plural(card.deaths, "death", "deaths"),
    plural(card.kills, "kill", "kills"),
  ].join(" · ");
}

/** "round 12 · turn 3" / "round 12 · round end" / "round 0 · initial state" for a run's last saved turn (as the Resume page words it). */
export function runProgressText(run: { current_turn_id: string; last_round: number; last_turn_index: number | null }): string {
  if (run.current_turn_id.endsWith("_init")) return "round 0 · initial state";
  if (run.last_turn_index === null) return `round ${run.last_round} · round end`;
  return `round ${run.last_round} · turn ${run.last_turn_index}`;
}

/** "round 3 · turn 2 · a05" for a turn id (for range selects and chapter captions). */
export function turnLabel(turnId: string): string {
  try {
    const parsed = parseTurnId(turnId);
    if (Number.isNaN(parsed.round)) return turnId;
    if (parsed.kind === "init") return "start of the run";
    if (parsed.kind === "round_end") return `end of round ${parsed.round}`;
    return `round ${parsed.round} · turn ${parsed.turn} · ${parsed.agentId}`;
  } catch {
    return turnId;
  }
}

// ---------------------------------------------------------------- brief card

/** Backend estimate as a ChapterEstimate (summaries are folded into its totals). */
export function fromStoryEstimate(estimate: StoryEstimate): ChapterEstimate {
  return { unit: estimate.unit, chapters: estimate.chapters, summaries: 0, costUsd: estimate.cost_usd, seconds: estimate.seconds };
}

/** Per-turn and per-round estimates of a brief: the backend's when present, else the local indicative one from `counts`. */
export function briefEstimates(brief: Pick<StoryBrief, "estimate_turn" | "estimate_round"> | null, counts: RangeCounts | null): Record<ChapterUnit, ChapterEstimate | null> {
  const local = counts ? estimateBoth(counts) : null;
  return {
    turn: brief?.estimate_turn ? fromStoryEstimate(brief.estimate_turn) : (local?.turn ?? null),
    round: brief?.estimate_round ? fromStoryEstimate(brief.estimate_round) : (local?.round ?? null),
  };
}

/** Chapters, interludes and other kinds in a chapter plan ("40 chapters, 25 interludes"). */
export function planSummary(plan: { kind: string }[]): string {
  const counts = new Map<string, number>();
  for (const entry of plan) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  const order = ["opening", "chapter", "interlude", "epilogue"];
  const nouns: Record<string, [string, string]> = {
    opening: ["opening", "openings"],
    chapter: ["chapter", "chapters"],
    interlude: ["short interlude", "short interludes"],
    epilogue: ["epilogue", "epilogues"],
  };
  const parts: string[] = [];
  for (const kind of [...order, ...[...counts.keys()].filter((k) => !order.includes(k))]) {
    const n = counts.get(kind);
    if (!n) continue;
    const [one, many] = nouns[kind] ?? [kind, kind];
    parts.push(`${n} ${n === 1 ? one : many}`);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------- reader

/** Chapters generated ahead of the reader (amended D8). */
export const READ_AHEAD = 3;

/** Plain words for a story status. */
export function storyStatusText(status: StoryStatus): string {
  switch (status) {
    case "interviewing":
      return "Choosing the story";
    case "brief_pending":
      return "Story brief waiting for you";
    case "generating":
      return "Writing chapters";
    case "paused":
      return "Paused (waiting for the reader)";
    case "complete":
      return "Complete";
    case "cancelled":
      return "Cancelled";
    case "error":
      return "Stopped by an error";
    case "interrupted":
      return "Interrupted (the server restarted)";
  }
}

export type StoryPhase = "interview" | "brief" | "reader";

/**
 * Which part of the session page to show: the reader once a chapter exists or
 * the job ran (generating, paused, complete, interrupted, or an error after an
 * accepted brief), the brief card while a brief waits for a decision, else the
 * step-0 run card and interview (also after Cancel, so the user can start over).
 */
export function storyPhase(session: Pick<StorySession, "status" | "brief" | "chapters_done">): StoryPhase {
  if (session.chapters_done > 0) return "reader";
  if (["generating", "paused", "complete", "interrupted"].includes(session.status)) return "reader";
  const briefStatus = session.brief?.status ?? null;
  if (session.status === "error" && (briefStatus === "executing" || briefStatus === "executed")) return "reader";
  if (session.status === "brief_pending" && briefStatus === "pending") return "brief";
  return "interview";
}

/** Poll GET story every 2.5 s while the job runs or waits, chapters are being written, or an interview message is in flight; else null. */
export function storyPollDelay(session: Pick<StorySession, "status" | "messages"> | null | undefined, job: Pick<JobView, "status"> | null | undefined, intervalMs = STORYBOOK_POLL_MS): number | null {
  if (!session) return null;
  if (job && (job.status === "queued" || job.status === "running")) return intervalMs;
  if (session.status === "generating") return intervalMs;
  if (session.messages.some((m) => m.status === "pending" || m.status === "running")) return intervalMs;
  return null;
}

/** The chapter to open first: the reader's saved position, at least 1 and at most `total` (1 when nothing is known). */
export function initialChapter(session: Pick<StorySession, "reader_position">, total: number): number {
  const upper = Math.max(1, total);
  return Math.min(upper, Math.max(1, session.reader_position));
}

/** Chapters the reader can list: the session's total, else the brief's plan length, else the chapters written so far. */
export function chapterTotal(session: Pick<StorySession, "chapters_total" | "brief">, chapters: { number: number }[]): number {
  if (session.chapters_total > 0) return session.chapters_total;
  if (session.brief && session.brief.chapter_plan.length > 0) return session.brief.chapter_plan.length;
  return chapters.reduce((max, c) => Math.max(max, c.number), 0);
}

/** Chapter numbers the job writes for a reader at `position` (1-based, clamped to `total`); empty when nothing to write. */
export function readerWindow(position: number, total: number, ahead = READ_AHEAD): number[] {
  const first = Math.max(1, position);
  const last = Math.min(total, Math.max(first, position) + ahead);
  const out: number[] = [];
  for (let n = first; n <= last; n += 1) out.push(n);
  return out;
}

export type ChapterAvailability = "ready" | "writing" | "queued" | "error" | "not_started";

/**
 * Whether chapter `number` can be shown: ready when done, writing when it is
 * the next one and the job runs, queued when the job will reach it (inside the
 * lazy window or generate all), error when the job stopped with an error,
 * not_started otherwise (the reader has to move closer or press Generate all).
 */
export function chapterAvailability(number: number, chapters: Pick<StoryChapter, "number" | "status">[], session: Pick<StorySession, "chapters_done" | "reader_position" | "generate_all" | "status">, job: Pick<JobView, "status"> | null): ChapterAvailability {
  const found = chapters.find((c) => c.number === number);
  if (found && found.status === "done") return "ready";
  if (found && found.status === "error") return "error";
  const jobActive = job !== null && (job.status === "running" || job.status === "queued");
  const next = session.chapters_done + 1;
  if (jobActive && number === next && job?.status === "running") return "writing";
  const reachable = session.generate_all || number <= Math.max(session.reader_position, 1) + READ_AHEAD;
  if ((jobActive || session.status === "generating") && reachable) return "queued";
  if (session.status === "error") return "error";
  return "not_started";
}

/** "Queued behind "The Arena" (ch 40/285)" / "Queue position 2" / the job's progress line. */
export function jobQueueText(job: Pick<JobView, "status" | "queue_position" | "queued_behind" | "progress" | "cancel_requested"> | null): string {
  if (!job) return "";
  if (job.cancel_requested && (job.status === "running" || job.status === "queued")) return "Stopping after the current chapter…";
  if (job.status === "queued") return job.queued_behind || (job.queue_position > 0 ? `Queue position ${job.queue_position}` : "Queued");
  if (job.status === "running") return job.progress || "Writing…";
  return "";
}

/** Chapters, cost and time left to write every remaining chapter, priced per chapter from the brief's estimate for `unit`. */
export function remainingEstimate(brief: Pick<StoryBrief, "estimate_turn" | "estimate_round"> | null, session: Pick<StorySession, "unit" | "chapters_total" | "chapters_done">): ChapterEstimate | null {
  const estimate = session.unit === "round" ? brief?.estimate_round : brief?.estimate_turn;
  const left = Math.max(0, session.chapters_total - session.chapters_done);
  if (!estimate || estimate.chapters <= 0) return null;
  const perCost = estimate.cost_usd / estimate.chapters;
  const perSeconds = estimate.seconds / estimate.chapters;
  return { unit: session.unit, chapters: left, summaries: 0, costUsd: Math.round(left * perCost * 10000) / 10000, seconds: Math.round(left * perSeconds) };
}

/** "Generate all (est. $0.52, ~5 min)". */
export function generateAllLabel(estimate: ChapterEstimate | null): string {
  if (!estimate) return "Generate all";
  const cost = formatUsd(estimate.costUsd).replace("≈", "");
  return `Generate all (est. ${cost}, ${formatDuration(estimate.seconds)})`;
}

/** A story pinned to an end turn can continue when the run has committed turns after it. */
export function canContinueStory(session: Pick<StorySession, "end_turn_id" | "status">, lastTurnId: string | null | undefined): boolean {
  if (!session.end_turn_id || !lastTurnId || lastTurnId === session.end_turn_id) return false;
  if (!["complete", "paused", "cancelled", "interrupted"].includes(session.status)) return false;
  return compareTurnIds(lastTurnId, session.end_turn_id) > 0;
}

/** Sort key of a turn id in commit order (round, then init < agent turns by index < round end). */
export function turnOrderKey(turnId: string): [number, number] {
  try {
    const parsed = parseTurnId(turnId);
    if (Number.isNaN(parsed.round)) return [Number.NaN, 0];
    if (parsed.kind === "init") return [parsed.round, -1];
    if (parsed.kind === "round_end") return [parsed.round, Number.MAX_SAFE_INTEGER];
    return [parsed.round, parsed.turn ?? 0];
  } catch {
    return [Number.NaN, 0];
  }
}

/** Negative / 0 / positive like a comparator, in commit order ("r00003_end" comes after "r00003_t08_a02"). */
export function compareTurnIds(a: string, b: string): number {
  const [ra, ta] = turnOrderKey(a);
  const [rb, tb] = turnOrderKey(b);
  if (Number.isNaN(ra) || Number.isNaN(rb)) return a < b ? -1 : a > b ? 1 : 0;
  return ra !== rb ? ra - rb : ta - tb;
}

/** "chapter-title.md" for the Markdown download. */
export function exportFileName(title: string, fallback = "story"): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || fallback}.md`;
}

/** Heading of a chapter in the reader's list ("3. The long night", "Interlude · round 2"). */
export function chapterHeading(chapter: Pick<StoryChapter, "number" | "kind" | "title" | "turn_ids">): string {
  const title = chapter.title.trim();
  if (chapter.kind === "interlude") return `${chapter.number}. Interlude${title ? ` · ${title}` : ""}`;
  if (chapter.kind === "opening") return `${chapter.number}. ${title || "Opening"}`;
  if (chapter.kind === "epilogue") return `${chapter.number}. ${title || "Epilogue"}`;
  return `${chapter.number}. ${title || "Untitled chapter"}`;
}

/** Paragraphs of a text-mode chapter or entry (blank-line separated; a leading "# title" line is dropped). */
export function paragraphs(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && /^#\s/.test(lines[0])) lines.shift();
  return lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- storybook tab

/** Poll GET storybook every 2.5 s while entries are pending or being written. */
export const STORYBOOK_POLL_MS = 2500;

/** Delay until the next storybook poll, or null to refresh only when the turn changes. */
export function storybookPollDelay(status: Pick<StorybookStatus, "pending_count" | "in_flight"> | null | undefined, intervalMs = STORYBOOK_POLL_MS): number | null {
  if (!status) return null;
  return status.pending_count > 0 || status.in_flight ? intervalMs : null;
}

/** "Auto on" | "Auto off" | "Auto paused: budget reached" | "Auto paused: error". */
export function storybookAutoText(status: Pick<StorybookStatus, "auto" | "auto_state">): string {
  switch (status.auto_state) {
    case "paused_budget":
      return "Auto paused: budget reached";
    case "paused_error":
      return "Auto paused: error";
    case "on":
      return "Auto on";
    case "off":
      return "Auto off";
  }
  return status.auto ? "Auto on" : "Auto off";
}

/** Why auto narration is paused (null when it is not). */
export function storybookPausedReason(status: Pick<StorybookStatus, "auto_state" | "notice" | "last_error" | "spend">): string | null {
  if (status.auto_state === "paused_budget") {
    return status.notice || `Automatic narration paused: this run's storybook spend reached its ${formatSpent(status.spend.limit_usd)} budget.`;
  }
  if (status.auto_state === "paused_error") return status.notice || `Automatic narration paused after an error${status.last_error ? `: ${status.last_error}` : "."}`;
  return status.notice || null;
}

/** "Write missing (12 entries, ≈$0.05, ~2 min)". */
export function writeMissingLabel(status: Pick<StorybookStatus, "missing_count" | "estimate">): string {
  const n = status.missing_count;
  const noun = n === 1 ? "entry" : "entries";
  return `Write missing (${n} ${noun}, ${formatUsd(status.estimate.cost_usd)}, ${formatDuration(status.estimate.seconds)})`;
}

/** The status line pieces after the auto toggle: pending, spend, missing. */
export function storybookStatusParts(status: Pick<StorybookStatus, "pending_count" | "in_flight" | "missing_count" | "spend" | "entry_count">): string[] {
  const parts: string[] = [];
  if (status.pending_count > 0) parts.push(`${status.pending_count} pending`);
  else if (status.in_flight) parts.push("writing…");
  parts.push(`${status.entry_count} ${status.entry_count === 1 ? "entry" : "entries"}`);
  parts.push(`spent ${formatSpent(status.spend.spent_usd)} of ${formatSpent(status.spend.limit_usd)}`);
  if (status.missing_count > 0) parts.push(`${status.missing_count} missing`);
  return parts;
}

/** A higher storybook budget to offer when auto paused on the budget (double, at least +$1). */
export function raisedBudget(limitUsd: number): number {
  const next = Math.max(limitUsd * 2, limitUsd + 1);
  return Math.ceil(next);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a storybook entry involves `entityId` (its entities list, else a whole-word mention in the text). */
export function entryInvolves(entry: Pick<StorybookEntry, "entities" | "text" | "turn_id">, entityId: string): boolean {
  if (!entityId) return true;
  if (entry.entities && entry.entities.length > 0) return entry.entities.includes(entityId);
  if (entry.turn_id !== "opening") {
    try {
      if (parseTurnId(entry.turn_id).agentId === entityId) return true;
    } catch {
      // not a turn id
    }
  }
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(entityId)}([^A-Za-z0-9_]|$)`).test(entry.text);
}

/** Entries involving `entityId` (all entries when it is null). */
export function filterStorybookEntries<E extends Pick<StorybookEntry, "entities" | "text" | "turn_id">>(entries: E[], entityId: string | null): E[] {
  if (!entityId) return entries;
  return entries.filter((e) => entryInvolves(e, entityId));
}

/** Heading of a storybook entry: "Opening", "Round 3 · turn 2 · <agent>", "End of round 3". */
export function entryHeading(entry: Pick<StorybookEntry, "turn_id" | "kind" | "round">, name?: (id: string) => string): string {
  if (entry.kind === "opening" || entry.turn_id === "opening") return "Opening";
  if (entry.kind === "round_end") return `End of round ${entry.round}`;
  try {
    const parsed = parseTurnId(entry.turn_id);
    if (parsed.kind === "agent_turn" && parsed.agentId) return `Round ${parsed.round} · turn ${parsed.turn} · ${name ? name(parsed.agentId) : parsed.agentId}`;
    if (parsed.kind === "round_end") return `End of round ${parsed.round}`;
  } catch {
    // fall through
  }
  return entry.turn_id;
}

/** True when a scroll box is at (or within `slack` px of) its bottom: only then does the list follow new entries. */
export function isNearBottom(metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 24): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= slack;
}
