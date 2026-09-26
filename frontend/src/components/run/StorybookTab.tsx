/**
 * Storybook tab of the run page (amended D7 UI; OWNER WP6, mounted by RunPage
 * as the fifth tab "storybook").
 *
 * DOCS: shows the run's AI-written narrative from
 * GET /api/runs/{run_id}/assistant/storybook: the opening entry in the header,
 * a status line (Auto on/off toggle via PUT .../assistant/settings, pending
 * count, spend against the per-run storybook budget, missing count with the
 * "Write missing (N entries, ≈$X, ~Y min)" button, the paused reason with
 * "Raise budget"), then one entry per committed turn (and round end) in commit
 * order.  The entry of the viewed turn is highlighted; clicking an entry views
 * that turn.  While a map selection is active, only entries involving that
 * entity are listed ("Following <name> · clear", with "Inspect").  The list
 * follows new entries only while scrolled to the bottom; "Jump to viewed
 * turn" scrolls to the highlighted entry.  Polls every 2.5 s while entries are
 * pending, otherwise refreshes only when the live or viewed turn changes.  The
 * GET is read-only: nothing is generated (and nothing spent) unless auto is on
 * or the user presses "Write missing" / "Regenerate".  The Turn record stays
 * the factual account.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiClientError } from "../../api/client";
import { generateStorybook, getStorybook, regenerateStorybookEntry, updateRunAssistantSettings } from "../../api/story";
import type { StorybookEntry, StorybookView } from "../../api/storyTypes";
import { errorText } from "../../state/runSessions";
import {
  compareTurnIds,
  entryHeading,
  filterStorybookEntries,
  formatSpent,
  isNearBottom,
  modelTier,
  paragraphs,
  raisedBudget,
  storybookAutoText,
  storybookPausedReason,
  storybookPollDelay,
  storybookStatusParts,
  writeMissingLabel,
} from "../../state/storyMode";
import "../../storybook.css";

export interface StorybookTabProps {
  runId: string;
  /** The history turn on screen (null while live: the live turn's entry is highlighted instead). */
  viewedTurnId: string | null;
  /** status.current_turn_id: a change refreshes the list when nothing is pending (optional). */
  liveTurnId?: string | null;
  /** The map / inspector selection: filters the entries to that entity ("Following <name>"). */
  selectedEntityId: string | null;
  /** RunPage's display-name helper ("a05 Eos"); ids are shown as they are without it. */
  name?: (id: string | null | undefined) => string;
  /** View a recorded turn (RunPage's setViewTurnId). */
  onViewTurn(turnId: string): void;
  /** Show an entity in the Inspector. */
  onInspect(entityId: string): void;
  /** Open Story Mode for this run (#/story/<run>). */
  onOpenStory(): void;
}

type Action = "auto" | "missing" | "budget" | `regen:${string}`;

export function StorybookTab(props: StorybookTabProps) {
  const { runId, selectedEntityId, onViewTurn, onInspect, onOpenStory } = props;
  /** The turn whose entry is highlighted: the history turn, else (live view) the latest committed turn. */
  const viewedTurnId = props.viewedTurnId ?? props.liveTurnId ?? null;
  const refreshKey = props.liveTurnId ?? viewedTurnId ?? "";
  const [view, setView] = useState<StorybookView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [tick, setTick] = useState(0);
  const [clearedFor, setClearedFor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const lastCountRef = useRef(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // ------------------------------------------------------------------ load + poll
  useEffect(() => {
    const controller = new AbortController();
    getStorybook(runId, undefined, controller.signal)
      .then((data) => {
        setView(data);
        setLoadError(null);
        setUnavailable(null);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiClientError && e.code === "assistant_unavailable") setUnavailable(e.body?.detail || "The assistant is not available on this server.");
        else setLoadError(errorText(e));
      });
    return () => controller.abort();
  }, [runId, refreshKey, tick]);

  const pollDelay = unavailable ? null : storybookPollDelay(view?.status);
  useEffect(() => {
    if (pollDelay === null) return;
    const timer = setTimeout(refresh, pollDelay);
    return () => clearTimeout(timer);
  }, [pollDelay, view, refresh]);

  // ------------------------------------------------------------------ filter
  const followId = selectedEntityId && clearedFor !== selectedEntityId ? selectedEntityId : null;
  const displayName = useCallback((id: string) => (props.name ? props.name(id) : id), [props]);
  const allEntries = useMemo(() => view?.entries ?? [], [view]);
  const entries = useMemo(() => filterStorybookEntries(allEntries, followId), [allEntries, followId]);

  // ------------------------------------------------------------------ scrolling
  const onScroll = () => {
    const el = listRef.current;
    if (el) atBottomRef.current = isNearBottom(el);
  };
  useLayoutEffect(() => {
    const el = listRef.current;
    const grew = entries.length > lastCountRef.current;
    lastCountRef.current = entries.length;
    if (el && grew && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  const viewedEntryId = useMemo(() => {
    if (!viewedTurnId || entries.length === 0) return null;
    if (entries.some((e) => e.turn_id === viewedTurnId)) return viewedTurnId;
    // the nearest entry at or before the viewed turn
    let best: string | null = null;
    for (const e of entries) if (compareTurnIds(e.turn_id, viewedTurnId) <= 0) best = e.turn_id;
    return best;
  }, [entries, viewedTurnId]);

  const jumpToViewed = () => {
    const el = listRef.current;
    if (!el || !viewedEntryId) return;
    const target = el.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(viewedEntryId)}"]`);
    if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  // ------------------------------------------------------------------ actions
  const act = async (action: Action, run: () => Promise<unknown>) => {
    setBusy(action);
    setActionError(null);
    try {
      await run();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const status = view?.status ?? null;
  const toggleAuto = () => {
    if (!status) return;
    void act("auto", () => updateRunAssistantSettings(runId, { storybook_auto: !status.auto }));
  };
  const writeMissing = () =>
    void act("missing", async () => {
      const response = await generateStorybook(runId, {});
      setView((v) => (v ? { ...v, status: response.status } : v));
    });
  const raiseBudget = () => {
    if (!status) return;
    void act("budget", () => updateRunAssistantSettings(runId, { storybook_budget_usd: raisedBudget(status.spend.limit_usd) }));
  };
  const regenerate = (turnId: string) => void act(`regen:${turnId}`, () => regenerateStorybookEntry(runId, turnId));

  // ------------------------------------------------------------------ render
  if (unavailable) {
    return (
      <div className="storybook">
        <p className="storybook-label">AI-written narrative; the Turn record has the facts</p>
        <p className="hint">Storybook unavailable: {unavailable}</p>
      </div>
    );
  }

  const paused = status ? storybookPausedReason(status) : null;
  const opening = view?.opening ?? null;

  return (
    <div className="storybook">
      <header className="storybook-header">
        <div className="storybook-titlebar">
          <p className="storybook-label" title="Written by the assistant's narrator model from the recorded turns. Thoughts are beliefs, not facts; check the Turn record.">
            AI-written narrative; the Turn record has the facts
          </p>
          <button type="button" className="btn btn-link storybook-story-link" onClick={onOpenStory}>
            Make a story of this run
          </button>
        </div>

        {status ? (
          <div className="storybook-status" aria-live="polite">
            <button
              type="button"
              className={`btn btn-small storybook-auto${status.auto ? " is-on" : ""}`}
              aria-pressed={status.auto}
              disabled={busy !== null}
              onClick={toggleAuto}
              title={
                status.auto
                  ? "Stop narrating new turns automatically"
                  : `Narrate turns committed from now on automatically (${modelTier(status.estimate.model_key) || "narrator model"}; costs money with a live model)`
              }
            >
              {storybookAutoText(status)}
            </button>
            <span className="storybook-status-parts">{storybookStatusParts(status).join(" · ")}</span>
            {status.missing_count > 0 ? (
              <button
                type="button"
                className="btn btn-small"
                disabled={busy !== null || status.in_flight}
                onClick={writeMissing}
                title={`Narrate the ${status.missing_count} committed turns without an entry with ${modelTier(status.estimate.model_key) || "the narrator model"} (${status.estimate.calls} calls).  Automatic narration never writes history on its own.`}
              >
                {busy === "missing" ? "Queuing…" : writeMissingLabel(status)}
              </button>
            ) : null}
          </div>
        ) : null}

        {paused ? (
          <div className="storybook-paused" role="status">
            <span>{paused}</span>
            {status?.auto_state === "paused_budget" ? (
              <button type="button" className="btn btn-small" disabled={busy !== null} onClick={raiseBudget}>
                Raise budget to {formatSpent(raisedBudget(status.spend.limit_usd))}
              </button>
            ) : null}
          </div>
        ) : null}

        {actionError ? (
          <div className="error-line" role="alert">
            {actionError}
          </div>
        ) : null}
        {loadError ? (
          <div className="error-line" role="alert">
            Could not read the storybook: {loadError}
          </div>
        ) : null}

        {opening ? (
          <details className="storybook-opening" open={allEntries.length < 3}>
            <summary>Opening</summary>
            <EntryText text={opening.text} />
            <EntryMeta entry={opening} busy={busy} onRegenerate={regenerate} />
          </details>
        ) : null}

        {followId ? (
          <div className="storybook-follow" role="status">
            <span>
              Following <strong>{displayName(followId)}</strong> · {entries.length} of {allEntries.length} entries
            </span>
            <button type="button" className="btn btn-link" onClick={() => onInspect(followId)}>
              Inspect
            </button>
            <button type="button" className="btn btn-link" onClick={() => setClearedFor(followId)} aria-label={`Clear the filter on ${displayName(followId)}`}>
              clear
            </button>
          </div>
        ) : null}

        <div className="storybook-tools">
          <button type="button" className="btn btn-small" disabled={!viewedEntryId} onClick={jumpToViewed} title="Scroll to the entry of the turn shown on the map">
            Jump to viewed turn
          </button>
        </div>
      </header>

      <div className="storybook-list" ref={listRef} onScroll={onScroll} aria-label="Storybook entries">
        {!view && !loadError ? <p className="hint">Reading the storybook…</p> : null}
        {view && allEntries.length === 0 ? (
          <p className="hint">
            {status?.auto
              ? "No entries yet. New turns are narrated as they are committed."
              : "No entries yet. Switch Auto on to narrate new turns as they are committed, or write the missing ones."}
          </p>
        ) : null}
        {view && allEntries.length > 0 && entries.length === 0 ? <p className="hint">No entry mentions {followId ? displayName(followId) : "this entity"} yet.</p> : null}
        {entries.map((entry) => (
          <EntryCard
            key={entry.turn_id}
            entry={entry}
            viewed={entry.turn_id === viewedEntryId}
            heading={entryHeading(entry, displayName)}
            busy={busy}
            onView={() => onViewTurn(entry.turn_id)}
            onRegenerate={regenerate}
          />
        ))}
      </div>
    </div>
  );
}

function EntryText(props: { text: string }) {
  const parts = paragraphs(props.text);
  return (
    <div className="storybook-text">
      {parts.length ? parts.map((p, i) => <p key={i}>{p}</p>) : <p className="hint">(empty entry)</p>}
    </div>
  );
}

function EntryMeta(props: { entry: StorybookEntry; busy: Action | null; onRegenerate(turnId: string): void }) {
  const { entry } = props;
  const regenerating = props.busy === `regen:${entry.turn_id}`;
  return (
    <div className="storybook-meta">
      <span>
        {modelTier(entry.model_key) || entry.model_key}
        {entry.cost_usd > 0 ? ` · ${formatSpent(entry.cost_usd)}` : ""}
        {entry.regenerated ? ` · rewritten ×${entry.regenerated}` : ""}
      </span>
      <button
        type="button"
        className="btn btn-link storybook-regen"
        disabled={props.busy !== null}
        onClick={(e) => {
          e.stopPropagation();
          props.onRegenerate(entry.turn_id);
        }}
        title="Write this entry again (one narrator call)"
      >
        {regenerating ? "Queuing…" : "Regenerate"}
      </button>
    </div>
  );
}

function EntryCard(props: { entry: StorybookEntry; viewed: boolean; heading: string; busy: Action | null; onView(): void; onRegenerate(turnId: string): void }) {
  const { entry, viewed } = props;
  const className = ["storybook-entry", entry.kind === "round_end" ? "storybook-entry-round" : "", viewed ? "is-viewed" : ""].filter(Boolean).join(" ");
  return (
    <article className={className} data-turn-id={entry.turn_id} aria-current={viewed ? "true" : undefined} onClick={props.onView}>
      <h4 className="storybook-entry-heading">
        <button
          type="button"
          className="btn btn-link"
          onClick={(e) => {
            e.stopPropagation();
            props.onView();
          }}
          title={`View turn ${entry.turn_id} on the map and in the Turn record`}
        >
          {props.heading}
        </button>
        {viewed ? <span className="storybook-viewed-badge">viewed</span> : null}
      </h4>
      <EntryText text={entry.text} />
      <EntryMeta entry={entry} busy={props.busy} onRegenerate={props.onRegenerate} />
    </article>
  );
}
