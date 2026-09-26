/**
 * Entry page (spec U10 "resume an old session" / "start a new session": the
 * two clear entry choices, plus the "How the world works" instructions).
 */

import { useEffect } from "react";
import { getHealth } from "../api/client";
import { useFetched } from "../hooks/useFetched";
import { navigate } from "../hooks/useHashRoute";
import { openInstructions } from "./InstructionsPage";
import "../setup.css";

export function EntryPage() {
  const health = useFetched("health", () => getHealth());
  useEffect(() => {
    document.title = "Empyrean";
  }, []);
  return (
    <div className="page entry-page">
      <header className="entry-header">
        <h1>Empyrean</h1>
        <p>LLM artificial-life world — operator console (prototype)</p>
      </header>
      <div className="entry-choices entry-choices-three">
        <button type="button" className="choice" onClick={() => navigate({ name: "new" })}>
          <span className="choice-title">New session</span>
          <span className="choice-text">Set up a new world.</span>
        </button>
        <button type="button" className="choice" onClick={() => navigate({ name: "resume" })}>
          <span className="choice-title">Resume session</span>
          <span className="choice-text">Open an old run to resume it or replay it.</span>
        </button>
        <button type="button" className="choice choice-secondary" onClick={openInstructions}>
          <span className="choice-title">How the world works</span>
          <span className="choice-text">The rules of the Empyrean: resources, plants, actions, skills, combat, and what you can do as the operator.</span>
        </button>
      </div>
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
