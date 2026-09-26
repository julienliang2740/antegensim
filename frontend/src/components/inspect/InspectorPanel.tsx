/**
 * InspectorPanel: detailed view of the selected entity for the viewed turn
 * (spec U1/U2; "Display and historical inspection": selection preserved across
 * history with before-birth/after-death indicators, optional agent-view
 * overlay).  Dispatches to the agent / plant / fruit / seed / residue
 * inspectors.  See InspectorPanelProps.
 */

import "../../inspect.css";
import { AgentInspector } from "./AgentInspector";
import { KindTag } from "./common";
import { FruitInspector, PlantInspector, ResidueInspector, SeedInspector } from "./EntityInspectors";
import { entityTitle, fmtPoint, isDead, kindLabel } from "./format";
import { presenceInTurn } from "./logic";
import type { InspectorPanelProps } from "./props";

export function InspectorPanel(props: InspectorPanelProps) {
  const { turn } = props;
  if (!props.entity) {
    return (
      <div className="insp insp-inspector">
        <div className="insp-panel-title">Inspector</div>
        <p className="insp-muted">Select an entity on the map (click a cell) or in the occupant list.</p>
      </div>
    );
  }

  const presence = presenceInTurn(props.entity, turn);
  // Prefer the viewed turn's record of this id; otherwise show the last known data, greyed.
  const entity = presence.inTurn ?? props.entity;
  const stale = presence.inTurn === null;
  const dead = isDead(entity);

  return (
    <div className="insp insp-inspector">
      <div className="insp-inspector-head">
        <div className="insp-panel-title">
          <KindTag kind={entity.kind} dead={dead} /> {capitalize(kindLabel(entity.kind))} {entityTitle(entity)}
          <span className="insp-muted"> at {fmtPoint(entity.position)}</span>
          {dead ? <span className="insp-badge insp-badge-bad">dead</span> : null}
        </div>
        {props.onAsk ? (
          <button
            type="button"
            className="btn btn-small assistant-ask-btn"
            title="Open the assistant with this question prefilled"
            onClick={() => props.onAsk?.(`What is ${entity.kind === "agent" ? `${entity.name} (${entity.id})` : entity.id} up to?`)}
          >
            Ask: What is {entity.kind === "agent" ? entity.name : entity.id} up to?
          </button>
        ) : null}
        <label className={`insp-toggle${props.agentView ? " insp-toggle-on" : ""}`} title="Show only what the agent knows">
          <input type="checkbox" checked={props.agentView} onChange={props.onToggleAgentView} /> Agent view {props.agentView ? "ON" : "off"}
        </label>
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

      <div className={stale ? "insp-stale" : undefined}>
        {entity.kind === "agent" ? (
          <AgentInspector
            agent={entity}
            turn={turn}
            knowledge={props.knowledge}
            settings={props.settings}
            rules={props.rules}
            agentView={props.agentView}
            onOpenModelCall={props.onOpenModelCall}
            onOpenPacket={props.onOpenPacket}
          />
        ) : props.agentView ? (
          <div className="insp-banner insp-banner-agentview">
            Agent view is on: it shows only what one agent knows. Select an agent, or turn agent view off to inspect this {kindLabel(entity.kind)}.
          </div>
        ) : entity.kind === "plant" ? (
          <PlantInspector plant={entity} turn={turn} rules={props.rules} />
        ) : entity.kind === "fruit" ? (
          <FruitInspector fruit={entity} turn={turn} rules={props.rules} />
        ) : entity.kind === "seed" ? (
          <SeedInspector seed={entity} turn={turn} />
        ) : (
          <ResidueInspector residue={entity} turn={turn} rules={props.rules} />
        )}
      </div>
    </div>
  );
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
