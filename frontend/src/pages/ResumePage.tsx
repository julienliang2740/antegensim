/**
 * Resume session (spec "Sessions and run controls": list saved sessions with
 * identifying names, last saved round/turn and save time; the selected run
 * opens paused at its latest complete checkpoint).  Each row also has a
 * "Story" action that opens Story Mode for the run (#/story/<run>) without
 * opening it.
 *
 * Clone setup opens one selected run’s original creation setup in the New session form.
 * It works for active and archived runs without opening or changing the source.
 *
 * Run housekeeping: a checkbox column selects runs (click, Ctrl/Cmd-click, Shift-click
 * ranges and row clicks; the rules are in state/selection.ts).  The selection toolbar
 * archives runs (they move to the archive view, GET /api/runs?archived=1, and can be
 * restored) or deletes them after a confirmation dialog (the run folders are removed for
 * good; the backend refuses a run that is open, 409 run_in_use, and the dialog shows that
 * per run).
 */

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ApiClientError, archiveRun, deleteRun, listRuns, unarchiveRun } from "../api/client";
import type { RunSummary } from "../api/types";
import { ConfirmDialog } from "../components/common/ConfirmDialog";
import { PageHeader } from "../components/common/PageHeader";
import { ErrorLine } from "../components/common/Problems";
import { useFetched } from "../hooks/useFetched";
import { navigate } from "../hooks/useHashRoute";
import { errorText } from "../state/runSessions";
import { applySelectionClick, headerState, pruneSelection, selectedInOrder, toggleAllShown, type SelectionSource } from "../state/selection";
import { stateWord } from "../state/statusText";

type View = "active" | "archive";

interface Notice {
  text: string;
  /** Offer the other view ("View archive" after archiving). */
  viewArchive?: boolean;
  failures: string[];
}

interface DeleteDialogState {
  runs: RunSummary[];
  busy: boolean;
  /** run_id -> "deleted" or the error text, filled as the deletes finish. */
  results: Record<string, string>;
  done: boolean;
}

function lastTurnText(run: RunSummary): string {
  if (run.current_turn_id.endsWith("_init")) return "round 0 · initial state";
  if (run.last_turn_index === null) return `round ${run.last_round} · round end`;
  return `round ${run.last_round} · turn ${run.last_turn_index}`;
}

function savedText(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function failureText(error: unknown): string {
  if (error instanceof ApiClientError && error.body?.detail) return error.body.detail;
  return errorText(error);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Row clicks that land on a control keep their own meaning (open, story, restore, the checkbox). */
function onControl(event: MouseEvent): boolean {
  return event.target instanceof Element && event.target.closest("button, a, input, label, select, textarea") !== null;
}

function HeaderCheckbox(props: { state: "none" | "some" | "all"; disabled: boolean; onToggle(): void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = props.state === "some";
  }, [props.state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="resume-check"
      aria-label={props.state === "all" ? "Clear the shown runs" : "Select all shown runs"}
      title={props.state === "all" ? "Clear the shown runs" : "Select all shown runs"}
      checked={props.state === "all"}
      disabled={props.disabled}
      onChange={props.onToggle}
    />
  );
}

export function ResumePage() {
  const active = useFetched("runs:active", () => listRuns("0"));
  const archived = useFetched("runs:archived", () => listRuns("1"));
  const [view, setView] = useState<View>("active");
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  /** Runs removed from the current view before the reload confirms it (optimistic archive/restore/delete). */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialog, setDialog] = useState<DeleteDialogState | null>(null);
  useEffect(() => {
    document.title = "Resume session · Empyrean";
  }, []);

  const source = view === "active" ? active : archived;
  const list = useMemo(
    () => [...(source.data ?? [])].filter((r) => !hidden.has(r.run_id)).sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1)),
    [source.data, hidden],
  );
  const listIds = useMemo(() => list.map((r) => r.run_id), [list]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((r) => `${r.name} ${r.run_id} ${r.world_id}`.toLowerCase().includes(needle));
  }, [list, filter]);
  const shownIds = useMemo(() => shown.map((r) => r.run_id), [shown]);
  // Ids that left the list (reload, another tab) drop out of the selection without an effect.
  const selected = useMemo(() => pruneSelection(selection, listIds), [selection, listIds]);
  const selectedRuns = useMemo(() => {
    const ids = new Set(selectedInOrder(selected, listIds));
    return list.filter((r) => ids.has(r.run_id));
  }, [selected, listIds, list]);
  const hiddenSelected = selectedRuns.filter((r) => !shownIds.includes(r.run_id)).length;
  const archivedCount = archived.data ? archived.data.filter((r) => !(view === "archive" && hidden.has(r.run_id))).length : null;

  function switchView(next: View) {
    setView(next);
    setSelection(new Set());
    setAnchor(null);
    setHidden(new Set());
    setNotice(null);
  }

  function click(runId: string, event: MouseEvent, from: SelectionSource) {
    const next = applySelectionClick(selected, anchor, runId, shownIds, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey, source: from });
    setSelection(next.selection);
    setAnchor(next.anchor);
  }

  function clearSelection() {
    setSelection(new Set());
    setAnchor(null);
  }

  function reloadBoth() {
    active.reload();
    archived.reload();
  }

  /** Archive (active view) or restore (archive view) runs: they leave the list at once, then both lists reload. */
  async function moveRuns(runs: RunSummary[], to: View) {
    if (runs.length === 0) return;
    const ids = runs.map((r) => r.run_id);
    setHidden((prev) => new Set([...prev, ...ids]));
    setSelection((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
    setBusy(to === "archive" ? `Archiving ${plural(runs.length, "run")}…` : `Restoring ${plural(runs.length, "run")}…`);
    const call = to === "archive" ? archiveRun : unarchiveRun;
    const results = await Promise.allSettled(runs.map((r) => call(r.run_id)));
    const failures: string[] = [];
    const failedIds: string[] = [];
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        failures.push(`${runs[i].name}: ${failureText(result.reason)}`);
        failedIds.push(runs[i].run_id);
      }
    });
    if (failedIds.length) setHidden((prev) => new Set([...prev].filter((id) => !failedIds.includes(id))));
    const moved = runs.length - failures.length;
    setBusy(null);
    setNotice({
      text: to === "archive" ? `Archived ${plural(moved, "run")}.` : `Restored ${plural(moved, "run")} to the active list.`,
      viewArchive: to === "archive" && moved > 0,
      failures,
    });
    reloadBoth();
  }

  function openDeleteDialog() {
    if (selectedRuns.length === 0) return;
    setDialog({ runs: selectedRuns, busy: false, results: {}, done: false });
  }

  async function confirmDelete() {
    if (!dialog) return;
    const runs = dialog.runs;
    setDialog({ ...dialog, busy: true });
    const results: Record<string, string> = {};
    for (const run of runs) {
      try {
        await deleteRun(run.run_id);
        results[run.run_id] = "deleted";
        setHidden((prev) => new Set([...prev, run.run_id]));
      } catch (error) {
        results[run.run_id] = failureText(error);
      }
      setDialog((prev) => (prev ? { ...prev, results: { ...results } } : prev));
    }
    const deleted = runs.filter((r) => results[r.run_id] === "deleted");
    const deletedIds = deleted.map((r) => r.run_id);
    setSelection((prev) => new Set([...prev].filter((id) => !deletedIds.includes(id))));
    const failed = runs.length - deleted.length;
    // Refusals are listed per run in the dialog, which stays open; the notice only reports deletions.
    setNotice(deleted.length ? { text: `Deleted ${plural(deleted.length, "run")} permanently.${failed ? ` ${plural(failed, "run")} could not be deleted.` : ""}`, failures: [] } : null);
    reloadBoth();
    if (failed === 0) setDialog(null);
    else setDialog({ runs, busy: false, results, done: true });
  }

  const header = headerState(selected, shownIds);
  const empty = source.data !== null && list.length === 0;

  return (
    <div className="page resume-page">
      <PageHeader title="Resume session" subtitle="Saved runs, newest first. Opening a run loads its latest complete checkpoint; it opens paused." />
      <div className="action-row resume-filter-row">
        <label className="field">
          <span>Filter by name or id</span>
          <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="part of a name or id" />
        </label>
        <button type="button" className="btn" onClick={reloadBoth}>
          Refresh list
        </button>
        <button type="button" className="btn" onClick={() => navigate({ name: "new" })}>
          New session instead
        </button>
        <span className="resume-view-toggle">
          {view === "active" ? (
            <button type="button" className="btn" onClick={() => switchView("archive")} title="Runs you archived: hidden from this list, nothing deleted">
              Archived runs{archivedCount !== null ? ` (${archivedCount})` : ""}
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => switchView("active")}>
              Back to active runs
            </button>
          )}
        </span>
      </div>
      {view === "archive" ? (
        <p className="resume-archive-banner">
          <strong>Archive.</strong> Archived runs are hidden from the list above; their data is untouched. <strong>Restore</strong> puts a run back.
        </p>
      ) : null}
      <p className="hint resume-select-hint">Select runs with the checkboxes: click a row to select only it, Ctrl-click (Cmd on a Mac) to add or remove one, Shift-click to add a range.</p>
      <ErrorLine text={source.error} prefix="Could not list runs:" />
      {notice ? (
        <div className={`resume-notice${notice.failures.length ? " resume-notice-warn" : ""}`} role="status">
          <span>{notice.text}</span>
          {notice.viewArchive ? (
            <button type="button" className="btn btn-link" onClick={() => switchView("archive")}>
              View archive
            </button>
          ) : null}
          <button type="button" className="btn btn-small resume-notice-close" onClick={() => setNotice(null)} aria-label="Dismiss this notice">
            Dismiss
          </button>
          {notice.failures.length ? (
            <ul className="resume-failures">
              {notice.failures.map((f) => (
                <li key={f} className="error-inline">
                  {f}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {selectedRuns.length > 0 ? (
        <div className="resume-toolbar" role="region" aria-label="Selected runs">
          <strong className="resume-toolbar-count">{selectedRuns.length} selected</strong>
          {hiddenSelected > 0 ? <span className="hint">({hiddenSelected} hidden by the filter)</span> : null}
          <button type="button" className="btn btn-primary" disabled={busy !== null || selectedRuns.length !== 1}
            title={selectedRuns.length === 1 ? "Edit this session’s original setup to create a new world" : "Select exactly one session to clone its setup"}
            onClick={() => navigate({ name: "new", cloneRunId: selectedRuns[0].run_id })}>
            Clone setup
          </button>
          {view === "active" ? (
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void moveRuns(selectedRuns, "archive")}>
              Archive selected
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void moveRuns(selectedRuns, "active")}>
              Restore selected
            </button>
          )}
          <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={openDeleteDialog}>
            Delete selected…
          </button>
          <button type="button" className="btn" onClick={clearSelection}>
            Clear selection
          </button>
          {busy ? <span className="hint">{busy}</span> : null}
        </div>
      ) : null}
      {source.loading && !source.data ? <p className="hint">Fetching the saved runs…</p> : null}
      {empty && view === "active" ? (
        <p className="hint">{archivedCount ? `No active runs. ${plural(archivedCount, "run")} in the archive.` : "No saved runs yet. Start a new session."}</p>
      ) : null}
      {empty && view === "archive" ? <p className="hint">The archive is empty. Archive runs from the active list to put them here.</p> : null}
      {list.length > 0 && shown.length === 0 ? <p className="hint">No run matches the filter.</p> : null}
      {shown.length > 0 ? (
        <table className={`data-table runs-table resume-table${view === "archive" ? " resume-table-archive" : ""}`}>
          <thead>
            <tr>
              <th className="resume-check-col">
                <HeaderCheckbox
                  state={header}
                  disabled={shown.length === 0}
                  onToggle={() => {
                    setSelection(toggleAllShown(selected, shownIds));
                    setAnchor(null);
                  }}
                />
              </th>
              <th>{view === "active" ? "Run (click to open)" : "Archived run"}</th>
              {view === "archive" ? <th>Archived at</th> : null}
              <th>Last saved turn</th>
              <th>Saved at</th>
              <th>Agents (living / total)</th>
              {view === "active" ? <th>Status when listed</th> : null}
              <th>Default model</th>
              {view === "active" ? <th>Story Mode</th> : null}
              <th>Ids</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((run) => {
              const isSelected = selected.has(run.run_id);
              return (
                <tr
                  key={run.run_id}
                  className={isSelected ? "resume-row-selected" : undefined}
                  data-run-id={run.run_id}
                  onMouseDown={(event) => {
                    // no text selection on Shift/Ctrl-clicks
                    if ((event.shiftKey || event.ctrlKey || event.metaKey) && !onControl(event)) event.preventDefault();
                  }}
                  onClick={(event) => {
                    if (!onControl(event)) click(run.run_id, event, "row");
                  }}
                >
                  <td className="resume-check-col">
                    <input
                      type="checkbox"
                      className="resume-check"
                      aria-label={`Select ${run.name}`}
                      checked={isSelected}
                      onChange={() => undefined}
                      onClick={(event) => click(run.run_id, event, "checkbox")}
                    />
                  </td>
                  <td>
                    {view === "active" ? (
                      <button type="button" className="btn btn-link run-open" onClick={() => navigate({ name: "run", runId: run.run_id, turnId: null })}>
                        Open {run.name}
                      </button>
                    ) : (
                      <div className="resume-archived-name">
                        <span className="resume-run-name">{run.name}</span>
                        <button type="button" className="btn btn-small" disabled={busy !== null} onClick={() => void moveRuns([run], "active")} title="Put this run back in the active list">
                          Restore
                        </button>
                      </div>
                    )}
                    {run.parent ? (
                      <div className="hint">
                        continuation of <code>{run.parent.run_id}</code> from <code>{run.parent.turn_id}</code>
                      </div>
                    ) : null}
                  </td>
                  {view === "archive" ? <td>{savedText(run.archived_at)}</td> : null}
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
                  {view === "active" ? <td>{stateWord(run.status)}</td> : null}
                  <td>
                    <code>{run.default_model_key}</code>
                  </td>
                  {view === "active" ? (
                    <td>
                      <button type="button" className="btn btn-small" title="Turn this run into a story (never opens the run)" onClick={() => navigate({ name: "story", runId: run.run_id, storyId: null })}>
                        Story
                      </button>
                    </td>
                  ) : null}
                  <td className="ids">
                    <div>
                      run <code>{run.run_id}</code>
                    </div>
                    <div>
                      world <code>{run.world_id}</code>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {dialog ? (
        <ConfirmDialog
          title={dialog.done ? "Some runs were not deleted" : `Delete ${plural(dialog.runs.length, "run")} permanently?`}
          confirmLabel={dialog.done ? undefined : `Delete ${plural(dialog.runs.length, "run")}`}
          closeLabel={dialog.done ? "Close" : "Cancel"}
          danger
          busy={dialog.busy}
          className="resume-delete-dialog"
          onConfirm={() => void confirmDelete()}
          onClose={() => setDialog(null)}
        >
          {dialog.done ? null : (
            <p>
              The run folders below are removed from disk permanently, with every turn, event, model call and story. <strong>This cannot be undone.</strong> A run that is open (playing or shown in another tab) is refused; leave it first.
            </p>
          )}
          <ul className="resume-delete-list">
            {dialog.runs.map((run) => {
              const result = dialog.results[run.run_id];
              return (
                <li key={run.run_id}>
                  <strong>{run.name}</strong> <code>{run.run_id}</code>
                  {result === "deleted" ? <span className="text-good"> deleted</span> : null}
                  {result && result !== "deleted" ? <div className="error-inline">Not deleted: {result}</div> : null}
                </li>
              );
            })}
          </ul>
          {dialog.busy ? <p className="hint">Deleting…</p> : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
