/**
 * Story Mode's run picker ("#/story"): every saved run from GET /api/runs with
 * a "Story" action that opens the run's story list (#/story/<run>).  Nothing
 * here opens a run: the list is read from storage and Story Mode works on
 * closed runs.  OWNER: WP6.
 */

import { useMemo, useState } from "react";
import { listRuns } from "../../api/client";
import { useFetched } from "../../hooks/useFetched";
import { navigate } from "../../hooks/useHashRoute";
import { stateWord } from "../../state/statusText";
import { runProgressText } from "../../state/storyMode";
import { ErrorLine } from "../common/Problems";

function savedText(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function RunPicker() {
  const runs = useFetched("runs", () => listRuns());
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = [...(runs.data ?? [])].sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1));
    if (!needle) return list;
    return list.filter((r) => `${r.name} ${r.run_id} ${r.world_id}`.toLowerCase().includes(needle));
  }, [runs.data, filter]);

  return (
    <>
      <div className="action-row">
        <label className="field">
          <span>Filter by name or id</span>
          <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="part of a name or id" />
        </label>
        <button type="button" className="btn" onClick={runs.reload}>
          Refresh list
        </button>
      </div>
      <ErrorLine text={runs.error} prefix="Could not list runs:" />
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
              <th>Story Mode</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((run) => (
              <tr key={run.run_id}>
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
                  <div className="action-row">
                    <button type="button" className="btn btn-primary btn-small" onClick={() => navigate({ name: "story", runId: run.run_id, storyId: null })}>
                      Story
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
