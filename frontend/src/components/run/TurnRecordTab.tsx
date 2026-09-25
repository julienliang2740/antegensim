/**
 * The viewed turn's own record (spec U5 "all actions and state per turn";
 * "Display and historical inspection": expose changes alongside their
 * action/model records): what was decided and done, the edits applied at its
 * boundary with before/after values, its model calls and packet, and every
 * event it recorded.
 *
 * A before/after value that is a whole knowledge record (voice,
 * edit_knowledge) is shown as one sentence ("added operator_voice record
 * a02-k000006 for a02: ...") with the raw JSON behind a disclosure; other long
 * values are cut inline and also available in full.
 */

import type { FieldChange, TurnView } from "../../api/types";
import { describeIntervention } from "../inspect";
import { costText, feedTag, lineCategory } from "../../state/feed";
import type { AgentNamer } from "../../state/statusText";
import { JsonBlock } from "../common/Problems";
import type { RecordTarget } from "../../state/records";
import { compactValue, describeRecordChange, isBulky } from "../../state/changes";
import { eventNote } from "./eventNotes";

function show(value: unknown): string {
  if (value === undefined) return "(absent)";
  return JSON.stringify(value);
}

export function TurnRecordTab(props: { view: TurnView; name: AgentNamer; onOpen(target: RecordTarget): void }) {
  const { view } = props;
  const t = view.turn;
  const packetIds = Array.from(new Set([...(t.packet_id ? [t.packet_id] : []), ...view.decision_packet_ids]));
  return (
    <div className="turn-tab">
      <table className="facts">
        <tbody>
          <tr>
            <th scope="row">turn</th>
            <td>
              <code>{t.turn_id}</code> ({view.live ? "live: latest saved turn" : "history"}) · kind {t.kind} · round {t.round}
              {t.turn_index !== null ? ` · turn ${t.turn_index}` : ""}
            </td>
          </tr>
          <tr>
            <th scope="row">acting agent</th>
            <td>{t.acting_agent_id ? props.name(t.acting_agent_id) : "none"}</td>
          </tr>
          <tr>
            <th scope="row">decision source</th>
            <td>{t.decision_source}</td>
          </tr>
          <tr>
            <th scope="row">action</th>
            <td>
              {t.action ? (
                <>
                  <strong>{t.action.name}</strong> {show(t.action.args)}
                  {t.action.via_skill ? ` (via skill ${t.action.skill_name ?? ""})` : ""}
                </>
              ) : (
                "none"
              )}
            </td>
          </tr>
          <tr>
            <th scope="row">result</th>
            <td>
              {t.action_result ? (
                <span className={t.action_result.ok ? "text-good" : "text-bad"}>
                  {t.action_result.ok ? "ok" : t.action_result.reason} · charge {t.action_result.cost_compute} compute
                  {t.action_result.cost_essence ? `, ${t.action_result.cost_essence} essence` : ""}
                </span>
              ) : (
                "none"
              )}
            </td>
          </tr>
          {t.action_result && Object.keys(t.action_result.effects).length > 0 ? (
            <tr>
              <th scope="row">effects</th>
              <td>
                <code>{show(t.action_result.effects)}</code>
              </td>
            </tr>
          ) : null}
          <tr>
            <th scope="row">initiative order</th>
            <td>
              {t.scheduler.order.join(" → ") || "none"} (next index {t.scheduler.next_index}
              {t.scheduler.round_complete ? ", round complete" : ""})
            </td>
          </tr>
          <tr>
            <th scope="row">previous turn</th>
            <td>
              <code>{t.previous_turn_id ?? "none"}</code>
              {view.parent ? ` (in parent run ${view.parent.run_id})` : ""}
            </td>
          </tr>
          <tr>
            <th scope="row">events</th>
            <td>
              seq {t.event_seq_start}–{t.event_seq_end} · saved {t.saved_at} · code {t.code_revision}
            </td>
          </tr>
        </tbody>
      </table>

      {t.action_result && Object.keys(t.action_result.data).length > 0 ? (
        <details className="packet-section">
          <summary>Result data</summary>
          <JsonBlock value={t.action_result.data} maxHeight={260} />
        </details>
      ) : null}

      <h4>Operator edits applied at this turn's boundary ({t.interventions.length})</h4>
      {t.interventions.length === 0 ? <p className="hint">None.</p> : null}
      {t.interventions.map((record, i) => (
        <div key={i} className={`intervention-record ${record.ok ? "" : "is-failed"}`}>
          <div>
            <code>{record.intervention.id ?? "?"}</code> <strong>{record.intervention.type}</strong> (
            {record.intervention.origin === "file" ? "file edit" : "UI"}) — {describeIntervention(record.intervention)} —{" "}
            {record.ok ? "applied" : `failed: ${record.error ?? "?"}`}
            {record.intervention.note ? <span className="hint"> · note: {record.intervention.note}</span> : null}
          </div>
          {record.changes.length > 0 ? (
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>field</th>
                  <th>before</th>
                  <th>after</th>
                </tr>
              </thead>
              <tbody>
                {record.changes.map((c, j) => (
                  <ChangeRow key={j} change={c} />
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ))}

      <h4>Decision packet and model calls</h4>
      <div className="record-links">
        {packetIds.map((id) => (
          <button key={id} type="button" className="btn btn-small" onClick={() => props.onOpen({ kind: "packet", turnId: t.turn_id, packetId: id })}>
            Open decision packet {id}
          </button>
        ))}
        {view.model_calls.map((c) => (
          <button key={c.call_id} type="button" className="btn btn-small" onClick={() => props.onOpen({ kind: "call", turnId: t.turn_id, callId: c.call_id })}>
            Open model call {c.call_id} ({c.status}
            {c.result_status ? ` / ${c.result_status}` : ""}, {c.input_tokens} in / {c.output_tokens} out
            {c.reasoning_tokens > 0 ? ` (${c.reasoning_tokens} reasoning)` : ""}, {(c.latency_ms / 1000).toFixed(1)} s
            {typeof c.provider_cost_usd === "number" ? `, $${c.provider_cost_usd.toFixed(4)}` : ""})
          </button>
        ))}
        {packetIds.length === 0 && view.model_calls.length === 0 ? <p className="hint">No packet or model call in this turn.</p> : null}
      </div>

      <h4>Events recorded in this turn ({view.events.length})</h4>
      <div className="log-scroll log-static">
        {view.events.map((e) => (
          <div key={e.seq} className={`log-line cat-${lineCategory(e)}`}>
            <div className="log-meta">
              <span className="log-seq">#{e.seq}</span>
              <span className="log-tag">{feedTag(e)}</span>
              <span className="log-actor">{e.actor}</span>
              <span className="log-kind">{e.kind}</span>
              {costText(e) ? <span className="log-cost">cost {costText(e)}</span> : null}
            </div>
            <div className="log-summary">{e.summary}</div>
            {eventNote(e) ? <div className="log-detail">{eventNote(e)}</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One before/after row; knowledge records become a sentence, long values are cut with the full JSON on demand. */
function ChangeRow(props: { change: FieldChange }) {
  const c = props.change;
  const sentence = describeRecordChange(c);
  if (sentence) {
    return (
      <tr>
        <td>
          <code>{c.path}</code>
        </td>
        <td colSpan={2} className="cell-wrap cell-sentence">
          {sentence}
          <details className="raw-value">
            <summary>raw before / after JSON</summary>
            <JsonBlock value={{ before: c.before, after: c.after }} maxHeight={240} />
          </details>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td>
        <code>{c.path}</code>
      </td>
      <td className="cell-wrap">
        <ValueCell value={c.before} />
      </td>
      <td className="cell-wrap">
        <ValueCell value={c.after} />
      </td>
    </tr>
  );
}

function ValueCell(props: { value: unknown }) {
  if (!isBulky(props.value)) return <>{show(props.value)}</>;
  return (
    <details className="raw-value">
      <summary>{compactValue(props.value)}</summary>
      <JsonBlock value={props.value} maxHeight={240} />
    </details>
  );
}
