/**
 * OccupantList: every entity at the selected point, grouped by kind, each row
 * individually selectable (spec U1; "Display and historical inspection": a
 * point click opens a scrollable list of every occupant and colocated
 * entities stay individually selectable).  The list grows to about a dozen
 * rows before it scrolls, and then shows a visible scroll cue ("N occupants —
 * scroll for more" over a bottom fade) so nothing is hidden below the fold
 * unnoticed.  In agent view (`agentViewOverlay`) it lists only what the
 * selected agent has observed at the point, as last seen.  See OccupantListProps.
 */

import "../../inspect.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Entity } from "../../api/types";
import { KindTag } from "./common";
import { entityOneLine, fmtPoint, isDead, kindLabel } from "./format";
import { markersAtPoint, overlayMarkers } from "./logic";
import type { MapMarker } from "./logic";
import type { OccupantListProps } from "./props";

interface Group {
  key: string;
  title: string;
  members: Entity[];
}

/** Living agents, dead agents, plants, fruit, residue, seeds (empty groups omitted). */
function groupOccupants(occupants: Entity[]): Group[] {
  const groups: Group[] = [
    { key: "agents", title: "Agents (living)", members: occupants.filter((e) => e.kind === "agent" && !isDead(e)) },
    { key: "dead", title: "Agents (dead)", members: occupants.filter((e) => e.kind === "agent" && isDead(e)) },
    { key: "plants", title: "Plants", members: occupants.filter((e) => e.kind === "plant") },
    { key: "fruit", title: "Fruit", members: occupants.filter((e) => e.kind === "fruit") },
    { key: "residue", title: "Residue", members: occupants.filter((e) => e.kind === "residue") },
    { key: "seeds", title: "Seeds", members: occupants.filter((e) => e.kind === "seed") },
  ];
  return groups.filter((g) => g.members.length > 0);
}

/**
 * Scroll box with a cue while more rows sit below the fold.  Measures overflow
 * on layout and scroll (ResizeObserver for content changes).
 */
function ScrollBox(props: { rowCount: number; rowWord: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [cue, setCue] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const overflow = el.scrollHeight - el.clientHeight > 2;
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    setCue(overflow && !atEnd);
  }, []);
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [measure, props.children]);
  return (
    <div className="insp-occupants-scrollwrap">
      <div className="insp-occupants-scroll" ref={ref} onScroll={measure}>
        {props.children}
      </div>
      {cue ? (
        <div className="insp-scroll-cue" aria-hidden="true">
          {props.rowCount} {props.rowWord} — scroll for more ▾
        </div>
      ) : null}
    </div>
  );
}

export function OccupantList(props: OccupantListProps) {
  const { point, occupants, selectedEntityId, onSelectEntity } = props;
  const overlay = props.agentViewOverlay ?? null;
  if (!point) {
    return (
      <div className="insp insp-occupants">
        <div className="insp-panel-title">Occupants</div>
        <p className="insp-muted">Click a map cell to list who and what is there.</p>
      </div>
    );
  }
  if (overlay) {
    const known: MapMarker[] = markersAtPoint(overlayMarkers(overlay), point);
    return (
      <div className="insp insp-occupants insp-occupants-agentview">
        <div className="insp-panel-title">
          Known at {fmtPoint(point)}
          {props.terrain ? <span className="insp-muted"> · {props.terrain}</span> : null}
          <span className="insp-count"> {known.length} {known.length === 1 ? "entity" : "entities"}</span>
        </div>
        <div className="insp-banner insp-banner-agentview">
          <strong>agent view: only what this agent has observed.</strong> {overlay.agentName} ({overlay.agentId}) knows of these entities at this point, each as
          of the round it last saw them; true positions and values are hidden.
        </div>
        {known.length === 0 ? (
          <p className="insp-muted">
            Nothing that {overlay.agentId} knows of at this point (never observed, or empty when it looked).
          </p>
        ) : null}
        <ScrollBox rowCount={known.length} rowWord="known entities">
          <div className="insp-occupant-group">
            <ul>
              {known.map((m) => {
                const selected = m.id === selectedEntityId;
                const label = `${m.id} ${m.self ? overlay.agentName : m.kind}${m.dead ? " (dead when seen)" : ""}`;
                const statsId = `occupant-stats-${m.id}`;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      className={`insp-occupant-row insp-agentview-row${selected ? " insp-selected" : ""}${m.dead ? " insp-dead" : ""}`}
                      aria-pressed={selected}
                      aria-label={label}
                      aria-describedby={statsId}
                      onClick={() => onSelectEntity(m.id)}
                    >
                      <KindTag kind={m.kind} dead={m.dead} />
                      <span className="insp-occupant-id">{m.id}</span>
                      <span className="insp-occupant-name">
                        {m.self ? `${overlay.agentName} (you)` : kindLabel(m.kind)}
                        {m.dead ? " (dead when seen)" : ""}
                      </span>
                      <span className="insp-occupant-stats" id={statsId}>
                        {m.line}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </ScrollBox>
      </div>
    );
  }
  const groups = groupOccupants(occupants);
  return (
    <div className="insp insp-occupants">
      <div className="insp-panel-title">
        Occupants at {fmtPoint(point)}
        {props.terrain ? <span className="insp-muted"> · {props.terrain}</span> : null}
        <span className="insp-count"> {occupants.length} {occupants.length === 1 ? "entity" : "entities"}</span>
      </div>
      {props.agentView ? (
        <div className="insp-banner insp-banner-warn">
          Agent view is on, but no agent is selected (or its knowledge is still loading), so this list is omniscient: every entity with true values. Select an
          agent to see only what it has observed.
        </div>
      ) : null}
      {occupants.length === 0 ? <p className="insp-muted">Nobody and nothing at this point.</p> : null}
      <ScrollBox rowCount={occupants.length} rowWord="occupants">
        {groups.map((group) => (
          <div key={group.key} className="insp-occupant-group">
            <div className="insp-occupant-group-title">
              {group.title} ({group.members.length})
            </div>
            <ul>
              {group.members.map((e) => {
                const selected = e.id === selectedEntityId;
                const dead = isDead(e);
                const label = `${e.id} ${e.kind === "agent" ? e.name : e.kind === "plant" || e.kind === "seed" ? e.species : e.kind}${dead ? " (dead)" : ""}`;
                const statsId = `occupant-stats-${e.id}`;
                return (
                  <li key={e.id}>
                    {/* Short accessible name (id and name); the stats line is its description. */}
                    <button
                      type="button"
                      className={`insp-occupant-row${selected ? " insp-selected" : ""}${dead ? " insp-dead" : ""}`}
                      aria-pressed={selected}
                      aria-label={label}
                      aria-describedby={statsId}
                      onClick={() => onSelectEntity(e.id)}
                    >
                      <KindTag kind={e.kind} dead={dead} />
                      <span className="insp-occupant-id">{e.id}</span>
                      <span className="insp-occupant-name">
                        {e.kind === "agent" ? e.name : e.kind === "plant" || e.kind === "seed" ? e.species : e.kind}
                        {dead ? " (dead)" : ""}
                      </span>
                      <span className="insp-occupant-stats" id={statsId}>
                        {entityOneLine(e, props.rules)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </ScrollBox>
    </div>
  );
}
