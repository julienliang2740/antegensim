/**
 * Story Mode page (amended D8; OWNER: WP6).
 *
 * Routes (hooks/useHashRoute.ts): "#/story" chooses a run (RunPicker: GET
 * /api/runs, nothing opened), "#/story/<run>" lists the run's stories with
 * "New story" (StoryList), "#/story/<run>/<story>" is one session: the
 * deterministic step-0 run card with chips and the "Story author" composer
 * (RunCard), the author's brief with both estimates and Accept / Change /
 * Cancel (BriefCard), then the reader with lazy chapters, Generate all, Cancel,
 * Continue story and Export Markdown (Reader).  The page never opens the run:
 * the history routes and the story API work on closed runs.  It polls GET
 * story every 2.5 s while a job or an author reply is in flight, publishes
 * { page: "story", runId, storyId } to state/assistantContext.ts, and marks a
 * chapter read when it is opened (GET chapters/{n}?mark_read=true), which is
 * what lets the job write the next three.
 *
 * DOCS: Story Mode control labels live here and in components/story/*: "Story",
 * "New story", "Write the story brief", "Dictate", "Accept: write N chapters…",
 * "Change", "Cancel", "Generate all (est. $X, ~Y min)", "Continue story",
 * "Export Markdown", "Open this turn in the run".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRun, listTurns } from "../api/client";
import { ApiClientError } from "../api/client";
import { approveStory, cancelStory, continueStory, exportStory, generateAllChapters, getStory, getStoryChapter, rejectStory, sendStoryMessage } from "../api/story";
import type { ChapterUnit, StoryView } from "../api/storyTypes";
import { PageHeader } from "../components/common/PageHeader";
import { ErrorLine } from "../components/common/Problems";
import { BriefCard } from "../components/story/BriefCard";
import { Interview } from "../components/story/Interview";
import { Reader } from "../components/story/Reader";
import { RunCard } from "../components/story/RunCard";
import { RunPicker } from "../components/story/RunPicker";
import { StatusBadge } from "../components/story/StatusBadge";
import { StoryList } from "../components/story/StoryList";
import { useFetched } from "../hooks/useFetched";
import { navigate, type StoryRoute } from "../hooks/useHashRoute";
import { clearContext, publishContext } from "../state/assistantContext";
import { errorText } from "../state/runSessions";
import {
  chapterTotal,
  choicesToPicks,
  exportFileName,
  formatSpent,
  initialChapter,
  picksToChoices,
  stepZeroText,
  storyPhase,
  storyPollDelay,
  storyStatusText,
  validateTurnRange,
  type StoryChoices,
} from "../state/storyMode";
import "../story.css";

export function StoryPage(props: { route: StoryRoute }) {
  const { runId, storyId } = props.route;
  if (!runId) return <RunPickerPage />;
  if (!storyId) return <StoryListPage key={runId} runId={runId} />;
  return <StorySessionPage key={`${runId}/${storyId}`} runId={runId} storyId={storyId} />;
}

// ---------------------------------------------------------------- #/story

function RunPickerPage() {
  useEffect(() => {
    document.title = "Story Mode · Empyrean";
    publishContext({ page: "story" });
    return () => clearContext();
  }, []);
  return (
    <div className="page storymode-page">
      <PageHeader title="Story Mode" subtitle="Turn a finished or running world into a story. Choose a run; reading and writing stories never opens it." />
      <RunPicker />
    </div>
  );
}

// ---------------------------------------------------------------- #/story/<run>

function StoryListPage(props: { runId: string }) {
  const [runName, setRunName] = useState<string | null>(null);
  useEffect(() => {
    document.title = `Stories of ${runName ?? props.runId} · Empyrean`;
    publishContext({ page: "story", runId: props.runId, runName });
    return () => clearContext();
  }, [props.runId, runName]);
  return (
    <div className="page storymode-page">
      <PageHeader title={runName ? `Stories of ${runName}` : "Stories"} subtitle={<span>Run <code>{props.runId}</code>. Each story is its own session: choices, the author's brief, then chapters written as you read.</span>} />
      <StoryList runId={props.runId} onRunName={setRunName} />
    </div>
  );
}

// ---------------------------------------------------------------- #/story/<run>/<story>

type Action = "message" | "accept" | "reject" | "cancel" | "all" | "continue" | "export";

function StorySessionPage(props: { runId: string; storyId: string }) {
  const { runId, storyId } = props;
  const [view, setView] = useState<StoryView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [tick, setTick] = useState(0);
  /** Chips the user changed (null until then: the saved picks or the run card's suggestion apply). */
  const [chosen, setChosen] = useState<StoryChoices | null>(null);
  const [text, setText] = useState("");
  const [changing, setChanging] = useState(false);
  /** The chapter the reader opened (null until then: the session's saved reader position applies). */
  const [opened, setOpened] = useState<number | null>(null);
  const markedRef = useRef<string | null>(null);

  const run = useFetched(`run:${runId}`, () => getRun(runId));
  const turns = useFetched(`turns:${runId}`, async () => (await listTurns(runId)).map((t) => t.turn_id));
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // ------------------------------------------------------------------ load + poll
  useEffect(() => {
    const controller = new AbortController();
    getStory(runId, storyId, controller.signal)
      .then((data) => {
        setView(data);
        setLoadError(null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setLoadError(errorText(e));
      });
    return () => controller.abort();
  }, [runId, storyId, tick]);

  const pollDelay = storyPollDelay(view?.session, view?.job);
  useEffect(() => {
    if (pollDelay === null) return;
    const timer = setTimeout(refresh, pollDelay);
    return () => clearTimeout(timer);
  }, [pollDelay, view, refresh]);

  // The run list refreshes with the story while a run is live ("Continue story" needs its latest turn).
  useEffect(() => {
    if (pollDelay === null || !run.data || run.data.status === "finished") return;
    const timer = setTimeout(run.reload, 10_000);
    return () => clearTimeout(timer);
  }, [pollDelay, run.data, run.reload, view]);

  const session = view?.session ?? null;
  const phase = session ? storyPhase(session) : null;
  const total = view ? chapterTotal(view.session, view.chapters) : 0;

  // ------------------------------------------------------------------ chips: the user's, else the saved picks, else the run card's suggestion
  const choices = useMemo<StoryChoices | null>(() => {
    if (chosen) return chosen;
    if (!view) return null;
    const saved = view.session.messages.length > 0 || view.session.brief ? view.session.picks : (view.run_card?.suggested ?? view.session.picks);
    return picksToChoices(saved);
  }, [chosen, view]);

  // ------------------------------------------------------------------ reader position (the saved one until the reader moves) + mark read (lazy generation)
  const current = opened ?? (phase === "reader" && session ? initialChapter(session, total) : null);

  useEffect(() => {
    if (phase !== "reader" || current === null) return;
    const key = `${storyId}:${current}`;
    if (markedRef.current === key) return;
    markedRef.current = key;
    let cancelled = false;
    getStoryChapter(runId, storyId, current, true)
      .then((chapter) => {
        if (cancelled) return;
        setView((v) => {
          if (!v) return v;
          const others = v.chapters.filter((c) => c.number !== chapter.number);
          const chapters = chapter.status === "done" ? [...others, chapter].sort((a, b) => a.number - b.number) : v.chapters;
          const reader_position = Math.max(v.session.reader_position, current);
          return { ...v, chapters, session: { ...v.session, reader_position } };
        });
        // The reader moved: the job may now write the next chapters, so look again soon.
        refresh();
      })
      .catch((e) => {
        if (cancelled) return;
        // 404: the chapter is not written yet; polling brings it when it lands.
        if (!(e instanceof ApiClientError && e.status === 404)) setActionError(errorText(e));
        refresh();
      });
    return () => {
      cancelled = true;
    };
  }, [phase, current, runId, storyId, refresh]);

  // ------------------------------------------------------------------ context + title
  const title = session?.title.trim() || (phase === "interview" ? "New story" : "Story");
  useEffect(() => {
    document.title = `${title} · Story Mode · Empyrean`;
    publishContext({ page: "story", runId, runName: run.data?.name ?? view?.run_card?.name ?? null, storyId, lastError: actionError ?? loadError ?? session?.error ?? null });
    return () => clearContext();
  }, [title, runId, storyId, run.data, view, actionError, loadError, session]);

  // ------------------------------------------------------------------ actions
  const act = async (action: Action, work: () => Promise<StoryView | null>) => {
    setBusy(action);
    setActionError(null);
    try {
      const next = await work();
      if (next) setView(next);
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const sendMessage = () => {
    if (!choices) return;
    void act("message", async () => {
      const next = await sendStoryMessage(runId, storyId, { text: stepZeroText(text), picks: choicesToPicks(choices) });
      setText("");
      setChanging(false);
      return next;
    });
  };
  const accept = (unit: ChapterUnit, jobBudgetUsd: number) => {
    const brief = session?.brief;
    if (!brief) return;
    void act("accept", async () => {
      const next = await approveStory(runId, storyId, { brief_id: brief.brief_id, unit, generate_all: false, job_budget_usd: jobBudgetUsd });
      setOpened(1);
      return next;
    });
  };
  const reject = () => void act("reject", () => rejectStory(runId, storyId, "Cancelled by the user"));
  const cancel = () => void act("cancel", () => cancelStory(runId, storyId));
  const generateAll = () => void act("all", () => generateAllChapters(runId, storyId));
  const continueLater = () => void act("continue", () => continueStory(runId, storyId, { to_turn_id: null }));
  const download = () =>
    void act("export", async () => {
      const result = await exportStory(runId, storyId);
      const blob = new Blob([result.markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFileName(result.title || title);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return null;
    });

  // ------------------------------------------------------------------ render
  const counts = useMemo(() => {
    if (!choices || !turns.data) return null;
    const check = validateTurnRange(choices.range, turns.data);
    return check.ok ? check.counts : null;
  }, [choices, turns.data]);
  const authorBusy = busy !== null || (session?.messages.some((m) => m.status === "pending" || m.status === "running") ?? false);

  return (
    <div className="page storymode-page">
      <PageHeader
        title={title}
        subtitle={
          <span>
            {run.data?.name ?? view?.run_card?.name ?? "run"} <code>{runId}</code>
            {session ? (
              <>
                {" · "}
                <StatusBadge status={session.status} /> {storyStatusText(session.status)}
                {session.spent_usd > 0 ? ` · spent ${formatSpent(session.spent_usd)}` : ""}
              </>
            ) : null}
          </span>
        }
      />
      <div className="storymode-toolbar">
        <button type="button" className="btn btn-link" onClick={() => navigate({ name: "story", runId, storyId: null })}>
          All stories of this run
        </button>
        <button type="button" className="btn btn-link" onClick={() => navigate({ name: "story", runId: null, storyId: null })}>
          Choose another run
        </button>
        <button type="button" className="btn btn-link" onClick={() => navigate({ name: "run", runId, turnId: null })}>
          Open the run
        </button>
        <span>AI-written story; the run's Turn record has the facts.</span>
      </div>
      <ErrorLine text={loadError} prefix="Could not read the story:" />
      <ErrorLine text={actionError} />
      {!view && !loadError ? <p className="hint">Reading the story…</p> : null}

      {view && session && phase === "reader" && current !== null ? (
        <>
          <Reader runId={runId} view={view} current={current} onSelect={(n) => setOpened(Math.max(1, total > 0 ? Math.min(total, n) : n))} runLastTurnId={run.data?.current_turn_id ?? null} busy={busy !== null} onGenerateAll={generateAll} onCancel={cancel} onContinue={continueLater} onExport={download} />
          {session.brief || session.messages.length ? (
            <details className="storymode-card">
              <summary>Story brief and interview</summary>
              {session.brief ? (
                <>
                  <h3>{session.brief.title}</h3>
                  <p className="storymode-brief-premise">{session.brief.premise}</p>
                  <p className="hint">{session.brief.style_guide}</p>
                </>
              ) : null}
              <Interview messages={session.messages} />
            </details>
          ) : null}
        </>
      ) : null}

      {view && session && phase === "brief" && session.brief ? (
        <>
          <BriefCard key={session.brief.brief_id} brief={session.brief} session={session} counts={counts} busy={busy !== null} changing={changing} onAccept={accept} onChange={() => setChanging(true)} onCancel={reject} />
          {changing && choices && view.run_card ? (
            <RunCard
              runId={runId}
              card={view.run_card}
              turnIds={turns.data}
              choices={choices}
              onChoices={setChosen}
              text={text}
              onText={setText}
              onSubmit={sendMessage}
              busy={authorBusy}
              heading="Ask for changes"
              submitLabel="Send the changes"
              note="The author writes a new brief from your changed chips and this note; the current brief is superseded."
              onCancel={() => setChanging(false)}
            />
          ) : null}
          {changing && !view.run_card ? <p className="hint">The run card is not available for this story; cancel the brief and start a new story to change the choices.</p> : null}
          <Interview messages={session.messages} />
        </>
      ) : null}

      {view && session && phase === "interview" ? (
        <>
          {session.status === "cancelled" ? <p className="hint">The brief was cancelled; nothing was generated. Change the choices and ask again, or start another story.</p> : null}
          {session.status === "error" && session.error ? <ErrorLine text={session.error} prefix="The author stopped:" /> : null}
          {view.run_card && choices ? (
            <RunCard runId={runId} card={view.run_card} turnIds={turns.data} choices={choices} onChoices={setChosen} text={text} onText={setText} onSubmit={sendMessage} busy={authorBusy} heading={view.run_card.name} submitLabel="Write the story brief" />
          ) : (
            <p className="hint">No run card came with this story.</p>
          )}
          <ErrorLine text={turns.error} prefix="Could not list the run's turns (the turn range stays at the whole run):" />
          <Interview messages={session.messages} />
        </>
      ) : null}
    </div>
  );
}
