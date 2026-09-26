/**
 * Resume session (spec "Sessions and run controls": list saved sessions with
 * identifying names, last saved round/turn and save time; the selected run
 * opens paused at its latest complete checkpoint).  Each row also has a
 * "Story" action that opens Story Mode for the run (#/story/<run>) without
 * opening it.
 */

import { useEffect, useMemo, useState } from "react";
import { listRuns } from "../api/client";
import type { RunSummary } from "../api/types";
import { PageHeader } from "../components/common/PageHeader";
import { ErrorLine } from "../components/common/Problems";
import { useFetched } from "../hooks/useFetched";
import { navigate } from "../hooks/useHashRoute";
import { stateWord } from "../state/statusText";

function lastTurnText(run: RunSummary): string {
  if (run.current_turn_id.endsWith("_init")) return "round 0 · initial state";
  if (run.last_turn_index === null) return `round ${run.last_round} · round end`;
  return `round ${run.last_round} · turn ${run.last_turn_index}`;
}

function savedText(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function ResumePage() {
  const runs = useFetched("runs", () => listRuns());
  const [filter, setFilter] = useState("");
  useEffect(() => {
    document.title = "Resume session · Empyrean";
  }, []);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = [...(runs.data ?? [])].sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1));
    if (!needle) return list;
    return list.filter((r) => `${r.name} ${r.run_id} ${r.world_id}`.toLowerCase().includes(needle));
  }, [runs.data, filter]);

  return (
    <div className="page resume-page">
      <PageHeader title="Resume session" subtitle="Saved runs, newest first. Opening a run loads its latest complete checkpoint; it opens paused." />
      <div className="action-row">
        <label className="field">
          <span>Filter by name or id</span>
          <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="part of a name or id" />
        </label>
        <button type="button" className="btn" onClick={runs.reload}>
          Refresh list
        </button>
        <button type="button" className="btn" onClick={() => navigate({ name: "new" })}>
          New session instead
        </button>
      </div>
      <ErrorLine text={runs.error} prefix="Could not list runs:" />
      {runs.loading && !runs.data ? <p className="hint">Fetching the saved runs…</p> : null}
      {runs.data && runs.data.length === 0 ? <p className="hint">No saved runs yet. Start a new session.</p> : null}
      {shown.length > 0 ? (
        <table className="data-table runs-table">
          <thead>
            <tr>
              <th>Run (click to open)</th>
              <th>Last saved turn</th>
              <th>Saved at</th>
              <th>Agents (living / total)</th>
              <th>Status when listed</th>
              <th>Default model</th>
              <th>Story Mode</th>
              <th>Ids</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((run) => (
              <tr key={run.run_id}>
                <td>
                  <button type="button" className="btn btn-link run-open" onClick={() => navigate({ name: "run", runId: run.run_id, turnId: null })}>
                    Open {run.name}
                  </button>
                  {run.parent ? (
                    <div className="hint">
                      continuation of <code>{run.parent.run_id}</code> from <code>{run.parent.turn_id}</code>
                    </div>
                  ) : null}
                </td>
                <td>
                  {lastTurnText(run)}
                  <div className="hint">
                    <code>{run.current_turn_id}</code>
                  </div>
                </td>
                <td>{savedText(run.saved_at)}</td>
                <td>
                  {run.living_agent_count} / {run.agent_count}
                </td>
                <td>{stateWord(run.status)}</td>
                <td>
                  <code>{run.default_model_key}</code>
                </td>
                <td>
                  <button type="button" className="btn btn-small" title="Turn this run into a story (never opens the run)" onClick={() => navigate({ name: "story", runId: run.run_id, storyId: null })}>
                    Story
                  </button>
                </td>
                <td className="ids">
                  <div>
                    run <code>{run.run_id}</code>
                  </div>
                  <div>
                    world <code>{run.world_id}</code>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
