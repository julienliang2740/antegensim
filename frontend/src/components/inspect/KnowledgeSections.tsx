/**
 * Knowledge views used by the agent inspector (spec U2 "agent stuff must be
 * very easy to see": knowledge, observations, received messages, recent
 * results).  Everything here reads one agent's AgentKnowledgeView only, so the
 * same sections serve the omniscient inspector and the agent-view overlay.
 * Record kinds and content shapes follow INTERFACES section 4.3.
 */

import { useState } from "react";
import type { AgentKnowledgeView, AgentStats, BelievedSelf, KnowledgeKind, KnowledgeRecord } from "../../api/types";
import { KeyValueTable } from "./common";
import type { KeyValueRow } from "./rows";
import { fmtJson, fmtNum, fmtValue } from "./format";
import { asBool, asNumber, asRecord, asString } from "./logic";

const ALL_KINDS: KnowledgeKind[] = ["observation", "query", "action_result", "message", "operator_voice", "damage", "system"];
const OWN_ACTION_KINDS: KnowledgeKind[] = ["observation", "query", "action_result"];
const RECEIVED_KINDS: KnowledgeKind[] = ["message", "operator_voice"];
/** How many rows the record table shows before "show all". */
const RECORD_PAGE = 60;
/** How many recent action results are listed. */
const RECENT_RESULTS = 10;

function newestFirst(records: KnowledgeRecord[]): KnowledgeRecord[] {
  return [...records].sort((a, b) => b.seq - a.seq);
}

function sourceLabel(record: KnowledgeRecord): string {
  const p = record.provenance;
  let label = p.source;
  if (p.action) label += ` (${p.action})`;
  if (p.sender_visible === false) label += " · sender unseen";
  return label;
}

// ---------------------------------------------------------------------------
// Believed self
// ---------------------------------------------------------------------------

const BELIEVED_FIELDS: (keyof BelievedSelf & keyof AgentStats)[] = [
  "compute",
  "essence",
  "essence_capacity",
  "health",
  "max_health",
  "attack",
  "speed",
  "vision_range",
  "communication_range",
  "compute_absorption",
  "essence_absorption",
  "skill_count_limit",
  "skill_block_limit",
];

/** "(from query, round N)" or "as of round N (derived, may be stale)" (INTERFACES 4.3 "Believed self"). */
function believedLabel(b: BelievedSelf): string {
  if (b.source === "query") return `from query(self), round ${b.known_round ?? "?"}`;
  if (b.source === "derived") return `as of round ${b.known_round ?? "?"} (derived, may be stale)`;
  return "unknown (no run-start record or query yet)";
}

/**
 * The agent's belief about itself.  With `actual` (omniscient view) a second
 * column shows the authoritative value and marks differences.
 */
export function BelievedSelfTable(props: { believed: BelievedSelf; actual?: AgentStats | null }) {
  const { believed, actual } = props;
  return (
    <div>
      <div className="insp-hint">Source: {believedLabel(believed)}. Upkeep is never applied to this belief.</div>
      <table className="insp-table">
        <thead>
          <tr>
            <th>stat</th>
            <th>believed</th>
            {actual ? <th>actual (omniscient)</th> : null}
          </tr>
        </thead>
        <tbody>
          {BELIEVED_FIELDS.map((field) => {
            const believedValue = believed[field];
            const a = actual ? actual[field] : null;
            const differs = a !== null && believedValue !== null && Math.abs(a - believedValue) > 1e-9;
            return (
              <tr key={field} className={differs ? "insp-row-warn" : undefined}>
                <th scope="row" className="insp-fieldname-cell">{field}</th>
                <td>{believedValue === null ? <span className="insp-muted">unknown</span> : fmtNum(believedValue)}</td>
                {actual ? (
                  <td>
                    {a === null ? "?" : fmtNum(a)}
                    {differs ? <span className="insp-badge insp-badge-warn">differs</span> : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notebook
// ---------------------------------------------------------------------------

export function NotebookView(props: { knowledge: AgentKnowledgeView }) {
  const k = props.knowledge.knowledge;
  return (
    <div>
      <div className="insp-hint">
        Version {k.notebook_version}
        {k.notebook_truncated ? " · the last update was cut to the notebook size limit" : ""}
      </div>
      {k.notebook ? <pre className="insp-pre insp-notebook">{k.notebook}</pre> : <p className="insp-muted">(empty notebook)</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Received messages and operator voice
// ---------------------------------------------------------------------------

export function ReceivedMessages(props: { knowledge: AgentKnowledgeView }) {
  const received = newestFirst(props.knowledge.knowledge.records.filter((r) => RECEIVED_KINDS.includes(r.kind)));
  if (received.length === 0) return <p className="insp-muted">No messages or operator voice received.</p>;
  return (
    <ul className="insp-messages">
      {received.map((r) => {
        const c = asRecord(r.content) ?? {};
        const text = asString(c.text) ?? r.text;
        const sender = asString(c.sender);
        const broadcast = asBool(c.broadcast);
        const from =
          r.kind === "operator_voice"
            ? "voice from nowhere (source unknown)"
            : sender
              ? `from ${sender}${asBool(c.sender_visible) === false ? " (unseen)" : ""}`
              : "from an unseen sender";
        return (
          <li key={r.id} className={r.kind === "operator_voice" ? "insp-voice" : undefined}>
            <div className="insp-message-meta">
              <code>{r.id}</code> · round {r.round} · {from}
              {broadcast ? " · broadcast" : ""}
              {!r.read ? <span className="insp-badge insp-badge-info">unread</span> : null}
            </div>
            <div className="insp-message-text">“{text}”</div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Recent action results (own_action records)
// ---------------------------------------------------------------------------

export function RecentResults(props: { knowledge: AgentKnowledgeView }) {
  const own = newestFirst(props.knowledge.knowledge.records.filter((r) => OWN_ACTION_KINDS.includes(r.kind))).slice(0, RECENT_RESULTS);
  if (own.length === 0) return <p className="insp-muted">No own actions recorded yet.</p>;
  return (
    <table className="insp-table insp-results">
      <thead>
        <tr>
          <th>round</th>
          <th>action</th>
          <th>result</th>
          <th>cost (compute / essence)</th>
          <th>thought</th>
        </tr>
      </thead>
      <tbody>
        {own.map((r) => {
          const c = asRecord(r.content) ?? {};
          const action = asRecord(c.action);
          const result = asRecord(c.result);
          const ok = asBool(result?.ok);
          const reason = asString(result?.reason) ?? "?";
          const viaSkill = asBool(c.via_skill);
          const name = asString(action?.name) ?? r.provenance.action ?? r.kind;
          const args = action?.args;
          return (
            <tr key={r.id}>
              <td>{r.round}</td>
              <td>
                <strong>{name}</strong> <span className="insp-small">{args !== undefined ? fmtValue(args, 60) : ""}</span>
                {viaSkill ? <span className="insp-badge insp-badge-info">via skill</span> : null}
              </td>
              <td className={ok === false ? "insp-bad" : ok ? "insp-good" : undefined}>{ok === null ? "?" : ok ? "ok" : reason}</td>
              <td>
                {fmtNum(asNumber(result?.cost_compute) ?? 0)} / {fmtNum(asNumber(result?.cost_essence) ?? 0)}
              </td>
              <td className="insp-small">{asString(c.thought) ?? ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// All records, filterable
// ---------------------------------------------------------------------------

export function KnowledgeRecordsTable(props: { knowledge: AgentKnowledgeView }) {
  const records = props.knowledge.knowledge.records;
  const [kinds, setKinds] = useState<Set<KnowledgeKind>>(() => new Set(ALL_KINDS));
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  const counts = new Map<KnowledgeKind, number>();
  for (const r of records) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const needle = search.trim().toLowerCase();
  const filtered = newestFirst(records).filter(
    (r) => kinds.has(r.kind) && (!unreadOnly || !r.read) && (!needle || r.text.toLowerCase().includes(needle) || r.id.includes(needle)),
  );
  const shown = showAll ? filtered : filtered.slice(0, RECORD_PAGE);

  const toggleKind = (kind: KnowledgeKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  return (
    <div>
      <div className="insp-filters">
        <span className="insp-filter-label">Kinds:</span>
        {ALL_KINDS.map((kind) => (
          <label key={kind} className="insp-filter-kind">
            <input type="checkbox" checked={kinds.has(kind)} onChange={() => toggleKind(kind)} /> {kind} ({counts.get(kind) ?? 0})
          </label>
        ))}
        <button type="button" className="insp-btn insp-btn-small" onClick={() => setKinds(new Set(ALL_KINDS))}>
          all
        </button>
        <button type="button" className="insp-btn insp-btn-small" onClick={() => setKinds(new Set())}>
          none
        </button>
      </div>
      <div className="insp-filters">
        <label>
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> unread only (
          {props.knowledge.unread_count} unread)
        </label>
        <input
          type="search"
          className="insp-search"
          placeholder="search text or id"
          aria-label="Search knowledge records"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="insp-muted">
          {filtered.length} of {records.length} records
        </span>
      </div>
      {/* One block per record: a meta line (id, round, kind, source) above the full-width text, so the
          text is never squeezed into a narrow last column (usability review: U2 "easy to see"). */}
      <ul className="insp-record-list">
        {shown.map((r) => (
          <li key={r.id} className={`insp-record${!r.read ? " insp-unread" : ""}`}>
            <div className="insp-record-meta">
              <code>{r.id}</code>
              <span>round {r.round}</span>
              <span className={`insp-rk insp-rk-${r.kind}`}>{r.kind}</span>
              <span className="insp-small">{sourceLabel(r)}</span>
              <span className="insp-muted">importance {fmtNum(r.importance)}</span>
              {!r.read ? <span className="insp-badge insp-badge-info">unread</span> : null}
            </div>
            <details>
              <summary className="insp-record-text">{r.text}</summary>
              <KeyValueTable
                rows={
                  [
                    ["tags", r.tags.join(", ") || "(none)"],
                    ["turn", r.provenance.turn_id ?? "?"],
                    ["created", r.created_at],
                  ] as KeyValueRow[]
                }
              />
              <pre className="insp-pre">{fmtJson(r.content)}</pre>
            </details>
          </li>
        ))}
      </ul>
      {filtered.length > shown.length ? (
        <button type="button" className="insp-btn" onClick={() => setShowAll(true)}>
          Show all {filtered.length} records
        </button>
      ) : null}
    </div>
  );
}
