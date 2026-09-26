/**
 * Sections of the entity profile card shared by every kind (History) and the
 * Overview of fruit, seeds and residue, plus EntityLink, the id button that
 * switches the card to another entity (a plant's fruit, a fruit's plant, a
 * residue's source).  All values are the viewed turn's.
 */

import type { Entity, Fruit, RemovedEntity, Residue, Seed, TurnView } from "../../api/types";
import { findEntity } from "../../api/types";
import { terrainAt } from "../../state/profile";
import { KeyValueTable, Section } from "../inspect/common";
import { fmtNum, fmtPoint } from "../inspect/format";
import type { Presence } from "../inspect/logic";
import { kv } from "../inspect/rows";
import type { KeyValueRow } from "../inspect/rows";

/** An entity id: a button that opens its profile when the entity is in the viewed turn, plain code otherwise. */
export function EntityLink(props: { id: string; turn: TurnView; onSelect(id: string): void; label?: string }) {
  const known = findEntity(props.turn.entities, props.id);
  if (!known) return <code title="not in the viewed turn">{props.label ?? props.id}</code>;
  return (
    <button type="button" className="profile-link" title={`Open the profile of ${props.id}`} onClick={() => props.onSelect(props.id)}>
      {props.label ?? props.id}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Fruit, seed, residue
// ---------------------------------------------------------------------------

export function FruitOverview(props: { fruit: Fruit; turn: TurnView; onSelect(id: string): void }) {
  const { fruit, turn } = props;
  const parent = fruit.plant_id ? (turn.entities.plants[fruit.plant_id] ?? null) : null;
  const decayRounds = parent ? (turn.rules.plant_species[parent.species]?.fruit_decay_rounds ?? null) : null;
  const rows: KeyValueRow[] = [
    ["available compute", fmtNum(fruit.available_compute)],
    ["available essence", `${fmtNum(fruit.available_essence)} (fruit holds no essence by design)`],
    kv(
      "from plant",
      fruit.plant_id ? (
        <>
          <EntityLink id={fruit.plant_id} turn={turn} onSelect={props.onSelect} />
          {parent ? ` (${parent.species})` : ""}
        </>
      ) : (
        <span className="insp-muted">none</span>
      ),
    ),
    ["created round", String(fruit.created_round)],
    kv(
      "rots",
      decayRounds === null ? "unknown (parent plant or rule not found)" : decayRounds === 0 ? "never (fruit_decay_rounds = 0)" : `at age ${decayRounds} rounds (round ${fruit.created_round + decayRounds})`,
    ),
    ["position", `${fmtPoint(fruit.position)}${terrainAt(turn, fruit.position) ? ` · ${terrainAt(turn, fruit.position)}` : ""}`],
  ];
  return (
    <Section title="Fruit">
      <KeyValueTable rows={rows} />
    </Section>
  );
}

export function SeedOverview(props: { seed: Seed; turn: TurnView; onSelect(id: string): void }) {
  const { seed, turn } = props;
  const round = turn.turn.round;
  const rows: KeyValueRow[] = [
    kv("species", <code>{seed.species}</code>),
    kv("from plant", seed.plant_id ? <EntityLink id={seed.plant_id} turn={turn} onSelect={props.onSelect} /> : <span className="insp-muted">none</span>),
    ["created round", String(seed.created_round)],
    kv("germinates round", `${seed.germinates_round}${seed.germinates_round > round ? ` (in ${seed.germinates_round - round} rounds)` : " (due; land only, else dormant)"}`),
    ["position", `${fmtPoint(seed.position)}${terrainAt(turn, seed.position) ? ` · ${terrainAt(turn, seed.position)}` : ""}`],
  ];
  return (
    <Section title="Seed (dormant record, no harvestable essence)">
      <KeyValueTable rows={rows} />
    </Section>
  );
}

export function ResidueOverview(props: { residue: Residue; turn: TurnView; onSelect(id: string): void }) {
  const { residue, turn } = props;
  const rows: KeyValueRow[] = [
    kv(
      "source",
      <>
        {residue.source_kind} <EntityLink id={residue.source_id} turn={turn} onSelect={props.onSelect} />
      </>,
    ),
    ["available compute", fmtNum(residue.available_compute)],
    ["available essence", fmtNum(residue.available_essence)],
    ["created round", String(residue.created_round)],
    ["decay per round", `${fmtNum(turn.rules.death.residue_decay_per_round)} (fraction; 0 = persists)`],
    ["position", fmtPoint(residue.position)],
  ];
  return (
    <Section title="Residue (left by a death; absorb to extract)">
      <KeyValueTable rows={rows} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// History (every kind)
// ---------------------------------------------------------------------------

export function HistorySection(props: { entity: Entity; turn: TurnView; presence: Presence; removed: RemovedEntity | null; onSelect(id: string): void }) {
  const { entity, turn, presence, removed } = props;
  const rows: KeyValueRow[] = [["created round", String(entity.created_round)]];
  if (entity.kind === "agent" || entity.kind === "plant") {
    rows.push(kv("alive", entity.alive ? "yes" : <span className="insp-bad">no</span>));
    if (!entity.alive) {
      rows.push(["died round", String(entity.died_round ?? "?")]);
      rows.push(["death cause", entity.death_cause ?? "unknown"]);
    }
  }
  if (entity.kind === "seed") rows.push(["germinates round", String(entity.germinates_round)]);
  if (removed) {
    rows.push(kv("left the world", <span className="insp-bad">round {removed.round} ({removed.reason})</span>));
    rows.push(["last point", fmtPoint(removed.position)]);
  }
  const residues = Object.values(turn.entities.residues).filter((r) => r.source_id === entity.id);
  if (entity.kind === "agent" || entity.kind === "plant") {
    rows.push(
      kv(
        "residue left",
        residues.length ? (
          <span className="profile-links">
            {residues.map((r) => (
              <EntityLink key={r.id} id={r.id} turn={turn} onSelect={props.onSelect} label={`${r.id} (${fmtNum(r.available_compute)} compute, ${fmtNum(r.available_essence)} essence)`} />
            ))}
          </span>
        ) : (
          <span className="insp-muted">{entity.alive ? "none (alive)" : "none in the viewed turn (absorbed, decayed or not left)"}</span>
        ),
      ),
    );
  }
  const presenceText =
    presence.status === "present"
      ? `present in turn ${turn.turn.turn_id} (round ${turn.turn.round})`
      : presence.status === "no_turn"
        ? "no turn loaded"
        : `${presence.label}: ${presence.message}`;
  rows.push(["in the viewed turn", presenceText]);
  return (
    <Section title="Birth, death and presence">
      <KeyValueTable rows={rows} />
    </Section>
  );
}
