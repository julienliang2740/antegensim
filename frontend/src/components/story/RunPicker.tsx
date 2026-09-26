/**
 * Story Mode's run picker ("#/story"): every saved run from GET /api/runs with
 * a "Story" action that opens the run's story list (#/story/<run>).  Runs with
 * an unfinished story (choosing, brief ready, writing, paused, interrupted) are
 * listed first, most recently touched first, with a "Stories" cell that says
 * what is going on; a "Finished stories" button at the top right of the table
 * opens the complete stories of every run, newest first.  Both come from
 * GET /api/assistant/stories.  Nothing here opens a run: the lists are read
 * from storage and Story Mode works on closed runs.  OWNER: WP6.
 */

import { useMemo, useState } from "react";
import { listRuns } from "../../api/client";
import { listAllStories } from "../../api/story";
import type { StorySessionSummary } from "../../api/storyTypes";
import { useFetched } from "../../hooks/useFetched";
import { navigate } from "../../hooks/useHashRoute";
import { stateWord } from "../../state/statusText";
import { finishedStoriesNewestFirst, formatSpent, orderRunsForPicker, runProgressText, unfinishedByRun, unfinishedStoryText } from "../../state/storyMode";
import { StatusBadge } from "./StatusBadge";
import { ErrorLine } from "../common/Problems";

function savedText(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function FinishedStories(props: { stories: StorySessionSummary[]; loading: boolean; error: string | null; onClose(): void }) {
  const finished = finishedStoriesNewestFirst(props.stories);
  return (
    <section className="storymode-finished" aria-label="Finished stories">
      <div className="storymode-finished-head">
        <h2>Finished stories</h2>
        <span className="hint">Complete stories of every run, most recent first.</span>
        <button type="button" className="btn btn-small" onClick={props.onClose}>
          Back to runs
        </button>
      </div>
      <ErrorLine text={props.error} prefix="Could not list stories:" />
      {props.loading && props.stories.length === 0 ? <p className="hint">Fetching the stories…</p> : null}
      {!props.loading && finished.length === 0 ? <p className="storymode-empty">No finished story yet. Pick a run below and write one.</p> : null}
      {finished.length > 0 ? (
        <table className="data-table storymode-stories">
          <thead>
            <tr>
              <th>Story</th>
              <th>Run</th>
              <th>Chapters</th>
              <th>Spent</th>
              <th>Finished</th>
              <th>Open</th>
            </tr>
          </thead>
          <tbody>
            {finished.map((s) => (
              <tr key={`${s.run_id}/${s.story_id}`}>
                <td>
                  <strong>{s.title || "untitled"}</strong>
                  <div className="hint">
                    <StatusBadge status={s.status} /> one chapter per {s.unit}
                  </div>
                </td>
                <td>
                  {s.run_name || s.run_id}
                  <div className="hint">
                    <code>{s.run_id}</code>
                  </div>
                </td>
                <td>
                  {s.chapters_done} / {s.chapters_total}
                </td>
                <td>{formatSpent(s.spent_usd)}</td>
                <td>{savedText(s.updated_at)}</td>
                <td>
                  <button type="button" className="btn btn-primary btn-small" onClick={() => navigate({ name: "story", runId: s.run_id, storyId: s.story_id })}>
                    Read
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export function RunPicker() {
  const runs = useFetched("runs", () => listRuns());
  const stories = useFetched("stories:all", () => listAllStories("all"));
  const [filter, setFilter] = useState("");
  const [showFinished, setShowFinished] = useState(false);

  const work = useMemo(() => unfinishedByRun(stories.data ?? []), [stories.data]);
  const finishedCount = useMemo(() => finishedStoriesNewestFirst(stories.data ?? []).length, [stories.data]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = orderRunsForPicker(runs.data ?? [], work);
    if (!needle) return list;
    return list.filter((r) => `${r.name} ${r.run_id} ${r.world_id}`.toLowerCase().includes(needle));
  }, [runs.data, work, filter]);

  const reload = () => {
    runs.reload();
    stories.reload();
  };

  return (
    <>
      <div className="action-row">
        <label className="field">
          <span>Filter by name or id</span>
          <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="part of a name or id" />
        </label>
        <button type="button" className="btn" onClick={reload}>
          Refresh list
        </button>
        <button
          type="button"
          className={`btn storymode-finished-toggle${showFinished ? " is-on" : ""}`}
          aria-pressed={showFinished}
          onClick={() => setShowFinished((v) => !v)}
          title="Complete stories of every run, most recent first"
        >
          {showFinished ? "Hide finished stories" : `Finished stories${finishedCount ? ` (${finishedCount})` : ""}`}
        </button>
      </div>
      {showFinished ? <FinishedStories stories={stories.data ?? []} loading={stories.loading} error={stories.error} onClose={() => setShowFinished(false)} /> : null}
      <ErrorLine text={runs.error} prefix="Could not list runs:" />
      {work.size > 0 && !filter ? <p className="hint">Runs with an unfinished story are listed first.</p> : null}
      {runs.loading && !runs.data ? <p className="hint">Fetching the saved runs…</p> : null}
      {runs.data && runs.data.length === 0 ? (
        <p className="storymode-empty">
          No saved runs yet. Start a{" "}
          <button type="button" className="btn btn-link" onClick={() => navigate({ name: "new" })}>
            new session
          </button>{" "}
          first; a story can be written while it runs or after it ends.
        </p>
      ) : null}
      {shown.length > 0 ? (
        <table className="data-table runs-table storymode-runs">
          <thead>
            <tr>
              <th>Run</th>
              <th>Progress</th>
              <th>Agents (living / total)</th>
              <th>Status when listed</th>
              <th>Saved at</th>
              <th>Stories</th>
              <th>Story Mode</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((run) => (
              <tr key={run.run_id} className={work.has(run.run_id) ? "storymode-run-unfinished" : undefined}>
                <td>
                  <strong>{run.name}</strong>
                  <div className="hint">
                    run <code>{run.run_id}</code> · world <code>{run.world_id}</code>
                  </div>
                  {run.parent ? (
                    <div className="hint">
                      continuation of <code>{run.parent.run_id}</code> from <code>{run.parent.turn_id}</code>
                    </div>
                  ) : null}
                </td>
                <td>
                  {runProgressText(run)}
                  <div className="hint">
                    <code>{run.current_turn_id}</code>
                  </div>
                </td>
                <td>
                  {run.living_agent_count} / {run.agent_count}
                </td>
                <td>{stateWord(run.status)}</td>
                <td>{savedText(run.saved_at)}</td>
                <td>
                  {work.has(run.run_id) ? (
                    <span className="storymode-run-work">
                      <StatusBadge status={work.get(run.run_id)!.story!.status} /> {unfinishedStoryText(work.get(run.run_id))}
                    </span>
                  ) : (
                    <span className="hint">{stories.data ? "none in progress" : "…"}</span>
                  )}
                </td>
                <td>
                  <div className="action-row">
                    <button type="button" className="btn btn-primary btn-small" onClick={() => navigate({ name: "story", runId: run.run_id, storyId: work.get(run.run_id)?.story?.story_id ?? null })}>
                      {work.has(run.run_id) ? "Continue story" : "Story"}
                    </button>
                    <button type="button" className="btn btn-link" onClick={() => navigate({ name: "run", runId: run.run_id, turnId: null })}>
                      Open run
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
