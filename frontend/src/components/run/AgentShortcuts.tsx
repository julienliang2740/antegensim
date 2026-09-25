/**
 * Links from a selected agent to its most recent model decision up to the
 * viewed turn (spec U2: decision packets and model records must be easy to
 * reach; "Load historical details on demand").  The packet id of a turn is
 * pk_{turn_id} (INTERFACES section 3).
 */

import type { TurnIndexEntry } from "../../api/types";
import type { RecordTarget } from "../../state/records";
import { latestModelTurn } from "../../state/timeline";

export interface AgentShortcutsProps {
  agentId: string;
  agentLabel: string;
  turns: TurnIndexEntry[];
  /** The turn shown now (live or history); only turns up to it are considered. */
  shownTurnId: string;
  onOpen(target: RecordTarget): void;
  onViewTurn(turnId: string): void;
}

export function AgentShortcuts(props: AgentShortcutsProps) {
  const latest = latestModelTurn(props.turns, props.agentId, props.shownTurnId);
  return (
    <div className="agent-shortcuts">
      <span className="panel-title">Latest decision of {props.agentLabel}</span>
      {latest ? (
        <>
          <span className="hint">
            turn <code>{latest.turn_id}</code>
            {latest.action_name ? ` · ${latest.action_name} ${latest.ok === false ? "failed" : "ok"}` : " · no action"}
          </span>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => props.onOpen({ kind: "packet", turnId: latest.turn_id, packetId: `pk_${latest.turn_id}` })}
          >
            Open its latest decision packet
          </button>
          {latest.turn_id !== props.shownTurnId ? (
            <button type="button" className="btn btn-small" onClick={() => props.onViewTurn(latest.turn_id)}>
              View that turn
            </button>
          ) : null}
        </>
      ) : (
        <span className="hint">No model decision by {props.agentId} up to the viewed turn.</span>
      )}
    </div>
  );
}
