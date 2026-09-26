/**
 * The assistant's view of the page: a pure external store (no React import,
 * unit-tested in state.test.mjs).
 *
 * DOCS: pages publish what the user is looking at (publishContext) and the run
 * page registers its action handlers keyed by run id (registerHandlers); the
 * drawer reads both with useSyncExternalStore(subscribe, getSnapshot) and
 * getHandlers(runId).  Nothing here calls the API.
 *
 * Why an external store and not React context: the drawer is a sibling of the
 * keyed RunPage (App.tsx), and a provider would re-render the heavy RunPage
 * tree on every map click and poll.  Keying handlers by run id means a stale
 * handler can never act on another run: the drawer asks for the handlers of
 * the run a brief or a ref names, and gets null when that run is not on screen.
 *
 * Snapshot identity is stable: publishContext only replaces the snapshot (and
 * notifies) when a field actually changed, so publishing from a RunPage effect
 * on every render is cheap and useSyncExternalStore never loops.
 */

import type { EntityKind, Point, RunState, RunStatus } from "../api/types";
import type { RecordTarget } from "./records";

/** Which page the user is on (mirrors the Route names of hooks/useHashRoute.ts). */
export type AssistantPage = "entry" | "new" | "resume" | "run" | "instructions" | "story";

/** Run page side tabs.  "storybook" is the fifth tab (WP5/WP6). */
export type RunTabId = "inspect" | "turn" | "god" | "rules" | "storybook";

/** What the user is looking at; every field but `page` is null when it does not apply. */
export interface AssistantContext {
  page: AssistantPage;
  runId: string | null;
  runName: string | null;
  /** status.current_turn_id: the latest committed turn. */
  liveTurnId: string | null;
  /** viewed.turn.turn_id: the turn actually displayed (differs from liveTurnId in history view). */
  shownTurnId: string | null;
  tab: RunTabId | null;
  selectedPoint: Point | null;
  selectedEntityId: string | null;
  selectedEntityKind: EntityKind | null;
  runState: RunState | null;
  /** The run's or the page's last error line, as shown to the user. */
  lastError: string | null;
  /** Story Mode: the open story. */
  storyId: string | null;
}

/** What publishContext accepts: `page` plus any fields that apply (the rest become null). */
export type AssistantContextInput = { page: AssistantPage } & Partial<Omit<AssistantContext, "page">>;

/**
 * Actions the run page performs for the drawer (links in answers, approved
 * run commands).  RunPage registers one bundle per run id and unregisters it
 * on unmount.  selectEntity/findPoint return null on success or a sentence
 * explaining why nothing was selected (RunPage's findEntityById/findPoint).
 */
export interface RunHandlers {
  selectEntity(entityId: string): string | null;
  findPoint(point: Point): string | null;
  /** Show a recorded turn (null = back to live). */
  viewTurn(turnId: string | null): void;
  setTab(tab: RunTabId): void;
  openRecord(target: RecordTarget): void;
  /** Mirror of RunPage's inFlight guard while the drawer executes an approved run command. */
  setInFlight(inFlight: boolean): void;
  /** Apply the RunStatus an approve endpoint returned (feed.applyStatus), so controls update without waiting for a poll. */
  applyStatus(status: RunStatus): void;
  /** Show (or clear, with null) the run page's command error line. */
  showError(message: string | null): void;
}

const EMPTY: AssistantContext = {
  page: "entry",
  runId: null,
  runName: null,
  liveTurnId: null,
  shownTurnId: null,
  tab: null,
  selectedPoint: null,
  selectedEntityId: null,
  selectedEntityKind: null,
  runState: null,
  lastError: null,
  storyId: null,
};

const KEYS = Object.keys(EMPTY) as (keyof AssistantContext)[];

let snapshot: AssistantContext = EMPTY;
const listeners = new Set<() => void>();
const handlers = new Map<string, RunHandlers>();

function samePoint(a: Point | null, b: Point | null): boolean {
  if (a === b) return true;
  return a !== null && b !== null && a.x === b.x && a.y === b.y;
}

function sameContext(a: AssistantContext, b: AssistantContext): boolean {
  return KEYS.every((key) => (key === "selectedPoint" ? samePoint(a.selectedPoint, b.selectedPoint) : a[key] === b[key]));
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** The current context (stable identity between changes; useSyncExternalStore's getSnapshot). */
export function getSnapshot(): AssistantContext {
  return snapshot;
}

/** Listen for context changes; returns the unsubscribe function (useSyncExternalStore's subscribe). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Replace the context with `input` (missing fields become null); notifies only when something changed. */
export function publishContext(input: AssistantContextInput): void {
  const next: AssistantContext = { ...EMPTY };
  for (const key of KEYS) {
    const value = input[key];
    if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
  }
  if (next.selectedPoint) next.selectedPoint = { x: next.selectedPoint.x, y: next.selectedPoint.y };
  if (sameContext(snapshot, next)) return;
  snapshot = next;
  emit();
}

/**
 * Reset to the empty context, e.g. when a page unmounts.  With `runId`, only
 * when the published context belongs to that run (so a RunPage unmounting
 * after the next run page published does not wipe the newer context).
 */
export function clearContext(runId?: string | null): void {
  if (runId !== undefined && runId !== null && snapshot.runId !== runId) return;
  if (snapshot === EMPTY) return;
  snapshot = EMPTY;
  emit();
}

/** Register the run page's handlers for `runId` (replacing earlier ones); returns an unregister function. */
export function registerHandlers(runId: string, bundle: RunHandlers): () => void {
  handlers.set(runId, bundle);
  return () => unregisterHandlers(runId, bundle);
}

/**
 * Remove the handlers of `runId`.  With `bundle`, only when it is still the
 * registered one (StrictMode double effects and remounts register a newer
 * bundle before the older cleanup runs).
 */
export function unregisterHandlers(runId: string, bundle?: RunHandlers): void {
  if (bundle !== undefined && handlers.get(runId) !== bundle) return;
  handlers.delete(runId);
}

/** The handlers of `runId`, or null when that run is not on screen in this tab. */
export function getHandlers(runId: string | null | undefined): RunHandlers | null {
  if (!runId) return null;
  return handlers.get(runId) ?? null;
}

/** One line for the drawer's context chip, e.g. "Run Arena · turn r00003_t02_a05 (history) · a05 selected". */
export function contextChipText(ctx: AssistantContext): string {
  if (ctx.page === "run" && ctx.runId) {
    const parts = [`Run ${ctx.runName ?? ctx.runId}`];
    if (ctx.shownTurnId) parts.push(`turn ${ctx.shownTurnId}${ctx.liveTurnId && ctx.shownTurnId !== ctx.liveTurnId ? " (history)" : ""}`);
    if (ctx.selectedEntityId) parts.push(`${ctx.selectedEntityId} selected`);
    else if (ctx.selectedPoint) parts.push(`point (${ctx.selectedPoint.x}, ${ctx.selectedPoint.y}) selected`);
    return parts.join(" · ");
  }
  if (ctx.page === "story") {
    if (!ctx.runId) return "Story Mode";
    return `Story Mode · ${ctx.runName ?? ctx.runId}${ctx.storyId ? ` · story ${ctx.storyId}` : ""}`;
  }
  const names: Record<AssistantPage, string> = {
    entry: "Home",
    new: "New session",
    resume: "Resume session",
    run: "Run",
    instructions: "How the world works",
    story: "Story Mode",
  };
  return names[ctx.page];
}

/** Test hook: forget the context, listeners and handlers. */
export function resetAssistantContextForTests(): void {
  snapshot = EMPTY;
  listeners.clear();
  handlers.clear();
}
