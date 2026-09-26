/**
 * The Story Mode reader (amended D8; OWNER: WP6): the chapter list beside the
 * current chapter, prev/next, what the job is doing ("Writing chapter k of N",
 * queue position, "Stopping after the current chapter…"; the current chapter
 * shows the working indicator while it is written or queued, and Cancel lives
 * in the page's working banner), "Generate all (est. $X, ~Y min)",
 * "Continue story" for turns committed after the story's
 * end, Export Markdown, and "Open this turn in the run" links (#/run/<id>?turn=)
 * under each chapter.  Chapters are written lazily 3 ahead of the reader: the
 * page marks a chapter read when it is opened (StoryPage), which is what lets
 * the job move on.
 */

import type { StoryChapter, StoryView } from "../../api/storyTypes";
import { routeHash } from "../../hooks/useHashRoute";
import {
  canContinueStory,
  chapterAvailability,
  chapterHeading,
  chapterTotal,
  formatSpent,
  generateAllLabel,
  jobQueueText,
  modelTier,
  paragraphs,
  remainingEstimate,
  storyStatusText,
  turnLabel,
  type ChapterAvailability,
  type StoryWork,
} from "../../state/storyMode";
import { Working, WorkingSpinner } from "../common/Working";

export interface ReaderProps {
  runId: string;
  view: StoryView;
  /** The chapter number on screen (1-based). */
  current: number;
  onSelect(number: number): void;
  /** The last committed turn of the run (RunSummary.current_turn_id) for "Continue story"; null when unknown. */
  runLastTurnId: string | null;
  busy: boolean;
  /** The story's working state (the page's banner shows it; the current chapter mirrors it). */
  work: StoryWork | null;
  onGenerateAll(): void;
  onContinue(): void;
  onExport(): void;
}

const STATE_WORD: Record<ChapterAvailability, string> = {
  ready: "",
  writing: "writing…",
  queued: "queued",
  error: "failed",
  not_started: "not yet",
};

function ChapterBody(props: { chapter: StoryChapter | null; availability: ChapterAvailability; number: number; onGenerateAll(): void; canGenerateAll: boolean; busy: boolean; jobText: string; work: StoryWork | null }) {
  const { chapter, availability } = props;
  if (chapter && chapter.status === "done") {
    const parts = paragraphs(chapter.text);
    return (
      <div className="storymode-chapter-text">
        {parts.length ? parts.map((p, i) => <p key={i}>{p}</p>) : <p className="hint">(empty chapter)</p>}
      </div>
    );
  }
  if (availability === "error") {
    return (
      <div className="storymode-chapter-wait" role="alert">
        <span className="storymode-error-note">Chapter {props.number} failed{chapter?.error ? `: ${chapter.error}` : "."}</span>
      </div>
    );
  }
  const work = props.work;
  if (availability === "writing" || availability === "queued") {
    const writingThis = availability === "writing" && work?.chapter === props.number;
    return (
      <div className="storymode-chapter-wait">
        {availability === "writing" ? (
          <Working
            announce={false}
            label={`Writing chapter ${props.number}…`}
            note="The chapter appears here when it is written."
            startedAt={writingThis ? work?.startedAt : null}
            workKey={writingThis && work ? work.key : `chapter-${props.number}`}
          />
        ) : (
          <Working
            announce={false}
            showElapsed={false}
            label={`Chapter ${props.number} is queued…`}
            note={work ? `Now: ${work.label}` : props.jobText || null}
            workKey={`queued-${props.number}`}
          />
        )}
      </div>
    );
  }
  return (
    <div className="storymode-chapter-wait" role="status">
      <span>{`Chapter ${props.number} has not been written yet. Read on and it is written three ahead of you, or generate the rest now.`}</span>
      {availability === "not_started" && props.canGenerateAll ? (
        <button type="button" className="btn" disabled={props.busy} onClick={props.onGenerateAll}>
          Generate the rest
        </button>
      ) : null}
    </div>
  );
}

export function Reader(props: ReaderProps) {
  const { view, current, busy } = props;
  const { session, chapters, job } = view;
  const total = chapterTotal(session, chapters);
  const byNumber = new Map(chapters.map((c) => [c.number, c]));
  const plan = session.brief?.chapter_plan ?? [];
  const chapter = byNumber.get(current) ?? null;
  const availability = chapterAvailability(current, chapters, session, job);
  const remaining = remainingEstimate(session.brief, session);
  const canGenerateAll = !session.generate_all && session.chapters_done < total && (session.status === "generating" || session.status === "paused");
  const canContinue = canContinueStory(session, props.runLastTurnId);
  const jobText = jobQueueText(job);

  const heading = (n: number): string => {
    const done = byNumber.get(n);
    if (done) return chapterHeading(done);
    const planned = plan.find((p) => p.number === n);
    if (planned) return chapterHeading({ number: n, kind: planned.kind, title: planned.title, turn_ids: planned.turn_ids });
    return `${n}. Chapter ${n}`;
  };

  return (
    <>
      <div className="storymode-progress" aria-live="polite">
        <span>
          {session.chapters_done} of {total || "?"} chapters written · {storyStatusText(session.status)}
        </span>
        {total > 0 ? <progress value={session.chapters_done} max={total} aria-label="Chapters written" /> : null}
        {jobText ? <span>{jobText}</span> : null}
        <span>spent {formatSpent(session.spent_usd)} of {formatSpent(session.job_budget_usd)}</span>
        {session.error ? (
          <span className="storymode-error-note" role="alert">
            {session.error}
          </span>
        ) : null}
      </div>
      <div className="storymode-reader-tools">
        {canGenerateAll ? (
          <button type="button" className="btn" disabled={busy} onClick={props.onGenerateAll} title="Write every remaining chapter now instead of three ahead of where you read">
            {generateAllLabel(remaining)}
          </button>
        ) : null}
        {canContinue ? (
          <button type="button" className="btn" disabled={busy} onClick={props.onContinue} title={`The run has turns after ${session.end_turn_id}; add chapters for them`}>
            Continue story
          </button>
        ) : null}
        <button type="button" className="btn" disabled={busy || session.chapters_done === 0} onClick={props.onExport} title="Download the chapters written so far as a Markdown file">
          Export Markdown
        </button>
      </div>

      <div className="storymode-reader">
        <nav className="storymode-chapters" aria-label="Chapters">
          <ol>
            {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
              const state = chapterAvailability(n, chapters, session, job);
              return (
                <li key={n}>
                  <button
                    type="button"
                    className={`storymode-chapter-item${n === current ? " is-current" : ""} is-${state.replace("_", "-")}`}
                    aria-current={n === current ? "true" : undefined}
                    onClick={() => props.onSelect(n)}
                  >
                    <span>{heading(n)}</span>
                    {STATE_WORD[state] ? (
                      <span className="storymode-chapter-state">
                        {state === "writing" ? <WorkingSpinner /> : null}
                        {STATE_WORD[state]}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <article className="storymode-chapter" aria-live="polite">
          <h2>{heading(current)}</h2>
          <ChapterBody chapter={chapter} availability={availability} number={current} onGenerateAll={props.onGenerateAll} canGenerateAll={canGenerateAll} busy={busy} jobText={jobText} work={props.work} />
          {chapter && chapter.status === "done" ? (
            <div className="storymode-chapter-turns">
              {chapter.turn_ids.map((turnId) => (
                <a key={turnId} href={routeHash({ name: "run", runId: props.runId, turnId })} title={`View ${turnId} on the map and in the Turn record`}>
                  Open this turn in the run: {turnLabel(turnId)}
                </a>
              ))}
              <span>
                {modelTier(chapter.model_key) || chapter.model_key}
                {chapter.cost_usd > 0 ? ` · ${formatSpent(chapter.cost_usd)}` : ""}
              </span>
            </div>
          ) : null}
          <div className="storymode-chapter-nav">
            <button type="button" className="btn" disabled={current <= 1} onClick={() => props.onSelect(current - 1)}>
              Previous chapter
            </button>
            <span className="hint">
              Chapter {current} of {total || "?"}
            </span>
            <button type="button" className="btn" disabled={total > 0 && current >= total} onClick={() => props.onSelect(current + 1)}>
              Next chapter
            </button>
          </div>
        </article>
      </div>
    </>
  );
}
