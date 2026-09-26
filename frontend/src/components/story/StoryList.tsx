/**
 * The stories of one run ("#/story/<run>"): GET .../assistant/stories as a
 * table (title, status, chapters, spend, last change) with "Open", and "New
 * story", which creates a session with the deterministic run card (POST
 * .../stories with no picks and no text: no model call, nothing spent) and
 * opens it.  OWNER: WP6.
 */

import { useState } from "react";
import { getRun } from "../../api/client";
import { createStory, listStories } from "../../api/story";
import type { StorySessionSummary } from "../../api/storyTypes";
import { useFetched } from "../../hooks/useFetched";
import { navigate } from "../../hooks/useHashRoute";
import { errorText } from "../../state/runSessions";
import { formatSpent, runProgressText, storyStatusText } from "../../state/storyMode";
import { ErrorLine } from "../common/Problems";
import { StatusBadge } from "./StatusBadge";

function whenText(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function chaptersText(story: StorySessionSummary): string {
  if (story.chapters_total > 0) return `${story.chapters_done} / ${story.chapters_total}`;
  return story.chapters_done > 0 ? String(story.chapters_done) : "—";
}

export function StoryList(props: { runId: string; onRunName(name: string | null): void }) {
  const { runId } = props;
  const run = useFetched(`run:${runId}`, async () => {
    const summary = await getRun(runId);
    props.onRunName(summary.name);
    return summary;
  });
  const stories = useFetched(`stories:${runId}`, () => listStories(runId));
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const newStory = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const view = await createStory(runId, { picks: null, text: "" });
      navigate({ name: "story", runId, storyId: view.session.story_id });
    } catch (e) {
      setCreateError(errorText(e));
      setCreating(false);
    }
  };

  const list = [...(stories.data ?? [])].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));

  return (
    <>
      <div className="storymode-toolbar">
        <button type="button" className="btn btn-link" onClick={() => navigate({ name: "story", runId: null, storyId: null })}>
          Choose another run
        </button>
        <button type="button" className="btn btn-link" onClick={() => navigate({ name: "run", runId, turnId: null })}>
          Open the run
        </button>
        {run.data ? (
          <span>
            {runProgressText(run.data)} · {run.data.living_agent_count} of {run.data.agent_count} agents living
          </span>
        ) : null}
      </div>
      <ErrorLine text={run.error} prefix="Could not read the run:" />
      <ErrorLine text={stories.error} prefix="Could not list the stories:" />
      <ErrorLine text={createError} prefix="Could not start a story:" />
      <div className="action-row">
        <button type="button" className="btn btn-primary" disabled={creating || !!stories.error} onClick={() => void newStory()}>
          {creating ? "Starting…" : "New story"}
        </button>
        <span className="hint">Starting a story costs nothing: the first step is a summary of the run with your choices. The author writes a brief only when you ask.</span>
      </div>
      {stories.loading && !stories.data ? <p className="hint">Reading the stories…</p> : null}
      {stories.data && stories.data.length === 0 ? <p className="storymode-empty">No stories of this run yet.</p> : null}
      {list.length > 0 ? (
        <table className="data-table storymode-stories">
          <thead>
            <tr>
              <th>Story</th>
              <th>Status</th>
              <th>Chapters (written / planned)</th>
              <th>Spent</th>
              <th>Last change</th>
            </tr>
          </thead>
          <tbody>
            {list.map((story) => (
              <tr key={story.story_id}>
                <td>
                  <button type="button" className="btn btn-link storymode-open" onClick={() => navigate({ name: "story", runId, storyId: story.story_id })}>
                    {story.title.trim() || "Untitled story"}
                  </button>
                  <div className="hint">
                    <code>{story.story_id}</code> · one chapter per {story.unit}
                  </div>
                </td>
                <td>
                  <StatusBadge status={story.status} /> <span className="hint">{storyStatusText(story.status)}</span>
                </td>
                <td>{chaptersText(story)}</td>
                <td>{formatSpent(story.spent_usd)}</td>
                <td>{whenText(story.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
