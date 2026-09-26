/**
 * The drawer's composer: a textarea, Send (Ctrl/Cmd+Enter), the Dictate button
 * (WP4's DictateButton inserts the transcript, never sends), the "Include what
 * I'm looking at" chip, the "replying to a proposal" line and suggestion chips
 * for an empty conversation.
 *
 * While a reply is being written Send shows a spinner and "Thinking…".
 *
 * DOCS: the composer is controlled by the drawer (text state lives there so
 * "Ask" entry points and "Ask for changes" can prefill it).  Recording state is
 * reported upwards so Escape cancels a recording before it closes the drawer.
 */

import { useEffect } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { DictateButton } from "./DictateButton";
import { WorkingSpinner } from "../common/Working";

export interface ComposerProps {
  text: string;
  onText(text: string): void;
  onSend(): void;
  /** True while a job runs or a send is in flight (Send disabled, Dictate blocked). */
  busy: boolean;
  /** Composer disabled entirely (assistant unavailable). */
  disabled?: boolean;
  disabledReason?: string | null;
  includeContext: boolean;
  onIncludeContext(value: boolean): void;
  contextLabel: string;
  /** The brief being revised ("Ask for changes"); null otherwise. */
  replyTo: { id: string; title: string } | null;
  onClearReplyTo(): void;
  suggestions: string[];
  onSuggestion(text: string): void;
  runId: string | null;
  language: string;
  onRecordingChange(active: boolean): void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Labels the two composers of a page ("Ask the assistant" / "Story author"). */
  label?: string;
}

const MAX_TEXT = 4000;

export function Composer(props: ComposerProps) {
  const { textareaRef, onSend } = props;

  // Grow with the text (up to a cap; the textarea then scrolls).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(180, Math.max(56, el.scrollHeight))}px`;
  }, [props.text, textareaRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!props.busy && !props.disabled && props.text.trim()) onSend();
    }
  };

  /** Insert a transcript at the caret (a space before it unless the caret follows whitespace), then focus after it. */
  const insertAtCaret = (text: string) => {
    const el = textareaRef.current;
    const current = props.text;
    const start = el ? el.selectionStart : current.length;
    const end = el ? el.selectionEnd : current.length;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const glue = before && !/\s$/.test(before) ? " " : "";
    const inserted = `${glue}${text}`;
    props.onText(`${before}${inserted}${after}`);
    const caret = before.length + inserted.length;
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(caret, caret);
    });
  };

  const canSend = !props.busy && !props.disabled && props.text.trim().length > 0 && props.text.length <= MAX_TEXT;
  const label = props.label ?? "Ask the assistant";

  return (
    <div className="assistant-composer">
      {props.suggestions.length > 0 ? (
        <div className="assistant-suggestions" aria-label="Suggested questions">
          {props.suggestions.map((s) => (
            <button key={s} type="button" className="assistant-chip assistant-suggestion" disabled={props.busy || props.disabled} onClick={() => props.onSuggestion(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : null}
      {props.replyTo ? (
        <div className="assistant-replyto">
          Changing the proposal <strong>{props.replyTo.title}</strong> (it will be replaced by a new one).{" "}
          <button type="button" className="btn-link" onClick={props.onClearReplyTo}>
            Not a change
          </button>
        </div>
      ) : null}
      <label className="assistant-sr-only" htmlFor="assistant-composer-text">
        {label}
      </label>
      <textarea
        id="assistant-composer-text"
        ref={textareaRef}
        className="assistant-textarea"
        rows={2}
        value={props.text}
        maxLength={MAX_TEXT}
        disabled={props.disabled}
        placeholder={props.disabled ? (props.disabledReason ?? "The assistant is unavailable") : "Ask about the world, the controls or what is happening; or say what to set up or run."}
        onChange={(e) => props.onText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="assistant-composer-row">
        <label className={`assistant-chip assistant-context-chip${props.includeContext ? " assistant-chip-on" : ""}`} title={`Sent with the question: ${props.contextLabel}`}>
          <input type="checkbox" checked={props.includeContext} onChange={(e) => props.onIncludeContext(e.target.checked)} /> Include what I'm looking at
        </label>
        <span className="assistant-composer-spacer" />
        <DictateButton
          onText={insertAtCaret}
          disabledReason={props.disabled ? (props.disabledReason ?? "The assistant is unavailable") : props.busy ? "Wait for the reply" : null}
          runId={props.runId}
          language={props.language}
          ariaLabel="Dictate to the assistant"
          onRecordingChange={props.onRecordingChange}
        />
        <button type="button" className="btn btn-primary btn-small assistant-send" disabled={!canSend} title="Send (Ctrl+Enter or Cmd+Enter)" onClick={() => props.onSend()}>
          {props.busy ? (
            <>
              <WorkingSpinner />
              Thinking…
            </>
          ) : (
            "Send"
          )}
        </button>
      </div>
      <div className="hint assistant-composer-hint">
        {props.text.length > MAX_TEXT - 200 ? `${props.text.length}/${MAX_TEXT} characters · ` : ""}Ctrl/Cmd+Enter sends. Proposals to set up or run things need your approval first.
      </div>
    </div>
  );
}
