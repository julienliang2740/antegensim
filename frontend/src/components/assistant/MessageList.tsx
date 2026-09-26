/**
 * The conversation transcript: user messages (with the context chip they were
 * sent with), assistant answers (formatted blocks, linkified refs, sources,
 * "as of turn", cost, the offline "Docs search" label), clarifying questions
 * with option chips, in-progress cards ("step k/4 · Ns · $x" with Cancel) and
 * failed messages rendered through the fixed error table with a Retry/other
 * action.  Brief messages render a BriefCard.
 *
 * DOCS: progress lines are not announced (aria-live covers final answers only,
 * in the drawer); the list auto-scrolls to the bottom when a new message
 * arrives while the user is already near the bottom.
 */

import { useEffect, useRef } from "react";
import type { Brief, ConversationView, JobView, Message } from "../../api/assistantTypes";
import { errorGuidance, formatUsd, progressLine } from "../../state/assistantBrief";
import type { ErrorAction, DescribeOptions } from "../../state/assistantBrief";
import { AnswerBlocks, RefChips } from "./AnswerBlocks";
import type { RefAction } from "./AnswerBlocks";
import { BriefCard } from "./BriefCard";

export interface MessageListProps {
  view: ConversationView | null;
  /** Wall-clock now (ticks every second while a job runs). */
  now: number;
  onScreenRunId: string | null;
  describe: DescribeOptions;
  busyBriefId: string | null;
  briefErrors: Record<string, string>;
  replyToBriefId: string | null;
  /** Job cancel requested locally (shows "stopping after the current step"). */
  cancelling: boolean;
  onCancelJob(job: JobView): void;
  onRetry(userText: string): void;
  onErrorAction(action: ErrorAction, message: Message): void;
  onOption(text: string): void;
  onAction(action: RefAction): void;
  onApprove(brief: Brief): void;
  onAskChanges(brief: Brief): void;
  onCancelBrief(brief: Brief): void;
  onOpenInSetup(brief: Brief): void;
  onOpenRun(runId: string): void;
  onOpenGodMode(runId: string): void;
}

function elapsedSeconds(job: JobView | null, message: Message, now: number): number {
  const started = job?.started_at ?? message.created_at;
  const t = Date.parse(started);
  if (Number.isFinite(t)) return Math.max(0, (now - t) / 1000);
  return job?.elapsed_s ?? 0;
}

function contextLine(message: Message): string | null {
  const c = message.context;
  if (!c) return null;
  const parts: string[] = [];
  if (c.run_name || c.run_id) parts.push(`run ${c.run_name ?? c.run_id}`);
  if (c.shown_turn_id) parts.push(`turn ${c.shown_turn_id}`);
  if (c.selected_entity_id) parts.push(`${c.selected_entity_id} selected`);
  else if (c.selected_point) parts.push(`point ${c.selected_point}`);
  if (!parts.length) return c.page === "entry" ? "Home" : c.page;
  return parts.join(" · ");
}

export function MessageList(props: MessageListProps) {
  const { view } = props;
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const count = view?.messages.length ?? 0;
  const lastStatus = view?.messages[count - 1]?.status ?? "";

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [count, lastStatus]);

  if (!view || view.messages.length === 0) {
    return (
      <div className="assistant-messages assistant-messages-empty" ref={listRef}>
        <p className="hint">
          Ask how the world works, what an agent is doing, why a run stopped, or say what to set up or run. Anything that changes a run comes back as a
          proposal you approve first.
        </p>
      </div>
    );
  }

  const briefs = new Map(view.briefs.map((b) => [b.brief_id, b]));
  const messages = view.messages;

  return (
    <div className="assistant-messages" ref={listRef} onScroll={onScroll}>
      {messages.map((message, index) => {
        if (message.role === "user") {
          const ctx = contextLine(message);
          return (
            <article key={message.message_id} className="assistant-msg assistant-msg-user">
              <div className="assistant-msg-text">{message.text}</div>
              {ctx ? <div className="assistant-msg-ctx hint">Looking at: {ctx}</div> : null}
            </article>
          );
        }
        const previousUser = [...messages.slice(0, index)].reverse().find((m) => m.role === "user") ?? null;
        const brief = message.brief_id ? (briefs.get(message.brief_id) ?? null) : null;
        const running = message.status === "pending" || message.status === "running";
        const job = view.job && view.job.job_id === message.job_id ? view.job : null;

        if (running) {
          const elapsed = elapsedSeconds(job, message, props.now);
          const line = progressLine(job?.step ?? message.steps.length, job?.max_steps ?? 0, elapsed, job?.cost_usd ?? message.cost_usd);
          const stopping = props.cancelling || !!job?.cancel_requested;
          return (
            <article key={message.message_id} className="assistant-msg assistant-msg-assistant assistant-msg-progress" aria-busy="true">
              <div className="assistant-progress-line">
                <span className="assistant-spinner" aria-hidden="true" />
                <span className="mono">{line}</span>
                {job && !stopping ? (
                  <button type="button" className="btn btn-small" onClick={() => props.onCancelJob(job)}>
                    Cancel
                  </button>
                ) : null}
              </div>
              <div className="hint">{stopping ? "Stopping after the current step…" : (message.progress ?? job?.progress ?? (job?.queue_position ? `Queued (${job.queue_position} ahead)…` : "Thinking…"))}</div>
              {message.steps.length > 0 ? (
                <ul className="assistant-steps">
                  {message.steps.map((step) => (
                    <li key={step.index} className="hint">
                      step {step.index + 1}: {step.kind || "…"}
                      {step.tool_calls.length ? ` · ${step.tool_calls.map((t) => t.summary || t.name).join("; ")}` : ""}
                      {step.status === "error" && step.error ? ` · ${step.error}` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          );
        }

        if (message.status === "error" || message.status === "cancelled" || message.status === "interrupted") {
          const lastStep = message.steps[message.steps.length - 1] ?? null;
          const guidance = errorGuidance(message.status === "interrupted" ? "interrupted" : lastStep?.status ?? null, message.error_code ?? lastStep?.error_code ?? null, message.error);
          return (
            <article key={message.message_id} className="assistant-msg assistant-msg-assistant assistant-msg-error">
              {message.text ? <AnswerBlocks text={message.text} onAction={props.onAction} /> : null}
              <div className="assistant-error" role="alert">
                <div>{guidance.text}</div>
                {message.error && !guidance.text.includes(message.error) ? <div className="hint assistant-error-detail">{message.error}</div> : null}
                <div className="assistant-brief-actions">
                  {guidance.action === "retry" || guidance.action === "shorter" ? (
                    <button type="button" className="btn btn-small" disabled={!previousUser} onClick={() => previousUser && props.onRetry(previousUser.text)}>
                      {guidance.actionLabel}
                    </button>
                  ) : guidance.action !== "none" ? (
                    <button type="button" className="btn btn-small" onClick={() => props.onErrorAction(guidance.action, message)}>
                      {guidance.actionLabel}
                    </button>
                  ) : null}
                  {message.cost_usd ? <span className="hint">cost {formatUsd(message.cost_usd)}</span> : null}
                </div>
              </div>
            </article>
          );
        }

        const meta: string[] = [];
        if (message.as_of_turn_id) meta.push(`as of turn ${message.as_of_turn_id}`);
        if (message.cost_usd) meta.push(formatUsd(message.cost_usd));
        if (message.steps.length > 1) meta.push(`${message.steps.length} steps`);

        return (
          <article key={message.message_id} className={`assistant-msg assistant-msg-assistant${message.offline ? " assistant-msg-offline" : ""}`}>
            {message.offline ? <div className="assistant-offline-label">Docs search (AI offline)</div> : null}
            {brief ? (
              <BriefCard
                brief={brief}
                describe={props.describe}
                busy={props.busyBriefId === brief.brief_id}
                onScreenRunId={props.onScreenRunId}
                awaitingChanges={props.replyToBriefId === brief.brief_id}
                error={props.briefErrors[brief.brief_id] ?? null}
                onApprove={props.onApprove}
                onAskChanges={props.onAskChanges}
                onCancel={props.onCancelBrief}
                onOpenInSetup={props.onOpenInSetup}
                onOpenRun={props.onOpenRun}
                onOpenGodMode={props.onOpenGodMode}
                onAction={props.onAction}
              />
            ) : (
              <AnswerBlocks text={message.text} onAction={props.onAction} />
            )}
            {message.ask_options.length > 0 ? (
              <div className="assistant-options">
                {message.ask_options.map((option) => (
                  <button key={option} type="button" className="assistant-chip" onClick={() => props.onOption(option)}>
                    {option}
                  </button>
                ))}
              </div>
            ) : null}
            <RefChips refs={message.refs} onAction={props.onAction} />
            {message.sources.length > 0 ? <div className="hint assistant-sources">Based on: {message.sources.join(", ")}</div> : null}
            {meta.length > 0 ? <div className="hint assistant-meta">{meta.join(" · ")}</div> : null}
          </article>
        );
      })}
    </div>
  );
}
