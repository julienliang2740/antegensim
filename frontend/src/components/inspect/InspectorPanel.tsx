/**
 * InspectorPanel: a compact summary of the selected entity for the viewed
 * turn in the Inspector tab (spec U1/U2; "Display and historical
 * inspection": selection preserved across history with before-birth /
 * after-death indicators, optional agent-view overlay).  The full record
 * (stats, decisions, skills, knowledge, messages, plant growth and rules,
 * history) is in the entity profile card (components/profile), opened with
 * the Profile button.  See InspectorPanelProps.
 */

import "../../inspect.css";
import { KindTag } from "./common";
import { entityOneLine, entityTitle, fmtPoint, isDead, kindLabel } from "./format";
import { presenceInTurn } from "./logic";
import type { InspectorPanelProps } from "./props";

export function InspectorPanel(props: InspectorPanelProps) {
  const { turn } = props;
  if (!props.entity) {
    return (
      <div className="insp insp-inspector">
        <div className="insp-panel-title">Inspector</div>
        <p className="insp-muted">Select an entity on the map (click a dot) or in the occupant list to open its profile card.</p>
      </div>
    );
  }

  const presence = presenceInTurn(props.entity, turn);
  // Prefer the viewed turn's record of this id; otherwise show the last known data, greyed.
  const entity = presence.inTurn ?? props.entity;
  const dead = isDead(entity);
  const last =
    entity.kind === "agent" && entity.last_action
      ? `last action: ${entity.last_action.name}${entity.last_result ? (entity.last_result.ok ? " ok" : ` ${entity.last_result.reason}`) : ""}`
      : null;

  return (
    <div className="insp insp-inspector">
      <div className="insp-inspector-head">
        <div className="insp-panel-title">
          <KindTag kind={entity.kind} dead={dead} /> {capitalize(kindLabel(entity.kind))} {entityTitle(entity)}
          <span className="insp-muted"> at {fmtPoint(entity.position)}</span>
          {dead ? <span className="insp-badge insp-badge-bad">dead</span> : null}
        </div>
        <button type="button" className="btn btn-small btn-primary" title="Open the profile card: stats, decisions, skills, knowledge and more" onClick={props.onOpenProfile}>
          Profile
        </button>
        {entity.kind === "agent" ? (
          <label className={`insp-toggle${props.agentView ? " insp-toggle-on" : ""}`} title="Show only what the agent knows">
            <input type="checkbox" checked={props.agentView} onChange={props.onToggleAgentView} /> Agent view {props.agentView ? "ON" : "off"}
          </label>
        ) : null}
      </div>
      <div className="insp-hint">
        {turn ? (
          <>
            Viewing turn <code>{turn.turn.turn_id}</code> (round {turn.turn.round}) — {turn.live ? "live" : "history"}
          </>
        ) : (
          "No turn loaded"
        )}
      </div>
      {presence.message ? (
        <div className={`insp-banner ${presence.status === "dead" ? "insp-banner-dead" : "insp-banner-warn"}`}>
          <strong>{presence.label}:</strong> {presence.message}
        </div>
      ) : null}
      <p className={`insp-summary-line${presence.inTurn === null ? " insp-stale" : ""}`}>
        {entityOneLine(entity, turn?.rules ?? props.rules)}
        {last ? ` · ${last}` : ""}
      </p>
    </div>
  );
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
