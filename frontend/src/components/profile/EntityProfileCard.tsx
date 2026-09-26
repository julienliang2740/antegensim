/**
 * Entity profile card: a dialog over the run page (the board stays visible,
 * dimmed, behind it) that shows one entity of the viewed turn.  A side list
 * of sections (only the ones the kind has: state/profile.profileSections)
 * picks what the scrolling content area shows; below 900 px the list becomes
 * a row of tabs and the card fills the window.
 *
 * Header: kind tag, name and id, a life badge (alive / dead / removed /
 * before birth / absent), position, "as of turn …", Agent view (agents),
 * Ask, Open in Inspector and ×.  Escape (unless a record is open over the
 * map: the card is hidden then) or the backdrop closes it; RunPage returns
 * focus to what opened it.  The card never changes the viewed turn or the
 * play state by itself; "View turn" rows do, on request.
 *
 * DOCS: opened by clicking an entity (map dot, map tooltip row, occupant
 * row, roster row, "Other entities" chip, assistant entity link, Profile
 * button in the Inspector); sections Overview, Decisions, Skills,
 * Knowledge, Messages, History (agents), Overview, Growth, Rules, History
 * (plants), Overview, History (fruit, seeds, residue).
 */

import "../../profile.css";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentKnowledgeView, EffectiveSettingsView, Entity, Intervention, RulesConfig, TurnIndexEntry, TurnView } from "../../api/types";
import { navTarget, profileSections, sectionFor, terrainAt } from "../../state/profile";
import type { ProfileSectionId } from "../../state/profile";
import type { RecordTarget } from "../../state/records";
import type { AgentNamer } from "../../state/statusText";
import { AskButton } from "../assistant/AskButton";
import { KindTag } from "../inspect/common";
import { fmtPoint, isDead, kindLabel } from "../inspect/format";
import { presenceInTurn } from "../inspect/logic";
import { AgentDecisions, AgentKnowledge, AgentMessages, AgentOverview, AgentSkills } from "./AgentSections";
import { FruitOverview, HistorySection, ResidueOverview, SeedOverview } from "./EntitySections";
import { PlantGrowth, PlantOverview, PlantRules } from "./PlantSections";

export interface EntityProfileCardProps {
  runId: string;
  /** The selected entity (the viewed turn's record, else the last one seen). */
  entity: Entity;
  /** The viewed turn (live or history). */
  turn: TurnView;
  /** The run's turn index (Decisions and Messages). */
  turns: TurnIndexEntry[];
  /** The agent's knowledge view of the viewed turn (agents only; null while loading). */
  knowledge: AgentKnowledgeView | null;
  knowledgeError: string | null;
  settings: EffectiveSettingsView | null;
  /** The live run's rules (the species rule change form); null until loaded. */
  liveRules: RulesConfig | null;
  agentView: boolean;
  onToggleAgentView(): void;
  name: AgentNamer;
  /** Hidden (kept mounted) while a record is open over the map. */
  hidden: boolean;
  /** Width kept free on the right for the docked assistant drawer. */
  rightInset: number;
  onClose(): void;
  onOpenInInspector(): void;
  onSelectEntity(id: string): void;
  onViewTurn(turnId: string): void;
  onOpen(target: RecordTarget): void;
  onStage(intervention: Intervention): Promise<void>;
}

export function EntityProfileCard(props: EntityProfileCardProps) {
  const { turn, onClose } = props;
  const presence = presenceInTurn(props.entity, turn);
  // Prefer the viewed turn's record of this id; otherwise show the last known data, greyed.
  const entity = presence.inTurn ?? props.entity;
  const stale = presence.inTurn === null;
  const removed = turn.entities.removed[entity.id] ?? null;
  const sections = profileSections(entity.kind);
  const [wanted, setWanted] = useState<ProfileSectionId>("overview");
  const section = sectionFor(entity.kind, wanted);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Focus the card when it opens (the opener gets it back from RunPage on close).
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  // Escape closes the card, and only the card (the map tooltip and the record viewer listen on window).
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (props.hidden) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.hidden]);

  // A new section starts at its top.
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [section]);

  const onNavKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = navTarget(event.key, index, sections.length);
    if (target === null) return;
    event.preventDefault();
    setWanted(sections[target].id);
    tabRefs.current[target]?.focus();
  };

  const dead = isDead(entity);
  const life =
    presence.status === "removed"
      ? { text: "removed", cls: "profile-badge-bad" }
      : dead
        ? { text: "dead", cls: "profile-badge-bad" }
        : presence.status === "before_birth"
          ? { text: "before birth", cls: "profile-badge-warn" }
          : presence.status === "absent"
            ? { text: "absent", cls: "profile-badge-warn" }
            : { text: entity.kind === "agent" || entity.kind === "plant" ? "alive" : "present", cls: "profile-badge-good" };
  const title = entity.kind === "agent" ? entity.name : `${capitalize(kindLabel(entity.kind))} ${entity.id}`;
  const askName = entity.kind === "agent" ? entity.name : entity.id;
  const askQuestion = `What is ${entity.kind === "agent" ? `${entity.name} (${entity.id})` : entity.id} up to?`;
  const terrain = terrainAt(turn, entity.position);
  const turnListProps = {
    runId: props.runId,
    turns: props.turns,
    shownTurnId: turn.turn.turn_id,
    name: props.name,
    onViewTurn: props.onViewTurn,
    onOpen: props.onOpen,
  };

  let body: ReactNode = null;
  if (section === "history") {
    body = <HistorySection entity={entity} turn={turn} presence={presence} removed={removed} onSelect={props.onSelectEntity} />;
  } else if (entity.kind === "agent") {
    if (section === "overview")
      body = (
        <AgentOverview
          agent={entity}
          turn={turn}
          knowledge={props.knowledge}
          knowledgeError={props.knowledgeError}
          settings={props.settings}
          rules={props.liveRules}
          agentView={props.agentView}
        />
      );
    else if (section === "decisions") body = <AgentDecisions agent={entity} {...turnListProps} />;
    else if (section === "skills") body = <AgentSkills agent={entity} turn={turn} />;
    else if (section === "knowledge") body = <AgentKnowledge agent={entity} knowledge={props.knowledge} knowledgeError={props.knowledgeError} agentView={props.agentView} />;
    else if (section === "messages") body = <AgentMessages agent={entity} knowledge={props.knowledge} knowledgeError={props.knowledgeError} {...turnListProps} />;
  } else if (entity.kind === "plant") {
    if (section === "overview") body = <PlantOverview plant={entity} turn={turn} />;
    else if (section === "growth") body = <PlantGrowth plant={entity} turn={turn} onSelect={props.onSelectEntity} />;
    else if (section === "rules") body = <PlantRules plant={entity} turn={turn} liveRules={props.liveRules} onStage={props.onStage} />;
  } else if (entity.kind === "fruit") {
    body = <FruitOverview fruit={entity} turn={turn} onSelect={props.onSelectEntity} />;
  } else if (entity.kind === "seed") {
    body = <SeedOverview seed={entity} turn={turn} onSelect={props.onSelectEntity} />;
  } else {
    body = <ResidueOverview residue={entity} turn={turn} onSelect={props.onSelectEntity} />;
  }

  return createPortal(
    <div className="profile-overlay" hidden={props.hidden} style={props.rightInset > 0 ? { right: props.rightInset } : undefined}>
      <div className="profile-backdrop" aria-hidden="true" onClick={onClose} />
      <div
        ref={cardRef}
        className={`profile-card profile-kind-${entity.kind}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-title"
        tabIndex={-1}
        data-entity-id={entity.id}
      >
        <header className="profile-head">
          <div className="profile-head-main">
            <div className="profile-title-row">
              <KindTag kind={entity.kind} dead={dead} />
              <h2 id="profile-title" className="profile-title">
                {title}
              </h2>
              {entity.kind === "agent" ? <code className="profile-id">{entity.id}</code> : null}
              {entity.kind === "plant" || entity.kind === "seed" ? <code className="profile-id">{entity.species}</code> : null}
              <span className={`profile-badge ${life.cls}`}>{life.text}</span>
            </div>
            <div className="profile-sub">
              {kindLabel(entity.kind)} at {fmtPoint(entity.position)}
              {terrain ? ` · ${terrain}` : ""} · as of turn <code>{turn.turn.turn_id}</code> (round {turn.turn.round}) ·{" "}
              <span className={turn.live ? "profile-live" : "profile-history"}>{turn.live ? "live" : "history"}</span>
            </div>
          </div>
          <div className="profile-head-actions">
            {entity.kind === "agent" ? (
              <label className={`profile-toggle${props.agentView ? " profile-toggle-on" : ""}`} title="Show only what the agent knows (map, occupants and this card)">
                <input type="checkbox" checked={props.agentView} onChange={props.onToggleAgentView} /> Agent view {props.agentView ? "ON" : "off"}
              </label>
            ) : null}
            <AskButton question={askQuestion} label={`Ask: What is ${askName} up to?`} />
            <button type="button" className="btn btn-small" title="Close this card and show the entity in the Inspector tab" onClick={props.onOpenInInspector}>
              Open in Inspector
            </button>
            <button type="button" className="profile-close" aria-label="Close profile" title="Close (Escape)" onClick={onClose}>
              ×
            </button>
          </div>
        </header>
        {presence.message ? (
          <div className={`profile-banner ${presence.status === "dead" || presence.status === "removed" ? "profile-banner-bad" : "profile-banner-warn"}`}>
            <strong>{presence.label}:</strong> {presence.message}
          </div>
        ) : null}
        {props.agentView && entity.kind !== "agent" ? (
          <div className="profile-banner profile-banner-agentview">Agent view is on: it applies to a selected agent. This card shows the full record of this {kindLabel(entity.kind)}.</div>
        ) : null}
        <div className="profile-body">
          <nav className="profile-nav" aria-label="Profile sections">
            <div role="tablist" aria-orientation="vertical" aria-label="Profile sections" className="profile-tabs">
              {sections.map((s, i) => (
                <button
                  key={s.id}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`profile-tab-${s.id}`}
                  aria-selected={s.id === section}
                  aria-controls="profile-panel"
                  tabIndex={s.id === section ? 0 : -1}
                  className={`profile-tab${s.id === section ? " profile-tab-active" : ""}`}
                  onClick={() => setWanted(s.id)}
                  onKeyDown={(e) => onNavKey(e, i)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </nav>
          <div ref={contentRef} id="profile-panel" role="tabpanel" aria-labelledby={`profile-tab-${section}`} className={`profile-content insp${stale ? " insp-stale" : ""}`}>
            {body}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
