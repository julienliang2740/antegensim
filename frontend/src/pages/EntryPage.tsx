/**
 * Entry page (spec U10 "resume an old session" / "start a new session": the
 * two clear entry choices, the "How the world works" instructions and, since
 * rev 4, Story Mode).  "New here? Ask the assistant" opens the drawer with a
 * first question prefilled.
 */

import { useEffect } from "react";
import { getHealth } from "../api/client";
import { useFetched } from "../hooks/useFetched";
import { navigate } from "../hooks/useHashRoute";
import { askAssistant, publishContext } from "../state/assistantContext";
import { openInstructions } from "./InstructionsPage";
import "../setup.css";

const FIRST_QUESTION = "What is Empyrean and how do I start?";

export function EntryPage() {
  const health = useFetched("health", () => getHealth());
  useEffect(() => {
    document.title = "Empyrean";
    publishContext({ page: "entry" });
  }, []);
  return (
    <div className="page entry-page">
      <header className="entry-header">
        <h1>Empyrean</h1>
        <p>LLM artificial-life world — operator console (prototype)</p>
      </header>
      <div className="entry-choices entry-choices-four">
        <button type="button" className="choice" onClick={() => navigate({ name: "new" })}>
          <span className="choice-title">New session</span>
          <span className="choice-text">Set up a new world.</span>
        </button>
        <button type="button" className="choice" onClick={() => navigate({ name: "resume" })}>
          <span className="choice-title">Resume session</span>
          <span className="choice-text">Open an old run to resume it or replay it.</span>
        </button>
        <button type="button" className="choice" onClick={() => navigate({ name: "story", runId: null, storyId: null })}>
          <span className="choice-title">Story Mode</span>
          <span className="choice-text">Turn a finished or running world into a story: pick a run, genre, tone and point of view, read it chapter by chapter.</span>
        </button>
        <button type="button" className="choice choice-secondary" onClick={openInstructions}>
          <span className="choice-title">How the world works</span>
          <span className="choice-text">The rules of the Empyrean: resources, plants, actions, skills, combat, and what you can do as the operator.</span>
        </button>
      </div>
      <p className="entry-ask">
        New here?{" "}
        <button type="button" className="btn-link" onClick={() => askAssistant(FIRST_QUESTION)}>
          Ask the assistant: "{FIRST_QUESTION}"
        </button>
      </p>
      <p className="hint">
        Backend:{" "}
        {health.data ? (
          <span className="text-good">reachable (version {health.data.version})</span>
        ) : health.error ? (
          <span className="text-bad">not reachable ({health.error}). Start it with: cd backend &amp;&amp; ../.venv/bin/python -m empyrean.main</span>
        ) : (
          "checking…"
        )}
      </p>
    </div>
  );
}
