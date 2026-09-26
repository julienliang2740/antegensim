/**
 * An execution brief card (amended D6).  Its primary "What will happen"
 * section is rendered deterministically from the typed action
 * (state/assistantBrief.describeAction: describeIntervention lines for staged
 * edits, fixed sentences for commands, continuations, open_run and settings)
 * plus the backend-computed setup diff, warnings and validation problems.  The
 * model's own title/summary/steps follow as "Assistant's description", then
 * "Proposed in reply to: <message>".
 *
 * Buttons: Approve (named by effect; disabled when invalid; for a run command
 * whose run is not on screen it becomes "Open <run> and run this"), Ask for
 * changes (quotes the brief into the composer), Cancel (reject).  After
 * execution the card turns into a result with links to the run or the staged
 * edits.  Nothing here calls the API: the drawer owns approve/reject.
 *
 * DOCS: model text on the card is always labelled as the assistant's
 * description and never drives what executes; an invalid brief cannot be
 * approved.
 */

import type { Brief } from "../../api/assistantTypes";
import { approveLabel, describeAction, describeSetupDiff, formatUsd, requiresOnScreenRun } from "../../state/assistantBrief";
import type { DescribeOptions } from "../../state/assistantBrief";
import { AnswerBlocks } from "./AnswerBlocks";
import type { RefAction } from "./AnswerBlocks";

export interface BriefCardProps {
  brief: Brief;
  describe: DescribeOptions;
  /** True while this brief's approve/reject request runs. */
  busy: boolean;
  /** The run shown in this tab (run commands may only be approved while their run is on screen). */
  onScreenRunId: string | null;
  /** "Waiting for your changes": the composer is replying to this brief. */
  awaitingChanges: boolean;
  /** Error of the last approve/reject attempt on this brief. */
  error: string | null;
  onApprove(brief: Brief): void;
  onAskChanges(brief: Brief): void;
  onCancel(brief: Brief): void;
  /** Secondary for create_run: prefill the New session form instead. */
  onOpenInSetup(brief: Brief): void;
  onOpenRun(runId: string): void;
  onOpenGodMode(runId: string): void;
  onAction(action: RefAction): void;
}

const STATUS_LABEL: Record<Brief["status"], string> = {
  pending: "awaiting your approval",
  executing: "executing…",
  executed: "done",
  failed: "failed",
  rejected: "cancelled",
  superseded: "replaced by a newer proposal",
  invalid: "invalid",
};

function overlayModelKey(brief: Brief): string | null {
  if (brief.action?.type !== "create_run") return null;
  const key = (brief.action.overlay as { default_model_key?: unknown }).default_model_key;
  return typeof key === "string" ? key : null;
}

export function BriefCard(props: BriefCardProps) {
  const { brief } = props;
  const action = brief.action;
  const validation = brief.validation;
  const lines = describeAction(action, props.describe);
  const diff = describeSetupDiff(validation.setup_diff ?? []);
  const pending = brief.status === "pending";
  const needsRun = requiresOnScreenRun(action);
  const runElsewhere = needsRun !== null && needsRun !== props.onScreenRunId;
  const approvable = pending && validation.ok && action !== null && !props.busy;
  const modelKey = overlayModelKey(brief);
  const paidModel = modelKey !== null && !modelKey.startsWith("fake");
  const effect = brief.effect;

  return (
    <section className={`assistant-brief assistant-brief-${brief.status}`} aria-label={`Proposal: ${brief.title}`}>
      <header className="assistant-brief-head">
        <span className="assistant-brief-kicker">Proposal</span>
        <h4 className="assistant-brief-title">{brief.title}</h4>
        <span className={`assistant-badge assistant-badge-${brief.status}`}>{STATUS_LABEL[brief.status]}</span>
      </header>

      <div className="assistant-brief-section assistant-brief-primary">
        <div className="assistant-brief-label">What will happen</div>
        <ul className="assistant-brief-lines">
          {lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
        {modelKey ? (
          <div className="assistant-brief-model">
            Agent model <code>{modelKey}</code>
            {paidModel ? <span className="assistant-badge assistant-badge-warn">live: costs money when played</span> : <span className="assistant-badge">fake: free</span>}
          </div>
        ) : null}
        {diff.length > 0 ? (
          <details className="assistant-brief-diff" open={diff.length <= 8}>
            <summary>
              {diff.length} setting{diff.length === 1 ? "" : "s"} differ from the defaults
            </summary>
            <ul className="assistant-brief-lines assistant-brief-difflist">
              {diff.map((line, i) => (
                <li key={i}>
                  <code>{line}</code>
                </li>
              ))}
            </ul>
          </details>
        ) : action?.type === "create_run" ? (
          <div className="hint">Every other setting stays at its default.</div>
        ) : null}
        {validation.warnings.length > 0 ? (
          <ul className="assistant-brief-warnings">
            {validation.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        ) : null}
        {validation.problems.length > 0 ? (
          <div className="assistant-brief-problems" role="alert">
            <strong>Cannot be executed as proposed:</strong>
            <ul>
              {validation.problems.map((p, i) => (
                <li key={i}>
                  {p.path ? <code>{p.path}</code> : null}
                  {p.path ? ": " : ""}
                  {p.message}
                </li>
              ))}
            </ul>
            <div className="hint">Use "Ask for changes" to say what to fix.</div>
          </div>
        ) : null}
        {validation.validated_against_turn_id ? <div className="hint">Checked against turn {validation.validated_against_turn_id}; it is checked again when you approve.</div> : null}
      </div>

      {brief.summary || brief.steps.length > 0 || brief.warnings.length > 0 ? (
        <div className="assistant-brief-section assistant-brief-prose">
          <div className="assistant-brief-label">Assistant's description</div>
          {brief.summary ? <AnswerBlocks text={brief.summary} onAction={props.onAction} /> : null}
          {brief.steps.length > 0 ? (
            <ol className="assistant-brief-steps">
              {brief.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          ) : null}
          {brief.warnings.length > 0 ? (
            <ul className="assistant-brief-warnings">
              {brief.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {brief.in_reply_to ? (
        <div className="assistant-brief-reply hint">
          Proposed in reply to: <q>{brief.in_reply_to}</q>
        </div>
      ) : null}

      {props.awaitingChanges && pending ? <div className="assistant-brief-waiting">Waiting for your changes: describe them in the composer and send.</div> : null}

      {pending || brief.status === "executing" ? (
        <div className="assistant-brief-actions">
          {runElsewhere && needsRun ? (
            <button type="button" className="btn btn-primary btn-small" disabled={props.busy} onClick={() => props.onOpenRun(needsRun)}>
              Open {props.describe.runNames?.[needsRun] ?? needsRun} and run this
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-small" disabled={!approvable} title={validation.ok ? undefined : "Fix the problems first (ask for changes)"} onClick={() => props.onApprove(brief)}>
              {brief.status === "executing" ? "Executing…" : approveLabel(action)}
            </button>
          )}
          {action?.type === "create_run" ? (
            <button type="button" className="btn btn-small" disabled={props.busy} title="Prefill the New session form with this setup and review it there" onClick={() => props.onOpenInSetup(brief)}>
              Open in setup form instead
            </button>
          ) : null}
          <button type="button" className="btn btn-small" disabled={props.busy || !pending} onClick={() => props.onAskChanges(brief)}>
            Ask for changes
          </button>
          <button type="button" className="btn btn-small btn-danger" disabled={props.busy || !pending} onClick={() => props.onCancel(brief)}>
            Cancel
          </button>
        </div>
      ) : null}

      {props.error ? (
        <div className="error-line" role="alert">
          {props.error}
        </div>
      ) : null}
      {brief.error && brief.status === "failed" ? (
        <div className="error-line" role="alert">
          <strong>Failed:</strong> {brief.error}
        </div>
      ) : null}
      {brief.status === "rejected" && brief.reject_reason ? <div className="hint">Reason: {brief.reject_reason}</div> : null}

      {brief.status === "executed" && effect ? (
        <div className="assistant-brief-result">
          <strong>Done.</strong> {effect.message}
          {effect.rounds_requested ? ` Rounds: ${effect.rounds_done ?? 0}/${effect.rounds_requested}.` : ""}
          <div className="assistant-brief-actions">
            {effect.run_id && action?.type !== "run_command" ? (
              <button type="button" className="btn btn-small" onClick={() => props.onOpenRun(effect.run_id ?? "")}>
                Open run {effect.run_summary?.name ?? effect.run_id}
              </button>
            ) : null}
            {effect.staged_ids.length > 0 && effect.run_id ? (
              <button type="button" className="btn btn-small" onClick={() => props.onOpenGodMode(effect.run_id ?? "")}>
                Open God mode ({effect.staged_ids.length} staged)
              </button>
            ) : null}
            {effect.status ? (
              <span className="hint">
                Run state now: {effect.status.state}, saved turn {effect.status.current_turn_id}
                {effect.status.real_usage ? ` · agents' spend ${formatUsd(effect.status.real_usage.provider_cost_usd)}` : ""}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
