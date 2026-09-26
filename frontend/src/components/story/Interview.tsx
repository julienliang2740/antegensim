/**
 * The Story Mode interview transcript: the user's requests and the author's
 * replies (the working indicator while a reply is being written, the error
 * when one failed).  The author's pending reply is not a stored message: the
 * page passes `pending` (state/storyMode.ts storyWork) while the story job
 * writes it.  The story brief itself is shown by BriefCard, not here.  OWNER: WP6.
 */

import type { StoryMessage } from "../../api/storyTypes";
import { formatSpent, paragraphs, type StoryWork } from "../../state/storyMode";
import { Working } from "../common/Working";

function MessageBody(props: { message: StoryMessage }) {
  const { message } = props;
  if (message.status === "pending" || message.status === "running") {
    return <Working announce={false} label={message.progress || (message.role === "assistant" ? "Story author is thinking…" : "Sending…")} startedAt={message.created_at} workKey={message.message_id} />;
  }
  if (message.status === "error") {
    return (
      <p className="storymode-error-note" role="alert">
        {message.error || "The author's reply failed."}
        {message.error_code ? ` (${message.error_code})` : ""}
      </p>
    );
  }
  if (message.status === "cancelled" || message.status === "interrupted") {
    return <p className="storymode-msg-progress">{message.text.trim() || (message.status === "cancelled" ? "Cancelled." : "Interrupted by a server restart.")}</p>;
  }
  const parts = paragraphs(message.text);
  return <>{parts.length ? parts.map((p, i) => <p key={i}>{p}</p>) : <p className="storymode-msg-progress">(no text)</p>}</>;
}

export function Interview(props: { messages: StoryMessage[]; pending?: StoryWork | null }) {
  const pending = props.pending ?? null;
  const stored = props.messages.some((m) => m.role === "assistant" && (m.status === "pending" || m.status === "running"));
  if (props.messages.length === 0 && !pending) return null;
  return (
    <ol className="storymode-messages" aria-label="Story author interview">
      {props.messages.map((message) => (
        <li key={message.message_id} className={`storymode-msg storymode-msg-${message.role}`}>
          <span className="storymode-msg-role">
            {message.role === "user" ? "You" : "Story author"}
            {message.role === "assistant" && message.cost_usd ? ` · ${formatSpent(message.cost_usd)}` : ""}
            {message.ask_options && message.ask_options.length ? " · asks" : ""}
          </span>
          <MessageBody message={message} />
        </li>
      ))}
      {pending && !stored ? (
        <li className="storymode-msg storymode-msg-assistant storymode-msg-pending">
          <span className="storymode-msg-role">Story author</span>
          <Working announce={false} label={pending.label} note={pending.note} startedAt={pending.startedAt} workKey={pending.key} />
        </li>
      ) : null}
    </ol>
  );
}
