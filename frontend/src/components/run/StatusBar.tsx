/**
 * Run status (spec "Sessions and run controls": current round, turn, acting
 * agent and status, including waiting for a model response or an error;
 * INTERFACES section 3 status machine and "Recover (pause)" in error).
 *
 * Layout rules (usability review):
 * - The run controls sit ABOVE this bar, so nothing here can move them.
 * - The model-call line has a fixed-height slot that is always present
 *   ("No model call in progress" when idle), so the page below does not jump
 *   every turn during Play.  It shows whenever a call is pending, including
 *   in "Pause requested".
 * - In the error state the failed turn explains itself: its id and agent, the
 *   model, the attempts and the provider's own error text (taken from the
 *   uncommitted events of the failed attempt, INTERFACES section 8).
 */

import type { RunStatus } from "../../api/types";
import type { FailedTurnInfo } from "../../state/feed";
import type { AgentNamer } from "../../state/statusText";
import { actingAgentLabel, nextStepText, secondsSince, stateSentence, stateWord } from "../../state/statusText";

export interface StatusBarProps {
  status: RunStatus;
  name: AgentNamer;
  realBudgetUsd: number | null;
  now: number;
  recoverEnabled: boolean;
  /** The failed attempt as the feed records it (null when the feed has no `error` event after the last saved turn). */
  failedTurn: FailedTurnInfo | null;
  /** True when every assigned model is a fake model (null while unknown). */
  allFake: boolean | null;
  onRecover(): void;
  onViewPending(): void;
}

const ACTIVE_STATES = ["running", "turn_active", "waiting_model"];

function turnText(status: RunStatus): string {
  const active = status.active_turn_id !== null;
  if (status.turn_index !== null) return `${status.turn_index}${active ? " (in progress)" : ""}`;
  if (status.current_turn_id.endsWith("_init") && !active) return "initial state";
  return active ? "round end (in progress)" : "round end";
}

function Fact(props: { label: string; value: string; code?: boolean; wide?: boolean; row?: boolean; wrap?: boolean }) {
  return (
    <div className={`status-fact${props.wide ? " status-fact-wide" : ""}${props.row ? " status-fact-row" : ""}${props.wrap ? " status-fact-wrap" : ""}`}>
      <dt>{props.label}</dt>
      <dd title={props.value}>{props.code ? <code>{props.value}</code> : props.value}</dd>
    </div>
  );
}

export function StatusBar(props: StatusBarProps) {
  const { status, name, failedTurn } = props;
  const usage = status.real_usage;
  const call = status.pending_model_call;
  const active = ACTIVE_STATES.includes(status.state);
  const usageLabel = props.allFake ? "Model usage (fake: free)" : "Real model usage";
  const usageText =
    `${usage.calls} calls${usage.interrupted_calls ? ` (${usage.interrupted_calls} interrupted)` : ""} · ` +
    `${usage.input_tokens.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out tokens${props.allFake ? " (estimated)" : ""} · $${usage.provider_cost_usd.toFixed(4)}` +
    (props.realBudgetUsd !== null ? ` of $${props.realBudgetUsd} budget` : props.allFake ? "" : " (no budget limit)");

  return (
    <section className={`status-bar status-${status.state}`} aria-label="Run status">
      <div className="status-headline">
        <span className={`state-badge state-${status.state}`}>{stateWord(status.state)}</span>
        <span className={`status-sentence${active ? " status-sentence-oneline" : ""}`} title={stateSentence(status, name)}>
          {stateSentence(status, name)}
        </span>
      </div>
      <dl className="status-facts">
        <Fact label="Round" value={String(status.round)} />
        <Fact label="Turn" value={turnText(status)} />
        <Fact label={actingAgentLabel(status)} value={status.acting_agent_id ? name(status.acting_agent_id) : "none"} />
        {/* Its own row, wrapping: at a round boundary it lists every agent of the predicted order. */}
        <Fact label="Next step" value={nextStepText(status, name)} wide row wrap />
        <Fact label="Last saved turn" value={status.current_turn_id} code />
        <Fact label="Living agents" value={String(status.living_agent_count)} />
        <Fact label="Staged edits" value={String(status.staged_intervention_count)} />
        {/* Always its own full-width row, so the bar never grows by a line when the usage text lengthens during Play. */}
        <Fact label={usageLabel} value={usageText} wide row />
      </dl>
      <div className={`status-slot${call ? " status-waiting" : ""}`}>
        {call ? (
          <>
            <span className="status-slot-text">
              Waiting for model: <strong>{name(call.agent_id)}</strong> asked <code>{call.model_key}</code> (call <code>{call.call_id}</code>) —{" "}
              {secondsSince(call.started_at, props.now).toFixed(1)} s so far.
            </span>
            <button type="button" className="btn btn-small" onClick={props.onViewPending}>
              View request in progress
            </button>
          </>
        ) : (
          <span className="status-slot-text status-idle">No model call in progress.</span>
        )}
      </div>
      {status.state === "error" ? (
        <div className="status-error" role="alert">
          <FailedTurnText status={status} failedTurn={failedTurn} name={name} />
          <div className="status-error-actions">
            <button type="button" className="btn btn-danger" disabled={!props.recoverEnabled} onClick={props.onRecover}>
              Recover (pause)
            </button>
            <span className="hint">
              Discards the failed attempt and reloads the last saved turn <code>{status.current_turn_id}</code>; the next Run turn or Play re-runs{" "}
              {failedTurn ? <code>{failedTurn.turnId}</code> : "the same turn"}.
            </span>
          </div>
        </div>
      ) : status.last_error ? (
        <div className="status-recovered">
          <strong>Previous error (recovered; clears at the next saved turn):</strong> {status.last_error}
          {failedTurn ? (
            <>
              {" "}
              — failed turn <code>{failedTurn.turnId}</code>
              {failedTurn.callError ? `: ${failedTurn.callError}` : ""}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function FailedTurnText(props: { status: RunStatus; failedTurn: FailedTurnInfo | null; name: AgentNamer }) {
  const { status, failedTurn: f, name } = props;
  if (!f) {
    return (
      <div>
        <strong>Run error:</strong> {status.last_error ?? "unknown"}
        <div className="hint">The failed attempt's events are not in the live log window; they are carried into the re-run of the turn.</div>
      </div>
    );
  }
  const call = [f.modelKey ? `model ${f.modelKey}` : null, f.callId ? `call ${f.callId}` : null, f.attempts !== null ? `${f.attempts} attempt${f.attempts === 1 ? "" : "s"}` : null]
    .filter(Boolean)
    .join(", ");
  return (
    <div className="failed-turn">
      <div>
        <strong>Failed turn:</strong> <code>{f.turnId}</code>
        {f.agentId ? ` · ${name(f.agentId)}` : ""}
        {call ? ` — ${call}` : ""}
      </div>
      {f.callError ? (
        <div>
          <strong>Cause:</strong> {f.callError}
          {f.infra ? (
            <>
              {" "}
              (infrastructure failure: no world compute was charged and no memory was marked read
              {f.providerCostUsd ? (
                <>
                  ; the provider still billed <strong>${f.providerCostUsd.toFixed(4)}</strong> for this attempt, included in Real model usage
                </>
              ) : (
                "; the provider reported no cost for this attempt"
              )}
              )
            </>
          ) : null}
        </div>
      ) : null}
      <div>
        <strong>Run error:</strong> {status.last_error ?? f.message ?? "unknown"}
      </div>
    </div>
  );
}
