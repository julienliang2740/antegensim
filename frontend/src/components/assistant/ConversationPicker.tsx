/**
 * Conversation picker of the drawer header: the conversations of the page's
 * scope (this run, or Home), plus New / Rename / Delete.  Titles come from the
 * backend (auto-titled from the first message, or renamed here).
 *
 * DOCS: conversations are per scope (a run, or the global "Home" scope); the
 * drawer remembers the last one opened per scope in localStorage.  Delete is
 * refused by the backend with 409 conversation_busy while a job runs.
 */

import { useState } from "react";
import type { ConversationMeta } from "../../api/assistantTypes";

export interface ConversationPickerProps {
  conversations: ConversationMeta[];
  currentId: string | null;
  /** The current conversation's title (it may not be in the scope's list after a rebind). */
  currentTitle: string | null;
  busy: boolean;
  onSelect(id: string): void;
  onNew(): void;
  onRename(id: string, title: string): Promise<void>;
  onDelete(id: string): Promise<void>;
}

export function ConversationPicker(props: ConversationPickerProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = props.conversations.find((c) => c.conversation_id === props.currentId) ?? null;
  const listed = current !== null;

  const startRename = () => {
    setDraft(current?.title ?? props.currentTitle ?? "");
    setRenaming(true);
    setError(null);
  };
  const saveRename = async () => {
    if (!props.currentId) return;
    const title = draft.trim();
    if (!title) return setError("The title cannot be empty.");
    try {
      await props.onRename(props.currentId, title);
      setRenaming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const doDelete = async () => {
    if (!props.currentId) return;
    try {
      await props.onDelete(props.currentId);
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="assistant-conv">
      {renaming ? (
        <div className="assistant-conv-row">
          <input
            type="text"
            className="assistant-conv-input"
            aria-label="Conversation title"
            value={draft}
            maxLength={120}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveRename();
              if (e.key === "Escape") {
                e.stopPropagation();
                setRenaming(false);
              }
            }}
          />
          <button type="button" className="btn btn-small" onClick={() => void saveRename()}>
            Save
          </button>
          <button type="button" className="btn btn-small" onClick={() => setRenaming(false)}>
            Cancel
          </button>
        </div>
      ) : confirming ? (
        <div className="assistant-conv-row">
          <span className="hint">Delete this conversation?</span>
          <button type="button" className="btn btn-small btn-danger" disabled={props.busy} onClick={() => void doDelete()}>
            Delete
          </button>
          <button type="button" className="btn btn-small" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </div>
      ) : (
        <div className="assistant-conv-row">
          <select
            className="assistant-conv-select"
            aria-label="Conversation"
            value={listed ? props.currentId ?? "" : props.currentId ? "__current" : ""}
            onChange={(e) => {
              if (e.target.value === "__new") props.onNew();
              else if (e.target.value && e.target.value !== "__current") props.onSelect(e.target.value);
            }}
          >
            {!props.currentId ? <option value="">New conversation</option> : null}
            {props.currentId && !listed ? <option value="__current">{props.currentTitle ?? "Current conversation"}</option> : null}
            {props.conversations.map((c) => (
              <option key={c.conversation_id} value={c.conversation_id}>
                {c.title}
                {c.message_count ? ` (${c.message_count})` : ""}
              </option>
            ))}
            <option value="__new">+ New conversation</option>
          </select>
          <button type="button" className="btn btn-small" title="Start a new conversation in this scope" onClick={props.onNew}>
            New
          </button>
          <button type="button" className="btn btn-small" disabled={!props.currentId} title="Rename this conversation" onClick={startRename}>
            Rename
          </button>
          <button type="button" className="btn btn-small" disabled={!props.currentId || props.busy} title="Delete this conversation" onClick={() => setConfirming(true)}>
            Delete
          </button>
        </div>
      )}
      {error ? <div className="error-inline">{error}</div> : null}
    </div>
  );
}
