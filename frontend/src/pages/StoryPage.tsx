/**
 * Story Mode page (STUB from WP0; WP6 replaces this file).
 *
 * Routes (hooks/useHashRoute.ts): "#/story" chooses a run, "#/story/<run>" is
 * the interview / story list for one run, "#/story/<run>/<story>" is one story
 * (brief card, then the reader).  The page never opens the run: history routes
 * and the story API work on closed runs.
 *
 * TODO(WP6): run picker, deterministic step-0 run card with chips
 * (state/storyMode.ts), author interview with Dictate, story brief with both
 * estimates, lazy reader, continue, export Markdown.  Publish
 * { page: "story", runId, storyId } to state/assistantContext.ts.
 */

import { useEffect } from "react";
import { PageHeader } from "../components/common/PageHeader";
import type { StoryRoute } from "../hooks/useHashRoute";

export function StoryPage(props: { route: StoryRoute }) {
  const { runId, storyId } = props.route;
  useEffect(() => {
    document.title = "Story Mode · Empyrean";
  }, []);
  return (
    <div className="page">
      <PageHeader title="Story Mode" subtitle="Turn a finished or running world into a story." />
      <p className="hint">Story Mode is being built.</p>
      {runId ? (
        <p className="hint">
          Run <code>{runId}</code>
          {storyId ? (
            <>
              , story <code>{storyId}</code>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
