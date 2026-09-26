/**
 * "Ask" entry point: a small button that opens the assistant drawer with a
 * prefilled, editable question (state/assistantContext.askAssistant).  Used by
 * the StatusBar error block, the Turn record header and the Record viewer; the
 * inspector gets the same behaviour through its `onAsk` prop.
 *
 * DOCS: the question is prefilled, never sent by itself: the user reviews it
 * and presses Send (or Ctrl/Cmd+Enter).
 */

import { askAssistant } from "../../state/assistantContext";

export interface AskButtonProps {
  /** The question placed in the composer. */
  question: string;
  /** Button text (default: "Ask: <question>"). */
  label?: string;
  className?: string;
  title?: string;
}

export function AskButton(props: AskButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn-small assistant-ask-btn${props.className ? ` ${props.className}` : ""}`}
      title={props.title ?? "Open the assistant with this question prefilled"}
      onClick={() => askAssistant(props.question)}
    >
      {props.label ?? `Ask: ${props.question}`}
    </button>
  );
}
