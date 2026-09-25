/**
 * Entry page (spec U10 "resume an old session" / "start a new session": the
 * two clear entry choices).
 */

import { useEffect } from "react";
import { getHealth } from "../api/client";
import { useFetched } from "../hooks/useFetched";
import { navigate } from "../hooks/useHashRoute";

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
      <div className="entry-choices">
        <button type="button" className="choice" onClick={() => navigate({ name: "new" })}>
          <span className="choice-title">New session</span>
          <span className="choice-text">Set up the world, plant rules, context settings and 6–11 agent cards (8 prefilled), then open the new run paused.</span>
        </button>
        <button type="button" className="choice" onClick={() => navigate({ name: "resume" })}>
          <span className="choice-title">Resume session</span>
          <span className="choice-text">Pick a saved run and open it paused at its latest saved turn, ready to inspect or continue.</span>
        </button>
      </div>
      <p className="entry-hint">
        <strong>Continue from history:</strong> resume a run, go back to a recorded turn with the timeline arrows, then in <em>God mode</em> use "Create
        continuation from turn …". The new run starts from that checkpoint; the original run and its future stay untouched.
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
