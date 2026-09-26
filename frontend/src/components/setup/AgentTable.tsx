/**
 * The agents of a new session as a table, one row per card (spec U11
 * "each agent should be, like, a card"; operator feedback: a table with an
 * editable card per row).  Rows are read-only summaries; clicking a row or
 * "Edit…" opens the full card (AgentCardDialog).  Validation problems under
 * agents[i] turn the matching cell red and are listed under the row.
 */

import type { AgentCard, ApiProblem } from "../../api/types";
import { FieldProblems } from "../common/Problems";
import { problemsUnder } from "../../state/setupForm";

interface Column {
  label: string;
  /** Paths under agents[i] whose problems mark this cell. */
  paths: string[];
  numeric?: boolean;
  value(card: AgentCard, defaultModelKey: string): string;
}

/** Up to 2 decimals, no trailing zeros. */
function num(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : String(value);
}

const COLUMNS: Column[] = [
  { label: "id", paths: ["id"], value: (c) => c.id || "auto" },
  { label: "name", paths: ["name"], value: (c) => c.name || "(no name)" },
  { label: "model", paths: ["model_key"], value: (c, d) => c.model_key || `run default (${d})` },
  { label: "start x", paths: ["position", "position.x"], numeric: true, value: (c) => String(c.position.x) },
  { label: "start y", paths: ["position", "position.y"], numeric: true, value: (c) => String(c.position.y) },
  {
    label: "health / max",
    paths: ["stats.health", "stats.max_health"],
    numeric: true,
    value: (c) => `${num(c.stats.health)} / ${num(c.stats.max_health)}`,
  },
  { label: "compute", paths: ["stats.compute"], numeric: true, value: (c) => num(c.stats.compute) },
  {
    label: "essence / capacity",
    paths: ["stats.essence", "stats.essence_capacity"],
    numeric: true,
    value: (c) => `${num(c.stats.essence)} / ${num(c.stats.essence_capacity)}`,
  },
  { label: "speed", paths: ["stats.speed"], numeric: true, value: (c) => num(c.stats.speed) },
  { label: "vision", paths: ["stats.vision_range"], numeric: true, value: (c) => num(c.stats.vision_range) },
];

export interface AgentTableProps {
  cards: AgentCard[];
  problems: ApiProblem[];
  defaultModelKey: string;
  canRemove: boolean;
  /** Index of the card open in the dialog (highlighted), if any. */
  openIndex: number | null;
  onEdit(index: number): void;
  onRemove(index: number): void;
}

export function AgentTable(props: AgentTableProps) {
  return (
    <div className="agent-table-wrap">
      <table className="data-table agent-table">
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th key={col.label} scope="col" className={col.numeric ? "num" : undefined}>
                {col.label}
              </th>
            ))}
            <th scope="col" className="agent-table-actions-head">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        {props.cards.map((card, index) => {
          const prefix = `agents[${index}]`;
          const mine = problemsUnder(props.problems, prefix);
          const label = `${card.id || `card ${index + 1}`} ${card.name}`.trim();
          const rowClass = ["agent-row", mine.length ? "has-problems" : "", props.openIndex === index ? "is-open" : ""].filter(Boolean).join(" ");
          return (
            <tbody key={index} className="agent-row-group">
              <tr className={rowClass} onClick={() => props.onEdit(index)} title="Click to open the full card">
                {COLUMNS.map((col) => {
                  const cellProblems = mine.filter((p) => col.paths.some((path) => p.path === `${prefix}.${path}`));
                  const classes = [col.numeric ? "num" : "", cellProblems.length ? "cell-invalid" : "", col.label === "model" ? "cell-model" : ""]
                    .filter(Boolean)
                    .join(" ");
                  const text = col.value(card, props.defaultModelKey);
                  return (
                    <td
                      key={col.label}
                      className={classes || undefined}
                      title={cellProblems.length ? cellProblems.map((p) => `${p.path}: ${p.message}`).join("\n") : undefined}
                    >
                      {col.label === "model" && !card.model_key ? <span className="muted">{text}</span> : text}
                      {cellProblems.length ? (
                        <span className="cell-flag" aria-label="has a problem">
                          {" "}
                          !
                        </span>
                      ) : null}
                    </td>
                  );
                })}
                <td className="agent-table-actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    aria-label={`Edit agent ${label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onEdit(index);
                    }}
                  >
                    Edit…
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    aria-label={`Remove agent ${label}`}
                    disabled={!props.canRemove}
                    title={props.canRemove ? undefined : "A run needs at least 6 agents."}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onRemove(index);
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
              {mine.length > 0 ? (
                <tr className="agent-row-problems">
                  <td colSpan={COLUMNS.length + 1}>
                    <FieldProblems problems={mine} />
                  </td>
                </tr>
              ) : null}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
