/**
 * Always-visible lists of the viewed turn's entities (spec U2 "agent stuff
 * must be very easy to see"; U14 clarity): an agent roster with the main
 * balances and one button per agent, and a compact index of plants, fruit,
 * seeds and residue.  Clicking selects the entity and its point.
 */

import type { Agent, Entity } from "../../api/types";
import { fmtNum } from "../inspect";

/** Same display rounding as the occupant list, hover card and inspector (never rounds 197.96 up to "198.0"). */
const fmt = fmtNum;

export function AgentRoster(props: { agents: Agent[]; selectedId: string | null; actingId: string | null; onSelect(id: string): void; compact?: boolean }) {
  if (props.compact) return <CompactRoster {...props} />;
  return (
    <div className="roster">
      <div className="panel-title">
        Agents ({props.agents.filter((a) => a.alive).length} living of {props.agents.length})
      </div>
      {props.agents.length === 0 ? <p className="hint">No agents.</p> : null}
      <div className="roster-list">
        {props.agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={`roster-row${agent.id === props.selectedId ? " is-selected" : ""}${agent.alive ? "" : " is-dead"}${agent.id === props.actingId ? " is-acting" : ""}`}
            aria-pressed={agent.id === props.selectedId}
            onClick={() => props.onSelect(agent.id)}
          >
            <span className="roster-name">
              {agent.id} {agent.name}
              {agent.alive ? "" : " (dead)"}
              {agent.id === props.actingId ? " · acting" : ""}
            </span>
            <span className="roster-stats">
              ({agent.position.x}, {agent.position.y}) · health {fmt(agent.stats.health)}/{fmt(agent.stats.max_health)} · compute {fmt(agent.stats.compute)} ·
              essence {fmt(agent.stats.essence)}
              {agent.last_action
                ? ` · last: ${agent.last_action.name}${agent.last_result ? (agent.last_result.ok ? " ok" : ` ${agent.last_result.reason}`) : ""}`
                : ""}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The roster for the run page's left rail: one short row per agent (a dot in
 * the map's agent colour, id and name, health / compute / essence); the full
 * stats and last action are in the row's tooltip and the inspector.
 */
function CompactRoster(props: { agents: Agent[]; selectedId: string | null; actingId: string | null; onSelect(id: string): void }) {
  return (
    <section className="roster roster-compact" aria-label="Agents">
      <div className="rail-label">
        Agents ({props.agents.filter((a) => a.alive).length} living of {props.agents.length})
      </div>
      {props.agents.length === 0 ? <p className="hint">No agents.</p> : null}
      <div className="roster-list">
        {props.agents.map((agent) => {
          const last = agent.last_action
            ? `last: ${agent.last_action.name}${agent.last_result ? (agent.last_result.ok ? " ok" : ` ${agent.last_result.reason}`) : ""}`
            : "no action yet";
          const title =
            `${agent.id} ${agent.name}${agent.alive ? "" : " (dead)"} at (${agent.position.x}, ${agent.position.y}) · health ${fmt(agent.stats.health)}/${fmt(agent.stats.max_health)} · ` +
            `compute ${fmt(agent.stats.compute)} · essence ${fmt(agent.stats.essence)} · ${last}`;
          return (
            <button
              key={agent.id}
              type="button"
              className={`roster-row${agent.id === props.selectedId ? " is-selected" : ""}${agent.alive ? "" : " is-dead"}${agent.id === props.actingId ? " is-acting" : ""}`}
              aria-pressed={agent.id === props.selectedId}
              title={title}
              onClick={() => props.onSelect(agent.id)}
            >
              <span className={`roster-dot${agent.alive ? "" : " roster-dot-dead"}`} aria-hidden="true" />
              <span className="roster-name">
                {agent.id} {agent.name}
                {agent.alive ? "" : " (dead)"}
                {agent.id === props.actingId ? <span className="roster-acting"> acting</span> : null}
              </span>
              <span className="roster-mini">
                {agent.alive ? (
                  <>
                    H {fmt(agent.stats.health)}/{fmt(agent.stats.max_health)} · C {fmt(agent.stats.compute)} · E {fmt(agent.stats.essence)}
                  </>
                ) : (
                  <>died round {agent.died_round ?? "?"}</>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

const KIND_TITLES: [Entity["kind"], string][] = [
  ["plant", "Plants"],
  ["fruit", "Fruit"],
  ["seed", "Seeds"],
  ["residue", "Residue"],
];

export function EntityIndex(props: { entities: Entity[]; selectedId: string | null; onSelect(id: string): void }) {
  return (
    <div className="entity-index">
      <div className="panel-title">Other entities</div>
      <div className="entity-index-scroll">
        {KIND_TITLES.map(([kind, title]) => {
          const members = props.entities.filter((e) => e.kind === kind);
          if (members.length === 0) return null;
          return (
            <div key={kind} className="entity-group">
              <div className="entity-group-title">
                {title} ({members.length})
              </div>
              <div className="entity-chips">
                {members.map((e) => {
                  const dead = e.kind === "plant" && !e.alive;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      className={`chip${e.id === props.selectedId ? " is-selected" : ""}${dead ? " is-dead" : ""}`}
                      aria-pressed={e.id === props.selectedId}
                      onClick={() => props.onSelect(e.id)}
                    >
                      {e.id}
                      {e.kind === "plant" || e.kind === "seed" ? ` ${e.species}` : ""} ({e.position.x}, {e.position.y}){dead ? " dead" : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
